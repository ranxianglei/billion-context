import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { noteUpstreamThrottle429, noteUpstreamThrottleResolved, upstreamThrottleLocalReject } from "../src/upstream-throttle.ts";

// N3 (PR #4725 round-3 review): the 429 governor's observe pair was wired only
// on the relay lane; the loop lane's own sends (compression re-requests,
// round-2+ rebuilds) — the sends most likely to retry in a storm — were
// invisible, so a 429-storming upstream never armed the hold for the next
// client turn. The loop's fetchUpstream chokepoint now notes 429 (retry
// callback + terminal UpstreamHttpError catch) and resolved (every ok settle
// — fetchWithRetry only resolves ok responses).
//
// Round-2 review F5 honesty note: this file pins the GOVERNOR CONTRACT the
// loop feeds (arm via consecutive 429 verdicts → the relay's pre-forward gate
// answers locally; a resolved verdict lifts it) — it is NOT a loop-wiring
// regression pin (it passes on master too, by design of the governor module).
// The loop-side chokepoint wiring is exercised by the e2e lanes.

test("429 governor contract: consecutive 429 verdicts arm the local gate; a resolved verdict lifts it", () => {
    const url = "http://loop-observe-4725.test/v1/chat/completions";
    const headers: Record<string, string> = {};
    // resolved verdict first: no hold exists — stays clean
    noteUpstreamThrottleResolved(url, headers, 200);
    assert.equal(upstreamThrottleLocalReject(url, headers), undefined, "no hold before any 429");
    // arm the hold with loop-shaped 429 verdicts (streak 2 → backoff armed)
    noteUpstreamThrottle429(url, headers, null);
    noteUpstreamThrottle429(url, headers, null);
    const reject = upstreamThrottleLocalReject(url, headers);
    assert.ok(reject, "hold armed after consecutive 429 verdicts");
    // a settled success (exactly what the loop notes on 2xx) lifts the hold
    noteUpstreamThrottleResolved(url, headers, 200);
    assert.equal(upstreamThrottleLocalReject(url, headers), undefined, "resolved verdict lifts the hold");
});
