import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

// #1336: the retrieval-quality ratio (wholeBlockRestores vs cheaper precise
// path available) is a LONG-RUN metric — if the loader forgets the counters,
// every restart silently resets the denominator/numerator and acp_status
// reports a bogus ratio. Persist → fresh store → same numbers.
test("stats retrieval-quality counters survive a reload round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-pq-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("pq-1");
        s.stats.wholeBlockRestores = 3;
        s.stats.wholeBlockRestoresPreciseAvailable = 7;
        s.stats.rangeRestores = 2;
        await store.writeNow(s);
        await store.flushAll([]);

        const reloaded = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const back = reloaded.loadSync("pq-1");
        assert.ok(back, "session reloaded");
        assert.equal(back.stats.wholeBlockRestores, 3, "wholeBlockRestores round-trips");
        assert.equal(back.stats.wholeBlockRestoresPreciseAvailable, 7, "wholeBlockRestoresPreciseAvailable round-trips");
        assert.equal(back.stats.rangeRestores, 2, "control counter still round-trips");
        await reloaded.flushAll([]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
