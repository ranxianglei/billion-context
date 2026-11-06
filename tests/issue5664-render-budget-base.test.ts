import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

// #5664 review: the PR's only budget.ts delta — inputEstBaseTokens, the
// additive FROZEN-ROW basis feeding the local-est arm when ctx.processedMessages
// holds only the bounded render tail — shipped with ZERO tests referencing it
// (repo-wide grep hits src/* only). A green render round prices its inbound as
// (textCum − last-F rows) + fresh est over [F frozen][kNew]; if this term
// double-counts (review P1-2's original class) or is dropped, every steady v6
// turn silently mis-prices the #453 output clamp — either direction breaks real
// turns only at the overflow boundary. Pinned here at the decision point.
//
// Caliber notes (kept verbatim from budget.ts semantics):
//   - absent param ⇒ byte-identical legacy (third-default parameter, used only
//     INSIDE the calibrated local-est arm);
//   - the usage-grade baseline (provider-reported previous-turn input) is never
//     scaled or re-charged by the basis — it wins the max() as before (#2558/#1492);
//   - estimateCoreMessages is strictly per-message linear, which is what makes
//     the cumulative per-round deltas ≡ the full-array price (pinned below).

import type { CoreMessage } from "acp-kernel";
import { clampOutgoingOutput, estimateInputTokens } from "../src/server/budget.ts";
import { estimateCoreMessages } from "../src/preflight.ts";

const NOOP_LOG = (_level: string, _msg: string): void => {};

const shortMsgs: CoreMessage[] = [
    { id: "h_" + "a".repeat(16), role: "user", text: "hello there" } as unknown as CoreMessage,
    { id: "h_" + "b".repeat(16), role: "assistant", text: "hi" } as unknown as CoreMessage,
];

test("#5664 budget: inputEstBaseTokens is additive inside the local-est arm (identity calibration)", () => {
    const e0 = estimateInputTokens(shortMsgs, "", [], 0); // baseline arm empty; est arm only
    for (const base of [0, 1234, 100_000]) {
        assert.equal(
            estimateInputTokens(shortMsgs, "", [], 0, undefined, undefined, undefined, undefined, 0, 0, base),
            e0 + base,
            `base=${base}: basis must shift the est arm by exactly itself under identity calibration`,
        );
    }
});

test("#5664 budget: a usage-grade baseline still wins the max() uncharged by the basis", () => {
    const msgs = [];
    // Basis well below the provider-measured total: result stays the baseline
    // EXACTLY — the frozen basis must never re-scale or re-charge a
    // usage-grade reading (that arm feeds #2558/#1492 math verbatim).
    assert.equal(estimateInputTokens(msgs, "", [], 100_000, "usage", undefined, undefined, undefined, 0, 0, 50_000), 100_000);
    // Basis large enough to beat the baseline: the est arm (basis + overhead) wins.
    const overBaseline = estimateInputTokens(msgs, "", [], 100_000, "usage", undefined, undefined, undefined, 0, 0, 300_000);
    assert.ok(overBaseline >= 300_000, "large basis must lift the est arm above the usage baseline");
});

test("#5664 budget: non-usage provenance still ignores lastInputTokens (with or without basis)", () => {
    // #1492: an estimate-grade baseline must not mask the payload est through
    // the max(); the new third-default parameter must not change that.
    const plain = estimateInputTokens(shortMsgs, "", [], 50_000, "local-estimate");
    const withBasis = estimateInputTokens(shortMsgs, "", [], 50_000, "local-estimate", undefined, undefined, undefined, 0, 0, 1000);
    assert.ok(plain < 50_000, "payload est here is small — the est-grade baseline must not win");
    assert.equal(withBasis, plain + 1000);
});

interface ClampCapture {
    raw: number;
    capped: number;
    window: number;
    planningInput: number;
    ledgerFloor: number;
}

/** Clamp a rebuild carrying max_tokens=REQUESTED against NATIVE_WINDOW with the
 *  given frozen basis; returns the captured event (throws if the clamp was a
 *  no-op — the chosen numbers make both arms bind). */
function clampWith(base: number | undefined): ClampCapture {
    const rebuilt: Record<string, unknown> = { model: "m", max_tokens: REQUESTED };
    let capture: ClampCapture | null = null;
    clampOutgoingOutput(rebuilt, "max_tokens", {
        systemText: "",
        tools: [],
        processedMessages: shortMsgs,
        lastInputTokens: 0,
        nativeWindow: NATIVE_WINDOW,
        imageTokens: 0,
        ...(base === undefined ? {} : { inputEstBaseTokens: base }),
    }, "test-session", NOOP_LOG, (c) => { capture = c; });
    if (capture === null) throw new Error("expected the output clamp to fire (window arithmetic changed?)");
    return capture;
}

const NATIVE_WINDOW = 200_000;
const REQUESTED = 64_000;

test("#5664 budget: the clamp plans on (frozen basis + tail) once — exact caps both arms", () => {
    // Hand-computed against budget.ts constants (MARGIN_PCT .05 / MIN_MARGIN
    // 2048 / ESTIMATE_SAFETY 1.12 / FLOOR 1024 / MIN_OUTPUT 4096):
    //   E = 120_000 → safe = 134_400 → margin 6_720 → cap floor(200_000−134_400−6_720) = 58_880
    //   E = 130_000 → safe = 145_600 → margin 7_280 → cap floor(200_000−145_600−7_280) = 47_120
    const e0 = estimateInputTokens(shortMsgs, "", [], 0);
    const c1 = clampWith(120_000 - e0);
    const c2 = clampWith(130_000 - e0);
    assert.equal(c1.planningInput, 120_000, "planning input = basis + tail est, exact (no double-count of the frozen window)");
    assert.equal(c2.planningInput, 130_000);
    assert.equal(c1.capped, 58_880);
    assert.equal(c2.capped, 47_120, "a heavier frozen prefix tightens the outgoing budget monotonically");
    assert.ok(c2.capped < c1.capped);
});

test("#5664 budget: absent inputEstBaseTokens is byte-identical to explicit zero", () => {
    const run = (base?: number): Record<string, unknown> => {
        const rebuilt: Record<string, unknown> = { model: "m", max_tokens: REQUESTED };
        clampOutgoingOutput(rebuilt, "max_tokens", {
            systemText: "",
            tools: [],
            processedMessages: shortMsgs,
            lastInputTokens: 0,
            nativeWindow: NATIVE_WINDOW,
            imageTokens: 0,
            ...(base === undefined ? {} : { inputEstBaseTokens: base }),
        }, "test-session", NOOP_LOG);
        return rebuilt;
    };
    assert.deepEqual(run(), run(0));
    // Small est (no frozen prefix here): the shared setup must NOT bind the
    // clamp — both shapes pass max_tokens through untouched.
    assert.equal(Number(run().max_tokens), REQUESTED);
});

test("#5664 budget: estimateCoreMessages additivity — the cumulant scheme needs it", () => {
    // The render plane advances its estimate bases per-round over TAIL-ONLY
    // slices while audit rounds price the FULL row sequence. The two stay
    // comparable only because pricing is strictly per-message (no per-array
    // overhead). Pin the invariant the whole ledger relies on — including the
    // memoized kernel-minted-id path (same id|length twice must not break it).
    const a: CoreMessage[] = [{ id: "h_" + "c".repeat(16), role: "user", text: "alpha beta gamma" } as unknown as CoreMessage];
    const b: CoreMessage[] = [
        { id: "h_" + "d".repeat(16), role: "assistant", text: "delta epsilon" } as unknown as CoreMessage,
        { id: "h_" + "c".repeat(16), role: "user", text: "alpha beta gamma" } as unknown as CoreMessage, // repeated id+text: memo hit path
    ];
    assert.equal(estimateCoreMessages(a) + estimateCoreMessages(b), estimateCoreMessages([...a, ...b]));
    assert.equal(estimateCoreMessages([]) + estimateCoreMessages([...a, ...b]), estimateCoreMessages([...a, ...b]));
});
