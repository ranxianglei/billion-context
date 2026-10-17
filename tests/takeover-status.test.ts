// #3582: proxy-side display-only registry of the native host's live takeover
// health. The host pushes via the runtime-info endpoint; the proxy stores the
// latest report per agent and derives `unknown` purely from staleness, so the
// panel can't silently show "ok" when a dead/stalled host stops heartbeating.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
    TAKEOVER_STALE_MS,
    TAKEOVER_TOP_ENDPOINTS,
    _recordTakeoverStatusAt,
    _resetTakeoverStatusForTest,
    parseTakeoverReport,
    recordTakeoverStatus,
    takeoverStatusWire,
    type TakeoverReport,
} from "../src/takeover-status.ts";

const T0 = 1_700_000_000_000;

function report(over: Partial<TakeoverReport> = {}): TakeoverReport {
    return {
        state: "threw",
        refusals: 3,
        byEndpoint: [{ endpoint: "https://api.deepseek.com/anthropic/v1/messages", count: 3 }],
        sinceMs: T0,
        hostStartedAtMs: T0 - 60_000,
        ...over,
    };
}

describe("parseTakeoverReport (#3582)", () => {
    it("accepts a well-formed report and echoes its fields", () => {
        const p = parseTakeoverReport({ state: "ok", refusals: 0, byEndpoint: [], sinceMs: 10, hostStartedAtMs: 5 });
        assert.deepEqual(p, { state: "ok", refusals: 0, byEndpoint: [], sinceMs: 10, hostStartedAtMs: 5 });
    });

    it("rejects absent / non-object input", () => {
        assert.equal(parseTakeoverReport(undefined), undefined);
        assert.equal(parseTakeoverReport(null), undefined);
        assert.equal(parseTakeoverReport("threw"), undefined);
        assert.equal(parseTakeoverReport(42), undefined);
    });

    it("rejects an unknown state (forward-compat guard)", () => {
        assert.equal(parseTakeoverReport({ state: "maybe", refusals: 1, sinceMs: 1, hostStartedAtMs: 1 }), undefined);
    });

    it("requires finite non-negative numeric fields", () => {
        const base = { state: "none" as const, sinceMs: 1, hostStartedAtMs: 1 };
        assert.equal(parseTakeoverReport({ ...base, refusals: -1 }), undefined);
        assert.equal(parseTakeoverReport({ ...base, refusals: NaN }), undefined);
        assert.equal(parseTakeoverReport({ ...base, refusals: "3" }), undefined);
        assert.equal(parseTakeoverReport({ ...base, sinceMs: undefined }), undefined);
        assert.equal(parseTakeoverReport({ ...base, hostStartedAtMs: Infinity }), undefined);
        assert.ok(parseTakeoverReport({ ...base, refusals: 0 }));
    });

    it("caps byEndpoint to the top-N highest counts", () => {
        const rows = Array.from({ length: TAKEOVER_TOP_ENDPOINTS + 2 }, (_, i) => ({ endpoint: `e${i}`, count: i + 1 }));
        const p = parseTakeoverReport({ state: "threw", refusals: 9, sinceMs: 1, hostStartedAtMs: 1, byEndpoint: rows });
        assert.ok(p);
        assert.deepEqual(p.byEndpoint.map((e) => e.count), [5, 4, 3, 2, 1]);
    });

    it("drops malformed byEndpoint rows (bad endpoint or count)", () => {
        const p = parseTakeoverReport({
            state: "threw",
            refusals: 9,
            sinceMs: 1,
            hostStartedAtMs: 1,
            byEndpoint: [{ endpoint: "", count: 9 }, { endpoint: "ok", count: 2 }, { endpoint: "noCount" }],
        });
        assert.ok(p);
        assert.deepEqual(p.byEndpoint, [{ endpoint: "ok", count: 2 }]);
    });
});

describe("takeoverStatusWire (#3582)", () => {
    beforeEach(() => _resetTakeoverStatusForTest());
    afterEach(() => _resetTakeoverStatusForTest());

    it("is null when nothing has been reported", () => {
        assert.equal(takeoverStatusWire(), null);
        assert.equal(takeoverStatusWire("dsh"), null);
    });

    it("surfaces a fresh report verbatim (not stale, reportedState present)", () => {
        recordTakeoverStatus("dsh", report({ state: "threw", refusals: 7 }));
        const w = takeoverStatusWire("dsh");
        assert.ok(w);
        assert.equal(w.agent, "dsh");
        assert.equal(w.state, "threw");
        assert.equal(w.reportedState, "threw");
        assert.equal(w.stale, false);
        assert.equal(w.refusals, 7);
        assert.equal(w.sinceMs, T0);
        assert.equal(w.hostStartedAtMs, T0 - 60_000);
        assert.ok(Math.abs(w.reportedAtMs - Date.now()) < 5000);
    });

    it("derives unknown once the last report goes past the staleness window", () => {
        _recordTakeoverStatusAt("dsh", report({ state: "ok" }), T0);
        const fresh = takeoverStatusWire("dsh", T0 + TAKEOVER_STALE_MS - 1);
        assert.equal(fresh?.state, "ok");
        assert.equal(fresh?.stale, false);
        const stale = takeoverStatusWire("dsh", T0 + TAKEOVER_STALE_MS + 1);
        assert.equal(stale?.state, "unknown");
        assert.equal(stale?.stale, true);
        assert.equal(stale?.reportedState, undefined);
        assert.equal(stale?.refusals, 3);
    });

    it("selects the requested agent explicitly, else the freshest overall", () => {
        _recordTakeoverStatusAt("omp", report({ state: "none" }), T0);
        _recordTakeoverStatusAt("dsh", report({ state: "threw" }), T0 + 1000);
        // Explicit `now` inside the staleness window: the default now=Date.now()
        // would backdate the fixed T0 records into `stale`/`unknown` (time-bomb).
        const now = T0 + 2000;
        assert.equal(takeoverStatusWire("omp", now)?.state, "none");
        assert.equal(takeoverStatusWire("dsh", now)?.state, "threw");
        assert.equal(takeoverStatusWire(undefined, now)?.agent, "dsh");
    });

    it("replaces an agent's prior report rather than stacking it", () => {
        _recordTakeoverStatusAt("dsh", report({ state: "threw", refusals: 1 }), T0);
        _recordTakeoverStatusAt("dsh", report({ state: "ok", refusals: 0 }), T0 + 5000);
        // Explicit `now` = the latest ingest timestamp keeps the entry fresh
        // (default now=Date.now() would mark the fixed-T0 record stale).
        const w = takeoverStatusWire("dsh", T0 + 5000);
        assert.equal(w?.state, "ok");
        assert.equal(w?.refusals, 0);
    });

    it("bounds the registry like every other per-agent table", () => {
        for (let i = 0; i < 20; i++) recordTakeoverStatus(`a${i}`, report({ state: "ok" }));
        assert.equal(takeoverStatusWire("a0"), null, "oldest evicted");
        assert.notEqual(takeoverStatusWire("a19"), null);
    });
});
