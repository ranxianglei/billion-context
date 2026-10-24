// #4526 regression: pi inline mode (BILI_PI_INLINE) must ALSO intercept the
// Codex Responses WebSocket lane. Pre-fix, the inline branch skipped
// installNativeWebSocketIntercept entirely (on the false premise "the pi lane
// does not use codex WS"), so codex WS traffic dialed the model directly —
// uncompressed, with no ACP session record. Now the engine binds a
// loopback-only WS bridge and the patched global WebSocket routes into it.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

// Hermetic XDG homes (store modules resolve paths lazily, but set these
// before any src import anyway) + never patch globals / spawn proxies.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue4526-"));
const PREV_ENV: Record<string, string | undefined> = {};
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "NODE_TEST_CONTEXT", "BILI_PI_INLINE", "BILLION_CONTEXT_PROXY"]) {
    PREV_ENV[key] = process.env[key];
    if (key.startsWith("XDG")) process.env[key] = ROOT;
}
process.env.NODE_TEST_CONTEXT = "1";

type Item = Record<string, unknown>;
const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

let serial = 0;
const rows: Array<{ request: Item; headers: http.IncomingHttpHeaders }> = [];
let upstream: http.Server;
let wss: WebSocketServer;
let upstreamOrigin = "";

test.before(async () => {
    // Mock Codex Responses-over-WS upstream: JSON frames, probe + turns.
    upstream = http.createServer((_req, res) => { res.writeHead(404).end(); });
    wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (peer, req) => {
        peer.on("error", () => {});
        peer.on("message", (raw) => {
            const request = JSON.parse(raw.toString()) as Item;
            rows.push({ request, headers: req.headers });
            const id = `resp_inline_${++serial}`;
            const send = (type: string, fields: Item): void => peer.send(JSON.stringify({ type, ...fields }));
            if (Array.isArray(request.input) && request.input.length === 0) {
                send("response.created", { response: { id, status: "in_progress", output: [] } });
                send("response.completed", { response: { id, status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 } } });
                return;
            }
            const item: Item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `ok-${serial}` }] };
            send("response.created", { response: { id, status: "in_progress", output: [] } });
            send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
            send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: `ok-${serial}` });
            send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: `ok-${serial}` });
            send("response.output_item.done", { output_index: 0, item });
            send("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 } } });
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});

test.after(async () => {
    for (const client of wss.clients) client.terminate();
    await Promise.all([
        new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    wss.close();
    const { _closeInlineWsBridgeForTest, _resetInlineEngineForTest } = await import("../src/inline-engine.js");
    await _closeInlineWsBridgeForTest();
    _resetInlineEngineForTest();
    const { flushConversations } = await import("../src/plugin.js");
    const { flushAllSessions } = await import("../src/session.js");
    flushConversations();
    await flushAllSessions();
    for (const [key, prev] of Object.entries(PREV_ENV)) {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
});

const bridgeOriginOf = async (): Promise<string> => {
    const { getInlineEngine, INLINE_ORIGIN } = await import("../src/inline-engine.js");
    const engine = await getInlineEngine();
    assert.equal(engine.origin, INLINE_ORIGIN);
    assert.match(engine.wsOrigin ?? "", /^http:\/\/127\.0\.0\.1:\d+$/, "the engine exposes a dialable loopback WS origin");
    return engine.wsOrigin!;
};

const frame = (sid: string, input: Item[], extra: Item = {}): string => JSON.stringify({
    type: "response.create", model: "gpt-5.2", instructions: "You are Codex", store: false, stream: true,
    prompt_cache_key: sid, tools: [], input, client_metadata: { session_id: sid, thread_id: sid }, ...extra,
});

// EventTarget-only surface: satisfied by BOTH the raw ws-package client and
// the DeferredWebSocket shell the intercept hands back (the shell records
// window-phase listeners and replays them on attach; post-attach calls proxy
// straight through to the real socket).
// Listener param is `unknown` so BOTH the ws package's typed listener union
// (MessageEvent & co.) and the shell's EventListener satisfy the interface.
interface Exchangeable {
    send(data: unknown): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
}

async function exchange(payload: string, client: Exchangeable): Promise<Item[]> {
    client.send(payload);
    return new Promise((resolve, reject) => {
        const events: Item[] = [];
        let done = false;
        const finish = (outcome: (() => void) | undefined, err?: Error): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            client.removeEventListener("message", onMessage);
            client.removeEventListener("close", onClose);
            if (err !== undefined) reject(err);
            else outcome?.();
        };
        const timer = setTimeout(() => finish(undefined, new Error("WS turn timed out")), 15000);
        const onClose = (): void => { finish(undefined, new Error("WS client closed")); };
        const onMessage = (event: unknown): void => {
            const parsed = JSON.parse(String((event as { data?: unknown }).data)) as Item;
            events.push(parsed);
            if (["response.completed", "response.failed", "response.incomplete", "error"].includes(String(parsed.type))) {
                finish(() => resolve(events));
            }
        };
        client.addEventListener("message", onMessage);
        client.addEventListener("close", onClose);
    });
}

const completed = (events: Item[]): Item => {
    const event = events.find((e) => e.type === "response.completed");
    assert.ok(event, JSON.stringify(events));
    return event.response as Item;
};

test("bridge: the inline engine binds a loopback-only upgrade listener with sane fallthroughs", { timeout: 30000 }, async () => {
    const bridge = await bridgeOriginOf();
    const sid = randomUUID();
    // Plain HTTP gets 404 — this port exists for upgrades only.
    const res = await fetch(`${bridge}/`);
    assert.equal(res.status, 404);
    // Unclaimed upgrade shapes get the 426 contract (server.ts parity):
    // codex's fast-fallback switches to HTTP POST on a clean 426.
    // ws-package 'unexpected-response' delivers (request, RESPONSE, head) —
    // the status code rides on the second argument.
    const expectStatus = (client: WebSocket): Promise<number> => new Promise((resolve, reject) => {
        client.on("error", () => {});
        client.on("unexpected-response", (_req: unknown, res: { statusCode?: number; socket?: { destroy: () => void } }) => { res.socket?.destroy(); resolve(res.statusCode ?? -1); });
        client.on("open", () => reject(new Error("unexpected upgrade success")));
        setTimeout(() => reject(new Error("timed out waiting for the refusal")), 5000);
    });
    // Unclaimed upgrade shapes get the 426 contract (server.ts parity):
    // codex's fast-fallback switches to HTTP POST on a clean 426.
    assert.equal(
        await expectStatus(new WebSocket(`${bridge.replace(/^http/, "ws")}/__acp/status`, { headers: { "session-id": sid } })),
        426,
    );
    // Admission still requires a conversation id (#2111 gate).
    assert.equal(
        await expectStatus(new WebSocket(`${bridge.replace(/^http/, "ws")}/bili/${upstreamOrigin}/v1/responses`, {})),
        426,
    );
});

test("bridge: codex WS rides the IN-PROCESS pipeline — probe + turn, ACP session recorded", { timeout: 30000 }, async () => {
    const bridge = await bridgeOriginOf();
    const sid = `pi-inline-${randomUUID()}`;
    const client = new WebSocket(`${bridge.replace(/^http/, "ws")}/bili/${upstreamOrigin}/v1/responses`, {
        headers: { authorization: "Bearer fake-credential", "session-id": sid, "thread-id": sid, "user-agent": "codex_exec/0.147.0" },
    });
    client.on("error", () => {});
    await once(client, "open");
    const baseRows = rows.length;
    try {
        const probeEvents = await exchange(frame(sid, [], { generate: false }), client);
        assert.equal(completed(probeEvents).status, "completed");
        const turnEvents = await exchange(frame(sid, [user("pi-inline-codex-ws")]), client);
        const done = completed(turnEvents);
        assert.equal(done.status, "completed");
        assert.ok(JSON.stringify(done.output).includes("ok-"));
        // Probe forwarded verbatim; the turn went THROUGH the pipeline —
        // bili's ACP tools ride alongside codex's (empty) tool list.
        assert.equal(rows.length, baseRows + 2);
        assert.deepEqual(rows[baseRows].request.input, []);
        assert.equal(rows[baseRows].request.generate, false);
        assert.ok(Array.isArray(rows[baseRows + 1].request.tools) && (rows[baseRows + 1].request.tools as Item[]).some((t) => t.name === "acp_status" || t.name === "compress"), JSON.stringify((rows[baseRows + 1].request.tools as Item[] | undefined)?.map?.((t) => t.name)));
        assert.ok(JSON.stringify(rows[baseRows + 1].request.input).includes("pi-inline-codex-ws"));
        assert.equal(rows[baseRows + 1].headers["session-id"], sid);
        // The issue's second complaint: inline mode left NO ACP session record.
        const { peekSession } = await import("../src/session.js");
        const session = peekSession(sid);
        assert.ok(session, "an ACP session exists for the bridged conversation");
        assert.equal(session.stats.requests, 1);
    } finally {
        client.terminate();
    }
});

test("client wiring: BILI_PI_INLINE=on arms the inline lane and the patched global WebSocket reaches the bridge", { timeout: 30000 }, async () => {
    const bridge = await bridgeOriginOf();
    // Relaxed switch value ("on" was the silent-spawn trap, #4526) + fresh
    // module import so the module-level plan sees it.
    process.env.BILI_PI_INLINE = "on";
    const pi = await import("../src/agent/pi-native.js");
    const state = pi._nativeStateForTest();
    assert.equal(state.origin, "http://billion-context.inline", "'on' planned the inline lane (pre-fix it spawned a proxy)");
    assert.equal(typeof state.resolveInlineWs, "function");
    const { installNativeWebSocketIntercept, _resetForTest } = await import("../src/agent/native-ws-intercept.js");
    const saved = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", { value: WebSocket, writable: true, configurable: true });
    try {
        installNativeWebSocketIntercept(state);
        const sid = `pi-inline-client-${randomUUID()}`;
        const top = (globalThis as Record<string, unknown>).WebSocket as new (...args: unknown[]) => WebSocket;
        // The claimable URL embeds the LIVE mock upstream: the bridge dials it
        // as the tunnel destination, so it must be reachable. The mock answers
        // frames on any path, so a degrade-direct regression would still make
        // the exchanges below succeed — the /bili/ url assertion is what pins
        // the routing decision.
        const targetWs = upstreamOrigin.replace(/^http/, "ws") + "/backend-api/codex/responses";
        // Constructed while the engine decision is still pending → deferred
        // shell; awaiting the respawn seam settles it onto the real bridge.
        const ws = new top(targetWs, {
            headers: { authorization: "Bearer fake-credential", "session-id": sid, "thread-id": sid },
        });
        // Swallow dial failures: a regression that degrades this connection
        // direct must fail the assertions below, not crash on an unhandled 'error'.
        (ws as unknown as { addEventListener: (type: string, listener: unknown) => void }).addEventListener("error", () => {});
        const respawn = pi._stateRespawnForTest();
        assert.ok(respawn !== undefined, "arm wired the runtime-recovery seam");
        await respawn();
        await new Promise<void>((resolve) => {
            const deadline = Date.now() + 10000;
            const poll = setInterval(() => {
                if ((ws as WebSocket).readyState === WebSocket.OPEN || Date.now() >= deadline) {
                    clearInterval(poll);
                    resolve();
                }
            }, 10);
        });
        assert.equal((ws as WebSocket).readyState, WebSocket.OPEN, "the shell attached to a live bridge connection");
        assert.ok((ws as WebSocket).url.includes("/bili/"), "the wrapper rewrote the dial to the loopback bridge, not the upstream");
        try {
            const probeEvents = await exchange(frame(sid, [], { generate: false }), ws as WebSocket);
            assert.equal(completed(probeEvents).status, "completed");
            const turnEvents = await exchange(frame(sid, [user("via-patched-global-websocket")]), ws as WebSocket);
            assert.equal(completed(turnEvents).status, "completed");
            const last = rows[rows.length - 1];
            assert.ok(JSON.stringify(last.request.input).includes("via-patched-global-websocket"));
            // Pipeline-proof: only traffic through the in-process engine gets
            // the ACP tools injected — direct-degraded traffic never reaches here.
            assert.ok(Array.isArray(last.request.tools) && (last.request.tools as Item[]).some((t) => t.name === "acp_status" || t.name === "compress"), JSON.stringify((last.request.tools as Item[] | undefined)?.map?.((t) => t.name)));
        } finally {
            ws.close();
        }
    } finally {
        _resetForTest();
        if (saved !== undefined) Object.defineProperty(globalThis, "WebSocket", saved);
    }
});
