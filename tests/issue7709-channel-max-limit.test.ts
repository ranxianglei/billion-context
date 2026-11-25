import test from "node:test";
import assert from "node:assert/strict";
import { inspectContextOverflow } from "../src/util.ts";

// #7709: OpenAI-compatible self-hosted / gateway upstreams (e.g. a MaaS relay)
// meter a per-CHANNEL ceiling and phrase the rejection as
//   "prompt tokens (611188) exceeds channel max limit (512000)"
// — no context / model / length keyword at all, so none of the pre-existing
// CONTEXT_OVERFLOW_PATTERNS matched, isOverflow stayed false, and the overflow
// self-heal (armOverflowShrink / window learn / same-request refold) never
// engaged. Pinned both directions:
//   (a) the channel-max body is detected, learns window=512000 and the rejected
//       payload size (611188);
//   (b) a channel-level RATE / concurrency limit phrased in the same family
//       (no token subject) is NOT treated as overflow — it must not arm a
//       token-space shrink.

test("#7709: 'prompt tokens (N) exceeds channel max limit (W)' → overflow + window + rejected size", () => {
    const body = JSON.stringify({
        message:
            "prompt tokens (611188) exceeds channel max limit (512000) (request id: 20261125092351544169174Gmky3eHF)",
        type: "maas_error",
        param: "",
        code: null,
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 512000);
    assert.equal(info.requestedTotal, 611188);
    assert.equal(info.requestedMessages, 611188);
});

test("#7709: plain-text 'exceeds channel maximum limit (W)' variant also detected", () => {
    const info = inspectContextOverflow(
        413,
        "prompt tokens (700000) exceeds channel maximum limit (655360)",
    );
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 655360);
    assert.equal(info.requestedTotal, 700000);
});

test("#7709: channel-level RATE limit in the same family does NOT arm overflow", () => {
    // No token subject before "channel max limit" → this is a rate/concurrency
    // ceiling, not a context-size wall; arming a token shrink here would be a
    // spurious over-compression.
    const body = JSON.stringify({
        message: "channel max limit (200) reached for channel 7, please retry later",
        type: "gateway_error",
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, false);
});

test("#7709: a non-plausible status (200) carrying a channel-max body is not overflow", () => {
    // The status gate stays the outer fence: a 200 (anything outside
    // 400/413/5xx) carrying a channel-max body must not be judged overflow.
    const body = "prompt tokens (611188) exceeds channel max limit (512000)";
    const info = inspectContextOverflow(200, body);
    assert.equal(info.isOverflow, false);
});
