// #3522: a pending MCP registration must never bind a native-wire request,
// and Codex's Responses namespace declaration ({type:"namespace",
// name:"mcp__bili", tools:[bare names]}) must count as an MCP-lane
// declaration — otherwise the #3510 eligibility gate would make genuine
// codex+MCP sessions unable to claim their own registration.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { ProxyOptions } from "../src/config.ts";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer } from "../src/server.ts";
import { declaresMcpBiliToolsOnWire } from "../src/session-self-heal.ts";
import { queuePluginRegister, takePendingPluginRegister, _resetPluginStateForTest } from "../src/plugin.ts";
import { peekSession } from "../src/session.ts";
import { PROXY_TOOL_NAMES } from "../src/compress-tool.ts";

const codexNamespace = (members: unknown[]) => ({
    type: "namespace", name: "mcp__bili", description: "Tools in the mcp__bili namespace.", tools: members,
});

test("#3522: the MCP-lane detector recognizes both wire forms of the bili MCP server", () => {
    const positives = [
        { tools: [{ name: "mcp__bili__compress" }] },
        { tools: [{ type: "function", function: { name: "mcp__bili__acp_status" } }] },
        { tools: [{ functionDeclarations: [{ name: "mcp__bili__decompress" }] }] },
        { tools: [codexNamespace([{ type: "function", name: "compress", parameters: {} }])] },
        { tools: [codexNamespace([{ type: "function", name: "compress", defer_loading: true, parameters: {} }]), { type: "tool_search" }] },
        { tools: [{ type: "function", name: "exec_command", parameters: {} }, codexNamespace([{ type: "function", name: "acp_status", parameters: {} }])] },
        { tools: [{ tools: [{ tools: [{ name: "mcp__bili__x" }] }] }] },
    ];
    for (const body of positives) assert.equal(declaresMcpBiliToolsOnWire(body), true, `expected MCP-lane: ${JSON.stringify(body)}`);

    const negatives = [
        {},
        null,
        "nope",
        42,
        { tools: [] },
        { tools: "not-an-array" },
        { tools: [null, 7, "str", { name: null }, { name: 123 }] },
        { tools: [{ name: "compress" }] },
        { tools: [{ type: "function", function: { name: "acp_status" } }] },
        { tools: [{ name: "mcp__bilibili__play" }] },
        { tools: [{ type: "namespace", name: "mcp__bilibili", tools: [{ type: "function", name: "play", parameters: {} }] }] },
        { tools: [{ type: "namespace", name: "mcp__codebase_memory", tools: [{ type: "function", name: "search_code", parameters: {} }] }] },
    ];
    for (const body of negatives) assert.equal(declaresMcpBiliToolsOnWire(body), false, `must stay non-MCP: ${JSON.stringify(body)}`);

    let deep: Record<string, unknown> = { name: "mcp__bili__x" };
    for (let i = 0; i < 10; i++) deep = { tools: [deep] };
    assert.equal(declaresMcpBiliToolsOnWire(deep), false, "the walk must stop at its depth cap");
});

test("#3522: a native request keeps wire injection and leaves the MCP registration pending; the codex-namespace request claims it", async () => {
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
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    queuePluginRegister("conv-mcp-3522", "mcp", false);
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer({
            port: 0, host: "127.0.0.1", upstream: origin,
            routes: { [origin]: { proxy: "", models: { "fixture-gpt": { context: 200_000, compress: { modelContextLimit: 200_000 } } } } },
            modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
            compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
            passthroughSource: null, autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
            advisoryCheck: false, releaseNotesCheck: false, compat: { roles: {} },
            streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
        } as ProxyOptions);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const send = (payload: unknown, session: string) => fetch(`http://127.0.0.1:${proxyPort}/bili/${origin}/v1/responses`, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": session }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
        });
        const topLevelToolNames = (tools: unknown): Set<string> => {
            const names = new Set<string>();
            if (!Array.isArray(tools)) return names;
            for (const t of tools) {
                if (t === null || typeof t !== "object") continue;
                const rec = t as Record<string, unknown>;
                if (typeof rec["name"] === "string") names.add(rec["name"]);
                const fn = rec["function"];
                if (fn !== null && typeof fn === "object" && typeof (fn as Record<string, unknown>)["name"] === "string")
                    names.add((fn as Record<string, unknown>)["name"] as string);
            }
            return names;
        };

        const native = await send({
            model: "fixture-gpt", stream: false, max_output_tokens: 10_000,
            tools: [
                { type: "function", name: "exec_command", description: "run", parameters: { type: "object", properties: {} } },
                { type: "namespace", name: "mcp__codebase_memory", description: "another server", tools: [{ type: "function", name: "search_code", parameters: { type: "object", properties: {} } }] },
            ],
            input: [{ type: "message", role: "user", content: "hello" }],
        }, "native-3522-a");
        assert.equal(native.status, 200, await native.text());
        const nativeNames = topLevelToolNames(received.at(-1)!.tools);
        for (const owned of PROXY_TOOL_NAMES) assert.ok(nativeNames.has(owned), `proxy mode must still inject ${owned}`);
        assert.equal(peekSession("native-3522-a")?.metadata.pluginAgent, undefined, "a native session must not enter plugin mode");

        const mcp = await send({
            model: "fixture-gpt", stream: false, max_output_tokens: 10_000,
            tools: [codexNamespace([
                { type: "function", name: "compress", description: "fold", parameters: { type: "object", properties: {} } },
                { type: "function", name: "acp_status", description: "status", parameters: { type: "object", properties: {} } },
            ])],
            input: [{ type: "message", role: "user", content: "hello" }],
        }, "mcp-3522-b");
        assert.equal(mcp.status, 200, await mcp.text());
        const mcpNames = topLevelToolNames(received.at(-1)!.tools);
        for (const owned of PROXY_TOOL_NAMES) assert.ok(!mcpNames.has(owned), `plugin mode must suppress injection of ${owned}`);
        assert.equal(peekSession("mcp-3522-b")?.metadata.pluginAgent, "mcp", "the codex-namespace request must claim the MCP registration");
        assert.equal(takePendingPluginRegister(() => true), undefined, "exactly one claim may drain the queue");
    } finally {
        _resetPluginStateForTest();
        proxy?.closeAllConnections();
        const closingProxy = proxy;
        if (closingProxy) await new Promise<void>((resolve) => closingProxy.close(() => resolve()));
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
});
