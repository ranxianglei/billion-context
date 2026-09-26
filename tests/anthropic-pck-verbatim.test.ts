import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer, _resetChainWarningsForTest } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { peekSession, _resetSessionsForTest } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #1403 wire invariant: the omp plugin stamps prompt_cache_key into the body
// as its session id (#268); that field is NOT part of the Anthropic Messages
// API, so EVERY anthropic forward path must ship it stripped — side requests
// (#388), chain advisories (#1086/#1357: advisory processing since #1357, the
// rebuild never forwards stamped fields), passthrough marks (#1117/#920), the
// non-conversation relay (#1284), global/route passthrough (#661). The fake
// upstream below enforces zen's strict schema: top-level prompt_cache_key ⇒
// the exact production 400.

const ZEN_400_BODY = JSON.stringify({
    type: "error",
    error: {
        type: "invalid_request_error",
        message: "Upstream request failed: [invalid_request_error] prompt_cache_key: Extra inputs are not permitted",
    },
});
const OK_RESPONSE = JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
});

type Captured = { url: string; body: string };
type LogRec = { level: string; msg: string };

function makeStrictUpstream(captured: Captured[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push({ url: req.url ?? "", body });
            let parsed: unknown = null;
            try {
                parsed = JSON.parse(body);
            } catch {
                parsed = null;
            }
            const leaks =
                typeof parsed === "object" &&
                parsed !== null &&
                !Array.isArray(parsed) &&
                Object.prototype.hasOwnProperty.call(parsed, "prompt_cache_key");
            if (leaks) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(ZEN_400_BODY);
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(OK_RESPONSE);
            }
        });
    });
}

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function makeOpts(upstream: string, extra: Partial<ProxyOptions> = {}): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream,
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        ...extra,
    };
}

function anthropicBody(pck: string | undefined, maxTokens: number, content: string): string {
    const o: Record<string, unknown> = {};
    if (pck !== undefined) o.prompt_cache_key = pck;
    o.model = "claude-test";
    o.max_tokens = maxTokens;
    o.messages = [{ role: "user", content: [{ type: "text", text: content }] }];
    return JSON.stringify(o);
}

async function post(port: number, targetPath: string, bodyStr: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return await new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                method: "POST",
                path: targetPath,
                headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(bodyStr)), ...headers },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            },
        );
        req.on("error", reject);
        req.write(bodyStr);
        req.end();
    });
}

async function withProxy(upstream: http.Server, opts: ProxyOptions, fn: (proxyPort: number, upstreamPort: number) => Promise<void>): Promise<void> {
    const proxy = await startServer(opts);
    await listen(proxy);
    try {
        await fn((proxy.address() as { port: number }).port, (upstream.address() as { port: number }).port);
    } finally {
        proxy.closeAllConnections?.();
        await close(proxy);
    }
}

function freshState(): void {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
}

test("#1403 T1: side request (max_tokens<=200) verbatim forward strips stamped prompt_cache_key", async () => {
    freshState();
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeStrictUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    try {
        await withProxy(upstream, makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`, { log: true }), async (pport, uport) => {
            const sid = randomUUID();
            const out = await post(pport, `/bili/http://127.0.0.1:${uport}/v1/messages`, anthropicBody(sid, 100, "tiny"), { "x-acp-session": sid });
            assert.equal(out.status, 200, `strict upstream must never see prompt_cache_key; got ${out.status}: ${out.body.slice(0, 200)}`);
            assert.equal(captured.length, 1);
            assert.ok(!captured[0]!.body.includes("prompt_cache_key"), "side-request forward must strip the stamped field");
            const sent = JSON.parse(captured[0]!.body) as Record<string, unknown>;
            assert.equal(sent.model, "claude-test");
            assert.equal(sent.max_tokens, 100);
            assert.ok(logs.some((l) => l.msg.includes("side request (max_tokens<=200)")), "must have taken the side-request passthrough path");
        });
    } finally {
        setLogCapture(null);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1403/#1357 T2: advisory processing of foreign ACP artifacts strips stamped prompt_cache_key", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-pck-chain-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeStrictUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const tag = "\x3cacp tokens=\"1.2K\" type=\"text\"\x3em00042\x3c/acp\x3e";
    try {
        await withProxy(upstream, makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`, { log: true }), async (pport, uport) => {
            const sid = randomUUID();
            const out = await post(pport, `/bili/http://127.0.0.1:${uport}/v1/messages`, anthropicBody(sid, 1024, `keep ${tag}`), { "x-acp-session": sid });
            assert.equal(out.status, 200, `strict upstream must never see prompt_cache_key; got ${out.status}: ${out.body.slice(0, 200)}`);
            assert.equal(captured.length, 1);
            assert.ok(!captured[0]!.body.includes("prompt_cache_key"), "advisory processing must still strip the stamped field");
            // #1357: historical ACP content is advisory — the request is PROCESSED
            // (kernel re-render adds its own tag header), not verbatim-forwarded.
            // Compare the PARSED message text: the user's literal tag must survive
            // byte-intact inside the rebuilt body.
            const sentText = (JSON.parse(captured[0]!.body) as { messages: { content: { type: string; text: string }[] }[] }).messages[0]!.content[0]!.text;
            assert.notEqual(sentText, `keep ${tag}`, "#1357: foreign ACP literal is advisory — processed, not verbatim chain forward");
            assert.ok(sentText.includes(`keep ${tag}`), "user text and literal tag survive processing intact");
            const warns = logs.filter((l) => l.level === "warn" && l.msg.includes("[chain]") && l.msg.includes(sid));
            assert.equal(warns.length, 1, "expected exactly one [chain] advisory warn for the foreign session");
            assert.ok(warns[0]!.msg.includes("#1357"), "warn cites the #1357 advisory downgrade");
            assert.notEqual(peekSession(sid), undefined, "advisory processing establishes local session state (#1357)");
        });
    } finally {
        setLogCapture(null);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1403 T3: global passthrough (--passthrough) final-fallback forward strips stamped prompt_cache_key", async () => {
    freshState();
    const captured: Captured[] = [];
    const upstream = makeStrictUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    try {
        await withProxy(upstream, makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`, { passthrough: true }), async (pport, uport) => {
            const sid = randomUUID();
            const out = await post(pport, `/bili/http://127.0.0.1:${uport}/v1/messages`, anthropicBody(sid, 1024, "hi"), { "x-acp-session": sid });
            assert.equal(out.status, 200, `strict upstream must never see prompt_cache_key; got ${out.status}: ${out.body.slice(0, 200)}`);
            assert.ok(!captured[0]!.body.includes("prompt_cache_key"), "global-passthrough forward must strip the stamped field");
        });
    } finally {
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1403 T4: passthrough-mark and plugin-bypass header forwards strip stamped prompt_cache_key", async () => {
    const headers: Record<string, string>[] = [{ "x-bili-passthrough": "1" }, { "x-bili-plugin-bypass": "1" }];
    for (const extra of headers) {
        freshState();
        const captured: Captured[] = [];
        const upstream = makeStrictUpstream(captured);
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        try {
            await withProxy(upstream, makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`), async (pport, uport) => {
                const sid = randomUUID();
                const out = await post(pport, `/bili/http://127.0.0.1:${uport}/v1/messages`, anthropicBody(sid, 1024, "hi"), { "x-acp-session": sid, ...extra });
                assert.equal(out.status, 200, `${Object.keys(extra)[0]}: strict upstream must never see prompt_cache_key; got ${out.status}: ${out.body.slice(0, 200)}`);
                assert.ok(!captured[0]!.body.includes("prompt_cache_key"), `${Object.keys(extra)[0]}: forward must strip the stamped field`);
            });
        } finally {
            upstream.closeAllConnections?.();
            await close(upstream);
        }
    }
});

test("#1403 T5: non-conversation relay (#1284) strips stamped prompt_cache_key", async () => {
    freshState();
    const captured: Captured[] = [];
    const upstream = makeStrictUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    try {
        await withProxy(upstream, makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`), async (pport, uport) => {
            const sid = randomUUID();
            const relayBody = JSON.stringify({ model: "claude-test", max_tokens: 1024, prompt_cache_key: sid });
            const out = await post(pport, `/bili/http://127.0.0.1:${uport}/v1/messages`, relayBody, { "x-acp-session": sid });
            assert.equal(out.status, 200, `strict upstream must never see prompt_cache_key; got ${out.status}: ${out.body.slice(0, 200)}`);
            assert.ok(!captured[0]!.body.includes("prompt_cache_key"), "relay forward must strip the stamped field");
        });
    } finally {
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});
