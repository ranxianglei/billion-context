import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { yieldToEventLoop } from "../src/yield-loop.js";
import { logRequestCost, _resetSlowSessionWarnedForTest } from "../src/server/request-cost.js";

// #4528: a large resent history makes bili run many O(messages) synchronous
// passes back-to-back on Node's single main thread, starving every other
// request on the same listener (incl. the web UI). The fix splits those
// stretches with cooperative yields so queued I/O callbacks drain between
// passes. These tests pin the two new units.

describe("#4528 yieldToEventLoop hands control to the poll phase", () => {
    it("a setImmediate queued before the yield runs by the time we resume", async () => {
        let immediateRan = false;
        setImmediate(() => { immediateRan = true; });
        // If the yield resolved via a microtask (queueMicrotask / Promise.resolve)
        // instead of setImmediate, the continuation would run BEFORE the check
        // phase and the callback above would still be pending here.
        await yieldToEventLoop();
        assert.equal(immediateRan, true);
    });

    it("lets a request queued mid-turn be served before the turn finishes", async () => {
        // Model one long turn as many small chunks, each yielding like the
        // instrumented prepare/preflight paths do. A "UI request" is a
        // macrotask queued up front; it must complete at a chunk boundary
        // strictly before the last chunk, not only after the whole turn.
        const TOTAL = 4000;
        const STEP = 200;
        let servedAtChunk = -1;
        let chunk = 0;
        setImmediate(() => { servedAtChunk = chunk; });
        for (let i = 0; i < TOTAL; i++) {
            if (i % STEP === 0) {
                await yieldToEventLoop();
                chunk++;
            }
        }
        const lastChunk = Math.floor((TOTAL - 1) / STEP);
        assert.ok(servedAtChunk >= 0, "queued request never ran");
        assert.ok(servedAtChunk <= lastChunk, `request only served after the turn (chunk ${servedAtChunk} > last ${lastChunk})`);
    });
});

// #5481: the wording IS the fix. The old advisory fired on inbound message
// COUNT (#4528) and asserted that per-turn synchronous work "is starving the
// event loop", advising a restart/compression — while the same line reported
// tens of milliseconds of local preparation. #5744 replaced the trigger with
// measured wall clock (count cannot separate cost from size: one reporter
// session cost 0.8s and 14.5s at the same ~3k msgs), so these tests pin the
// wall-clock trigger AND the factual, non-attributing wording together.
describe("#4528 logRequestCost slow-session guard", () => {
    function capture(): { lines: Array<[string, string]>; log: (level: string, msg: string) => void } {
        const lines: Array<[string, string]> = [];
        return { lines, log: (level, msg) => lines.push([level, msg]) };
    }
    const warns = (lines: Array<[string, string]>) => lines.filter(([l]) => l === "warn");

    it("warns once past the wall-clock budget, reporting measured facts only", () => {
        const { lines, log } = capture();
        logRequestCost(log, "sess-slow", 1500, 11_000_000, performance.now() - 8000);
        const w = warns(lines);
        assert.equal(w.length, 1);
        assert.match(w[0][1], /slow-session: 1500 msgs/);
        assert.match(w[0][1], /inbound=/);
        assert.match(w[0][1], /local=\d+ms/);
        // Load-bearing: revert to the attributed wording and this goes red.
        assert.match(w[0][1], /not evidence of event-loop starvation/);
        assert.doesNotMatch(w[0][1], /starving the event loop/);
        assert.doesNotMatch(w[0][1], /restart|enabling compression/);
        assert.ok(lines.some(([l, m]) => l === "info" && m.includes("sess-slow") && m.includes("1500 msgs")));
    });

    it("does not warn for a fast request, however large the history (#5744)", () => {
        const { lines, log } = capture();
        logRequestCost(log, "sess-small", 500, 100_000, performance.now() - 40);
        logRequestCost(log, "sess-big-fast", 1500, 11_000_000, performance.now() - 40);
        assert.equal(warns(lines).length, 0);
        assert.ok(lines.some(([l, m]) => l === "info" && m.includes("sess-big-fast") && m.includes("1500 msgs")));
    });

    it("warns for a tiny history that is slow — the trigger is wall clock, not count (#5744)", () => {
        const { lines, log } = capture();
        logRequestCost(log, "sess-tiny-slow", 13, 900_000, performance.now() - 39_000);
        const w = warns(lines);
        assert.equal(w.length, 1);
        assert.match(w[0][1], /slow-session: 13 msgs/);
        assert.match(w[0][1], /local=\d+ms/);
    });

    it("reports an unknown message count without dropping the slow warn", () => {
        const { lines, log } = capture();
        logRequestCost(log, "sess-unknown", null, 1_000_000, performance.now() - 39_000);
        const w = warns(lines);
        assert.equal(w.length, 1);
        assert.match(w[0][1], /slow-session: \? msgs/);
        assert.ok(lines.some(([l, m]) => l === "info" && m.includes("? msgs")));
    });

    it("does not warn for a fast request with an unknown message count (passthrough lane)", () => {
        const { lines, log } = capture();
        logRequestCost(log, "sess-unknown-fast", null, 1_000_000, performance.now() - 5);
        assert.equal(warns(lines).length, 0);
        assert.ok(lines.some(([l, m]) => l === "info" && m.includes("? msgs")));
    });

    it("warns only ONCE per session and carries the size picture plus the cleanup command (#5907)", () => {
        _resetSlowSessionWarnedForTest();
        const { lines, log } = capture();
        logRequestCost(log, "sess-once", 3086, 26_100_000, performance.now() - 8000);
        // The same session exceeds the wall budget on EVERY turn — the second
        // slow turn must stay silent (the #5907 field shape: one line per
        // turn of a long session).
        logRequestCost(log, "sess-once", 3090, 26_200_000, performance.now() - 9000);
        const warns = lines.filter(([l]) => l === "warn");
        assert.equal(warns.length, 1, "second slow turn of the same session must not re-warn");
        assert.match(warns[0][1], /slow-session: 3086 msgs/);
        // 26_100_000 B / 4 = 6_525_000 est tok (the repo-wide optimistic floor).
        assert.match(warns[0][1], /~6525000 est tok/);
        assert.match(warns[0][1], /bili sessions rm sess-once/);
        // A DIFFERENT session still gets its own first warning (#3617 both-ways).
        logRequestCost(log, "sess-other", 2000, 8_000_000, performance.now() - 5000);
        assert.equal(lines.filter(([l]) => l === "warn").length, 2, "another session keeps its own first warning");
    });
});
