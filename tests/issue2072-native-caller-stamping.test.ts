// #2072: every host-native agent lane forwarded tools through
// shared.forwardTool WITHOUT the nativeCaller flag, so a stale unique
// outbound witness (#1685) could silently reroute a confirmed host-stamped
// caller onto a sibling subagent's session (owner repro: two Pi subagents,
// identical empty-args acp_status({}) calls inside the witness TTL). Pins the
// production fix end-to-end with REAL pi plugin hosts over a REAL proxy:
//   1. incident shape — host A calls a tool whose exact (tool, args) pair was
//      just streamed by sibling host B: A's flagged call routes HOME past the
//      conflicting witness, while UNFLAGGED callers keep master's exact
//      contract byte-for-byte (a conflicting resolvable id fails closed
//      409 TOOL_CONVERSATION_CONFLICT, #2016; an id-less call still routes by
//      the unique witness, #1685);
//   2. loud failure — a registered-but-never-requested host (issue form ②)
//      fails with the #1158 diagnostic instead of adopting the sibling's
//      state (no rescue, no sibling adoption).
// Client-side body-contract legs live in tests/plugin-agent.test.ts
// (forwardTool stamps per the mcp.ts:136 rule); the pure server-side policy
// is pinned by tests/mcp-native-thread.test.ts Part B.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { after } from "node:test";
import type { ProxyOptions } from "../src/config.ts";

// XDG env BEFORE importing the server (mcp-native-thread.test.ts pattern):
// boot's loadConversations() would otherwise hydrate live production
// conversations into the routing table.
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-native-caller-"));
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
const biliPlugin = (await import("../src/agent/pi.ts")).default;

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

/** Deterministic fake chat upstream. A request whose user text carries
 *  `WITNESS:<tool>` is answered with a NON-STREAM JSON assistant message
 *  containing that tool call with EMPTY arguments (recording lane 5, #1692)
 *  — the exact collision shape of the owner repro. Everything else gets a
 *  plain text answer. */
function startRelay(): http.Server {
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
    return server;
}

type Harness = {
    baseUrl: string;
    chatUrl: string;
    relayUpstream: string;
    relay: http.Server;
    stop: () => Promise<void>;
};

async function boot(): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    resetToolRingForTest();
    _resetPluginStateForTest();
    const relay = startRelay();
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
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
    const relayUpstream = `http://127.0.0.1:${relayPort}`;
    return {
        baseUrl: `http://127.0.0.1:${proxyPort}`,
        chatUrl: `http://127.0.0.1:${proxyPort}/bili/${relayUpstream}/v1/chat/completions`,
        relayUpstream,
        relay,
        stop: async () => {
            await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
            await new Promise<void>((resolve, reject) => relay.close((e) => (e ? reject(e) : resolve())));
        },
    };
}

type TextBlock = { type: "text"; text: string };
type FakeTool = { name: string; parameters: unknown; execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: Record<string, unknown>) => Promise<{ content: TextBlock[]; isError?: boolean }> };
type PiHandler = (event: unknown, ctx: unknown) => unknown;
type FakePi = {
    // Real pi stores an ARRAY of handlers per event name and awaits each
    // (pi-coding-agent@0.83.0 runner.js emit(): `ext.handlers.get(type)` →
    // `for (const handler of handlers)`), so a second registration for the
    // same event (e.g. the embedded subagents wiring) must APPEND, not
    // replace. A Map-of-one would silently drop the factory's own handler.
    events: Map<string, PiHandler[]>;
    tools: FakeTool[];
    commands: Map<string, unknown>;
    providers: Map<string, string>;
    on: (event: string, handler: PiHandler) => void;
    registerTool: (tool: FakeTool) => void;
    registerCommand: (name: string, options: unknown) => void;
    registerProvider: (name: string, config: { baseUrl: string }) => void;
};

function makeFakePi(): FakePi {
    const events = new Map<string, PiHandler[]>();
    const tools: FakeTool[] = [];
    const commands = new Map<string, unknown>();
    const providers = new Map<string, string>();
    return {
        events,
        tools,
        commands,
        providers,
        on: (event, handler) => {
            const list = events.get(event);
            if (list) list.push(handler);
            else events.set(event, [handler]);
        },
        registerTool: (tool) => {
            const i = tools.findIndex((t) => t.name === tool.name);
            if (i >= 0) tools[i] = tool;
            else tools.push(tool);
        },
        registerCommand: (name, options) => { commands.set(name, options); },
        registerProvider: (name, config) => { providers.set(name, config.baseUrl); },
    };
}

/** A real pi plugin host bound to its own machine session id — the
 *  conversation id the plugin stamps comes from ctx.sessionManager, exactly
 *  like the owner repro (src/agent/pi.ts getSessionId()). */
async function makeHost(h: Harness, sid: string): Promise<{ host: FakePi; ctx: Record<string, unknown> }> {
    const host = makeFakePi();
    const ctx: Record<string, unknown> = {
        sessionManager: { getSessionId: () => sid },
        model: { contextWindow: 1_000_000, baseUrl: `${h.baseUrl}/bili/${h.relayUpstream}/v1/chat/completions` },
        cwd: "/tmp",
    };
    biliPlugin(host as never);
    for (const handler of host.events.get("session_start") ?? []) await handler({}, ctx);
    const deadline = Date.now() + 15000;
    while (!host.tools.some((t) => t.name === "acp_cache")) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for the acp_cache tool on ${sid}`);
        await new Promise((r) => setTimeout(r, 25));
    }
    return { host, ctx };
}

async function stampedChatHeaders(host: FakePi, ctx: Record<string, unknown>): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const handler of host.events.get("before_provider_headers") ?? []) await handler({ headers }, ctx);
    headers["x-bili-plugin-model"] = "gpt-test";
    return headers;
}

async function modelTurn(h: Harness, headers: Record<string, string>, userText: string): Promise<void> {
    const res = await fetch(h.chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: userText }] }),
    });
    assert.equal(res.status, 200, `model turn for ${headers["x-bili-plugin-conversation"]} must succeed`);
    await res.json();
}

async function toolPost(h: Harness, body: Record<string, unknown>): Promise<{ status: number; json: { ok?: boolean; result?: string; error?: string } | null }> {
    const res = await fetch(`${h.baseUrl}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as { ok?: boolean; result?: string; error?: string } | null };
}

/** The served session's Web UI deep link (contains its session id) — the
 *  oracle for WHICH conversation a tool execution ran against. acp_cache
 *  prefixes its result with the link. */
async function webUrlOf(h: Harness, conv: string): Promise<string> {
    const res = await fetch(`${h.baseUrl}/__bili/plugin/status?conversationId=${encodeURIComponent(conv)}`);
    assert.equal(res.status, 200, `status for ${conv} must resolve`);
    const json = (await res.json()) as { webUrl?: string | null };
    assert.ok(typeof json.webUrl === "string" && json.webUrl.length > 0, `status for ${conv} must expose its webUrl`);
    return json.webUrl;
}

test("#2072 e2e: flagged host-stamped caller routes home past a conflicting sibling witness; unflagged contract unchanged", async () => {
    const h = await boot();
    try {
        const a = await makeHost(h, "nt-a");
        const b = await makeHost(h, "nt-b");
        const headersA = await stampedChatHeaders(a.host, a.ctx);
        const headersB = await stampedChatHeaders(b.host, b.ctx);
        assert.equal(headersA["x-bili-plugin-conversation"], "nt-a");
        assert.equal(headersB["x-bili-plugin-conversation"], "nt-b");

        // Sibling B streams the very (acp_cache, {}) call A is about to make —
        // its unique witness now names nt-b.
        await modelTurn(h, headersA, "alpha plain turn");
        await modelTurn(h, headersB, "WITNESS:acp_cache beta streams the identical tool call");
        const urlA = await webUrlOf(h, "nt-a");
        const urlB = await webUrlOf(h, "nt-b");
        assert.notEqual(urlA, urlB);

        // The incident: A executes its OWN registered acp_cache tool with
        // colliding empty args. Post-fix the flagged call must serve A.
        const cacheA = a.host.tools.find((t) => t.name === "acp_cache")!;
        const out = await cacheA.execute("call-1", {}, undefined, undefined, a.ctx);
        assert.equal(out.isError, undefined, `host A's own tool call must succeed, got: ${out.content[0]?.text}`);
        const textA = out.content[0]!.text;
        assert.ok(textA.includes(urlA), "the NATIVE caller's session must be served, not the witnessing one");
        assert.ok(!textA.includes(urlB), "the witnessing sibling's session must NOT be served");

        // Control legs: unflagged callers follow master's contract byte-for-
        // byte — a conflicting resolvable id fails closed (#2016), and an
        // id-less call still routes by the unique witness (#1685).
        const r = await toolPost(h, { tool: "acp_cache", args: {}, conversationId: "nt-a" });
        assert.equal(r.status, 409, "an unflagged conflicting id must fail closed on master's contract");
        assert.equal((r.json as Record<string, unknown> | null)?.code, "TOOL_CONVERSATION_CONFLICT");
        const r2 = await toolPost(h, { tool: "acp_cache", args: {} });
        assert.equal(r2.status, 200);
        assert.ok(String(r2.json?.result ?? "").includes(urlB), "an id-less unflagged call must still route by the unique witness (#1685)");
        assert.ok(!String(r2.json?.result ?? "").includes(urlA));
    } finally {
        await h.stop();
    }
});

test("#2072 e2e: registered-but-never-requested host fails loudly — no witness rescue, no sibling adoption", async () => {
    const h = await boot();
    try {
        const b = await makeHost(h, "nt-b");
        const c = await makeHost(h, "nt-c");
        const headersB = await stampedChatHeaders(b.host, b.ctx);
        await modelTurn(h, headersB, "WITNESS:acp_cache beta witness turn");

        // Host C registered but never sent a model request (issue form ②):
        // pre-fix it silently received B's panel through the stale witness;
        // post-fix its flagged id fails loudly with the #1158 diagnostic.
        const cacheC = c.host.tools.find((t) => t.name === "acp_cache")!;
        const out = await cacheC.execute("call-2", {}, undefined, undefined, c.ctx);
        assert.equal(out.isError, true, "an unknown flagged caller must fail loudly instead of adopting the sibling");
        assert.match(out.content[0]!.text, /no model request has arrived with this conversation id yet/, "#1158 diagnostic must point at the id");
    } finally {
        await h.stop();
    }
});
