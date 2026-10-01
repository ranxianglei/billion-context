// E2E: #1685 plugin tool-call routing ladder — sediment of the 2026-09-30
// real-machine matrix (issue #1611 / PR #1692 verification session). Every
// scenario below was first probed live against a production instance with
// curl; this file pins the same ladder hermetically:
//
//   rung 1  outbound tool_use witness — the proxy streamed the very call
//           being answered, so the id-less POST routes to the session that
//           owns the streamed tool_use (unique witness wins even over a
//           differing body id);
//   rung 2  body conversationId — legacy/extension hosts (no witness yet);
//           an id no model request ever arrived under is a loud 400, never
//           a guess (#1158 diagnostic);
//   rung 3  single-active arbitration — no witness, no id, exactly one
//           fresh conversation on the proxy;
//   rung 4  refuse-to-guess — no witness, no id, two fresh conversations:
//           loud 400 naming the ambiguity.
//
// The MCP shim leg (codex-style host: no plugin headers, identity only via
// BILI_MCP_PROXY + BILI_CONVERSATION_ID) is covered by spawning the REAL
// src/mcp.ts over stdio JSON-RPC — no codex binary needed, the shim is the
// client contract codex exercises.
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

// XDG env BEFORE importing the server (auto-restart.test.ts pattern):
// stateDir() resolves XDG_STATE_HOME per call, but loadConversations() at
// boot would otherwise read the DEVELOPER'S production
// plugin-conversations.json — live sessions from real traffic would count
// as "fresh conversations" and break the single-active arbitration
// assertions below.
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-tool-routing-"));
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
    requests: { conv: string | undefined; body: string }[];
};

/** Deterministic fake chat upstream. A request whose user text carries the
 *  marker `WITNESS:<tool>` is answered with a NON-STREAM JSON assistant
 *  message containing that tool call — the proxy's fifth recording lane
 *  (#1692: plain-JSON responses record witnesses too). Everything else gets
 *  a plain text answer. */
function startRelay(): Relay {
    const requests: { conv: string | undefined; body: string }[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const conv = req.headers["x-bili-plugin-conversation"];
            requests.push({ conv: Array.isArray(conv) ? conv[0] : conv, body });
            const marker = /WITNESS:([a-z_]+)/.exec(body)?.[1];
            if (marker) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "r1", object: "chat.completion",
                    choices: [{
                        index: 0,
                        message: {
                            role: "assistant",
                            content: null,
                            tool_calls: [{ type: "function", function: { name: marker, arguments: "{}" } }],
                        },
                        finish_reason: "tool_calls",
                    }],
                    usage: { prompt_tokens: 100, completion_tokens: 2 },
                }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "r1", object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "plain reply" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
        });
    });
    server.listen(0, "127.0.0.1");
    return { server, requests };
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

async function toolPost(h: Harness, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await fetch(`${h.baseUrl}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

test("plugin tool routing ladder: arb → witness beats two-active → refuse-to-guess → loud 400 on unknown body id", async () => {
    const h = await boot();
    try {
        // ── rung 3: single fresh conversation, no witness → arbitration ──
        await modelTurn(h, "routing-conv-a", "plain turn one for the arbitration leg");
        let r = await toolPost(h, { tool: "acp_status" });
        assert.equal(r.status, 200, "single-active arbitration must route the id-less call");
        assert.equal(r.json?.ok, true);

        // ── rung 1: second conversation streams an acp_status tool_use in a
        // plain-JSON (non-stream) response — recording lane 5 (#1692) ──
        await modelTurn(h, "routing-conv-b", "WITNESS:acp_status turn that streams the tool call");
        // With TWO fresh conversations arbitration can only 400 — so a 200 now
        // proves the outbound witness matched, and the only ring entry belongs
        // to routing-conv-b.
        r = await toolPost(h, { tool: "acp_status" });
        assert.equal(r.status, 200, "witness must route even with two conversations active (arb would refuse)");
        assert.equal(r.json?.ok, true);

        // ── rung 4: no witness for this tool, no id, two fresh convs ──
        r = await toolPost(h, { tool: "search_context", args: { query: "routing ladder probe" } });
        assert.equal(r.status, 400, "refuse-to-guess when no witness, no id, two active conversations");
        assert.match(String(r.json?.error), /refuse to guess/, "the refusal must name the ambiguity loudly");

        // ── rung 2: body id that no model request ever arrived under ──
        r = await toolPost(h, { tool: "search_context", args: { query: "bogus id probe" }, conversationId: "routing-bogus" });
        assert.equal(r.status, 404, "unknown body conversation id must fail loudly, never guess");
        assert.match(String(r.json?.error), /no model request has arrived with this conversation id yet/, "#1158 diagnostic must point at the id");
    } finally {
        await h.stop();
    }
});

/** Drive the REAL MCP shim (src/mcp.ts) over stdio JSON-RPC the way a codex
 *  host does: no plugin headers, identity from spawn env only. Env is spread
 *  from process.env (issue760 spawnShell pattern) — a stripped env loses
 *  SystemRoot/PATH on Windows and the shim spawn fails before it can reply. */
function mcpCall(baseUrl: string, conversationId: string, method: string, params: Record<string, unknown> | undefined, id: number): Promise<{ stdout: string[]; stderr: string }> {
    return new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            BILI_MCP_PROXY: baseUrl,
            BILI_CONVERSATION_ID: conversationId,
            CLAUDE_CODE_SESSION_ID: "",
        };
        const child = spawn(process.execPath, ["--import", "tsx", "src/mcp.ts"], {
            cwd: process.cwd(),
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: string[] = [];
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`mcp shim timed out; stderr: ${stderr}`));
        }, 30_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (d: string) => {
            for (const line of d.split("\n")) if (line.trim()) stdout.push(line);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d: string) => { stderr += d; });
        child.on("error", reject);
        const send = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`);
        // MCP handshake first (initialize → initialized), then the real call —
        // the exact order a codex host drives the shim in. stdin stays OPEN:
        // the shim exits on stdin end (src/mcp.ts `"end" → process.exit(0)`),
        // so ending it early would kill an in-flight reply — the exact flake
        // the first push hit on every CI lane. We wait for the reply, then kill.
        send({ jsonrpc: "2.0", id: id - 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id, method, params });
        const waitForReply = (): void => {
            const hit = stdout.find((l) => { try { return JSON.parse(l)?.id === id; } catch { return false; } });
            if (hit !== undefined) {
                clearTimeout(timer);
                child.kill();
                return;
            }
            setTimeout(waitForReply, 50);
        };
        waitForReply();
        child.on("close", () => {
            clearTimeout(timer);
            resolve({ stdout, stderr });
        });
    });
}

test("MCP shim (codex-style host): body-id lane routes a registered conversation over stdio JSON-RPC", async () => {
    const h = await boot();
    try {
        // Register the conversation with a real model turn through the proxy,
        // then clear the ring so the shim's call exercises the body-id lane
        // deterministically (no witness interference).
        await modelTurn(h, "routing-mcp-a", "plain turn for the mcp shim leg");
        resetToolRingForTest();
        const { stdout, stderr } = await mcpCall(h.baseUrl, "routing-mcp-a", "tools/call", { name: "acp_status", arguments: {} }, 7);
        const replies = stdout.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<{ id?: number; result?: { content?: Array<{ text?: string }> } }>;
        const ours = replies.find((x) => x.id === 7);
        assert.ok(ours, `shim must answer the tools/call request; stderr: ${stderr.slice(0, 400)}`);
        const text = ours.result?.content?.map((c) => c.text ?? "").join("") ?? "";
        assert.match(text, /ACTIVE SURFACE/, "acp_status result must come back through the shim");
    } finally {
        await h.stop();
    }
});
