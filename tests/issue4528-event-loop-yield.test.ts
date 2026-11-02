import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { yieldToEventLoop } from "../src/yield-loop.js";
import { logRequestCost } from "../src/server.js";

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

describe("#4528 logRequestCost slow-session guard", () => {
    function capture(): { lines: Array<[string, string]>; log: (level: string, msg: string) => void } {
        const lines: Array<[string, string]> = [];
        return { lines, log: (level, msg) => lines.push([level, msg]) };
    }

    it("warns when the inbound history has grown past the message threshold", () => {
        const { lines, log } = capture();
        logRequestCost(log, "sess-big", 1500, 11_000_000, performance.now() - 8000);
        const warns = lines.filter(([l]) => l === "warn");
        assert.equal(warns.length, 1);
        assert.match(warns[0][1], /slow-session: 1500 msgs/);
        assert.match(warns[0][1], /inbound=/);
        assert.match(warns[0][1], /local=\d+ms/);
    });

    it("does not warn for a healthy-sized session", () => {
        const { lines, log } = capture();
        logRequestCost(log, "sess-small", 500, 100_000, performance.now() - 40);
        assert.equal(lines.filter(([l]) => l === "warn").length, 0);
        assert.ok(lines.some(([l, m]) => l === "info" && m.includes("sess-small") && m.includes("500 msgs")));
    });
});
