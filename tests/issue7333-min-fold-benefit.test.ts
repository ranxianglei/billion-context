// #7333: minimum-benefit floor on the model-initiated compress commit gate.
// A committed fold rewrites the context prefix and re-bills the prompt-cache
// tail, so a burst of tiny model-initiated folds (one nudge → many small
// folds) re-bills the tail repeatedly for almost no reclaim. Below the
// pressure band, a fold that would reclaim fewer than
// compress.minFoldBenefitTokens (default 4096 — the same bar bili's own
// auto-fold applies, #3444) is refused with a teaching receipt instead of
// committed. At/above the pressure band or in emergency the floor drops to 1
// (survival folds are never blocked); 0 restores the legacy any-positive-
// shrink gate; bili's own preflight folds (loopTracking:false) are never
// gated by the benefit floor (only the original no-net-shrink gate applies).
//
// Gate negative assertions per #3617: each gate row asserts BOTH directions —
// "refuses when it should" AND "commits when it should not".
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage, NudgeDecision } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ResolvedKernelConfig } from "../src/compress-settings.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue7333-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

type Ctx = RewriteCtx & { session: Session; config: Config };

/** Build a ctx whose ONLY message is `origChars` chars (non-CJK → ceil/4
 *  tokens) and return it plus a summary of `sumChars` chars. The recent-
 *  message zone is disabled (preserveRecentMessages/Tokens = 0 — the kernel's
 *  documented opt-out for tests that compress the tail) so the single message
 *  is foldable rather than a protected no-op. The test mutates ctx.lastNudge /
 *  ctx.config before calling applyRanges. netDelta for the resulting fresh
 *  single-message fold = ceil(origChars/4) - ceil(sumChars/4). */
function makeFoldCtx(origChars: number, sumChars: number, config?: Config): { ctx: Ctx; summary: string } {
    const msg = textMsg("raw_1", "assistant", "a".repeat(origChars));
    const session = makeSession();
    const res = assignRefs([msg], { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    const cfg = { ...(config ?? defaultConfig(200000)), preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const ctx: Ctx = {
        core: createCore(),
        config: cfg,
        messages: [msg],
        session,
        log: () => {},
    };
    return { ctx, summary: "s".repeat(sumChars) };
}

/** Build a minimal NudgeDecision carrying only the breakdown flags the host
 *  gate reads (overLimit / emergencyOverride). compressibleRanges is empty so
 *  the post-fold range-advertisement path (viableRanges) stays inert. */
function makeNudge(breakdown: { overLimit?: number; emergencyOverride?: number }): NudgeDecision {
    return {
        shouldInject: false,
        reason: "test",
        compressibleRanges: [],
        contextUsage: 0,
        tier: 1,
        breakdown: { usage: 0, growth: 0, effectiveThreshold: 0, overLimit: 0, emergencyOverride: 0, ...breakdown },
    } as unknown as NudgeDecision;
}

function runCompress(ctx: Ctx, summary: string, opts?: { loopTracking?: boolean }) {
    return applyRanges(
        parseCompressInput({ content: [{ startId: "m00001", endId: "m00001", summary }] }),
        ctx,
        opts,
    );
}

// --- the gate refuses when it should ---------------------------------------

test("#7333: a sub-floor fold (reclaims 500 tok < 4096) is refused below the pressure band", () => {
    // 20000-char range (5000 tok) → 18000-char summary (4500 tok): netDelta 500.
    const { ctx, summary } = makeFoldCtx(20000, 18000);
    const r = runCompress(ctx, summary);
    assert.equal(r.reason, "gate:below-min-benefit", `reason, got: ${r.reason}`);
    assert.ok(r.text.startsWith("[Compression refused: below minimum benefit"), `receipt, got: ${r.text.slice(0, 80)}`);
    assert.ok(r.text.includes("compress.minFoldBenefitTokens (4096)"), "receipt names the floor");
    assert.ok(r.text.includes("reclaim only 500 token(s)"), "receipt states the actual reclaim");
    assert.ok(r.text.includes("Nothing was folded and the cache is untouched"), "receipt states the cache is untouched");
    assert.equal(ctx.session.state.blocks.length, 0, "nothing committed");
});

test("#7333: a no-net-shrink fold (netDelta 0) is refused with the byte-identical pre-#7333 receipt", () => {
    // 16000-char range (4000 tok) → 16000-char summary (4000 tok): netDelta 0.
    const { ctx, summary } = makeFoldCtx(16000, 16000);
    const r = runCompress(ctx, summary);
    assert.equal(r.reason, "gate:no-net-shrink", `reason, got: ${r.reason}`);
    assert.equal(
        r.text,
        "[Compression refused: no net shrink — the summary you supplied is not smaller than the range it replaces (committing it leaves the context size unchanged). Nothing was folded: no block was created and the context prefix/cache were left untouched. Do not re-issue this same range and summary; supply a much shorter summary for the range, target a larger span so the summary shrinks it, or continue your task without compressing.]",
        "no-net-shrink receipt byte-identical to the pre-#7333 text",
    );
    assert.equal(ctx.session.state.blocks.length, 0, "nothing committed");
});

// --- the gate does NOT refuse when it should not ---------------------------

test("#7333: a fold above the floor (reclaims 8000 tok ≥ 4096) commits", () => {
    // 40000-char range (10000 tok) → 8000-char summary (2000 tok): netDelta 8000.
    const { ctx, summary } = makeFoldCtx(40000, 8000);
    const r = runCompress(ctx, summary);
    assert.ok(r.text.startsWith("[Compressed "), `committed, got: ${r.text.slice(0, 80)}`);
    assert.equal(ctx.session.state.blocks.length, 1, "one block created");
});

test("#7333: in the pressure band the floor drops to 1 — a sub-floor fold commits", () => {
    const { ctx, summary } = makeFoldCtx(20000, 18000);
    ctx.lastNudge = makeNudge({ overLimit: 1 });
    const r = runCompress(ctx, summary);
    assert.ok(r.text.startsWith("[Compressed "), `committed in-band, got: ${r.text.slice(0, 80)}`);
    assert.equal(ctx.session.state.blocks.length, 1, "one block created");
});

test("#7333: in emergency the floor drops to 1 — a sub-floor fold commits", () => {
    const { ctx, summary } = makeFoldCtx(20000, 18000);
    ctx.lastNudge = makeNudge({ emergencyOverride: 1 });
    const r = runCompress(ctx, summary);
    assert.ok(r.text.startsWith("[Compressed "), `committed in emergency, got: ${r.text.slice(0, 80)}`);
    assert.equal(ctx.session.state.blocks.length, 1, "one block created");
});

test("#7333: minFoldBenefitTokens=0 restores the legacy any-positive-shrink gate", () => {
    const config = { ...defaultConfig(200000), minFoldBenefitTokens: 0 } as ResolvedKernelConfig;
    const { ctx, summary } = makeFoldCtx(20000, 18000, config);
    const r = runCompress(ctx, summary);
    assert.ok(r.text.startsWith("[Compressed "), `legacy fold commits, got: ${r.text.slice(0, 80)}`);
    assert.equal(ctx.session.state.blocks.length, 1, "one block created");
});

test("#7333: bili's own preflight folds (loopTracking:false) are never gated by the benefit floor", () => {
    // Same sub-floor shape as the first test (netDelta 500), but the preflight
    // lane — bili's internal overflow backstop — commits it: only the
    // no-net-shrink gate applies to loopTracking:false.
    const { ctx, summary } = makeFoldCtx(20000, 18000);
    const r = runCompress(ctx, summary, { loopTracking: false });
    assert.ok(r.text.startsWith("[Compressed "), `preflight fold commits, got: ${r.text.slice(0, 80)}`);
    assert.equal(ctx.session.state.blocks.length, 1, "one block created");
});
