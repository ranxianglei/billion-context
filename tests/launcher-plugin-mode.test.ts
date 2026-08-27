import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { spawn } from "node:child_process";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { buildClaudePluginEnv, buildCodexMcpArgs, buildMcpConfig, launcherDirectUrl, launcherInjectMcp } from "../src/launcher.ts";

// Launcher mode (#162): hosts that cannot attach per-request headers
// (claude/codex spawned by `bili claude` / `bili codex`) bind into plugin mode
// via POST /__bili/plugin/register. Two binding strategies, both covered:
//   1. identity-driven (claude code): every model request carries
//      x-claude-code-session-id === the CLAUDE_CODE_SESSION_ID the MCP shell
//      registered — binds regardless of arrival order,
//   2. headless pending (codex spawn): the register queues; the first request
//      that creates a NEW session consumes it.

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textScript(): string {
    return anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        anthropicSse("message_stop", { type: "message_stop" });
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxyUrl: (path: string) => string;
    modelUrl: () => string;
    upstreamBodies: string[];
    closeAll(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(textScript());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "l162-model": { context: 100_000 } } } },
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
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        proxyUrl: (path) => `http://127.0.0.1:${proxyPort}${path}`,
        modelUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        upstreamBodies,
        closeAll: async () => {
            await close(proxy);
            await close(upstream);
        },
    };
}

function postModel(rig: Rig, sessionHeader?: string): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sessionHeader) headers["x-claude-code-session-id"] = sessionHeader;
    return fetch(rig.modelUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "l162-model", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
}

async function register(rig: Rig, conversationId: string, opts?: { agent?: string; identity?: boolean }): Promise<void> {
    const res = await fetch(rig.proxyUrl("/__bili/plugin/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent: opts?.agent, identity: opts?.identity ?? false }),
    });
    assert.equal(res.status, 200, "register accepted");
}

test("launcher register endpoint: validates body and echoes the registration", async () => {
    const rig = await startRig();
    try {
        const bad = await fetch(rig.proxyUrl("/__bili/plugin/register"), { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
        assert.equal(bad.status, 400);
        const missing = await fetch(rig.proxyUrl("/__bili/plugin/register"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal(missing.status, 400);
        await register(rig, "reg-a");
    } finally {
        await rig.closeAll();
    }
});

test("launcher identity binding: register arriving AFTER the first request still binds (the -p race)", async () => {
    const rig = await startRig();
    try {
        // Reversed order on purpose: claude -p fires its first model request
        // concurrently with the MCP shell's initialize. The first request is
        // NOT plugin mode (wire tools injected)…
        await postModel(rig, "sess-identity-1");
        assert.ok(rig.upstreamBodies[0]!.includes("compress"), "wire tools injected before binding");
        // …then the shell registers; the SECOND request carries the same
        // x-claude-code-session-id and must bind via identity.
        await register(rig, "sess-identity-1", { agent: "mcp", identity: true });
        await postModel(rig, "sess-identity-1");
        assert.ok(!rig.upstreamBodies[1]!.includes("\"compress\"", ), "wire tool injection suppressed after identity binding");
        const status = await (await fetch(rig.proxyUrl("/__bili/plugin/status?conversationId=sess-identity-1"))).json() as { ok: boolean; pluginAgent?: string };
        assert.ok(status.ok, "conversation registered");
        assert.equal(status.pluginAgent, "mcp");
    } finally {
        await rig.closeAll();
    }
});

test("launcher headless pending binding: register BEFORE the first request binds the new session (codex spawn)", async () => {
    const rig = await startRig();
    try {
        await register(rig, "headless-conv-1", { agent: "mcp" });
        await postModel(rig); // no session header at all
        assert.ok(!rig.upstreamBodies[0]!.includes("\"compress\""), "wire tool injection suppressed from the very first request");
        const status = await (await fetch(rig.proxyUrl("/__bili/plugin/status?conversationId=headless-conv-1"))).json() as { ok: boolean; pluginAgent?: string };
        assert.ok(status.ok, "pending register consumed by the new session");
        assert.equal(status.pluginAgent, "mcp");
    } finally {
        await rig.closeAll();
    }
});

test("launcher identity binding survives model switches (one conversation, multiple sessions)", async () => {
    const rig = await startRig();
    const upstream2Bodies: string[] = [];
    const upstream2 = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstream2Bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(textScript());
        });
    });
    upstream2.listen(0, "127.0.0.1");
    await listen(upstream2);
    try {
        const port2 = (upstream2.address() as { port: number }).port;
        const postUpstream2 = (): Promise<Response> => fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${port2}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-switch" },
            body: JSON.stringify({ model: "l162-model", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        // First model (upstream A): binds via identity as usual.
        await register(rig, "sess-switch", { agent: "omp", identity: true });
        await postModel(rig, "sess-switch");
        assert.ok(!rig.upstreamBodies[0]!.includes("\"compress\""), "upstream A: wire injection suppressed after identity binding");
        // Model switch mid-conversation: upstream B resolves a NEW session
        // under the SAME conversation id. The omp TUI flow (e.g. GLM chat →
        // qwen responses) must keep plugin mode on the new session too.
        await postUpstream2();
        assert.ok(!upstream2Bodies[0]!.includes("\"compress\""), "upstream B: identity binding survives the model switch");
    } finally {
        await close(upstream2);
        await rig.closeAll();
    }
});

test("launcher identity binding does not leak onto other sessions", async () => {
    const rig = await startRig();
    try {
        await register(rig, "sess-mine", { agent: "mcp", identity: true });
        await postModel(rig, "sess-other"); // different conversation id
        assert.ok(rig.upstreamBodies[0]!.includes("compress"), "unregistered conversation stays wire mode");
        const status = await (await fetch(rig.proxyUrl("/__bili/plugin/status?conversationId=sess-mine"))).json() as { ok: boolean };
        assert.ok(!status.ok, "registration not consumed by a foreign session");
    } finally {
        await rig.closeAll();
    }
});

test("launcher injection builders: direct-URL env, MCP config JSON, codex -c args", () => {
    assert.equal(launcherDirectUrl({}), false, "transparent-MITM route is the default (existing launcher compatibility)");
    assert.equal(launcherDirectUrl({ BILI_LAUNCHER_DIRECT: "1" }), true, "direct URL is opt-in");
    assert.equal(launcherDirectUrl({ BILI_LAUNCHER_DIRECT: "0" }), false, "explicit opt-out honored");

    // MCP injection is ON by default for claude/codex (#290): zero-config
    // native tools, mirroring the pi/omp/opencode auto-injection.
    // BILI_LAUNCHER_PLUGIN=0 is the kill switch back to pure wire mode for
    // hosts older than the verified builds (claude 2.1.227, codex 0.147.0).
    assert.equal(launcherInjectMcp({}, "claude"), true, "plugin injection on by default (claude)");
    assert.equal(launcherInjectMcp({}, "codex"), true, "plugin injection on by default (codex)");
    assert.equal(launcherInjectMcp({ BILI_LAUNCHER_PLUGIN: "0" }, "claude"), false, "explicit opt-out honored (claude)");
    assert.equal(launcherInjectMcp({ BILI_LAUNCHER_PLUGIN: "0" }, "codex"), false, "explicit opt-out honored (codex)");
    assert.equal(launcherInjectMcp({ BILI_LAUNCHER_PLUGIN: "1" }, "claude"), true, "explicit opt-in still works");
    assert.equal(launcherInjectMcp({ BILI_LAUNCHER_PLUGIN: "1" }, "pi"), false, "pi always excluded (native extension #154)");

    const env = buildClaudePluginEnv("http://127.0.0.1:8787", true, { HOME: "/h" });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787/bili/https://api.anthropic.com");
    assert.equal(env.HOME, "/h", "base env preserved");
    assert.equal(buildClaudePluginEnv("http://127.0.0.1:8787", false, { HOME: "/h" }).ANTHROPIC_BASE_URL, undefined, "MITM mode leaves the base URL alone");

    const mcp = buildMcpConfig("http://127.0.0.1:8787");
    assert.equal(mcp.mcpServers.bili.command, process.execPath);
    assert.match(mcp.mcpServers.bili.args[0]!, /mcp\.js$/);
    assert.equal(mcp.mcpServers.bili.env.BILI_MCP_PROXY, "http://127.0.0.1:8787");

    const codexConvId = "11111111-2222-4333-8444-555555555555";
    const args = buildCodexMcpArgs("http://127.0.0.1:8787", codexConvId);
    assert.deepEqual(args[0], "-c");
    assert.match(args[1]!, /^mcp_servers\.bili\.command=/);
    assert.match(args[3]!, /^mcp_servers\.bili\.args=/);
    assert.match(args[5]!, /^mcp_servers\.bili\.env\.BILI_MCP_PROXY=/);
    // codex-cli parses these -c values as TOML: args MUST be a TOML array,
    // not a JSON-encoded string — a double-encoded value makes codex refuse
    // to start ("invalid type: string ..., expected a sequence").
    const argsValue = args[3]!.slice("mcp_servers.bili.args=".length);
    assert.match(argsValue, /^\[.*\]$/, "args is a TOML array, not a stringified array");
    const parsedArgs = JSON.parse(argsValue) as unknown[];
    assert.ok(Array.isArray(parsedArgs) && parsedArgs.length === 1, "exactly one argument");
    assert.ok(String(parsedArgs[0]).endsWith("mcp.js"), "argument is the mcp script path");
    // codex passes no session id to MCP children, so the launcher injects a
    // per-spawn conversation id for the shell's headless self-registration.
    assert.match(args[7]!, /^mcp_servers\.bili\.env\.BILI_CONVERSATION_ID=/);
    assert.equal(args[7]!.slice("mcp_servers.bili.env.BILI_CONVERSATION_ID=".length), JSON.stringify(codexConvId));
});

test("mcp stdio shell: manifest → tools/list → tools/call forwards to the plugin tool endpoint", async () => {
    const rig = await startRig();
    // Bind a conversation first so acp_status has a session to report on.
    await register(rig, "mcp-shell-conv", { agent: "mcp" });
    await postModel(rig, "mcp-shell-conv");

    const shell = spawn(process.execPath, ["--import", "tsx", "src/mcp.ts"], {
        env: {
            ...process.env,
            BILI_MCP_PROXY: rig.proxyUrl(""),
            BILI_CONVERSATION_ID: "mcp-shell-conv",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const { promise: settled, resolve: settledOk, reject: settledErr } = Promise.withResolvers<void>();
    const lines: string[] = [];
    shell.stdout.on("data", (d: Buffer) => {
        let chunk = d.toString("utf8");
        let nl: number;
        while ((nl = chunk.indexOf("\n")) >= 0) {
            const line = chunk.slice(0, nl).trim();
            chunk = chunk.slice(nl + 1);
            if (line.startsWith("{")) lines.push(line);
        }
        if (lines.length === 3) settledOk(); // initialize + tools/list + tools/call
    });
    shell.stderr.on("data", () => {});
    shell.on("error", settledErr);
    const send = (msg: unknown) => shell.stdin.write(JSON.stringify(msg) + "\n");

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acp_status", arguments: {} } });

    try {
        await settled;
    } finally {
        shell.kill();
        await rig.closeAll();
    }

    const out = lines;

    const byId = (n: number): Record<string, unknown> => JSON.parse(out.find((l) => (JSON.parse(l) as { id?: number }).id === n) ?? "{}");

    const init = byId(1) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(init.result?.serverInfo?.name, "bili");
    const tools = byId(2) as { result?: { tools?: { name: string }[] } };
    assert.deepEqual(tools.result?.tools?.map((t) => t.name).sort(), ["acp_status", "compress", "decompress", "search_context"]);
    const call = byId(3) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    assert.equal(call.result?.isError, false);
    assert.match(call.result?.content?.[0]?.text ?? "", /CONTEXT BREAKDOWN/, "acp_status result forwarded verbatim");
});

test("mcp stdio shell (codex style): BILI_CONVERSATION_ID self-register → headless binding → tools/call", async () => {
    // The exact flow `bili codex` now produces (default MITM route): the
    // launcher passes BILI_CONVERSATION_ID, the shell self-registers
    // headlessly on initialize (no manual register, no identity header), the
    // first NEW-session model request consumes the pending registration, and
    // tool calls through the shell resolve.
    const rig = await startRig();
    const conv = "codex-e2e-conv-1";
    let status: { ok: boolean; pluginAgent?: string } = { ok: false };

    const shell = spawn(process.execPath, ["--import", "tsx", "src/mcp.ts"], {
        env: {
            ...process.env,
            BILI_MCP_PROXY: rig.proxyUrl(""),
            BILI_CONVERSATION_ID: conv,
            // deliberately NO CLAUDE_CODE_SESSION_ID — codex passes none.
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const { promise: settled, resolve: settledOk, reject: settledErr } = Promise.withResolvers<void>();
    const lines: string[] = [];
    shell.stdout.on("data", (d: Buffer) => {
        let chunk = d.toString("utf8");
        let nl: number;
        while ((nl = chunk.indexOf("\n")) >= 0) {
            const line = chunk.slice(0, nl).trim();
            chunk = chunk.slice(nl + 1);
            if (line.startsWith("{")) {
                lines.push(line);
                if (lines.length === 1) {
                    // initialize answered → the headless register has landed
                    // (the shell awaits it before responding). Consume it via
                    // a fresh model session, then ask for tools.
                    void postModel(rig).then(() => {
                        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
                        send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acp_status", arguments: {} } });
                    });
                } else if (lines.length === 3) {
                    settledOk();
                }
            }
        }
    });
    shell.stderr.on("data", () => {});
    shell.on("error", settledErr);
    const send = (msg: unknown) => shell.stdin.write(JSON.stringify(msg) + "\n");

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    try {
        await settled;
        // The headless registration was consumed by the model session — the
        // conversation is bound in the proxy. (Must run before closeAll.)
        status = await (await fetch(rig.proxyUrl(`/__bili/plugin/status?conversationId=${conv}`))).json() as { ok: boolean; pluginAgent?: string };
    } finally {
        shell.kill();
        await rig.closeAll();
    }

    const byId = (n: number): Record<string, unknown> => JSON.parse(lines.find((l) => (JSON.parse(l) as { id?: number }).id === n) ?? "{}");
    const tools = byId(2) as { result?: { tools?: { name: string }[] } };
    assert.deepEqual(tools.result?.tools?.map((t) => t.name).sort(), ["acp_status", "compress", "decompress", "search_context"], "tools listed");
    const call = byId(3) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    assert.equal(call.result?.isError, false, `tools/call succeeded (self-registered conversation bound)${call.result?.isError ? ": " + (call.result?.content?.[0]?.text ?? "") : ""}`);
    assert.match(call.result?.content?.[0]?.text ?? "", /CONTEXT BREAKDOWN/);
    assert.equal(status.ok, true, "conversation bound after the model request");
    assert.equal(status.pluginAgent, "mcp");
});
