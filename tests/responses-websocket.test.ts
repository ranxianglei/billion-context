import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { on, once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { Agent } from "undici";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { ResponsesWsHistory, ResponsesWsUpstream } from "../src/responses-ws.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";
import { proxyDispatcher } from "../src/upstream-proxy.ts";
import { ensureRootCA, mintHostCert, rootCaPath } from "../src/ca.ts";
import { validateResponsesWsCreate } from "./wire-contract-fakes.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { peekSession } from "../src/session.ts";
import { BILI_ACP_TOOLS_RESPONSES } from "../src/compress-tool.ts";
import type { ProxyOptions } from "../src/config.ts";
import { createOpencodeV2Setup, type V2HttpRequestEvent } from "../src/agent/opencode-v2.ts";
import { createNativeRoute } from "../src/agent/opencode-native.ts";

type Item = Record<string, unknown>;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ws-home-"));
process.env.XDG_STATE_HOME = testHome;
process.env.XDG_DATA_HOME = testHome;
process.env.XDG_CACHE_HOME = testHome;

const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

test("WS history: expand deltas, exact-prefix continuation, and reset after a fold", () => {
    const history = new ResponsesWsHistory();
    const first = { model: "m", input: [user("old")] };
    const output = [{ type: "message", role: "assistant", content: "ok", status: "completed" }];
    history.commit(first, { id: "resp_1", status: "completed", output });
    const next = history.expand({ type: "response.create", previous_response_id: "resp_1", input: [user("new")] });
    assert.equal((next.input as Item[]).length, 3);
    assert.deepEqual(history.continuation(next), { model: "m", previous_response_id: "resp_1", input: [user("new")] });
    const folded = { ...next, input: [user("summary"), ...output, user("new")] };
    assert.deepEqual(history.continuation(folded), folded);
    assert.throws(() => history.expand({ type: "response.create", previous_response_id: "unknown", input: [] }), /previous_response_not_found/);
    history.commit(next, { id: "failed", status: "failed", output: [] });
    assert.throws(() => history.expand({ type: "response.create", previous_response_id: "failed", input: [] }), /previous_response_not_found/);
});

test("V2 handshake: routes OAuth/API Responses sockets and stamps native identity", async () => {
    const hooks = new Map<string, (event: V2HttpRequestEvent) => void | Promise<void>>();
    const origin = "http://127.0.0.1:8787";
    const cleanup = await createOpencodeV2Setup({ route: createNativeRoute({ origin, ready: Promise.resolve(origin) }, { probe: async () => true }) })({
        session: { hook: async (name, cb) => { hooks.set(name, cb); return {}; } },
    });
    try {
        for (const url of ["wss://api.openai.com/v1/responses", "wss://chatgpt.com/backend-api/codex/responses"]) {
            const event: V2HttpRequestEvent = { url, headers: { authorization: "Bearer test-only" }, sessionID: "ses_ws", agent: "build", model: { providerID: "openai", id: "gpt-5.2" } };
            await hooks.get("experimental.ws.handshake")!(event);
            assert.equal(event.url, `ws://127.0.0.1:8787/bili/responses/${url.replace(/^ws/, "http")}`);
            assert.equal(event.headers?.authorization, "Bearer test-only");
            assert.equal(event.headers?.["x-bili-plugin"], "opencode");
            assert.equal(event.headers?.["x-bili-plugin-conversation"], "ses_ws");
        }
    } finally { cleanup(); }
});

async function fixture(terminalOutput: "full" | "empty" | "omitted" | "partial" | "suffix" = "full") {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-responses-ws-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const rows: Array<{ request: Item; full: Item[]; headers: http.IncomingHttpHeaders }> = [];
    const snapshots = new Map<string, Item[]>();
    let httpRequests = 0;
    let serial = 0;
    let toolArguments: string | undefined;
    let toolName = "write";
    const nextErrors: Item[] = [];
    let stalled = false;
    let disconnect = false;
    let terminalMode: "completed" | "failed" | "incomplete" | "hold" | "disconnect" = "completed";
    let finishHeld: (() => void) | undefined;
    let connections = 0;
    const upstream = http.createServer((req, res) => { if (req.method === "POST") httpRequests++; res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", () => { connections++; });
    wss.on("connection", (peer, req) => peer.on("message", raw => {
        const request = JSON.parse(raw.toString()) as Item;
        const violations = validateResponsesWsCreate(request);
        if (violations.length) { peer.send(JSON.stringify({ type: "error", status: 400, error: { code: "invalid_request", message: violations.join("; ") } })); return; }
        const delta = request.input as Item[];
        const previous = typeof request.previous_response_id === "string" ? snapshots.get(request.previous_response_id) : undefined;
        const full = previous ? [...previous, ...delta] : delta;
        rows.push({ request, full, headers: req.headers });
        const nextError = nextErrors.shift();
        if (nextError) { peer.send(JSON.stringify(nextError)); return; }
        if (disconnect) { disconnect = false; peer.terminate(); return; }
        if (stalled) return;
        if (request.previous_response_id && !previous) { peer.send(JSON.stringify({ type: "error", status: 400, error: { code: "previous_response_not_found", message: "missing upstream checkpoint" } })); return; }
        const id = `resp_ws_${++serial}`;
        const item: Item = toolArguments !== undefined
            ? { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: toolName, arguments: toolArguments, status: "completed" }
            : { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `ok-${serial}`, annotations: [] }] };
        const send = (type: string, fields: Item) => peer.send(JSON.stringify({ type, ...fields }));
        const prefix: Item[] = terminalOutput === "partial" || terminalOutput === "suffix" ? [{ type: "reasoning", id: `rs_${id}`, summary: [], encrypted_content: `opaque-${serial}` }] : [];
        const outputIndex = prefix.length;
        const output = [...prefix, item];
        send("response.created", { response: { id, status: "in_progress", output: [] } });
        for (const [index, part] of prefix.entries()) {
            send("response.output_item.added", { output_index: index, item: part });
            send("response.output_item.done", { output_index: index, item: part });
        }
        send("response.output_item.added", { output_index: outputIndex, item: { ...item, status: "in_progress", ...(toolArguments === undefined ? { content: [] } : { arguments: "" }) } });
        if (toolArguments !== undefined) {
            send("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: toolArguments });
            send("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, arguments: toolArguments });
        } else {
            send("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: 0, delta: `ok-${serial}` });
            send("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: 0, text: `ok-${serial}` });
        }
        send("response.output_item.done", { output_index: outputIndex, item });
        const finish = () => {
            const status = terminalMode === "failed" || terminalMode === "incomplete" ? terminalMode : "completed";
            if (status === "completed") snapshots.set(id, [...full, ...output]);
            send(`response.${status}`, { response: { id, object: "response", status, ...(terminalOutput === "omitted" ? {} : { output: terminalOutput === "full" ? output : terminalOutput === "suffix" ? [item] : prefix }), usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 } } });
        };
        if (terminalMode === "hold") finishHeld = finish;
        else if (terminalMode === "disconnect") peer.close(1011, "private-upstream-close-reason");
        else finish();
    }));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const config = defaultConfig(200000);
    config.preserveRecentTokens = 0;
    const opts: ProxyOptions = { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1", routes: {}, modelContextLimit: 200000, kernelConfig: config, compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, logFile: path.join(tmp, "bili.log"), debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const sid = `ses_ws_${randomUUID()}`;
    const openPeer = async (authorization = "Bearer fake-credential", extraHeaders: Record<string, string> = {}) => {
        const client = new WebSocket(`${proxyOrigin.replace(/^http/, "ws")}/bili/responses/${upstreamOrigin}/v1/responses`, { headers: { authorization, "x-bili-plugin": "opencode", "x-bili-plugin-conversation": sid, "x-bili-plugin-model": "gpt-5.2", "x-bili-plugin-context-window": "200000", ...extraHeaders } });
        await once(client, "open");
        return client;
    };
    const peer = await openPeer();
    async function turn(input: Item[], previous?: string, extra: Item = {}, client = peer): Promise<Item[]> {
        return new Promise((resolve, reject) => {
            const events: Item[] = [];
            const cleanup = (): void => { clearTimeout(timer); client.off("message", onMessage); client.off("close", onClose); };
            const timer = setTimeout(() => { cleanup(); reject(new Error("WS turn timed out")); }, 10000);
            const onClose = (): void => { cleanup(); reject(new Error("WS client closed")); };
            const onMessage = (raw: WebSocket.RawData): void => {
                const event = JSON.parse(raw.toString()) as Item;
                events.push(event);
                if (["response.completed", "response.failed", "response.incomplete", "error"].includes(String(event.type))) {
                    cleanup();
                    resolve(events);
                }
            };
            client.on("message", onMessage);
            client.once("close", onClose);
            client.send(JSON.stringify({ type: "response.create", model: "gpt-5.2", store: false, input, tools: BILI_ACP_TOOLS_RESPONSES, ...(previous ? { previous_response_id: previous } : {}), ...extra }));
        });
    }
    return { rows, sid, proxyOrigin, upstreamOrigin, proxy, peer, turn, openPeer,
        logPath: path.join(tmp, "bili.log"),
        connectionCount: () => connections,
        setTerminalMode: (value: typeof terminalMode) => { terminalMode = value; },
        finishHeld: () => { assert.ok(finishHeld); const finish = finishHeld; finishHeld = undefined; finish(); },
        closeUpstream: async () => {
            const closed = [...wss.clients].map(client => once(client, "close"));
            for (const client of wss.clients) client.close(1000, "private-idle-close-reason");
            await Promise.all(closed);
        },
        setError: (error: Item) => { nextErrors.push(error); },
        setStalled: (value: boolean) => { stalled = value; },
        disconnectNext: () => { disconnect = true; },
        setTerminalOutput: (value: typeof terminalOutput) => { terminalOutput = value; },
        clearUpstreamHistory: () => { snapshots.clear(); },
        upstreamPeers: () => wss.clients.size,
        setToolArguments: (args: string, name = "write") => { toolArguments = args; toolName = name; }, get httpRequests() { return httpRequests; }, close: async () => {
        peer.terminate();
        for (const client of wss.clients) client.terminate();
        await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
        wss.close();
    } };
}

const completed = (events: Item[]): Item => {
    const event = events.find(e => e.type === "response.completed");
    assert.ok(event, JSON.stringify(events));
    return event.response as Item;
};

async function nextEvent(peer: WebSocket, type: string): Promise<Item> {
    for await (const [raw] of on(peer, "message", { signal: AbortSignal.timeout(10000) })) {
        const event = JSON.parse(String(raw)) as Item;
        if (event.type === type) return event;
    }
    throw new Error(`Missing WS event: ${type}`);
}

test("Responses WS: both ends use sockets; incremental tool continuation reaches ACP and usage", { timeout: 30000 }, async () => {
    const f = await fixture();
    f.setToolArguments('{"path":"test-only"}');
    try {
        const first = completed(await f.turn([user("first-round-sentinel")]));
        const call = (first.output as Item[])[0];
        const second = completed(await f.turn([{ type: "function_call_output", call_id: call.call_id, output: "tool result" }, user("second-round")], first.id as string));
        assert.equal(f.httpRequests, 0);
        assert.equal(f.rows.length, 2);
        assert.equal(f.rows[1].request.previous_response_id, first.id);
        assert.equal((f.rows[1].request.input as Item[]).length, 2);
        assert.ok(JSON.stringify(f.rows[1].full).includes("first-round-sentinel"));
        assert.equal(f.rows[0].headers.authorization, "Bearer fake-credential");
        assert.equal(second.status, "completed");
        const session = peekSession(f.sid);
        assert.ok(session);
        assert.equal(session.stats.requests, 2);
        assert.equal(session.stats.lastInputTokens, 500);
        assert.ok(session.state.messageRefs.byRef);
    } finally { await f.close(); }
});

async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("WS condition timed out");
        await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
}

test("Responses WS: upstream continuation cache miss retries once with full processed input", async () => {
    const f = await fixture();
    f.setToolArguments('{"path":"test"}');
    try {
        const first = completed(await f.turn([user("retained history")]));
        f.clearUpstreamHistory();
        const call = (first.output as Item[])[0];
        completed(await f.turn([{ type: "function_call_output", call_id: call.call_id, output: "next" }], first.id as string));
        assert.equal(f.rows.length, 3);
        assert.equal(f.rows[1].request.previous_response_id, first.id);
        assert.equal(f.rows[2].request.previous_response_id, undefined);
        assert.ok(JSON.stringify(f.rows[2].full).includes("retained history"));
    } finally { await f.close(); }
});

test("Responses WS: upstream request errors preserve status and structured error", async () => {
    const f = await fixture();
    try {
        f.setError({ type: "error", status: 429, error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "test rate limit" } });
        const events = await f.turn([user("reject this request")]);
        assert.equal(events[0].status, 429);
        assert.equal((events[0].error as Item).code, "rate_limit_exceeded");
        assert.equal(f.httpRequests, 0);
    } finally { await f.close(); }
});

test("Responses WS: client cancellation closes the upstream and clears idle timers", async () => {
    const f = await fixture();
    try {
        f.setStalled(true);
        const turn = f.turn([user("stall")]);
        const rejected = assert.rejects(turn, /WS client closed/);
        await until(() => f.rows.length === 1);
        f.peer.terminate();
        await rejected;
        await until(() => f.upstreamPeers() === 0 && _liveUpstreamTimersForTest() === 0);
    } finally { await f.close(); }
});

test("Responses WS: disconnect fails the turn; next full request reconnects without old state", async () => {
    const f = await fixture();
    try {
        f.disconnectNext();
        const events = await f.turn([user("first attempt")]);
        assert.equal(events.at(-1)?.type, "error");
        completed(await f.turn([user("second attempt")]));
        assert.equal(f.rows.at(-1)?.request.previous_response_id, undefined);
        assert.ok(!JSON.stringify(f.rows.at(-1)?.full).includes("first attempt"));
    } finally { await f.close(); }
});

test("Responses WS: unsupported client events/options fail explicitly without upstream traffic", async () => {
    const f = await fixture();
    try {
        for (const extra of [{ type: "session.update" }, { stream: true }, { stream_id: "named-lane" }, { background: true }]) {
            const events = await f.turn([user("invalid")], undefined, extra);
            assert.equal((events[0].error as Item).code, "invalid_request");
        }
        assert.equal(f.rows.length, 0);
    } finally { await f.close(); }
});

test("Responses WS: anonymous upgrades retain 426 on the explicit Responses tunnel", async () => {
    const f = await fixture();
    try {
        const peer = new WebSocket(`${f.proxyOrigin.replace(/^http/, "ws")}/bili/responses/${f.upstreamOrigin}/v1/responses`);
        await new Promise<void>((resolve, reject) => {
            peer.once("error", error => { assert.match(error.message, /426/); resolve(); });
            peer.once("open", () => { peer.terminate(); reject(new Error("Anonymous upgrade admitted")); });
        });
    } finally { await f.close(); }
});

test("Responses WS: non-streaming pipeline requests use WS and return the completed JSON body", async () => {
    const f = await fixture();
    const transport = new ResponsesWsUpstream();
    try {
        const response = await transport.fetch(`${f.upstreamOrigin}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-5.2", stream: false, input: [user("preflight request")] }) });
        const body = await response.json() as Item;
        assert.equal(body.status, "completed");
        assert.equal(f.httpRequests, 0);
    } finally { transport.close(); await f.close(); }
});

for (const terminalOutput of ["empty", "omitted", "partial", "suffix"] as const) {
    test(`Responses WS: non-streaming ${terminalOutput} terminal output includes streamed results and supports continuation`, async () => {
        const f = await fixture(terminalOutput);
        const transport = new ResponsesWsUpstream();
        try {
            const input = [user("preflight with streamed output")];
            const first = await transport.fetch(`${f.upstreamOrigin}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-5.2", stream: false, input }) });
            const body = await first.json() as Item;
            const output = body.output as Item[];
            assert.ok(output.some(item => item.type === "message" && JSON.stringify(item.content).includes("ok-1")));
            if (terminalOutput === "partial" || terminalOutput === "suffix") {
                assert.deepEqual(output.map(item => item.type), ["reasoning", "message"]);
                assert.equal(output[0].encrypted_content, "opaque-1");
            }
            const next = await transport.fetch(`${f.upstreamOrigin}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-5.2", stream: false, input: [...input, ...output, user("next preflight")] }) });
            const nextBody = await next.json() as Item;
            assert.equal(f.rows.at(-1)?.request.previous_response_id, body.id);
            assert.ok(JSON.stringify(nextBody.output).includes("ok-2"));
            assert.ok(!JSON.stringify(nextBody.output).includes("ok-1"));
            assert.equal(f.httpRequests, 0);
        } finally { transport.close(); await f.close(); }
    });
}

test("Responses WS: completed and failed sessions do not share socket checkpoints", async () => {
    const a = await fixture();
    const b = await fixture();
    try {
        const first = completed(await a.turn([user("session-A-only")]));
        const wrong = await b.turn([user("session-B-delta")], first.id as string);
        assert.equal((wrong[0].error as Item).code, "previous_response_not_found");
        completed(await b.turn([user("session-B-only")]));
        assert.ok(!JSON.stringify(b.rows.at(-1)?.full).includes("session-A-only"));
        a.setError({ type: "response.failed", response: { id: "resp_failed", status: "failed", error: { code: "server_error", message: "fake failure" }, output: [] } });
        const failed = await a.turn([user("failed request")], first.id as string);
        assert.equal(failed.at(-1)?.type, "response.failed");
        const wrongFailed = await a.turn([user("delta")], "resp_failed");
        assert.equal((wrongFailed[0].error as Item).code, "previous_response_not_found");
    } finally { await a.close(); await b.close(); }
});

test("Responses WS: connection lifetime limit rotates once and sends full input", async () => {
    const f = await fixture();
    try {
        f.setError({ type: "error", status: 400, error: { code: "websocket_connection_limit_reached", message: "fake lifetime limit" } });
        completed(await f.turn([user("reconnect full input")]));
        assert.equal(f.rows.length, 2);
        assert.equal(f.rows[1].request.previous_response_id, undefined);
        assert.ok(JSON.stringify(f.rows[1].full).includes("reconnect full input"));
    } finally { await f.close(); }
});

test("Responses WS: existing upstream HTTP proxy routes the WebSocket CONNECT", async () => {
    const f = await fixture();
    let connects = 0;
    const sockets = new Set<net.Socket>();
    const proxy = http.createServer();
    proxy.on("connect", (req, socket, head) => {
        connects++;
        const destination = new URL(`http://${req.url}`);
        const upstream = net.connect(Number(destination.port), destination.hostname, () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        sockets.add(upstream);
        upstream.on("error", () => socket.destroy());
        upstream.on("close", () => { sockets.delete(upstream); socket.destroy(); });
        socket.on("error", () => upstream.destroy());
        socket.on("close", () => upstream.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const transport = new ResponsesWsUpstream();
    try {
        const response = await transport.fetch(`${f.upstreamOrigin}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-5.2", stream: false, input: [user("proxied WS")] }), dispatcher: proxyDispatcher(`http://127.0.0.1:${(proxy.address() as { port: number }).port}`) });
        assert.equal((await response.json() as Item).status, "completed");
        assert.equal(connects, 1);
        assert.equal(f.httpRequests, 0);
    } finally {
        transport.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => proxy.close(() => resolve()));
        await f.close();
    }
});

test("Responses WSS: TLS verification and authorization headers survive the secure upstream leg", async () => {
    ensureRootCA();
    const certificate = mintHostCert("localhost");
    const server = https.createServer({ cert: certificate.certPem, key: certificate.keyPem });
    const wss = new WebSocketServer({ server });
    let authorization: string | undefined;
    wss.on("connection", (peer, req) => {
        authorization = req.headers.authorization;
        peer.on("message", () => peer.send(JSON.stringify({ type: "response.completed", response: { id: "resp_tls", status: "completed", output: [] } })));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const dispatcher = new Agent({ connect: { ca: fs.readFileSync(rootCaPath(), "utf8"), servername: "localhost" } });
    const transport = new ResponsesWsUpstream();
    try {
        const response = await transport.fetch(`https://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`, { method: "POST", headers: { authorization: "Bearer tls-test-only" }, dispatcher, body: JSON.stringify({ model: "gpt-5.2", stream: false, input: [user("TLS verified")] }) });
        assert.equal((await response.json() as Item).id, "resp_tls");
        assert.equal(authorization, "Bearer tls-test-only");
    } finally {
        transport.close();
        for (const peer of wss.clients) peer.terminate();
        await dispatcher.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        wss.close();
    }
});

test("Responses WS: closing the HTTP server also tears down its upgraded sockets", async () => {
    const f = await fixture();
    try {
        completed(await f.turn([user("shutdown test")]));
        const peerClosed = once(f.peer, "close");
        await new Promise<void>(resolve => f.proxy.close(() => resolve()));
        await peerClosed;
        await until(() => f.upstreamPeers() === 0 && _liveUpstreamTimersForTest() === 0);
    } finally { await f.close(); }
});

test("Responses WS: tool argument fragments and completed arguments are byte-exact", async () => {
    const f = await fixture();
    const args = '{ "text" : "literal \x3cacp tokens=\\\"2\\\"\x3em00001\x3c/acp\x3e", "unicode": "雪" }';
    f.setToolArguments(args);
    try {
        const events = await f.turn([user("tool-payload")]);
        assert.equal(events.find(e => e.type === "response.function_call_arguments.delta")?.delta, args);
        assert.equal(events.find(e => e.type === "response.function_call_arguments.done")?.arguments, args);
        assert.equal(((completed(events).output as Item[])[0]).arguments, args);
    } finally { await f.close(); }
});

/** Windows-runners flake guard: the bili log file is written by the server
 *  process while the test advances, so a snapshot taken right after a turn can
 *  miss lines that are logically already emitted. Poll until every positive
 *  pattern has landed (bounded), then vet the settled snapshot against the
 *  negative pattern — the CI legs showed 1-2 random WS fault tests failing per
 *  run purely on this read race (#1968). */
async function readLogUntil(logPath: string, patterns: readonly RegExp[], notMatch?: RegExp, timeoutMs = 10000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let log = "";
    for (;;) {
        log = fs.readFileSync(logPath, "utf8");
        if (patterns.every(pattern => pattern.test(log))) break;
        if (Date.now() > deadline) {
            assert.ok(false, `timed out waiting for log patterns ${patterns.map(String).join(" ; ")}\n--- log tail ---\n${log.split("\n").slice(-40).join("\n")}`);
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (notMatch) assert.doesNotMatch(log, notMatch);
    return log;
}

test("Responses WS: unknown continuation returns an explicit retry-full error", async () => {
    const f = await fixture();
    try {
        const events = await f.turn([user("delta")], "unknown");
        assert.equal((events[0].error as Item).code, "previous_response_not_found");
        assert.equal(f.rows.length, 0);
    } finally { await f.close(); }
});

for (const terminalMode of ["disconnect", "failed", "incomplete"] as const) {
test(`Responses WS faults: ${terminalMode} after a delivered tool never commits or silently replays it`, { timeout: 30000 }, async () => {
    const f = await fixture("empty");
    try {
        const seed = completed(await f.turn([user("retained before interrupted tool")]));
        f.setToolArguments('{"text":"private-tool-payload"}');
        f.setTerminalMode(terminalMode);
        const events = await f.turn([user("private-request-payload")], seed.id as string);
        const call = events.find(e => e.type === "response.output_item.added")?.item as Item;
        assert.equal(call?.type, "function_call");
        assert.equal(events.filter(e => e.type === "response.function_call_arguments.done").length, 1);
        assert.equal(events.some(e => e.type === "response.completed"), false);
        assert.equal(f.rows.length, 2, "No automatic replay after a tool was delivered");
        f.setTerminalMode("completed");
        completed(await f.turn([user("explicit retry from last successful response")], seed.id as string));
        assert.equal(f.rows.length, 3);
        assert.equal(f.rows[2].request.previous_response_id, undefined);
        assert.ok(JSON.stringify(f.rows[2].full).includes("retained before interrupted tool"));
        assert.ok(!f.rows[2].full.some(item => item.call_id === call.call_id));
        assert.ok(!JSON.stringify(f.rows[2].full).includes("private-request-payload"));
        assert.equal(f.httpRequests, 0);
        const log = await readLogUntil(
            f.logPath,
            [/\[responses-ws\] \[conn=\d+\] \[session="ses_ws_/, terminalMode === "disconnect" ? /upstream failed phase=stream event=close close_code=1011/ : new RegExp(`checkpoint reset reason=response\.${terminalMode}`)],
            /private-tool-payload|private-request-payload|private-upstream-close-reason|fake-credential/,
        );
        if (terminalMode === "disconnect") assert.match(log, /checkpoint reset reason=upstream-disconnect/);
    } finally { await f.close(); }
});
}

test("Responses WS faults: cancel after tool delivery and immediately resume with rotated credentials", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const seedInput = [user("credential rotation preserves completed history")];
        const seed = completed(await f.turn(seedInput));
        f.setToolArguments('{"text":"private-tool-payload"}');
        f.setTerminalMode("hold");
        const added = nextEvent(f.peer, "response.output_item.added");
        const delivered = nextEvent(f.peer, "response.function_call_arguments.done");
        const interrupted = f.turn([user("cancelled request")], seed.id as string);
        const rejected = assert.rejects(interrupted, /WS client closed/);
        await delivered;
        const call = (await added).item as Item;
        f.peer.close(1000, "private-client-close-reason");
        const fresh = await f.openPeer("Bearer private-rotated-credential");
        await rejected;
        const stale = await f.turn([user("delta on fresh socket")], seed.id as string, {}, fresh);
        assert.equal((stale[0].error as Item).code, "previous_response_not_found");
        assert.equal(f.rows.length, 2);
        f.setTerminalMode("completed");
        const full = [...seedInput, ...seed.output as Item[], user("resume with full history")];
        const resumed = completed(await f.turn(full, undefined, {}, fresh));
        assert.equal(f.rows[2].headers.authorization, "Bearer private-rotated-credential");
        assert.equal(f.rows[2].request.previous_response_id, undefined);
        assert.ok(!f.rows[2].full.some(item => item.call_id === call.call_id));
        const resumedCall = (resumed.output as Item[])[0];
        completed(await f.turn([{ type: "function_call_output", call_id: resumedCall.call_id, output: "completed once" }], resumed.id as string, {}, fresh));
        assert.equal(f.rows.at(-1)?.request.previous_response_id, resumed.id);
        assert.equal(f.connectionCount(), 2);
        await until(() => _liveUpstreamTimersForTest() === 0);
        assert.equal(f.httpRequests, 0);
        const log = await readLogUntil(
            f.logPath,
            [/client closed phase=active close_code=1000/, /client checkpoint reset reason=client-close/, /client rejected reason=previous_response_not_found/],
            /private-tool-payload|private-client-close-reason|private-rotated-credential/,
        );
    } finally { await f.close(); }
});

test("Responses WS faults: an overlapping create is rejected without corrupting the active checkpoint", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        f.setToolArguments("{}");
        f.setTerminalMode("hold");
        const added = nextEvent(f.peer, "response.output_item.added");
        const delivered = nextEvent(f.peer, "response.function_call_arguments.done");
        const active = f.turn([user("active turn")]);
        await delivered;
        const call = (await added).item as Item;
        const busy = nextEvent(f.peer, "error");
        f.peer.send(JSON.stringify({ type: "response.create", input: [user("must not reach upstream")] }));
        assert.equal(((await busy).error as Item).code, "response_in_progress");
        await active;
        assert.equal(f.rows.length, 1);
        const done = nextEvent(f.peer, "response.completed");
        f.setTerminalMode("completed");
        f.finishHeld();
        const response = (await done).response as Item;
        completed(await f.turn([{ type: "function_call_output", call_id: call.call_id, output: "single result" }], response.id as string));
        assert.equal(f.rows[1].request.previous_response_id, response.id);
        assert.equal(f.rows[1].full.filter(item => item.call_id === call.call_id).length, 2);
        assert.ok(!JSON.stringify(f.rows[1].full).includes("must not reach upstream"));
        await readLogUntil(f.logPath, [/client rejected reason=response-in-progress/]);
    } finally { await f.close(); }
});

for (const code of ["previous_response_not_found", "websocket_connection_limit_reached"]) {
test(`Responses WS faults: repeated ${code} stops after one transport recovery`, { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        f.setToolArguments("{}");
        const seed = completed(await f.turn([user("retained retry baseline")]));
        const call = (seed.output as Item[])[0];
        const rejection = { type: "error", status: 400, error: { code, message: "private-error-message" } };
        f.setError(rejection);
        f.setError(rejection);
        const events = await f.turn([{ type: "function_call_output", call_id: call.call_id, output: "bounded retry" }], seed.id as string);
        assert.equal(events.at(-1)?.type, "error");
        assert.equal((events.at(-1)?.error as Item).code, code);
        assert.equal(f.rows.length, 3);
        assert.equal(f.rows[2].request.previous_response_id, undefined);
        completed(await f.turn([{ type: "function_call_output", call_id: call.call_id, output: "explicit recovery" }], seed.id as string));
        assert.equal(f.rows.length, 4);
        assert.equal(f.rows[3].request.previous_response_id, undefined);
        assert.ok(!JSON.stringify(f.rows[3].full).includes("bounded retry"));
        const log = (await readLogUntil(f.logPath, [/upstream rejected phase=await-first-event status=400/]))
            .split("\n").filter(line => line.includes("[responses-ws]")).join("\n");
        assert.equal((log.match(/upstream retry reason=/g) ?? []).length, 1);
        assert.doesNotMatch(log, /private-error-message|fake-credential/);
        assert.equal(f.httpRequests, 0);
    } finally { await f.close(); }
});
}

test("Responses WS faults: refused handshake then a new upstream reconnects without leaking diagnostics", { timeout: 30000 }, async () => {
    const f = await fixture();
    const rejected = http.createServer();
    rejected.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    rejected.listen(0, "127.0.0.1");
    await once(rejected, "listening");
    const log: string[] = [];
    const transport = new ResponsesWsUpstream((_level, message) => log.push(message));
    const body = JSON.stringify({ model: "gpt-5.2", stream: false, input: [user("private-handshake-payload")] });
    try {
        const port = (rejected.address() as { port: number }).port;
        await assert.rejects(transport.fetch(`http://127.0.0.1:${port}/responses?private-query=secret`, { method: "POST", headers: { authorization: "Bearer private-handshake-credential" }, body, signal: AbortSignal.timeout(10000) }), /handshake failed/);
        const response = await transport.fetch(`${f.upstreamOrigin}/v1/responses`, { method: "POST", body });
        assert.equal((await response.json() as Item).status, "completed");
        assert.equal(f.rows.length, 1);
        assert.equal(f.rows[0].request.previous_response_id, undefined);
        assert.match(log.join("\n"), /failed phase=handshake event=error close_code=none/);
        assert.match(log.join("\n"), /checkpoint reset reason=connection-key-changed/);
        assert.doesNotMatch(log.join("\n"), /private-|secret|Bearer/);
    } finally {
        transport.close();
        await f.close();
        await new Promise<void>(resolve => rejected.close(() => resolve()));
    }
});

test("Responses WS: a first-turn all-bili tools frame is a main turn, not an #1897 side demotion", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        // turn() stamps tools: BILI_ACP_TOOLS_RESPONSES and no max_tokens, so the
        // frame matches the #1897 omp leak shape exactly — but it arrives through
        // the WS lane (x-bili-ws-lane stamped by the bridge), whose envelopes are
        // the conversation mainline: the demotion must be vetoed, the kernel must
        // engage, and nothing may be routed through the side passthrough (which
        // cannot speak this lane's upstream transport).
        const first = completed(await f.turn([user("#1897 veto: all-bili first frame stays a main turn")]));
        assert.equal(first.status, "completed");
        const previous = first.id as string;
        const second = completed(await f.turn([user("still a main turn after the first usage report")], previous));
        assert.equal(second.status, "completed");
        await readLogUntil(f.logPath, [/view=ws-expanded/], /leaked bili tools|side request \(/);
    } finally {
        await f.close();
    }
});

test("Responses WS: a title-persona side request rides the lane transport instead of 502ing", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        // The upgrade carries the #1699 persona header, so every frame on this
        // connection is a #388 side request (passthrough + tag strip only). Its
        // outbound body reaches the transport as a Buffer — the side passthrough
        // forwards the inbound buffer verbatim — and must still ride the lane's
        // WebSocket upstream instead of failing with 502.
        const titlePeer = await f.openPeer(undefined, { "x-bili-plugin-agent": "title" });
        const events = await f.turn([user("title over the WS lane")], undefined, {}, titlePeer);
        const done = events.find(e => e.type === "response.completed");
        assert.ok(done, JSON.stringify(events));
        // Poll the log: on slow runners the side-request line can lag the
        // completed frame (same race family the other sites fixed).
        await readLogUntil(f.logPath, [/side request \(agent=title\)/], /Unsupported request in Responses WebSocket transport/);
    } finally {
        await f.close();
    }
});

for (const terminalOutput of ["full", "empty", "omitted", "partial", "suffix"] as const) {
test(`Responses WS: actual fold and successive tool results survive ${terminalOutput} terminal output`, { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const seed = completed(await f.turn([user("session purpose: WebSocket ACP integration")]));
        const first = completed(await f.turn([user("OLD-BULKY-SENTINEL " + "unique filler content ".repeat(1200))], seed.id as string));
        const firstText = JSON.stringify(f.rows[1].full.find(item => item.role === "user" && JSON.stringify(item).includes("OLD-BULKY-SENTINEL")));
        const ref = firstText.match(/\x3cacp[^\x3e]*\x3e(m\d+)\x3c\/acp\x3e/)?.[1];
        assert.ok(ref, firstText.slice(-300));
        let previous = first.id as string;
        for (let i = 0; i < 4; i++) previous = completed(await f.turn([user(`push ${i}`)], previous)).id as string;
        const args = { content: [{ startId: ref, endId: ref, summary: "SUMMARY-WS-FOLD: initial bulky material contained deterministic filler; retain this verified summary instead of the original payload." }] };
        const result = await fetch(`${f.proxyOrigin}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: f.sid, tool: "compress", args }) });
        const out = await result.json() as { ok: boolean; result: string };
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.match(out.result, /Compressed/);
        f.setTerminalOutput(terminalOutput);
        f.setToolArguments("{}", "acp_status");
        let events = await f.turn([
            { type: "function_call", id: "fc_compress", call_id: "call_compress", name: "compress", arguments: JSON.stringify(args) },
            { type: "function_call_output", call_id: "call_compress", output: out.result },
            user("continue after fold"),
        ], previous);
        completed(events);
        const row = f.rows.at(-1)!;
        assert.equal(row.request.previous_response_id, undefined);
        assert.ok(!JSON.stringify(row.full).includes("OLD-BULKY-SENTINEL"), JSON.stringify(row.full.filter(item => JSON.stringify(item).includes("OLD-BULKY-SENTINEL")).map(item => ({ ...item, content: JSON.stringify(item.content).slice(0,180) }))));
        assert.ok(JSON.stringify(row.full).includes("SUMMARY-WS-FOLD"));
        assert.ok(peekSession(f.sid)?.state.blocks.some(b => b.active));
        const calls: Item[] = [];
        for (let i = 0; i < 3; i++) {
            const response = completed(events);
            const call = events.find(e => e.type === "response.output_item.done" && (e.item as Item).type === "function_call")?.item as Item;
            assert.ok(call);
            calls.push(call);
            if (terminalOutput === "empty") assert.deepEqual(response.output, []);
            if (terminalOutput === "omitted") assert.equal(response.output, undefined);
            if (terminalOutput === "suffix") assert.deepEqual(response.output, [call]);
            const output = `STATUS_RESULT_${i}`;
            events = await f.turn([{ type: "function_call_output", call_id: call.call_id, output }], response.id as string);
            completed(events);
            const next = f.rows.at(-1)!;
            assert.equal(next.request.previous_response_id, response.id);
            if (terminalOutput === "partial" || terminalOutput === "suffix") {
                const callIndex = next.full.findIndex(item => item.id === call.id);
                assert.equal(next.full[callIndex - 1]?.type, "reasoning");
                assert.equal(next.full[callIndex - 1]?.id, `rs_${response.id}`);
                assert.equal(typeof next.full[callIndex - 1]?.encrypted_content, "string");
            }
            for (const [index, priorCall] of calls.entries()) {
                assert.ok(next.full.some(item => item.type === "function_call" && item.call_id === priorCall.call_id), `Missing call ${index} in ${terminalOutput} continuation`);
                assert.ok(next.full.some(item => item.type === "function_call_output" && item.call_id === priorCall.call_id && item.output === `STATUS_RESULT_${index}`), `Missing result ${index} in ${terminalOutput} continuation`);
            }
            assert.ok(!JSON.stringify(next.full).includes("OLD-BULKY-SENTINEL"));
            assert.ok(JSON.stringify(next.full).includes("SUMMARY-WS-FOLD"));
        }
        if (terminalOutput === "empty") {
            for (const fault of ["missing-checkpoint", "idle-disconnect", "connection-limit"] as const) {
                const response = completed(events);
                const call = events.find(e => e.type === "response.output_item.done" && (e.item as Item).type === "function_call")?.item as Item;
                calls.push(call);
                if (fault === "missing-checkpoint") f.clearUpstreamHistory();
                if (fault === "idle-disconnect") await f.closeUpstream();
                if (fault === "connection-limit") f.setError({ type: "error", status: 400, error: { code: "websocket_connection_limit_reached" } });
                const index = calls.length - 1;
                events = await f.turn([{ type: "function_call_output", call_id: call.call_id, output: `STATUS_RESULT_${index}` }], response.id as string);
                completed(events);
                const next = f.rows.at(-1)!;
                assert.equal(next.request.previous_response_id, undefined, fault);
                for (const [i, priorCall] of calls.entries()) {
                    assert.equal(next.full.filter(item => item.type === "function_call" && item.call_id === priorCall.call_id).length, 1, fault);
                    assert.equal(next.full.filter(item => item.type === "function_call_output" && item.call_id === priorCall.call_id && item.output === `STATUS_RESULT_${i}`).length, 1, fault);
                }
                assert.ok(!JSON.stringify(next.full).includes("OLD-BULKY-SENTINEL"));
                assert.ok(JSON.stringify(next.full).includes("SUMMARY-WS-FOLD"));
            }
            const log = await readLogUntil(
                f.logPath,
                [/upstream retry reason=continuation-rejected action=resend-full/, /upstream checkpoint reset reason=reconnect/, /upstream retry reason=connection-limit action=reconnect-full/],
                /fake-credential|private-idle-close-reason/,
            );
        }
        assert.equal(f.httpRequests, 0);
    } finally { await f.close(); }
});
}
