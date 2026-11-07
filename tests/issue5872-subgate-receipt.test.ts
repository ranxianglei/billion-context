import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressibleRange, CoreMessage, NudgeDecision } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { uncoveredHistoryRuns } from "../src/uncovered.ts";

// #5872: the success-tail receipt named sub-gate runs as inspectable work
// orders ("not at its minimum … inspect with acp_status") — refs that fail the
// kernel's minCompressRange gate by construction — and drove 187 single-message
// compress retries after a successful fold. Positive gates: when EVERY reported
// run sits below the gate the receipt keeps the honest mass report but drops
// the refs, the minimum claim, and the inspection pointer, ending on the
// contract stop phrase; with ANY foldable run present the legacy wording stays
// byte-stable (#4331's honesty pin). Negative gates: drained and sub-floor
// sessions are untouched. Also pins #5872 fix 4: too-small rejections surface
// the picked-vs-min gap while the breaker is unarmed and yield to the breaker
// paragraph once armed (#2360 §2, one instruction per receipt).
const NO_RANGES_REMAIN_TEXT = "No compressible ranges remain — the context is already at its minimum; continue the task without compressing.";
const UNCOVERED_HEADER = "Uncovered history remains";
const SUBGATE_MARKER = "below the fold-size gate (min";
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
            id: "issue5872-test",
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

// 44 turns, payload 350 (~2.9K chars / ~750 tok per turn — each hole stays
// strictly below the 5000-char fold gate while clearing the 200-tok viability
// floor). Holes at turns 0,3,…,42 (15 of them, ~11K tok total — past the 10K
// receipt floor); folds cover the two turns between consecutive holes; the
// final turn sits exactly inside the protected zone (preserveRecentMessages: 9
// = one full turn) so the audit classifies it zone-hidden.
function subgateSession(): { ctx: Ctx; spans: Array<{ startRef: string; endRef: string }> } {
    const ctx = withRefs(makeCtx(buildSession(44, 350, "bash"), { preserveRecentMessages: 9, preserveRecentTokens: 0 }));
    const spans: Array<{ startRef: string; endRef: string }> = [];
    for (let t = 1; t <= 41; t += 3) spans.push(turnSpan(t, t + 1));
    setOffer(ctx, spans.map((s) => offerRange(s.startRef, s.endRef, 18)));
    return { ctx, spans };
}

test("#5872 P1: every run sub-gate -> honest mass report without refs, claim, or pointer", () => {
    const { ctx, spans } = subgateSession();
    const out = runApply(ctx, foldArgs(spans));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes(UNCOVERED_HEADER), "honest mass report expected:\n" + out);
    const tail = out.slice(out.indexOf(UNCOVERED_HEADER));
    assert.ok(tail.includes(SUBGATE_MARKER), "sub-gate verdict expected:\n" + out);
    assert.ok(tail.includes("Continue the task without compressing"), "contract stop phrase expected:\n" + out);
    assert.ok(!tail.includes("not at its minimum"), "false minimum claim must not fire while nothing is foldable:\n" + out);
    assert.ok(!tail.includes("acp_status"), "inspection pointer must not fire on the sub-gate path:\n" + out);
    assert.ok(!/m\d{5}/.test(tail), "sub-gate receipt must not name refs:\n" + out);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "drained-session claim must not fire while uncovered mass exists:\n" + out);
});

test("#5872 P1b: audit runs carry chars mirroring the kernel gate sum exactly", () => {
    const { ctx, spans } = subgateSession();
    const out = runApply(ctx, foldArgs(spans));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    const runs = uncoveredHistoryRuns({
        core: ctx.core,
        messages: ctx.messages,
        state: ctx.session.state,
        config: ctx.config,
        tokenCount: 100000,
    });
    assert.ok(runs.length > 0, "hole runs expected from the audit");
    const minChars = ctx.config.compress.minCompressRange;
    for (const r of runs) {
        assert.ok(r.chars > 0 && r.chars < minChars, `run ${r.startRef}-${r.endRef} must be strictly sub-gate: ${JSON.stringify(r)}`);
        assert.ok(r.tokens >= 200, "reported runs clear the viability floor");
    }
    const hole = runs.find((r) => r.startRef === "m00028" && r.endRef === "m00036");
    assert.ok(hole, `turn-3 hole missing from audit: ${JSON.stringify(runs)}`);
    const expected = ctx.messages.slice(27, 36).reduce((n, m) => n + (m.text ?? "").length, 0);
    assert.equal(hole.chars, expected, "chars must equal Σ msg.text.length over the kept entries");
});

test("#5872 P2: any foldable run present -> legacy wording byte-stable (#4331 pin)", () => {
    // Same geometry as the #4331 fixture: one 99-msg mid-history hole
    // (~55K chars) that DOES clear the gate — the old wording, refs included,
    // must survive this change untouched.
    const ctx = withRefs(makeCtx(buildSession(40, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const left = turnSpan(1, 16);
    const right = turnSpan(28, 39);
    setOffer(ctx, [offerRange(left.startRef, left.endRef, 137), offerRange(right.startRef, right.endRef, 108)]);
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes(UNCOVERED_HEADER), "uncovered verdict expected:\n" + out);
    assert.ok(out.includes("not at its minimum"), "legacy claim stands while a foldable run exists:\n" + out);
    assert.ok(out.includes('acp_status(scope:"uncompressed")'), "legacy inspection pointer stands:\n" + out);
    assert.ok(out.includes("m00154") && out.includes("m00252"), "hole span must be named:\n" + out);
    assert.ok(!out.includes(SUBGATE_MARKER), "sub-gate branch must not fire while a foldable run exists:\n" + out);
});

test("#5872 N1: genuinely-drained session keeps the verbatim #1387 minimum claim", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 4000, "write"), { preserveRecentMessages: 9, preserveRecentTokens: 0 }));
    const span = turnSpan(0, 10);
    setOffer(ctx, [offerRange(span.startRef, span.endRef, 99)]);
    const out = runApply(ctx, foldArgs([span]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(!out.includes(UNCOVERED_HEADER), "protected tail is not leakable mass:\n" + out);
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), "verbatim contract string must survive for drained sessions:\n" + out);
});

test("#5872 N2: sub-floor residue (< 200 tok/run) stays silent, minimum claim stands", () => {
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

test("#5872 P3: too-small rejection surfaces the picked-vs-min gap while unarmed, yields to the breaker once armed", () => {
    // 8 turns x ~2.7K chars (~22K total): the conversation as a whole clears
    // the gate (so the noViableAnywhere verdict stays quiet) while any single
    // turn (~2.7K chars) does not.
    const ctx = withRefs(makeCtx(buildSession(8, 300, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const r1 = runApply(ctx, foldArgs([{ startRef: "m00001", endRef: "m00009" }]));
    assert.ok(r1.startsWith("[Compression FAILED"), `expected refusal, got: ${r1.slice(0, 200)}`);
    assert.ok(/Total compressible content too small \(\d+ chars across 1 range\(s\), min 5000\)/.test(r1), "kernel too-small line expected:\n" + r1);
    assert.ok(/You picked \d+ char\(s\) — \d+ short of the 5000-char gate/.test(r1), "gap arithmetic expected:\n" + r1);
    assert.ok(r1.includes("widen the range to cover more messages"), "single-span advice expected:\n" + r1);
    assert.ok(!r1.includes("COMPRESS CIRCUIT BREAKER"), "breaker must not arm before the third failure:\n" + r1);
    const r2 = runApply(ctx, foldArgs([{ startRef: "m00010", endRef: "m00018" }]));
    assert.ok(r2.startsWith("[Compression FAILED"), `expected refusal, got: ${r2.slice(0, 200)}`);
    assert.ok(r2.includes("short of the 5000-char gate"), "gap arithmetic persists while unarmed:\n" + r2);
    const r3 = runApply(ctx, foldArgs([{ startRef: "m00019", endRef: "m00027" }]));
    assert.ok(r3.startsWith("[Compression FAILED"), `expected refusal, got: ${r3.slice(0, 200)}`);
    assert.ok(r3.includes("COMPRESS CIRCUIT BREAKER"), "breaker arms on the third consecutive failure:\n" + r3);
    assert.ok(!r3.includes("short of the"), "armed receipt yields to the breaker paragraph (#2360 §2):\n" + r3);
});
