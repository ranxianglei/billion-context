// A graceful shutdown (POST /__bili/shutdown, SIGTERM) waits for requests in
// flight, not for idle connections. An idle CONNECT tunnel used to hold the
// drain through every backstop pass (110 s measured), so a replacement bili
// could not bind the port and systemd killed the process before its session
// flush. The fixture runs in a child process because shutdown ends in
// process.exit(0).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { rmrf } from "./tmp-rm.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/shutdown-idle-tunnel-bili.mts", import.meta.url));
const READY_TIMEOUT_MS = 30_000;
const EXIT_BOUND_MS = 4_000;
const DELTAS = 8;
const PASSTHROUGH_PATH = "/v1/shutdown-probe";
const PASSTHROUGH_DELTAS = 16;
const DELTA_INTERVAL_MS = 250;

interface Bili {
    port: number;
    exitCode: () => number | null | undefined;
    waitExit: (ms: number) => Promise<number | null | undefined>;
    stderrTail: () => string;
    stop: () => Promise<void>;
}

async function spawnBili(upstream: string): Promise<Bili> {
    const root = path.join(tmpdir(), `bili-shutdown-tunnel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(BILI_|BILLION_CONTEXT_)/.test(k) || /^(https?|all|no)_proxy$/i.test(k)) continue;
        env[k] = v;
    }
    for (const [k, sub] of [["XDG_CONFIG_HOME", "cfg"], ["XDG_STATE_HOME", "state"], ["XDG_CACHE_HOME", "cache"], ["XDG_DATA_HOME", "data"], ["BILI_SESSIONS_DIR", "sessions"]] as const) {
        env[k] = path.join(root, sub);
        mkdirSync(env[k]!, { recursive: true });
    }
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", FIXTURE, upstream], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => { stdout += String(c); });
    child.stderr!.on("data", (c) => { stderr += String(c); });
    let code: number | null | undefined;
    const exited = new Promise<void>((resolve) => child.on("exit", (c) => { code = c; resolve(); }));
    const stop = async (): Promise<void> => {
        if (code === undefined && child.pid) {
            child.kill("SIGKILL");
            await exited;
        }
        try { rmrf(root); } catch { /* best-effort */ }
    };
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let port = 0;
    while (!port && Date.now() < deadline && code === undefined) {
        const m = /^READY (\d+)$/m.exec(stdout);
        if (m) port = Number(m[1]);
        else await new Promise((r) => setTimeout(r, 50));
    }
    if (!port) {
        await stop();
        throw new Error(`fixture never reported READY (stderr tail: ${stderr.slice(-800)})`);
    }
    return {
        port,
        exitCode: () => code,
        waitExit: async (ms) => {
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([exited, new Promise((r) => { timer = setTimeout(r, ms); })]);
            clearTimeout(timer);
            return code;
        },
        stderrTail: () => stderr.slice(-1500),
        stop,
    };
}

async function startEcho(): Promise<{ port: number; close: () => void }> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
        s.on("error", () => { /* bili cut the tunnel */ });
        s.pipe(s);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        port: (server.address() as net.AddressInfo).port,
        close: () => { for (const s of sockets) s.destroy(); server.close(); },
    };
}

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startFlood(): Promise<{ port: number; close: () => void }> {
    const chunk = Buffer.alloc(64 * 1024, 120);
    const server = net.createServer((socket) => {
        socket.on("error", () => { /* bili cut the tunnel */ });
        socket.once("data", () => {
            const pump = (): void => {
                while (!socket.destroyed && socket.write(chunk)) { /* fill until backpressure */ }
                if (!socket.destroyed) socket.once("drain", pump);
            };
            pump();
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as net.AddressInfo;
    return { port, close: () => { server.close(); } };
}

const BIG_REPLY_BYTES = 24 * 1024 * 1024;

function decodeBody(head: string, rest: Buffer): Buffer | null {
    const length = /\r\ncontent-length: (\d+)/i.exec(head);
    if (length) return rest.length === Number(length[1]) ? rest : null;
    if (!/\r\ntransfer-encoding: chunked/i.test(head)) return null;
    const parts: Buffer[] = [];
    let at = 0;
    for (;;) {
        const eol = rest.indexOf("\r\n", at);
        if (eol < 0) return null;
        const size = parseInt(rest.subarray(at, eol).toString("latin1"), 16);
        if (Number.isNaN(size)) return null;
        if (size === 0) return Buffer.concat(parts);
        if (rest.length < eol + 2 + size + 2) return null;
        parts.push(rest.subarray(eol + 2, eol + 2 + size));
        at = eol + 2 + size + 2;
    }
}

async function startBigJsonUpstream(): Promise<{ url: string; release: () => void; requested: Promise<void>; close: () => void }> {
    let release = (): void => { /* set below */ };
    const released = new Promise<void>((r) => { release = r; });
    let markRequested = (): void => { /* set below */ };
    const requested = new Promise<void>((r) => { markRequested = r; });
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            markRequested();
            void released.then(() => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_big", type: "message", role: "assistant", model: "shutdown-model",
                    content: [{ type: "text", text: "x".repeat(BIG_REPLY_BYTES) }],
                    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 },
                }));
            });
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
        release: () => release(),
        requested,
        close: () => { server.closeAllConnections(); server.close(); },
    };
}

async function startSlowUpstream(): Promise<{ url: string; close: () => void }> {
    const server = http.createServer((req, res) => {
        req.resume();
        const deltas = req.url === PASSTHROUGH_PATH ? PASSTHROUGH_DELTAS : DELTAS;
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(sse("message_start", { type: "message_start", message: { id: "msg_shutdown", type: "message", role: "assistant", model: "shutdown-model", content: [], usage: { input_tokens: 10, output_tokens: 0 } } }));
            res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            let i = 0;
            const timer = setInterval(() => {
                if (res.destroyed) { clearInterval(timer); return; }
                if (i < deltas) {
                    res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `d${i}|` } }));
                    i += 1;
                    return;
                }
                clearInterval(timer);
                res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
                res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: deltas } }));
                res.end(sse("message_stop", { type: "message_stop" }));
            }, DELTA_INTERVAL_MS);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
        close: () => { server.closeAllConnections(); server.close(); },
    };
}

interface Tunnel {
    socket: net.Socket;
    closedAt: () => number | undefined;
}

async function openTunnel(biliPort: number, targetPort: number): Promise<Tunnel> {
    const socket = net.connect(biliPort, "127.0.0.1");
    let closedAt: number | undefined;
    socket.on("close", () => { closedAt = Date.now(); });
    socket.on("error", () => { /* bili cut the tunnel */ });
    await once(socket, "connect");
    socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
    let buf = "";
    while (!buf.includes("\r\n\r\n")) {
        const [chunk] = await once(socket, "data") as [Buffer];
        buf += chunk.toString("latin1");
    }
    assert.match(buf, /^HTTP\/1\.1 200 /, `CONNECT answered 200 (got ${JSON.stringify(buf)})`);
    socket.write("ping");
    const [echoed] = await once(socket, "data") as [Buffer];
    assert.equal(echoed.toString(), "ping", "the tunnel relays bytes to the target and back");
    return { socket, closedAt: () => closedAt };
}

async function requestShutdown(biliPort: number): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${biliPort}/__bili/shutdown`, { method: "POST" });
    assert.equal(res.status, 202, "admin shutdown accepted");
    await res.text();
}

interface StreamResult {
    status: number;
    body: string;
    complete: boolean;
    endedAt: number;
}

function startStream(biliPort: number, urlPath: string): { firstByte: Promise<void>; done: Promise<StreamResult> } {
    let markFirst = (): void => { /* set below */ };
    let failFirst = (_e: Error): void => { /* set below */ };
    const firstByte = new Promise<void>((resolve, reject) => { markFirst = resolve; failFirst = reject; });
    const done = new Promise<StreamResult>((resolve, reject) => {
        const payload = JSON.stringify({ model: "shutdown-model", max_tokens: 4096, stream: true, messages: [{ role: "user", content: "stream through shutdown" }] });
        const req = http.request({
            host: "127.0.0.1",
            port: biliPort,
            path: urlPath,
            method: "POST",
            agent: false,
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-acp-session": `shutdown-drain-${urlPath}`, "anthropic-version": "2023-06-01", "x-api-key": "test-key" },
        }, (res) => {
            let body = "";
            let complete = false;
            res.setEncoding("utf8");
            res.on("data", (c: string) => { body += c; markFirst(); });
            res.on("end", () => { complete = true; });
            res.on("close", () => resolve({ status: res.statusCode ?? 0, body, complete, endedAt: Date.now() }));
            res.on("error", () => { /* surfaced as complete=false */ });
        });
        req.on("error", (e) => { failFirst(e); reject(e); });
        req.end(payload);
    });
    return { firstByte, done };
}

test("shutdown with only an idle CONNECT tunnel open exits promptly", { timeout: 60_000 }, async () => {
    const echo = await startEcho();
    const bili = await spawnBili("http://127.0.0.1:1");
    try {
        const tunnel = await openTunnel(bili.port, echo.port);
        const t0 = Date.now();
        await requestShutdown(bili.port);
        const code = await bili.waitExit(EXIT_BOUND_MS);
        const elapsed = Date.now() - t0;
        assert.notEqual(code, undefined, `bili must exit within ${EXIT_BOUND_MS} ms of the shutdown request when nothing is in flight; still alive after ${elapsed} ms (stderr tail: ${bili.stderrTail()})`);
        assert.equal(code, 0, "clean exit code");
        assert.notEqual(tunnel.closedAt(), undefined, "the idle tunnel was closed");
    } finally {
        await bili.stop();
        echo.close();
    }
});

test("shutdown with a tunnel whose client stopped reading still exits promptly", { timeout: 60_000 }, async () => {
    const flood = await startFlood();
    const bili = await spawnBili("http://127.0.0.1:1");
    try {
        const socket = net.connect(bili.port, "127.0.0.1");
        socket.on("error", () => { /* bili cut the tunnel */ });
        await once(socket, "connect");
        socket.write(`CONNECT 127.0.0.1:${flood.port} HTTP/1.1\r\nHost: 127.0.0.1:${flood.port}\r\n\r\n`);
        let received = 0;
        const flooding = new Promise<void>((resolve) => {
            const onData = (chunk: Buffer): void => {
                received += chunk.length;
                if (received < 1024 * 1024) return;
                socket.off("data", onData);
                socket.pause();
                resolve();
            };
            socket.on("data", onData);
        });
        socket.write("go");
        await flooding;
        await new Promise((r) => setTimeout(r, 500));
        const t0 = Date.now();
        await requestShutdown(bili.port);
        const code = await bili.waitExit(EXIT_BOUND_MS);
        const elapsed = Date.now() - t0;
        assert.notEqual(code, undefined, `a tunnel with unflushed bytes must not hold the drain; still alive after ${elapsed} ms (stderr tail: ${bili.stderrTail()})`);
        assert.equal(code, 0, "clean exit code");
    } finally {
        await bili.stop();
        flood.close();
    }
});

test("a reply still in bili's write buffer when the last request ends reaches a slow client before the cut", { timeout: 60_000 }, async () => {
    const upstream = await startBigJsonUpstream();
    const bili = await spawnBili(upstream.url);
    try {
        const payload = JSON.stringify({ model: "shutdown-model", max_tokens: 4096, stream: false, messages: [{ role: "user", content: "big reply through shutdown" }] });
        const socket = net.connect(bili.port, "127.0.0.1");
        socket.on("error", () => { /* surfaced as a short body */ });
        await once(socket, "connect");
        socket.write(`POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nx-acp-session: shutdown-drain-big\r\nanthropic-version: 2023-06-01\r\nx-api-key: test-key\r\nConnection: close\r\n\r\n${payload}`);
        await upstream.requested;
        await requestShutdown(bili.port);
        const chunks: Buffer[] = [];
        const closed = new Promise<void>((r) => socket.once("close", () => r()));
        const firstData = new Promise<void>((resolve) => {
            socket.once("data", (chunk: Buffer) => {
                chunks.push(chunk);
                socket.pause();
                resolve();
            });
        });
        upstream.release();
        await firstData;
        await new Promise((r) => setTimeout(r, 600));
        socket.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        socket.resume();
        await closed;
        const raw = Buffer.concat(chunks);
        const split = raw.indexOf("\r\n\r\n");
        assert.ok(split > 0, "response headers arrived");
        const head = raw.subarray(0, split).toString("latin1");
        assert.match(head, /^HTTP\/1\.1 200 /, "reply status 200");
        const body = decodeBody(head, raw.subarray(split + 4));
        assert.ok(body !== null, `the whole reply reached the client before bili closed the socket (${raw.length - split - 4} body bytes; head ${JSON.stringify(head)})`);
        const parsed = JSON.parse(body.toString("utf8")) as { content: Array<{ text: string }> };
        assert.equal(parsed.content[0].text.length, BIG_REPLY_BYTES, "reply text intact");
        const code = await bili.waitExit(EXIT_BOUND_MS);
        assert.equal(code, 0, `bili exits after the reply is delivered (stderr tail: ${bili.stderrTail()})`);
    } finally {
        await bili.stop();
        upstream.close();
    }
});

test("streams in flight at shutdown finish before the idle tunnel closes and bili exits", { timeout: 60_000 }, async () => {
    const echo = await startEcho();
    const upstream = await startSlowUpstream();
    const bili = await spawnBili(upstream.url);
    try {
        const tunnel = await openTunnel(bili.port, echo.port);
        const model = startStream(bili.port, "/v1/messages");
        const passthrough = startStream(bili.port, PASSTHROUGH_PATH);
        await Promise.all([model.firstByte, passthrough.firstByte]);
        await requestShutdown(bili.port);
        const results = await Promise.all([model.done, passthrough.done]);
        const lastEnd = Math.max(...results.map((r) => r.endedAt));
        for (const [name, r, deltas] of [["model", results[0], DELTAS], ["passthrough", results[1], PASSTHROUGH_DELTAS]] as const) {
            assert.equal(r.status, 200, `${name} stream status`);
            assert.ok(r.complete, `${name} stream ended cleanly, not cut (body tail: ${r.body.slice(-300)}; stderr tail: ${bili.stderrTail()})`);
            for (let i = 0; i < deltas; i++) assert.ok(r.body.includes(`d${i}|`), `${name} stream carries delta ${i}`);
            assert.match(r.body, /message_stop/, `${name} stream carries its terminal event`);
        }
        const tunnelClosed = tunnel.closedAt();
        assert.ok(tunnelClosed === undefined || tunnelClosed >= lastEnd, `the idle tunnel stays open until the last stream ends (closed ${tunnelClosed !== undefined ? tunnelClosed - lastEnd : "n/a"} ms relative to stream end)`);
        const code = await bili.waitExit(EXIT_BOUND_MS);
        assert.notEqual(code, undefined, `bili must exit within ${EXIT_BOUND_MS} ms of the last stream ending (stderr tail: ${bili.stderrTail()})`);
        assert.equal(code, 0, "clean exit code");
    } finally {
        await bili.stop();
        upstream.close();
        echo.close();
    }
});
