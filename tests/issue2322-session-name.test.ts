import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate state + config so a developer's real billion-context.json and
// plugin-conversations.json never leak into the rig (wiring-test pattern).
const HOME = mkdtempSync(path.join(tmpdir(), "bc-2322-"));
process.env.HOME = HOME;
process.env.BILI_CONFIG_FILE = path.join(HOME, "billion-context.json");

// Imported AFTER the env isolation above.
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { listSessions } = await import("../src/session.ts");
const biliPlugin = (await import("../src/agent/pi.ts")).default;
import type { ProxyOptions } from "../src/config.ts";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function textScript(): string {
    return [
        "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ].join("");
}

type Rig = {
    proxyUrl: (p: string) => string;
    modelUrl: () => string;
    closeAll: () => Promise<void>;
};

async function startRig(): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "l2322-model": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyUrl: (p) => `http://127.0.0.1:${proxyPort}${p}`,
        modelUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        closeAll: async () => {
            await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
            await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
        },
    };
}

async function register(rig: Rig, conversationId: string): Promise<void> {
    const res = await fetch(rig.proxyUrl("/__bili/plugin/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent: "pi" }),
    });
    assert.equal(res.status, 200, "register accepted");
}

async function postModel(rig: Rig, text: string): Promise<Response> {
    return fetch(rig.modelUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin-conversation": "name-conv" },
        body: JSON.stringify({ model: "l2322-model", max_tokens: 8192, stream: true, messages: [{ role: "user", content: text }] }),
    });
}

async function webSessions(rig: Rig): Promise<{ sessions: Array<{ id: string; title?: string; label?: string }> }> {
    const res = await fetch(rig.proxyUrl("/__bili/sessions"));
    assert.equal(res.status, 200);
    return await res.json() as { sessions: Array<{ id: string; title?: string; label?: string }> };
}

test("plugin session-name endpoint: validation, set/rename/clear, display precedence (#2322)", async () => {
    const rig = await startRig();
    try {
        const post = (body: string): Promise<Response> => fetch(rig.proxyUrl("/__bili/plugin/session-name"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
        assert.equal((await post("not json")).status, 400, "invalid JSON rejected");
        assert.equal((await post("{}")).status, 400, "missing conversationId rejected");
        assert.equal((await post(JSON.stringify({ conversationId: "name-conv" }))).status, 400, "missing name rejected");
        assert.equal((await post(JSON.stringify({ conversationId: "name-conv", name: 42 }))).status, 400, "non-string name rejected");
        assert.equal((await post(JSON.stringify({ conversationId: "never-registered", name: "x" }))).status, 404, "unknown conversation rejected");

        const before = new Set(listSessions().map((s) => s.id));
        await register(rig, "name-conv");
        await postModel(rig, "hello world from the first message");
        const session = listSessions().find((s) => !before.has(s.id));
        assert.ok(session, "the model request created a new session");
        assert.ok(session.meta.title, "derived title set from the first user message");
        const derived = session.meta.title!;

        // Set: hostTitle wins over the derived title everywhere.
        let res = await post(JSON.stringify({ conversationId: "name-conv", name: "Fix auth bug" }));
        assert.equal(res.status, 200);
        assert.equal((await res.json() as { ok: boolean }).ok, true);
        assert.equal(session.meta.hostTitle, "Fix auth bug", "hostTitle stored on the session");
        assert.equal(session.meta.title, derived, "derived title untouched");
        let row = (await webSessions(rig)).sessions.find((s) => s.id === session.id);
        assert.equal(row?.title, "Fix auth bug", "web list prefers hostTitle (#2322)");
        const stats = await (await fetch(rig.proxyUrl("/__bili/stats"))).json() as { sessions?: Array<{ id: string; title?: string }> };
        assert.equal(stats.sessions?.find((x) => x.id === session.id)?.title, "Fix auth bug", "/__bili/stats prefers hostTitle (#2322 follow-up)");

        // Rename: latest-wins.
        await post(JSON.stringify({ conversationId: "name-conv", name: "renamed" }));
        assert.equal(session.meta.hostTitle, "renamed");

        // Whitespace normalization + length cap.
        await post(JSON.stringify({ conversationId: "name-conv", name: "  lots\n  of   space  " }));
        assert.equal(session.meta.hostTitle, "lots of space", "whitespace collapsed and trimmed");
        await post(JSON.stringify({ conversationId: "name-conv", name: "x".repeat(300) }));
        assert.equal(session.meta.hostTitle!.length, 200, "name capped at 200 chars");

        // Clear: empty string removes hostTitle; display falls back to derived.
        await post(JSON.stringify({ conversationId: "name-conv", name: "" }));
        assert.equal(session.meta.hostTitle, undefined, "empty name clears hostTitle");
        row = (await webSessions(rig)).sessions.find((s) => s.id === session.id);
        assert.equal(row?.title, derived, "display falls back to the derived title after clear");
    } finally {
        await rig.closeAll();
    }
});

test("pi plugin wiring: session_info_changed reports rename and clear end-to-end (#2322)", async () => {
    const rig = await startRig();
    // Intercept fetch to count session-name POSTs — the dedupe below must
    // hold at the source, not merely be idempotent on the server side.
    let namePosts = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (init?.method === "POST" && url.endsWith("/__bili/plugin/session-name")) namePosts += 1;
        return realFetch(input, init);
    }) as typeof fetch;
    try {
        process.env.BILLION_CONTEXT_PROXY = rig.proxyUrl("");
        const host = makeFakePi();
        const ctx = { sessionManager: { getSessionId: () => "pi-sid-2322" } };
        biliPlugin(host as never);
        const fire = async (event: Record<string, unknown>) => {
            for (const handler of host.events.get("session_info_changed") ?? []) await handler(event, ctx);
        };

        const before = new Set(listSessions().map((s) => s.id));
        await register(rig, "pi-sid-2322");
        // Plugin lane: the request carries the conversation header so the
        // session binds to the conversation the name POST will target.
        await fetch(rig.modelUrl(), {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-conversation": "pi-sid-2322" },
            body: JSON.stringify({ model: "l2322-model", max_tokens: 8192, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        const session = listSessions().find((s) => !before.has(s.id));
        assert.ok(session, "session bound to the conversation");

        // Rename: event name lands on the session via the endpoint.
        await fire({ type: "session_info_changed", name: "My named session" });
        await waitUntil(() => session.meta.hostTitle === "My named session" && namePosts === 1);
        assert.equal(session.meta.hostTitle, "My named session", "rename reported through the real endpoint");
        assert.equal(namePosts, 1, "rename POSTed exactly once");

        // Dedupe: an identical event must not re-POST (the map suppresses).
        // Immediate asserts are safe: suppression is decided synchronously at
        // dispatch, and step 1's settled success left the map armed.
        await fire({ type: "session_info_changed", name: "My named session" });
        assert.equal(session.meta.hostTitle, "My named session");
        assert.equal(namePosts, 1, "identical event suppressed — no re-POST");

        // Clear: name: undefined → empty string → hostTitle removed.
        await fire({ type: "session_info_changed", name: undefined });
        await waitUntil(() => session.meta.hostTitle === undefined && namePosts === 2);
        assert.equal(session.meta.hostTitle, undefined, "clear reported (undefined name → empty string)");
        assert.equal(namePosts, 2, "clear POSTed once");
    } finally {
        delete process.env.BILLION_CONTEXT_PROXY;
        globalThis.fetch = realFetch;
        await rig.closeAll();
    }
});

// reportSessionName is fire-and-forget by design (a report must never block
// the host event loop), so poll its observable effect instead of sleeping a
// fixed tick — a fixed sleep flakes whenever one loopback round-trip exceeds
// it (#2953).
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the session-name POST to settle");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
}

type PiHandler = (event: unknown, ctx: unknown) => unknown;
type FakePi = {
    events: Map<string, PiHandler[]>;
    on: (event: string, handler: PiHandler) => void;
    registerTool: (tool: unknown) => void;
    registerCommand: (name: string, options: unknown) => void;
    registerProvider: (name: string, config: { baseUrl: string }) => void;
};

function makeFakePi(): FakePi {
    const events = new Map<string, PiHandler[]>();
    return {
        events,
        // Real pi stores an ARRAY of handlers per event and awaits each
        // (issue2072 lesson) — a second registration for the same event
        // must APPEND, not replace.
        on: (event, handler) => {
            const list = events.get(event);
            if (list) list.push(handler);
            else events.set(event, [handler]);
        },
        registerTool: () => {},
        registerCommand: () => {},
        registerProvider: () => {},
    };
}
