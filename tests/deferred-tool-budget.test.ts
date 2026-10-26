import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";
import { startServer } from "../src/server.ts";
import { normalizeUpstreamOrigin } from "../src/util.ts";
import { clampOutgoingOutput, countLoadedToolTokens, countSystemAndToolsTokens, estimateInputTokens, estimateWireOverhead, modelVisibleTools } from "../src/server/budget.ts";

// #4185: an identified fresh session whose preflight ends in deterministic
// exhaustion now forwards once for upstream arbitration instead of failing
// fast locally. These pins assert the LOCAL stop-before-forward contract, so
// they carry a settled usage baseline to keep testing the evidence-driven path.
function seedEvidence(upstreamPort: number, sessionId: string): void {
    const s = getSession(sessionId);
    s.stats.lastInputTokens = 100;
    s.stats.lastInputTokensSource = "usage";
    s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${upstreamPort}`);
}

const deferred = {
    type: "function", name: "large_schema", description: "x".repeat(1_200_000),
    parameters: { type: "object", properties: {} }, defer_loading: true,
};
const search = { type: "tool_search" };
const tools = [deferred, search];

test("#2391: deferred Responses schemas do not consume the visible tool budget", () => {
    const body = { instructions: "SHORT", tools, input: [{ type: "message", role: "user", content: "hello" }] };
    const before = JSON.stringify(body);
    assert.ok(defaultCountTokens(JSON.stringify(tools)) > 272_000);
    assert.ok(countSystemAndToolsTokens(body.instructions, tools) < 100);
    assert.ok(estimateWireOverhead("responses", before) < 100);
    assert.equal(JSON.stringify(body), before, "budget projection must not mutate the forwarded catalog");
    assert.ok(countSystemAndToolsTokens(body.instructions, [deferred]) > 272_000, "without tool search, retain the full schema");
    assert.ok(countSystemAndToolsTokens(body.instructions, [{ ...deferred, defer_loading: false }, search]) > 272_000);
});

test("#2391: namespace descriptions and eager members remain visible; flags are not inherited", () => {
    const inherited = { type: "function", name: "eager", description: "e".repeat(4000), parameters: { type: "object" } };
    const namespace = { type: "namespace", name: "workspace", description: "n".repeat(4000), defer_loading: true, tools: [deferred, inherited] };
    const original = [namespace, search];
    assert.deepEqual(modelVisibleTools(original), [{ ...namespace, tools: [
        { type: "function", name: deferred.name, defer_loading: true }, inherited,
    ] }, search]);
    assert.ok(countSystemAndToolsTokens("", original) >= 2000);
    assert.equal(namespace.tools[0].description, deferred.description);
});

test("#2391: unknown flags, tool kinds, malformed schemas and Chat Completions stay conservative", () => {
    const cases = [
        { ...deferred, defer_loading: "true" },
        { ...deferred, type: "custom" },
        { ...deferred, name: undefined },
        { ...deferred, parameters: [] },
        { ...deferred, parameters: null },
        { type: "function", function: { name: "chat", description: deferred.description, parameters: {} }, defer_loading: true },
    ];
    for (const candidate of cases) {
        const catalog = [candidate, search];
        assert.deepEqual(modelVisibleTools(catalog), catalog);
        assert.ok(countSystemAndToolsTokens("", catalog) > 272_000);
    }
    const chat = { messages: [], tools };
    assert.equal(estimateWireOverhead("openai", JSON.stringify(chat)), defaultCountTokens(JSON.stringify(tools)));
});

test("#2391: loaded records count in full even when the definitions still say deferred", () => {
    for (const type of ["additional_tools", "tool_search_call", "tool_search_output", "mcp_list_tools"]) {
        const loaded = { type, tools: [deferred], call_id: "loaded" };
        const body = { instructions: "SHORT", tools, input: [loaded] };
        const before = JSON.stringify(body);
        const loadedTokens = defaultCountTokens(JSON.stringify(loaded));
        assert.equal(countLoadedToolTokens(body), loadedTokens);
        assert.equal(estimateWireOverhead("responses", before), countSystemAndToolsTokens(body.instructions, tools) + loadedTokens);
        assert.ok(estimateWireOverhead("responses", before) > 272_000);
        assert.equal(JSON.stringify(body), before);
    }
    assert.equal(countLoadedToolTokens({ input: [] }), 0);
    assert.equal(countLoadedToolTokens({ input: "hello" }), 0);
});

test("#2391: usage remains authoritative; loaded definitions enter calibration before the max", () => {
    const visible = countSystemAndToolsTokens("", tools);
    assert.equal(estimateInputTokens([], "", tools, 300_000, "usage"), 300_000);
    assert.equal(estimateInputTokens([], "", tools, 300_000, "estimate"), visible);
    assert.equal(estimateInputTokens([], "", tools, 250_000, "usage", undefined, undefined, undefined, 100_000), 250_000);
    assert.equal(estimateInputTokens([], "", tools, 0, "estimate", 0.5, "fixture", "fixture", 100_000), (visible + 100_000) * 0.5);
});

test("#2391: output headroom includes loaded schemas without adding them again to usage", () => {
    const loaded = { ...deferred, description: "l".repeat(780_000) };
    const body = { tools, input: [{ type: "additional_tools", tools: [loaded] }], max_output_tokens: 100_000 };
    const context = { processedMessages: [], systemText: "", tools, lastInputTokens: 0, imageTokens: 0, nativeWindow: 272_000 };
    clampOutgoingOutput(body, "max_output_tokens", context, "fixture", () => {});
    assert.ok(body.max_output_tokens < 100_000 && body.max_output_tokens > 60_000);
    const usageBody = { ...body, max_output_tokens: 100_000 };
    clampOutgoingOutput(usageBody, "max_output_tokens", { ...context, lastInputTokens: 200_000, lastInputTokensSource: "usage" }, "fixture", () => {});
    assert.equal(usageBody.max_output_tokens, 62_000);
});

test("#2391: a 272k Responses proxy forwards the full deferred catalog and rejects eager/loaded overflow", async () => {
    const received: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${upstreamPort}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer({
            port: 0, host: "127.0.0.1", upstream: origin,
            routes: { [origin]: { proxy: "", models: { "fixture-gpt": { context: 272_000, compress: { modelContextLimit: 272_000 } } } } },
            modelContextLimit: 272_000, kernelConfig: defaultConfig(272_000),
            compress: { injectTool: false, injectNudge: false }, promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
            passthroughSource: null, autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
            advisoryCheck: false, releaseNotesCheck: false, compat: { roles: {} },
            streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
        } as ProxyOptions);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const body = { model: "fixture-gpt", stream: false, tools, max_output_tokens: 68_000,
            input: [{ type: "message", role: "user", content: "hello" }] };
        const send = (payload: unknown, session: string) => fetch(`http://127.0.0.1:${proxyPort}/bili/${origin}/v1/responses`, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": session }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
        });
        const accepted = await send(body, "2391-deferred");
        assert.equal(accepted.status, 200, await accepted.text());
        assert.equal(received.length, 1);
        assert.deepEqual(received[0].tools, tools, "full upstream definitions must stay unchanged");
        seedEvidence(upstreamPort, "2391-eager");
        const eager = await send({ ...body, tools: [{ ...deferred, defer_loading: false }, search] }, "2391-eager");
        assert.notEqual(eager.status, 200, await eager.text());
        assert.equal(received.length, 1, "eager overflow must be stopped before forwarding");
        seedEvidence(upstreamPort, "2391-loaded");
        const loaded = await send({ ...body, input: [{ type: "additional_tools", tools: [deferred] }, ...body.input] }, "2391-loaded");
        assert.notEqual(loaded.status, 200, await loaded.text());
        assert.equal(received.length, 1, "loaded overflow must be stopped before forwarding");
        const small = { ...deferred, description: "small loaded definition" };
        const loadedItems = [
            { type: "additional_tools", tools: [small] },
            { type: "tool_search_call", call_id: "search_1", arguments: { goal: "large_schema" }, execution: "client" },
            { type: "tool_search_output", call_id: "search_1", tools: [small], execution: "client" },
        ];
        const loadedSmall = await send({ ...body, input: [...loadedItems, ...body.input] }, "2391-loaded-small");
        assert.equal(loadedSmall.status, 200, await loadedSmall.text());
        const forwardedInput = received.at(-1)?.input as Record<string, unknown>[];
        assert.deepEqual(forwardedInput.filter((item) => ["additional_tools", "tool_search_call", "tool_search_output"].includes(String(item.type))), loadedItems);
        assert.equal(forwardedInput[0].type, "additional_tools", "leading loaded definitions must retain their position");
    } finally {
        proxy?.closeAllConnections();
        const closingProxy = proxy;
        if (closingProxy) await new Promise<void>((resolve) => closingProxy.close(() => resolve()));
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
});
