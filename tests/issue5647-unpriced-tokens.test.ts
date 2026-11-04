import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.NODE_ENV = "test";
// Pin the envelope → buildSession() legacy reload path — the exact cold-load
// route where a whitelist drop would zero the ledger (#5303's bug class).
process.env.BILI_STORAGE_UNIFIED = "legacy";

import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import { billInputUsage, billOutputUsage, validUnpricedTokens } from "../src/billing.ts";
import type { Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #5647 item 3: requests for models with no resolvable price flowed through
// with NO trace at all — stampBillingPrice deletes the stamp, both bill*
// functions returned early, and costUsdTotal understated spend by an unknown
// amount (the reporter saw kimi-for-coding: 1,041 requests / 95.6M input /
// $0.00). Now the same settle sites count raw tokens into
// stats.unpricedTokens when no price resolves: 0.00 + unpricedTokens > 0
// means "unknown", not "free".

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

test("unpriced input settles into unpricedTokens, costUsd stays absent (#5647)", () => {
    const s = makeSession("i5647-input");
    // Split semantics: total = fresh(1100) + read(400) + write(100) = 1600.
    billInputUsage(s, { total: 1600, cached: 400, creation: 100 });
    assert.equal(s.stats.costUsd, undefined, "never a fabricated $0 ledger");
    assert.deepEqual(s.stats.unpricedTokens, { input: 1100, cacheRead: 400, cacheWrite: 100, output: 0 });

    // Inclusive semantics (openai-style): total includes cached, no creation.
    billInputUsage(s, { total: 1400, cached: 400 });
    assert.deepEqual(s.stats.unpricedTokens, { input: 2100, cacheRead: 800, cacheWrite: 100, output: 0 });

    // Zero-total reports add nothing.
    billInputUsage(s, { total: 0, cached: null });
    assert.deepEqual(s.stats.unpricedTokens, { input: 2100, cacheRead: 800, cacheWrite: 100, output: 0 });
});

test("unpriced output settles into unpricedTokens.output (#5647)", () => {
    const s = makeSession("i5647-output");
    billOutputUsage(s, 2000);
    assert.equal(s.stats.costUsd, undefined);
    assert.deepEqual(s.stats.unpricedTokens, { input: 0, cacheRead: 0, cacheWrite: 0, output: 2000 });
    billOutputUsage(s, 0);
    assert.equal(s.stats.unpricedTokens?.output, 2000, "zero output adds nothing");
});

test("priced sessions never touch unpricedTokens (negative gate) (#5647)", () => {
    const s = makeSession("i5647-priced");
    s.metadata.billingPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, source: "config", model: "claude-x" };
    billInputUsage(s, { total: 1600, cached: 400, creation: 100 });
    billOutputUsage(s, 2000);
    assert.ok(s.stats.costUsd, "priced ledger created");
    assert.ok(Math.abs(s.stats.costUsd.input - 1100 * 3 / 1e6) < 1e-12, "fresh billed at the stamped rate");
    assert.equal(s.stats.unpricedTokens, undefined, "no unpriced side-channel while priced");
});

test("mid-session price loss splits the ledgers without cross-contamination (#5647)", () => {
    const s = makeSession("i5647-mixed");
    s.metadata.billingPrice = { input: 2, source: "registry", model: "m-priced" };
    billInputUsage(s, { total: 1000, cached: null });
    // A model switch to an unknown model deletes the stamp (stampBillingPrice).
    delete s.metadata.billingPrice;
    billInputUsage(s, { total: 500, cached: null });
    billOutputUsage(s, 700);
    assert.ok(Math.abs((s.stats.costUsd?.input ?? 0) - (1000 * 2) / 1e6) < 1e-12, "pre-switch report stays priced");
    assert.deepEqual(s.stats.unpricedTokens, { input: 500, cacheRead: 0, cacheWrite: 0, output: 700 }, "post-switch reports count as unpriced");
});

test("validUnpricedTokens: same discipline as validCostUsd (#5647)", () => {
    assert.deepEqual(validUnpricedTokens({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }), { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 });
    assert.deepEqual(validUnpricedTokens({ input: 5 }), { input: 5, cacheRead: 0, cacheWrite: 0, output: 0 }, "partial blob zero-fills missing lanes");
    assert.equal(validUnpricedTokens({ input: -1, cacheRead: "x", cacheWrite: null, output: NaN }), undefined, "all-invalid reads as no ledger");
    assert.equal(validUnpricedTokens(null), undefined);
    assert.equal(validUnpricedTokens([1, 2]), undefined);
    assert.equal(validUnpricedTokens("x"), undefined);
});

type StatsBlob = Record<string, unknown>;

const UNPRICED_LEDGER = { input: 95_600_000, cacheRead: 1_200_000, cacheWrite: 0, output: 12_000 };

function findRecordFile(dir: string): string {
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, `expected exactly one session record, found ${files.length}`);
    return join(dir, files[0] as string);
}

test("unpricedTokens survives a reload round-trip (#5647)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5647-rt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5647-rt");
        s.stats.requests = 20;
        s.stats.unpricedTokens = { ...UNPRICED_LEDGER };
        await store.writeNow(s);
        await store.flushAll([]);

        const back = new SessionStore({ dir, debounceMs: 5, enabled: true }).loadSync("i5647-rt");
        assert.ok(back, "session reloaded");
        assert.deepEqual(back.stats.unpricedTokens, UNPRICED_LEDGER, "unpricedTokens round-trips through buildSession");
        assert.equal(back.stats.requests, 20, "control counter still round-trips");
    } finally {
        rmrf(dir);
    }
});

test("restored unpricedTokens keeps accumulating instead of resetting to zero (#5647)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5647-cont-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5647-cont");
        s.stats.unpricedTokens = { ...UNPRICED_LEDGER };
        await store.writeNow(s);
        await store.flushAll([]);

        const back = new SessionStore({ dir, debounceMs: 5, enabled: true }).loadSync("i5647-cont");
        assert.ok(back, "session reloaded");
        // No price resolves on the restored session either (no stamp persisted).
        billInputUsage(back, { total: 1_000_000, cached: null });
        assert.equal(back.stats.unpricedTokens?.input, UNPRICED_LEDGER.input + 1_000_000, `ledger must accumulate ONTO the restored base (${UNPRICED_LEDGER.input}+1000000), not restart from 0`);
    } finally {
        rmrf(dir);
    }
});

test("corrupt persisted unpricedTokens blobs are rejected at restore (#5647)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5647-corrupt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5647-corrupt");
        s.stats.requests = 7;
        s.stats.unpricedTokens = { ...UNPRICED_LEDGER };
        await store.writeNow(s);
        await store.flushAll([]);

        const file = findRecordFile(dir);
        const goodEnv = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: StatsBlob } };
        const loadMutated = (mutate: (stats: StatsBlob) => void): Session => {
            const env = structuredClone(goodEnv);
            mutate(env.payload.stats);
            writeFileSync(file, JSON.stringify(env));
            const fresh = new SessionStore({ dir, debounceMs: 5, enabled: true });
            const back = fresh.loadSync("i5647-corrupt");
            assert.ok(back, "session reloaded");
            return back;
        };

        const bad = loadMutated((st) => { st.unpricedTokens = { input: -1, cacheRead: "x", cacheWrite: null, output: NaN }; });
        assert.equal(bad.stats.unpricedTokens, undefined, "all-invalid blob rejected as no-ledger");
        assert.equal(bad.stats.requests, 7, "untouched counters still restore");

        const wrongType = loadMutated((st) => { st.unpricedTokens = [1, 2]; });
        assert.equal(wrongType.stats.unpricedTokens, undefined, "array blob rejected");
    } finally {
        rmrf(dir);
    }
});

test("legacy files without unpricedTokens stay ledger-less (#5647)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5647-legacy-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5647-legacy");
        s.stats.requests = 3;
        await store.writeNow(s);
        await store.flushAll([]);

        const file = findRecordFile(dir);
        const env = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: StatsBlob } };
        delete env.payload.stats.unpricedTokens;
        writeFileSync(file, JSON.stringify(env));

        const back = new SessionStore({ dir, debounceMs: 5, enabled: true }).loadSync("i5647-legacy");
        assert.ok(back, "session reloaded");
        assert.equal(back.stats.unpricedTokens, undefined, "absent stays absent — pre-fix files gain no fabricated counter");
    } finally {
        rmrf(dir);
    }
});
