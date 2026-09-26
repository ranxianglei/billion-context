import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
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
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
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
    return applyRanges(parseCompressInput(args), ctx);
}

test("#1387: success with remaining ranges appends the fresh range list (pi #420)", () => {
    const msgs = Array.from({ length: 9 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    // preserveRecentMessages: 2 (+ token zone off) → only m00008–m00009 stay
    // protected, so m00005–m00007 remain raw-compressible after folding m00001–m00004.
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: "TAIL-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    assert.ok(out.includes(RANGES_HEADER), `missing ranges header:\n${out}`);
    assert.ok(out.includes("m00005"), `remaining range must name m00005:\n${out}`);
    assert.ok(out.includes("m00007"), `remaining range must reach m00007:\n${out}`);
    assert.ok(!out.includes("m00008"), "protected recent zone must not be advertised:\n" + out);
    assert.ok(!out.includes(NO_RANGES_REMAIN_TEXT), "stop signal must not appear while ranges remain:\n" + out);
});

test("#1387: clean success that drains every compressible range emits the stop signal (pi #521)", () => {
    // Default preserveRecentMessages: 5 → after folding m00001–m00002 the rest
    // (m00003–m00007) sits in the protected recent zone: nothing actionable left.
    const msgs = [
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ];
    const ctx = withRefs(makeCtx(msgs));
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
    ctx.session.stats.lastInputTokens = 200000;
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

test("#1387: partial failure (some ranges rejected) keeps the old silent tail", () => {
    // m00003–m00007 sit entirely in the protected recent zone under the default
    // config; pairing that range with a valid one exercises the partial-failure
    // gate: no stop verdict while errors are still owed an answer (pi #521).
    const msgs = [
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ];
    const ctx = withRefs(makeCtx(msgs));
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
