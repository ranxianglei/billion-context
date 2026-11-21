import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { isDroppedMetadata, snapshotMessages } from "../src/session.ts";
import { createInitialState, type CoreMessage } from "acp-kernel";
import { planIngestDelta, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore, messageRowReads } from "../src/storage/store.ts";
import type { UnifiedShadow } from "../src/storage/shadow.ts";
import { rmrf } from "./tmp-rm.ts";

// #4739: ordinary loads must not materialize the whole historical log — the
// view only consumes tail/pluginSnapshot pointer rows — and the dropped
// lazy fields must restore through narrow reads instead of two full-session
// rebuilds per saved record.

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-4739-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";
// Keep the persisted tail SMALL relative to the seeded history so the
// pointer set is a strict subset of the message table.
process.env.BILI_PERSIST_TAIL_TOKENS = "600";

function makeSession(id: string): Session {
    return {
        id,
        meta: { label: id, protocol: "openai", upstreamOrigin: "http://up:1" },
        stats: { requests: 3, tokensSaved: 0, inputTokens: 10, cachedTokens: 0, outputTokens: 5, cacheSamples: 0, lastInputTokens: 10, contextTokens: 1000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function rawTail(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: `big${i}`, contentType: "text", role: i % 2 === 0 ? "user" : "assistant", text: `bounded load probe message number ${i} with filler words to spend tokens` });
    }
    return out;
}

/** Finds the persisted envelope for `id` under `root` (payload.id match). */
function findEnvelope(root: string, id: string): string | null {
    const hits: string[] = [];
    const walk = (d: string): void => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, f.name);
            if (f.isDirectory()) walk(fp);
            else if (f.name.endsWith(".json")) hits.push(fp);
        }
    };
    walk(root);
    for (const hit of hits) {
        try {
            const envelope = JSON.parse(fs.readFileSync(hit, "utf8")) as Record<string, unknown>;
            const payload = (envelope["payload"] ?? envelope) as Record<string, unknown>;
            if (payload["id"] === id) return hit;
        } catch {
            // non-JSON or partial write — skip
        }
    }
    return null;
}

test("full mode: viewFor decodes only pointer rows and matches the full-log decode", async () => {
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4739-view-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("big-1");
        s.metadata.foldAnchors = { m00001: { c: "text", frags: ["a", "b"] } };
        const N = 400;
        snapshotMessages(s, rawTail(N));
        await store.writeNow(s);

        const sh = (store as unknown as { shadow?: UnifiedShadow }).shadow;
        assert.ok(sh && sh.readsUnified, "full-mode sidecar live");

        const direct = UnifiedStore.open(path.join(dir, "index.db"));
        // Generation 2 — the production shape after an idle fold (#3050 R3):
        // the table keeps every row, tail_json points at the bounded raw
        // suffix only (an equal-length raw tail is a valid empty delta).
        const K = 40;
        const allRows = direct.getMessages("big-1");
        assert.equal(allRows.length, N, "generation 1 ingested the full history");
        const maxSeq = allRows[allRows.length - 1]!.seq;
        const suffixSeqs = allRows.slice(-K).map((m) => m.seq);
        const boundaryRow = allRows[allRows.length - 1]!;
        const deltaLegacy: LegacySessionLike = {
            id: "big-1",
            createdAt: s.createdAt,
            lastSeen: s.lastSeen,
            meta: { protocol: "openai" },
            stats: { requests: 4 },
            metadata: {},
            state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 1, nextRunId: 1 },
            blockContents: new Map(),
            lastMessages: rawTail(N).slice(-K),
        };
        const plan = planIngestDelta(deltaLegacy, maxSeq, suffixSeqs, { msgId: boundaryRow.msgId, contentHash: boundaryRow.contentHash }, true);
        assert.ok(plan, "empty delta accepted for the shrunken raw tail");
        direct.ingestSession(plan, { trustedSeq: maxSeq, boundaryMsgId: boundaryRow.msgId, boundaryHash: boundaryRow.contentHash, trustedTailSeqs: suffixSeqs });

        // Reference decode: the OLD algorithm — every message row through
        // loadLegacyView on the second handle of the same database.
        const sessionRow = direct.getSessionRow("big-1");
        assert.ok(sessionRow, "session row present");
        const liveSeqs = new Set(direct.getMessages("big-1").map((m) => m.seq));
        assert.equal(liveSeqs.size, N, "table still holds the full history");
        const tailDoc = JSON.parse(sessionRow.tailJson) as { tailSeqs?: unknown; pluginSnapshotSeqs?: unknown };
        const pickSeqs = (v: unknown): number[] => (Array.isArray(v) ? v.filter((s): s is number => typeof s === "number") : []);
        const expectedPointers = [...new Set([...pickSeqs(tailDoc.tailSeqs), ...pickSeqs(tailDoc.pluginSnapshotSeqs)])].filter((seq) => liveSeqs.has(seq)).length;
        assert.equal(expectedPointers, K, `tail now points at ${K} of ${N} rows`);

        const reference = loadLegacyView({
            session: sessionRow,
            messages: direct.getMessages("big-1"),
            blocks: direct.getBlocks("big-1"),
            deadRefs: direct.getDeadRefs("big-1"),
            refs: direct.getRefs("big-1"),
        });
        const before = messageRowReads.count;
        const via = sh.viewFor("big-1");
        const delta = messageRowReads.count - before;
        direct.close();

        assert.ok(via, "viewFor resolved");
        assert.deepEqual(via, reference, "bounded decode byte-equal to the full-log decode");
        assert.equal(delta, expectedPointers, `viewFor read ${delta} message rows for ${expectedPointers} pointer seqs (full log = ${liveSeqs.size})`);
    } finally {
        store.closeQuietly();
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});

test("full mode: dropped metadata restores from the index alone (narrow read, no envelope)", async () => {
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4739-md-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("md-idx");
        s.metadata.foldAnchors = { m00001: { c: "tool-call" } };
        s.metadata.cacheLedger = { restartDrops: { count: 2 } };
        snapshotMessages(s, rawTail(50));
        await store.writeNow(s);
        assert.equal(isDroppedMetadata(s.metadata), true, "metadata folded after idle save");

        // The persisted shape (what a restart restores) — captured while the
        // envelope still exists.
        const envelopePath = findEnvelope(dir, "md-idx");
        assert.ok(envelopePath, "envelope written in full mode");
        const envelopePayload = JSON.parse(fs.readFileSync(envelopePath, "utf8")).payload as Record<string, unknown>;
        const persistedKeys = Object.keys(envelopePayload.metadata as object).sort();

        // Delete the file copy: restore must come from the index alone.
        fs.unlinkSync(envelopePath);
        assert.deepEqual(s.metadata.cacheLedger, { restartDrops: { count: 2 } }, "narrow index restore serves the value");
        assert.deepEqual(Object.keys(s.metadata).sort(), persistedKeys, "materialized shape is the persisted (restart) shape");
        assert.equal(isDroppedMetadata(s.metadata), false, "materialized on read");

        // A later save persists the same keys — no thinned erase.
        await store.writeNow(s);
        const again = findEnvelope(dir, "md-idx");
        assert.ok(again, "envelope rewritten by later save");
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(again, "utf8")).payload.metadata as object).sort(), persistedKeys);
    } finally {
        store.closeQuietly();
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});


