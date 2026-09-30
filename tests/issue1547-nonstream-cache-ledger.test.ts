import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";
import { buildSessionCacheReport, getCacheLedger, settleUsageReport } from "../src/cache-ledger.ts";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("issue #1547: non-streaming rewriter turns settle into the cache ledger", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let turn = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            turn += 1;
            const usage =
                turn === 1
                    ? { prompt_tokens: 2000, completion_tokens: 50, total_tokens: 2050, prompt_tokens_details: { cached_tokens: 1800 } }
                    : { prompt_tokens: 0, completion_tokens: 5, total_tokens: 5 };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    id: `chatcmpl-${turn}`,
                    object: "chat.completion",
                    created: 123,
                    model: "gpt-test",
                    choices: [{ index: 0, message: { role: "assistant", content: `hi ${turn}` }, finish_reason: "stop" }],
                    usage,
                }),
            );
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const sessionId = "issue-1547-nonstream";
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const post = (): Promise<Response> =>
        fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            body: JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });

    try {
        const resp1 = await post();
        assert.equal(resp1.status, 200);
        const body1 = (await resp1.json()) as { choices?: { message?: { content?: string } }[] };
        assert.equal(body1.choices?.[0]?.message?.content, "hi 1");

        const s = getSession(sessionId);
        assert.equal(s.stats.inputTokens, 2000);
        assert.equal(s.stats.cachedTokens, 1800);
        assert.equal(s.stats.cacheSamples, 1);
        assert.equal(s.stats.lastInputTokens, 2000);
        assert.equal(s.stats.lastInputTokensSource, "usage");
        assert.equal(s.stats.outputTokens, 50);

        const report = buildSessionCacheReport(s);
        assert.equal(report.totals.requests, 1);
        assert.equal(report.totals.input, 2000);
        assert.equal(report.totals.cached, 1800);
        assert.equal(report.lines.length, 1);
        assert.equal(report.lines[0]!.input, 2000);
        assert.equal(report.lines[0]!.cached, 1800);
        assert.equal(report.lines[0]!.hitPct, 90);

        const led = getCacheLedger(s);
        assert.equal(led.lines.length, 1);
        assert.equal(led.lines[0]!.proto, "openai");
        assert.equal(led.lines[0]!.up, `http://127.0.0.1:${upstreamPort}`);

        const rep = await fetch(`http://127.0.0.1:${proxyPort}/__bili/cache-report?session=${sessionId}`);
        assert.equal(rep.status, 200);
        const repBody = (await rep.json()) as { reports?: { id: string; report: string }[] };
        assert.equal(repBody.reports?.length, 1);
        assert.ok((repBody.reports?.[0]?.report ?? "").length > 0);

        const resp2 = await post();
        assert.equal(resp2.status, 200);
        const s2 = getSession(sessionId);
        assert.equal(s2.stats.lastInputTokens, 2000, "zero-total report must keep lastInputTokens (#793 parity)");
        assert.equal(s2.stats.lastInputTokensSource, "usage");
        assert.equal(s2.stats.cacheSamples, 1);
        assert.equal(s2.stats.outputTokens, 55);
        assert.equal(buildSessionCacheReport(s2).totals.requests, 1, "zero-total report records no ledger sample");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

function makeSession(): Session {
    return {
        id: "issue-1547-unit",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("settleUsageReport: updates stats and records an attributed ledger sample", () => {
    const s = makeSession();
    settleUsageReport(s, { total: 2000, reportedCached: 1800, output: 50, protocol: "openai", upstream: "http://up.test" });
    assert.equal(s.stats.inputTokens, 2000);
    assert.equal(s.stats.cachedTokens, 1800);
    assert.equal(s.stats.cacheSamples, 1);
    assert.equal(s.stats.lastInputTokens, 2000);
    assert.equal(s.stats.lastInputTokensSource, "usage");
    const led = getCacheLedger(s);
    assert.equal(led.lines.length, 1);
    assert.equal(led.lines[0]!.input, 2000);
    assert.equal(led.lines[0]!.cached, 1800);
    assert.equal(led.lines[0]!.hitPct, 90);
    assert.equal(led.lines[0]!.proto, "openai");
    assert.equal(led.lines[0]!.up, "http://up.test");
    assert.equal(led.agg.requests, 1);
});

test("settleUsageReport: compress credit nets out of lastInputTokens; null-cache quarantines", () => {
    const s = makeSession();
    s.stats.compressCreditTokens = 300;
    s.stats.overflowArmTokens = 123_456;
    settleUsageReport(s, { total: 2000, reportedCached: null });
    assert.equal(s.stats.lastInputTokens, 1700);
    assert.equal(s.stats.overflowArmTokens, undefined);
    assert.equal(s.stats.cacheSamples, 0);
    assert.equal(s.stats.cachedTokens, 0);
    const led = getCacheLedger(s);
    assert.equal(led.lines.length, 1);
    assert.equal(led.lines[0]!.unk, 1);
    assert.equal(led.agg.unknownSamples, 1);
    assert.equal(led.agg.unknownInput, 2000);
});

test("settleUsageReport: zero-total sample must not clobber the last trusted value", () => {
    const s = makeSession();
    settleUsageReport(s, { total: 5000, reportedCached: 4000 });
    s.stats.overflowArmTokens = 777;
    settleUsageReport(s, { total: 0, reportedCached: null });
    assert.equal(s.stats.lastInputTokens, 5000);
    assert.equal(s.stats.lastInputTokensSource, "usage");
    assert.equal(s.stats.overflowArmTokens, 777);
    assert.equal(s.stats.cacheSamples, 1);
    const led = getCacheLedger(s);
    assert.equal(led.lines.length, 2);
    assert.equal(led.lines[0]!.input, 5000);
    assert.equal(led.lines[1]!.input, 0);
});
