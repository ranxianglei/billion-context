// #2778: failed-compress recovery hints must advertise ONLY ranges the actual
// apply-side gate accepts. The old arithmetic hint (highest-ref minus block
// boundary) pointed "Retry NOW" at spans the gate deterministically refuses —
// a protected tail, a covered prefix, or a sub-minimum range — so one refused
// call became a self-amplifying retry loop. The hint now derives from the SAME
// live eligibility acp_status reports (shared liveNudgeDecision/submitGatedRanges
// source), and falls through to block distillation or an honest stop when
// nothing raw is eligible. Supersedes the #1026/#1366/#2362 arithmetic-era
// assertions below the shared-source rewrite.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage, Config } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap, deactivateBlock } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, liveSpanHint, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

function cfgNoProtect(): Config {
    return defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
}

function makeCtx(config?: Config): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: config ?? defaultConfig(200000),
        messages: MESSAGES,
        session: {
            id: "span-hint-test",
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

function seedRefs(ctx: Ctx): void {
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
}

/** refs assigned + one ACTIVE kernel block covering m00002..m00020 */
function makeFoldedCtx(config?: Config): Ctx {
    const ctx = makeCtx(config);
    seedRefs(ctx);
    const r = ctx.core.applyCompression({ ranges: [{ startRef: "m00002", endRef: "m00020", summary: "y".repeat(100) }], messages: ctx.messages, state: ctx.session.state, config: ctx.config });
    assert.equal(r.result.blocksCreated, 1, `seed fold must succeed: ${r.result.errors.join("; ")}`);
    ctx.session.state = r.state;
    return ctx;
}

test("#2778: CORE — a fully-protected tail offers no retry push (old bug)", () => {
    // defaultConfig(200000): preserveRecentTokens=5000 shields every remaining
    // raw ref, so nothing clears the gate. The arithmetic hint used to say
    // "Live compressible refs: m00021–m00080 … Retry NOW" here.
    const ctx = makeFoldedCtx();
    const hint = liveSpanHint(ctx);
    assert.ok(!hint.includes("Retry NOW"), `must not push a doomed retry: ${hint}`);
    assert.ok(!hint.includes("Live compressible refs right now"), `must not advertise the protected tail: ${hint}`);
    assert.ok(hint.includes("No compressible ranges right now"), `honest stop expected: ${hint}`);
    assert.ok(hint.includes("Continue the task"), `tells the agent to move on: ${hint}`);
    assert.ok(!hint.includes("\n"), `single-line receipt constraint (#1029): ${hint}`);
});

test("#2778: eligible live ranges ARE offered when they clear the gates", () => {
    const ctx = makeFoldedCtx(cfgNoProtect());
    const hint = liveSpanHint(ctx);
    assert.ok(hint.includes("Live compressible refs right now"), `eligible span offered: ${hint}`);
    assert.ok(hint.includes("Retry NOW"), `retry push only when genuinely eligible: ${hint}`);
    assert.match(hint, /m0\d{4}–m0\d{4}/, `names concrete ref spans: ${hint}`);
    assert.ok(!hint.includes("\n"), `single-line: ${hint}`);
});

test("#2778: >=2 active blocks with no eligible raw falls to block distillation by real id", () => {
    const ctx = makeCtx(cfgNoProtect());
    seedRefs(ctx);
    for (const [s, e] of [["m00001", "m00040"], ["m00041", "m00080"]] as const) {
        const r = ctx.core.applyCompression({ ranges: [{ startRef: s, endRef: e, summary: "y".repeat(100) }], messages: ctx.messages, state: ctx.session.state, config: ctx.config });
        assert.equal(r.result.blocksCreated, 1, `fold ${s}..${e}: ${r.result.errors.join("; ")}`);
        ctx.session.state = r.state;
    }
    const actives = ctx.session.state.blocks.filter((b) => b.active).map((b) => b.blockId);
    assert.ok(actives.length >= 2, `expected >=2 active blocks, got ${actives.join(",")}`);
    const hint = liveSpanHint(ctx);
    assert.ok(hint.includes("compress a run of ACTIVE blocks instead"), `distill wording: ${hint}`);
    assert.ok(hint.includes(`startId ${actives[0]}, endId ${actives[actives.length - 1]}`), `real block ids: ${hint}`);
    assert.ok(!hint.includes("Retry NOW"), `no raw-retry push when raw is exhausted: ${hint}`);
});

test("#2778: dead/absent refs are never named as offered targets", () => {
    const ctx = makeFoldedCtx(cfgNoProtect());
    // client history rewrite drops two messages; record their refs dead.
    ctx.messages = ctx.messages.filter((m) => m.id !== "raw40" && m.id !== "raw54");
    ctx.session.state.deadRefs = ["m00041", "m00055"];
    const hint = liveSpanHint(ctx);
    // absent refs cannot be span endpoints, so the live source never surfaces
    // them as offered targets (the old arithmetic hint carved fake gaps here).
    assert.ok(!hint.includes("m00041"), `dead ref not offered: ${hint}`);
    assert.ok(!hint.includes("m00055"), `dead ref not offered: ${hint}`);
    assert.ok(!hint.includes("\n"), `single-line: ${hint}`);
});

test("#2778: a sub-minimum conversation offers no retry push (min size gate)", () => {
    const ctx = makeCtx(cfgNoProtect());
    ctx.messages = MESSAGES.slice(0, 4);
    seedRefs(ctx);
    const hint = liveSpanHint(ctx);
    assert.ok(!hint.includes("Retry NOW"), `below minCompressRange must not push retry: ${hint}`);
    assert.ok(!hint.includes("Live compressible refs right now"), `sub-minimum range not advertised: ${hint}`);
    assert.ok(hint.includes("No compressible ranges right now"), `honest stop: ${hint}`);
});

test("#2778: unavailable status degrades to 'run acp_status', never a guessed span", () => {
    const ctx = makeCtx();
    seedRefs(ctx);
    ctx.core.processTurn = () => { throw new Error("boom"); };
    const hint = liveSpanHint(ctx);
    assert.ok(hint.includes("Run acp_status"), `points at acp_status: ${hint}`);
    assert.ok(hint.includes("do not guess"), `forbids guessing a range: ${hint}`);
    assert.ok(!hint.includes("Retry NOW"), `no retry push on unavailable status: ${hint}`);
});

test("#2778: a decompressed (inactive) block releases its span back into the offer", () => {
    const ctx = makeFoldedCtx(cfgNoProtect());
    ctx.session.state = deactivateBlock(ctx.session.state, [ctx.session.state.blocks[0]!.blockId]);
    const hint = liveSpanHint(ctx);
    assert.ok(hint.includes("Live compressible refs right now"), `freed span offered again: ${hint}`);
    assert.match(hint, /m0\d{4}–m0\d{4}/, `names concrete ref spans: ${hint}`);
    assert.ok(!hint.includes("\n"), `single-line: ${hint}`);
});

test("#2778: no-valid-ranges receipt carries the LIVE hint (no false protected-tail span)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeFoldedCtx();
    const out = applyRanges(parseCompressInput({ content: [{ summary: "no bounds" }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), `failure receipt: ${out}`);
    assert.ok(out.includes("No compressible ranges right now"), `live-derived honest stop: ${out}`);
    assert.ok(!out.includes("Retry NOW in this same turn"), `no false retry into the protected tail: ${out}`);
    assert.ok(!out.includes("\n"), `single-line receipt (#1029): ${out}`);
});

test("#2778: blocksCreated=0 receipt carries the LIVE hint (no false protected-tail span)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeFoldedCtx();
    // stale refs (never assigned) → kernel rejects the range → 0 blocks
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m09999", endId: "m09999", summary: "s" }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), `failure receipt: ${out}`);
    assert.ok(out.includes("No compressible ranges right now"), `live-derived honest stop: ${out}`);
    assert.ok(!out.includes("Retry NOW in this same turn"), `no false retry into the protected tail: ${out}`);
    assert.ok(!out.includes("\n"), `single-line receipt (#1029): ${out}`);
});
