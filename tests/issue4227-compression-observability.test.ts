import assert from "node:assert/strict";
import test from "node:test";
process.env.NODE_ENV = "test";
import { assignRefs, createCore, createInitialState, defaultConfig, defaultPrompts, emptyRefMap, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { getCacheLedger } from "../src/cache-ledger.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.js";

// #4227: two observability defects in the compression diagnostic surface,
// both observed live in the #4224 dsh-fork marathon (87 blocks):
//
// 1. shrink%/postCtx were THIS-FOLD meters printed as if they were SESSION
//    meters: postCtx subtracted only the current fold's saving from the raw
//    resend mass, ignoring every earlier active block. With 86+ blocks the
//    line read "shrink 0%" / "postCtx≈14.5M" / "ceiling ≥0%" for a heavily
//    compressed session. The fix keeps the this-fold ratio where gates need
//    it (degenerate-fold, staged-compress note, lastCompress) and adds the
//    cumulative view; postCtx becomes the RENDERED post-fold context (raw
//    view minus the union of ALL active blocks' covered mass).
//
// 2. The internal-lane (preflight) receipt tail judged "anything left?" on a
//    live recompute fed by statusInputBaseline — the previous request's
//    usage-grade input tokens — while the walk itself acted on the ACTUAL
//    payload of this request. In an overflow marathon the baseline sits far
//    below the window while the payload is 19x over, so the tail printed
//    "No compressible ranges remain" in the very fold whose own walk logged
//    "102 viable range(s)". The fix pins the tail to the round's own nudge
//    offer (lastNudge) — same source/scope/moment the walk acted on, the
//    same discipline the relay lane already follows (#2404).

const NO_RANGES_REMAIN_TEXT = "No compressible ranges remain — the context is already at its minimum; continue the task without compressing.";
const RANGES_HEADER = "Current compressible ranges (use these refs exactly as listed):";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "issue4227-metric",
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

test("#4227 metric: postCtx/cumulative count EVERY active block's covered mass, not just this fold", () => {
    // raw_1/raw_2 = 20000 chars each (10000 tok together), raw_3..raw_8 =
    // 5000 chars each (7500 tok), raw_9..raw_12 = 5000 chars each (5000 tok)
    // -> 22500 tok total. An EXISTING active block already covers raw_9..raw_12;
    // the fold removes raw_1..raw_2. Rendered post-fold context is raw_3..raw_8
    // (7500 tok) — the old meter printed postCtx≈12500 (this fold only) and had
    // no cumulative figure. Twelve messages so the head fold stays outside the
    // kernel's protected-recent zone computed over the UNCOVERED tail.
    const msgs = [
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
        textMsg("raw_8", "assistant", "x".repeat(5000)),
        textMsg("raw_9", "user", "x".repeat(5000)),
        textMsg("raw_10", "assistant", "x".repeat(5000)),
        textMsg("raw_11", "user", "x".repeat(5000)),
        textMsg("raw_12", "assistant", "x".repeat(5000)),
    ];
    const ctx = withRefs(makeCtx(msgs));
    // id "b0": a valid numeric block id below any id the kernel will mint for
    // the fold under test, so the ledger's high-water bootstrap stays clear of it.
    ctx.session.state.blocks.push({
        blockId: "b0",
        runId: "r-seed",
        tier: 1,
        summary: "S".repeat(40),
        directMessageIds: ["raw_9", "raw_10", "raw_11", "raw_12"],
        effectiveMessageIds: ["raw_9", "raw_10", "raw_11", "raw_12"],
        directBlockIds: [],
        compressedTokens: 5000,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: 1,
        active: true,
    } as never);
    getCacheLedger(ctx.session); // production: ledger predates its first compress (bootstrap lastBlockId below the new block)
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] }), ctx).text;
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    assert.ok(ctx.session.state.blocks.some((b) => b.blockId === "b0" && b.active), "precondition: the pre-existing block survived the apply");
    const obs = ctx.logs.find((l) => l.includes("[acp-compress-obs]")) ?? "";
    assert.ok(obs.includes("shrink 44% this-fold (~10000/22500 tok)"), `this-fold meter missing/mislabelled:\n${obs}`);
    assert.ok(obs.includes("cumulative 67% (~15000/22500 tok)"), `cumulative meter missing (both blocks' 15000 tok covered):\n${obs}`);
    assert.ok(obs.includes("postCtx≈7500"), `postCtx must be the rendered post-fold size (raw_3..raw_8 left), not this-fold-only 12500:\n${obs}`);
    const fold = getCacheLedger(ctx.session).folds[0];
    assert.equal(fold?.V, 22500, "ledger V = full pre-fold view");
    assert.equal(fold?.Vp, 7500, "ledger Vp = rendered post-fold size (old code recorded 12500)");
});

test("#4227 metric: single-block sessions stay byte-identical to the old meter", () => {
    // No pre-existing blocks: union == this fold, so cumulative == this-fold
    // and postCtx equals the historical value (pinned elsewhere at 6250).
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
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] }), ctx).text;
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    const obs = ctx.logs.find((l) => l.includes("[acp-compress-obs]")) ?? "";
    assert.ok(obs.includes("shrink 62% this-fold (~10000/16250 tok)"), obs);
    assert.ok(obs.includes("cumulative 62% (~10000/16250 tok)"), `with one block cumulative must equal this-fold:\n${obs}`);
    assert.ok(obs.includes("postCtx≈6250"), obs);
});

function filler(chars: number, tag: string): string {
    const unit = `${tag} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega `;
    return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

test("#4227 wiring: internal-lane receipts judge on the round's own offer, not the stale usage baseline", async () => {
    // Reproduces the #4224 mixed scope: the ACTUAL payload is ~20x the window
    // (emergency digest marathon, zero model calls) while the session's
    // usage-grade baseline (stats.lastInputTokens) sits far below the window.
    // One seeded mid-history block splits the raw history into two disjoint
    // compressible runs, so every early round's offer holds MORE than the fold
    // submits. Old tail (live recompute on the low baseline): every receipt
    // claimed "No compressible ranges remain" mid-marathon. Fixed tail
    // (pinned to the round's own nudge offer): receipts advertise what the
    // walk itself still sees until the offer is genuinely consumed.
    const core = createCore();
    const limit = 2400;
    const config = defaultConfig(limit);
    const messages: CoreMessage[] = Array.from({ length: 40 }, (_, i) => ({
        id: `msg_${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        contentType: "text",
        text: filler(5000, `MSG${i}`),
    }));
    const turn0 = core.processTurn({ messages, state: createInitialState(), config: { ...config, modelContextLimit: limit * 100 }, tokenCount: limit * 100, renderTags: "text-only" });
    const foldCfg = { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const refs = turn0.state.messageRefs.byRaw;
    const c0 = core.applyCompression({ messages, state: turn0.state, config: foldCfg, ranges: [{ startRef: refs["msg_20"]!, endRef: refs["msg_29"]!, summary: filler(2000, "SEED") }] });
    assert.equal(c0.state.blocks.filter((b) => b.active).length, 1, "fixture seeds one mid-history block");
    const session: Session = {
        id: "issue4227-wiring", meta: {}, metadata: {}, state: c0.state,
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 1200, compressCreditTokens: 0, contextTokens: 1200, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [], createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false,
    };
    session.stats.lastInputTokensSource = "usage"; // usage-grade: statusInputBaseline returns it verbatim
    const logs: string[] = [];
    const deps: PreflightDeps = {
        core, session, config, prompts: defaultPrompts, protocol: "responses",
        // Port 9 refuses instantly: the emergency-digest marathon must never
        // bill a model call; any attempt surfaces as a refused fold.
        url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "test",
        externalSummary: new ConfiguredSummaryPlan({ enabled: true, targets: [{ name: "sm", protocol: "openai", url: "http://127.0.0.1:9/v1/chat/completions", model: "sm", apiKey: "k" }] }),
        unknownBaseline: true,
        log: (_l, m) => { logs.push(m); },
    };
    const result = await preflightCompress(deps, messages);
    assert.ok(result.compressedRanges >= 2, `the marathon must fold at least twice (got ${result.compressedRanges}; ${JSON.stringify(result.failure)})`);
    const receipts = logs.filter((l) => l.startsWith("[acp-proxy: [Compressed"));
    assert.ok(receipts.length >= 2, `expected >=2 committed folds (got ${receipts.length})\n${logs.join("\n")}`);
    // THE regression: the first fold consumes one chunk of one run while the
    // OTHER disjoint run is still untouched, so the round's own offer still
    // holds an advertised range. The stale-baseline tail could never see that
    // (its judgment sat below the window all run) and printed the stop signal
    // on this very receipt; the pinned-offer tail must advertise the survivor.
    // (Later receipts may legitimately stop once a fold's span overlaps its
    // round's whole offer — #2404 pinning semantics: the tail reports the
    // pinned offer, the next round recomputes.)
    assert.ok(receipts[0]!.includes(RANGES_HEADER),
        `the first receipt must advertise the round's remaining offer (old code: every receipt was a false stop signal)\n${receipts[0]}`);
    assert.ok(!receipts[0]!.includes(NO_RANGES_REMAIN_TEXT),
        `the first receipt must not claim nothing remains while the other run is untouched\n${receipts[0]}`);
});
