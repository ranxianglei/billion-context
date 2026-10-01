import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

function close(server: http.Server | net.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface Harness {
    port: number;
    stop: () => Promise<void>;
    cleanup: () => void;
}

async function startProxy(upstream: http.Server | net.Server, debug: boolean): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-issue1452-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, "{}", "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        sessionHeader: "x-acp-session",
        // log:true routes startServer's local log through the global logger so
        // setLogCapture sees the [conn]/[exposure] lines under test.
        log: true,
        debug,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    return {
        port,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmrf(root);
        },
    };
}

const CHAT_BODY = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
// Streaming variant: without `stream: true` the request takes the non-loop
// pipeThrough path (no compress loop, no in-band error emission) — real agent
// traffic always streams, so these stream-silence tests must too (#1452/#1706).
const STREAM_BODY = JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });

function withEnv(name: string, value: string | undefined): () => void {
    const prev = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    return () => {
        if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
    };
}

test("clientError: parse-fail flood is drained and closed with FIN, never destroy-RST (#1452)", async () => {
    // Upstream is irrelevant — the bytes die in bili's HTTP parser before any
    // forwarding happens.
    const upstream = http.createServer((_req, res) => res.end("{}"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    let harness: Harness | null = null;
    try {
        harness = await startProxy(upstream, false);
        const socket = net.connect(harness.port, "127.0.0.1");
        await once(socket, "connect");
        let sawError: string | null = null;
        socket.on("error", (e) => { sawError = e.code ?? e.message; });
        // Guaranteed llhttp parse failure on byte one; the remaining ~64KB
        // stays unread in the kernel buffer — exactly the residual state that
        // makes a destroy() surface as RST to the peer (verified matrix).
        socket.write(Buffer.alloc(65_536, 0));
        // Bounded: without the clientError disposition, Node's default leaves
        // the peer stranded (no FIN, no RST) and this await would hang CI
        // instead of failing fast (#1452).
        const closedInTime = await Promise.race([
            (async () => { await once(socket, "close"); return true; })(),
            new Promise((r) => setTimeout(() => r(false), 5_000)),
        ]);
        assert.ok(closedInTime, "clientError socket must close promptly; a hang means the drain-then-close disposition regressed (#1452)");
        assert.equal(sawError, null, `client socket must close cleanly, got error ${sawError}`);
        const marker = captured.find((c) => c.msg.includes("[conn] clientError"));
        assert.ok(marker, `expected [conn] clientError log line, got: ${captured.map((c) => c.msg).join(" | ")}`);
        assert.equal(marker!.level, "warn");
    } finally {
        setLogCapture(null);
        if (harness) { await harness.stop(); harness.cleanup(); }
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("lifecycle ledger: client FIN first classifies reason=peer-fin (#1452)", async () => {
    // Keep-alive upstream on purpose: a connection:close upstream makes bili end
    // the client socket itself (prefinish → server-end), which would mask the
    // peer-FIN-first ordering this test pins (#1452).
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    let harness: Harness | null = null;
    try {
        harness = await startProxy(upstream, true);
        const base = captured.length;
        // req.socket is only attached after the first tick even with agent:false —
        // capture it from the response instead (#1452 test hardening).
        // agent:false also defaults to Connection: close; the explicit keep-alive
        // header above is required so bili keeps the socket open post-response.
        const closed = new Promise<void>((resolve) => {
            const req = http.request(
                { host: "127.0.0.1", port: harness.port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(CHAT_BODY), "connection": "keep-alive" } },
                (res) => {
                    const s = res.socket as net.Socket;
                    s.once("close", () => resolve());
                    res.resume();
                    res.on("end", () => s.end());
                },
            );
            req.end(CHAT_BODY);
        });
        await closed;
        // The server-side socket 'close' (emitting the ledger line) queues in
        // this same process but can land AFTER the client-side close we awaited;
        // late closes from earlier tests also leak into the shared capture —
        // hence bounded polling + the reqs=1 anchor (#1452).
        const deadline = Date.now() + 2000;
        let line = captured.slice(base).find((c) => /closed reason=peer-fin .* reqs=1$/.test(c.msg));
        while (!line && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
            line = captured.slice(base).find((c) => /closed reason=peer-fin .* reqs=1$/.test(c.msg));
        }
        assert.ok(line, `expected reason=peer-fin ledger line, got: ${captured.slice(base).filter((c) => c.msg.includes("closed reason=")).map((c) => c.msg).join(" | ")}`);
        assert.equal(line!.level, "debug");
    } finally {
        setLogCapture(null);
        if (harness) { await harness.stop(); harness.cleanup(); }
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("lifecycle ledger: clock-tie between FIN read and prefinish still classifies reason=peer-fin (#1562)", async () => {
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    let harness: Harness | null = null;
    // Freeze performance.now() for the exchange: reproduces the load-induced
    // condition where the end→prefinish gap falls below the clock's effective
    // resolution and both markers come out equal. A strict ordering check then
    // mislabels the close server-end; the ledger must classify ties as peer-fin
    // (every post-response prefinish producer is downstream of the FIN read).
    const perf = performance as unknown as { now: () => number };
    const origNow = perf.now;
    try {
        perf.now = () => 1234567.89;
        harness = await startProxy(upstream, true);
        const base = captured.length;
        const closed = new Promise<void>((resolve) => {
            const req = http.request(
                { host: "127.0.0.1", port: harness.port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(CHAT_BODY), "connection": "keep-alive" } },
                (res) => {
                    const s = res.socket as net.Socket;
                    s.once("close", () => resolve());
                    res.resume();
                    res.on("end", () => s.end());
                },
            );
            req.end(CHAT_BODY);
        });
        await closed;
        const deadline = Date.now() + 2000;
        let line = captured.slice(base).find((c) => /closed reason=peer-fin .* reqs=1$/.test(c.msg));
        while (!line && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
            line = captured.slice(base).find((c) => /closed reason=peer-fin .* reqs=1$/.test(c.msg));
        }
        assert.ok(line, `expected reason=peer-fin ledger line under clock tie, got: ${captured.slice(base).filter((c) => c.msg.includes("closed reason=")).map((c) => c.msg).join(" | ")}`);
    } finally {
        perf.now = origNow;
        setLogCapture(null);
        if (harness) { await harness.stop(); harness.cleanup(); }
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("lifecycle ledger + kat knob: idle keep-alive close classifies reason=idle-timeout as clean FIN (#1452)", async () => {
    const upstream = http.createServer((_req, res) => {
        // Upstream stays keep-alive so bili keeps the client socket open and
        // lets it idle until the kat reaper — that idle window IS the scenario
        // under test (#1452). A connection:close upstream made bili end the
        // client leg right after the response (age≈78ms), never reaching the
        // 300ms reap; teardown-order swap below absorbs any pool redial noise.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    const restoreKat = withEnv("BILI_KEEP_ALIVE_TIMEOUT_MS", "300");
    let harness: Harness | null = null;
    let sock: net.Socket | null = null;
    try {
        const h = await startProxy(upstream, true);
        harness = h;
        const base = captured.length;
        const katLine = captured.find((c) => c.msg.includes("[conn] keepAliveTimeout=300ms"));
        assert.ok(katLine, "expected startup keepAliveTimeout=300ms log line (kat knob wired)");
        // Raw socket on purpose — every higher-level client is nondeterministic
        // here (#1452): agent:false closes its own socket right after the body,
        // and a pooling http.Agent drops the socket because bili's Keep-Alive
        // header truncates sub-second kat to whole seconds (timeout=0 → Node
        // treats the connection as done). Only a raw socket that never sends
        // FIN is the pure-idle peer the kat reaper must close.
        // The no-op 'data' consumer is REQUIRED: Node does not treat a socket
        // with an unread buffered response as idle, so without it the reaper
        // never fires (verified against a vanilla http.Server control).
        const reaped = new Promise<string | null>((resolve, reject) => {
            let sawError: string | null = null;
            const s = net.connect(h.port, "127.0.0.1");
            sock = s;
            s.once("connect", () => {
                s.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(CHAT_BODY)}\r\nConnection: keep-alive\r\n\r\n${CHAT_BODY}`);
            });
            s.on("data", () => {});
            s.on("error", (e) => { sawError = e.code ?? e.message; reject(new Error(`client socket error during idle reap: ${sawError}`)); });
            // Await 'end' (peer FIN), not 'close': a raw socket never ends its
            // own side, so 'close' would hang until we destroyed it ourselves.
            s.once("end", () => resolve(sawError));
        });
        // Measured on Node v22: the reaper lands at ≈kat+1s with ±40ms jitter;
        // the deadline keeps CI-load headroom while a missing reap fails fast.
        const reapTimeout = new Promise<never>((_resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`kat reaper did not FIN the idle socket within 6000ms (kat=300ms)`)), 6000);
            t.unref();
        });
        const sawError = await Promise.race([reaped, reapTimeout]);
        assert.equal(sawError, null, `idle reap must be a clean FIN, got error ${sawError}`);
        // Destroying our side completes the four-way close; the server-side
        // 'close' (which emits the ledger line) only fires after that.
        sock?.destroy();
        // Same same-process close-ordering race as the peer-fin test (#1452).
        const deadline = Date.now() + 2000;
        let line = captured.slice(base).find((c) => /closed reason=idle-timeout .* reqs=1$/.test(c.msg));
        while (!line && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
            line = captured.slice(base).find((c) => /closed reason=idle-timeout .* reqs=1$/.test(c.msg));
        }
        assert.ok(line, `expected reason=idle-timeout ledger line, got: ${captured.slice(base).filter((c) => c.msg.includes("closed reason=")).map((c) => c.msg).join(" | ")}`);
    } finally {
        restoreKat();
        setLogCapture(null);
        if (sock && !sock.destroyed) sock.destroy();
        if (harness) { await harness.stop(); harness.cleanup(); }
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("exposure telemetry: periodic info line with liveConns breakdown (#1452)", async () => {
    const upstream = http.createServer((_req, res) => res.end("{}"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    const restoreExposure = withEnv("BILI_EXPOSURE_LOG_INTERVAL_MS", "100");
    let harness: Harness | null = null;
    try {
        harness = await startProxy(upstream, false);
        await new Promise((r) => setTimeout(r, 400));
        const line = captured.find((c) => /\[exposure\] uptime=/.test(c.msg));
        assert.ok(line, `expected [exposure] telemetry line, got: ${captured.map((c) => c.msg).join(" | ")}`);
        assert.match(line!.msg, /liveConns=\d+ tcpHandles=\d+ handles=\d+ sessions=\d+ blindTunnels=\d+ inFlight=\d+/);
        assert.equal(line!.level, "info");
    } finally {
        restoreExposure();
        setLogCapture(null);
        if (harness) { await harness.stop(); harness.cleanup(); }
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("retired stall guard: stale export ignored + named at startup; idle budget bounds the silence (#1706/#1714)", async () => {
    // First chunk then silence forever — the #1706 incident shape. The retired
    // BILI_STREAM_STALL_MS=400 export must NOT cut this stream at ~400ms; only
    // the 3s idle budget may, and the stale value must be named at startup.
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "connection": "close" });
        res.flushHeaders();
        res.write('data: {"choices":[{"delta":{"content":"chunk-1"}}]}\n\n');
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const restoreStall = withEnv("BILI_STREAM_STALL_MS", "400");
    const restoreIdle = withEnv("BILI_UPSTREAM_TIMEOUT_MS", "3000");
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    let harness: Harness | null = null;
    try {
        harness = await startProxy(upstream, false);
        const retireWarn = captured.find((c) => c.level === "warn" && c.msg.includes("BILI_STREAM_STALL_MS=400") && c.msg.includes("no longer read"));
        assert.ok(retireWarn, `expected startup notice naming the stale export, got: ${captured.map((c) => c.msg).join(" | ").slice(0, 400)}`);
        const ac = new AbortController();
        const guard = setTimeout(() => ac.abort(), 15_000);
        guard.unref?.();
        const started = Date.now();
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: STREAM_BODY,
            signal: ac.signal,
        });
        const body = await res.text();
        const elapsed = Date.now() - started;
        assert.equal(res.status, 200, `headers were committed before the cut, got ${res.status}`);
        assert.ok(body.includes("upstream_stream_truncated"), `expected in-band truncation frame, got: ${body.slice(0, 300)}`);
        assert.ok(body.includes("data: [DONE]"), "stream must terminate with the protocol terminal event");
        // >2s proves the stale 400ms export did not fire; <10s proves the 3s
        // idle budget (or its 2x watchdog) still bounds a dead stream.
        assert.ok(elapsed > 2000, `stale BILI_STREAM_STALL_MS appears to have cut the stream early (${elapsed}ms)`);
        assert.ok(elapsed < 10_000, `idle budget took too long to fire (${elapsed}ms)`);
    } finally {
        restoreStall();
        restoreIdle();
        setLogCapture(null);
        if (harness) { await harness.stop(); harness.cleanup(); }
        upstream.closeAllConnections?.();
        await close(upstream);
        assert.equal(_liveUpstreamTimersForTest(), 0, "no upstream timers leaked after idle abort");
    }
});

test("retired stall guard: mid-stream silence survives any short window even with the stale export set (#1706/#1714)", async () => {
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "connection": "close" });
        res.flushHeaders();
        res.write('data: {"choices":[{"delta":{"content":"chunk-1"}}]}\n\n');
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    // The stale-export shape from #1706: the retired var is set, and the
    // stream still goes silent far past its old 400ms window — nothing may cut it.
    const restoreStall = withEnv("BILI_STREAM_STALL_MS", "400");
    const restoreIdle = withEnv("BILI_UPSTREAM_TIMEOUT_MS", "60000");
    let harness: Harness | null = null;
    try {
        harness = await startProxy(upstream, false);
        const seen: string[] = [];
        const req = http.request(
            { host: "127.0.0.1", port: harness.port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(STREAM_BODY) } },
            (res) => {
                res.setEncoding("utf8");
                res.on("data", (d: string) => seen.push(d));
            },
        );
        req.end(STREAM_BODY);
        await new Promise((r) => setTimeout(r, 2000));
        const soFar = seen.join("");
        assert.ok(soFar.length > 0, "first chunk should have flowed through");
        assert.ok(!soFar.includes("stream error"), `retired guard must not emit a truncation error: ${soFar.slice(0, 300)}`);
        assert.ok(!soFar.includes("[DONE]"), `retired guard must not terminate a still-open stream: ${soFar.slice(0, 300)}`);
        req.destroy();
    } finally {
        restoreStall();
        restoreIdle();
        if (harness) { await harness.stop(); harness.cleanup(); }
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("clientError backstop: silent peer after drain-end is terminated, reason=clienterror-backstop (#1529)", async () => {
    // Adversarial shape: parse-garbage, then silence forever. allowHalfOpen:true
    // is the ONLY pure half-open holder — a default net.Socket auto-ends its
    // write side upon receiving our drain FIN, and that well-behaved path is
    // pinned by the #1452 test above (clean FIN, no error).
    const upstream = http.createServer((_req, res) => res.end("{}"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    const restoreBackstop = withEnv("BILI_CLIENT_ERROR_BACKSTOP_MS", "300");
    let harness: Harness | null = null;
    let sock: net.Socket | null = null;
    try {
        const h = await startProxy(upstream, true);
        harness = h;
        const base = captured.length;
        assert.ok(captured.some((c) => c.msg.includes("[conn] keepAliveTimeout=") && c.msg.includes("clientErrorBackstop=300ms")), "expected startup line pinning clientErrorBackstop=300ms (knob wired)");
        sock = net.connect({ port: h.port, host: "127.0.0.1", allowHalfOpen: true });
        await once(sock, "connect");
        let sawError: string | null = null;
        sock.on("error", (e) => { sawError = e.code ?? e.message; });
        sock.write(Buffer.alloc(65_536, 0));
        const endedInTime = await Promise.race([
            (async () => { await once(sock, "end"); return true; })(),
            new Promise((r) => setTimeout(() => r(false), 5_000)),
        ]);
        assert.ok(endedInTime, `drain FIN must still reach the peer first (bail end() intact), sawError=${sawError}`);
        // The backstop close itself is invisible to the peer: from FIN_WAIT_2
        // with an empty (fully drained) recv queue the kernel transitions to
        // TIME_WAIT quietly — no RST, no second FIN. The anchor is therefore
        // the SERVER-side ledger line, which only the backstop path classifies
        // as clienterror-backstop.
        const deadline = Date.now() + 5000;
        let line = captured.slice(base).find((c) => /closed reason=clienterror-backstop .* reqs=0$/.test(c.msg));
        while (!line && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
            line = captured.slice(base).find((c) => /closed reason=clienterror-backstop .* reqs=0$/.test(c.msg));
        }
        assert.ok(line, `expected reason=clienterror-backstop ledger line, got: ${captured.slice(base).filter((c) => c.msg.includes("closed reason=")).map((c) => c.msg).join(" | ")}`);
        assert.equal(line!.level, "debug");
        const marker = captured.find((c) => c.level === "warn" && c.msg.includes("clientError backstop"));
        assert.ok(marker, "expected the distinct backstop warn marker");
        assert.equal(sawError, null, `backstop destroy must carry no unread residual bytes (no RST to the peer), got ${sawError}`);
    } finally {
        restoreBackstop();
        setLogCapture(null);
        if (sock && !sock.destroyed) sock.destroy();
        if (harness) { await harness.stop(); harness.cleanup(); }
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("clientError backstop: knob off restores hold-until-peer-FIN status quo (#1529)", async () => {
    const upstream = http.createServer((_req, res) => res.end("{}"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    const restoreBackstop = withEnv("BILI_CLIENT_ERROR_BACKSTOP_MS", "0");
    const restoreExposure = withEnv("BILI_EXPOSURE_LOG_INTERVAL_MS", "100");
    let harness: Harness | null = null;
    let sock: net.Socket | null = null;
    try {
        const h = await startProxy(upstream, true);
        harness = h;
        const base = captured.length;
        assert.ok(captured.some((c) => c.msg.includes("clientErrorBackstop=0ms")), "expected startup line pinning clientErrorBackstop=0ms (knob off)");
        // Same adversarial half-open holder as above.
        sock = net.connect({ port: h.port, host: "127.0.0.1", allowHalfOpen: true });
        await once(sock, "connect");
        let closedEarly = false;
        sock.on("close", () => { closedEarly = true; });
        sock.write(Buffer.alloc(65_536, 0));
        const endedInTime = await Promise.race([
            (async () => { await once(sock, "end"); return true; })(),
            new Promise((r) => setTimeout(() => r(false), 5_000)),
        ]);
        assert.ok(endedInTime, "drain FIN must reach the peer even with the backstop disabled");
        // Past the moment a 300ms backstop would have fired: with the knob off
        // the socket must STILL be held on our side. Observable via the
        // [exposure] telemetry (liveConns counts connRecords entries).
        await new Promise((r) => setTimeout(r, 800));
        assert.ok(!closedEarly, "with backstop disabled the socket must not be terminated early");
        const held = captured.slice(base).some((c) => /liveConns=1\b/.test(c.msg));
        assert.ok(held, `expected an [exposure] line showing the half-open socket still held (liveConns=1), got: ${captured.slice(base).filter((c) => c.msg.startsWith("[exposure]")).map((c) => c.msg).join(" | ")}`);
        assert.ok(!captured.slice(base).some((c) => c.msg.includes("reason=clienterror-backstop")), "disabled backstop must not fire");
        // Peer FIN now → clean close classified server-end (we ended first at bail).
        sock.end();
        const deadline = Date.now() + 2000;
        let line = captured.slice(base).find((c) => /closed reason=server-end .* reqs=0$/.test(c.msg));
        while (!line && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
            line = captured.slice(base).find((c) => /closed reason=server-end .* reqs=0$/.test(c.msg));
        }
        assert.ok(line, `expected reason=server-end after peer FIN, got: ${captured.slice(base).filter((c) => c.msg.includes("closed reason=")).map((c) => c.msg).join(" | ")}`);
    } finally {
        restoreBackstop();
        restoreExposure();
        setLogCapture(null);
        if (sock && !sock.destroyed) sock.destroy();
        if (harness) { await harness.stop(); harness.cleanup(); }
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("clientError backstop: knob parse — negative / non-numeric fall back to the 30s default (#1529)", async () => {
    // Pins the documented contract (CONFIGURATION.md + PR body): only a valid
    // non-negative integer is honored (0 disables); a negative or non-numeric
    // value falls back to the 30s default rather than silently disabling the
    // backstop. The value is read at startServer, so each case boots its own
    // proxy and reads the [conn] startup line that echoes the resolved value.
    const upstream = http.createServer((_req, res) => res.end("{}"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    const bootLine = async (value: string | undefined): Promise<string> => {
        const restore = withEnv("BILI_CLIENT_ERROR_BACKSTOP_MS", value);
        try {
            const base = captured.length;
            const h = await startProxy(upstream, true);
            try {
                return (captured.slice(base).find((c) => c.msg.includes("clientErrorBackstop="))?.msg ?? "");
            } finally {
                await h.stop(); h.cleanup();
            }
        } finally {
            restore();
        }
    };
    try {
        assert.ok((await bootLine("-5")).includes("clientErrorBackstop=30000ms"), "negative knob must fall back to the 30s default");
        assert.ok((await bootLine("garbage")).includes("clientErrorBackstop=30000ms"), "non-numeric knob must fall back to the 30s default");
    } finally {
        setLogCapture(null);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});
