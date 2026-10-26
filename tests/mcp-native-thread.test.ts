// #2024: Codex Code Mode 压缩失败 — the MCP shim ignored the per-call
// _meta.threadId Codex ≥0.160 stamps on every tools/call (real thread id) and
// kept routing through a stale env binding baked into the generated MCP
// config. Pins the production fix at three layers:
//   A. shim contract — the REAL src/mcp.ts over stdio JSON-RPC against a mock
//      HTTP proxy capturing the exact POST /__bili/plugin/tool bodies: a valid
//      native id overrides BOTH the stale default binding and the
//      model-transcribed conversation_id, per call only (the global binding is
//      never rewritten); malformed metadata falls through to the legacy
//      channels; registration stays one-shot on the default binding;
//   B. proxy routing policy — real startServer: a host-stamped nativeCaller
//      outranks a conflicting unique outbound witness, while UNMARKED ids fail
//      closed on conflicting witnesses; an unresolvable native id fails loudly
//      (no witness rescue, no sibling adoption);
//   C. incident shape end-to-end — real server + real shim over stdio with a
//      stale env id: interleaved main/child threads each route home, and a
//      meta-less call still fails against the untouched stale binding.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { after } from "node:test";
import type { ProxyOptions } from "../src/config.ts";

// XDG env BEFORE importing the server (auto-restart.test.ts pattern): boot's
// loadConversations() would otherwise hydrate the developer's live production
// conversations into the routing table.
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-native-thread-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

// Imported AFTER the XDG env above.
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { resetToolRingForTest } = await import("../src/tool-ring.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

type Relay = {
    server: http.Server;
};

/** Deterministic fake chat upstream. A request whose user text carries
 *  `WITNESS:<tool>` is answered with a NON-STREAM JSON assistant message
 *  containing that tool call (recording lane 5, #1692); everything else gets
 *  a plain text answer. */
function startRelay(): Relay {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const marker = /WITNESS:([a-z_]+)/.exec(body)?.[1];
            res.writeHead(200, { "content-type": "application/json" });
            if (marker) {
                res.end(JSON.stringify({
                    id: "r1", object: "chat.completion",
                    choices: [{
                        index: 0,
                        message: { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: marker, arguments: "{}" } }] },
                        finish_reason: "tool_calls",
                    }],
                    usage: { prompt_tokens: 100, completion_tokens: 2 },
                }));
                return;
            }
            res.end(JSON.stringify({
                id: "r1", object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "plain reply" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
        });
    });
    server.listen(0, "127.0.0.1");
    return { server };
}

type Harness = {
    baseUrl: string;
    chatUrl: string;
    relay: Relay;
    stop: () => Promise<void>;
};

async function boot(): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    resetToolRingForTest();
    _resetPluginStateForTest();
    const relay = startRelay();
    await listen(relay.server);
    const relayPort = (relay.server.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${relayPort}`]: { models: { "gpt-test": { context: 1_000_000 } }, compressProtocol: "marker" } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {}),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        baseUrl: `http://127.0.0.1:${proxyPort}`,
        chatUrl: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`,
        relay,
        stop: async () => {
            await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
            await new Promise<void>((resolve, reject) => relay.server.close((e) => (e ? reject(e) : resolve())));
        },
    };
}

async function modelTurn(h: Harness, conv: string, userText: string): Promise<void> {
    const res = await fetch(h.chatUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "pi",
            "x-bili-plugin-conversation": conv,
            "x-bili-plugin-model": "gpt-test",
        },
        body: JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: userText }] }),
    });
    assert.equal(res.status, 200, `model turn for ${conv} must succeed`);
    await res.json();
}

async function toolPost(h: Harness, body: Record<string, unknown>): Promise<{ status: number; json: { ok?: boolean; result?: string; error?: string; code?: string } | null }> {
    const res = await fetch(`${h.baseUrl}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as { ok?: boolean; result?: string; error?: string; code?: string } | null };
}

/** The served session's Web UI deep link (contains its session id) — the
 *  oracle for WHICH conversation a tool execution ran against. acp_cache
 *  prefixes its result with the link (handlePluginTool, #acp-cache deep link). */
async function webUrlOf(h: Harness, conv: string): Promise<string> {
    const res = await fetch(`${h.baseUrl}/__bili/plugin/status?conversationId=${encodeURIComponent(conv)}`);
    assert.equal(res.status, 200, `status for ${conv} must resolve`);
    const json = (await res.json()) as { webUrl?: string | null };
    assert.ok(typeof json.webUrl === "string" && json.webUrl.length > 0, `status for ${conv} must expose its webUrl`);
    return json.webUrl;
}

// ─────────────────────────── Part A: shim contract ───────────────────────────

type CapturedBody = { conversationId?: unknown; tool?: unknown; args?: unknown; nativeCaller?: unknown };

function argOf(body: CapturedBody, key: string): unknown {
    const args = body.args;
    if (!args || typeof args !== "object") return undefined;
    return (args as Record<string, unknown>)[key];
}

function startMockProxy(): Promise<{ url: string; tools: CapturedBody[]; registers: CapturedBody[]; stop: () => Promise<void> }> {
    const tools: CapturedBody[] = [];
    const registers: CapturedBody[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = (raw ? JSON.parse(raw) : {}) as CapturedBody;
            if (req.method === "GET" && req.url === "/__bili/plugin/manifest") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    tools: { anthropic: [
                        { name: "acp_status", description: "s", input_schema: { type: "object" } },
                        { name: "acp_cache", description: "c", input_schema: { type: "object" } },
                        { name: "compress", description: "c", input_schema: { type: "object" } },
                        { name: "search_context", description: "q", input_schema: { type: "object" } },
                    ] },
                }));
                return;
            }
            if (req.method === "POST" && req.url === "/__bili/plugin/register") {
                registers.push(parsed);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            if (req.method === "POST" && req.url === "/__bili/plugin/tool") {
                tools.push(parsed);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: `MOCK:${String(parsed.conversationId ?? "none")}` }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "not found" }));
        });
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        tools,
        registers,
        stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    }));
}

/** Multi-call client driving the REAL src/mcp.ts over stdio JSON-RPC (one
 *  shim process for several calls — required to prove the global binding is
 *  never rewritten across calls). Env spreads process.env (issue760 pattern):
 *  a stripped env loses PATH/SystemRoot and the spawn dies pre-handshake. */
class ShimClient {
    private child: ReturnType<typeof spawn>;
    private stderr = "";
    private pending = new Map<number, (msg: unknown) => void>();
    private buf = "";

    constructor(env: NodeJS.ProcessEnv) {
        this.child = spawn(process.execPath, ["--import", "tsx", "src/mcp.ts"], {
            cwd: process.cwd(),
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stdout?.setEncoding("utf8");
        this.child.stderr?.setEncoding("utf8");
        this.child.stdout?.on("data", (d: string) => {
            this.buf += d;
            let nl: number;
            while ((nl = this.buf.indexOf("\n")) >= 0) {
                const line = this.buf.slice(0, nl).trim();
                this.buf = this.buf.slice(nl + 1);
                if (!line) continue;
                try {
                    const msg = JSON.parse(line) as { id?: unknown };
                    if (typeof msg.id === "number") {
                        const waiter = this.pending.get(msg.id);
                        if (waiter) {
                            this.pending.delete(msg.id);
                            waiter(msg);
                        }
                    }
                } catch { /* non-JSON line — ignore */ }
            }
        });
        this.child.stderr?.on("data", (d: string) => { this.stderr += d; });
        this.child.on("error", () => this.failAll("shim spawn failed"));
    }

    private failAll(reason: string): void {
        for (const waiter of [...this.pending.values()]) {
            waiter({ error: reason, stderr: this.stderr.slice(0, 400) });
        }
        this.pending.clear();
    }

    private send(obj: unknown): void {
        this.child.stdin?.write(`${JSON.stringify(obj)}\n`);
    }

    request(id: number, method: string, params?: Record<string, unknown>): Promise<{ result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: unknown; stderr?: string }> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`shim ${method} (id ${id}) timed out; stderr: ${this.stderr.slice(0, 400)}`));
            }, 20_000);
            this.pending.set(id, (msg) => {
                clearTimeout(timer);
                resolve(msg as { result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: unknown; stderr?: string });
            });
            this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
        });
    }

    async init(clientName = "codex-mcp-client"): Promise<void> {
        const r = await this.request(0, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: clientName, version: "0.160.0" },
        });
        assert.ok(r.result, `initialize must succeed; stderr: ${this.stderr.slice(0, 400)}`);
        this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    }

    close(): void {
        this.child.kill();
    }
}

function callText(r: { result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: unknown }): { isError: boolean; text: string } {
    if (r.error) return { isError: true, text: String(r.error) };
    const content = r.result?.content ?? [];
    return { isError: r.result?.isError === true, text: content.map((c) => c.text ?? "").join("") };
}

const MAIN_THREAD = "6f1e2c3a-1111-4aaa-9bbb-000000000001";
const CHILD_THREAD = "6f1e2c3a-2222-4bbb-9ccc-000000000002";
const STALE_ENV_ID = "6f1e2c3a-9999-4ddd-9eee-000000000099";
const MODEL_COPIED_ID = "6f1e2c3a-3333-4ccc-9ddd-000000000003";
const SEARCH_TARGET = "6f1e2c3a-4444-4ddd-9eee-000000000004";

const COMPRESS_ARGS = { content: [{ startId: "m00001", endId: "m00003", summary: "routing-check compressed range" }] };

test("#2024 shim: valid _meta.threadId overrides stale env AND model-transcribed id, per call only", async () => {
    const mock = await startMockProxy();
    try {
        const c = new ShimClient({
            ...process.env,
            BILI_MCP_PROXY: mock.url,
            BILI_CONVERSATION_ID: STALE_ENV_ID,
            CLAUDE_CODE_SESSION_ID: "",
        });
        try {
            await c.init();
            // 1: native main thread, transient run sessionId alongside (must be ignored)
            await c.request(1, "tools/call", { name: "compress", arguments: COMPRESS_ARGS, _meta: { threadId: MAIN_THREAD, sessionId: "transient-run-1" } });
            // 2: native child thread + a stale model-transcribed conversation_id
            await c.request(2, "tools/call", { name: "compress", arguments: { ...COMPRESS_ARGS, conversation_id: MODEL_COPIED_ID }, _meta: { threadId: CHILD_THREAD, sessionId: "transient-run-1" } });
            // 3: no meta at all — must still hit the UNTOUCHED default binding
            await c.request(3, "tools/call", { name: "acp_status", arguments: {} });
            // 4: search_context cross-session target with a native caller
            await c.request(4, "tools/call", { name: "search_context", arguments: { query: "probe", conversation_id: SEARCH_TARGET }, _meta: { threadId: MAIN_THREAD } });
        } finally {
            c.close();
        }
        assert.equal(mock.tools.length, 4, "all four calls must be forwarded");
        const [t1, t2, t3, t4] = mock.tools;
        assert.equal(t1.conversationId, MAIN_THREAD, "native main id must route call 1");
        assert.equal(t1.nativeCaller, true, "host-stamped origin must be flagged");
        assert.equal(argOf(t1, "conversation_id"), undefined, "per-call id stripped for non-search tools");
        assert.equal(t2.conversationId, CHILD_THREAD, "native id must beat the model-transcribed conversation_id");
        assert.equal(t2.nativeCaller, true);
        assert.equal(argOf(t2, "conversation_id"), undefined);
        assert.equal(t3.conversationId, STALE_ENV_ID, "global binding must NOT be rewritten by native calls 1–2");
        assert.equal(t3.nativeCaller, undefined, "env-bound calls carry no native flag");
        assert.equal(t4.conversationId, MAIN_THREAD, "caller routes natively…");
        assert.equal(t4.nativeCaller, true);
        assert.equal(argOf(t4, "conversation_id"), SEARCH_TARGET, "…while the search target stays read-only in args");
        assert.equal(mock.registers.length, 1, "registration stays one-shot…");
        assert.equal(mock.registers[0].conversationId, STALE_ENV_ID, "…on the default binding only");
    } finally {
        await mock.stop();
    }
});

test("#2024 shim: with NO default binding, a native caller still routes natively and keeps the search target read-only", async () => {
    const mock = await startMockProxy();
    try {
        const c = new ShimClient({
            ...process.env,
            BILI_MCP_PROXY: mock.url,
            BILI_CONVERSATION_ID: "",
            CLAUDE_CODE_SESSION_ID: "",
        });
        try {
            await c.init();
            // New (#2024): previously the target would have been mistaken for
            // the caller (routeOverride fell back to perCall, then stripped).
            await c.request(1, "tools/call", { name: "search_context", arguments: { query: "probe", conversation_id: SEARCH_TARGET }, _meta: { threadId: MAIN_THREAD } });
            // Legacy fallback unchanged: no meta, no binding → perCall routes.
            await c.request(2, "tools/call", { name: "search_context", arguments: { query: "probe", conversation_id: SEARCH_TARGET } });
            // Id-less lane unchanged: nothing to route with.
            await c.request(3, "tools/call", { name: "acp_status", arguments: {} });
        } finally {
            c.close();
        }
        assert.equal(mock.tools.length, 3);
        const [t1, t2, t3] = mock.tools;
        assert.equal(t1.conversationId, MAIN_THREAD);
        assert.equal(t1.nativeCaller, true);
        assert.equal(argOf(t1, "conversation_id"), SEARCH_TARGET);
        assert.equal(t2.conversationId, SEARCH_TARGET, "legacy per-call fallback preserved");
        assert.equal(t2.nativeCaller, undefined);
        assert.ok(!("conversationId" in t3), "id-less lane sends no conversationId");
        assert.equal(t3.nativeCaller, undefined);
        assert.equal(mock.registers.length, 0, "nothing registered when there is no binding");
    } finally {
        await mock.stop();
    }
});

test("#2024 shim: malformed or absent _meta.threadId never shadows the legacy channels", async () => {
    const mock = await startMockProxy();
    try {
        const c = new ShimClient({
            ...process.env,
            BILI_MCP_PROXY: mock.url,
            BILI_CONVERSATION_ID: STALE_ENV_ID,
            CLAUDE_CODE_SESSION_ID: "",
        });
        try {
            await c.init();
            const badValues: Array<Record<string, unknown>> = [
                { threadId: 42 },
                { threadId: { nested: true } },
                { threadId: "" },
                { threadId: "   " },
                { threadId: null },
                {},
            ];
            let id = 1;
            for (const meta of badValues) {
                await c.request(id, "tools/call", { name: "acp_status", arguments: {}, _meta: meta });
                id++;
            }
            // Well-formed threadId still wins even when sessionId rides along.
            await c.request(id, "tools/call", { name: "acp_status", arguments: {}, _meta: { threadId: MAIN_THREAD, sessionId: "transient-run-1" } });
        } finally {
            c.close();
        }
        assert.equal(mock.tools.length, 7);
        for (let i = 0; i < 6; i++) {
            assert.equal(mock.tools[i].conversationId, STALE_ENV_ID, `malformed meta #${i + 1} must fall through to the env binding`);
            assert.equal(mock.tools[i].nativeCaller, undefined, `malformed meta #${i + 1} must not flag native origin`);
        }
        assert.equal(mock.tools[6].conversationId, MAIN_THREAD);
        assert.equal(mock.tools[6].nativeCaller, true);
    } finally {
        await mock.stop();
    }
});

// ─────────────────────── Part B: proxy routing policy ────────────────────────

test("#2024 proxy: host-stamped native caller outranks a conflicting unique witness; unmarked ids fail closed", async () => {
    const h = await boot();
    try {
        await modelTurn(h, "nt-a", "alpha plain turn");
        // nt-b streams the very (acp_cache, {}) call we will POST — its unique
        // witness names nt-b, conflicting with the native caller nt-a.
        await modelTurn(h, "nt-b", "WITNESS:acp_cache beta streams the tool call");
        const urlA = await webUrlOf(h, "nt-a");
        const urlB = await webUrlOf(h, "nt-b");
        assert.notEqual(urlA, urlB);

        let r = await toolPost(h, { tool: "acp_cache", args: {}, conversationId: "nt-a", nativeCaller: true });
        assert.equal(r.status, 200, "conflicting-witness conflict must not hard-fail a confirmed native caller");
        assert.ok(String(r.json?.result ?? "").includes(urlA), "the NATIVE caller's session must be served, not the witnessing one");
        assert.ok(!String(r.json?.result ?? "").includes(urlB), "the witnessing session must NOT be served");

        // Without the host stamp, a conflicting witness must not silently
        // redirect a model-written/static body id into another session.
        resetToolRingForTest();
        await modelTurn(h, "nt-b", "WITNESS:acp_cache second beta witness turn");
        r = await toolPost(h, { tool: "acp_cache", args: {}, conversationId: "nt-a" });
        assert.equal(r.status, 409, "unmarked resolvable body id contradicted by a unique witness must fail closed (#2016)");
        assert.equal((r.json as Record<string, unknown> | null)?.code, "TOOL_CONVERSATION_CONFLICT");
    } finally {
        await h.stop();
    }
});

test("#2024 proxy: unresolvable native id fails loudly even with a conflicting witness — no rescue, no sibling adoption", async () => {
    const h = await boot();
    try {
        await modelTurn(h, "nt-a", "alpha plain turn");
        await modelTurn(h, "nt-b", "WITNESS:acp_cache beta witness turn");
        const r = await toolPost(h, { tool: "acp_cache", args: {}, conversationId: "nt-never-seen", nativeCaller: true });
        assert.equal(r.status, 404, "an unknown native thread must fail loudly");
        assert.match(String(r.json?.error ?? ""), /no model request has arrived with this conversation id yet/, "#1158 diagnostic must point at the id");
    } finally {
        await h.stop();
    }
});

test("#2024 proxy: native id with no model requests yet fails loudly with no witness involved", async () => {
    const h = await boot();
    try {
        await modelTurn(h, "nt-a", "alpha plain turn");
        resetToolRingForTest();
        const r = await toolPost(h, { tool: "acp_status", args: {}, conversationId: "nt-fresh-thread", nativeCaller: true });
        assert.equal(r.status, 404);
        assert.match(String(r.json?.error ?? ""), /no model request has arrived with this conversation id yet/);
    } finally {
        await h.stop();
    }
});

test("#2024 proxy: native caller without any witness routes through the ordinary body-id lane", async () => {
    const h = await boot();
    try {
        await modelTurn(h, "nt-a", "alpha plain turn");
        resetToolRingForTest();
        const urlA = await webUrlOf(h, "nt-a");
        const r = await toolPost(h, { tool: "acp_cache", args: {}, conversationId: "nt-a", nativeCaller: true });
        assert.equal(r.status, 200);
        assert.ok(String(r.json?.result ?? "").includes(urlA), "flagged call with no witness must serve its own session");
    } finally {
        await h.stop();
    }
});

// ─────────────────── Part C: incident shape, real server + real shim ─────────

test("#2024 e2e: stale env id + interleaved main/child threads each route home; meta-less call still fails", async () => {
    const h = await boot();
    try {
        await modelTurn(h, "codex-main-thread", "main thread plain turn");
        await modelTurn(h, "codex-child-thread", "child thread plain turn");
        // Routing below must come from the meta channel alone.
        resetToolRingForTest();
        const urlMain = await webUrlOf(h, "codex-main-thread");
        const urlChild = await webUrlOf(h, "codex-child-thread");

        // The exact client contract bili codex exercises: BILI_MCP_PROXY + a
        // STALE BILI_CONVERSATION_ID baked into the generated MCP config.
        const c = new ShimClient({
            ...process.env,
            BILI_MCP_PROXY: h.baseUrl,
            BILI_CONVERSATION_ID: STALE_ENV_ID,
            CLAUDE_CODE_SESSION_ID: "",
        });
        try {
            await c.init();
            const r1 = await c.request(1, "tools/call", { name: "acp_cache", arguments: {}, _meta: { threadId: "codex-main-thread", sessionId: "transient-run-1" } });
            const t1 = callText(r1);
            assert.equal(t1.isError, false, `main-thread call must succeed, got: ${t1.text.slice(0, 200)}`);
            assert.ok(t1.text.includes(urlMain), "call 1 must serve the main thread");

            const r2 = await c.request(2, "tools/call", { name: "acp_cache", arguments: {}, _meta: { threadId: "codex-child-thread", sessionId: "transient-run-1" } });
            const t2 = callText(r2);
            assert.equal(t2.isError, false, `child-thread call must succeed, got: ${t2.text.slice(0, 200)}`);
            assert.ok(t2.text.includes(urlChild), "call 2 must serve the child thread");

            const r3 = await c.request(3, "tools/call", { name: "acp_cache", arguments: {}, _meta: { threadId: "codex-main-thread", sessionId: "transient-run-2" } });
            const t3 = callText(r3);
            assert.equal(t3.isError, false);
            assert.ok(t3.text.includes(urlMain), "interleaving back to main must still route home");

            // No meta: the global binding is STILL the stale residue (a
            // write-back bug would serve the main thread here instead).
            const r4 = await c.request(4, "tools/call", { name: "acp_cache", arguments: {} });
            const t4 = callText(r4);
            assert.equal(t4.isError, true, "meta-less call against the stale binding must fail");
            assert.match(t4.text, /unknown plugin conversation/, "the failure must name the unknown conversation");
        } finally {
            c.close();
        }
    } finally {
        await h.stop();
    }
});
