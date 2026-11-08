import test from "node:test";
import assert from "node:assert/strict";
import { TRUNCATION_CLIP_RE, buildTruncationClipMarker, truncateLargeToolOutputs } from "../src/index.js";
import { defaultConfig } from "../src/config.js";
import { defaultCountTokens } from "../src/tokenize.js";

test("TRUNCATION_CLIP_RE matches exactly what truncateLargeToolOutputs writes", () => {
    // The marker the clipper builds for any token estimate must be fully
    // consumed by the exported regex — hosts (egress tripwire) rely on the
    // two staying in lockstep when wording ever changes.
    for (const tokens of [0, 1, 17, 1234567]) {
        const marker = buildTruncationClipMarker(tokens);
        assert.ok(TRUNCATION_CLIP_RE.test(marker), `marker for ~${tokens} tokens must match the clip regex`);
        assert.equal(marker.match(TRUNCATION_CLIP_RE)?.[0], marker, "regex must consume the whole marker");
    }
});

test("an actual clipped body is recognized end-to-end", () => {
    const big = "A".repeat(5000) + "B".repeat(5000);
    const messages = [
        { id: "m0", role: "user" as const, contentType: "text" as const, text: "start" },
        { id: "m1", role: "tool" as const, contentType: "tool-result" as const, toolCallId: "c1", text: big },
        { id: "m2", role: "user" as const, contentType: "text" as const, text: "hi" },
        { id: "m3", role: "assistant" as const, contentType: "text" as const, text: "done" },
    ];
    const config = { ...defaultConfig(), modelContextLimit: 1000, truncate: { ...defaultConfig().truncate, threshold: 0.1 } };
    const out = truncateLargeToolOutputs(messages, 9999, config, defaultCountTokens, { protectRecentMessages: 0 });
    assert.equal(out.truncatedCount, 1);
    const clipped = out.messages[1]!.text!;
    const m = TRUNCATION_CLIP_RE.exec(clipped);
    assert.ok(m, "clipped body carries the marker");
    // head + tail reconstruction: the kept ends are the original's ends.
    const head = clipped.slice(0, m!.index);
    const tail = clipped.slice(m!.index + m![0].length);
    assert.ok(big.startsWith(head) && big.endsWith(tail));
});
