import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { ACP_TOOLS_ANTHROPIC } from "../src/compress-tool.ts";

// #760→#1685: per-call conversation_id for MCP tools. Hosts that share ONE
// shim process across several concurrent conversations (kimi web et al.) have
// no env/meta session channel. Since #1685 (zero-injection) the manifest no
// longer advertises a conversation_id parameter and the proxy injects NO
// model-visible id anywhere; the per-call override path survives purely as
// legacy compat for models trained on the old schema. Covered here: manifest
// schema (id-free), zero id in the wire system part, first-call routing
// (peekSession fallback), unknown-id rejection, sticky plugin-mode flip via
// successful-tool evidence, and the shim's per-call routing / arg stripping /
// adoption guard / id-less forwarding (proxy-side routing, #1685).

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
        proxyUrl: (path) => `http://127.0.0.1:${proxyPort}${path}`,
        modelUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        upstreamBodies,
        closeAll: async () => {
            await close(proxy);
            await close(upstream);
        },
    };
}

function postModel(rig: Rig, conversationId: string, headerName = "x-session-affinity"): Promise<Response> {
    return fetch(rig.modelUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", [headerName]: conversationId },
        body: JSON.stringify({ model: "l162-model", max_tokens: 8192, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
}

async function toolCall(rig: Rig, conversationId: string, tool = "acp_status", args: Record<string, unknown> = {}): Promise<{ status: number; data: { ok?: boolean; result?: string; error?: string } }> {
    const res = await fetch(rig.proxyUrl("/__bili/plugin/tool"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, tool, args }),
    });
    return { status: res.status, data: (await res.json()) as { ok?: boolean; result?: string; error?: string } };
}

async function statusOf(rig: Rig, conversationId: string): Promise<{ ok?: boolean; pluginAgent?: string }> {
    const res = await fetch(rig.proxyUrl(`/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`));
    return (await res.json()) as { ok?: boolean; pluginAgent?: string };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > 5000) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

function sysText(body: string): string {
    const parsed = JSON.parse(body) as { system?: string | { text?: string }[] };
    if (typeof parsed.system === "string") return parsed.system;
    if (Array.isArray(parsed.system)) return parsed.system.map((s) => s.text ?? "").join("\n");
    return "";
}

function toolNames(body: string): string[] {
    const parsed = JSON.parse(body) as { tools?: { name?: string }[] };
    return (parsed.tools ?? []).map((t) => t.name ?? "");
}

type SchemaObj = { properties?: Record<string, unknown>; required?: string[] };

function schemaOf(tool: unknown): SchemaObj | undefined {
    if (!tool || typeof tool !== "object") return undefined;
    const t = tool as Record<string, unknown>;
    if (t.input_schema && typeof t.input_schema === "object") return t.input_schema as SchemaObj;
    const fn = t.function;
    if (fn && typeof fn === "object") {
        const params = (fn as { parameters?: unknown }).parameters;
        if (params && typeof params === "object") return params as SchemaObj;
    }
    if (t.parameters && typeof t.parameters === "object") return t.parameters as SchemaObj;
    return undefined;
}

// Mirrors src/session.ts derivedLegacyCanonicalId: the stable pfa-* id a
// non-pfa (client-named) session exposes for MCP routing.
function canonicalOf(sessionId: string): string {
    return `pfa-${createHash("sha256").update(`legacy:${sessionId}`).digest("hex").slice(0, 16)}`;
}

test("plugin manifest advertises NO conversation_id in any tool format (#1685 zero-injection)", async () => {
    const rig = await startRig();
    try {
        const res = await fetch(rig.proxyUrl("/__bili/plugin/manifest"));
        assert.equal(res.status, 200);
        const m = (await res.json()) as { ok: boolean; tools: Record<string, unknown[]> };
        assert.equal(m.ok, true);
        for (const format of ["anthropic", "openai", "responses"] as const) {
            const tools = m.tools[format];
            assert.ok(Array.isArray(tools) && tools.length >= 4, `${format}: tools listed`);
            for (const t of tools) {
                const schema = schemaOf(t);
                assert.ok(schema?.properties, `${format}/${(t as { name?: string }).name}: has properties`);
                assert.equal((schema!.properties as Record<string, unknown>).conversation_id, undefined, `${format}/${(t as { name?: string }).name}: conversation_id NOT advertised (#1685)`);
                assert.ok(!(schema!.required ?? []).includes("conversation_id"), `${format}: conversation_id not required`);
            }
        }
        // The served shapes must stay byte-identical to the kernel constants —
        // the zero-injection policy means nothing is added on top.
        assert.doesNotMatch(JSON.stringify(ACP_TOOLS_ANTHROPIC), /conversation_id/, "kernel constants unmutated");
    } finally {
        await rig.closeAll();
    }
});

test("wire mode: NO conversation id anywhere in the system part (#1685), byte-stable across turns", async () => {
    const rig = await startRig();
    try {
        await postModel(rig, "conv-760-a");
        await postModel(rig, "conv-760-a");
        await waitFor(() => rig.upstreamBodies.length >= 2, "two upstream bodies");
        const sys0 = sysText(rig.upstreamBodies[0]);
        assert.doesNotMatch(sys0, /Your bili conversation id/, "zero-injection: no model-visible conversation id");
        assert.equal(sysText(rig.upstreamBodies[1]), sys0, "system bytes stable across turns (prefix-cache anchor)");
    } finally {
        await rig.closeAll();
    }
});

test("first tool call routes before any plugin binding recorded the mapping (peekSession fallback)", async () => {
    const rig = await startRig();
    try {
        // No register, no prompt_cache_key: header-based clients leave NO
        // conversations-map entry, so routing must fall back to the verbatim
        // session-id lookup.
        await postModel(rig, "conv-fb");
        const r = await toolCall(rig, "conv-fb");
        assert.equal(r.status, 200, `first-call routing succeeded: ${JSON.stringify(r.data)}`);
        assert.equal(r.data.ok, true);
        assert.match(r.data.result ?? "", /CONTEXT BREAKDOWN/);
    } finally {
        await rig.closeAll();
    }
});

test("unknown conversation id is rejected without creating a session", async () => {
    const rig = await startRig();
    try {
        const r = await toolCall(rig, "conv-ghost");
        assert.equal(r.status, 404);
        assert.equal(r.data.ok, false);
        assert.match(r.data.error ?? "", /no model request has arrived/, "orphan-adoption trigger substring preserved");
        const st = await statusOf(rig, "conv-ghost");
        assert.notEqual(st.ok, true, "no session materialized for the fabricated id");
    } finally {
        await rig.closeAll();
    }
});

test("canonical pfa-* id (derived, not the client's own) routes to the right session; raw id still works", async () => {
    const rig = await startRig();
    try {
        await postModel(rig, "conv-canonical");
        await waitFor(() => rig.upstreamBodies.length >= 1, "one upstream body");
        const sys0 = sysText(rig.upstreamBodies[0]);
        assert.doesNotMatch(sys0, /Your bili conversation id/, "zero-injection: no model-visible id (#1685)");

        // Route by the CANONICAL id — a legacy model echo (or a host that
        // captured the id before #1685) still routes via the reverse lookup.
        const rCanon = await toolCall(rig, canonicalOf("conv-canonical"));
        assert.equal(rCanon.status, 200, `canonical-id routing succeeded: ${JSON.stringify(rCanon.data)}`);
        assert.equal(rCanon.data.ok, true);
        assert.match(rCanon.data.result ?? "", /CONTEXT BREAKDOWN/);

        // Backward compat: the raw client session id STILL routes.
        const rRaw = await toolCall(rig, "conv-canonical");
        assert.equal(rRaw.status, 200, `raw-id routing still succeeds: ${JSON.stringify(rRaw.data)}`);
        assert.equal(rRaw.data.ok, true);

        // A fabricated canonical-looking id is rejected and creates nothing.
        const rGhost = await toolCall(rig, "pfa-deadbeefdeadbeef");
        assert.equal(rGhost.status, 404);
        assert.match(rGhost.data.error ?? "", /no model request has arrived/);
    } finally {
        await rig.closeAll();
    }
});

test("successful MCP tool execution flips a wire-mode session to plugin mode (evidence-based)", async () => {
    const rig = await startRig();
    try {
        await postModel(rig, "conv-ev-a");
        await postModel(rig, "conv-ev-b");
        await waitFor(() => rig.upstreamBodies.length >= 2, "two upstream bodies");
        // Neither is bound yet — both wire mode.
        assert.notEqual((await statusOf(rig, "conv-ev-a")).pluginAgent, "mcp", "A starts in wire mode");
        // A successful tool call against A flips ONLY A.
        const r = await toolCall(rig, "conv-ev-a");
        assert.equal(r.status, 200, `tool call succeeded: ${JSON.stringify(r.data)}`);
        const stA = await statusOf(rig, "conv-ev-a");
        assert.equal(stA.pluginAgent, "mcp", "session flipped to plugin mode after its own MCP tool execution");
        const stB = await statusOf(rig, "conv-ev-b");
        assert.notEqual(stB.pluginAgent, "mcp", "sibling without a tool call stays wire mode");
    } finally {
        await rig.closeAll();
    }
});

interface ShellHarness {
    send(msg: unknown): void;
    settled: Promise<void>;
    lines: string[];
    kill(): void;
}

function spawnShell(env: Record<string, string>): ShellHarness {
    const shell = spawn(process.execPath, ["--import", "tsx", "src/mcp.ts"], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const settled = new Promise<void>((resolve, reject) => {
        shell.on("error", reject);
        shell.stdout.on("data", (d: Buffer) => {
            for (const l of d.toString().split("\n")) {
                if (l.trim()) lines.push(l.trim());
            }
        });
    });
    shell.stderr.on("data", () => {});
    return {
        send: (msg) => shell.stdin.write(JSON.stringify(msg) + "\n"),
        settled,
        lines,
        kill: () => shell.kill(),
    };
}

function byId(lines: string[], n: number): Record<string, unknown> {
    return JSON.parse(lines.find((l) => (JSON.parse(l) as { id?: number }).id === n) ?? "{}");
}

test("shared shim, no env/meta id: per-call ids route two sessions independently and flip them to plugin mode", async () => {
    const rig = await startRig();
    const h = spawnShell({
        BILI_MCP_PROXY: rig.proxyUrl(""),
        BILI_CONVERSATION_ID: "",
        CLAUDE_CODE_SESSION_ID: "",
    });
    try {
        h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
        h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        h.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        await waitFor(() => h.lines.length >= 2, "initialize + tools/list responses");
        const tools = byId(h.lines, 2) as { result?: { tools?: { inputSchema?: { properties?: Record<string, unknown> } }[] } };
        for (const t of tools.result?.tools ?? []) {
            assert.equal(t.inputSchema?.properties?.conversation_id, undefined, `shim does NOT expose conversation_id (#1685): ${JSON.stringify(t.inputSchema?.properties ?? {})}`);
        }

        // Session A exists; a per-call id (legacy model echo of the pre-#1685
        // schema) still routes immediately via the canonical reverse lookup.
        await postModel(rig, "conv-mcp-a");
        h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acp_status", arguments: { conversation_id: canonicalOf("conv-mcp-a") } } });
        await waitFor(() => h.lines.some((l) => (JSON.parse(l) as { id?: number }).id === 3), "per-call acp_status(A)");
        const callA = byId(h.lines, 3) as { result?: { content?: { text?: string }[]; isError?: boolean } };
        assert.equal(callA.result?.isError, false, `per-call call routed to A${callA.result?.isError ? ": " + (callA.result?.content?.[0]?.text ?? "") : ""}`);
        assert.match(callA.result?.content?.[0]?.text ?? "", /CONTEXT BREAKDOWN/);

        // An unrelated session lands between A's requests: the evidence-based
        // flip touches ONLY the session whose own tool executed, so this one
        // must NOT be flipped or routed to.
        await postModel(rig, "conv-other");
        await postModel(rig, "conv-mcp-a");
        await postModel(rig, "conv-mcp-b");
        h.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "acp_status", arguments: { conversation_id: canonicalOf("conv-mcp-b") } } });
        // Await the tool result BEFORE B's next request: real agents only
        // resume the model loop after the tool call returns, and the
        // evidence-based flip lands synchronously inside that call — the test
        // must mirror that order.
        await waitFor(() => h.lines.some((l) => (JSON.parse(l) as { id?: number }).id === 4), "per-call acp_status(B)");
        await postModel(rig, "conv-mcp-b");
        const callB = byId(h.lines, 4) as { result?: { content?: { text?: string }[]; isError?: boolean } };
        assert.equal(callB.result?.isError, false, `per-call call routed to B${callB.result?.isError ? ": " + (callB.result?.content?.[0]?.text ?? "") : ""}`);

        await waitFor(() => rig.upstreamBodies.length >= 5, "five upstream bodies");
        // A's first request: wire mode — ephemeral compress tool injected, zero id bytes.
        assert.ok(toolNames(rig.upstreamBodies[0]).includes("compress"), "wire request carries the ephemeral compress tool");
        assert.doesNotMatch(sysText(rig.upstreamBodies[0]), /Your bili conversation id/, "no id in wire mode (#1685)");
        // A's second request arrives AFTER the tool call landed:
        // pure plugin mode — no ephemeral tools, still zero id bytes.
        assert.ok(!toolNames(rig.upstreamBodies[2]).includes("compress"), "post-tool-call request drops the ephemeral compress tool");
        assert.doesNotMatch(sysText(rig.upstreamBodies[2]), /Your bili conversation id/, "no id in plugin mode either (#1685)");
        // B's requests never carry A's id — no cross-talk (trivially true now,
        // but pins the zero-injection invariant per session).
        assert.doesNotMatch(sysText(rig.upstreamBodies[3]), /Your bili conversation id/);

        // Sticky plugin-mode flip, and the untouched sibling stays wire mode.
        const stA = await statusOf(rig, "conv-mcp-a");
        assert.equal(stA.ok, true);
        assert.equal(stA.pluginAgent, "mcp", "A flipped to plugin mode via successful-tool evidence");
        const stB = await statusOf(rig, "conv-mcp-b");
        assert.equal(stB.pluginAgent, "mcp", "B flipped independently");
        const stOther = await statusOf(rig, "conv-other");
        assert.notEqual(stOther.pluginAgent, "mcp", "unrelated session NOT flipped (evidence flip touches only the session whose own tool ran)");

        // A repeat per-call call still routes to A.
        h.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "acp_status", arguments: { conversation_id: canonicalOf("conv-mcp-a") } } });
        await waitFor(() => h.lines.some((l) => (JSON.parse(l) as { id?: number }).id === 5), "repeat per-call acp_status(A)");
        const callA2 = byId(h.lines, 5) as { result?: { isError?: boolean } };
        assert.equal(callA2.result?.isError, false, "repeat call still routes to A");
    } finally {
        h.kill();
        await rig.closeAll();
    }
});

test("shim: per-call id strips the forwarded arg, routes on the body field, never registers or adopts for per-call ids", async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const mock = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            if (req.method === "POST") posts.push({ url: req.url ?? "", body });
            res.writeHead(200, { "content-type": "application/json" });
            if ((req.url ?? "").startsWith("/__bili/plugin/manifest")) {
                res.end(JSON.stringify({
                    ok: true, version: "t", protocolVersion: 1, toolNames: [],
                    tools: {
                        anthropic: [{ name: "acp_status", description: "", input_schema: { type: "object", properties: {}, required: [] } }],
                        openai: [], responses: [],
                    },
                    headers: {}, toolEndpoint: "/__bili/plugin/tool", statusEndpoint: "/__bili/plugin/status",
                }));
            } else if ((req.url ?? "").startsWith("/__bili/plugin/register")) {
                res.end(JSON.stringify({ ok: true }));
            } else if (body.conversationId === "GHOST") {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false, error: 'unknown plugin conversation id "GHOST" (no model request has arrived with this conversation id yet)' }));
            } else {
                res.end(JSON.stringify({ ok: true, result: "fine" }));
            }
        });
    });
    mock.listen(0, "127.0.0.1");
    await listen(mock);
    const mockPort = (mock.address() as { port: number }).port;
    const h = spawnShell({
        BILI_MCP_PROXY: `http://127.0.0.1:${mockPort}`,
        BILI_CONVERSATION_ID: "",
        CLAUDE_CODE_SESSION_ID: "",
    });
    try {
        h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
        h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        // No default binding → no register on initialize.
        // #1685: an id-less call no longer hard-fails in the shim — it is
        // FORWARDED and the proxy routes it (witness / arbitration); here the
        // mock answers any id-less tool POST with success.
        h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "acp_status", arguments: {} } });
        await waitFor(() => h.lines.some((l) => (JSON.parse(l) as { id?: number }).id === 2), "id-less call");
        const noId = byId(h.lines, 2) as { result?: { content?: { text?: string }[]; isError?: boolean } };
        assert.equal(noId.result?.isError, false, "id-less call forwarded to the proxy (#1685)");
        assert.equal(noId.result?.content?.[0]?.text, "fine");
        const idlessPost = posts.find((p) => p.url.startsWith("/__bili/plugin/tool"));
        assert.equal(idlessPost?.body.conversationId, undefined, "id-less POST carries no conversationId key");

        h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acp_status", arguments: { conversation_id: "X", extra: 1 } } });
        await waitFor(() => h.lines.some((l) => (JSON.parse(l) as { id?: number }).id === 3), "per-call X");
        const callX = byId(h.lines, 3) as { result?: { content?: { text?: string }[]; isError?: boolean } };
        assert.equal(callX.result?.isError, false);
        assert.equal(callX.result?.content?.[0]?.text, "fine");

        // No lazy registration for per-call ids anymore — the sticky flip comes
        // from successful-tool evidence inside the call, not from a registration
        // a raw-client-id request would never consume.
        assert.equal(posts.filter((p) => p.url.startsWith("/__bili/plugin/register")).length, 0, "no lazy registration issued for a per-call id");
        const toolPost = posts.find((p) => p.url.startsWith("/__bili/plugin/tool") && p.body.conversationId === "X");
        assert.equal(toolPost?.body.conversationId, "X", "routes on the body-level field");
        assert.deepEqual(toolPost?.body.args, { extra: 1 }, "conversation_id stripped from the forwarded args");

        // A repeat call still issues no registration.
        h.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "acp_status", arguments: { conversation_id: "X" } } });
        await waitFor(() => h.lines.some((l) => (JSON.parse(l) as { id?: number }).id === 4), "repeat per-call X");
        assert.equal(posts.filter((p) => p.url.startsWith("/__bili/plugin/register")).length, 0, "still no registration after a repeat call");

        // Unknown per-call id fails loudly — no orphan adoption (which would
        // mutate the shared default binding for everyone else's calls).
        h.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "acp_status", arguments: { conversation_id: "GHOST" } } });
        await waitFor(() => h.lines.some((l) => (JSON.parse(l) as { id?: number }).id === 5), "ghost per-call");
        const ghost = byId(h.lines, 5) as { result?: { content?: { text?: string }[]; isError?: boolean } };
        assert.equal(ghost.result?.isError, true, "unknown per-call id surfaces as a tool error");
        assert.match(ghost.result?.content?.[0]?.text ?? "", /no model request has arrived/);
        assert.ok(!posts.some((p) => p.url.startsWith("/__bili/plugin/status")), "no adoption lookup for per-call failures");
    } finally {
        h.kill();
        await close(mock);
    }
});
