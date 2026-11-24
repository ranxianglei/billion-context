import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { createSession, listSessions, _resetSessionsForTest } from "../src/session.ts";
import { preflightCompress, estimateRawBodyTokens, type PreflightDeps } from "../src/preflight.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const SUMMARY = "Historical decisions, completed investigation, and the accepted constraints are preserved. Continue the current task with these findings.";
const WINDOW = 1_100_000;

for (const pluginMode of [false, true]) {
    test(`Responses wire mass triggers preflight and shrinks with its projection (plugin=${pluginMode})`, async () => {
        _setStoreForTest(new SessionStore({ enabled: false }));
        _resetSessionsForTest();
        setRegistryForTest({});
        const logs: string[] = [];
        setLogCapture((_level, message) => {
            if (message.includes("preflight")) logs.push(message);
        });
        const forwards: Array<Record<string, unknown>> = [];
        let summaries = 0;
        const upstream = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", chunk => chunks.push(chunk));
            request.on("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (body.stream === false) {
                    summaries++;
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(JSON.stringify({ output_text: SUMMARY }));
                    return;
                }
                forwards.push(body);
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.end(`data: ${JSON.stringify({
                    type: "response.completed",
                    response: { id: `response-${forwards.length}`, status: "completed", output: [],
                        usage: { input_tokens: 1000, output_tokens: 3, total_tokens: 1003 } },
                })}\n\ndata: [DONE]\n\n`);
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const address = upstream.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const config = defaultConfig(WINDOW, {
            preserveRecentMessages: 2, preserveRecentTokens: 500,
            compress: { minCompressRange: 100, minSummaryLength: 50, maxSummaryLength: 20000 },
        });
        const options: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: origin,
            routes: { [origin]: { models: { fixture: { context: WINDOW } } } },
            modelContextLimit: WINDOW, kernelConfig: config,
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: true, debug: false, passthrough: false, passthroughSource: null,
            autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
            advisoryCheck: false, releaseNotesCheck: false, compat: { roles: {} },
            streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
        };
        const proxy = await startServer(options);
        await once(proxy, "listening");
        const proxyAddress = proxy.address();
        assert.ok(proxyAddress && typeof proxyAddress !== "string");
        const url = `http://127.0.0.1:${proxyAddress.port}/bili/${origin}/responses`;
        const headers = { "content-type": "application/json",
            "x-acp-session": `wire-${pluginMode}`,
            ...(pluginMode ? { "x-bili-plugin": "1" } : {}) };
        const post = async (input: unknown[], tools?: unknown[]) => {
            const response = await fetch(url, { method: "POST", headers,
                body: JSON.stringify({ model: "fixture", stream: true, input, tools }) });
            return { status: response.status, text: await response.text() };
        };
        try {
            const seed = [{ type: "message", role: "user", content: "Begin the wire accounting fixture." }];
            assert.equal((await post(seed)).status, 200);
            assert.equal(summaries, 0);
            const session = listSessions().find(value => value.meta.label === `wire-${pluginMode}`);
            assert.ok(session);
            session.stats.lastInputTokens = 10_000;
            session.stats.lastInputTokensSource = "usage";
            session.stats.lastInputTokensOrigin = origin;
            forwards.length = 0;
            const input: Array<Record<string, unknown>> = [...seed];
            const opaque = new Map<string, string>();
            for (let index = 0; index < 70; index++) {
                const id = `reasoning-${index}`;
                const encrypted = `${index}-` + "Q".repeat(70_000);
                opaque.set(id, encrypted);
                input.push({ type: "message", role: "user",
                    content: `Turn ${index}. ` + "Historical evidence and accepted constraints. ".repeat(40) });
                input.push({ type: "reasoning", id, encrypted_content: encrypted, summary: [] });
                input.push({ type: "message", role: "assistant", content: `Completed investigation ${index}.` });
            }
            input.push({ type: "message", role: "user", content: "Continue with the established decisions." });
            assert.ok(estimateRawBodyTokens({ input }) > WINDOW);
            const result = await post(input);
            assert.equal(result.status, 200, result.text + "\n" + logs.join("\n"));
            assert.ok(summaries > 0);
            assert.equal(forwards.length, 1);
            const forwarded = forwards[0]!;
            assert.ok(estimateRawBodyTokens(forwarded) < WINDOW);
            for (const item of forwarded.input as Array<Record<string, unknown>>) {
                if (item.type === "reasoning") assert.equal(item.encrypted_content, opaque.get(String(item.id)));
            }
            assert.ok(session.state.blocks.length > 0);
            const beforeContinuation = summaries;
            assert.equal((await post([...input, { type: "message", role: "user", content: "One more ordinary turn." }])).status, 200);
            assert.equal(summaries, beforeContinuation);
            forwards.length = 0;
            // #7537: an unfoldable over-window body is no longer doomed on
            // bili's own measurement — it forwards; the upstream is the size
            // authority (this mock accepts → 200).
            assert.equal((await post([{ type: "message", role: "user", content: "A".repeat(4_600_000) }])).status, 200);
            assert.equal(forwards.length, 1);
            forwards.length = 0;
            assert.equal((await post(seed, [{ type: "function", name: "oversized",
                description: "D".repeat(4_600_000), parameters: { type: "object" } }])).status, 200);
            assert.equal(forwards.length, 1);
        } finally {
            setLogCapture(null);
            proxy.close(); proxy.closeAllConnections();
            upstream.close(); upstream.closeAllConnections();
        }
    });
}

test("wire projection savings remain foldable while epoch confirmation is pending", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const core = createCore();
    const messages: CoreMessage[] = Array.from({ length: 24 }, (_, index) => ({
        id: `wire-message-${index}`, role: index % 2 ? "assistant" : "user", contentType: "text",
        text: `Evidence ${index}. ` + "Retain the accepted findings and concrete constraints. ".repeat(20),
    }));
    const originalIds = new Set(messages.map(message => message.id));
    const config = defaultConfig(100_000, {
        preserveRecentMessages: 0, preserveRecentTokens: 0,
        compress: { minCompressRange: 100, minSummaryLength: 50, maxSummaryLength: 20000 },
    });
    const session = createSession("wire-futility");
    session.stats.requests = 1;
    session.stats.lastInputTokens = 10_000;
    session.metadata.foldEpochConfirmPending = true;
    session.state = core.processTurn({ messages, state: session.state, config,
        tokenCount: 200_000, renderTags: "text-only" }).state;
    let calls = 0;
    const upstream = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
            calls++;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ output_text: SUMMARY }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    try {
        const measureWireTokens = (view: CoreMessage[]) => view.reduce((sum, message) =>
            sum + (originalIds.has(message.id) ? 15_000 : 100), 0);
        const deps: PreflightDeps = {
            core, session, config, prompts: defaultPrompts, protocol: "responses",
            url: `http://127.0.0.1:${address.port}`, model: "fixture", headers: {},
            measureWireTokens, log: () => {},
        };
        const paused = await preflightCompress({ ...deps, measureWireTokens: () => 10_000 }, messages);
        assert.equal(paused.fitsWindow, true);
        assert.equal(calls, 0);
        const result = await preflightCompress(deps, messages);
        assert.ok(calls > 0);
        assert.ok(result.compressedRanges > 0);
        assert.equal(result.fitsWindow, true);
        assert.equal(result.failure, undefined);
        assert.ok(session.state.blocks.every(block => block.summary === SUMMARY));
    } finally {
        upstream.close(); upstream.closeAllConnections();
    }
});
