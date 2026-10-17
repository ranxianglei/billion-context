import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { postRebuildAnchorTokens } from "../src/session.ts";
import { effectiveTokenCount } from "../src/server.ts";
import { estimateCoreMessagesUpper } from "../src/preflight.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import type { Session } from "../src/session.ts";

// #3573: a fold that out-sizes the session meter (stale baseline after an
// upgrade cutover, a never-reporting upstream, or the first fold of a
// raw-replayed giant history) drives the #695 credit net below zero and clamps
// the baseline to 0. With the baseline annihilated, the next prepare falls
// through the effectiveTokenCount ladder to the resent-history char-count
// bound — 2-4x the real token mass — so a session that JUST folded 1.9M tokens
// meters usage=289% (field: 564%) and fires a phantom EMERGENCY nudge / a
// preflight marathon into an already-folded context. Fix: plain folds now
// stamp the #1820 post-rebuild anchor with the fold's post-fold view size
// (same kernel-count space the [acp-compress-obs] shrink line reports), so
// the meter rides the anchor until a real usage report supersedes it.

const WINDOW = 200_000;

function makeSession(): Session {
    return {
        id: "issue3573-fold-anchor",
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
    };
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

// ~430K chars across 7 messages: the two oldest (folded away) carry the bulk,
// the surviving five are modest. Char-bound raw ≈ 430K ≈ 215% of the window —
// exactly the ghost shape; the post-fold remainder is ~40K ≈ 20%.
function makeCtx(): RewriteCtx {
    const messages = [
        textMsg("raw_1", "user", "x".repeat(200_000)),
        textMsg("raw_2", "assistant", "x".repeat(200_000)),
        textMsg("raw_3", "user", "y".repeat(6_000)),
        textMsg("raw_4", "assistant", "y".repeat(6_000)),
        textMsg("raw_5", "user", "y".repeat(6_000)),
        textMsg("raw_6", "assistant", "y".repeat(6_000)),
        textMsg("raw_7", "user", "y".repeat(6_000)),
    ];
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: defaultConfig(WINDOW), messages, session, log: () => {} };
}

const COMPRESS_ARGS = { content: [{ startId: "m00001", endId: "m00002", summary: "ISSUE3573-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] };

test("#3573: a fold that out-sizes the meter anchors the next read to the post-fold view, not the char-count ghost", () => {
    const ctx = makeCtx();
    // The ghost shape: a stale estimate-grade baseline far below the fold's
    // mass, no usage-grade sample anywhere (never-reporting upstream /
    // cutover), no per-turn local estimate yet.
    ctx.session.stats.lastInputTokens = 11_579;
    ctx.session.stats.lastInputTokensSource = "estimate";

    const out = applyRanges(parseCompressInput(COMPRESS_ARGS), ctx);
    const text = typeof out === "string" ? out : out.text;
    assert.ok(text.startsWith("[Compressed"), `fold succeeded (got: ${text})`);

    // The #695 credit net clamps the annihilated baseline to 0 — the mechanism
    // that pre-fix dropped the ladder through to the raw char bound.
    assert.equal(ctx.session.stats.lastInputTokens, 0, "stale baseline netted to 0 by the fold credit");

    const anchor = postRebuildAnchorTokens(ctx.session);
    assert.ok(anchor > 0, "the fold stamped the post-rebuild anchor");
    const raw = estimateCoreMessagesUpper(ctx.messages);
    assert.ok(anchor * 4 < raw, `anchor is the post-fold remainder in kernel-count space (anchor=${anchor}, raw=${raw})`);

    // The very next prepare (full raw RESENT history, usage report not landed
    // yet) must meter against the anchor — pre-fix this read returned `raw`
    // (≈215% of the window) and lit the EMERGENCY branch into the folded context.
    const meter = effectiveTokenCount(ctx.session, ctx.messages);
    assert.equal(meter.tokens, anchor, "meter rides the post-fold anchor");
    assert.equal(meter.source, "estimate", "anchor reads as estimate-grade");
    assert.ok(meter.tokens < WINDOW, `folded context meters inside the window (got ${meter.tokens}/${WINDOW}, pre-fix ghost was ${raw})`);
});

test("#3573: a STALE per-turn local estimate (the field's 564% shape) is outranked by the anchor", () => {
    const ctx = makeCtx();
    ctx.session.stats.lastInputTokens = 11_579;
    ctx.session.stats.lastInputTokensSource = "estimate";
    // The field signature: localInputEstimate lags one turn (#1820 lag note), so
    // at decision time it still holds the PREVIOUS turn's raw-resent char mass —
    // ~430K here, ≈215% of the window. Pre-fix the ladder's min(est, raw) branch
    // returned exactly this ghost and lit EMERGENCY on the freshly-folded session.
    ctx.session.stats.localInputEstimate = 430_000;

    const out = applyRanges(parseCompressInput(COMPRESS_ARGS), ctx);
    const text = typeof out === "string" ? out : out.text;
    assert.ok(text.startsWith("[Compressed"), `fold succeeded (got: ${text})`);

    const anchor = postRebuildAnchorTokens(ctx.session);
    assert.ok(anchor > 0, "the fold stamped the post-rebuild anchor");
    const meter = effectiveTokenCount(ctx.session, ctx.messages);
    assert.equal(meter.tokens, anchor, "anchor branch outranks the stale min(est, raw) ghost branch");
    assert.ok(meter.tokens < WINDOW, `folded context meters inside the window (got ${meter.tokens}/${WINDOW}, pre-fix ghost was 430000)`);
});

test("#3573: a degenerate full-coverage fold still stamps an anchor (postCtx=0 edge)", () => {
    const ctx = makeCtx();
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    ctx.config.compress.minSummaryLength = 0;
    ctx.session.stats.lastInputTokens = 11_579;
    ctx.session.stats.lastInputTokensSource = "estimate";

    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "ISSUE3573-DEGENERATE-FULL-COVERAGE-SUMMARY-LONG-ENOUGH-FOR-MIN-LENGTH" }] }), ctx);
    const text = typeof out === "string" ? out : out.text;
    assert.ok(text.startsWith("[Compressed"), `degenerate fold succeeded (got: ${text})`);

    // tokensCompressed covers the whole view -> postCtx === 0 -> the setter's
    // <=0 no-op would leave NO anchor and one ghost decision would survive.
    assert.ok(postRebuildAnchorTokens(ctx.session) > 0, "anchor stamped even when the fold leaves nothing behind");
});

test("#3573: a usage-grade baseline still outranks the post-fold anchor (no behavior change for healthy sessions)", () => {
    const ctx = makeCtx();
    ctx.session.stats.lastInputTokens = 300_000;
    ctx.session.stats.lastInputTokensSource = "usage";

    const out = applyRanges(parseCompressInput(COMPRESS_ARGS), ctx);
    const text = typeof out === "string" ? out : out.text;
    assert.ok(text.startsWith("[Compressed"), `fold succeeded (got: ${text})`);
    // The credit nets the usage-grade baseline down; the anchor is stamped too,
    // but branch #1 of the ladder wins — same precedence as #1820.
    assert.ok(ctx.session.stats.lastInputTokens > 0, "usage-grade baseline survived the netting (300k exceeds the folded mass)");
    const meter = effectiveTokenCount(ctx.session, ctx.messages);
    assert.equal(meter.tokens, ctx.session.stats.lastInputTokens, "usage-grade fast path wins over the anchor");
    assert.equal(meter.source, "usage", "usage-grade source preserved");
});
