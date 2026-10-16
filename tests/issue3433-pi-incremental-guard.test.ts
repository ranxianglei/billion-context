// #3433: pi (and pi-native, which inherits this wiring by design) must apply
// the same anthropic-wire guard as omp/opencode before converting an outgoing
// payload onto the incremental lane — pi supports openai/responses/google
// provider APIs, so OpenAI tool shapes (assistant.tool_calls / role:"tool")
// reach before_provider_request and would be silently dropped by the lane's
// anthropicToCore ingest. They stay on full resend.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { createBiliPlugin } from "../src/agent/pi.ts";
import { __resetIncrementalClientForTests } from "../src/agent/incremental-client.js";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-incr3433-"));
after(() => rmSync(testRoot, { recursive: true, force: true }));

type FakePi = { events: Map<string, (event: unknown, ctx: unknown) => unknown>; tools: Array<{ name: string }>; on: (event: string, handler: (event: never, ctx: never) => unknown) => void; registerTool: (tool: { name: string }) => void };

function makeFakePi(): FakePi {
    const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools: Array<{ name: string }> = [];
    return {
        events,
        tools,
        on: (event, handler) => {
            const h = handler as (event: unknown, ctx: unknown) => unknown;
            const prev = events.get(event);
            events.set(event, prev ? ((e, c) => { prev(e, c); return h(e, c); }) : h);
        },
        registerTool: (tool) => {
            const i = tools.findIndex((t) => t.name === tool.name);
            if (i >= 0) tools[i] = tool;
            else tools.push(tool);
        },
    };
}

/** Real proxy with the lane LIVE (unified storage + rollout forced on) so the
 *  probe passes and the guard — not the probe — is what decides conversion. */
async function harness(): Promise<{ origin: string; close: () => Promise<void> }> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    const savedXdg: Record<string, string | undefined> = {};
    const savedRollout = process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
    const savedProxy = process.env.BILLION_CONTEXT_PROXY;
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
        savedXdg[key] = process.env[key];
        process.env[key] = dir;
    }
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalClientForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 100, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    process.env.BILLION_CONTEXT_PROXY = origin;
    return {
        origin,
        close: async () => {
            for (const [key, v] of Object.entries(savedXdg)) {
                if (v === undefined) delete process.env[key];
                else process.env[key] = v;
            }
            if (savedRollout === undefined) delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
            else process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = savedRollout;
            if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
            else process.env.BILLION_CONTEXT_PROXY = savedProxy;
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            store.closeQuietly();
            await new Promise<void>((resolve) => upstream.close(() => resolve()));
        },
    };
}

test("#3433: pi OpenAI tool shapes ride full resend; anthropic shapes still convert", async () => {
    const h = await harness();
    try {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("before_provider_request");
        assert.ok(handler, "before_provider_request handler registered");
        const ctx = { sessionManager: { getSessionId: () => "pi-inc-3433" }, model: { id: "claude-test", contextWindow: 400000, baseUrl: h.origin }, cwd: "/tmp" };

        // OpenAI chat-completions shape: assistant.tool_calls + role:"tool"
        const openaiBody = { model: "gpt-test", max_tokens: 64, stream: false, messages: [
            { role: "user", content: "list the files" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "call_1", content: "a.txt b.txt" },
        ] };
        const out = await handler({ payload: openaiBody }, ctx);
        assert.ok(pi.tools.length > 0, "tools registered — the readiness gate passed, so the shape guard is what skipped the conversion");
        assert.equal(out, undefined, "OpenAI tool shape: no replacement — the host keeps its full-resend payload");

        // control: the anthropic wire shape DOES convert in the same live-lane environment
        const anthropicBody = { model: "claude-test", max_tokens: 64, system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
        const replaced = (await handler({ payload: anthropicBody }, ctx)) as { conversationId?: string; sinceSeq?: number; messages?: unknown[] } | undefined;
        assert.ok(replaced !== undefined, "anthropic shape converts (guard does not over-block)");
        assert.equal(replaced?.conversationId, "pi-inc-3433");
        assert.equal(replaced?.sinceSeq, 0, "first turn seeds the lane");
        assert.equal(replaced?.messages?.length, 1);
    } finally {
        await h.close();
    }
});
