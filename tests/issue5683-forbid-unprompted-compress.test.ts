// #5683: forbid unprompted / out-of-bounds model-initiated compression.
// Two opt-in knobs (compress.requireNudge / compress.requireRecommendation)
// enforced in applyRanges — the single execution point for every model-initiated
// compress across lanes. Gate discipline (#3617): BOTH directions asserted per
// gate — fires when it should, stays silent when it should not.
// #5943: requireNudge judges a NUDGE CREDIT (a K-round window minted by each
// actually-injected nudge, decayed per un-nudged model round), not this-round
// arm — the multi-round cleanup continuation cases below pin both directions of
// the window transition.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage, CompressibleRange, NudgeDecision } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { parseCompressSettings } from "../src/config.ts";
import { mergeCompress } from "../src/compress-settings.js";
import { liveCompressionRanges } from "../src/acp-status.js";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { NUDGE_CREDIT_ROUNDS, storeUnpromptedGate } from "../src/unprompted-gate.ts";

const SUM = "SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK-XYZ";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "issue5683-test",
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

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

/** Nine 5000-char messages; preserveRecentMessages 2 keeps m8-m9 protected,
 *  so m1-m7 are the live fold space. */
function freshCtx(): Ctx {
    const msgs = Array.from({ length: 9 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    return withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
}

function offerRange(startRef: string, endRef: string, count: number, tokens = 8000): CompressibleRange {
    return { startRef, endRef, count, tokens, chars: tokens * 4, toolPct: 0, textPct: 100 };
}

function setOffer(ctx: Ctx, ranges: CompressibleRange[]): void {
    ctx.lastNudge = { compressibleRanges: ranges, tier: null } as unknown as NudgeDecision;
}

function runApply(ctx: Ctx, args: unknown, opts?: { loopTracking?: boolean }): string {
    return applyRanges(parseCompressInput(args), ctx, opts).text;
}

// ---------------------------------------------------------------------------
// Config plumbing: parse + three-level merge.
// ---------------------------------------------------------------------------

test("#5683: parseCompressSettings accepts the two boolean gates", () => {
    const parsed = parseCompressSettings({ requireNudge: true, requireRecommendation: false });
    assert.ok(parsed);
    assert.equal(parsed.requireNudge, true);
    assert.equal(parsed.requireRecommendation, false);
});

test("#5683: parseCompressSettings rejects non-boolean gate values (whole block)", () => {
    assert.equal(parseCompressSettings({ requireNudge: "yes" }), undefined);
    assert.equal(parseCompressSettings({ requireRecommendation: 1 }), undefined);
});

test("#5683: mergeCompress — deepest defined level wins per field (explicit false disables)", () => {
    assert.equal(mergeCompress({ requireNudge: true }).requireNudge, true);
    assert.equal(mergeCompress({ requireNudge: true }, { requireNudge: false }).requireNudge, false);
    assert.equal(mergeCompress({ requireNudge: false }, undefined, { requireNudge: true }).requireNudge, true);
    assert.equal(mergeCompress({ requireRecommendation: true }, { requireRecommendation: true }, {}).requireRecommendation, true);
    assert.equal(mergeCompress().requireNudge, undefined);
});

// ---------------------------------------------------------------------------
// requireNudge — timing gate (nudge actually delivered this turn?).
// ---------------------------------------------------------------------------

test("#5683: default (nothing stamped) — unprompted compress SUCCEEDS (behavior unchanged)", () => {
    const ctx = freshCtx();
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 160)}`);
});

test("#5683: requireNudge ON + unarmed round — refused with policy receipt, nothing folded", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: true, requireRecommendation: false });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compression REFUSED"), `expected refusal, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("requireNudge"), "receipt names the knob:\n" + out);
    assert.equal(ctx.session.state.blocks.length, 0, "no block may be created");
    assert.ok(ctx.logs.some((l) => l.includes("refused unprompted compress")), "refusal logged");
});

test("#5683: requireNudge ON + armed round (nudge injected) — allowed", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: true, requireRecommendation: false });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 160)}`);
});

test("#5683: requireNudge ON + unarmed + preflight lane (loopTracking:false) — exempt, succeeds", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: true, requireRecommendation: false });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] }, { loopTracking: false });
    assert.ok(out.startsWith("[Compressed"), `preflight self-save must stay available, got: ${out.slice(0, 160)}`);
});

test("#5683: both gates ON + unarmed — the timing refusal wins (checked first)", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: true, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.includes("requireNudge"), `timing gate reports first, got: ${out.slice(0, 160)}`);
    assert.ok(!out.includes("requireRecommendation"), "scope gate must not double-report");
});

// ---------------------------------------------------------------------------
// requireRecommendation — scope gate (stay within the recommended set).
// ---------------------------------------------------------------------------

test("#5683: requireRecommendation ON + range inside the prepare-time offer — allowed", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 160)}`);
});

test("#5683: requireRecommendation ON + SUBDIVIDING a recommended span — allowed (coverage, not equality)", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00002", endId: "m00003", summary: SUM }] });
    assert.ok(out.startsWith("[Compressed"), `subdivided span must pass, got: ${out.slice(0, 160)}`);
});

test("#5683: requireRecommendation ON + live range OUTSIDE the offer — refused naming the span, nothing folded", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    // m5-m7 are live-compressible per the kernel but were NOT offered this round.
    const out = runApply(ctx, { content: [{ startId: "m00005", endId: "m00007", summary: SUM }] });
    assert.ok(out.startsWith("[Compression REFUSED"), `expected refusal, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("requireRecommendation"), "receipt names the knob:\n" + out);
    assert.ok(out.includes("m00005–m00007"), "offending span named:\n" + out);
    assert.equal(ctx.session.state.blocks.length, 0, "no block may be created");
});

test("#5683: requireRecommendation ON + mixed range (part offered, part not) — refused as a whole", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00003", endId: "m00006", summary: SUM }] });
    assert.ok(out.startsWith("[Compression REFUSED"), `mixed span must be refused whole, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("m00003–m00006"));
    assert.equal(ctx.session.state.blocks.length, 0, "atomic: nothing folded");
});

test("#5683: requireRecommendation ON + offered span BELOW the minCompressRange floor — out of bounds", () => {
    // The advertised surfaces (nudge submitGate, acp_status) drop sub-floor
    // ranges, so the gate must agree: raising the floor above the offered
    // span's char count (4 × 8000 tokens × 4 = 32000) removes it from the
    // recommendation set even though it sits in lastNudge verbatim.
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    ctx.config.compress.minCompressRange = 40000;
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compression REFUSED"), `sub-floor span must be out of bounds, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("out-of-bounds compression is disabled"), "must be OUR receipt, not a kernel one:\n" + out);
    assert.equal(ctx.session.state.blocks.length, 0, "nothing folded");
});

test("#5683: requireRecommendation ON + pure refold of an active block — NOT refused by the scope gate", () => {
    // Fold m1-m4 first (gates off), then re-point the offer away and re-submit
    // the SAME span: the covered messages never sit in fresh recommendation
    // lists, so the carve-out must let the call through to the kernel's own
    // refold handling (whatever verdict THAT gives, it is not our receipt).
    const ctx = freshCtx();
    const first = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(first.startsWith("[Compressed"), `setup fold failed: ${first.slice(0, 160)}`);
    assert.ok(ctx.session.state.blocks.length > 0, "block exists after setup fold");
    setOffer(ctx, [offerRange("m00005", "m00007", 3)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM + "-REFOLD-UPDATE" }] });
    assert.ok(!out.includes("out-of-bounds compression is disabled"), "scope gate must not fire on a refold:\n" + out);
    assert.ok(!ctx.logs.some((l) => l.includes("refused out-of-recommendation")), "no scope-gate refusal logged");
});

test("#5683: requireRecommendation ON + no offer and EMPTY live plan (every candidate dead) — strict: refused", () => {
    // Without a prepare snapshot the scope falls back to the live recompute;
    // killing every candidate makes that set empty ⇒ nothing is recommended
    // ⇒ every span is out of bounds. (The non-empty fallback case is pinned by
    // the plugin-lane positive test below.)
    const ctx = freshCtx();
    ctx.session.state.deadRefs = ["m00001", "m00002", "m00003", "m00004", "m00005", "m00006", "m00007"];
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compression REFUSED"), `nothing recommended ⇒ nothing foldable, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("requireRecommendation"));
    assert.equal(ctx.session.state.blocks.length, 0, "nothing folded");
});

// ---------------------------------------------------------------------------
// Plugin-lane shape: ctx carries NO prepare snapshot (lastNudge undefined) —
// the recommendation set falls back to the LIVE recompute (same source acp_status shows).
// ---------------------------------------------------------------------------

test("#5683: plugin-lane ctx (no lastNudge) — a live-recommended span passes the scope gate", () => {
    const ctx = freshCtx();
    const live = liveCompressionRanges(ctx);
    assert.ok(live && live.ranges.length > 0, "fixture must yield a live recommendation set");
    const r = live.ranges[0];
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: r.startRef, endId: r.endRef, summary: SUM }] });
    assert.ok(!out.includes("out-of-bounds compression is disabled"), "live-recommended span must pass:\n" + out);
});

test("#5683: plugin-lane ctx (no lastNudge) — a span containing a DEAD ref is out of bounds", () => {
    const ctx = freshCtx();
    // Client dropped m00006: every advertised span containing it is excluded,
    // so submitting across it is definitively out-of-bounds (our receipt wins
    // over any kernel-side rejection because the gate runs before apply).
    ctx.session.state.deadRefs = ["m00006"];
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00005", endId: "m00007", summary: SUM }] });
    assert.ok(out.startsWith("[Compression REFUSED"), `expected refusal, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("out-of-bounds compression is disabled"), "must be OUR receipt, not a kernel one:\n" + out);
    assert.equal(ctx.session.state.blocks.length, 0, "nothing folded");
});

// ---------------------------------------------------------------------------
// #5943 — nudge CREDIT window (requireNudge judges K model rounds, not this round).
// ---------------------------------------------------------------------------

/** Stamp `n` consecutive un-nudged MODEL rounds on top of whatever credit exists. */
function decayRounds(ctx: Ctx, n: number): void {
    for (let i = 0; i < n; i++) {
        storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: true, requireRecommendation: false });
    }
}

test("#5943: delayed fulfillment — nudge injected N rounds ago, fold NOW succeeds (the reported defect)", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: true, requireRecommendation: false });
    decayRounds(ctx, 3); // three un-nudged model rounds pass; credit 20 → 17
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compressed"), `delayed fulfillment inside the window must succeed, got: ${out.slice(0, 160)}`);
});

test("#5943: window expiry — both directions around the K-th un-nudged round", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: true, requireRecommendation: false });
    decayRounds(ctx, NUDGE_CREDIT_ROUNDS - 1); // credit 20 → 1: still live
    const alive = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(alive.startsWith("[Compressed"), `last live round of the window must succeed, got: ${alive.slice(0, 160)}`);

    const ctx2 = freshCtx();
    storeUnpromptedGate(ctx2.session, { nudgeInjected: true, requireNudge: true, requireRecommendation: false });
    decayRounds(ctx2, NUDGE_CREDIT_ROUNDS); // credit → 0: expired
    const out = runApply(ctx2, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compression REFUSED"), `expired window must refuse, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("requireNudge"), "receipt names the knob:\n" + out);
    assert.ok(out.includes(`within ${NUDGE_CREDIT_ROUNDS} model rounds`), "receipt names the window length:\n" + out);
    assert.equal(ctx2.session.state.blocks.length, 0, "nothing folded");
});

test("#5943: refresh mid-decay — a new injection re-mints the full window", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: true, requireRecommendation: false });
    decayRounds(ctx, NUDGE_CREDIT_ROUNDS - 1); // down to credit 1
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: true, requireRecommendation: false }); // refresh → 20
    decayRounds(ctx, NUDGE_CREDIT_ROUNDS - 1); // back down to credit 1
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compressed"), `refreshed window must still cover the fold, got: ${out.slice(0, 160)}`);
});

test("#5943: successful folds do NOT consume the credit — multi-round cleanup continues (#5943 item 3 deviation)", () => {
    // The issue's consumption variant would have refused this exact sequence:
    // the 18:41 fold would have eaten the credit and every continuation round
    // (the reported 18:42–18:46 four-in-a-row refusals) stayed refused. Window-
    // only semantics keep the cleanup going until the window lapses.
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: true, requireRecommendation: false });
    const first = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(first.startsWith("[Compressed"), `first fold failed: ${first.slice(0, 160)}`);
    decayRounds(ctx, 2); // two more rounds pass; no consumption happened
    const second = runApply(ctx, { content: [{ startId: "m00005", endId: "m00007", summary: SUM + "-CONT" }] });
    assert.ok(second.startsWith("[Compressed"), `continuation fold under the same credit must succeed, got: ${second.slice(0, 160)}`);
});

test("#5943: non-model stamps hold the window open (neither refresh nor decay)", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: true, requireRecommendation: false });
    for (let i = 0; i < NUDGE_CREDIT_ROUNDS; i++) {
        storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: true, requireRecommendation: false, modelRound: false });
    }
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compressed"), `countTokens-style shapes must not burn the window, got: ${out.slice(0, 160)}`);
});
