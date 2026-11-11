// #6171: pre-first-event WS failures were undiagnosable — the log line carried only
// event.type + close_code, so a raw TCP drop (undici fires 'error', then a synchronous
// 'close'(1006)) read as `event=error close_code=none`, a clean server close lost its
// reason text, nothing correlated the client-visible terminal state with the failure or
// with later recovery, and a fully stalled upstream hung the exchange until the client
// gave up (no server-side idle budget on the WS leg). This suite pins:
//   (a) transport loss before the first event → two correlated lines under the SAME
//       conn stamp (error + follow-up close 1006), each with elapsed_ms/received_events;
//       the client gets EXACTLY ONE object-form terminal frame; the next turn succeeds
//       and logs recovery=ok;
//   (b) a clean server close keeps its code + cleanness on a single line, and its
//       free-text reason never reaches the log (untrusted upstream content);
//   (c) BILI_WS_IDLE_TIMEOUT_MS terminates a stalled exchange in one terminal state
//       and the next turn recovers;
//   (d) the knob resolves env > file > 10-minute default, garbage falls back.
// The refused-handshake fallback (#3342) keeps its own regression test in
// tests/responses-websocket.test.ts, updated in place for the enriched handshake lines.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { wsIdleTimeoutMs } from "../src/knobs.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";

type Item = Record<string, unknown>;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6171-home-"));
process.env.XDG_STATE_HOME = testHome;
process.env.XDG_DATA_HOME = testHome;
process.env.XDG_CACHE_HOME = testHome;

const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

interface F6171 {
    sid: string;
    peer: WebSocket;
    proxy: http.Server;
    upstream: http.Server;
    wss: WebSocketServer;
    logPath: string;
    frame: (input: Item[], extra?: Item) => string;
    exchange: (payload: string) => Promise<Item[]>;
    close: () => Promise<void>;
}

/** Full codex-lane fixture; the mock upstream decides per-turn behavior via callback. */
async function fixture(turnBehavior: (peer: WebSocket, turnIndex: number) => void): Promise<F6171> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6171-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let turns = 0;
    const upstream = http.createServer((req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", peer => {
        peer.on("message", raw => {
            const request = JSON.parse(raw.toString()) as Item;
            if (Array.isArray(request.input) && request.input.length === 0 && request.generate === false) {
                peer.send(JSON.stringify({ type: "response.created", response: { id: "resp_probe", status: "in_progress", output: [] } }));
                peer.send(JSON.stringify({ type: "response.completed", response: { id: "resp_probe", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 } } }));
                return;
            }
            turnBehavior(peer, turns++);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const config = defaultConfig(200000);
    config.preserveRecentTokens = 0;
    const opts: ProxyOptions = { host: "127.0.0.1", port: 0, upstream: upstreamOrigin, routes: {}, modelContextLimit: 200000, kernelConfig: config, compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, logFile: path.join(tmp, "bili.log"), debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const sid = `codex-thread-6171-${randomUUID()}`;
    const peer = new WebSocket(`${proxyOrigin.replace(/^http/, "ws")}/bili/${upstreamOrigin}/v1/responses`, { headers: { authorization: "Bearer fake-credential", "session-id": sid, "thread-id": sid, "openai-beta": "responses_websockets=2026-02-06", "user-agent": "codex_exec/0.166.0" } });
    await once(peer, "open");
    peer.on("error", () => {});
    const frame = (input: Item[], extra: Item = {}): string => JSON.stringify({ type: "response.create", model: "gpt-5.2", instructions: "You are Codex", store: false, stream: true, prompt_cache_key: sid, tools: [], input, client_metadata: { session_id: sid, thread_id: sid }, ...extra });
    const exchange = (payload: string): Promise<Item[]> => new Promise((resolve, reject) => {
        peer.send(payload);
        const events: Item[] = [];
        const timer = setTimeout(() => { cleanup(); reject(new Error("WS turn timed out")); }, 20000);
        const cleanup = (): void => { clearTimeout(timer); peer.off("message", onMessage); peer.off("close", onClose); };
        const onClose = (): void => { cleanup(); reject(new Error("WS client closed")); };
        const onMessage = (raw: WebSocket.RawData): void => {
            const event = JSON.parse(raw.toString()) as Item;
            events.push(event);
            if (["response.completed", "response.failed", "response.incomplete", "error"].includes(String(event.type))) {
                cleanup();
                resolve(events);
            }
        };
        peer.on("message", onMessage);
        peer.once("close", onClose);
    });
    return {
        sid, peer, proxy, upstream, wss, logPath: path.join(tmp, "bili.log"), frame, exchange,
        close: async () => {
            peer.terminate();
            for (const client of wss.clients) client.terminate();
            await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
            wss.close();
        },
    };
}

/** The logger flushes asynchronously (#1971 class) — poll until the pattern lands. */
async function waitForLog(logPath: string, pattern: RegExp, timeoutMs = 15000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let text = "";
    for (;;) {
        text = fs.readFileSync(logPath, "utf8");
        if (pattern.test(text)) return text;
        if (Date.now() > deadline) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`log did not match ${pattern} within ${timeoutMs}ms; tail:\n${text.slice(-2000)}`);
}

const failedLines = (log: string): string[] => log.split("\n").filter(line => line.includes("upstream failed"));

test("#6171 transport loss before the first event: correlated lines, one client terminal, recovery logged", { timeout: 60000 }, async () => {
    const f = await fixture((peer, turnIndex) => {
        if (turnIndex === 0) peer.terminate(); // raw TCP drop: undici fires 'error' THEN a synchronous close(1006)
        else answerTurn(peer);
    });
    try {
        const events = await f.exchange(f.frame([user("hello")]));
        const errors = events.filter(e => e.type === "error");
        assert.equal(errors.length, 1, `the client must see exactly ONE terminal frame, got: ${JSON.stringify(events.map(e => String(e.type)))}`);
        const error = errors[0];
        assert.equal(typeof error.error, "object", "WS-lane error contract: object form (#4601)");
        assert.equal((error.error as Item).code, "proxy_failure");
        assert.equal(error.status, 502);
        assert.match(String((error.error as Item).message), /disconnected before completion/);
        // Both failure lines land under the SAME conn/session stamp, each carrying
        // elapsed_ms + received_events — the correlation the old line could not give.
        const log = await waitForLog(f.logPath, /upstream failed phase=await-first-event event=error error_class=\w+ error_message=\S+ elapsed_ms=\d+ received_events=0/);
        const log2 = await waitForLog(f.logPath, /upstream failed phase=await-first-event event=close close_code=1006 was_clean=false elapsed_ms=\d+ received_events=0/);
        const lines = failedLines(log2);
        assert.equal(lines.length, 2, `expected exactly two failure lines per exchange, got ${lines.length}:\n${lines.join("\n")}`);
        assert.match(lines[0], /event=error error_class=\w+ error_message=\S+/);
        assert.match(lines[1], /event=close close_code=1006 was_clean=false/);
        const connOf = (line: string): string => line.match(/conn=(\d+)/)?.[1] ?? "";
        assert.equal(connOf(lines[0]), connOf(lines[1]), "both failure lines must share the conn stamp");
        // The client-visible terminal state is named in the log, paired with the upstream line.
        await waitForLog(f.logPath, /client terminal=synthesized code=proxy_failure status=502/);
        // Recovery: the next turn rides a fresh upstream connection and succeeds.
        const recovered = await f.exchange(f.frame([user("again")]));
        assert.ok(recovered.some(e => e.type === "response.completed"), JSON.stringify(recovered.map(e => String(e.type))));
        const log3 = await waitForLog(f.logPath, /recovery=ok after_ms=\d+/);
        assert.equal(failedLines(log3).length, 2, "the recovered turn must not add failure lines");
    } finally { await f.close(); }
});

test("#6171 clean upstream close keeps its code on one line; the free-text reason never reaches the log", { timeout: 60000 }, async () => {
    const f = await fixture((peer) => peer.close(1013, "private-upstream-close-reason-6171"));
    try {
        const events = await f.exchange(f.frame([user("hi")]));
        const errors = events.filter(e => e.type === "error");
        assert.equal(errors.length, 1, JSON.stringify(events.map(e => String(e.type))));
        assert.equal(typeof errors[0].error, "object");
        const log = await waitForLog(f.logPath, /upstream failed phase=await-first-event event=close close_code=1013 was_clean=true elapsed_ms=\d+ received_events=0/);
        const lines = failedLines(log);
        assert.equal(lines.length, 1, `a clean close is ONE line (no phantom follow-up), got ${lines.length}:\n${lines.join("\n")}`);
        // The close reason is arbitrary upstream-set text — untrusted content that must
        // stay out of the log entirely (same contract the leak guard in
        // tests/responses-websocket.test.ts pins for the stream-phase close).
        assert.doesNotMatch(log, /private-upstream-close-reason-6171/, "the upstream close reason must never be logged");
    } finally { await f.close(); }
});

test("#6171 idle watchdog: a stalled upstream fails the exchange once, next turn recovers", { timeout: 60000 }, async () => {
    const prev = process.env.BILI_WS_IDLE_TIMEOUT_MS;
    process.env.BILI_WS_IDLE_TIMEOUT_MS = "400";
    let stalled = false;
    try {
        const f = await fixture((peer) => {
            if (!stalled) { stalled = true; return; } // accept the create frame, never send anything
            answerTurn(peer);
        });
        try {
            const events = await f.exchange(f.frame([user("stall me")]));
            const errors = events.filter(e => e.type === "error");
            assert.equal(errors.length, 1, JSON.stringify(events.map(e => String(e.type))));
            assert.equal(typeof errors[0].error, "object");
            assert.equal((errors[0].error as Item).code, "proxy_failure");
            assert.match(String((errors[0].error as Item).message), /timed out before completion/);
            const log = await waitForLog(f.logPath, /upstream failed phase=await-first-event event=timeout reason=idle-timeout elapsed_ms=\d+ received_events=0/);
            const recovered = await f.exchange(f.frame([user("again")]));
            assert.ok(recovered.some(e => e.type === "response.completed"), JSON.stringify(recovered.map(e => String(e.type))));
            const log2 = await waitForLog(f.logPath, /recovery=ok after_ms=\d+/);
            assert.equal(failedLines(log2).length, 1, "one timeout line per stalled exchange");
        } finally { await f.close(); }
    } finally {
        if (prev === undefined) delete process.env.BILI_WS_IDLE_TIMEOUT_MS;
        else process.env.BILI_WS_IDLE_TIMEOUT_MS = prev;
    }
});

test("#6171 wsIdleTimeoutMs resolves env > file > 10-minute default; garbage falls back", () => {
    const prev = process.env.BILI_WS_IDLE_TIMEOUT_MS;
    try {
        assert.equal(wsIdleTimeoutMs(), 600000, "owner-set default: 10 minutes");
        process.env.BILI_WS_IDLE_TIMEOUT_MS = "4321";
        assert.equal(wsIdleTimeoutMs(), 4321);
        process.env.BILI_WS_IDLE_TIMEOUT_MS = "abc";
        assert.equal(wsIdleTimeoutMs(), 600000, "garbage env falls back to the default, never NaN");
        process.env.BILI_WS_IDLE_TIMEOUT_MS = "-5";
        assert.equal(wsIdleTimeoutMs(), 600000, "non-positive values fall back to the default");
    } finally {
        if (prev === undefined) delete process.env.BILI_WS_IDLE_TIMEOUT_MS;
        else process.env.BILI_WS_IDLE_TIMEOUT_MS = prev;
    }
});

function answerTurn(peer: WebSocket): void {
    const id = `resp_${randomUUID()}`;
    const item: Item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] };
    peer.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
    peer.send(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }));
    peer.send(JSON.stringify({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "ok" }));
    peer.send(JSON.stringify({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "ok" }));
    peer.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
    peer.send(JSON.stringify({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } }));
}
