import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.NODE_ENV = "test";
// Same guard as the #2129 suite: pin the legacy layer so the unified index
// cannot mask the envelope-level restore under test.
process.env.BILI_STORAGE_UNIFIED = "legacy";

import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import { displayContextBest, staleSmallAnchorFallback, type Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #5914: buildRecord persists the per-send billing-caliber estimate pair
// (#2117) and the usage anchor's own payload snapshot (#4805) via spread, but
// the #2129-era restore whitelist dropped all three — after a restart
// displayContextBest fell back from the calibrated estimate to the char-count
// upper bound (the caliber flip the report saw as a ~2.7× context jump) and
// two decision guards sat disarmed until the next send/settle re-stamped them
// (staleSmallAnchorFallback reads contextEstimateTokens; the effectiveTokenCount
// size guard requires lastUsagePayloadUpper > 0). This suite pins the restore
// contract: legal values round-trip (incl. 0 and false), corrupt values are
// rejected, legacy records without the fields keep their old behavior, the
// transient fields stay dropped, and the display/guard readers see the
// restored values from the first post-restart reading.

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

async function reload(dir: string, id: string): Promise<Session> {
    const fresh = new SessionStore({ dir, debounceMs: 5, enabled: true });
    try {
        const back = fresh.loadSync(id);
        assert.ok(back, "session reloaded");
        return back;
    } finally {
        await fresh.flushAll([]);
        fresh.cancelAll();
    }
}

/** The report's desensitized terminal state: a settled usage anchor, an
 *  estimate-grade current reading, and the three fields under test. */
function fixtureStats(st: Session["stats"], opts?: { source?: "usage" | "estimate" }): void {
    st.lastInputTokens = 94_931;
    st.lastInputTokensSource = "usage";
    st.lastUsageGradeTokens = 94_931;
    st.contextTokens = 259_141;
    st.contextTokensSource = opts?.source ?? "estimate";
    st.localInputEstimate = 259_141;
    st.contextEstimateTokens = 95_447;
    st.contextEstimateCalibrated = true;
    st.lastUsagePayloadUpper = 257_988;
}

test("estimate pair + payload anchor survive a reload round-trip; the display keeps its caliber (#5914)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5914-rt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5914-rt");
        fixtureStats(s.stats);
        await store.writeNow(s);
        await store.flushAll([]);

        const back = await reload(dir, "i5914-rt");
        assert.equal(back.stats.contextEstimateTokens, 95_447, "contextEstimateTokens round-trips");
        assert.equal(back.stats.contextEstimateCalibrated, true, "contextEstimateCalibrated round-trips");
        assert.equal(back.stats.lastUsagePayloadUpper, 257_988, "lastUsagePayloadUpper round-trips");
        // The visible symptom: pre-restart the bar reads the calibrated
        // estimate; post-restart it must NOT flip to the char-count upper.
        assert.deepEqual(displayContextBest(back), { tokens: 95_447, kind: "estimate", calibrated: true }, "display stays on the calibrated estimate, not the upper bound");
        assert.deepEqual(displayContextBest(back), displayContextBest(s), "restart must not change the display reading");
        // Sibling #2129 fields unaffected.
        assert.equal(back.stats.localInputEstimate, 259_141, "localInputEstimate still round-trips");
        assert.equal(back.stats.lastUsageGradeTokens, 94_931, "lastUsageGradeTokens still round-trips");
    } finally {
        rmrf(dir);
    }
});

test("a usage-grade reading still outranks the restored estimate (#5914)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5914-usage-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5914-usage");
        fixtureStats(s.stats, { source: "usage" });
        s.stats.contextTokens = 94_931;
        await store.writeNow(s);
        await store.flushAll([]);

        const back = await reload(dir, "i5914-usage");
        assert.equal(back.stats.contextEstimateTokens, 95_447, "estimate restored alongside");
        assert.deepEqual(displayContextBest(back), { tokens: 94_931, kind: "usage" }, "usage wins over the estimate — restoring the estimate must not demote a real measurement");
    } finally {
        rmrf(dir);
    }
});

test("legal zero and false survive the round-trip (#5914)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5914-zero-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5914-zero");
        fixtureStats(s.stats);
        s.stats.contextEstimateTokens = 0;
        s.stats.contextEstimateCalibrated = false;
        s.stats.lastUsagePayloadUpper = 0;
        await store.writeNow(s);
        await store.flushAll([]);

        const back = await reload(dir, "i5914-zero");
        assert.equal(back.stats.contextEstimateTokens, 0, "legal 0 estimate preserved (not dropped as falsy)");
        assert.equal(back.stats.contextEstimateCalibrated, false, "legal false flag preserved (not dropped as falsy)");
        assert.equal(back.stats.lastUsagePayloadUpper, 0, "legal 0 anchor snapshot preserved");
    } finally {
        rmrf(dir);
    }
});

test("records written before the fields existed keep legacy behavior (#5914)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5914-legacy-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5914-legacy");
        fixtureStats(s.stats);
        await store.writeNow(s);
        await store.flushAll([]);

        // Simulate an older version's file: strip the three fields from disk.
        const file = findRecordFile(dir);
        const env = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: StatsBlob } };
        delete env.payload.stats.contextEstimateTokens;
        delete env.payload.stats.contextEstimateCalibrated;
        delete env.payload.stats.lastUsagePayloadUpper;
        writeFileSync(file, JSON.stringify(env));

        const back = await reload(dir, "i5914-legacy");
        assert.equal(back.stats.contextEstimateTokens, undefined, "absent estimate stays absent");
        assert.equal(back.stats.contextEstimateCalibrated, undefined, "absent flag stays absent");
        assert.equal(back.stats.lastUsagePayloadUpper, undefined, "absent anchor snapshot stays absent");
        // Legacy fall-through: no estimate → the upper-bound reading, exactly
        // today's display for such sessions.
        assert.deepEqual(displayContextBest(back), { tokens: 259_141, kind: "upper" }, "legacy sessions keep the upper-bound display");
        assert.equal(back.stats.localInputEstimate, 259_141, "sibling fields untouched");
    } finally {
        rmrf(dir);
    }
});

test("corrupt persisted values are rejected at restore (#5914)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5914-corrupt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5914-corrupt");
        fixtureStats(s.stats);
        await store.writeNow(s);
        await store.flushAll([]);

        const file = findRecordFile(dir);
        const goodEnv = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: StatsBlob } };
        const loadMutated = async (mutate: (stats: StatsBlob) => void): Promise<Session> => {
            const env = structuredClone(goodEnv);
            mutate(env.payload.stats);
            writeFileSync(file, JSON.stringify(env));
            return reload(dir, "i5914-corrupt");
        };

        // Negative estimate/anchor are nonsense; a string flag is not a
        // boolean; null stands in for JSON-encoded NaN/Infinity.
        const bad = await loadMutated((st) => {
            st.contextEstimateTokens = -5;
            st.contextEstimateCalibrated = "true";
            st.lastUsagePayloadUpper = null;
        });
        assert.equal(bad.stats.contextEstimateTokens, undefined, "negative estimate rejected");
        assert.equal(bad.stats.contextEstimateCalibrated, undefined, "non-boolean flag rejected");
        assert.equal(bad.stats.lastUsagePayloadUpper, undefined, "null anchor snapshot rejected");
        assert.equal(bad.stats.localInputEstimate, 259_141, "untouched valid sibling still restores");

        // A non-numeric string is rejected too, and the flag alone can be
        // present without the value (must not fabricate a pairing).
        const partial = await loadMutated((st) => {
            st.contextEstimateTokens = "big";
            st.contextEstimateCalibrated = false;
            st.lastUsagePayloadUpper = 257_988;
        });
        assert.equal(partial.stats.contextEstimateTokens, undefined, "string estimate rejected");
        assert.equal(partial.stats.contextEstimateCalibrated, false, "valid flag restores independently");
        assert.equal(partial.stats.lastUsagePayloadUpper, 257_988, "valid anchor snapshot restores independently");
    } finally {
        rmrf(dir);
    }
});

test("in-memory-only measurement fields still ride to disk but are not restored (#5914 boundary)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5914-transient-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5914-transient");
        fixtureStats(s.stats);
        s.stats.pendingFoldUsage = true;
        s.stats.lastLocalTextEstimate = 111;
        s.stats.lastLocalTextEstimateOrigin = "http://127.0.0.1:8787";
        await store.writeNow(s);
        await store.flushAll([]);

        const back = await reload(dir, "i5914-transient");
        assert.equal(back.stats.pendingFoldUsage, undefined, "pendingFoldUsage intentionally not restored (#2129 triage)");
        assert.equal(back.stats.lastLocalTextEstimate, undefined, "lastLocalTextEstimate intentionally not restored (pending k̂ pair)");
        assert.equal(back.stats.lastLocalTextEstimateOrigin, undefined, "lastLocalTextEstimateOrigin intentionally not restored");
        assert.equal(back.stats.contextEstimateTokens, 95_447, "durable trio unaffected by the transient boundary");
    } finally {
        rmrf(dir);
    }
});

test("decision guards see the restored values from the first post-restart reading (#5914)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5914-guards-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i5914-guards");
        fixtureStats(s.stats);
        await store.writeNow(s);
        await store.flushAll([]);

        const back = await reload(dir, "i5914-guards");
        // #4383 stale-small guard: a 4.7k sidecar sample under the restored
        // 95k estimate is demoted to the estimate again — pre-fix the lost
        // estimate made this return null and the poison stood.
        assert.equal(staleSmallAnchorFallback(back.stats, 4_733), 95_447, "stale-small fallback armed on the restored estimate");
        // #4805 size guard input: the effectiveTokenCount refusal needs a
        // positive finite lastUsagePayloadUpper (src/server.ts:2908-2912); the
        // guard logic itself is pinned by the #4805 suites.
        const upper = back.stats.lastUsagePayloadUpper;
        assert.ok(typeof upper === "number" && Number.isFinite(upper) && upper > 0, "size guard sees a positive finite payload snapshot");
    } finally {
        rmrf(dir);
    }
});
