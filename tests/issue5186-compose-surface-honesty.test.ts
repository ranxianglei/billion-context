import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressibleRange, CoreMessage, NudgeDecision } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { describeUncoveredRuns } from "../src/uncovered.ts";

// #5186: compose-surface honesty. Two host-side fixes for the "model composes a
// bad batch" family: (1) UNCOVERED HISTORY rows carry live-looking ref spans
// that models copied into compress ranges despite the parenthetical "not as
// fold suggestions" — every row now carries an explicit [not foldable] tag
// (both surfaces share describeUncoveredRuns); (2) the success receipt teaches
// the source-of-truth split — refs quoted in stored summaries are historical
// snapshots that die on generation change, ranges come from acp_status or the
// receipt's own live list. Coverage: proxy lane only (plugin-mode hosts render
// their own receipts).
const SUMMARY = "SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-SUMMARY-MINIMUM-LENGTH-CHECK-OK";
const MSGS_PER_TURN = 9;
const STATUS_SECTION = "UNCOVERED HISTORY";
const HISTORICAL_NOTE_MARKER = "Refs quoted in stored summaries are historical snapshots";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "issue5186-test",
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

test("#5186 P1: describeUncoveredRuns tags every listed run [not foldable]", () => {
    const s = describeUncoveredRuns([
        { startRef: "m00010", endRef: "m00020", count: 11, tokens: 5000 },
        { startRef: "m00030", endRef: "m00040", count: 11, tokens: 6000 },
    ]);
    assert.ok(s.startsWith("[not foldable] m00010"), `first run must lead with the tag: ${s}`);
    assert.ok(s.includes(", [not foldable] m00030"), `second run must carry the tag too: ${s}`);
    const many = Array.from({ length: 7 }, (_, i) => ({ startRef: `m00${100 + i}`, endRef: `m00${110 + i}`, count: 9, tokens: 5000 }));
    const capped = describeUncoveredRuns(many);
    assert.equal((capped.match(/\[not foldable\]/g) ?? []).length, 5, "tag rides exactly the listed runs:\n" + capped);
    assert.ok(capped.includes("+2 more run(s)"), "cap counting survives the tag:\n" + capped);
});

test("#5186 P2: acp_status UNCOVERED HISTORY section renders the tag next to each ref span", () => {
    // Same hole recipe as #4331 P3: fold around a mid-history hole, raise
    // minCompressRange so the live offer comes up empty and the hole surfaces
    // in its own section.
    const ctx = withRefs(makeCtx(buildSession(40, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const left = turnSpan(1, 16);
    const right = turnSpan(28, 39);
    setOffer(ctx, [offerRange(left.startRef, left.endRef, 137), offerRange(right.startRef, right.endRef, 108)]);
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    ctx.config.compress.minCompressRange = 100000;
    const status = handleAcpStatus({}, ctx);
    assert.ok(status.text.includes(STATUS_SECTION), "UNCOVERED HISTORY section expected:\n" + status.text);
    assert.ok(status.text.includes("[not foldable] m00154"), "tag must sit next to the hole span:\n" + status.text);
    assert.ok(status.text.includes("m00252"), "hole span must still be named:\n" + status.text);
});

test("#5186 N1: offered runs stay untagged — the tag never leaks into the actionable list", () => {
    // Default gates: the hole IS offered, so it belongs to the Compressible-ranges
    // list and the section stays silent — nowhere may the bracket tag appear.
    const ctx = withRefs(makeCtx(buildSession(40, 4000, "bash"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const left = turnSpan(1, 16);
    const right = turnSpan(28, 39);
    setOffer(ctx, [offerRange(left.startRef, left.endRef, 137), offerRange(right.startRef, right.endRef, 108)]);
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    const status = handleAcpStatus({}, ctx);
    assert.ok(!status.text.includes(STATUS_SECTION), "offered runs must not duplicate into the section:\n" + status.text);
    assert.ok(!status.text.includes("[not foldable]"), "bracket tag is reserved for the uncovered section:\n" + status.text);
    assert.ok(status.text.includes("m00154"), "the hole must still be visible via the ranges list:\n" + status.text);
});

test("#5186 P3: success receipt teaches that summary-quoted refs are historical snapshots", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 4000, "write"), { preserveRecentMessages: 9, preserveRecentTokens: 0 }));
    const span = turnSpan(0, 10);
    setOffer(ctx, [offerRange(span.startRef, span.endRef, 99)]);
    const out = runApply(ctx, foldArgs([span]));
    assert.ok(out.startsWith("[Compressed"), `expected success receipt, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes(HISTORICAL_NOTE_MARKER), "historical-refs note expected on the success receipt:\n" + out);
    assert.ok(out.includes("Compose ranges only from acp_status output"), "note must point at the source of truth:\n" + out);
});

test("#5186 N2: the note is success-only — total-failure receipts stay unchanged", () => {
    const ctx = withRefs(makeCtx(buildSession(12, 4000, "write"), { preserveRecentMessages: 9, preserveRecentTokens: 0 }));
    const out = runApply(ctx, foldArgs([{ startRef: "m00500", endRef: "m00600" }]));
    assert.ok(!out.includes(HISTORICAL_NOTE_MARKER), "note must not ride failure receipts:\n" + out);
    assert.ok(!out.startsWith("[Compressed"), `expected failure receipt, got: ${out.slice(0, 160)}`);
});
