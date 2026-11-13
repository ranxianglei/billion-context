import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressibleRange, CoreMessage, NudgeDecision } from "acp-kernel";
import { assignRefs, coveredMessageIds, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { describeUncoveredRuns, shortTokenCount, uncoveredHistoryRuns } from "../src/uncovered.ts";

// #4331: "no compressible ranges remain" fired while large mid-history spans sat
// outside every active block AND every offer. Positive gates: the stop verdict
// must audit uncovered runs before claiming the global minimum, and acp_status
// must name them. Negative gates: genuinely-drained sessions keep the verbatim
// #1387 contract string byte-stable, sub-floor residue stays silent, and tier
// distillation precedence is untouched.
const NO_RANGES_REMAIN_TEXT = "No compressible ranges remain — the context is already at its minimum; continue the task without compressing.";
const UNCOVERED_HEADER = "Uncovered history remains";
const STATUS_SECTION = "UNCOVERED HISTORY";
const SUMMARY = "SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-SUMMARY-MINIMUM-LENGTH-CHECK-OK";
const MSGS_PER_TURN = 9;

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "issue4331-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

function runApply(ctx: Ctx, args: unknown): string {
    return applyRanges(parseCompressInput(args), ctx).text;
}

function offerRange(startRef: string, endRef: string, count: number, tokens = 8000): CompressibleRange {
    return { startRef, endRef, count, tokens, chars: tokens * 4, toolPct: 0, textPct: 100 };
}
function setOffer(ctx: Ctx, ranges: CompressibleRange[], tier: number | null = null): void {
    ctx.lastNudge = { compressibleRanges: ranges, tier } as unknown as NudgeDecision;
}

// Turn layout (9 msgs): user, reasoning, text, 3x(tool-call, tool-result).
// toolName "write" stays inside recent-zone accounting (unlike bash, which is
// in NEVER_PRESERVE_RECENT_TOOLS) so zone math is exact in the drain tests.
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

// Ref of 0-based message index i (fresh dense assignment: idx i -> m(i+1)).
const refAt = (i: number) => `m${String(i + 1).padStart(5, "0")}`;
const turnSpan = (fromTurn: number, toTurn: number): { startRef: string; endRef: string } => ({
    startRef: refAt(fromTurn * MSGS_PER_TURN),
    endRef: refAt((toTurn + 1) * MSGS_PER_TURN - 1),
});

function foldArgs(spans: Array<{ startRef: string; endRef: string }>) {
    return { content: spans.map((s) => ({ startId: s.startRef, endId: s.endRef, summary: SUMMARY })) };
}

// 40 turns; fold turns 1..16 and 28..39, leaving turns 17..27 (99 msgs,
// m00154..m00252) as a mid-history hole plus turn 0 as a head residue.
function holeSession(): { ctx: Ctx; spans: Array<{ startRef: string; endRef: string }> } {
    const ctx = withRefs(makeCtx(buildSession(40, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const left = turnSpan(1, 16);
    const right = turnSpan(28, 39);
    setOffer(ctx, [offerRange(left.startRef, left.endRef, 137), offerRange(right.startRef, right.endRef, 108)]);
    return { ctx, spans: [left, right] };
}

test("#4331 P1: offer exhausted with a mid-history hole -> honest uncovered-history verdict, no false minimum claim", () => {
    const { ctx, spans } = holeSession();
    const [left, right] = spans;
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes(UNCOVERED_HEADER), "honest uncovered-history verdict expected:\n" + out);
    assert.ok(out.includes("m00154") && out.includes("m00252"), "hole span must be named:\n" + out);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "false minimum claim must not fire while uncovered mass exists:\n" + out);
});

test("#4331 P1b: the audit itself finds the post-fold hole on the real applied state", () => {
    const { ctx, spans } = holeSession();
    const [left, right] = spans;
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    const runs = uncoveredHistoryRuns({
        core: ctx.core,
        messages: ctx.messages,
        state: ctx.session.state,
        config: ctx.config,
        tokenCount: 100000,
    });
    const hole = runs.find((r) => r.startRef === "m00154" && r.endRef === "m00252");
    assert.ok(hole, `hole run missing from audit: ${JSON.stringify(runs)}`);
    assert.equal(hole.count, 99, "hole is 11 turns x 9 msgs");
    assert.ok(hole.tokens > 10000, "hole carries substantial raw mass");
});

test("#4331 N1: genuinely-drained session keeps the verbatim #1387 minimum claim", () => {
    // 12 turns, fold turns 0..10; the untouched final turn sits EXACTLY inside
    // the protected zone (preserveRecentMessages: 9 over all-visible turns).
    // The audit must classify it zone-hidden and stay silent.
    const ctx = withRefs(makeCtx(buildSession(12, 4000, "write"), { preserveRecentMessages: 9, preserveRecentTokens: 0 }));
    const span = turnSpan(0, 10);
    setOffer(ctx, [offerRange(span.startRef, span.endRef, 99)]);
    const out = runApply(ctx, foldArgs([span]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(!out.includes(UNCOVERED_HEADER), "protected tail is not leakable mass:\n" + out);
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), "verbatim contract string must survive for drained sessions:\n" + out);
});

test("#4331 N2: sub-floor residue (< 200 tok/run) stays silent, minimum claim stands", () => {
    // 8 turns with big payloads except turns 0 and 4 (tiny, < 200 tok each).
    // Fold turns 1..3 and 5..7; the two tiny residues fall below the viability
    // floor and must not manufacture an uncovered-history verdict.
    const msgs = buildSession(8, 4000, "bash");
    msgs.splice(0, MSGS_PER_TURN, ...turnMsgs(0, 0, "bash"));
    msgs.splice(4 * MSGS_PER_TURN, MSGS_PER_TURN, ...turnMsgs(4, 0, "bash"));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const left = turnSpan(1, 3);
    const right = turnSpan(5, 7);
    setOffer(ctx, [offerRange(left.startRef, left.endRef, 27), offerRange(right.startRef, right.endRef, 27)]);
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(!out.includes(UNCOVERED_HEADER), "sub-floor residue must not be reported:\n" + out);
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), "minimum claim stands below the floor:\n" + out);
});

test("#4331 P2: tier-distillation precedence — no stop signal AND no uncovered verdict while a tier is active", () => {
    const { ctx, spans } = holeSession();
    const [left, right] = spans;
    ctx.lastNudge = { compressibleRanges: [offerRange(left.startRef, left.endRef, 137), offerRange(right.startRef, right.endRef, 108)], tier: 1 } as unknown as NudgeDecision;
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "tier active: no stop signal:\n" + out);
    assert.ok(!out.includes(UNCOVERED_HEADER), "tier active: uncovered verdict suppressed too:\n" + out);
});

test("#4331 P4: tier-2 parents carry their children's coverage — the audit never reports child spans as uncovered", () => {
    // Reviewer note on the #4331 thread: in their CED-T session a tier-2
    // parent's STORED effective list looked empty on a DB-side walk while its
    // children covered the spans. The state model must not have that hole:
    // every block-creation path unions consumed children's effectiveMessageIds
    // into the new parent (kernel/src/unit-projection.ts:178-183) and
    // deactivates the children (kernel/src/compress.ts:1578-1581), so
    // coveredMessageIds — the active-block union the audit relies on
    // (kernel/src/state.ts:57-64) — sees the full distilled span. Pin it:
    // fold three adjacent T1 blocks, distill them into one T2 parent, then
    // the audit must not name any ref inside the distilled region.
    const ctx = withRefs(makeCtx(buildSession(16, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const s1 = turnSpan(1, 5);
    const s2 = turnSpan(6, 10);
    const s3 = turnSpan(11, 15);
    setOffer(ctx, [offerRange(s1.startRef, s1.endRef, 45), offerRange(s2.startRef, s2.endRef, 45), offerRange(s3.startRef, s3.endRef, 45)]);
    const out = runApply(ctx, foldArgs([s1, s2, s3]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    const refNum = (ref: string) => Number(ref.replace(/\D/g, ""));
    const t1s = ctx.session.state.blocks.filter((b) => b.tier === 1 && b.active).sort((a, b) => refNum(a.startRef ?? "") - refNum(b.startRef ?? ""));
    assert.equal(t1s.length, 3, "three T1 blocks expected before distillation");
    const distillOut = runApply(ctx, foldArgs([{ startRef: t1s[0].blockId, endRef: t1s[2].blockId }]));
    assert.ok(distillOut.startsWith("[Compressed"), `expected distillation receipt, got: ${distillOut.slice(0, 160)}`);
    const parent = ctx.session.state.blocks.find((b) => b.tier === 2 && b.active);
    assert.ok(parent, "T2 parent expected after distillation");
    assert.equal(ctx.session.state.blocks.filter((b) => b.tier === 1 && b.active).length, 0, "children must be deactivated");
    const covered = coveredMessageIds(ctx.session.state);
    for (const i of [9, 89, 134]) {
        assert.ok(covered.has(ctx.messages[i].id), `message idx ${i} (inside the distilled span) must stay covered via the T2 parent`);
    }
    const runs = uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });
    assert.ok(!runs.some((r) => refNum(r.startRef) <= 135 && refNum(r.endRef) >= 10), `distilled T2 span leaked into the audit: ${JSON.stringify(runs)}`);
});

test("#4331 P3: acp_status names uncovered runs that no offer covers (additive section)", () => {
    // Raise minCompressRange above every run so the live offer list comes up
    // empty; the mid-history hole must then surface in its own section.
    const { ctx, spans } = holeSession();
    ctx.config.compress.minCompressRange = 100000;
    const [left, right] = spans;
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    const status = handleAcpStatus({}, ctx);
    assert.ok(status.text.includes(STATUS_SECTION), "UNCOVERED HISTORY section expected:\n" + status.text);
    assert.ok(status.text.includes("m00154"), "hole span must be named in the section:\n" + status.text);
});

test("#4331 P3b: acp_status does not duplicate runs the offer list already carries", () => {
    // Default gates: the hole IS offered by the live recompute, so it belongs
    // to the Compressible-ranges list above — the section must stay silent.
    const { ctx, spans } = holeSession();
    const [left, right] = spans;
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    const status = handleAcpStatus({}, ctx);
    assert.ok(!status.text.includes(STATUS_SECTION), "offered runs must not be duplicated below the list:\n" + status.text);
    assert.ok(status.text.includes("m00154"), "the hole must still be visible via the ranges list:\n" + status.text);
});

test("#4331 N3: acp_status stays quiet on a drained session (no section)", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 4000, "write"), { preserveRecentMessages: 9, preserveRecentTokens: 0 }));
    const span = turnSpan(0, 10);
    setOffer(ctx, [offerRange(span.startRef, span.endRef, 99)]);
    const out = runApply(ctx, foldArgs([span]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    const status = handleAcpStatus({}, ctx);
    assert.ok(!status.text.includes(STATUS_SECTION), "no section for drained sessions:\n" + status.text);
});

test("#4331 unit: describeUncoveredRuns caps the listing and counts the rest", () => {
    const runs = Array.from({ length: 7 }, (_, i) => ({ startRef: `m00${100 + i}`, endRef: `m00${110 + i}`, count: 9, tokens: 5000 }));
    const s = describeUncoveredRuns(runs);
    assert.ok(s.includes("+2 more run(s)"), s);
    assert.ok(s.includes("~5K tok"), s);
    assert.equal(shortTokenCount(950), "950");
    assert.equal(shortTokenCount(1500), "~1.5K");
    assert.equal(shortTokenCount(50000), "~50K");
});
