import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { snapshotMessages } from "../src/session.ts";
import { createInitialState, type CoreMessage } from "acp-kernel";
import { UnifiedStore, messageRowReads } from "../src/storage/store.ts";
import type { UnifiedShadow } from "../src/storage/shadow.ts";
import { rmrf } from "./tmp-rm.ts";

// #4739 follow-up (adjacent finding from the #4765 review): the checkpoint
// tip-seq read must be ONE MAX(seq) aggregate over live rows — not a full
// materialization of the message log (rows + content-CAS reads + media
// hydration) reduced to a scalar. The old scan cost O(N) per checkpoint
// insert on the write path.

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-tipseq-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "full";

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
        out.push({ id: `tip${i}`, contentType: "text", role: i % 2 === 0 ? "user" : "assistant", text: `tip-seq probe message number ${i} with filler words to spend tokens` });
    }
    return out;
}

test("sessionTipSeq is max live seq + 1 and materializes zero message rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-tipseq-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("tip-1");
        const N = 300;
        snapshotMessages(s, rawTail(N));
        await store.writeNow(s);

        const sh = (store as unknown as { shadow?: UnifiedShadow }).shadow;
        assert.ok(sh && sh.readsUnified, "full-mode sidecar live");

        // Reference value computed with the OLD algorithm's input set (live
        // rows only) — taken BEFORE the narrowness window opens.
        const direct = UnifiedStore.open(path.join(dir, "index.db"));
        const rows = direct.getMessages("tip-1");
        assert.equal(rows.length, N, "generation 1 ingested the full history");
        const expectedTip = rows[rows.length - 1]!.seq + 1;
        direct.close();

        assert.equal(sh.sessionTipSeq("no-such-session"), 0, "no live rows → tip 0 (as before)");

        const before = messageRowReads.count;
        assert.equal(sh.sessionTipSeq("tip-1"), expectedTip, "tip = max live seq + 1");
        assert.equal(messageRowReads.count - before, 0, `no message rows materialized (old scan read ${N})`);

        assert.equal(await sh.sessionTipSeqAsync("tip-1"), expectedTip, "async twin agrees");
    } finally {
        // release the unified index.db handle before rmrf — Windows cannot
        // unlink an open SQLite file (the #4599 tmp-rm EBUSY family)
        store.closeQuietly();
        rmrf(dir);
    }
});
