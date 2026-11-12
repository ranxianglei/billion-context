import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.NODE_ENV = "test";
// Pin the envelope → buildSession() legacy reload path — the exact cold-load
// route where the dropped field lived (#5303).
process.env.BILI_STORAGE_UNIFIED = "legacy";

import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import { billInputUsage, stampedBillingPrice } from "../src/billing.ts";
import { type Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #5303: buildRecord() persists the entire stats object (spread), but
// buildSession() restored a hand-picked whitelist that DROPPED stats.costUsd
// — the USD spend ledger (#4899). Every cold load (process restart, LRU
// eviction under sessions.max) silently zeroed historical spend, and because
// one buildRecord output feeds BOTH the JSON envelope and the index.db
// projection, the next save wrote that loss into both stores. The reporter's
// machine showed exactly this: v3 snapshot had $0.105971 for a fold lane,
// index.db.stats_json had no costUsd at all.

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

type StatsBlob = Record<string, unknown>;

function findRecordFile(dir: string): string {
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, `expected exactly one session record, found ${files.length}`);
    return join(dir, files[0] as string);
}

const LANE_LEDGER = { input: 0.0762, cacheRead: 0.0214, cacheWrite: 0.0084, output: 0.0 };

test("costUsd ledger survives a reload round-trip (#5303)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5303-rt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5303-rt");
        s.stats.requests = 20;
        // The fold-lane ledger shape from the issue report (20 requests of
        // large-prefix summarization).
        s.stats.costUsd = { ...LANE_LEDGER };
        await store.writeNow(s);
        await store.flushAll([]);

        const back = new SessionStore({ dir, debounceMs: 5, enabled: true }).loadSync("i5303-rt");
        assert.ok(back, "session reloaded");
        assert.deepEqual(back.stats.costUsd, LANE_LEDGER, "costUsd round-trips through buildSession");
        assert.equal(back.stats.requests, 20, "control counter still round-trips");
    } finally {
        rmrf(dir);
    }
});

test("restored ledger keeps accumulating instead of resetting to zero (#5303)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5303-cont-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5303-cont");
        s.stats.costUsd = { ...LANE_LEDGER };
        s.metadata.billingPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, source: "registry", model: "somehost/claude-bill" };
        await store.writeNow(s);
        await store.flushAll([]);

        const back = new SessionStore({ dir, debounceMs: 5, enabled: true }).loadSync("i5303-cont");
        assert.ok(back, "session reloaded");
        assert.ok(stampedBillingPrice(back) !== undefined, "billing stamp survives (metadata is restored wholesale)");
        const before = back.stats.costUsd?.input ?? 0;
        // 1M fresh input tokens at $3/Mtok bills exactly $3.
        billInputUsage(back, { total: 1_000_000, cached: null });
        assert.ok(Math.abs((back.stats.costUsd?.input ?? 0) - (before + 3)) < 1e-12, `ledger must accumulate ONTO the restored base (${before}+3), not restart from 0`);
    } finally {
        rmrf(dir);
    }
});

test("corrupt persisted costUsd blobs are rejected or sanitized at restore (#5303)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5303-corrupt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5303-corrupt");
        s.stats.requests = 7;
        s.stats.costUsd = { ...LANE_LEDGER };
        await store.writeNow(s);
        await store.flushAll([]);

        const file = findRecordFile(dir);
        const goodEnv = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: StatsBlob } };
        const loadMutated = async (mutate: (stats: StatsBlob) => void): Promise<Session> => {
            const env = structuredClone(goodEnv);
            mutate(env.payload.stats);
            writeFileSync(file, JSON.stringify(env));
            const fresh = new SessionStore({ dir, debounceMs: 5, enabled: true });
            try {
                const back = fresh.loadSync("i5303-corrupt");
                assert.ok(back, "session reloaded");
                return back;
            } finally {
                await fresh.flushAll([]);
            }
        };

        // All-invalid blobs read as "no ledger" — never poison the display or
        // the settlement path.
        const bad = await loadMutated((st) => { st.costUsd = { input: -1, cacheRead: "x", cacheWrite: null, output: NaN }; });
        assert.equal(bad.stats.costUsd, undefined, "all-invalid blob rejected as no-ledger");
        assert.equal(bad.stats.requests, 7, "untouched counters still restore");

        const wrongType = await loadMutated((st) => { st.costUsd = [0.1, 0.2]; });
        assert.equal(wrongType.stats.costUsd, undefined, "array blob rejected");

        // Partially-valid blobs zero-fill their missing lanes (the writer
        // always emits all four, init 0 — so zero-fill matches writer shape).
        const partial = await loadMutated((st) => { st.costUsd = { input: 5 }; });
        assert.deepEqual(partial.stats.costUsd, { input: 5, cacheRead: 0, cacheWrite: 0, output: 0 }, "partial blob zero-fills missing lanes");
    } finally {
        rmrf(dir);
    }
});

test("legacy files without costUsd stay ledger-less (#5303)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5303-legacy-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5303-legacy");
        s.stats.requests = 3;
        await store.writeNow(s);
        await store.flushAll([]);

        const file = findRecordFile(dir);
        const env = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: StatsBlob } };
        delete env.payload.stats.costUsd;
        writeFileSync(file, JSON.stringify(env));

        const back = new SessionStore({ dir, debounceMs: 5, enabled: true }).loadSync("i5303-legacy");
        assert.ok(back, "session reloaded");
        assert.equal(back.stats.costUsd, undefined, "absent stays absent — pre-billing files gain no fabricated ledger");
    } finally {
        rmrf(dir);
    }
});
