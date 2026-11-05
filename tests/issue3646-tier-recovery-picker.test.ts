import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
process.env.NODE_ENV = "test";
import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.js";

// #3646: the bounded tier-recovery candidate picker (#2952) pinned its start to the
// front-most positioned block and declared "every compression tier is exhausted"
// when the FIRST pair crossed the 60k source-char budget — even when a later pair
// in the same tier, or a viable T2 pair behind a blocked T1 pool, was eligible.
// These tests pin the repaired search: slide past an over-budget leading pair,
// fall through from a blocked preferred tier to the other supported tier, and
// report WHICH gate blocked the search instead of the blanket exhaustion claim,
// and keep the T1->T2 merge preferred while BOTH pools hold candidates.
// Caps (6 calls, 60k chars), cancellation bounds, and T1->T2 / T2->T3 semantics
// are unchanged.

const CAP = 6; // mirrors src/preflight.ts MAX_TIER_DISTILL_CALLS

function filler(chars: number, tag: string): string {
    const unit = `${tag} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega `;
    return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

interface BuildOpts { limit: number; blocks: number[]; tailChars: number; }

// History folded into one tier-1 block per entry of `blocks` (summary sized to the
// entry, tagged BLK<i>) plus a small foldable "early" message (so the raw futility
// gate defers to tier recovery) and a protected tail. Block mass dominates the
// payload, so the raw pool alone cannot close any deficit.
function buildSession(o: BuildOpts) {
    const core = createCore();
    const config = defaultConfig(o.limit);
    config.preserveRecentMessages = 1; // protect the tail (last) message
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    // Fixture summaries deliberately exceed the 20k-char default (the span math
    // needs 40-58k blocks); 0 disables the kernel's summary-length guard.
    config.compress.maxSummaryLength = 0;
    const messages: CoreMessage[] = [
        { id: "early", role: "user", contentType: "text", text: filler(500, "EARLY") },
    ];
    for (let i = 0; i < o.blocks.length; i++) {
        const chars = o.blocks[i]!;
        messages.push({ id: `u${i}`, role: "user", contentType: "text", text: filler(chars, `HISTU${i}`) });
        messages.push({ id: `a${i}`, role: "assistant", contentType: "text", text: filler(120, `HISTA${i}`) });
    }
    messages.push({ id: "tail", role: "user", contentType: "text", text: filler(o.tailChars, "TAIL") });
    const turn = core.processTurn({ messages, state: createInitialState(), config: { ...config, modelContextLimit: o.limit * 1000 }, tokenCount: o.limit * 1000, renderTags: "text-only" });
    const foldCfg = { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 };
    let state = turn.state;
    for (let i = 0; i < o.blocks.length; i++) {
        const ref = turn.state.messageRefs.byRaw[`u${i}`];
        const c = core.applyCompression({ messages, state, config: foldCfg, ranges: [{ startRef: ref, endRef: ref, summary: filler(o.blocks[i]!, `BLK${i}`) }] });
        state = c.state;
    }
    // Seed integrity: every fold must have produced its block (the kernel silently
    // drops ranges whose summary violates length guards — assert instead of trusting).
    const seeded = state.blocks.filter((b) => b.active);
    assert.equal(seeded.length, o.blocks.length, `fixture must seed ${o.blocks.length} tier-1 blocks (got ${seeded.length})`);
    for (let i = 0; i < o.blocks.length; i++) {
        assert.ok(seeded.some((b) => b.tier === 1 && b.effectiveMessageIds.includes(`u${i}`)), `block for u${i} missing`);
    }
    const session: Session = {
        id: "issue3646-preflight", meta: {}, metadata: {}, state,
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: o.limit * 4, compressCreditTokens: 0, contextTokens: o.limit * 4, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [], createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false,
    };
    return { core, config, messages, session };
}

async function startRecordingUpstream(body: object): Promise<{ server: http.Server; url: string; bodies: string[] }> {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
        let data = "";
        req.on("data", (c) => { data += c; });
        req.on("end", () => {
            bodies.push(data);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    return { server, url: `http://127.0.0.1:${addr.port}`, bodies };
}

function openAiBody(content: string): object {
    return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
}

function makePlan(url: string): ConfiguredSummaryPlan {
    return new ConfiguredSummaryPlan({ enabled: true, targets: [{ name: "sm", protocol: "openai", url, model: "sm", apiKey: "k" }] });
}

function makeDeps(core: ReturnType<typeof createCore>, session: Session, config: ReturnType<typeof defaultConfig>, url: string, logs: string[]): PreflightDeps {
    return {
        core, session, config, prompts: defaultPrompts, protocol: "responses",
        // Port 9 refuses instantly: model-lane traffic must never reach the stub.
        url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "test",
        externalSummary: makePlan(url), log: (_l, m) => { logs.push(m); },
    };
}

// Distillation calls carry the "must be distilled" TASK prompt; raw-range folds do not.
const distillCalls = (bodies: string[]): string[] => bodies.filter((b) => b.includes("must be distilled"));

test("#3646: an over-budget FIRST pair must not hide a viable later pair in the same tier", async () => {
    // A (58k chars) + B (4k) span ~62k > 60k budget; B + C (4k) span ~8k fits.
    // The old picker started at A, broke, and claimed every tier exhausted with
    // ZERO distillation calls. The repair must pick B..C, send exactly that span
    // (not A) to the stubbed summarizer once, and then fail honestly: A alone
    // (~14.5k tokens) still exceeds the 10k-token window, so no fit may be claimed.
    const { core, config, messages, session } = buildSession({ limit: 10000, blocks: [58000, 4000, 4000], tailChars: 200 });
    const { server, url, bodies } = await startRecordingUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), messages);
        assert.equal(result.fitsWindow, false, `A alone cannot fit a 10k window (estimate ${result.payloadEstimate}) — no fit may be claimed`);
        assert.equal(result.failure?.kind, "exhausted", `expected honest exhaustion after the B..C merge, got ${JSON.stringify(result.failure)}`);
        const calls = distillCalls(bodies);
        assert.equal(calls.length, 1, `exactly one distillation call expected (got ${calls.length})`);
        assert.ok(calls[0]!.includes("BLK1") && calls[0]!.includes("BLK2"), "the distillation input must cover the B..C span");
        assert.ok(!calls[0]!.includes("BLK0"), "the over-budget A block must NOT be in the distillation input");
        assert.ok(session.state.blocks.some((b) => b.active && b.tier === 2), "the B..C merge must create a tier-2 block");
        assert.match(result.failure?.detail ?? "", /no tier held two or more active blocks to distill/i, `diagnostic must name the real end state (got: ${result.failure?.detail})`);
    } finally {
        server.close();
    }
});

test("#3646: a blocked T1 pool must fall through to a viable T2 pool", async () => {
    // Two 40k T1 blocks whose combined span (~80k) exceeds the budget sit ahead of
    // four small T1 blocks pre-merged pairwise into two ADJACENT T2 blocks (4k
    // summaries each, span ~8k). The old code chose the T1 pool alone and
    // dead-ended; the repair must distill the T2 pair to T3 and only then report
    // the tier-1 source-budget blockage.
    const { core, config, messages, session } = buildSession({ limit: 10000, blocks: [40000, 40000, 2000, 2000, 2000, 2000], tailChars: 200 });
    const foldCfg = { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const idOf = (msgId: string): string => {
        const b = session.state.blocks.find((x) => x.active && x.effectiveMessageIds.includes(msgId));
        assert.ok(b, `fixture must have an active block covering ${msgId}`);
        return b!.blockId;
    };
    for (const [a, b, tag] of [["u2", "u3", "T2A"], ["u4", "u5", "T2B"]] as const) {
        const c = core.applyCompression({ messages, state: session.state, config: foldCfg, ranges: [{ startRef: idOf(a), endRef: idOf(b), summary: filler(4000, tag) }] });
        session.state = c.state;
    }
    assert.equal(session.state.blocks.filter((b) => b.active && b.tier === 2).length, 2, "fixture seeds two tier-2 blocks");
    const { server, url, bodies } = await startRecordingUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), messages);
        const calls = distillCalls(bodies);
        assert.equal(calls.length, 1, `exactly one distillation call expected (got ${calls.length})`);
        assert.ok(calls[0]!.includes("T2A") && calls[0]!.includes("T2B"), "the T2 pair must reach the stubbed summarizer");
        assert.ok(!calls[0]!.includes("BLK0") && !calls[0]!.includes("BLK1"), "the blocked T1 blocks must not leak into the T2 distillation input");
        assert.ok(session.state.blocks.some((b) => b.active && b.tier === 3), "the T2 merge must create a tier-3 block");
        assert.equal(result.failure?.kind, "exhausted", `expected honest exhaustion after the T2 merge, got ${JSON.stringify(result.failure)}`);
        assert.equal(result.fitsWindow, false, "the 80k T1 mass plus tail cannot fit a 10k window");
        assert.match(result.failure?.detail ?? "", /tier-1: no two-block span stayed under the 60,000-character source budget/, `diagnostic must name the tier-1 blockage (got: ${result.failure?.detail})`);
    } finally {
        server.close();
    }
});

test("#3646: when EVERY pair crosses the source budget, no distillation call may fire", async () => {
    const { core, config, messages, session } = buildSession({ limit: 10000, blocks: [40000, 40000, 40000], tailChars: 200 });
    const { server, url, bodies } = await startRecordingUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), messages);
        assert.equal(distillCalls(bodies).length, 0, "an all-oversized pool must not spend a summary call");
        assert.equal(result.failure?.kind, "exhausted", `expected honest exhaustion, got ${JSON.stringify(result.failure)}`);
        assert.equal(result.fitsWindow, false, "a 120k-char payload cannot fit a 10k window");
        assert.match(result.failure?.detail ?? "", /tier-1: no two-block span stayed under the 60,000-character source budget/, `diagnostic must name the source-budget blockage (got: ${result.failure?.detail})`);
        assert.ok(!session.state.blocks.some((b) => b.active && b.tier >= 2), "no higher-tier block may be created");
    } finally {
        server.close();
    }
});

test("#3646: blocks whose covered messages left the resent wire spend no recovery calls", async () => {
    // The host re-sent its history WITHOUT the messages covered by blocks 1 and 2
    // (e.g. after a native compaction dropped old turns). The kernel's reconciliation
    // deactivates those orphaned blocks during processTurn, so they neither render
    // nor become distillation candidates: no summary call may target them, the
    // payload is judged on live mass only, and the verdict stays honest (no fit).
    const { core, config, messages, session } = buildSession({ limit: 10000, blocks: [50000, 20000, 20000], tailChars: 200 });
    const gone = new Set(["u1", "a1", "u2", "a2"]);
    const resent = messages.filter((m) => !gone.has(m.id));
    const { server, url, bodies } = await startRecordingUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), resent);
        assert.equal(distillCalls(bodies).length, 0, "orphaned blocks must not spend a summary call");
        assert.equal(result.failure?.kind, "exhausted", `expected honest exhaustion, got ${JSON.stringify(result.failure)}`);
        assert.equal(result.fitsWindow, false, "a 50k-char block plus tail cannot fit a 10k window");
        // The mechanism that keeps this scenario benign: reconciliation deactivated
        // the orphaned blocks, leaving one active tier-1 block (below the 2-block gate).
        assert.ok(session.state.blocks.every((b) => !b.active || [...b.effectiveMessageIds].every((id) => resent.some((m) => m.id === id))), "every active block must still be anchored in the resent wire");
    } finally {
        server.close();
    }
});

test("#3646: the six-call cap still bounds a long feasible ladder", async () => {
    // Twelve 25k blocks: every pair span (~50k) fits but no triple (~75k) does, so
    // each call merges exactly two blocks. The protected tail (60k chars ≈ 15k
    // tokens) alone exceeds the 12k window, so the deficit can never be closed —
    // the loop must stop at exactly six distillation calls with the call-budget
    // verdict, not run on.
    const { core, config, messages, session } = buildSession({ limit: 12000, blocks: Array(12).fill(25000), tailChars: 60000 });
    const { server, url, bodies } = await startRecordingUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), messages);
        assert.equal(distillCalls(bodies).length, CAP, `recovery must stop at the ${CAP}-call cap (used ${distillCalls(bodies).length})`);
        assert.equal(result.failure?.kind, "exhausted", `expected honest exhaustion at the cap, got ${JSON.stringify(result.failure)}`);
        assert.equal(result.fitsWindow, false, "the tail floor alone exceeds the window");
        assert.match(result.failure?.detail ?? "", /bounded distillation call budget was reached after 6 call\(s\)/, `diagnostic must name the call-budget end (got: ${result.failure?.detail})`);
    } finally {
        server.close();
    }
});

test("#3646 review: with BOTH pools feasible the T1 pair must be distilled before any T2 pair", async () => {
    // Four 25k T1 blocks (every pair ~50k fits, no triple ~75k) plus two pre-merged
    // adjacent T2 blocks (4k summaries each). Both pools hold candidates from the
    // first iteration; T1 preference must win — a missing pool break let the later
    // T2 pool overwrite the feasible T1 choice and condense coarser T2->T3 before
    // the finer T1->T2 merge, inverting the old t1.length >= 2 ? t1 : t2 behavior.
    const { core, config, messages, session } = buildSession({ limit: 10000, blocks: [25000, 25000, 25000, 25000, 3000, 3000, 3000, 3000], tailChars: 200 });
    const foldCfg = { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const idOf = (msgId: string): string => {
        const b = session.state.blocks.find((x) => x.active && x.effectiveMessageIds.includes(msgId));
        assert.ok(b, `fixture must have an active block covering ${msgId}`);
        return b!.blockId;
    };
    for (const [a, b, tag] of [["u4", "u5", "T2A"], ["u6", "u7", "T2B"]] as const) {
        const c = core.applyCompression({ messages, state: session.state, config: foldCfg, ranges: [{ startRef: idOf(a), endRef: idOf(b), summary: filler(4000, tag) }] });
        session.state = c.state;
    }
    assert.equal(session.state.blocks.filter((b) => b.active && b.tier === 1).length, 4, "fixture seeds four tier-1 blocks");
    assert.equal(session.state.blocks.filter((b) => b.active && b.tier === 2).length, 2, "fixture seeds two tier-2 blocks");
    const { server, url, bodies } = await startRecordingUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        await preflightCompress(makeDeps(core, session, config, url, logs), messages);
        const calls = distillCalls(bodies);
        assert.ok(calls.length >= 1, "recovery must run at least one distillation");
        assert.ok(calls[0]!.includes("BLK0") && calls[0]!.includes("BLK1"), "the FIRST distillation must carry the front T1 pair");
        assert.ok(!calls[0]!.includes("T2A") && !calls[0]!.includes("T2B"), "the T2 pool must not preempt the T1 choice");
        assert.ok(session.state.blocks.some((b) => b.active && b.tier === 2 && b.effectiveMessageIds.includes("u0")), "the first merge must be T1->T2 over u0..u1");
    } finally {
        server.close();
    }
});
