import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import type { NudgeDecision } from "acp-kernel";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { buildContextView } from "../src/context-view.ts";
import type { Session } from "../src/session.ts";

// #3862: the /__bili/plugin/status `contextView` field — the machine-readable
// twin of the panel breakdown that the dsh client Context tab renders. Two
// layers: unit math on buildContextView (categories sum exactly to sentTotal,
// anchor ladder, fold/switch trails from a seeded ledger) and an integration
// pass through the real server (field presence, additive regression, CORS
// echo for cross-origin browser readers).

const AGG_KEYS = [
    "requests", "input", "cached", "output", "nc", "cr", "tr",
    "switches", "switchMissed", "keySwitches", "keySwitchMissed",
    "promptSwitches", "promptSwitchMissed", "projSwitches", "projSwitchMissed",
    "wireSwitches", "wireSwitchMissed", "upstreamSwitches", "upstreamSwitchMissed",
    "restartDrops", "restartDropMissed", "attributedMissed",
    "unknownSamples", "unknownInput", "nbSamples", "nbInput",
    "seamSuspects", "seamMissed",
    "providerSideMisses", "providerSideMissed", "providerTtlMisses", "providerTtlMissed",
    "rewinds", "rewindMissed", "abortCorrelated", "clientInserts", "clientInsertMissed",
] as const;

function zeroAgg(overrides: Record<string, number> = {}): Record<string, number> {
    const agg: Record<string, number> = {};
    for (const k of AGG_KEYS) agg[k] = 0;
    return { ...agg, ...overrides };
}

function nudgeWith(bd: { system: number; tool: number; summaries: number; code: number; text: number; total: number; growth: number }): NudgeDecision {
    return { contextBreakdown: bd } as unknown as NudgeDecision;
}

function minimalSession(overrides?: { stats?: Record<string, unknown>; metadata?: Record<string, unknown> }): Session {
    return {
        id: "unit-session",
        stats: {
            contextTokens: 0,
            contextTokensSource: "estimate",
            lastUsageGradeTokens: 0,
            lastInputTokensSource: "estimate",
            lastInputTokens: 0,
            ...(overrides?.stats ?? {}),
        },
        metadata: { ...(overrides?.metadata ?? {}) },
        state: { blocks: [] },
    } as unknown as Session;
}

test("contextView: categories mirror the panel math and sum EXACTLY to sentTotal", () => {
    // system+tools measured by the host at prepare time (sysprompt row); the
    // kernel breakdown classifies messages only.
    const view = buildContextView({
        nudge: nudgeWith({ system: 100, tool: 2000, summaries: 300, code: 400, text: 500, total: 3300, growth: 1234 }),
        systemPromptTokens: 1200,
        limit: 100_000,
        session: minimalSession(),
    });
    assert.ok(view !== null, "view built");
    assert.equal(view.scale, "estimate");
    assert.equal(view.limit, 100_000);
    assert.equal(view.growth, 1234);
    assert.equal(view.sentTotal, 4500, "sentTotal = classified(3300) + sysprompt(1200)");
    const byKey = Object.fromEntries(view.categories.map((c) => [c.key, c]));
    assert.deepEqual(Object.keys(byKey), ["sysprompt", "tool", "text", "code", "summaries", "system"], "fixed category order, all present");
    assert.equal(byKey.sysprompt!.tokens, 1200);
    assert.equal(byKey.tool!.tokens, 2000);
    assert.equal(byKey.text!.tokens, 500);
    assert.equal(byKey.code!.tokens, 400);
    assert.equal(byKey.summaries!.tokens, 300);
    assert.equal(byKey.system!.tokens, 100);
    assert.equal(view.categories.reduce((n, c) => n + c.tokens, 0), view.sentTotal, "segments sum exactly to sentTotal");
    for (const c of view.categories) {
        assert.ok(c.pct >= 0 && c.pct <= 100, `pct in range for ${c.key}`);
        assert.equal(c.pct, Math.round((c.tokens / view.sentTotal) * 100), `pct rounding for ${c.key}`);
    }
    assert.deepEqual(view.folds, []);
    assert.deepEqual(view.switches, []);
    assert.equal(view.anchor, null, "no usage evidence yet ⇒ anchor null");
});

test("contextView: zero categories are omitted and sentTotal can be host-only", () => {
    const view = buildContextView({
        nudge: nudgeWith({ system: 0, tool: 0, summaries: 0, code: 0, text: 0, total: 0, growth: 0 }),
        systemPromptTokens: 900,
        limit: 0,
        session: minimalSession(),
    });
    assert.ok(view !== null);
    assert.equal(view.sentTotal, 900);
    assert.deepEqual(view.categories.map((c) => [c.key, c.tokens]), [["sysprompt", 900]]);
    assert.equal(view.categories[0]!.pct, 100);
    assert.equal(view.limit, null, "non-positive limit publishes null");
});

test("contextView: null before any breakdown exists", () => {
    assert.equal(buildContextView({ nudge: undefined, systemPromptTokens: 0, limit: 1, session: minimalSession() }), null);
});

test("contextView: anchor follows the displayContextBest ladder (usage > anchored estimate > upper)", () => {
    const base = {
        nudge: nudgeWith({ system: 0, tool: 10, summaries: 0, code: 0, text: 0, total: 10, growth: 0 }),
        systemPromptTokens: 0,
        limit: 100_000,
    };
    const usage = buildContextView({ ...base, session: minimalSession({ stats: { contextTokensSource: "usage", contextTokens: 7777 }, metadata: { contextTokensAt: 111 } }) });
    assert.deepEqual(usage?.anchor, { tokens: 7777, kind: "usage", at: 111 });
    const estimate = buildContextView({ ...base, session: minimalSession({ stats: { contextTokensSource: "estimate", lastUsageGradeTokens: 5000, contextEstimateTokens: 6000 } }) });
    assert.deepEqual(estimate?.anchor, { tokens: 6000, kind: "estimate", at: null });
    const upper = buildContextView({ ...base, session: minimalSession({ stats: { contextTokens: 9999, contextTokensSource: "estimate" } }) });
    assert.deepEqual(upper?.anchor, { tokens: 9999, kind: "upper", at: null });
});

test("contextView: fold and switch trails map the cache ledger (reclaimed/savedSoFar/paidBack math)", () => {
    const T0 = 1_700_000_000_000;
    const ledger = {
        v: 1,
        lastBlockId: 0,
        consumedFoldSeq: 0,
        sampleSeq: 2,
        foldSeqCounter: 1,
        folds: [{ seq: 1, at: T0, S: 5000, sigma: 200, T: 0, hPct: null, requestsAfter: 3, k: null }],
        lines: [
            { seq: 1, at: T0 - 1000, input: 1000, cached: 900, output: 50, hitPct: 90, missed: 100, nc: 0, cr: 0, tr: 0, foldSeq: null, model: "model-a" },
            { seq: 2, at: T0 - 500, input: 1000, cached: 0, output: 50, hitPct: 0, missed: 1000, nc: 0, cr: 0, tr: 1234, foldSeq: null, model: "model-b", sw: 1, cause: "model" },
        ],
        agg: zeroAgg({ switches: 1, switchMissed: 1234 }),
    };
    const view = buildContextView({
        nudge: nudgeWith({ system: 0, tool: 10, summaries: 0, code: 0, text: 0, total: 10, growth: 0 }),
        systemPromptTokens: 0,
        limit: 100_000,
        session: minimalSession({ metadata: { cacheLedger: ledger } }),
    });
    assert.ok(view !== null);
    assert.deepEqual(view.folds, [{ seq: 1, at: T0, s: 5000, sigma: 200, reclaimed: 4800, savedSoFar: 14400, paidBack: true }],
        "reclaimed=S−σ; savedSoFar=(S−σ)×requestsAfter; default price w1/r0.1/q4 ⇒ breakeven 0.625 ≤ 3 requests");
    assert.deepEqual(view.switches, [{ dim: "model", at: T0 - 500, from: "model-a", to: "model-b", attributed: 1234 }]);
});

interface Rig {
    proxyUrl: (path: string) => string;
    messagesUrl: () => string;
    closeAll(): Promise<void>;
}

function anthropicStream(): string {
    const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    return (
        sse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        sse("message_stop", { type: "message_stop" })
    );
}

async function startRig(): Promise<Rig> {
    const upstream = http.createServer((_req, res) => {
        _req.resume();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(anthropicStream());
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const closeOne = (s: http.Server): Promise<void> => new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
    return {
        proxyUrl: (path) => `http://127.0.0.1:${proxyPort}${path}`,
        messagesUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        closeAll: async () => {
            // undici keep-alive sockets outlive server.close() and would keep
            // the test process alive; drain them first (admin-origin pattern).
            proxy.closeAllConnections?.();
            upstream.closeAllConnections?.();
            await closeOne(proxy);
            await closeOne(upstream);
        },
    };
}

async function postTurn(rig: Rig, conversationId: string, text: string): Promise<void> {
    const res = await fetch(rig.messagesUrl(), {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": "test",
            "x-bili-plugin": "dsh",
            "x-bili-plugin-conversation": conversationId,
        },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, messages: [{ role: "user", content: text }] }),
    });
    assert.equal(res.status, 200, "plugin turn served");
    await res.body?.cancel().catch(() => {});
}

test("integration: plugin/status serves contextView after turns, additively, with CORS echo for trusted origins", async () => {
    const rig = await startRig();
    try {
        const reg = await fetch(rig.proxyUrl("/__bili/plugin/register"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "cv-test", agent: "dsh", identity: true }),
        });
        assert.equal(reg.status, 200, "register accepted");
        await postTurn(rig, "cv-test", "first turn");
        await postTurn(rig, "cv-test", "second turn");

        const res = await fetch(rig.proxyUrl("/__bili/plugin/status?conversationId=cv-test"));
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, any>;
        assert.equal(body.ok, true);

        // Additive regression: every pre-existing field still present.
        assert.equal(typeof body.sessionId, "string");
        assert.equal(body.contextLimit, 100_000);
        assert.equal(typeof body.contextTokens, "number");
        assert.equal(typeof body.contextTokensSource, "string");
        assert.equal(typeof body.panel, "string");
        assert.ok(Array.isArray(body.blocks));
        assert.ok(Array.isArray(body.compressibleRanges));

        const cv = body.contextView;
        assert.ok(cv !== null && typeof cv === "object", "contextView published after first request");
        assert.equal(cv.scale, "estimate");
        assert.equal(cv.limit, 100_000);
        assert.equal(typeof cv.at, "number");
        assert.ok(cv.sentTotal > 0, "sentTotal positive");
        assert.ok(Array.isArray(cv.categories) && cv.categories.length > 0);
        assert.equal(cv.categories.reduce((n: number, c: any) => n + c.tokens, 0), cv.sentTotal, "segments sum exactly to sentTotal");
        for (const c of cv.categories) {
            assert.equal(typeof c.key, "string");
            assert.ok(Number.isFinite(c.tokens) && c.tokens > 0);
            assert.ok(c.pct >= 0 && c.pct <= 100);
        }
        assert.ok(Number.isFinite(cv.growth), "growth is signed (tokenCount − reference); no sign assumption");
        assert.ok(Array.isArray(cv.folds));
        assert.ok(Array.isArray(cv.switches));
        if (cv.anchor !== null) {
            assert.ok(["usage", "estimate", "upper"].includes(cv.anchor.kind), "anchor kind on its own scale label");
            assert.ok(cv.anchor.tokens > 0);
        }

        // CORS: a cross-origin browser reader (the dsh client tab) must be
        // able to READ this response — the gate-trusted loopback origin is
        // echoed back.
        // Close only AFTER listening resolved: calling close() on a still-
        // pending listen suppresses the 'listening' event forever.
        const foreignPort = await new Promise<number>((resolve, reject) => {
            const s = http.createServer(() => {});
            s.once("error", reject);
            s.listen(0, "127.0.0.1", () => {
                const port = (s.address() as { port: number }).port;
                s.close(() => resolve(port));
            });
        });
        const corsRes = await fetch(rig.proxyUrl("/__bili/plugin/status?conversationId=cv-test"), {
            headers: { origin: `http://127.0.0.1:${foreignPort}` },
        });
        assert.equal(corsRes.status, 200, "trusted loopback origin admitted");
        assert.equal(corsRes.headers.get("access-control-allow-origin"), `http://127.0.0.1:${foreignPort}`, "origin echoed for the browser read");
        await corsRes.body?.cancel().catch(() => {});

        // Untrusted origin stays denied by the existing gate — the echo never
        // widens access.
        const denied = await fetch(rig.proxyUrl("/__bili/plugin/status?conversationId=cv-test"), {
            headers: { origin: "http://example.com" },
        });
        assert.equal(denied.status, 403, "untrusted origin rejected");
        const deniedBody = (await denied.json()) as { error?: string };
        assert.ok(deniedBody.error !== undefined);
        await denied.body?.cancel().catch(() => {});
    } finally {
        await rig.closeAll();
    }
});
