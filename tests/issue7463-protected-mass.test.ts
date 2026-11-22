import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressibleRange, CoreMessage, NudgeDecision } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { buildContextView } from "../src/context-view.ts";
import { storeUnpromptedGate } from "../src/unprompted-gate.ts";
import {
  PROTECTED_MASS_RENDER_FLOOR,
  formatProtectedMass,
  formatProtectedMassCompact,
  type ProtectedMassLedger,
  uncoveredAudit,
  uncoveredHistoryRuns,
} from "../src/uncovered.ts";

// #7463: the usage meter bills protected mass (hard BLOCKED + soft zone) but
// every decision surface skipped it — the meter-vs-offer gap was
// unexplainable from the model's side (session-8421629a: 400K meter, 37K
// offered, ~100K unaccounted, no surface could name it). Positive gates: the
// audit tallies both classes, acp_status renders the line (independently of
// uncovered runs), and the drained-fold receipt names it. Negative gates:
// sub-floor mass stays silent, hard-protected messages never leak into the
// uncovered runs, and uncoveredHistoryRuns keeps its byte-stable shape.
const STATUS_LINE = "PROTECTED MASS";
const RECEIPT_LINE = "Also protected (never in any offer)";
const SUMMARY = "SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-SUMMARY-MINIMUM-LENGTH-CHECK-OK";
const MSGS_PER_TURN = 9;

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    const ctx: Ctx = {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "issue7463-test",
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
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: false, postComPressTail: true });
    return ctx;
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

// Hand-bind a mid-history message to the BLOCKED sentinel — the shape the
// kernel's ref pass writes at protection time (kernel/src/refs.ts:125).
function block(ctx: Ctx, index: number): CoreMessage {
    const msg = ctx.messages[index];
    ctx.session.state.messageRefs.byRaw[msg.id] = "BLOCKED";
    return msg;
}

function auditOf(ctx: Ctx) {
    return uncoveredAudit({
        core: ctx.core,
        messages: ctx.messages,
        state: ctx.session.state,
        config: ctx.config,
        tokenCount: 100000,
    });
}

test("#7463 P1: uncoveredAudit tallies hard (BLOCKED) and zone mass alongside the runs", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 8000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    block(ctx, 20);
    const audit = auditOf(ctx);
    assert.equal(audit.mass.hardCount, 1, "exactly the hand-bound message is hard-protected");
    assert.ok(audit.mass.hardTokens > 500, "the blocked 8K-payload message carries real mass");
    assert.ok(audit.mass.zoneCount >= 3, "the protected recent window (last 3 msgs) is tallied as zone");
    assert.ok(audit.mass.zoneTokens > 1000, "zone mass is non-trivial for 8K-payload turns (empirically ~2-4K here)");
    for (const c of audit.mass.topCarriers) assert.ok(c.label.length > 0 && c.tokens > 0);
    assert.ok(audit.mass.topCarriers.some((c) => c.label.startsWith("user ") || c.label.startsWith("tool:bash")), `carriers labeled by kind: ${JSON.stringify(audit.mass.topCarriers)}`);
});

test("#7463 P1b: hard-protected messages never leak into the uncovered runs (no ref to cite)", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 8000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    block(ctx, 20);
    const audit = auditOf(ctx);
    const num = 21; // index 20 -> m00021
    for (const r of audit.runs) {
        const a = Number(r.startRef.replace(/\D/g, ""));
        const b = Number(r.endRef.replace(/\D/g, ""));
        assert.ok(!(a <= num && num <= b), `blocked message inside run ${r.startRef}..${r.endRef}`);
    }
});

test("#7463 P2: the protected-mass ledger is OPT-IN — default acp_status stays silent, protectedMass:true names it", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 8000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    block(ctx, 20);
    const def = handleAcpStatus({}, ctx);
    assert.ok(!def.text.includes(STATUS_LINE), "default report must stay silent about protected mass (owner ruling 2026-11-21):\n" + def.text);
    const flagged = handleAcpStatus({ protectedMass: true }, ctx);
    assert.ok(flagged.text.includes(STATUS_LINE), "flagged report must carry the ledger:\n" + flagged.text);
    assert.ok(flagged.text.includes("Top carriers:"), "top carriers expected:\n" + flagged.text);
});

test("#7463 P3: a PURELY-protected gap (no uncovered runs) still renders the line", () => {
    // 12 turns at 16K payload, fold 0..10, the final 9 messages sit EXACTLY
    // inside the zone (preserveRecentMessages: 9) — the #4331 drained shape.
    // No uncovered runs remain, yet ~8K of zone mass must be named: before
    // #7463 this shape produced no section at all while the meter billed the zone.
    const ctx = withRefs(makeCtx(buildSession(12, 16000, "write"), { preserveRecentMessages: 9, preserveRecentTokens: 0 }));
    const span = turnSpan(0, 10);
    setOffer(ctx, [offerRange(span.startRef, span.endRef, 99)]);
    const out = runApply(ctx, foldArgs([span]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    const def = handleAcpStatus({}, ctx);
    assert.ok(!def.text.includes("UNCOVERED HISTORY"), "drained shape: no uncovered section:\n" + def.text);
    assert.ok(!def.text.includes(STATUS_LINE), "default acp_status stays silent:\n" + def.text);
    const flagged = handleAcpStatus({ protectedMass: true }, ctx);
    assert.ok(flagged.text.includes(STATUS_LINE), "purely-protected gap must be named behind the flag:\n" + flagged.text);
    assert.ok(/zone ~\d/.test(flagged.text), "zone share named:\n" + flagged.text);
});

test("#7463 P4: drained-fold receipt note names the protected mass (same #6522 latch)", () => {
    // 8K payload: the 5-turn hole clears the 10K receipt floor and the
    // hard-bound answer message + zone clear the 5K protected floor.
    const ctx = withRefs(makeCtx(buildSession(12, 8000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const left = turnSpan(0, 3);
    const right = turnSpan(9, 11);
    setOffer(ctx, [offerRange(left.startRef, left.endRef, 36), offerRange(right.startRef, right.endRef, 36)]);
    block(ctx, 38); // turn 4's answer message — the big one in the hole
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes(RECEIPT_LINE), "receipt must name the protected mass:\n" + out);
});

test("#7463 N1: sub-floor protected mass stays silent on every surface", () => {
    const tiny = (tokens: number): ProtectedMassLedger => ({ hardTokens: 0, hardCount: 0, zoneTokens: tokens, zoneCount: 1, topCarriers: [] });
    assert.equal(formatProtectedMass(tiny(PROTECTED_MASS_RENDER_FLOOR - 1)), null, "below floor: no status line");
    assert.equal(formatProtectedMassCompact(tiny(PROTECTED_MASS_RENDER_FLOOR - 1)), "", "below floor: no receipt fragment");
    assert.ok(formatProtectedMass(tiny(PROTECTED_MASS_RENDER_FLOOR))!.includes(STATUS_LINE), "at floor: rendered");
    // end-to-end: small tail (zone below floor) + one big folded turn renders nothing
    const msgs = buildSession(3, 4000, "write");
    msgs.splice(2 * MSGS_PER_TURN, MSGS_PER_TURN, ...turnMsgs(2, 0, "write"));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 3, preserveRecentTokens: 0 }));
    const span = turnSpan(0, 0);
    setOffer(ctx, [offerRange(span.startRef, span.endRef, 9)]);
    const out = runApply(ctx, foldArgs([span]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    const status = handleAcpStatus({}, ctx);
    assert.ok(!status.text.includes(STATUS_LINE), "sub-floor session: no line:\n" + status.text);
});

test("#7463 N2: uncoveredHistoryRuns keeps its shape (delegation is transparent)", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    block(ctx, 20);
    const legacy = uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });
    const audit = auditOf(ctx);
    assert.deepEqual(legacy, audit.runs, "legacy export must equal the audit's runs exactly");
});

function makeNudge(): NudgeDecision {
    const bd = { system: 0, tool: 1000, summaries: 500, code: 300, text: 200 };
    return {
        shouldInject: false,
        reason: "test",
        compressibleRanges: [],
        contextUsage: 0.1,
        tier: null,
        breakdown: { usage: 0.1, growth: 0, growthReference: 0, effectiveThreshold: 0, nudgeGrowthTokens: 0, growthFloor: 0, hasPendingNudge: 0, overLimit: 0, emergencyOverride: 0, pendingT1: 0, pendingT2: 0, pendingT3: 0, maxPending: 0 },
        contextBreakdown: { ...bd, total: 2000, growth: 0 },
    };
}

test("#7463: buildContextView carries the protected-mass ledger when provided (web/dsh Context tab attribution)", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 8000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    block(ctx, 20);
    const bare = buildContextView({ nudge: makeNudge(), systemPromptTokens: 0, limit: 100000, session: ctx.session });
    assert.ok(bare !== null, "view builds without the ledger");
    assert.equal("protectedMass" in bare, false, "absent by default (no audit input)");
    const mass: ProtectedMassLedger = { hardTokens: 9000, hardCount: 2, zoneTokens: 8000, zoneCount: 9, topCarriers: [{ tokens: 6000, label: "user hi" }] };
    const withMass = buildContextView({ nudge: makeNudge(), systemPromptTokens: 0, limit: 100000, session: ctx.session, protectedMass: mass });
    assert.ok(withMass !== null);
    assert.deepEqual(withMass.protectedMass, mass, "field passes through untouched");
});
