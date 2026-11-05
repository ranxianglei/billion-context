import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
process.env.NODE_ENV = "test";
import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.js";

// #5766: a DSH session whose new turn carried several oversized inline items (six
// base64 images, ~130K chars each) made EVERY candidate two-block span cross the
// 60,000-char tier-distillation source budget, so bounded tier-recovery found no
// legal span and ended structurally exhausted. That verdict was installed WITHOUT
// the `deterministic` flag its sibling futile-round paths carry (#3461), so the
// server fail-fast degraded to 502 instead of 413 — and status-code-driven hosts
// read 502 as transient and spun on doomed retries (field: 5+ in 8s).
//
// These tests pin the repaired verdict classification at the preflight boundary:
//   - the structurally-exhausted ending (span-math proved no legal span) IS
//     marked deterministic — the identical payload can never recover regardless of
//     upstream health;
//   - the relay/budget-dependent endings (call-budget cap) are NOT marked
//     deterministic — they keep their 502-retryable contract where the next round
//     continues from a smaller baseline (#3918).
// The oversized-item shape is modeled with long-text blocks: `spanContent` measures
// the real rendered chars of a span, so an item whose content alone blows any span
// past the budget behaves identically whether it is inline media or prose.

function filler(chars: number, tag: string): string {
    const unit = `${tag} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega `;
    return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

interface BuildOpts { limit: number; blocks: number[]; tailChars: number; }

// One tier-1 block per entry of `blocks` (summary sized to the entry) plus a small
// foldable "early" message (defers the raw futility gate to tier recovery) and a
// protected tail. Block mass dominates the payload, so the raw pool alone cannot
// close any deficit. Mirrors tests/issue3646-tier-recovery-picker.test.ts.
function buildSession(o: BuildOpts) {
    const core = createCore();
    const config = defaultConfig(o.limit);
    config.preserveRecentMessages = 1;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
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
    const seeded = state.blocks.filter((b) => b.active);
    assert.equal(seeded.length, o.blocks.length, `fixture must seed ${o.blocks.length} tier-1 blocks (got ${seeded.length})`);
    const session: Session = {
        id: "issue5766-preflight", meta: {}, metadata: {}, state,
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

test("#5766: a structurally-exhausted tier recovery (every span over budget) is marked deterministic", async () => {
    // Three ~40k-char items: any two-block span (~80k) crosses the 60,000-char source
    // budget, so the picker finds no legal candidate — the same gate six oversized
    // inline images trip in production. Recovery must end structurally exhausted and
    // the verdict MUST carry deterministic:true (→ 413 not-forwarded, no host spin).
    const { core, config, messages, session } = buildSession({ limit: 10000, blocks: [40000, 40000, 40000], tailChars: 200 });
    const { server, url, bodies } = await startRecordingUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), messages);
        assert.equal(result.fitsWindow, false, "a 120k-char payload cannot fit a 10k window");
        assert.equal(result.failure?.kind, "exhausted", `expected honest exhaustion, got ${JSON.stringify(result.failure)}`);
        assert.match(result.failure?.detail ?? "", /no two-block span stayed under the 60,000-character source budget/, `diagnostic must name the source-budget blockage (got: ${result.failure?.detail})`);
        // THE FIX: structural exhaustion is deterministic — the identical payload can
        // never recover regardless of upstream health. Before the fix this was undefined.
        assert.equal(result.failure?.deterministic, true, `structurally-exhausted recovery must be flagged deterministic (got ${JSON.stringify(result.failure)})`);
        assert.equal(bodies.length, 0, "an all-oversized pool must not spend a summary call");
    } finally {
        server.close();
    }
});

test("#5766: a single positionable block (below the two-block gate) is also marked deterministic", async () => {
    // Only one active tier-1 block survives reconciliation — below the two-block gate,
    // so no span can ever be assembled. Same structural truth as the over-budget case:
    // deterministic, not a relay-dependent 502.
    const { core, config, messages, session } = buildSession({ limit: 10000, blocks: [40000, 40000], tailChars: 200 });
    // Drop the second block's covered messages from the resent wire so reconciliation
    // deactivates it, leaving exactly one active block.
    const gone = new Set(["u1", "a1"]);
    const resent = messages.filter((m) => !gone.has(m.id));
    const activeAfter = () => session.state.blocks.filter((b) => b.active).length;
    const { server, url } = await startRecordingUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), resent);
        assert.equal(result.failure?.kind, "exhausted", `expected honest exhaustion, got ${JSON.stringify(result.failure)}`);
        assert.ok(activeAfter() <= 1 || /no tier held two or more active blocks|positionable/i.test(result.failure?.detail ?? ""), `expected a below-gate or unpositionable end state (active=${activeAfter()}, got: ${result.failure?.detail})`);
        assert.equal(result.failure?.deterministic, true, `below-two-block-gate exhaustion must be flagged deterministic (got ${JSON.stringify(result.failure)})`);
    } finally {
        server.close();
    }
});

test("#5766 (negative gate): a call-budget-cap ending is NOT marked deterministic (keeps 502-retryable)", async () => {
    // Twelve 25k blocks: every pair (~50k) fits, so recovery distills until it hits the
    // six-call cap while the 60k-char tail floor alone still exceeds the window. That is
    // a BUDGET ending, not a structural proof — it must stay non-deterministic so the
    // server keeps its 502-retryable contract where the next round continues from the
    // folded baseline (#3918). Over-marking this deterministic would wrongly 413 it.
    const { core, config, messages, session } = buildSession({ limit: 12000, blocks: Array(12).fill(25000), tailChars: 60000 });
    const { server, url, bodies } = await startRecordingUpstream(openAiBody(filler(300, "CONDENSED")));
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), messages);
        const calls = bodies.filter((b) => b.includes("must be distilled"));
        assert.equal(calls.length, 6, `recovery must run to the 6-call cap (used ${calls.length})`);
        assert.equal(result.failure?.kind, "exhausted", `expected exhaustion at the cap, got ${JSON.stringify(result.failure)}`);
        assert.match(result.failure?.detail ?? "", /bounded distillation call budget was reached after 6 call\(s\)/, `diagnostic must name the call-budget end (got: ${result.failure?.detail})`);
        // THE CONTRAST: a budget ending is NOT a structural impossibility — it must not
        // be flagged deterministic (would wrongly force a 413 and kill the continue-on-retry path).
        assert.ok(!result.failure?.deterministic, `call-budget-cap ending must stay non-deterministic (got ${JSON.stringify(result.failure)})`);
    } finally {
        server.close();
    }
});
