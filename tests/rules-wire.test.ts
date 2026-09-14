import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #749: acp_rule must be injected on all three native-tool wires when
// compress.rules is enabled (deepest config level wins), and NEVER injected
// by default. These tests drive real HTTP through startServer against a mock
// upstream that captures the forwarded body — the only way to catch a broken
// injection helper (e.g. an extras array pushed as one nested tool element).

const ANTHROPIC_SSE =
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_rw", usage: { input_tokens: 10 } } })}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;

const OPENAI_SSE =
    `data: ${JSON.stringify({ id: "c_rw", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: "c_rw", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
    `data: [DONE]\n\n`;

const RESPONSES_SSE =
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r_rw", status: "in_progress" } })}\n\n` +
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r_rw", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`;

function startUpstream(): Promise<{ server: http.Server; port: number; bodies: () => Array<Record<string, unknown>> }> {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            try {
                bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                /* non-JSON request */
            }
            const path = req.url ?? "";
            if (path.endsWith("/v1/messages")) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(ANTHROPIC_SSE);
            } else if (path.endsWith("/v1/chat/completions")) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(OPENAI_SSE);
            } else if (path.endsWith("/v1/responses")) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(RESPONSES_SSE);
            } else {
                res.writeHead(404);
                res.end();
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, port: (server.address() as { port: number }).port, bodies: () => bodies });
        });
    });
}

function startProxy(upstreamPort: number, modelCompress?: Record<string, unknown>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "m-test": { context: 10_000, ...(modelCompress ? { compress: modelCompress } : {}) } } } },
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
    } as ProxyOptions);
}

async function post(url: string, headers: Record<string, string>, body: string): Promise<void> {
    const res = await fetch(url, { method: "POST", headers, body });
    assert.equal(res.status, 200, `proxy responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

test("#749 anthropic wire: acp_rule injected alongside ACP tools when rules enabled", async () => {
    const up = await startUpstream();
    const proxy = await startProxy(up.port, { rules: true });
    await once(proxy, "listening");
    const pport = (proxy.address() as { port: number }).port;
    try {
        await post(`http://127.0.0.1:${pport}/bili/http://127.0.0.1:${up.port}/v1/messages`,
            { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-acp-session": "rw-ant-on" },
            JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }));
        assert.equal(up.bodies().length, 1, "exactly one upstream request");
        const tools = up.bodies()[0].tools as Array<{ name?: unknown; input_schema?: unknown }>;
        assert.ok(Array.isArray(tools), "tools array present");
        for (const t of tools) {
            assert.equal(typeof t?.name, "string", `every tool entry is a flat object with a string name (got: ${JSON.stringify(t).slice(0, 80)})`);
        }
        const names = tools.map((t) => t.name);
        for (const expected of ["compress", "decompress", "search_context", "acp_status", "acp_rule"]) {
            assert.ok(names.includes(expected), `tool list includes ${expected} (got: ${names.join(", ")})`);
        }
        const rule = tools.find((t) => t.name === "acp_rule")!;
        assert.ok(rule.input_schema && typeof rule.input_schema === "object", "acp_rule carries an input_schema");
        assert.equal(names.filter((n) => n === "acp_rule").length, 1, "acp_rule appears exactly once");
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("#749 anthropic wire: acp_rule NOT injected by default (rules off)", async () => {
    const up = await startUpstream();
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const pport = (proxy.address() as { port: number }).port;
    try {
        await post(`http://127.0.0.1:${pport}/bili/http://127.0.0.1:${up.port}/v1/messages`,
            { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-acp-session": "rw-ant-off" },
            JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }));
        const tools = up.bodies()[0].tools as Array<{ name?: unknown }>;
        const names = tools.map((t) => t.name);
        assert.ok(names.includes("compress"), "ACP tools still injected");
        assert.ok(!names.includes("acp_rule"), `acp_rule absent by default (got: ${names.join(", ")})`);
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("#749 openai wire: acp_rule function tool injected when rules enabled", async () => {
    const up = await startUpstream();
    const proxy = await startProxy(up.port, { rules: true });
    await once(proxy, "listening");
    const pport = (proxy.address() as { port: number }).port;
    try {
        // max_tokens > 200 keeps the request out of title-gen mode (which
        // skips ALL tool injection).
        await post(`http://127.0.0.1:${pport}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`,
            { "content-type": "application/json", "x-acp-session": "rw-oai-on" },
            JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }));
        const tools = up.bodies()[0].tools as Array<{ type?: unknown; function?: { name?: unknown } }>;
        for (const t of tools) {
            assert.equal(t.type, "function", `every openai tool entry is a function wrapper (got: ${JSON.stringify(t).slice(0, 80)})`);
        }
        const names = tools.map((t) => t.function?.name);
        for (const expected of ["compress", "acp_status", "acp_rule"]) {
            assert.ok(names.includes(expected), `tool list includes ${expected} (got: ${names.join(", ")})`);
        }
        assert.equal(names.filter((n) => n === "acp_rule").length, 1, "acp_rule appears exactly once");
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("#749 responses wire: acp_rule flat tool injected when rules enabled", async () => {
    const up = await startUpstream();
    const proxy = await startProxy(up.port, { rules: true });
    await once(proxy, "listening");
    const pport = (proxy.address() as { port: number }).port;
    try {
        await post(`http://127.0.0.1:${pport}/bili/http://127.0.0.1:${up.port}/v1/responses`,
            { "content-type": "application/json", "x-acp-session": "rw-resp-on" },
            JSON.stringify({ model: "m-test", stream: true, instructions: "You are a test agent.", input: [{ type: "message", role: "user", content: "hi" }] }));
        const tools = up.bodies()[0].tools as Array<{ name?: unknown }>;
        const names = tools.map((t) => t.name);
        for (const expected of ["compress", "acp_status", "acp_rule"]) {
            assert.ok(names.includes(expected), `tool list includes ${expected} (got: ${names.join(", ")})`);
        }
        assert.equal(names.filter((n) => n === "acp_rule").length, 1, "acp_rule appears exactly once");
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("#749 anthropic wire: client-supplied tools merge without duplicating acp_rule", async () => {
    const up = await startUpstream();
    const proxy = await startProxy(up.port, { rules: true });
    await once(proxy, "listening");
    const pport = (proxy.address() as { port: number }).port;
    try {
        await post(`http://127.0.0.1:${pport}/bili/http://127.0.0.1:${up.port}/v1/messages`,
            { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-acp-session": "rw-ant-dedup" },
            JSON.stringify({
                model: "m-test", max_tokens: 1024, stream: true,
                messages: [{ role: "user", content: "hi" }],
                tools: [
                    { name: "bash", description: "client tool", input_schema: { type: "object", properties: {} } },
                    { name: "acp_rule", description: "plugin-side copy", input_schema: { type: "object", properties: {} } },
                ],
            }));
        const tools = up.bodies()[0].tools as Array<{ name?: unknown }>;
        const names = tools.map((t) => t.name);
        assert.equal(names.filter((n) => n === "bash").length, 1, "client tool preserved");
        assert.equal(names.filter((n) => n === "acp_rule").length, 1, "no duplicate acp_rule (dedup by name)");
        assert.ok(names.includes("compress"), "missing ACP tools still appended");
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});
