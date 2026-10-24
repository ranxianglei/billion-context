import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { on, once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { defaultConfig } from "acp-kernel";
import { startServer, BILI_HOP_HEADER } from "../src/server.ts";
import { setLogCapture } from "../src/logger.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { peekSession } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { validateCodexResponsesWsCreate } from "./wire-contract-fakes.ts";

type Item = Record<string, unknown>;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-ws-home-"));
process.env.XDG_STATE_HOME = testHome;
process.env.XDG_DATA_HOME = testHome;
process.env.XDG_CACHE_HOME = testHome;

const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const developer = (text: string): Item => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });

// Mirrors the captured codex 0.147.0 Responses-over-WebSocket client: the
// upgrade targets the ordinary prefix-mode path with codex's own transport
// headers (no plugin marker), and every request is a full `response.create`
// replay — a `generate: false` probe with empty input first, then one
// full-history frame per turn. Codex never sends previous_response_id.
async function fixture(overrides: Partial<ProxyOptions> = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-ws-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const rows: Array<{ request: Item; headers: http.IncomingHttpHeaders }> = [];
    const upstreamConnections: http.IncomingHttpHeaders[] = [];
    let httpRequests = 0;
    let serial = 0;
    let toolArguments: string | undefined;
    const upstream = http.createServer((req, res) => { if (req.method === "POST") httpRequests++; res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (peer, req) => { upstreamConnections.push(req.headers); peer.on("error", e => console.error("[FAKE-UPSTREAM-PEER-ERR]", e.message)); peer.on("message", raw => {
        const request = JSON.parse(raw.toString()) as Item;
        const violations = validateCodexResponsesWsCreate(request);
        if (violations.length) { peer.send(JSON.stringify({ type: "error", status: 400, error: { code: "invalid_request", message: violations.join("; ") } })); return; }
        rows.push({ request, headers: req.headers });
        const id = `resp_codex_${++serial}`;
        const send = (type: string, fields: Item): void => peer.send(JSON.stringify({ type, ...fields }));
        if (request.generate === false || (Array.isArray(request.input) && request.input.length === 0)) {
            // Probe / no-generation warmup: codex expects a terminal event, nothing more.
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
    const opts: ProxyOptions = { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1", routes: {}, modelContextLimit: 200000, kernelConfig: config, compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, logFile: path.join(tmp, "bili.log"), debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] }, ...overrides };
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
    const turn = (input: Item[], client: WebSocket = peer, extra: Item = {}): Promise<Item[]> => exchange(frame(input, extra), client);
    const peer = await openPeer();
    peer.on("error", e => console.error("[TEST-CLIENT-ERR]", e.message));
    return { rows, upstreamConnections, sid, proxyOrigin, upstreamOrigin, proxy, peer, turn, probe, frame, openPeer,
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
        // #3063: the client's transport fields must ride the upstream frame
        // verbatim — dropping stream made chatgpt.com answer with a zero-output
        // completed turn.
        assert.equal(f.rows[0].request.stream, true);
        assert.equal(f.rows[1].request.stream, true);
        // The real turn is a full replay the pipeline processed: bili's ACP
        // tools ride alongside codex's own (empty) tool list.
        assert.ok(Array.isArray(f.rows[1].request.tools) && (f.rows[1].request.tools as Item[]).some(t => t.name === "acp_status" || t.name === "compress"), JSON.stringify((f.rows[1].request.tools as Item[] | undefined)?.map?.((t: Item) => t.name)));
        assert.ok(JSON.stringify(f.rows[1].request.input).includes("codex-first-turn"));
        const session = peekSession(f.sid);
        assert.ok(session);
        assert.equal(session.stats.requests, 1);
        assert.equal(session.stats.lastInputTokens, 500);
        // Poll, don't one-shot-read (#2882): the logger's file stream is
        // async/buffered (#1971) — same family as the :275 wait below — and a
        // cold readFileSync here raced the flush on loaded CI runners, leaving
        // only the 4 startup lines in the file.
        const wantWs = /\[codex-responses-ws\] \[conn=1\]/;
        const wantConnected = /Responses socket connected/;
        const deadlineLog = Date.now() + 5000;
        let log = "";
        for (;;) {
            log = fs.readFileSync(f.logPath, "utf8");
            if (wantWs.test(log) && wantConnected.test(log)) break;
            if (Date.now() >= deadlineLog) break;
            await new Promise(r => setTimeout(r, 20));
        }
        assert.match(log, wantWs);
        assert.match(log, wantConnected);
        assert.doesNotMatch(log, /side request \(/);
    } finally { await f.close(); }
});

test("codex WS: probe and turns share ONE upstream connection (#3073)", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        completed(await f.turn([user("shared-upstream-one")]));
        completed(await f.turn([user("shared-upstream-one"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "prior" }] }, user("shared-upstream-two")]));
        assert.equal(f.rows.length, 3);
        // #3073 regression: the probe bypasses the pipeline that stamps
        // x-bili-hop / x-bili-tunnel on turn envelopes, so its handshake key
        // diverged and every client connection tore onto a second upstream
        // socket at the probe→turn switch — wiping the checkpoint with it.
        assert.equal(f.upstreamConnections.length, 1, `expected exactly one upstream WebSocket connection, got ${f.upstreamConnections.length}`);
        const upgrade = f.upstreamConnections[0]!;
        // The shared handshake must carry the chain markers a pipeline-stamped
        // turn would carry: a chained bili keys off them for chain-skip /
        // self-loop detection, so marker-less probes were not just wasteful —
        // they were invisible to the #300 double-compression guard.
        assert.match(String(upgrade["x-bili-hop"]), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, `probe handshake must carry the processor's x-bili-hop id, got ${JSON.stringify(upgrade["x-bili-hop"])}`);
        assert.equal(upgrade["x-bili-tunnel"], "1");
        assert.equal(upgrade["x-bili-ws-lane"], "codex-responses-ws");
        assert.equal(upgrade.authorization, "Bearer fake-credential");
        assert.equal(upgrade["session-id"], f.sid);
    } finally { await f.close(); }
});

test("codex WS chain: A→B stack keeps single-layer processing over one upstream socket (#3073)", { timeout: 30000 }, async () => {
    // Stacked proxies over the WS lane: client → A → B → mock LLM. A processes
    // (stamps x-bili-hop on its upstream handshake); B must see that marker on
    // EVERY frame — probe included — skip processing, and pass through verbatim.
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const mockConnections: http.IncomingHttpHeaders[] = [];
    const mockRows: Item[] = [];
    let serial = 0;
    const mock = http.createServer((req, res) => { res.writeHead(404).end(); });
    const mockWss = new WebSocketServer({ server: mock });
    mockWss.on("connection", (peer, req) => {
        mockConnections.push(req.headers);
        peer.on("message", raw => {
            const request = JSON.parse(raw.toString()) as Item;
            mockRows.push(request);
            const id = `resp_chain_${++serial}`;
            if (Array.isArray(request.input) && request.input.length === 0) {
                peer.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
                peer.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 } } }));
                return;
            }
            const item: Item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `chain-${serial}` }] };
            peer.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
            peer.send(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }));
            peer.send(JSON.stringify({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: `chain-${serial}` }));
            peer.send(JSON.stringify({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: `chain-${serial}` }));
            peer.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
            peer.send(JSON.stringify({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 } } }));
        });
    });
    mock.listen(0, "127.0.0.1");
    await once(mock, "listening");
    const makeOpts = (upstream: string): ProxyOptions => ({ host: "127.0.0.1", port: 0, upstream, routes: {}, modelContextLimit: 200000, kernelConfig: (() => { const c = defaultConfig(200000); c.preserveRecentTokens = 0; return c; })(), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, logFile: "off", debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } });
    const mockOrigin = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
    const B = await startServer(makeOpts(mockOrigin));
    await once(B, "listening");
    const bOrigin = `http://127.0.0.1:${(B.address() as { port: number }).port}`;
    const A = await startServer(makeOpts(bOrigin));
    await once(A, "listening");
    const aOrigin = `http://127.0.0.1:${(A.address() as { port: number }).port}`;
    let client: WebSocket | undefined;
    try {
        const sid = `codex-thread-chain-${randomUUID()}`;
        client = new WebSocket(`${aOrigin.replace(/^http/, "ws")}/bili/${bOrigin}/bili/${mockOrigin}/v1/responses`, { headers: { authorization: "Bearer fake-credential", "session-id": sid, "thread-id": sid, "openai-beta": "responses_websockets=2026-02-06", "user-agent": "codex_exec/0.147.0" } });
        await once(client, "open");
        client.on("error", e => console.error("[CHAIN-CLIENT-ERR]", e.message));
        const frame = (input: Item[], extra: Item = {}): string => JSON.stringify({ type: "response.create", model: "gpt-5.2", instructions: "You are Codex", store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: sid, reasoning: { effort: "medium", summary: "auto" }, text: { verbosity: "low" }, tools: [], input, client_metadata: { session_id: sid, thread_id: sid }, ...extra });
        const exchange = (payload: string): Promise<Item> => new Promise((resolve, reject) => {
            client!.send(payload);
            const timer = setTimeout(() => reject(new Error("chain WS turn timed out")), 10000);
            const onMessage = (raw: WebSocket.RawData): void => {
                const event = JSON.parse(raw.toString()) as Item;
                if (event.type === "response.completed") { clearTimeout(timer); resolve(event.response as Item); }
            };
            client!.on("message", onMessage);
        });
            await exchange(frame([], { generate: false }));
            const reply = await exchange(frame([user("chain-turn")]));
            assert.equal(reply.status, "completed");

            // B detected A's processor marker and skipped ALL processing (the
            // #300 guard fires per envelope; only the turn is an envelope —
            // probes bypass dispatch on both hops). Exactly one warn ⇒ no
            // double layer.
            const warns = logs.filter(l => l.level === "warn" && l.msg.includes("[chain]") && l.msg.includes(BILI_HOP_HEADER));
            assert.equal(warns.length, 1, `expected exactly one chain warning (from B), got ${warns.length}: ${JSON.stringify(warns)}`);

            const turnAtMock = mockRows.at(-1)!;
            // Single-layer processing end to end: exactly ONE injected developer
            // message (A's) in the wire body — a double-processing B would add
            // a second one.
            const developers = ((turnAtMock.input ?? []) as Item[]).filter(i => i.role === "developer");
            assert.equal(developers.length, 1, JSON.stringify(developers.map(d => String((d.content ?? "")).slice(0, 80))));
            assert.ok(JSON.stringify(turnAtMock.tools ?? []).includes("acp_status"), "A's ACP tools must reach the mock");

            // One upstream socket end to end: A shares its single A→B connection
            // across probe+turn, and B shares its single B→mock connection.
            assert.equal(mockConnections.length, 1, `expected exactly one mock upstream connection, got ${mockConnections.length}`);
            const hop = String(mockConnections[0]!["x-bili-hop"]);
            assert.match(hop, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "A's x-bili-hop marker must reach the mock");
            // B passed A's marker through verbatim (no re-stamp with its own id).
            assert.ok(warns[0]!.msg.includes(hop), "B's chain warning must name the same marker that reached the mock (A's, not B's)");
            assert.equal(mockConnections[0]!["x-bili-tunnel"], "1");
    } finally {
        setLogCapture(null);
        client?.terminate();
        for (const c of mockWss.clients) c.terminate();
        A.closeAllConnections?.();
        await new Promise<void>(resolve => A.close(() => resolve()));
        B.closeAllConnections?.();
        await new Promise<void>(resolve => B.close(() => resolve()));
        mock.closeAllConnections?.();
        await new Promise<void>(resolve => mock.close(() => resolve()));
        mockWss.close();
    }
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

// codex's startup / idle-thread warmup is generate:false carrying only its
// developer/user context items. Run as a pipeline turn, that zero-conversation
// view deactivated every fold and re-injected every forged summary (#4594).
test("codex WS: a context-only generate:false prewarm is relayed verbatim and leaves the fold intact (#4594)", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        const replay: Item[] = [];
        const play = async (text: string): Promise<void> => {
            const reply = completed(await f.turn([...replay, user(text)]));
            replay.push(user(text));
            const message = (reply.output as Item[]).find(item => item.type === "message");
            if (message) replay.push(message);
        };
        await play("session purpose: codex prewarm regression");
        await play("PREWARM-BULKY " + "unique filler content ".repeat(1200));
        const bulky = JSON.stringify((f.rows.at(-1)!.request.input as Item[]).find(item => JSON.stringify(item).includes("PREWARM-BULKY")));
        const ref = bulky.match(/\x3cacp[^\x3e]*\x3e(m\d+)\x3c\/acp\x3e/)?.[1];
        assert.ok(ref, bulky.slice(-300));
        for (let i = 0; i < 4; i++) await play(`push ${i}`);
        const args = { content: [{ startId: ref, endId: ref, summary: "SUMMARY-PREWARM-FOLD: bulky deterministic filler, folded before the prewarm arrives." }] };
        const result = await fetch(`${f.proxyOrigin}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: f.sid, tool: "compress", args }) });
        assert.equal(((await result.json()) as { ok: boolean }).ok, true);
        const session = peekSession(f.sid);
        assert.ok(session);
        assert.ok(session.state.blocks.some(b => b.active));
        session.metadata.codexForgedSummaries = ["FORGED-SUMMARY-SENTINEL"];
        const requests = session.stats.requests;
        const context = [developer("codex permissions and instructions"), user("environment context: cwd=/repo shell=bash")];
        const warm = completed(await f.turn(context, f.peer, { generate: false }));
        assert.deepEqual(warm.output, []);
        const sent = f.rows.at(-1)!.request;
        assert.equal(sent.generate, false);
        assert.deepEqual(sent.input, context, "the prewarm reaches upstream verbatim");
        assert.deepEqual(sent.tools, [], "no ACP tools ride a no-generation request");
        assert.ok(!JSON.stringify(sent).includes("FORGED-SUMMARY-SENTINEL"), "forged summaries are not re-injected into the prewarm");
        assert.equal(session.stats.requests, requests, "the prewarm is not a pipeline turn");
        assert.ok(peekSession(f.sid)?.state.blocks.some(b => b.active), "the prewarm leaves the fold active");
    } finally { await f.close(); }
});

test("codex WS: a history-replaying generate:false prewarm stays on the ACP pipeline (#4594)", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        completed(await f.turn([user("history-turn")]));
        const warm = completed(await f.turn([user("history-turn"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "prior answer" }] }], f.peer, { generate: false }));
        assert.deepEqual(warm.output, []);
        const sent = f.rows.at(-1)!.request;
        assert.equal(sent.generate, false);
        assert.ok((sent.tools as Item[]).some(t => t.name === "acp_status" || t.name === "compress"), "a history prewarm is still processed by the pipeline");
        assert.equal(peekSession(f.sid)?.stats.requests, 2);
    } finally { await f.close(); }
});

test("codex WS: the prewarm probe egresses through the configured upstream proxy (#4594)", { timeout: 30000 }, async () => {
    let connects = 0;
    const tunnels = new Set<net.Socket>();
    const upstreamProxy = http.createServer();
    upstreamProxy.on("connect", (req, socket, head) => {
        connects++;
        const destination = new URL(`http://${req.url}`);
        const tunnel = net.connect(Number(destination.port), destination.hostname, () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) tunnel.write(head);
            tunnel.pipe(socket);
            socket.pipe(tunnel);
        });
        tunnels.add(tunnel);
        tunnel.on("error", () => socket.destroy());
        tunnel.on("close", () => { tunnels.delete(tunnel); socket.destroy(); });
        socket.on("error", () => tunnel.destroy());
        socket.on("close", () => tunnel.destroy());
    });
    upstreamProxy.listen(0, "127.0.0.1");
    await once(upstreamProxy, "listening");
    const f = await fixture({ proxy: `http://127.0.0.1:${(upstreamProxy.address() as { port: number }).port}` });
    try {
        await f.probe();
        assert.equal(connects, 1, "the probe's upstream WebSocket tunnels through the configured proxy");
        assert.deepEqual(f.rows[0]?.request.input, []);
    } finally {
        await f.close();
        for (const tunnel of tunnels) tunnel.destroy();
        await new Promise<void>(resolve => upstreamProxy.close(() => resolve()));
    }
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

test("codex WS: stream_options delivery hints are admitted (codex 0.160.0 shape, #2126)", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        const events: Item[] = [];
        const done = new Promise<Item[]>(resolve => {
            f.peer.on("message", (raw: WebSocket.RawData) => { const event = JSON.parse(raw.toString()) as Item; events.push(event); if (event.type === "response.completed") resolve(events); });
        });
        // codex 0.147+ rides reasoning_summary_delivery on every response.create;
        // the lane must admit it instead of refusing the whole frame.
        f.peer.send(f.frame([user("stream-options-turn")], { stream_options: { reasoning_summary_delivery: "sequential_cutoff" } }));
        const result = await done;
        assert.equal(result.at(-1)?.type, "response.completed");
        assert.ok(result.every(e => e.type !== "error"), JSON.stringify(result));
        // Admitted through the ACP pipeline: probe row + one processed turn row, no error frame.
        assert.equal(f.rows.length, 2);
        assert.ok(JSON.stringify(f.rows[1].request.input).includes("stream-options-turn"));
        // #3063: admitted is not enough — the hint must also reach upstream verbatim.
        assert.equal(f.rows[0].request.stream, true);
        assert.equal(f.rows[1].request.stream, true);
        assert.deepEqual(f.rows[1].request.stream_options, { reasoning_summary_delivery: "sequential_cutoff" });
    } finally { await f.close(); }
});

test("codex WS: rejection names the offending transport option in the frame and log (#2126)", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const done = new Promise<Item>(resolve => { f.peer.on("message", (raw: WebSocket.RawData) => { const event = JSON.parse(raw.toString()) as Item; if (event.type === "error") resolve(event); }); });
        f.peer.send(f.frame([user("bg")], { background: true }));
        const error = await done;
        assert.equal(error.type, "error");
        assert.equal((error.error as { code: string }).code, "invalid_request");
        assert.match(String((error.error as Item).message), /background/);
        // Poll, don't one-shot-read: the logger's file stream is async/buffered
        // (#1971) and readFileSync right after the error frame raced loaded CI runners.
        const want = /client rejected reason=invalid_request detail=.*background/;
        const deadline = Date.now() + 5000;
        let log = "";
        for (;;) {
            try { log = fs.readFileSync(f.logPath, "utf8"); } catch { /* open still in flight */ }
            if (want.test(log)) break;
            if (Date.now() >= deadline) break;
            await new Promise(r => setTimeout(r, 20));
        }
        assert.match(log, want);
    } finally { await f.close(); }
});
