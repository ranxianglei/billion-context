// #3343: the marker divert must not be reachable from outside the loopback,
// and the lane's synthetic re-entry must carry the REAL caller's socket —
// never a forged 127.0.0.1. Non-loopback peers are simulated deterministically
// by connecting through a unix socket: remoteAddress comes back undefined,
// which isLoopbackAddress classifies as non-loopback (no network topology luck).
// On Windows runners the harness-based tests in this file self-skip: repeated
// unified-storage harness instances deterministically kill the node process
// there (silent exit 1, no error output), so win32 runs only the
// platform-independent unit tests below; the gate logic they cover is identical.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests, handleIncrementalTurn } from "../src/incremental-lane.ts";
import { adminGateDenial } from "../src/server/admin.ts";
import { BILI_TUNNEL_HEADER } from "../src/tunnel-guard.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-3343-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const userTurn = (n: number, text = "hello") => ({ id: `u${n}`, role: "user", contentType: "text", content: text.repeat(400) });

interface Harness {
    proxy: http.Server;
    proxyUrl: string;
    dir: string;
    forwarded: Record<string, unknown>[];
    /** Close the TCP listener and re-listen the SAME server on a unix
     *  socket — subsequent connections present remoteAddress undefined
     *  (= non-loopback to every gate) without depending on machine topology.
     *  Rejects on platforms where that re-listen is unsupported (win32). */
    toUnixSocket: () => Promise<string>;
    close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const toUnixSocket = async (): Promise<string> => {
        proxy.closeAllConnections?.();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        const sockPath = join(dir, "proxy.sock");
        await new Promise<void>((resolve, reject) => {
            proxy.once("error", reject);
            proxy.listen(sockPath, () => resolve());
        });
        return sockPath;
    };
    return { proxy, proxyUrl, dir, forwarded, toUnixSocket, close: async () => {
        proxy.closeAllConnections?.();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        store.closeQuietly();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    } };
}

/** Raw request over a unix socket (fetch/undici cannot dial socketPaths);
 *  the Host header is set explicitly because it is part of the gate input. */
function udsRequest(sockPath: string, method: "GET" | "POST", path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: sockPath, host: "127.0.0.1", method, path, headers: { host: "127.0.0.1", ...headers } }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

/** Skip on win32, where this file's repeated unified-storage harness
 *  instances deterministically kill the node process (silent exit 1, no
 *  error output; two CI runs). Returns true when the caller must return. */
function win32HarnessSkip(t: { skip: (msg?: string) => void }): boolean {
    if (process.platform === "win32") {
        t.skip("win32: repeated unified-storage harness instances crash the node process on Windows CI (silent exit 1) — tracked separately; gate logic covered by the unit matrix here");
        return true;
    }
    return false;
}

/** Swap onto the unix-socket transport; on platforms where the re-listen is
 *  unsupported mark the test skipped instead of failing the file. */
async function nonLoopbackTransport(h: Harness, t: { skip: (msg?: string) => void }): Promise<string | undefined> {
    try {
        return await h.toUnixSocket();
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        t.skip(`non-loopback transport unavailable on this platform (${e.code ?? e.message}) — gate logic covered by the adminGateDenial matrix`);
        return undefined;
    }
}

const MARKER_HEADERS = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-turn": "1" };

test("#3343 unit: adminGateDenial — the checks the divert now shares", () => {
    const mkReq = (remoteAddress: string | undefined, headers: Record<string, unknown> = {}): http.IncomingMessage =>
        Object.assign(new Readable({ read: (): void => {} }), { method: "GET", url: "/__bili/sessions", headers, socket: { remoteAddress } }) as unknown as http.IncomingMessage;
    const deny = (req: http.IncomingMessage) => adminGateDenial(req, "127.0.0.1");
    assert.equal(deny(mkReq("127.0.0.1", { host: "127.0.0.1" })), undefined, "loopback + trusted Host, no Origin (curl class) passes");
    assert.equal(deny(mkReq("::1", { host: "localhost" })), undefined, "::1 + localhost passes");
    assert.match(deny(mkReq("192.168.1.50", { host: "127.0.0.1" })) ?? "", /loopback-only/, "a FORGED Host does not help a remote peer — the socket check precedes origin");
    assert.equal(deny(mkReq(undefined, { host: "127.0.0.1" })) !== undefined, true, "unix-socket peer (remoteAddress undefined) is non-loopback");
    assert.match(deny(mkReq("127.0.0.1", { host: "evil.example" })) ?? "", /origin/, "loopback peer with an untrusted Host is denied");
    assert.match(deny(mkReq("127.0.0.1", { host: "127.0.0.1", [BILI_TUNNEL_HEADER]: "1" })) ?? "", /tunnel/, "anti-tunnel holds even on loopback");
});

test("#3343: loopback marker'd shaped turn still works (fix must not break the lane)", async (t) => {
    if (win32HarnessSkip(t)) return;
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    let h: Harness | undefined;
    try {
        h = await harness();
        const res = await fetch(`${h.proxyUrl}/v1/messages`, {
            method: "POST",
            headers: { ...MARKER_HEADERS, "x-bili-plugin-conversation": "conv-3343-local", "x-acp-session": "conv-3343-local" },
            body: JSON.stringify({ conversationId: "conv-3343-local", sinceSeq: 0, request: { model: "claude-test", max_tokens: 512 }, messages: [userTurn(1)] }),
        });
        assert.equal(res.status, 200);
        assert.ok(res.headers.get("x-bili-applied-seq"), "loopback diversion carries the ack");
        const upstream = h.forwarded.at(-1) as { model?: string; messages?: unknown[] };
        assert.equal(upstream.model, "claude-test", "assembled request reached the upstream");
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        await h?.close();
    }
});

test("#3343: non-loopback marker'd shaped turn → 403, no lane state written", async (t) => {
    if (win32HarnessSkip(t)) return;
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    let h: Harness | undefined;
    try {
        h = await harness();
        const sockPath = await nonLoopbackTransport(h, t);
        if (sockPath === undefined) return;
        // The exact exploit shape from the issue: empty delta + sticky-system
        // update aimed at a foreign conversation. Pre-fix this seeded the
        // victim session with the injected system prompt.
        const victim = "conv-3343-victim";
        const res = await udsRequest(sockPath, "POST", "/v1/messages", { ...MARKER_HEADERS, "x-bili-plugin-conversation": victim, "x-acp-session": victim },
            JSON.stringify({ conversationId: victim, sinceSeq: 0, system: "INJECTED-SYSTEM", request: { model: "claude-test", max_tokens: 512 }, messages: [] }));
        assert.equal(res.status, 403, `denied before the lane (${res.body.slice(0, 120)})`);
        assert.match(res.body, /loopback-only/);
        assert.equal(h.forwarded.length, 0, "nothing reached the upstream");
        assert.equal(peekSession(victim), undefined, "no session state was created for the foreign conversation");
        // The capability probe stays loopback-gated too — a remote host sees
        // 403 and correctly concludes "no incremental support", staying full-resend.
        const probe = await udsRequest(sockPath, "GET", "/__bili/plugin/turn", { "x-bili-plugin": "dsh" });
        assert.equal(probe.status, 403);
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        await h?.close();
    }
});

test("#3343: non-loopback marker'd shaped turn on /__acp/* → 403 admin gate, never diverted", async (t) => {
    if (win32HarnessSkip(t)) return;
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    let h: Harness | undefined;
    try {
        h = await harness();
        const sockPath = await nonLoopbackTransport(h, t);
        if (sockPath === undefined) return;
        // Pre-fix this rode the divert into the pipeline with a forged
        // 127.0.0.1 socket, passed the admin gate, and answered 404 after
        // writing lane state under the caller-chosen conversation id.
        const conv = "conv-3343-acp";
        const res = await udsRequest(sockPath, "POST", "/__acp/status", { ...MARKER_HEADERS, "x-bili-plugin-conversation": conv, "x-acp-session": conv },
            JSON.stringify({ conversationId: conv, sinceSeq: 0, request: { model: "claude-test", max_tokens: 512 }, messages: [userTurn(1)] }));
        assert.equal(res.status, 403, `management prefix rejected by the real gate (${res.body.slice(0, 120)})`);
        assert.match(res.body, /loopback-only/);
        assert.equal(h.forwarded.length, 0);
        assert.equal(peekSession(conv), undefined, "no lane state under the caller-chosen id");
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        await h?.close();
    }
});

test("#3343: marker'd FULL-RESEND body still rides the normal pipeline regardless of source (availability)", async (t) => {
    if (win32HarnessSkip(t)) return;
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    let h: Harness | undefined;
    try {
        h = await harness();
        // A host whose probe 403s stays full-resend but keeps stamping the
        // marker — those turns must keep working byte-for-byte semantics. The
        // shape→replay decision is source-independent (it precedes the gate),
        // so a loopback fetch exercises the identical branch on every platform.
        const res = await fetch(`${h.proxyUrl}/v1/messages`, {
            method: "POST",
            headers: { ...MARKER_HEADERS, "x-acp-session": "conv-3343-plain" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 512, messages: [{ role: "user", content: "plain turn" }] }),
        });
        assert.equal(res.status, 200, (await res.text()).slice(0, 120));
        const upstream = h.forwarded.at(-1) as { model?: string; conversationId?: string };
        assert.equal(upstream.model, "claude-test");
        assert.equal("conversationId" in upstream, false, "not diverted — ordinary model traffic");
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        await h?.close();
    }
});

test("#3343 unit: the synthetic forward carries the REAL socket, never a forged loopback", async () => {
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    // Self-contained state: a bare store (no HTTP server), so this unit test
    // stays runnable on platforms where the full harness must be skipped. The
    // unified-storage env var is set here too — the lane-enablement gate
    // (replicasAvailable) needs it, and on win32 no earlier harness sets it.
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = mkdtempSync(join(testRoot, "unit-"));
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _resetSessionsForTest();
    _resetPluginStateForTest();
    __resetIncrementalLaneForTests();
    _setStoreForTest(store);
    try {
        const remoteSocket = { remoteAddress: "192.168.1.50", localPort: 43210 } as const;
        const req = Readable.from([]) as unknown as http.IncomingMessage;
        Object.assign(req, {
            method: "POST",
            url: "/v1/messages",
            headers: { host: "127.0.0.1", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-3343-sock" },
            socket: remoteSocket,
        });
        const fakeRes = {
            writeHead: (): void => {},
            setHeader: (): void => {},
            end: (): void => {},
            on: (): unknown => fakeRes,
        } as unknown as http.ServerResponse;
        let captured: http.IncomingMessage | undefined;
        await handleIncrementalTurn(req, fakeRes, (): void => {}, (synthetic) => {
            captured = synthetic;
            return Promise.resolve();
        }, "/v1/messages", Buffer.from(JSON.stringify({ conversationId: "conv-3343-sock", sinceSeq: 0, resync: true, request: { model: "claude-test", max_tokens: 512 }, messages: [userTurn(1)] })));
        assert.ok(captured, "the turn reached the forward step");
        assert.equal(captured?.socket, remoteSocket, "identity: the caller's actual socket object, not a stand-in");
        assert.notEqual((captured?.socket as { remoteAddress?: string } | undefined)?.remoteAddress, "127.0.0.1", "no forged loopback identity downstream");
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        delete process.env.BILI_STORAGE_UNIFIED;
        store.closeQuietly();
    }
});
