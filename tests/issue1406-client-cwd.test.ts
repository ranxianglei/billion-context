import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import {
    handlePluginRegister,
    pluginReportedCwd,
    queuePluginRegister,
    sanitizeClientCwd,
    takePendingPluginRegister,
    consumePluginRegisterFor,
    _resetPluginStateForTest as _reset_for_test,
} from "../src/plugin.ts";
import { listSessions } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";

/**
 * #1406: client project directory transport. The proxy needs the CLIENT's
 * project directory to resolve project-level rules files (<cwd>/rules.md)
 * under the two-layer rules design (acp-kernel#446 follow-up) — its own
 * process.cwd() is wrong whenever the launcher attached to an already-
 * running proxy started elsewhere. Two transports: cooperative plugins stamp
 * x-bili-plugin-cwd per request (latest wins, tracks mid-session /cd);
 * launcher lanes that cannot stamp headers report `cwd` in the register
 * payload (seeds the session, never overrides a header value).
 */

function fakeRes(): import("node:http").ServerResponse & { written: string[] } {
    const written: string[] = [];
    return { writeHead: () => undefined, end: (body: string) => void written.push(body), written } as unknown as import("node:http").ServerResponse & { written: string[] };
}

test("sanitizeClientCwd rejects empty, overlong, newline-bearing and non-string values (#1406)", () => {
    assert.equal(sanitizeClientCwd("/projects/demo"), "/projects/demo");
    assert.equal(sanitizeClientCwd("  /projects/demo  "), "/projects/demo");
    assert.equal(sanitizeClientCwd(""), undefined);
    assert.equal(sanitizeClientCwd("   "), undefined);
    assert.equal(sanitizeClientCwd("x".repeat(4097)), undefined);
    assert.equal(sanitizeClientCwd("x".repeat(4096)), "x".repeat(4096));
    assert.equal(sanitizeClientCwd("/a\nb"), undefined);
    assert.equal(sanitizeClientCwd("/a\rb"), undefined);
    assert.equal(sanitizeClientCwd(42), undefined);
    assert.equal(sanitizeClientCwd(null), undefined);
    assert.equal(sanitizeClientCwd(undefined), undefined);
});

test("pluginReportedCwd honors the value only from requests that announce themselves as plugins (#1406)", () => {
    assert.equal(pluginReportedCwd({}), undefined);
    // Plain client stamping the internal header: ignored (same gate as the window/max-output reports).
    assert.equal(pluginReportedCwd({ "x-bili-plugin-cwd": "/sneaky" }), undefined);
    assert.equal(pluginReportedCwd({ "x-bili-plugin": "pi", "x-bili-plugin-cwd": "/proj/a" }), "/proj/a");
    assert.equal(pluginReportedCwd({ "x-bili-plugin": "pi", "x-bili-plugin-cwd": "" }), undefined);
    assert.equal(pluginReportedCwd({ "x-bili-plugin": ["pi"], "x-bili-plugin-cwd": ["/array/proj"] }), "/array/proj");
});

test("register payloads carry cwd through both identity and pending paths; malformed values are dropped (#1406)", () => {
    _reset_for_test();
    const res = fakeRes();

    handlePluginRegister(JSON.stringify({ conversationId: "cwd-id-1", agent: "claude", identity: true, cwd: "/proj/id" }), res);
    assert.ok(JSON.parse(res.written[0]!).ok, "register must succeed");
    assert.deepEqual(consumePluginRegisterFor("cwd-id-1"), { agent: "claude", cwd: "/proj/id" });
    // LRU refresh keeps the entry (and its cwd) for rebinding.
    assert.deepEqual(consumePluginRegisterFor("cwd-id-1"), { agent: "claude", cwd: "/proj/id" });

    handlePluginRegister(JSON.stringify({ conversationId: "cwd-pend-1", agent: "codex", identity: false, cwd: "/proj/pend" }), res);
    const pending = takePendingPluginRegister();
    assert.ok(pending, "pending register taken");
    assert.equal(pending!.conversationId, "cwd-pend-1");
    assert.equal(pending!.cwd, "/proj/pend");

    // Legacy registers without the field keep the exact old shape (no cwd key).
    queuePluginRegister("cwd-legacy", "pi", true);
    assert.deepEqual(consumePluginRegisterFor("cwd-legacy"), { agent: "pi" });

    // Malformed cwd: dropped, registration still succeeds.
    for (const bad of ["", "   ", "x".repeat(5000), "/a\nb", 42]) {
        handlePluginRegister(JSON.stringify({ conversationId: `cwd-bad-${typeof bad}-${String(bad).slice(0, 4)}`, agent: "pi", identity: true, cwd: bad }), res);
        const last = JSON.parse(res.written[res.written.length - 1]!) as { ok: boolean };
        assert.ok(last.ok, `register with malformed cwd ${JSON.stringify(String(bad)).slice(0, 24)} must still succeed`);
    }
    assert.equal(takePendingPluginRegister(), undefined, "malformed-value registers consumed nothing extra");
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function startEchoUpstream(): http.Server {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

type ChatMsg = { role: string; content: string };

async function chat(url: string, messages: ChatMsg[], conversation: string, extraHeaders: Record<string, string> = {}): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
    if (conversation) headers["x-acp-session"] = conversation;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-test", stream: true, messages }) });
    if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
    let raw = "";
    for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
    let reply = "";
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
            const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            reply += parsed.choices?.[0]?.delta?.content ?? "";
        } catch {
            /* ignore keepalives */
        }
    }
    return reply;
}

function proxyOpts(relayPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {} as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, { preserveRecentMessages: 2, preserveRecentTokens: 400 }),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        forkAdoption: false,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
}

test("headless register payload cwd seeds the bound session (#1406 e2e)", async () => {
    _reset_for_test();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conv = `cwd-headless-${run}`;
    const relay = startEchoUpstream();
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(relayPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;
    const preExisting = new Set(listSessions().map((s) => s.id));
    try {
        const reg = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, agent: "codex", identity: false, cwd: `/proj/${run}` }),
        });
        assert.ok(reg.ok, "register must succeed");

        // Anonymous first request claims the pending register (launcher mode:
        // no x-bili-plugin headers at all).
        const reply = await chat(url, [{ role: "user", content: "hello cwd headless" }], "");
        assert.ok(reply.length > 0, "headless turn must produce a reply");
        const session = listSessions().find((s) => !preExisting.has(s.id));
        assert.ok(session, "request must create a new session");
        assert.equal(session.metadata.clientCwd, `/proj/${run}`, "register payload seeds metadata.clientCwd");
    } finally {
        await close(proxy);
        await close(relay);
    }
});

test("identity register payload cwd seeds the identity-bound session (#1406 e2e)", async () => {
    _reset_for_test();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conv = `cwd-identity-${run}`;
    const relay = startEchoUpstream();
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(relayPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;
    const preExisting = new Set(listSessions().map((s) => s.id));
    try {
        const reg = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, agent: "claude", identity: true, cwd: `/proj/${run}` }),
        });
        assert.ok(reg.ok, "register must succeed");

        const reply = await chat(url, [{ role: "user", content: "hello cwd identity" }], conv);
        assert.ok(reply.length > 0, "identity turn must produce a reply");
        const session = listSessions().find((s) => !preExisting.has(s.id));
        assert.ok(session, "request must create a new session");
        assert.equal(session.metadata.clientCwd, `/proj/${run}`, "identity register payload seeds metadata.clientCwd");
    } finally {
        await close(proxy);
        await close(relay);
    }
});

test("per-request x-bili-plugin-cwd wins over the register seed and tracks mid-session changes (#1406 e2e)", async () => {
    _reset_for_test();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conv = `cwd-header-${run}`;
    const relay = startEchoUpstream();
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(relayPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;
    const preExisting = new Set(listSessions().map((s) => s.id));
    try {
        // Register carries a STALE cwd; the plugin stamps the real one per request.
        const reg = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, agent: "pi", identity: true, cwd: `/stale/${run}` }),
        });
        assert.ok(reg.ok, "register must succeed");

        const piHeaders = { "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv };
        const reply1 = await chat(url, [{ role: "user", content: "turn one" }], "", { ...piHeaders, "x-bili-plugin-cwd": `/proj/a-${run}` });
        assert.ok(reply1.length > 0, "turn one must produce a reply");
        let session = listSessions().find((s) => !preExisting.has(s.id));
        assert.ok(session, "turn one must create a session");
        assert.equal(session.metadata.clientCwd, `/proj/a-${run}`, "header wins over the stale register seed");

        // Mid-session /cd: latest request value wins.
        const reply2 = await chat(url, [{ role: "user", content: "turn one" }, { role: "assistant", content: "ok" }, { role: "user", content: "turn two" }], "", { ...piHeaders, "x-bili-plugin-cwd": `/proj/b-${run}` });
        assert.ok(reply2.length > 0, "turn two must produce a reply");
        session = listSessions().find((s) => !preExisting.has(s.id));
        assert.ok(session, "turn two must resolve the same session");
        assert.equal(session.metadata.clientCwd, `/proj/b-${run}`, "latest-wins per request");
    } finally {
        await close(proxy);
        await close(relay);
    }
});

test("oversized x-bili-plugin-cwd is not stored (#1406 e2e)", async () => {
    _reset_for_test();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conv = `cwd-oversize-${run}`;
    const relay = startEchoUpstream();
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(relayPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;
    const preExisting = new Set(listSessions().map((s) => s.id));
    try {
        const piHeaders = { "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv, "x-bili-plugin-cwd": "x".repeat(5000) };
        const reply = await chat(url, [{ role: "user", content: "oversized cwd" }], "", piHeaders);
        assert.ok(reply.length > 0, "turn must produce a reply");
        const session = listSessions().find((s) => !preExisting.has(s.id));
        assert.ok(session, "request must create a session");
        assert.equal(session.metadata.clientCwd, undefined, "overlong cwd rejected, nothing stored");
    } finally {
        await close(proxy);
        await close(relay);
    }
});
