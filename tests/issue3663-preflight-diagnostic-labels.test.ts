import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import type { ResolvedKernelConfig } from "../src/compress-settings.js";
import type { Session } from "../src/session.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.js";
import { startServer, buildEffectiveWallClause } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { normalizeUpstreamOrigin } from "../src/util.ts";

// #3663 facet B: the preflight fail-fast headline cited the headroom-reserved
// wall as "the model window N" even though N = native − output-headroom
// reservation (handle.ts rewrites modelContextLimit in place, records no shrink
// reason). Readers chased model metadata instead of the setting that controls
// the rejection (compress.outputHeadroomMaxPct / the request's max_tokens).
// buildEffectiveWallClause labels the cited wall by what actually set it;
// every non-headroom shape must stay byte-identical to the historical wording.

test("#3663: buildEffectiveWallClause truth table (positive + all negative gates)", () => {
    assert.equal(
        buildEffectiveWallClause({ limit: 22_500, configuredLimit: 22_500, nativeWindow: 30_000, shrinkReason: undefined }),
        "the effective input budget 22500 (model window 30000, 7500 tokens reserved for model output via compress.outputHeadroomMaxPct)",
        "headroom-reserved wall must be labeled as the effective input budget with the native window and the controlling setting named");
    // Negative gates — each must keep the historical "the model window N" byte-for-byte:
    assert.equal(
        buildEffectiveWallClause({ limit: 30_000, configuredLimit: 30_000, nativeWindow: 30_000, shrinkReason: undefined }),
        "the model window 30000",
        "no reservation (configured == native) must not gain the headroom label");
    assert.equal(
        buildEffectiveWallClause({ limit: 22_500, configuredLimit: 22_500, nativeWindow: 30_000, shrinkReason: "operator" }),
        "the model window 22500",
        "an operator shrink keeps its own #736 note; the wall clause stays historical");
    assert.equal(
        buildEffectiveWallClause({ limit: 22_500, configuredLimit: 22_500, nativeWindow: 30_000, shrinkReason: "codex" }),
        "the model window 22500",
        "a codex alignment keeps its own #736 note; the wall clause stays historical");
    assert.equal(
        buildEffectiveWallClause({ limit: 20_000, configuredLimit: 22_500, nativeWindow: 30_000, shrinkReason: undefined }),
        "the model window 20000",
        "a wall strictly below config.modelContextLimit means the stated-wall overflow arm bound (#3450), not headroom");
    assert.equal(
        buildEffectiveWallClause({ limit: 22_500, configuredLimit: 22_500, nativeWindow: undefined, shrinkReason: undefined }),
        "the model window 22500",
        "without a resolved native window there is nothing to contrast — stay historical");
});

// Integration: the label must survive the FULL path — request max_tokens →
// handle.ts output-headroom reservation (in-place modelContextLimit rewrite) →
// preflightCompressIfNeeded fail-fast. Harness cloned from
// tests/issue3645-calibrated-futility.test.ts (same mock upstream + boot shape).

const WINDOW = 30_000;

type Call = { summary: boolean };
let CALLS: Call[] = [];

function chatSse(text: string, finishReason: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, finishReason) + "data: [DONE]\n\n";
}

function mockUpstream(): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            CALLS.push({ summary: /TASK: The conversation segment below/.test(Buffer.concat(chunks).toString("utf8")) });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse("forwarded answer", "stop"));
        });
    });
}

function proxyOptions(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } } as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 1000,
            protectedTools: ["bash"],
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

function bashPair(id: number, resultRepeat: number): Record<string, unknown>[] {
    return [
        { role: "assistant", content: null, tool_calls: [{ id: `call_${id}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] },
        { role: "tool", tool_call_id: `call_${id}`, content: `BASH_RESULT_${id}_payload_`.repeat(resultRepeat) },
    ];
}

async function boot(upstreamPort: number): Promise<{ proxyPort: number; cleanup: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = mockUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const proxy = await startServer(proxyOptions(upstreamPort));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        cleanup: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function post(proxyPort: number, upstreamPort: number, session: string, messages: Record<string, unknown>[], extraBody: Record<string, unknown>): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages, ...extraBody }),
    });
}

// #4185: an identified fresh session whose preflight ends in deterministic
// exhaustion forwards once for upstream arbitration — seed a settled usage
// baseline so these rows keep testing the LOCAL fail-fast contract.
function seedEvidence(upstreamPort: number, sessionId: string): void {
    const s = getSession(sessionId);
    s.stats.lastInputTokens = 100;
    s.stats.lastInputTokensSource = "usage";
    s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${upstreamPort}`);
}

test("#3663: headroom-reserved wall is labeled as the effective input budget end-to-end", async () => {
    CALLS = [];
    const upstream = mockUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const p = await boot(upstreamPort);
    try {
        // Two hard-protected bash pairs (never foldable) sized so the payload sits
        // OVER the headroom-reserved budget (30000 − min(8000, 0.25×30000)=22500)
        // yet UNDER the native window: the rejection is governed entirely by the
        // output-headroom reservation, exactly the reported shape.
        const REPEAT = 1990; // bulk ≈ 12×1990 + 40 ≈ 23960 tokens
        const sessionId = "issue3663-headroom-label";
        seedEvidence(upstreamPort, sessionId);
        const resp = await post(p.proxyPort, upstreamPort, sessionId, [
            ...bashPair(1, REPEAT),
            ...bashPair(2, REPEAT),
        ], { max_tokens: 8000 });
        const body = await resp.text();
        let json: { error?: { code?: string; message?: string } };
        try { json = JSON.parse(body); } catch { assert.fail(`expected a JSON fail-fast error, got HTTP ${resp.status}: ${body.slice(0, 240)}`); return; }
        assert.equal(resp.status, 413, `deterministic exhaustion must fail fast non-retryably: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.equal(json.error?.code, "preflight_compress_failed");
        const msg = json.error?.message ?? "";
        assert.match(msg, /context ~\d+ tokens exceeds the effective input budget 22500 \(model window 30000, 7500 tokens reserved for model output via compress\.outputHeadroomMaxPct\)/,
            `headroom-reserved wall must be labeled as the effective input budget with the native window named (got: ${msg})`);
        assert.ok(!msg.includes("exceeds the model window"), `must not call the reserved budget "the model window" (got: ${msg})`);
        assert.equal(CALLS.filter((c) => c.summary).length, 0, "deterministic exhaustion spends ZERO summarization calls");
    } finally {
        await p.cleanup();
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("#3663: without an output reservation the wall keeps the historical 'model window' label", async () => {
    CALLS = [];
    const upstream = mockUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const p = await boot(upstreamPort);
    try {
        // Same shape, NO max_tokens → no headroom reservation → limit == native.
        // Payload over the NATIVE window; the label must stay byte-historical.
        const REPEAT = 2660; // bulk ≈ 12×2660 + 40 ≈ 31960 tokens > 30000
        const sessionId = "issue3663-native-label";
        seedEvidence(upstreamPort, sessionId);
        const resp = await post(p.proxyPort, upstreamPort, sessionId, [
            ...bashPair(1, REPEAT),
            ...bashPair(2, REPEAT),
        ], {});
        const body = await resp.text();
        let json: { error?: { code?: string; message?: string } };
        try { json = JSON.parse(body); } catch { assert.fail(`expected a JSON fail-fast error, got HTTP ${resp.status}: ${body.slice(0, 240)}`); return; }
        assert.equal(resp.status, 413, `deterministic exhaustion must fail fast non-retryably: HTTP ${resp.status} ${body.slice(0, 240)}`);
        const msg = json.error?.message ?? "";
        assert.match(msg, /context ~\d+ tokens exceeds the model window 30000/, `no-reservation wall must keep the historical label (got: ${msg})`);
        assert.ok(!msg.includes("effective input budget"), `no headroom happened — the budget label must not appear (got: ${msg})`);
    } finally {
        await p.cleanup();
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

// #3663 facet C: the tier-recovery detail counted only COMPLETED distillations
// (callsUsed), so a recovery whose summarizer failed/timed out read "0 summary
// call(s)" although the logs show the attempts happened. The detail must state
// attempted-vs-completed; the common case (every dispatched call completed)
// keeps the historical phrasing byte-for-byte. Harness cloned from
// tests/issue2952-preflight-tier-recovery.test.ts (direct preflightCompress).

function filler(chars: number, tag: string): string {
    const unit = `${tag} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega `;
    return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

interface FixtureOpts { limit: number; blockCount: number; blockChars: number; tailChars: number; }

// Builds a session whose history is already folded into `blockCount` tier-1
// blocks (large summaries) plus a small foldable early message and a protected
// tail. The block mass dominates the payload, so the raw pool alone cannot
// close the deficit and the walk defers to tier distillation.
function buildFixture(o: FixtureOpts) {
    const core = createCore();
    const config = defaultConfig(o.limit);
    config.preserveRecentMessages = 1;
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
    const session: Session = {
        id: "issue3663-preflight", meta: {}, metadata: {}, state,
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: o.limit * 4, compressCreditTokens: 0, contextTokens: o.limit * 4, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [], createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false,
    };
    return { core, config, messages, session };
}

async function startJsonUpstream(status: number, body: object): Promise<{ server: http.Server; url: string }> {
    const server = http.createServer((_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
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

function makeDeps(core: ReturnType<typeof createCore>, session: Session, config: ResolvedKernelConfig, summaryUrl: string, logs: string[]): PreflightDeps {
    return {
        core, session, config, prompts: defaultPrompts, protocol: "responses",
        url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "test",
        externalSummary: makePlan(summaryUrl), log: (_l, m) => { logs.push(m); },
    };
}

test("#3663: a failed distillation dispatch is visible in the detail as an attempt, not '0 calls'", async () => {
    const { core, config, messages, session } = buildFixture({ limit: 12_000, blockCount: 6, blockChars: 18_000, tailChars: 200 });
    const { server, url } = await startJsonUpstream(500, { error: { message: "summarizer upstream exploded" } });
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), messages);
        assert.ok(result.failure, `the fully-failed recovery must end in a failure verdict (got fitsWindow=${result.fitsWindow})`);
        const detail = result.failure.detail ?? "";
        assert.match(detail, /0 of 1 attempted summary call\(s\) completed/,
            `a dispatched-but-failed distillation must be counted as an attempt (got: ${detail})`);
        assert.match(detail, /the distillation summary was unavailable/, `the unavailable cause must be named (got: ${detail})`);
        // A failed dispatch surfaces either as a thrown relay error or as an
        // unusable outcome (e.g. an upstream 500 body) — both stop recovery the
        // same way and both must leave a warn trace.
        assert.ok(logs.some((l) => /tier-\d->\d+ distillation (summary call failed|produced no usable summary)/.test(l)), `the warn log must record the failed dispatch (logs: ${logs.join(" | ")})`);
    } finally {
        server.close();
    }
});

test("#3663: completed-only recoveries keep the historical '(N summary call(s)' phrasing", async () => {
    // Every distillation returns a summary just under maxSummaryLength (20000
    // chars → 19600 chars ≈ 4900 tokens): usable by the executor's length gates
    // yet heavy enough that NO sequence of successful distillations can pull
    // the payload under the 4800-token window — the round ends futile with
    // every dispatched call COMPLETED, exactly the case that must read like it
    // always did. (An over-cap summary is rejected as invalid before apply,
    // which would exercise the failure path instead.)
    const { core, config, messages, session } = buildFixture({ limit: 4_800, blockCount: 6, blockChars: 18_000, tailChars: 200 });
    const { server, url } = await startJsonUpstream(200, openAiBody(filler(19_600, "HEAVYSUMMARY")));
    try {
        const logs: string[] = [];
        const result = await preflightCompress(makeDeps(core, session, config, url, logs), messages);
        assert.ok(result.failure, `heavy summaries can never close the gap — expect a failure verdict (got fitsWindow=${result.fitsWindow})`);
        const detail = result.failure.detail ?? "";
        assert.match(detail, /\(\d+ summary call\(s\), net ~\d+ tokens saved\)/,
            `completed-only recovery must keep the historical phrasing (got: ${detail})`);
        assert.ok(!detail.includes("attempted"), `no dispatch failed — the attempted-vs-completed split must not appear (got: ${detail})`);
    } finally {
        server.close();
    }
});
