import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { on, once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { peekSession } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";

type Item = Record<string, unknown>;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-ws-home-"));
process.env.XDG_STATE_HOME = testHome;
process.env.XDG_DATA_HOME = testHome;
process.env.XDG_CACHE_HOME = testHome;

const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

// Mirrors the captured codex 0.147.0 Responses-over-WebSocket client: the
// upgrade targets the ordinary prefix-mode path with codex's own transport
// headers (no plugin marker), and every request is a full `response.create`
// replay — a `generate: false` probe with empty input first, then one
// full-history frame per turn. Codex never sends previous_response_id.
async function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-ws-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const rows: Array<{ request: Item; headers: http.IncomingHttpHeaders }> = [];
    let httpRequests = 0;
    let serial = 0;
    let toolArguments: string | undefined;
    const upstream = http.createServer((req, res) => { if (req.method === "POST") httpRequests++; res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (peer, req) => { peer.on("error", e => console.error("[FAKE-UPSTREAM-PEER-ERR]", e.message)); peer.on("message", raw => {
        const request = JSON.parse(raw.toString()) as Item;
        rows.push({ request, headers: req.headers });
        const id = `resp_codex_${++serial}`;
        const send = (type: string, fields: Item): void => peer.send(JSON.stringify({ type, ...fields }));
        if (Array.isArray(request.input) && request.input.length === 0) {
            // Probe: codex expects a terminal event, nothing more.
            send("response.created", { response: { id, status: "in_progress", output: [] } });
            send("response.completed", { response: { id, status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 } } });
            return;
        }
        const item: Item = toolArguments !== undefined
            ? { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "acp_status", arguments: toolArguments, status: "completed" }
            : { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `ok-${serial}` }] };
        send("response.created", { response: { id, status: "in_progress", output: [] } });
        send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...(toolArguments === undefined ? { content: [] } : { arguments: "" }) } });
        if (toolArguments !== undefined) {
            send("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: toolArguments });
            send("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: toolArguments });
        } else {
            send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: `ok-${serial}` });
            send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: `ok-${serial}` });
        }
        send("response.output_item.done", { output_index: 0, item });
        send("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 } } });
    }); });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const config = defaultConfig(200000);
    config.preserveRecentTokens = 0;
    const opts: ProxyOptions = { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1", routes: {}, modelContextLimit: 200000, kernelConfig: config, compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, logFile: path.join(tmp, "bili.log"), debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const sid = `codex-thread-${randomUUID()}`;
    const openPeer = async (authorization = "Bearer fake-credential", extraHeaders: Record<string, string> = {}) => {
        const client = new WebSocket(`${proxyOrigin.replace(/^http/, "ws")}/bili/${upstreamOrigin}/v1/responses`, { headers: { authorization, "session-id": sid, "thread-id": sid, "openai-beta": "responses_websockets=2026-02-06", "user-agent": "codex_exec/0.147.0 (Ubuntu 24.4.0; x86_64) gnome-terminal (codex_exec; 0.147.0)", originator: "codex_exec", ...extraHeaders } });
        await once(client, "open");
        return client;
    };
    const frame = (input: Item[], extra: Item = {}): string => JSON.stringify({ type: "response.create", model: "gpt-5.2", instructions: "You are Codex", store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: sid, reasoning: { effort: "medium", summary: "auto" }, text: { verbosity: "low" }, tools: [], input, client_metadata: { session_id: sid, thread_id: sid }, ...extra });
    async function exchange(payload: string, client: WebSocket): Promise<Item[]> {
        client.send(payload);
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
        });
    }
    // Codex opens every connection with a prewarm probe and waits for its
    // terminal event before sending the real turn; the test must respect the
    // same ordering or the session correctly rejects it with response_in_progress.
    const probe = (client: WebSocket = peer): Promise<Item[]> => exchange(frame([], { generate: false }), client);
    const turn = (input: Item[], client: WebSocket = peer): Promise<Item[]> => exchange(frame(input), client);
    const peer = await openPeer();
    peer.on("error", e => console.error("[TEST-CLIENT-ERR]", e.message));
    return { rows, sid, proxyOrigin, upstreamOrigin, proxy, peer, turn, probe, frame, openPeer,
        logPath: path.join(tmp, "bili.log"),
        setToolArguments: (args: string) => { toolArguments = args; }, get httpRequests() { return httpRequests; }, close: async () => {
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

test("codex WS: prewarm probe plus full-replay turns ride the prefix lane through ACP", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        const first = completed(await f.turn([user("codex-first-turn")]));
        assert.equal(first.status, "completed");
        assert.ok(JSON.stringify(first.output).includes("ok-"));
        assert.equal(f.httpRequests, 0);
        assert.equal(f.rows.length, 2);
        // Probe forwarded verbatim on the upstream transport (no ACP pipeline:
        // no synthesized message, no injected tools, no phantom turn).
        assert.deepEqual(f.rows[0].request.input, []);
        assert.equal(f.rows[0].request.generate, false);
        assert.ok(Array.isArray(f.rows[0].request.tools) && f.rows[0].request.tools.length === 0);
        assert.equal(f.rows[0].headers.authorization, "Bearer fake-credential");
        assert.equal(f.rows[0].headers["session-id"], f.sid);
        assert.match(String(f.rows[0].headers["user-agent"]), /^codex_exec\//);
        // The real turn is a full replay the pipeline processed: bili's ACP
        // tools ride alongside codex's own (empty) tool list.
        assert.ok(Array.isArray(f.rows[1].request.tools) && (f.rows[1].request.tools as Item[]).some(t => t.name === "acp_status" || t.name === "compress"), JSON.stringify((f.rows[1].request.tools as Item[] | undefined)?.map?.((t: Item) => t.name)));
        assert.ok(JSON.stringify(f.rows[1].request.input).includes("codex-first-turn"));
        const session = peekSession(f.sid);
        assert.ok(session);
        assert.equal(session.stats.requests, 1);
        assert.equal(session.stats.lastInputTokens, 500);
        const log = fs.readFileSync(f.logPath, "utf8");
        assert.match(log, /\[codex-responses-ws\] \[conn=1\]/);
        assert.match(log, /Responses socket connected/);
        assert.doesNotMatch(log, /side request \(/);
    } finally { await f.close(); }
});

test("codex WS: later turns replay full history; no previous_response_id is ever sent", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        completed(await f.turn([user("turn-one-material")]));
        completed(await f.turn([user("turn-one-material"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "prior answer" }] }, user("turn-two")]));
        
        assert.equal(f.rows.length, 3);
        for (const row of f.rows) assert.equal(row.request.previous_response_id, undefined);
        const replayed = f.rows[2].request.input as Item[];
        // The lane injects a developer message (instructions + compression
        // philosophy) ahead of the replay; codex replay itself is verbatim.
        assert.equal(replayed.filter(item => item.type === "message" && item.role !== "developer").length, 3);
        assert.ok(replayed.some(item => item.role === "developer"));
        assert.ok(JSON.stringify(replayed).includes("turn-two"));
        assert.equal(f.httpRequests, 0);
    } finally { await f.close(); }
});

test("codex WS: folding covered history shrinks the replayed turn", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        // Codex replays the FULL history every turn (no previous_response_id);
        // the fold test must drive the wire the same way or each single-message
        // turn would replace the kernel's conversation view instead of growing it.
        const replay: Item[] = [];
        const play = async (text: string): Promise<void> => {
            const reply = completed(await f.turn([...replay, user(text)]));
            replay.push(user(text));
            const message = Array.isArray(reply.output) ? (reply.output.find(item => item && typeof item === "object" && item.type === "message") as Item | undefined) : undefined;
            if (message) replay.push(message);
        };
        await play("session purpose: codex prefix-lane ACP integration");
        await play("OLD-BULKY-SENTINEL " + "unique filler content ".repeat(1200));
        const firstText = JSON.stringify((f.rows.at(-1)!.request.input as Item[]).find((item: Item) => JSON.stringify(item).includes("OLD-BULKY-SENTINEL")));
        const ref = firstText.match(/\x3cacp[^\x3e]*\x3e(m\d+)\x3c\/acp\x3e/)?.[1];
        assert.ok(ref, firstText.slice(-300));
        for (let i = 0; i < 4; i++) await play(`push ${i}`);
        const args = { content: [{ startId: ref, endId: ref, summary: "SUMMARY-CODEX-WS-FOLD: initial bulky material contained deterministic filler; retain this verified summary instead of the original payload." }] };
        const result = await fetch(`${f.proxyOrigin}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: f.sid, tool: "compress", args }) });
        const out = await result.json() as { ok: boolean; result: string };
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.match(out.result, /Compressed/);
        f.setToolArguments("{}");
        completed(await f.turn([
            ...replay,
            { type: "function_call", id: "fc_compress", call_id: "call_compress", name: "compress", arguments: JSON.stringify(args) },
            { type: "function_call_output", call_id: "call_compress", output: out.result },
            user("continue after fold"),
        ]));
        const row = f.rows.at(-1)!;
        assert.ok(!JSON.stringify(row.request.input).includes("OLD-BULKY-SENTINEL"), JSON.stringify((row.request.input as Item[]).filter(item => JSON.stringify(item).includes("OLD-BULKY-SENTINEL")).map(item => JSON.stringify(item.content).slice(0, 180))));
        assert.ok(JSON.stringify(row.request.input).includes("SUMMARY-CODEX-WS-FOLD"));
        assert.ok(peekSession(f.sid)?.state.blocks.some(b => b.active));
        assert.equal(f.httpRequests, 0);
    } finally { await f.close(); }
});

test("codex WS: admission requires the conversation header and the responses path", { timeout: 30000 }, async () => {
    const f = await fixture();
    const origin = f.proxyOrigin.replace(/^http/, "ws");
    const refused = async (url: string, headers: Record<string, string>): Promise<number> => {
        const client = new WebSocket(url, { headers });
        const [, incoming] = (await once(client, "unexpected-response")) as unknown as [http.ClientRequest, http.IncomingMessage];
        const status = incoming.statusCode ?? 0;
        incoming.destroy(); // pre-open refusal: destroy the socket, terminate() would throw
        return status;
    };
    try {
        // Missing session-id: nothing claims the upgrade.
        assert.equal(await refused(`${origin}/bili/${f.upstreamOrigin}/v1/responses`, { authorization: "Bearer fake" }), 426);
        // Conversation header present but the path is not a responses endpoint.
        assert.equal(await refused(`${origin}/bili/${f.upstreamOrigin}/v1/chat`, { "session-id": f.sid }), 426);
    } finally { await f.close(); }
});

test("codex WS: non-streaming transport options are refused with a protocol error frame", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const events: Item[] = [];
        const done = new Promise<Item>(resolve => { f.peer.on("message", (raw: WebSocket.RawData) => { const event = JSON.parse(raw.toString()) as Item; events.push(event); if (event.type === "error") resolve(event); }); });
        f.peer.send(f.frame([user("nope")], { stream: false }));
        const error = await done;
        assert.equal(error.type, "error");
        assert.equal((error.error as { code: string }).code, "invalid_request");
    } finally { await f.close(); }
});
