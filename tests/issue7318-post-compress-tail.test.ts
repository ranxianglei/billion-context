// #7318: the "fold more" recommendation in the SUCCESS compress receipt — the
// remaining-offer range list and the "Uncovered history remains" audit note —
// is opt-in via compress.postComPressTail, DEFAULT OFF. Per-receipt
// re-recommendation drove models into endless fold loops against explicit user
// stop requests (0.1.216: 200+ folds in one night; #6522/#5872 same family).
// Both gate directions are pinned here (#3617):
//   OFF (default, no stamp): no range list, no uncovered note, no false
//     minimum claim; the verbatim stop signal survives for drained sessions.
//   ON (explicit): legacy range list; the uncovered note fires at most once
//     per nudge-injection cycle and a fresh ACTUAL injection re-opens it
//     (#6522).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressibleRange, CoreMessage, NudgeDecision } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressSettings } from "../src/config.ts";
import { mergeCompress } from "../src/compress-settings.ts";
import { storeUnpromptedGate } from "../src/unprompted-gate.ts";

const RANGES_HEADER = "Current compressible ranges (use these refs exactly as listed):";
const UNCOVERED_HEADER = "Uncovered history remains";
const NO_RANGES_REMAIN_TEXT = "No compressible ranges remain — the context is already at its minimum; continue the task without compressing.";
const SUMMARY = "SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-SUMMARY-MINIMUM-LENGTH-CHECK-OK";
const MSGS_PER_TURN = 9;

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

// makeCtx deliberately stamps NOTHING: an unstamped session is the DEFAULT
// configuration (postComPressTail off), which is exactly what this suite pins.
function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "issue7318-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100000, compressCreditTokens: 0, contextTokens: 0, rangeRestores: 0 },
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

function enableRecommendation(ctx: Ctx): void {
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: false, postComPressTail: true });
}

function runApply(ctx: Ctx, args: unknown): string {
    return applyRanges(parseCompressInput(args), ctx).text;
}

function offerRange(startRef: string, endRef: string, count: number, tokens = 8000): CompressibleRange {
    return { startRef, endRef, count, tokens, chars: tokens * 4, toolPct: 0, textPct: 100 };
}
function setOffer(ctx: Ctx, ranges: CompressibleRange[], tier: number | null = null): void {
    ctx.lastNudge = { compressibleRanges: ranges, tier } as unknown as NudgeDecision;
}

function turnMsgs(turn: number, payloadChars: number, toolName: string): CoreMessage[] {
    const id = (k: number) => `t${turn}_${k}`;
    const fill = "x".repeat(payloadChars);
    return [
        { id: id(0), role: "user", contentType: "text", text: `User request for turn ${turn}. ${payloadChars > 0 ? fill.slice(0, 200) : ""}` },
        { id: id(1), role: "assistant", contentType: "reasoning", text: `Reasoning for turn ${turn}. ${payloadChars > 0 ? fill.slice(0, 200) : ""}` },
        { id: id(2), role: "assistant", contentType: "text", text: `Assistant answer for turn ${turn}. ${fill}` },
        ...[0, 1, 2].flatMap((k): CoreMessage[] => [
            { id: id(3 + k * 2), role: "assistant", contentType: "tool-call", toolName, toolCallId: `tc_${turn}_${k}`, text: JSON.stringify({ input: `${toolName} step-${k} ${fill.slice(0, 600)}` }) },
            { id: id(4 + k * 2), role: "tool", contentType: "tool-result", toolName, toolCallId: `tc_${turn}_${k}`, text: `result of ${toolName} step-${k}: ${fill.slice(0, 600)}` },
        ]),
    ];
}

function buildSession(turns: number, payloadChars: number, toolName: string): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let t = 0; t < turns; t++) out.push(...turnMsgs(t, payloadChars, toolName));
    return out;
}

const refAt = (i: number) => `m${String(i + 1).padStart(5, "0")}`;
const turnSpan = (fromTurn: number, toTurn: number): { startRef: string; endRef: string } => ({
    startRef: refAt(fromTurn * MSGS_PER_TURN),
    endRef: refAt((toTurn + 1) * MSGS_PER_TURN - 1),
});

function foldArgs(spans: Array<{ startRef: string; endRef: string }>) {
    return { content: spans.map((s) => ({ startId: s.startRef, endId: s.endRef, summary: SUMMARY })) };
}

test("#7318 P1 (default OFF): partial fold — no range list, no stop claim, no note", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const first = turnSpan(0, 3);
    const second = turnSpan(4, 7);
    setOffer(ctx, [offerRange(first.startRef, first.endRef, 36), offerRange(second.startRef, second.endRef, 36)]);
    const out = runApply(ctx, foldArgs([first]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(!out.includes(RANGES_HEADER), "off by default: the remaining-offer list must not be re-advised:\n" + out);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "ranges still outstanding — the stop claim must not fire:\n" + out);
    assert.ok(!out.includes(UNCOVERED_HEADER), "no uncovered-history note while the recommendation is off:\n" + out);
});

test("#7318 P2 (default OFF): offer exhausted + mid-history hole — honest silence, no note and no false minimum claim", () => {
    // 40 turns; fold turns 1..16 and 28..39, leaving turns 17..27 (~10.9K tok)
    // as a mid-history hole above the receipt floor.
    const ctx = withRefs(makeCtx(buildSession(40, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const left = turnSpan(1, 16);
    const right = turnSpan(28, 39);
    setOffer(ctx, [offerRange(left.startRef, left.endRef, 137), offerRange(right.startRef, right.endRef, 108)]);
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(!out.includes(UNCOVERED_HEADER), "off by default: no re-nag:\n" + out);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "no 'already at its minimum' claim while material mass sits uncovered (#4331 honesty):\n" + out);
    assert.ok(!out.includes(RANGES_HEADER), "no range list:\n" + out);
});

test("#7318 P3 (default OFF): offer exhausted + drained tail — the verbatim stop signal survives", () => {
    // 12 turns, fold turns 0..10; the untouched final turn sits exactly inside
    // the protected zone, so the audit finds no leakable mass.
    const ctx = withRefs(makeCtx(buildSession(12, 4000, "write"), { preserveRecentMessages: 9, preserveRecentTokens: 0 }));
    const span = turnSpan(0, 10);
    setOffer(ctx, [offerRange(span.startRef, span.endRef, 99)]);
    const out = runApply(ctx, foldArgs([span]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(!out.includes(RANGES_HEADER) && !out.includes(UNCOVERED_HEADER), "no recommendation of any kind:\n" + out);
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), "the #1387 contract stop signal is NOT part of the recommendation and must survive in off mode:\n" + out);
});

test("#7318 N1 (explicit ON): partial fold — the legacy remaining-offer list is restored", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    enableRecommendation(ctx);
    const first = turnSpan(0, 3);
    const second = turnSpan(4, 7);
    setOffer(ctx, [offerRange(first.startRef, first.endRef, 36), offerRange(second.startRef, second.endRef, 36)]);
    const out = runApply(ctx, foldArgs([first]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes(RANGES_HEADER), "on: the remaining offer must be listed:\n" + out);
    assert.ok(out.includes(second.startRef) && out.includes(second.endRef), "the outstanding span must be named:\n" + out);
});

test("#7318 N2 (explicit ON): the uncovered note fires at most once per injection cycle; a fresh injection re-opens it (#6522)", () => {
    const ctx = withRefs(makeCtx(buildSession(40, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    enableRecommendation(ctx);
    const left = turnSpan(1, 16);
    const right = turnSpan(28, 39);
    setOffer(ctx, [offerRange(left.startRef, left.endRef, 137), offerRange(right.startRef, right.endRef, 108)]);
    // Fold 1 (offer exhausted) -> the note fires and latches the session.
    const out1 = runApply(ctx, foldArgs([left, right]));
    assert.ok(out1.startsWith("[Compressed"), `fold 1: ${out1.slice(0, 160)}`);
    assert.ok(out1.includes(UNCOVERED_HEADER), "first note expected:\n" + out1);
    assert.equal(ctx.session.uncoveredReceiptNoted, true, "latch must be a session field");
    // Fold 2: a span INSIDE the uncovered hole splits the run — the latch keeps
    // the receipt quiet (the #6522 loop step). The remaining hole is still
    // above the receipt floor, so the receipt must stay SILENT — it must not
    // fall through to the "No compressible ranges remain" claim, which would
    // assert the context is at its minimum while material mass sits uncovered
    // (#4331 honesty; the pre-#7318 code always returned the note here).
    const mid = turnSpan(18, 20);
    setOffer(ctx, [offerRange(mid.startRef, mid.endRef, 27)]);
    const out2 = runApply(ctx, foldArgs([mid]));
    assert.ok(out2.startsWith("[Compressed"), `fold 2: ${out2.slice(0, 160)}`);
    assert.ok(!out2.includes(UNCOVERED_HEADER), "second fold must not re-nag:\n" + out2);
    assert.ok(!out2.includes(NO_RANGES_REMAIN_TEXT), "latched + hole still above floor: honest silence, no false minimum claim (#4331):\n" + out2);
    // A fresh ACTUAL nudge injection (nudgeOutcome === "injected" in
    // src/server/handle.ts) re-opens the latch — the next qualifying fold may
    // note the uncovered runs once more in the new cycle.
    ctx.session.uncoveredReceiptNoted = false;
    const late = turnSpan(21, 23);
    setOffer(ctx, [offerRange(late.startRef, late.endRef, 27)]);
    const out3 = runApply(ctx, foldArgs([late]));
    assert.ok(out3.startsWith("[Compressed"), `fold 3: ${out3.slice(0, 160)}`);
    assert.ok(out3.includes(UNCOVERED_HEADER), "re-opened cycle: the note may fire once more:\n" + out3);
});

test("#7318 unit: config surface — parseCompressSettings accepts booleans only, mergeCompress deepest-wins", () => {
    assert.equal(parseCompressSettings({ postComPressTail: true })?.postComPressTail, true);
    assert.equal(parseCompressSettings({ postComPressTail: false })?.postComPressTail, false);
    assert.equal(parseCompressSettings({})?.postComPressTail, undefined, "absent = default off");
    assert.equal(parseCompressSettings({ postComPressTail: "yes" }), undefined, "non-boolean rejects the whole compress block");
    assert.equal(mergeCompress({ postComPressTail: true }, undefined, { postComPressTail: false }).postComPressTail, false, "model level wins over global");
    assert.equal(mergeCompress(undefined, { postComPressTail: true }, undefined).postComPressTail, true, "provider level wins over global");
    assert.equal(mergeCompress({ postComPressTail: true }, undefined, undefined).postComPressTail, true, "global level alone");
    assert.equal(mergeCompress(undefined, undefined, undefined).postComPressTail, undefined, "unset everywhere = off by default");
});
