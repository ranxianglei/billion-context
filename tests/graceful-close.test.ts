import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureRootCA, rootCaPath, mintHostCert, _resetForTest } from "../src/ca.js";
import { rmrf } from "./tmp-rm.ts";

// #1982: the proxy-initiated post-response close must be graceful
// (close_notify + FIN) instead of an abortive destroy that races unACKed bytes
// into an RST. Asserted against a REAL bili server in a child process (see
// tests/fixtures/graceful-close-bili.mts for why), with the connection
// lifecycle ledger lines captured from its stderr.
//
// Single top-level test with explicit step sequencing: node:test's root
// test.after hook fires after the FIRST awaited top-level test completes, not
// after all of them — hook-based teardown would SIGKILL the child mid-suite.
//
// Child env pins: BILI_POST_RESPONSE_LINGER_MS=400 (backstop step stays fast;
// happy paths FIN in milliseconds so the shorter budget never bites them),
// BILI_KEEP_ALIVE_TIMEOUT_MS=300 (idle-reaper regression guard stays fast),
// BILI_MITM_HANDSHAKE_TIMEOUT_MS=600 (pre-handshake teardown step stays fast).
//
// #3454: windows-latest shards intermittently stall a leg's TRANSPORT (TCP
// connect / TLS handshake / response body) under runner load, past even
// generous per-phase budgets, with nothing to recover — one slow attempt is a
// hard red that blocks merge. Two test-side-only backstops:
//   1. load-tolerant budgets (the happy path is milliseconds; these sit far
//      above it, sized against the observed 11.6s flake window);
//   2. a ONE-SHOT full-scenario retry on a fresh child + fresh ports — a
//      wedged accept queue cannot carry over between attempts.
// Only TransportTimeout is retriable. Behavior assertions and behavior-line
// waits (linger/idle/pre-handshake lifecycle lines) propagate immediately:
// those ARE the product contract, and a real graceful-close regression must
// fail fast on attempt 1, never be retried away. Server side is untouched —
// listen/close semantics are the verified #1982 contract.

let caDir = "", stateDir = "", homeDir = "";
let caPath = "", rootPem = "";
let leafCert = "", leafKey = "";
let child: ChildProcess | undefined;
let monTimer: ReturnType<typeof setInterval> | undefined;
let biliPort = 0, tlsUpPort = 0, plainUpPort = 0;
let tlsUp: tls.Server | undefined, plainUp: http.Server | undefined;
let stdoutBuf = "";
const logLines: string[] = [];

const FIXTURE = fileURLToPath(new URL("./fixtures/graceful-close-bili.mts", import.meta.url));

// #3454 load-tolerant transport budgets (see header). The happy path completes
// in milliseconds; these are abort backstops for a loaded runner, not pacing.
const CONNECT_TIMEOUT_MS = 5_000;   // CONNECT status line
const HANDSHAKE_TIMEOUT_MS = 5_000; // TLS secureConnect / plain connect
const RESPONSE_BUDGET_MS = 15_000;  // full response body (was 8_000 — floored at the observed 11.6s flake window)
const READY_TIMEOUT_MS = 30_000;    // child prints READY <port>

/** A leg's transport stalled (connect/handshake/response/ready) — retriable
 *  once on a fresh scenario. Distinct from assert failures and behavior-line
 *  waits, which are NOT retriable and surface immediately. */
class TransportTimeout extends Error {}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
// once(server, "close") rejects/hangs if the server is already closed — guard with a timer.
function closeServer(s: net.Server | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (!s) { resolve(); return; }
        (s as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        const t = setTimeout(resolve, 2_000);
        s.on("close", () => { clearTimeout(t); resolve(); });
        // close() stops accepting — without it the server handle keeps the
        // test process alive long after the suite ends.
        s.close();
    });
}
const PHASE_T0 = Date.now();
function phase(msg: string): void { process.stderr.write(`[gc-test] t=${Date.now() - PHASE_T0}ms ${msg}\n`); }
/** Await one event, bounded. `transport=true` tags the timeout as a
 *  TransportTimeout (retriable); otherwise a plain Error. */
async function onceCap<T extends NodeJS.EventEmitter>(target: T, ev: string, ms: number, transport?: boolean): Promise<void[]> {
    let to: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { to = setTimeout(() => reject(transport ? new TransportTimeout(`${ev} timeout ${ms}ms`) : new Error(`${ev} timeout ${ms}ms`)), ms); });
    try { return await Promise.race([once(target, ev), timeout]); } finally { clearTimeout(to!); }
}
function mark(): number { return logLines.length; }
function since(m: number): string[] { return logLines.slice(m); }
async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (pred()) return;
        await sleep(25);
    }
    throw new Error(`timeout waiting for: ${what}\nrecent log:\n${logLines.slice(-30).join("\n")}`);
}

/** Send a raw CONNECT and resolve once the status line arrives. */
async function rawConnectStatus(port: number, target: string): Promise<{ statusLine: string; socket: net.Socket }> {
    const socket = net.connect(port, "127.0.0.1");
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    let buf = "";
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TransportTimeout(`CONNECT timeout ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
        const onData = (c: Buffer): void => {
            buf += c.toString("utf8");
            if (buf.includes("\r\n\r\n")) {
                clearTimeout(timer);
                socket.off("data", onData);
                resolve();
            }
        };
        socket.on("data", onData);
        socket.once("error", reject);
    });
    return { statusLine: buf.slice(0, buf.indexOf("\r\n")), socket };
}

interface MitmResult { body: string; sawReset: boolean; sock: tls.TLSSocket; }

/** One model request through the MITM leg. allowHalfOpen keeps the client from
 *  auto-FINning when bili's close_notify arrives, so each step decides exactly
 *  WHEN (or whether) to send its FIN. */
async function mitmRequest(tag: string, conn: string | undefined): Promise<MitmResult> {
    phase(`mitmRequest(${tag}): connect`);
    const target = `localhost:${tlsUpPort}`;
    const { statusLine, socket } = await rawConnectStatus(biliPort, target);
    phase(`mitmRequest(${tag}): CONNECT ok`);
    assert.match(statusLine, /^HTTP\/1\.1 200/, `CONNECT must be accepted: ${statusLine}`);
    const sock = tls.connect({ socket, ca: rootPem, servername: "localhost", allowHalfOpen: true } as tls.ConnectionOptions);
    await onceCap(sock, "secureConnect", HANDSHAKE_TIMEOUT_MS, true);
    phase(`mitmRequest(${tag}): TLS ok`);
    let sawReset = false;
    sock.once("error", (e: NodeJS.ErrnoException) => { if (e.code === "ECONNRESET") sawReset = true; });
    const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "ping" }] });
    const connHdr = conn ? `Connection: ${conn}\r\n` : "";
    sock.write(
        `POST /v1/chat/completions HTTP/1.1\r\n` +
        `Host: ${target}\r\n` +
        `Content-Type: application/json\r\n` +
        `x-acp-session: gc-${tag}\r\n` +
        connHdr +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    let buf = "";
    sock.on("data", (c: Buffer) => { buf += c.toString("utf8"); });
    const full = (): string | undefined => {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return undefined;
        const head = buf.slice(0, i);
        const mcl = /content-length:\s*(\d+)/i.exec(head);
        if (mcl) {
            return buf.length >= i + 4 + Number(mcl[1]) ? buf.slice(i + 4, i + 4 + Number(mcl[1])) : undefined;
        }
        return /\r\n0\r\n\r\n$/.test(buf) ? buf : undefined;
    };
    const t0 = Date.now();
    while (full() === undefined) {
        if (Date.now() - t0 > RESPONSE_BUDGET_MS) throw new TransportTimeout(`response incomplete after ${RESPONSE_BUDGET_MS}ms:\n${buf.slice(0, 500)}`);
        await sleep(10);
    }
    phase(`mitmRequest(${tag}): response complete`);
    return { body: full()!, sawReset, sock };
}

interface PlainResult { body: string; sawReset: boolean; sock: net.Socket; }

/** One model request through the PLAIN-TCP direct leg (/bili/<upstream>/... prefix).
 *  Raw socket instead of the http client: the agent would close a
 *  Connection: close socket on its own schedule, but each step must own
 *  exactly WHEN (or whether) the FIN goes out. halfOpen=true keeps the
 *  writable side open after receiving our FIN (Node's default duplex
 *  politely auto-ends it — see endWritableNT), which is what makes a
 *  genuinely silent peer possible. */
async function plainRequest(tag: string, conn: string | undefined, halfOpen?: boolean): Promise<PlainResult> {
    phase(`plainRequest(${tag}): connect`);
    const target = `127.0.0.1:${plainUpPort}`;
    const sock = net.connect({ host: "127.0.0.1", port: biliPort, allowHalfOpen: halfOpen ?? false });
    await onceCap(sock, "connect", HANDSHAKE_TIMEOUT_MS, true);
    let sawReset = false;
    sock.once("error", (e: NodeJS.ErrnoException) => { if (e.code === "ECONNRESET") sawReset = true; });
    const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "ping" }] });
    const connHdr = conn ? `Connection: ${conn}\r\n` : "";
    sock.write(
        `POST /bili/http://${target}/v1/chat/completions HTTP/1.1\r\n` +
        `Host: ${target}\r\n` +
        `Content-Type: application/json\r\n` +
        `x-acp-session: gc-${tag}\r\n` +
        connHdr +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    let buf = "";
    sock.on("data", (c: Buffer) => { buf += c.toString("utf8"); });
    const full = (): string | undefined => {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return undefined;
        const head = buf.slice(0, i);
        const mcl = /content-length:\s*(\d+)/i.exec(head);
        if (mcl) {
            return buf.length >= i + 4 + Number(mcl[1]) ? buf.slice(i + 4, i + 4 + Number(mcl[1])) : undefined;
        }
        return /\r\n0\r\n\r\n$/.test(buf) ? buf : undefined;
    };
    const t0 = Date.now();
    while (full() === undefined) {
        if (Date.now() - t0 > RESPONSE_BUDGET_MS) throw new TransportTimeout(`response incomplete after ${RESPONSE_BUDGET_MS}ms:\n${buf.slice(0, 500)}`);
        await sleep(10);
    }
    phase(`plainRequest(${tag}): response complete`);
    return { body: full()!, sawReset, sock };
}

/** One full scenario: bring up fresh mock upstreams + a fresh child bili on
 *  fresh ports, then run the five graceful-close steps. Every per-attempt
 *  resource is torn down in the finally so a #3454 retry starts from a clean
 *  slate (a wedged accept queue from attempt N cannot leak into N+1). The
 *  CA is generated ONCE by the caller and reused across attempts. */
async function runScenario(attempt: number): Promise<void> {
    stdoutBuf = "";
    logLines.length = 0;
    child = undefined; monTimer = undefined; tlsUp = undefined; plainUp = undefined;
    biliPort = 0; tlsUpPort = 0; plainUpPort = 0;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gc-state-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gc-home-"));
    const upstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "r1",
                object: "chat.completion",
                created: 1,
                model: "gpt-test",
                choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }));
        });
    };
    // https (not tls) createServer: the listener must be a request handler,
    // not a secure-connection handler.
    try {
        phase(`[${attempt}] upstreams up`);
        tlsUp = https.createServer({ key: leafKey, cert: leafCert }, upstreamHandler);
        await new Promise<void>((r) => tlsUp!.listen(0, "127.0.0.1", r));
        tlsUpPort = (tlsUp.address() as { port: number }).port;
        plainUp = http.createServer(upstreamHandler);
        await new Promise<void>((r) => plainUp!.listen(0, "127.0.0.1", r));
        plainUpPort = (plainUp.address() as { port: number }).port;

        phase(`[${attempt}] spawning child (tls=${tlsUpPort} plain=${plainUpPort})`);
        child = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
            env: {
                ...process.env,
                XDG_DATA_HOME: caDir,
                XDG_STATE_HOME: stateDir,
                HOME: homeDir,
                NODE_EXTRA_CA_CERTS: caPath,
                GC_TLS_UPSTREAM_PORT: String(tlsUpPort),
                GC_PLAIN_UPSTREAM_PORT: String(plainUpPort),
                BILI_POST_RESPONSE_LINGER_MS: "400",
                BILI_KEEP_ALIVE_TIMEOUT_MS: "300",
                BILI_MITM_HANDSHAKE_TIMEOUT_MS: "600",
                BILI_ADVISORY_CHECK: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout!.on("data", (d: Buffer) => { stdoutBuf += d.toString("utf8"); });
        child.stderr!.on("data", (d: Buffer) => {
            const text = d.toString("utf8");
            for (const l of text.split("\n")) if (l.trim()) logLines.push(l);
            process.stderr.write(text);
        });
        child.on("exit", (code, sig) => phase(`[${attempt}] child exited code=${code} sig=${sig}`));
        const readyT0 = Date.now();
        let m: RegExpExecArray | null;
        while (!(m = /^READY (\d+)$/m.exec(stdoutBuf))) {
            if (Date.now() - readyT0 > READY_TIMEOUT_MS) throw new TransportTimeout(`child did not report READY within ${READY_TIMEOUT_MS}ms\n${logLines.slice(-30).join("\n")}`);
            await sleep(50);
        }
        biliPort = Number(m[1]);
        phase(`[${attempt}] child READY on ${biliPort}`);
        // Liveness watchdog: silent while healthy, dumps state only when the child
        // stops accepting — the failure mode this suite guards against.
        monTimer = setInterval(() => {
            const c = child;
            if (!c) return;
            const probe = net.connect(biliPort, "127.0.0.1");
            const done = (res: string): void => {
                try { probe.destroy(); } catch { /* already gone */ }
                if (res !== "ok") phase(`[${attempt}][mon] exitCode=${c.exitCode} killed=${c.killed} port=${res}`);
            };
            const pt = setTimeout(() => done("timeout"), 600);
            probe.once("connect", () => { clearTimeout(pt); done("ok"); });
            probe.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(pt); done(e.code ?? "err"); });
        }, 750);
        monTimer.unref?.();

        phase(`[${attempt}] step1(happy): start`);
        {
            const m0 = mark();
            const { body, sawReset, sock } = await mitmRequest("happy", "close");
            assert.match(body, /chat\.completion/, "mock upstream response must pass through unchanged in shape");
            // The client decides to FIN now (a pooled client tearing down the connection).
            // allowHalfOpen suppresses the automatic 'close' after EOF; and on loopback
            // bili's close_notify can land BEFORE any 'end' listener is registered, so
            // prove the clean shutdown via the readableEnded state — race-free.
            sock.end();
            await waitFor(() => sock.readableEnded, 5_000, "client EOF (readableEnded)");
            await waitFor(() => since(m0).some((l) => /post-response close: lingering for peer close signal/.test(l)), 3_000, "linger arm line");
            await waitFor(() => since(m0).some((l) => /linger complete: peer close signal received/.test(l)), 3_000, "linger completion line");
            await waitFor(() => since(m0).some((l) => /\] tls closed reason=(server-end|idle-timeout)/.test(l)), 3_000, "tls leg close line");
            await waitFor(() => since(m0).some((l) => /\] tcp closed reason=paired-clean/.test(l)), 3_000, "raw leg paired-clean line");
            assert.equal(sawReset, false, "client must not observe ECONNRESET on the graceful close");
            assert.ok(!since(m0).some((l) => /\[ABORTIVE/.test(l)), `no abortive close expected in this window:\n${since(m0).filter((l) => /\[ABORTIVE/.test(l)).join("\n")}`);
            try { sock.destroy(); } catch { /* already gone */ }
        }

        phase(`[${attempt}] step2(backstop): start`);
        {
            const m0 = mark();
            const { body, sock } = await plainRequest("backstop", "close", true);
            assert.match(body, /chat\.completion/);
            // Hold the socket open without FINning (a stuck/zombie client):
            // allowHalfOpen suppresses Node's polite auto-FIN, so the budget
            // must run out. A well-behaved TLS stack cannot stay silent either
            // — RFC 8446 §6.1 makes the close_notify reply mandatory (that
            // auto-reply is what completes step 1's linger instantly), so the
            // TLS-leg backstop is unreachable by design; the mechanism itself
            // is leg-agnostic.
            await waitFor(() => since(m0).some((l) => /linger backstop: no peer close signal/.test(l)), 3_000, "linger backstop warn");
            await waitFor(() => since(m0).some((l) => /\] tcp closed reason=linger-backstop/.test(l)), 3_000, "tcp leg linger-backstop close line");
            try { sock.destroy(); } catch { /* already gone */ }
        }

        phase(`[${attempt}] step3(idle-reaper): start`);
        {
            const m0 = mark();
            const { body, sock } = await mitmRequest("idle", undefined);
            assert.match(body, /chat\.completion/);
            // Hold open past kat (300ms pin + Node's 1s keepAliveTimeoutBuffer) without FINning.
            await waitFor(() => since(m0).some((l) => /\] tls closed reason=idle-timeout/.test(l)), 4_000, "idle-timeout close line");
            assert.ok(!since(m0).some((l) => /post-response close: lingering/.test(l)), "kat reaper (bare destroy on empty idle queues) must stay immediate, not linger");
            try { sock.destroy(); } catch { /* already gone */ }
        }

        phase(`[${attempt}] step4(pre-handshake): start`);
        {
            const m0 = mark();
            const { statusLine, socket } = await rawConnectStatus(biliPort, `localhost:${tlsUpPort}`);
            assert.match(statusLine, /^HTTP\/1\.1 200/);
            // Never send a ClientHello — the slowloris pattern; the handshake timeout (600ms pin) destroys both legs.
            await waitFor(() => since(m0).some((l) => /TLS handshake timeout/.test(l)), 3_000, "handshake timeout line");
            await waitFor(() => since(m0).some((l) => /\[ABORTIVE — peer may see RST\/ECONNRESET\]/.test(l)), 3_000, "abortive warn line");
            assert.ok(!since(m0).some((l) => /post-response close: lingering/.test(l)), "pre-handshake teardown must not linger");
            try { socket.destroy(); } catch { /* already gone */ }
        }

        phase(`[${attempt}] step5(plain-tcp): start`);
        {
            const m0 = mark();
            const { body, sawReset, sock } = await plainRequest("direct", "close");
            assert.match(body, /chat\.completion/, "mock upstream response must pass through unchanged in shape");
            // Pooled-client teardown: explicit FIN now.
            sock.end();
            await waitFor(() => since(m0).some((l) => /\] tcp post-response close: lingering for peer close signal/.test(l)), 3_000, "tcp linger arm line");
            await waitFor(() => since(m0).some((l) => /\] tcp linger complete: peer close signal received/.test(l)), 3_000, "tcp linger completion line");
            await waitFor(() => since(m0).some((l) => /\] tcp closed reason=(server-end|idle-timeout)/.test(l)), 3_000, "tcp leg close line");
            assert.equal(sawReset, false, "client must not observe ECONNRESET on the graceful close");
            try { sock.destroy(); } catch { /* already gone */ }
        }
    } finally {
        phase(`[${attempt}] teardown: start`);
        if (monTimer) { clearInterval(monTimer); monTimer = undefined; }
        if (child && child.exitCode === null && !child.killed) {
            child.kill("SIGKILL");
            await onceCap(child, "exit", 5_000).catch(() => {});
        }
        await Promise.all([closeServer(tlsUp), closeServer(plainUp)]);
        for (const d of [stateDir, homeDir]) {
            if (d) { try { rmrf(d); } catch { /* best-effort */ } }
        }
    }
}

let scenarioAttempts = 0; // #3454: at most two scenarios run (one-shot backstop)
function attemptOf(): number { return ++scenarioAttempts; }
function attemptsUsed(): number { return scenarioAttempts; }

await test("#1982 graceful client-side close (MITM + plain-TCP legs)", async () => {
    phase("setup: ca");
    caDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gc-ca-"));
    // Generate the test CA under an isolated XDG_DATA_HOME BEFORE spawning the
    // child, so the child's bili reuses it and NODE_EXTRA_CA_CERTS can point at it.
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = caDir;
    try {
        _resetForTest();
        ensureRootCA();
        caPath = rootCaPath();
        rootPem = fs.readFileSync(rootCaPath(), "utf8");
        const leaf = mintHostCert("localhost");
        leafCert = leaf.certPem;
        leafKey = leaf.keyPem;
    } finally {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdg;
        _resetForTest();
    }
    phase(`setup: ca ready (${caPath})`);

    // #3454 one-shot recovery: a windows-latest shard can wedge a leg's
    // transport under load; a TransportTimeout re-runs the ENTIRE scenario on
    // a fresh child + fresh ports. Anything else (an assertion, a missing
    // lifecycle line) propagates immediately — never retried away. The loop
    // always exits by return (success) or throw, never falls off the end.
    for (;;) {
        try {
            await runScenario(attemptOf());
            return;
        } catch (err) {
            if (err instanceof TransportTimeout && attemptsUsed() < 2) {
                phase(`leg transport timeout (attempt ${attemptsUsed()}) — re-running on fresh ports`);
                continue;
            }
            throw err;
        }
    }
});
