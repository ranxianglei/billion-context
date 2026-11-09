import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { type ProxyOptions } from "../src/config.ts";
import { preflightCompress, estimateCoreMessagesUpper } from "../src/preflight.ts";
import { preflightCompressIfNeeded, registerRequestAbort, type Prepared } from "../src/server.ts";
import { forward } from "../src/server/relay.ts";
import { getSession } from "../src/session.ts";
import { parseExternalSummarySettings } from "../src/external-summary-settings.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));
const SUMMARY = "SUMMARY: preserve the task goal, exact acceptance criteria and next step; the repeated fixture output is disposable.";

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0);
    _resetFetchUtilForTest();
});

async function withUpstream(run: (url: string, mainCalls: () => number) => Promise<void>) {
    let mainCalls = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean };
            if (body.stream) mainCalls++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: SUMMARY }] }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
        await run(`http://127.0.0.1:${address.port}/responses`, () => mainCalls);
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeIdleConnections?.();
        server.closeAllConnections();
        await closed;
    }
}

function fixture(url: string, window = 6000) {
    const session = getSession(`client-abort-${randomUUID()}`);
    const core = createCore();
    const config = defaultConfig(window, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(4000) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    const prepared: Prepared = {
        body: JSON.stringify({ model: "test-model", stream: true, input: messages.map(m => ({ role: m.role, content: m.text })) }),
        session, processedMessages: messages, originalMessages: messages,
        protocol: "responses", stream: true, compressInjected: false,
    };
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = url;
    req.headers = { "content-type": "application/json" };
    const res = new http.ServerResponse(req);
    const opts: ProxyOptions = {
        host: "127.0.0.1", port: 0, upstream: url, routes: {},
        proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: window, kernelConfig: config,
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, compat: { roles: {} },
        streamErrorShape: "protocol", sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
    };
    const logs: string[] = [];
    const log = (_level: string, message: string) => { logs.push(message); };
    return { session, core, config, messages, prepared, req, res, opts, log, logs };
}

type Fixture = ReturnType<typeof fixture>;
function rebuild(f: Fixture): Prepared {
    const turn = f.core.processTurn({ messages: f.messages, state: f.session.state, config: f.config,
        tokenCount: f.session.stats.lastInputTokens, renderTags: "text-only" });
    f.session.stats.requests++;
    return { ...f.prepared, processedMessages: turn.messages,
        body: JSON.stringify({ model: "test-model", stream: true, input: turn.messages.map(m => ({ role: m.role, content: m.text })) }),
    };
}

function gate(f: Fixture, rebuild: () => Promise<Prepared>) {
    return preflightCompressIfNeeded(f.prepared, rebuild, f.req, Buffer.from(f.prepared.body), f.res,
        f.opts, f.core, f.config, f.config.modelContextLimit, "test-model", undefined, undefined, undefined, undefined, false, f.log, "abort-test");
}

test("preflight keeps cancellation after an applied fold makes the final payload fit", async () => {
    await withUpstream(async url => {
        const f = fixture(url);
        const ac = new AbortController();
        const processTurn = f.core.processTurn.bind(f.core);
        f.core.processTurn = params => {
            const turn = processTurn(params);
            // 在真实摘要应用后的最终窗口检查时取消。
            if (params.config.modelContextLimit === 600_000 && f.session.state.blocks.length > 0 && estimateCoreMessagesUpper(turn.messages) < 6000) ac.abort();
            return turn;
        };
        const result = await preflightCompress({ core: f.core, session: f.session, config: f.config,
            prompts: defaultPrompts, protocol: "responses", url, headers: {}, model: "test-model",
            signal: ac.signal, log: f.log }, f.messages);
        assert.ok(result.compressedRanges > 0);
        assert.equal(ac.signal.aborted, true);
        assert.equal(result.fitsWindow, true, JSON.stringify({ result, logs: f.logs }));
        assert.equal(result.failure?.kind, "aborted");
        assert.ok(JSON.stringify(f.session.state.blocks).includes(SUMMARY), "completed folds survive cancellation");
    });
});

for (const pluginMode of [false, true]) {
    test(`cancel during a fitting rebuild prevents main forwarding (plugin=${pluginMode})`, { timeout: 10_000 }, async () => {
        await withUpstream(async (url, mainCalls) => {
            const f = fixture(url);
            f.prepared.pluginMode = pluginMode;
            let ready!: () => void;
            const readyPromise = new Promise<void>(resolve => { ready = resolve; });
            let complete!: (result: Awaited<ReturnType<typeof gate>>) => void;
            let fail!: (error: unknown) => void;
            const completedPromise = new Promise<Awaited<ReturnType<typeof gate>>>((resolve, reject) => { complete = resolve; fail = reject; });
            const downstream = http.createServer((req, res) => {
                req.resume();
                f.req = req;
                f.req.url = url;
                f.res = res;
                gate(f, async () => {
                    const closed = once(res, "close");
                    ready();
                    await closed;
                    return rebuild(f);
                }).then(complete, fail);
            });
            downstream.listen(0, "127.0.0.1");
            await once(downstream, "listening");
            const address = downstream.address();
            assert.ok(address && typeof address === "object");
            const client = http.request({ host: "127.0.0.1", port: address.port, method: "POST" });
            client.on("error", () => {}); // 主动断开产生的 ECONNRESET 是本用例的预期行为。
            client.end();
            try {
                await Promise.race([readyPromise, completedPromise.then(() => assert.fail("rebuild was not reached"))]);
                client.destroy();
                const result = await completedPromise;
                assert.ok("failFast" in result, "a fitting payload must not erase cancellation");
                assert.equal(result.respond, false);
                assert.equal(result.retryable, false);
                assert.ok(f.session.state.blocks.length > 0);
                assert.equal(mainCalls(), 0);
            } finally {
                client.destroy();
                const closed = once(downstream, "close");
                downstream.close();
                downstream.closeIdleConnections?.();
                downstream.closeAllConnections();
                await closed;
            }
        });
    });
}

test("cancelled growth auto-fold stops before fail-open forwarding and backoff", async () => {
    await withUpstream(async (url, mainCalls) => {
        const f = fixture(url, 50_000);
        // #3444 benefit gate: the growth arm needs decisionTrigger − target ≥
        // AUTO_FOLD_MIN_BENEFIT_TOKENS (4096) — 10_000 vs 8192 left only 1808,
        // so the trigger silently disarmed after 30ae2188a. 20_000 re-arms it.
        f.session.stats.lastInputTokens = 20_000;
        f.session.stats.lastInputTokensSource = "usage";
        Object.assign(f.config, { externalSummary: parseExternalSummarySettings({
            enabled: true, autoFold: true, autoFoldTargetTokens: 8192,
            targets: [{ name: "sum", protocol: "responses", url, model: "test-model", apiKey: "fixture-key" }],
        }, { inlineKeys: true }) });
        f.prepared.nudge = f.core.processTurn({ messages: f.messages, state: f.session.state,
            config: f.config, tokenCount: 20_000, renderTags: "text-only" }).nudge;
        assert.ok(f.prepared.nudge?.compressibleRanges.length);
        const processTurn = f.core.processTurn.bind(f.core);
        f.core.processTurn = params => {
            const turn = processTurn(params);
            f.res.emit("close");
            return turn;
        };
        const result = await gate(f, async () => assert.fail("cancelled zero-progress fold must not rebuild"));
        assert.ok(f.logs.some(message => message.includes("auto-fold growth floor")), JSON.stringify(f.logs));
        assert.ok("failFast" in result, "cancellation must override growth fail-open");
        assert.equal(result.respond, false);
        assert.equal(result.retryable, false);
        assert.equal(mainCalls(), 0);
        assert.equal(f.session.metadata.autoFoldBackoffUntil, undefined, "cancellation is not a summary-service failure");
    });
});

test("live fitting rebuild forwards exactly once and retains its summary", async () => {
    await withUpstream(async (url, mainCalls) => {
        const f = fixture(url);
        const result = await gate(f, async () => rebuild(f));
        assert.ok(!("failFast" in result));
        assert.ok(result.body.toString().includes(SUMMARY));
        await forward(f.req, f.res, f.opts, result.body, result, f.core, f.config, f.log, undefined, "abort-test");
        assert.equal(mainCalls(), 1);
        assert.ok(JSON.stringify(f.session.state.blocks).includes(SUMMARY));
    });
});

test("relay rejects a response already closed before it registers the abort listener", async () => {
    await withUpstream(async (url, mainCalls) => {
        const f = fixture(url);
        f.res.destroy();
        f.res.emit("close");
        await forward(f.req, f.res, f.opts, f.prepared.body, null, f.core, f.config, f.log, undefined, "abort-test");
        assert.equal(mainCalls(), 0, "the main fetch must start with an aborted signal");
    });
});

test("request abort handoff inherits a watchdog cancellation before response end", () => {
    const req = new http.IncomingMessage(new net.Socket());
    const res = new http.ServerResponse(req);
    const old = new AbortController();
    registerRequestAbort(res, old);
    old.abort();
    assert.equal(res.writableEnded, false);
    const next = new AbortController();
    registerRequestAbort(res, next);
    assert.equal(next.signal.aborted, true);
});

test("preflight preserves an existing aborted failure even when its input already fits", async () => {
    await withUpstream(async (url, mainCalls) => {
        const f = fixture(url);
        const ac = new AbortController();
        ac.abort();
        const result = await preflightCompress({ core: f.core, session: f.session, config: f.config,
            prompts: defaultPrompts, protocol: "responses", url, headers: {}, model: "test-model",
            signal: ac.signal, log: f.log }, [f.messages[0]]);
        assert.equal(result.fitsWindow, true);
        assert.equal(result.failure?.kind, "aborted");
        assert.equal(mainCalls(), 0);
    });
});

test("request abort registration keeps a live response usable and rejects an ended response", () => {
    const req = new http.IncomingMessage(new net.Socket());
    const res = new http.ServerResponse(req);
    const live = new AbortController();
    registerRequestAbort(res, live);
    assert.equal(live.signal.aborted, false);
    res.end();
    const ended = new AbortController();
    registerRequestAbort(res, ended);
    assert.equal(ended.signal.aborted, true);
});
