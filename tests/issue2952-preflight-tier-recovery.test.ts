import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
process.env.NODE_ENV = "test";
import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import type { ResolvedKernelConfig } from "../src/compress-settings.ts";
import type { Session } from "../src/session.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.js";

// #2952: the preflight futility gate bounded max-saving on RAW-message ranges
// only, ignoring recoverable T1/T2 summary-block mass. A tier-enabled session
// whose raw pool sat below the required reduction deadlocked at 502 even though
// distilling existing T1 blocks to T2/T3 would have closed the gap. Design A+C:
// defer the terminal verdict, run ONE bounded tier-distillation pass, re-measure,
// and fail honestly only when every tier is exhausted — never forwarding
// over-window. These tests pin the three shapes: positive recovery, honest
// all-tier exhaustion (no forward), and byte-identical tiers=false behavior.

// Bounded distillation cap mirrored from src/preflight.ts (MAX_TIER_DISTILL_CALLS).
const CAP = 6;

function filler(chars: number, tag: string): string {
    const unit = `${tag} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega `;
    return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

interface FixtureOpts { limit: number; blockCount: number; blockChars: number; tailChars: number; }

// Builds a session whose history is already folded into `blockCount` tier-1
// blocks (large summaries) plus a small foldable early message (so raw
// potential > 0, tripping the futility gate) and a protected tail. The block
// mass dominates the payload, so the raw pool alone cannot close the deficit.
function buildFixture(o: FixtureOpts) {
    const core = createCore();
    const config = defaultConfig(o.limit);
    config.preserveRecentMessages = 1; // protect the tail (last) message
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const messages: CoreMessage[] = [
        { id: "early", role: "user", contentType: "text", text: filler(500, "EARLY") },
    ];
    for (let i = 0; i < o.blockCount; i++) {
        messages.push({ id: `u${i}`, role: "user", contentType: "text", text: filler(o.blockChars, `HISTU${i}`) });
        messages.push({ id: `a${i}`, role: "assistant", contentType: "text", text: filler(120, `HISTA${i}`) });
    }
    messages.push({ id: "tail", role: "user", contentType: "text", text: filler(o.tailChars, "TAIL") });
    const turn = core.processTurn({ messages, state: createInitialState(), config: { ...config, modelContextLimit: o.limit * 1000 }, tokenCount: o.limit * 1000, renderTags: "text-only" });
    const foldCfg = { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 };
    let state = turn.state;
    for (let i = 0; i < o.blockCount; i++) {
        const ref = turn.state.messageRefs.byRaw[`u${i}`];
        const c = core.applyCompression({ messages, state, config: foldCfg, ranges: [{ startRef: ref, endRef: ref, summary: filler(o.blockChars, `BLK${i}`) }] });
        state = c.state;
    }
    const activeBlocks = state.blocks.filter((b) => b.active);
    const session: Session = {
        id: "issue2952-preflight", meta: {}, metadata: {}, state,
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: o.limit * 4, compressCreditTokens: 0, contextTokens: o.limit * 4, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [], createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false,
    };
    return { core, config, messages, session, activeBlocks };
}

async function startSummaryUpstream(body: object): Promise<{ server: http.Server; url: string }> {
    const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    return { server, url: `http://127.0.0.1:${addr.port}` };
}

function openAiBody(content: string): object {
    return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
}

function makePlan(url: string): ConfiguredSummaryPlan {
    return new ConfiguredSummaryPlan({ enabled: true, targets: [{ name: "sm", protocol: "openai", url, model: "sm", apiKey: "k" }] });
}

test("#2952: tier-enabled overflow recovers by distilling T1 blocks when the raw pool is insufficient", async () => {
    const { core, config, messages, session, activeBlocks } = buildFixture({ limit: 12000, blockCount: 6, blockChars: 18000, tailChars: 200 });
    assert.ok(activeBlocks.every((b) => b.tier === 1), "fixture seeds tier-1 blocks");
    const { server, url } = await startSummaryUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const deps: PreflightDeps = {
            core, session, config, prompts: defaultPrompts, protocol: "responses",
            url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "test",
            externalSummary: makePlan(url), log: (_l, m) => { logs.push(m); },
        };
        const result = await preflightCompress(deps, messages);
        assert.equal(result.failure, undefined, `expected recovery, got failure: ${JSON.stringify(result.failure)}`);
        assert.equal(result.fitsWindow, true, `payload must fit after distillation (estimate ${result.payloadEstimate} vs limit 12000)`);
        const higherTiers = session.state.blocks.filter((b) => b.active && b.tier >= 2);
        assert.ok(higherTiers.length >= 1, `distillation must create a T2/T3 block (got ${higherTiers.length})`);
        assert.ok(result.externalDispatch && result.externalDispatch.calls >= 1, "recovery must spend at least one summary call");
        assert.ok(result.externalDispatch!.calls <= CAP, `recovery must respect the ${CAP}-call cap (used ${result.externalDispatch!.calls})`);
        assert.ok(result.compressedRanges >= 1, `recovery must count as a fold so the caller rebuilds THIS round's outbound request (compressedRanges=${result.compressedRanges})`);
        assert.ok(logs.some((l) => l.includes("#2952")), `must log the deferred tier-distillation recovery (logs: ${logs.join(" | ")})`);
    } finally {
        server.close();
    }
});

test("#2952: unknown-baseline mode — an over-window payload dominated by distillable T1 blocks is never marked fit-to-forward (constraint #1)", async () => {
    // Unknown baseline (no upstream usage anchor): the caller judges the window on the
    // upper-bound estimate (finalUpper), not the floorless payloadEstimate. The safety-
    // critical direction is that a payload that genuinely cannot be brought under the
    // window is NEVER reported as fitting — otherwise the caller forwards an over-window
    // request. A protected tail whose mass alone exceeds the 4000-token window is an
    // invariant floor no amount of T1->T2->T3 distillation removes, so fitsWindow must
    // read false regardless of whether the bounded distillation engages. (Per review
    // finding 1b, any engagement recomputes finalUpper from the post-fold view rather
    // than trusting a stale value; this pins the judgment's safety direction.)
    const { core, config, messages, session } = buildFixture({ limit: 4000, blockCount: 6, blockChars: 18000, tailChars: 24000 });
    const { server, url } = await startSummaryUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const deps: PreflightDeps = {
            core, session, config, prompts: defaultPrompts, protocol: "responses",
            url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "test",
            unknownBaseline: true, externalSummary: makePlan(url), log: (_l, _m) => { /* ignore */ },
        };
        const result = await preflightCompress(deps, messages);
        assert.equal(result.fitsWindow, false, "an over-window payload must never be marked fit-to-forward in unknown-baseline mode");
        assert.ok(result.failure !== undefined, "an unrecovered over-window payload carries a failure verdict");
    } finally {
        server.close();
    }
});

test("#2952: when every tier is exhausted, fail honestly and never forward over-window", async () => {
    // A protected tail whose mass alone exceeds the window is an invariant floor:
    // no amount of T1->T2->T3 distillation can remove it, so recovery must run its
    // bounded attempts and then report all-tier exhaustion (kind "exhausted",
    // fitsWindow false => the caller will not forward an over-window request).
    const { core, config, messages, session } = buildFixture({ limit: 4000, blockCount: 6, blockChars: 18000, tailChars: 24000 });
    const { server, url } = await startSummaryUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const deps: PreflightDeps = {
            core, session, config, prompts: defaultPrompts, protocol: "responses",
            url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "test",
            externalSummary: makePlan(url), log: (_l, m) => { logs.push(m); },
        };
        const result = await preflightCompress(deps, messages);
        assert.equal(result.failure?.kind, "exhausted", `expected honest exhaustion, got: ${JSON.stringify(result.failure)}`);
        // #3646 refined the blanket "every compression tier is exhausted" claim into
        // cause-specific reasons; this fixture ends with no tier holding two active
        // blocks (the T1 pairs were merged down to singletons plus higher tiers).
        assert.match(result.failure?.detail ?? "", /no tier held two or more active blocks to distill/i, `detail must name the real end state (got: ${result.failure?.detail})`);
        assert.equal(result.fitsWindow, false, "an unrecoverable payload must NOT be marked fit-to-forward");
        // Bounded: the recovery path must stop at the cap even though it cannot win.
        assert.ok(!result.externalDispatch || result.externalDispatch.calls <= CAP, `bounded to ${CAP} calls (used ${result.externalDispatch?.calls})`);
        assert.ok(logs.some((l) => l.includes("#2952")), "recovery must have been attempted (then failed)");
    } finally {
        server.close();
    }
});

test("#2952: tiers=false keeps the existing behavior — no distillation, old futility verdict", async () => {
    const { core, config, messages, session, activeBlocks } = buildFixture({ limit: 12000, blockCount: 6, blockChars: 18000, tailChars: 200 });
    (config as ResolvedKernelConfig).tiers.enabled = false;
    const logs: string[] = [];
    const deps: PreflightDeps = {
        core, session, config, prompts: defaultPrompts, protocol: "responses",
        // Port 9 refuses instantly: if recovery were (wrongly) entered, the stray
        // model-lane call surfaces as kind "upstream", not the old "exhausted".
        url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "test",
        log: (_l, m) => { logs.push(m); },
    };
    const result = await preflightCompress(deps, messages);
    assert.equal(result.failure?.kind, "exhausted", `expected the pre-existing exhaustion, got: ${JSON.stringify(result.failure)}`);
    assert.match(result.failure?.detail ?? "", /maximum possible saving|no combination of folds/i, `must keep the OLD futility wording (got: ${result.failure?.detail})`);
    assert.ok(!logs.some((l) => l.includes("#2952")), `tiers=false must not enter tier recovery (logs: ${logs.join(" | ")})`);
    assert.equal(session.state.blocks.filter((b) => b.active).length, activeBlocks.length, "no blocks may be created or destroyed when tiers=false");
});
