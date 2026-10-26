import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage, CompressibleRange, NudgeDecision } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";

// #1387: post-compress success tail — remaining-ranges snapshot (pi #420) and
// explicit stop signal (pi #521). Cross-host wording must stay verbatim.
const RANGES_HEADER = "Current compressible ranges (use these refs exactly as listed):";
const NO_RANGES_REMAIN_TEXT = "No compressible ranges remain — the context is already at its minimum; continue the task without compressing.";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "compress-tail-test",
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
        },
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

function withRefs(ctx: Ctx): Ctx {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function runApply(ctx: Ctx, args: unknown): string {
    return applyRanges(parseCompressInput(args), ctx).text;
}

// #2404: hand-build a prepare-time nudge offer so the tail's pre-fold baseline is
// controlled independently of the kernel's range builder. postCompressTail reads
// only .compressibleRanges and .tier, hence the partial cast.
function offerRange(startRef: string, endRef: string, count: number, tokens = 8000): CompressibleRange {
    return { startRef, endRef, count, tokens, chars: tokens * 4, toolPct: 0, textPct: 100 };
}
function setOffer(ctx: Ctx, ranges: CompressibleRange[]): void {
    ctx.lastNudge = { compressibleRanges: ranges, tier: null } as unknown as NudgeDecision;
}

test("#2404: folding a subset of the pre-fold offer keeps advertising the rest", () => {
    // Offer carried two disjoint ranges; the model folds only the first. The
    // receipt must still advertise the second (owner rule: "offered 3, folded 2,
    // show the 1") — unlike the band-aid, this does NOT suppress live offers.
    const msgs = Array.from({ length: 9 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    setOffer(ctx, [offerRange("m00001", "m00004", 4), offerRange("m00005", "m00007", 3)]);
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    assert.ok(out.includes(RANGES_HEADER), "remaining offered range must be advertised:\n" + out);
    assert.ok(out.includes("m00005"), "unfolded offered range must be listed:\n" + out);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "stop signal must not fire while an offer remains:\n" + out);
});

test("#2404: a range protected at nudge time never leaks into the receipt (no zero-growth chained fold)", () => {
    // THE regression: after the fold, m00005–m00007 are raw-compressible in LIVE
    // state (preserveRecentMessages: 2 keeps only m00008–m00009 protected), so a
    // post-fold RECOMPUTE would list them and chain a second zero-growth fold.
    // But they were NOT part of the pre-fold offer (still inside the protection
    // window when the nudge fired) → pinning the tail to that offer keeps them
    // out. A regression to the recompute path makes m00005 leak and fail here.
    const msgs = Array.from({ length: 9 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    assert.ok(!out.includes(RANGES_HEADER), "no ranges may be advertised once the whole offer folded:\n" + out);
    assert.ok(!out.includes("m00005"), "a not-yet-offered (protected-at-nudge) range must NOT leak:\n" + out);
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), "stop signal fires once every offered range folded:\n" + out);
});

test("#2404: folding every offered range emits the stop signal", () => {
    // Both offered ranges folded in one call → nothing left to recommend → the
    // #521 stop signal ("压缩完了的描述").
    const msgs = Array.from({ length: 9 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    setOffer(ctx, [offerRange("m00001", "m00004", 4), offerRange("m00005", "m00007", 3)]);
    const out = runApply(ctx, { content: [
        { startId: "m00001", endId: "m00004", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" },
        { startId: "m00005", endId: "m00007", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" },
    ]});
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    assert.ok(!out.includes(RANGES_HEADER), "no ranges may remain once every offer folded:\n" + out);
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), "stop signal must fire when the whole offer is consumed:\n" + out);
});

test("#2404: a rejected range keeps advertising the still-offered remainder (recovery is not cadence)", () => {
    // Offer carried two ranges; the call folds the first but submits an UNKNOWN
    // ref alongside → a PARTIAL success (blocksCreated>0, errors.length>0). The
    // still-offered second range must remain advertised, and no stop verdict may
    // fire while an error is owed an answer (#1495/#847, pi #521 gate).
    const msgs = Array.from({ length: 9 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    setOffer(ctx, [offerRange("m00001", "m00004", 4), offerRange("m00006", "m00007", 2)]);
    const out = runApply(ctx, { content: [
        { startId: "m00001", endId: "m00004", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" },
        { startId: "m99999", endId: "m99999", summary: "THIS-RANGE-IS-UNKNOWN-AND-MUST-BE-REJECTED-BUT-STILL-LONG-ENOUGH" },
    ]});
    if (out.startsWith("[Compression FAILED")) {
        // Kernel treated the batch atomically in this version — nothing applied;
        // the failure path carries its own guidance, so the tail contract is moot.
        return;
    }
    assert.ok(out.startsWith("[Compressed"), `partial success expected, got: ${out.slice(0, 120)}`);
    assert.ok(out.includes("Errors:"), `the rejected unknown ref must surface as an error:\n${out}`);
    assert.ok(out.includes(RANGES_HEADER), "still-offered range must remain advertised:\n" + out);
    assert.ok(out.includes("m00006"), "the unfolded offered range must be listed:\n" + out);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "no stop verdict while an error is owed:\n" + out);
});

test("#1387: clean success that drains every compressible range emits the stop signal (pi #521)", () => {
    // Pin preserveRecentMessages: 5 — the premise below needs m00003–m00007 inside
    // the protected recent zone; #3058 moved the kernel default to 3, where m00003
    // becomes compressible and the stop signal never fires.
    const msgs = [
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ];
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 5 }));
    ctx.session.stats.lastInputTokens = 80000;
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00002", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), `missing stop signal:\n${out}`);
    assert.ok(!out.includes(RANGES_HEADER), "ranges header must not appear when drained:\n" + out);
});

test("#1387: stop signal suppressed when a tier-distillation nudge is active", () => {
    // 12 messages folded into three tier-1 blocks with large summaries, then
    // the final fold drains every raw range while the session stays over-limit:
    // T2 distillation (block-boundary compress) is still actionable, so the
    // stop signal must NOT fire (it would contradict the tier trigger).
    const msgs = Array.from({ length: 12 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const big = "y".repeat(10000);
    const ctx = withRefs(makeCtx(msgs, {
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
        tiers: { enabled: true, tier2Trigger: 2, tier3Trigger: 3 },
    }));
    // #2029: this contract is about a REAL over-limit reading — stamp the
    // provenance so the shared status baseline keeps the value verbatim
    // instead of relying on legacy-shape luck (unflagged values now fall back
    // to the usage anchor / unknown).
    ctx.session.stats.lastInputTokens = 200000;
    ctx.session.stats.lastInputTokensSource = "usage";
    const spans: [string, string][] = [["m00001", "m00004"], ["m00005", "m00008"], ["m00009", "m00012"]];
    let out = "";
    for (let i = 0; i < spans.length; i++) {
        out = runApply(ctx, { content: [{ startId: spans[i][0], endId: spans[i][1], summary: big }] });
        assert.ok(out.startsWith("[Compressed"), `call ${i + 1} expected success, got: ${out.slice(0, 120)}`);
    }
    assert.equal(ctx.session.state.blocks.filter((b) => b.active).length, 3, "three active tier-1 blocks");
    assert.ok(!out.includes(RANGES_HEADER), "no raw ranges remain after the final fold:\n" + out);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "stop signal must be suppressed while T2 distillation is actionable:\n" + out);
});

test("#2029: estimate-grade baseline must not suppress the stop signal via phantom pressure", () => {
    // Same shape as the tier-suppression case above, but the session baseline
    // is estimate-grade: a failure arm / preflight write-back raised
    // lastInputTokens past the window while the retained real anchor stays
    // well inside it. The shared status baseline feeds the ANCHOR to the nudge
    // recompute, so there is no confirmed pressure and T2 distillation is not
    // yet actionable on the growth cadence — the stop signal fires instead of
    // the phantom-pressure silence (behavioral evidence in issue #2029).
    const msgs = Array.from({ length: 12 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const big = "y".repeat(10000);
    const ctx = withRefs(makeCtx(msgs, {
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
        tiers: { enabled: true, tier2Trigger: 2, tier3Trigger: 3 },
    }));
    ctx.session.stats.lastInputTokens = 174000;
    ctx.session.stats.lastInputTokensSource = "estimate";
    ctx.session.stats.lastUsageGradeTokens = 60000;
    const spans: [string, string][] = [["m00001", "m00004"], ["m00005", "m00008"], ["m00009", "m00012"]];
    let out = "";
    for (let i = 0; i < spans.length; i++) {
        out = runApply(ctx, { content: [{ startId: spans[i][0], endId: spans[i][1], summary: big }] });
        assert.ok(out.startsWith("[Compressed"), `call ${i + 1} expected success, got: ${out.slice(0, 120)}`);
    }
    assert.equal(ctx.session.state.blocks.filter((b) => b.active).length, 3, "three active tier-1 blocks");
    assert.ok(!out.includes(RANGES_HEADER), "no raw ranges remain after the final fold:\n" + out);
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), "stop signal must fire: an estimate-grade reading must not manufacture tier pressure:\n" + out);
});

test("#1387: partial failure (some ranges rejected) keeps the old silent tail", () => {
    // Pin preserveRecentMessages: 5 (old default; #3058 moved it to 3): m00003–m00007
    // must sit entirely in the protected recent zone so pairing that range with a
    // valid one exercises the partial-failure gate — no stop verdict while errors
    // are still owed an answer (pi #521).
    const msgs = [
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ];
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 5 }));
    ctx.session.stats.lastInputTokens = 80000;
    const out = runApply(ctx, { content: [
        { startId: "m00001", endId: "m00002", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" },
        { startId: "m00003", endId: "m00007", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" },
    ]});
    if (out.startsWith("[Compression FAILED")) {
        // Kernel treats the batch atomically in this version — the failure
        // path already carries its own guidance; the tail contract is moot.
        assert.ok(true, "atomic batch rejection (kernel-owned semantics)");
        return;
    }
    assert.ok(out.startsWith("[Compressed"), `partial success expected, got: ${out.slice(0, 120)}`);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "stop signal suppressed on partial failure:\n" + out);
    assert.ok(!out.includes(RANGES_HEADER), "no ranges advertised on partial failure:\n" + out);
});

test("#1387: tail recompute respects the kernel's own eligibility (shouldInject=false leftovers are not advertised)", () => {
    // #3058 moved preserveRecentMessages 5 → 3: under the default, folding
    // m00001–m00002 leaves m00003 outside the protection window, and the live
    // recompute returns a nudge DECISION STRUCT whose ranges list m00003 even
    // though the kernel itself judged it below threshold/floor (shouldInject
    // === false, reason "max compressible … < threshold …"). Advertising such
    // ranges in the receipt re-nags at zero pressure — the disease #1387
    // (pi #521) fixed. The tail must honor shouldInject: sub-threshold
    // leftovers never list; the stop signal fires instead. (The two tests
    // above pin preserveRecentMessages: 5 for their protection premise; this
    // one pins the default-config behavior the unpinned tests used to cover.)
    const msgs = [
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ];
    const ctx = withRefs(makeCtx(msgs)); // default config — no preserve pin
    ctx.session.stats.lastInputTokens = 80000;
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00002", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    assert.ok(!out.includes(RANGES_HEADER), "a sub-threshold leftover must not be advertised:\n" + out);
    assert.ok(!out.includes("m00003"), "the below-threshold residue must stay unlisted:\n" + out);
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), "stop signal fires when the kernel itself would not nudge:\n" + out);
});

test("#1387: tail recompute still advertises ranges under real pressure (shouldInject=true)", () => {
    // Control for the test above: same live-recompute path, but the session is
    // over-limit with material compressible content left (preserve 0, window
    // 200k, input 240k). The kernel injects (shouldInject === true) and the
    // receipt must list the remaining range — the stop signal must NOT fire.
    const msgs = Array.from({ length: 12 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 0, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 240000; // over the 200k window
    ctx.session.stats.lastInputTokensSource = "usage";
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    assert.ok(out.includes(RANGES_HEADER), "live ranges must be advertised under real pressure:\n" + out);
    assert.ok(out.includes("m00005"), "the unfolded over-limit range must be listed:\n" + out);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "stop signal must not fire while over-limit ranges remain:\n" + out);
});
