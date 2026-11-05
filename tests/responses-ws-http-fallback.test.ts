import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import WebSocket from "ws";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";
import type { ProxyOptions } from "../src/config.ts";

// #3342: a Codex Responses-over-WebSocket client talking to a supplier that
// REFUSES the WS upgrade but serves plain HTTP /responses + SSE. The client leg
// stays WS (deltas, checkpoints, ACP); only the bili→supplier leg falls back to
// HTTP/SSE, and ONLY after the handshake fails before any generation request is
// sent. These tests pin that contract against a hermetic upgrade-refusing,
// HTTP-SSE supplier.

type Item = Record<string, unknown>;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ws-httpfb-home-"));
process.env.XDG_STATE_HOME = testHome;
process.env.XDG_DATA_HOME = testHome;
process.env.XDG_CACHE_HOME = testHome;

// Each full bili server leaves a ref'd undici idle-watchdog per fallback leg
// (released only via clearTimer, which the WS sink path never calls) plus
// phase-aligned unref'd peer-rescan ticks that outlive the assertions. Every
// test already reports (30s test + 15s exchange timeouts catch real hangs), so
// force a clean exit once the suite is done to keep the hermetic shard from
// being held open by teardown residue.
after(() => { process.exit(process.exitCode ?? 0); });

const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const developer = (text: string): Item => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });

type FailMode = "ok" | "error400" | "incomplete";

async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("WS condition timed out");
        await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
}

async function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ws-httpfb-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const httpRows: Array<{ request: Item; headers: http.IncomingHttpHeaders }> = [];
    let upgradesRefused = 0;
    let serial = 0;
    let failMode: FailMode = "ok";
    let toolArguments: string | undefined;
    let stallNext = false;
    const heldRequests: Array<{ aborted: boolean }> = [];
    const upstream = http.createServer((req, res) => {
        if (req.method !== "POST") { res.writeHead(404).end(); return; }
        let body = "";
        req.on("data", c => { body += c; });
        req.on("end", () => {
            const parsed = JSON.parse(body) as Item;
            httpRows.push({ request: parsed, headers: req.headers });
            if (stallNext) {
                // Hold the request open without responding — pins that a client
                // disconnect aborts the in-flight HTTP egress instead of pinning it.
                stallNext = false;
                const held = { aborted: false };
                heldRequests.push(held);
                const markAborted = (): void => { held.aborted = true; };
                req.on("aborted", markAborted);
                res.on("close", markAborted);
                return;
            }
            // Connection: close stops undici from pooling the socket; without it
            // the global dispatcher holds an idle ref'd socket and the test
            // process never exits after the servers are closed.
            res.setHeader("connection", "close");
            if (failMode === "error400") {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { type: "invalid_request_error", code: "bad_model", message: "model not found" } }));
                return;
            }
            const id = `resp_http_${++serial}`;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const send = (type: string, fields: Item): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`); };
            if (parsed.generate === false) {
                // No-generation warmup: terminal with empty output, whatever the input.
                send("response.created", { response: { id, status: "in_progress", output: [] } });
                send("response.completed", { response: { id, object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } });
                res.end();
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
            if (failMode !== "incomplete") {
                send("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 } } });
            }
            res.end();
        });
    });
    // Refuse every WebSocket upgrade — the "HTTP/SSE-only supplier" shape that
    // triggers the fallback. undici's UpstreamWebSocket surfaces this as a
    // handshake failure before any generation request is sent.
    upstream.on("upgrade", (_req, socket) => {
        upgradesRefused++;
        socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const config = defaultConfig(200000);
    config.preserveRecentTokens = 0;
    // injectTool:false isolates the transport under test: no ACP-native tool
    // execution loop (acp_status re-request) muddying the single upstream leg.
    const opts: ProxyOptions = { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1", routes: {}, modelContextLimit: 200000, kernelConfig: config, compress: { injectTool: false, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, logFile: path.join(tmp, "bili.log"), debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const sid = `codex-thread-${randomUUID()}`;
    const openPeer = async (): Promise<WebSocket> => {
        const client = new WebSocket(`${proxyOrigin.replace(/^http/, "ws")}/bili/${upstreamOrigin}/v1/responses`, { headers: { authorization: "Bearer fake-credential", "session-id": sid, "thread-id": sid, "openai-beta": "responses_websockets=2026-02-06", "user-agent": "codex_exec/0.147.0" } });
        await once(client, "open");
        client.on("error", () => {});
        return client;
    };
    const frame = (input: Item[], extra: Item = {}): string => JSON.stringify({ type: "response.create", model: "gpt-5.2", instructions: "You are Codex", store: false, stream: true, prompt_cache_key: sid, tools: [], input, client_metadata: { session_id: sid, thread_id: sid }, ...extra });
    async function exchange(payload: string, client: WebSocket): Promise<Item[]> {
        client.send(payload);
        return new Promise((resolve, reject) => {
            const events: Item[] = [];
            const cleanup = (): void => { clearTimeout(timer); client.off("message", onMessage); client.off("close", onClose); };
            const timer = setTimeout(() => { cleanup(); reject(new Error("WS turn timed out")); }, 15000);
            const onClose = (): void => { cleanup(); reject(new Error("WS client closed")); };
            const onMessage = (raw: WebSocket.RawData): void => {
                const event = JSON.parse(raw.toString()) as Item;
                events.push(event);
                if (["response.completed", "response.failed", "response.incomplete", "error"].includes(String(event.type))) { cleanup(); resolve(events); }
            };
            client.on("message", onMessage);
            client.once("close", onClose);
        });
    }
    const peer = await openPeer();
    const probe = (client: WebSocket = peer): Promise<Item[]> => exchange(frame([], { generate: false }), client);
    const turn = (input: Item[], extra: Item = {}, client: WebSocket = peer): Promise<Item[]> => exchange(frame(input, extra), client);
    return {
        httpRows, sid, proxy, peer, turn, probe, frame, openPeer,
        get upgradesRefused(): number { return upgradesRefused; },
        get lastHttpRequest(): Item { return httpRows[httpRows.length - 1]?.request ?? {}; },
        setFailMode: (m: FailMode): void => { failMode = m; },
        setToolArguments: (args: string): void => { toolArguments = args; },
        resetFailMode: (): void => { failMode = "ok"; },
        get heldAbortedCount(): number { return heldRequests.filter(h => h.aborted).length; },
        setStallNext: (v: boolean): void => { stallNext = v; },
        close: async (): Promise<void> => {
            peer.terminate();
            await Promise.all([new Promise<void>(r => proxy.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]);
        },
    };
}

const completed = (events: Item[]): Item => {
    const event = events.find(e => e.type === "response.completed");
    assert.ok(event, `expected response.completed in ${JSON.stringify(events.map(e => e.type))}`);
    return event.response as Item;
};
const errorEvent = (events: Item[]): Item => {
    const event = events.find(e => e.type === "error");
    assert.ok(event, `expected an error frame in ${JSON.stringify(events.map(e => e.type))}`);
    return event;
};
// The HTTP egress must carry the full effective input with no local checkpoint
// marker and no WS-only frame field, and force streaming so the SSE sink works.
function assertHttpEgressShape(request: Item): void {
    assert.equal(request.stream, true, "egress forces stream:true for the SSE sink");
    assert.ok(!("previous_response_id" in request), "local checkpoint id stripped from HTTP egress");
    assert.ok(!("type" in request), "WS-only type field stripped from HTTP egress");
    assert.ok(Array.isArray(request.input), "egress carries an input array");
    assert.equal(request.model, "gpt-5.2");
}
// Scan every recorded row, not just the last: one client turn can fan out into
// several supplier requests (ACP degenerate-turn handling), so the last row is
// not guaranteed to be the one carrying the delta under assertion.
function assertAllEgress(rows: Array<{ request: Item; headers: http.IncomingHttpHeaders }>): void {
    assert.ok(rows.length > 0, "at least one HTTP egress request recorded");
    for (const row of rows) {
        assert.equal(row.request.stream, true, "every egress forces stream:true");
        assert.ok(!("previous_response_id" in row.request), "no local checkpoint id in any egress");
        assert.ok(!("type" in row.request), "no WS-only type field in any egress");
        assert.ok(Array.isArray(row.request.input), "egress carries an input array");
        assert.equal(row.headers.authorization, "Bearer fake-credential", "auth rides every egress");
    }
}


test("WS client over an HTTP/SSE-only supplier: probe + turn complete via HTTP fallback", { timeout: 30000 }, async t => {
    const fx = await fixture();
    try {
        await t.test("empty generate:false warmup completes without starting generation", async () => {
            const events = await fx.probe();
            const resp = completed(events);
            assert.equal(resp.status, "completed");
            assert.deepEqual(resp.output, []);
            assert.equal(fx.lastHttpRequest.generate, false);
            assert.deepEqual(fx.lastHttpRequest.input, []);
            assertHttpEgressShape(fx.lastHttpRequest);
        });
        await t.test("a real turn completes and the egress carries auth + full input", async () => {
            const events = await fx.turn([user("hello")]);
            const resp = completed(events);
            assert.equal(resp.status, "completed");
            const out = resp.output as Item[];
            const msgContent = out[0].content as Array<{ type: string; text?: string }>;
            assert.match(String(msgContent[0].text), /^ok-\d+$/);
            assertAllEgress(fx.httpRows);
        });
        assert.ok(fx.upgradesRefused > 0, "the WS upgrade was attempted and refused (fallback was exercised)");
        assert.ok(fx.httpRows.length >= 2, "probe + turn both egressed over plain HTTP");
    } finally {
        await fx.close();
    }
});

test("tool-call round trip over the fallback preserves exact args, item order and usage", { timeout: 30000 }, async t => {
    const fx = await fixture();
    try {
        await fx.probe();
        const args = JSON.stringify({ action: "status", deep: true, note: 'keep "quotes" \\ intact' });
        fx.setToolArguments(args);
        const events = await fx.turn([user("check status")]);
        const resp = completed(events);
        const out = resp.output as Item[];
        assert.equal(out.length, 1);
        assert.equal(out[0].type, "function_call");
        assert.equal(out[0].arguments, args, "tool-call arguments survive byte-exact over the fallback");
        assert.ok(typeof out[0].call_id === "string" && (out[0].call_id as string).length > 0);
        assert.ok((resp.usage as Item)?.total_tokens, "usage preserved on the terminal");
        const done = events.find(e => e.type === "response.function_call_arguments.done");
        assert.equal(done?.arguments, args);
    } finally {
        await fx.close();
    }
});

test("a warmup establishes a usable checkpoint; a previous_response_id continuation resolves and egresses the merged input", { timeout: 30000 }, async t => {
    const fx = await fixture();
    try {
        const warm = completed(await fx.probe());
        const warmId = warm.id as string;
        assert.ok(warmId, "warmup produced a response id to anchor the checkpoint");
        const events = await fx.turn([user("follow-up")], { previous_response_id: warmId });
        const resp = completed(events);
        assert.equal(resp.status, "completed");
        assertAllEgress(fx.httpRows);
        // The ACP pipeline reformats message text (leading separators, ref markers),
        // so pin presence by substring over the serialized merged input.
        const blobs = fx.httpRows.map(r => JSON.stringify(r.request.input));
        assert.ok(blobs.some(b => b.includes("follow-up")), "the delta's user message egressed to the supplier");
    } finally {
        await fx.close();
    }
});

test("nonempty generate:false warmup produces no output; the continuation merges the developer message", { timeout: 30000 }, async t => {
    const fx = await fixture();
    try {
        const warmEvents = await fx.turn([developer("be brief")], { generate: false });
        const warm = completed(warmEvents);
        assert.equal(warm.status, "completed");
        assert.deepEqual(warm.output, [], "generate:false must not start a supplier generation");
        assert.equal(fx.lastHttpRequest.generate, false);
        const warmId = warm.id as string;
        const cont = completed(await fx.turn([user("q-turn")], { previous_response_id: warmId }));
        assert.equal(cont.status, "completed");
        assertAllEgress(fx.httpRows);
        const merged = fx.httpRows.map(r => JSON.stringify(r.request.input)).find(b => b.includes("q-turn"));
        assert.ok(merged !== undefined, "a request egressed the continuation's user turn");
        assert.ok(String(merged).includes("be brief"), "the warmup's developer baseline survived into the continuation");
        assert.ok(String(merged).indexOf("be brief") < String(merged).indexOf("q-turn"), "the baseline precedes the delta");
    } finally {
        await fx.close();
    }
});

test("an upstream HTTP 400 surfaces as an error frame carrying the original status, not incomplete_response", { timeout: 30000 }, async t => {
    const fx = await fixture();
    try {
        fx.setFailMode("error400");
        const events = await fx.turn([user("boom")]);
        const err = errorEvent(events);
        assert.equal(err.status, 400, "the supplier's HTTP status is preserved");
        assert.notEqual(JSON.stringify(err), JSON.stringify({ type: "error", status: 502 }), "not mislabelled as incomplete_response");
        assert.match(String((err.error as Item)?.message ?? ""), /model not found/);
    } finally {
        await fx.close();
    }
});

test("an unterminated SSE stream resolves explicitly instead of hanging", { timeout: 30000 }, async t => {
    const fx = await fixture();
    try {
        fx.setFailMode("incomplete");
        const events = await fx.turn([user("truncated")]);
        // Whatever in-band signal the pipeline emits for a cut stream, the client
        // must receive a well-formed terminal event rather than hang or get a raw cut.
        assert.ok(events.length > 0, "received events before the cut");
        const last = events[events.length - 1];
        assert.ok(["response.completed", "response.failed", "response.incomplete", "error"].includes(String(last.type)), `terminal event expected, got ${last.type}`);
    } finally {
        await fx.close();
    }
});

test("a missing checkpoint across connections reports previous_response_not_found, then recovers on full history", { timeout: 30000 }, async t => {
    const fx = await fixture();
    try {
        const first = completed(await fx.turn([user("a")]));
        const firstId = first.id as string;
        // A brand-new connection has its own (empty) history — the checkpoint does
        // not leak across sessions.
        const other = await fx.openPeer();
        const refused = await fx.turn([user("b")], { previous_response_id: firstId }, other);
        const err = errorEvent(refused);
        assert.match(JSON.stringify(err), /previous_response_not_found|full input/i);
        const recovered = completed(await fx.turn([user("a"), user("b")], {}, other));
        assert.equal(recovered.status, "completed");
        other.terminate();
    } finally {
        await fx.close();
    }
});

test("a client disconnect aborts an in-flight HTTP fallback egress instead of pinning it", { timeout: 30000 }, async () => {
    const fx = await fixture();
    try {
        fx.setStallNext(true);
        const baseline = _liveUpstreamTimersForTest();
        const turn = fx.turn([user("stall")]);
        const rejected = assert.rejects(turn, /WS client closed/);
        await until(() => fx.httpRows.length >= 1);
        fx.peer.terminate();
        await rejected;
        await until(() => fx.heldAbortedCount === 1);
        assert.equal(_liveUpstreamTimersForTest(), baseline, "no idle-watchdog timer left behind by the aborted egress");
    } finally {
        await fx.close();
    }
});
