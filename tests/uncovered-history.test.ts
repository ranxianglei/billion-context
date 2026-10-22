import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionBlock, CompressionState, CoreMessage, NudgeDecision } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { coveredRefNumbers, formatUncoveredHistory, uncoveredHistory } from "../src/uncovered-history.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { handleAcpStatus } from "../src/acp-status.ts";

const NO_RANGES_REMAIN_TEXT = "No compressible ranges remain — the context is already at its minimum; continue the task without compressing.";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "uncovered-history-test",
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

function block(id: string, effective: string[], kids: string[] = [], opts: { tier?: 1 | 2 | 3; active?: boolean } = {}): CompressionBlock {
    return {
        blockId: id,
        runId: "r1",
        tier: opts.tier ?? 1,
        summary: "s",
        directMessageIds: effective,
        effectiveMessageIds: effective,
        directBlockIds: kids,
        compressedTokens: 0,
        createdAt: 0,
        survivedCount: 0,
        generation: "young",
        active: opts.active ?? true,
    };
}

function stateWithRefs(count: number): { state: CompressionState; messages: CoreMessage[] } {
    const messages = Array.from({ length: count }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(200)));
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    const state = createInitialState();
    state.messageRefs = res.map;
    return { state, messages };
}

test("#4331: coveredRefNumbers recurses into directBlockIds (tier-2 parents)", () => {
    const { state } = stateWithRefs(3);
    state.blocks = [
        block("b1", ["raw_1"]),
        block("b2", [], ["b1"], { tier: 2 }),
        block("b3", ["raw_3"], [], { active: false }),
    ];
    const covered = coveredRefNumbers(state);
    assert.ok(covered.has(1), "child coverage must survive an empty effectiveMessageIds parent");
    assert.ok(!covered.has(3), "inactive block coverage must not count");
});

test("#4331: uncoveredHistory finds the gap between folds and respects the protected tail", () => {
    const { state, messages } = stateWithRefs(8);
    state.blocks = [block("b1", ["raw_1", "raw_2", "raw_3"], [], { tier: 1 })];
    const report = uncoveredHistory(state, messages, { preserveRecentMessages: 2 });
    assert.equal(report.runCount, 1);
    assert.equal(report.messageCount, 3, "m00004–m00006 are the only older uncovered refs");
    assert.deepEqual(report.runs[0], { startRef: "m00004", endRef: "m00006", count: 3, tokens: report.runs[0]!.tokens });
});

test("#4331: split cores sharing one ref stay in a single run", () => {
    const { state, messages } = stateWithRefs(2);
    state.messageRefs = { byRaw: { raw_1: "m00010", raw_2: "m00010" }, nextIndex: 11 } as never;
    state.blocks = [];
    const report = uncoveredHistory(state, messages, { preserveRecentMessages: 0 });
    assert.equal(report.runCount, 1);
    assert.deepEqual([report.runs[0]!.startRef, report.runs[0]!.endRef], ["m00010", "m00010"]);
    assert.equal(report.runs[0]!.count, 2);
});

test("#4331: dead refs and minTokens/maxRuns filters", () => {
    const { state, messages } = stateWithRefs(6);
    state.blocks = [];
    state.deadRefs = ["m00002"];
    const all = uncoveredHistory(state, messages, { preserveRecentMessages: 0 });
    assert.equal(all.messageCount, 5, "the dead ref is not coverage the agent can reclaim");
    assert.equal(all.runCount, 2, "m00001 and m00003–m00006");
    const filtered = uncoveredHistory(state, messages, { preserveRecentMessages: 0, minTokens: 1000 });
    assert.equal(filtered.runCount, 0, "tiny runs are filtered by token floor");
});

test("#4331: acp_status reports the coverage gap the fold scanner cannot see", () => {
    const msgs = Array.from({ length: 12 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const ctx = withRefs(makeCtx(msgs));
    ctx.session.state.blocks = [
        {
            ...block("b1", ["raw_1", "raw_2"], [], { tier: 1 }),
            runId: "r1",
            summary: "folded",
        } as CompressionBlock,
    ];
    const out = handleAcpStatus({}, ctx as unknown as RewriteCtx).text;
    assert.match(out, /UNCOVERED HISTORY — \d+ message\(s\) in \d+ run\(s\)/);
    assert.ok(out.includes("m00003"), "the first ref after the fold must be named:\n" + out);
    assert.ok(out.includes("does NOT include these refs"), "the audit must say the ranges table is scoped:\n" + out);
});

test("#4331: the stop signal carries a material-gap note, and stays quiet for sub-threshold residue", () => {
    // Material gap: 20 large messages, only the head folded, tail protected.
    const big = Array.from({ length: 20 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const ctx = withRefs(makeCtx(big, { preserveRecentMessages: 3, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 80000;
    const out = applyRanges(parseCompressInput({
        content: [{ startId: "m00001", endId: "m00002", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }],
    }), ctx).text;
    assert.ok(out.includes(NO_RANGES_REMAIN_TEXT), "kernel stop verdict must stay verbatim:\n" + out);
    assert.ok(out.includes("UNCOVERED HISTORY"), "a material blind spot must be named:\n" + out);
    assert.ok(out.includes("m00003"), "the gap must carry actionable refs:\n" + out);

    // Sub-threshold residue (the #1387 fixture): the receipt must not re-nag.
    const small = Array.from({ length: 7 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    const ctx2 = withRefs(makeCtx(small));
    ctx2.session.stats.lastInputTokens = 80000;
    const out2 = applyRanges(parseCompressInput({
        content: [{ startId: "m00001", endId: "m00002", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }],
    }), ctx2).text;
    assert.ok(out2.includes(NO_RANGES_REMAIN_TEXT));
    assert.ok(!out2.includes("UNCOVERED HISTORY"), "declined leftovers must not be advertised:\n" + out2);
});
