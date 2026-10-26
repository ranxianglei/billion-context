import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { Session, residentBreakdown, snapshotMessages } from "../src/session.ts";
import { createInitialState, type CoreMessage } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// #3050 R3 ②a: after a successful save of an IDLE session, the resident copy
// of the raw resent-history tail folds down to the bounded persisted view
// (the exact shape a restart restores). Mid-turn saves keep the raw tail; the
// next request's snapshotMessages re-arms the raw copy either way.

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-fold-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";
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

/** ~2.5-token sentences: 300 of them ≈ 750 tokens > the 600-token budget. */
function rawTail(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: `mf${i}`, contentType: "text", role: i % 2 === 0 ? "user" : "assistant", text: `fold-probe message number ${i} with some filler words to spend tokens` });
    }
    return out;
}

function readRecord(dir: string): Record<string, unknown> {
    const proto = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory())?.name;
    assert.ok(proto, "no protocol dir written");
    const file = readdirSync(path.join(dir, proto!)).find((f) => f.endsWith(".json"));
    assert.ok(file, "no session file written");
    const envelope = JSON.parse(readFileSync(path.join(dir, proto!, file!), "utf8")) as { payload: Record<string, unknown> };
    return envelope.payload;
}

test("idle save folds the resident raw tail to the persisted bounded view", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-fold-1-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("fold-1");
        snapshotMessages(s, rawTail(300));
        assert.equal(s.lastMessagesFolded, false, "snapshotMessages arms the raw copy unfolded");
        const rawBytes = residentBreakdown(s).lastMessages;
        assert.ok(rawBytes > 30_000, `raw tail should be tens of KB, got ${rawBytes}`);

        await store.writeNow(s);

        assert.equal(s.lastMessagesFolded, true, "idle save folds the resident tail");
        assert.ok(s.lastMessages && s.lastMessages.length < 300, `bounded view keeps only the tail-budget messages, got ${s.lastMessages?.length}`);
        const foldedBytes = residentBreakdown(s).lastMessages;
        assert.ok(foldedBytes < rawBytes / 2, `resident tail must shrink (raw ${rawBytes} -> folded ${foldedBytes})`);

        // The envelope carries the SAME bounded view — disk and RAM agree.
        const payload = readRecord(dir);
        const persisted = payload.messages as CoreMessage[];
        assert.deepEqual(persisted, s.lastMessages, "envelope tail equals the folded resident view");
        assert.equal((payload as { messagesFolded?: boolean }).messagesFolded, true);
    } finally {
        store.cancelAll();
        rmrf(dir);
    }
});

test("mid-turn save keeps the raw tail; the next request re-arms it regardless", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-fold-2-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("fold-2");
        snapshotMessages(s, rawTail(200));
        s.inFlight = 1; // a request is running: eviction guard active, turn may read the raw tail
        await store.writeNow(s);
        assert.equal(s.lastMessages!.length, 200, "in-flight save must not fold");
        assert.equal(s.lastMessagesFolded, false);
        s.inFlight = 0;

        // Even after an idle fold, the next turn's snapshot re-arms raw.
        await store.writeNow(s);
        assert.equal(s.lastMessagesFolded, true);
        snapshotMessages(s, rawTail(3));
        assert.equal(s.lastMessages!.length, 3);
        assert.equal(s.lastMessagesFolded, false, "snapshotMessages re-arms the raw copy");
    } finally {
        store.cancelAll();
        rmrf(dir);
    }
});

test("idle re-saves are envelope-stable and restart restores the folded shape", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-fold-3-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("fold-3");
        snapshotMessages(s, rawTail(250));
        await store.writeNow(s);
        const first = readRecord(dir).messages as CoreMessage[];

        await store.writeNow(s); // idle re-save builds from the folded view
        const second = readRecord(dir).messages as CoreMessage[];
        assert.deepEqual(second, first, "folding is idempotent: re-saving the folded view writes the same tail");

        const again = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
        try {
            const loaded = (await again.loadAll()).get("fold-3");
            assert.ok(loaded, "restart loads the session");
            assert.equal(loaded.lastMessagesFolded, true, "restart restores the folded shape (pre-existing contract)");
            assert.deepEqual(loaded.lastMessages, s.lastMessages, "resident view after fold == what a restart restores");
        } finally {
            again.cancelAll();
        }
    } finally {
        store.cancelAll();
        rmrf(dir);
    }
});
