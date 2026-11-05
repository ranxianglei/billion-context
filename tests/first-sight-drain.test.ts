import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSightDrainActive, withFirstSightDrain, withStagedCompressGuidance } from "../src/compress-tool.ts";

// #2326 first-sight mass digestion guidance. The kernel appends
// " [first-sight mass]" to the nudge reason while a pre-inflated backlog is
// still being digested (and re-arms it after every successful fold), so the
// host can key the batched-drain note on that marker. Outside digestion the
// wrapper must stay byte-identical to the legacy staged-guidance path.

const MARKER_REASON = "context pressure: first-sight mass ready [first-sight mass]";
const PLAIN_REASON = "context pressure: growth 51200 tokens since reference";

function withShrinkSwitch(value: string | undefined, fn: () => void): void {
    const prev = process.env.BILI_MAX_SHRINK_PER_COMPRESS;
    try {
        if (value === undefined) delete process.env.BILI_MAX_SHRINK_PER_COMPRESS;
        else process.env.BILI_MAX_SHRINK_PER_COMPRESS = value;
        fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_MAX_SHRINK_PER_COMPRESS;
        else process.env.BILI_MAX_SHRINK_PER_COMPRESS = prev;
    }
}

test("#2326: firstSightDrainActive keys on the kernel marker only", () => {
    assert.equal(firstSightDrainActive(MARKER_REASON), true);
    assert.equal(firstSightDrainActive(PLAIN_REASON), false);
    assert.equal(firstSightDrainActive(""), false);
    assert.equal(firstSightDrainActive(undefined), false);
});

test("#2326: no marker → byte-identical to the legacy staged path", () => {
    withShrinkSwitch(undefined, () => {
        assert.equal(withFirstSightDrain("NUDGE", PLAIN_REASON, false), withStagedCompressGuidance("NUDGE"), "switch off → unchanged");
        assert.equal(withFirstSightDrain("NUDGE", undefined, true), withStagedCompressGuidance("NUDGE"), "reason undefined → unchanged");
    });
    withShrinkSwitch("0.3", () => {
        assert.equal(withFirstSightDrain("NUDGE", PLAIN_REASON, false), withStagedCompressGuidance("NUDGE"), "switch on, no marker → staged guidance still applies");
    });
});

test("#2326: marker → drain note appended, staged guidance suppressed", () => {
    withShrinkSwitch("0.3", () => {
        const out = withFirstSightDrain("NUDGE", MARKER_REASON, false);
        assert.ok(out.startsWith("NUDGE"), "keeps the original nudge");
        assert.ok(out.includes("First-sight digestion"), "appends the drain note");
        assert.ok(out.includes("ONE batched compress call"), "steers toward one batched call");
        assert.ok(out.includes("starting point of the batch, not its limit"), "carries the directive-precedence sentence");
        assert.ok(!out.includes("Smooth-transition guidance"), "staged note suppressed during digestion (opposite steering)");
    });
});

test("#2326: marker + external summaries → external variant", () => {
    const out = withFirstSightDrain("NUDGE", MARKER_REASON, true);
    assert.ok(out.includes("independent summary service"), "external variant names the service");
    assert.ok(out.includes("response-length budget is not a limit"), "external variant lifts the output-budget concern");
    assert.ok(!out.includes("each summary within its cap"), "per-summary cap wording only in the self-written variant");
    assert.ok(!out.includes("Smooth-transition guidance"), "staged note suppressed during digestion");
});

test("#2326: drain note is byte-stable for equal inputs", () => {
    const a = withFirstSightDrain("NUDGE", MARKER_REASON, false);
    const b = withFirstSightDrain("NUDGE", MARKER_REASON, false);
    assert.equal(a, b, "prefix-cache anchor requires deterministic text");
    assert.notEqual(a, withFirstSightDrain("NUDGE", MARKER_REASON, true), "external flag switches the constant");
});
