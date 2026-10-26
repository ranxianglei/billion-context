// #4753: large requests retained input-only data across long responses. Three
// retention sites, three fixes pinned here:
//   A. readBody listeners/chunks      -> tests/proxy-readbody.test.ts
//   B. raw-wire bookkeeping scalars   -> parity corpus + scalar-gate unit +
//                                         e2e pipeline parity (below)
//   C. release-on-retries-settled     -> settlement-ordering probes + the
//                                         existing refold suites (premature
//                                         release would break them)
// The parity corpus compares the NEW precomputed bookkeeping against a verbatim
// copy of the OLD algorithm (re-parse + walk inside rememberPluginMessages) so
// any drift in hash or comparability verdict fails loudly.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, listSessions } from "../src/session.ts";
import { computeRawWireBookkeeping, rememberPluginMessages } from "../src/plugin.ts";
import { forward } from "../src/server/relay.ts";
import { _resetFetchUtilForTest } from "../src/fetch-util.ts";

_setStoreForTest(new SessionStore({ enabled: false }));
setRegistryForTest({});

test.afterEach(() => {
    _resetFetchUtilForTest();
});

// ---------------------------------------------------------------------------
// B1: parity corpus — new precomputed bookkeeping vs the old inline algorithm.
// ---------------------------------------------------------------------------

// Verbatim copy of the OLD comparableHistory walker (was private in
// src/plugin.ts; kept here so the oracle cannot silently drift with the fix).
function oracleComparableHistory(value: unknown): boolean {
    if (value === null || typeof value === "string") return true;
    if (Array.isArray(value)) return value.every(oracleComparableHistory);
    if (!value || typeof value !== "object") return false;
    const part = value as Record<string, unknown>;
    if (part.type !== undefined && !["message", "text", "input_text", "output_text", "tool_use", "tool_result", "function_call", "function_call_output"].includes(String(part.type))) return false;
    if (part.type === "tool_use" || part.type === "function_call") return true;
    if (part.audio !== undefined && part.audio !== null) return false;
    if (part.content !== undefined) return oracleComparableHistory(part.content);
    if (part.output !== undefined) return oracleComparableHistory(part.output);
    if (part.parts !== undefined) return oracleComparableHistory(part.parts);
    return typeof part.text === "string" || Array.isArray(part.tool_calls);
}

// The OLD algorithm as it ran inside rememberPluginMessages before #4753:
// hash the raw buffer, then RE-PARSE it and walk the message field.
function oldAlgorithm(rawWire: Buffer): { wireHash: string; textComparable: boolean } {
    const wireHash = createHash("sha256").update(rawWire).digest("hex");
    let comparable = false;
    try {
        const wire = JSON.parse(rawWire.toString("utf8")) as Record<string, unknown>;
        comparable = oracleComparableHistory(wire.messages ?? wire.input ?? wire.contents);
    } catch {
        comparable = false;
    }
    return { wireHash, textComparable: comparable };
}

// How handle.ts now seeds the helper: the ORIGINAL parse result, or null.
function parseLikeHandle(buf: Buffer): unknown {
    try {
        return JSON.parse(buf.toString("utf8"));
    } catch {
        return null;
    }
}

const PARITY_FIXTURES: Array<{ name: string; body: string; expected: boolean }> = [
    { name: "anthropic plain text", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] }), expected: true },
    { name: "anthropic image part", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] }), expected: false },
    { name: "assistant audio field", body: JSON.stringify({ model: "m", messages: [{ role: "assistant", content: "t", audio: { id: "a1" } }] }), expected: false },
    { name: "responses function_call", body: JSON.stringify({ model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }, { type: "function_call", name: "f", arguments: "{}" }] }), expected: true },
    { name: "google contents parts", body: JSON.stringify({ model: "m", contents: [{ role: "user", parts: [{ text: "hi" }] }] }), expected: true },
    { name: "tool_use / tool_result pair", body: JSON.stringify({ model: "m", messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] }), expected: true },
    { name: "non-JSON garbage", body: "not json{", expected: false },
    { name: "top-level null literal", body: "null", expected: false },
    { name: "top-level array", body: "[1,2]", expected: false },
    { name: "empty messages array", body: JSON.stringify({ messages: [] }), expected: true },
    { name: "unicode text", body: JSON.stringify({ messages: [{ role: "user", content: "中文テキスト🎉" }] }), expected: true },
    { name: "thinking block", body: JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], thinking_tokens: 3 }] }), expected: false },
];

for (const fx of PARITY_FIXTURES) {
    test(`bookkeeping parity: ${fx.name}`, () => {
        const buf = Buffer.from(fx.body, "utf8");
        const fresh = computeRawWireBookkeeping(buf, parseLikeHandle(buf));
        const old = oldAlgorithm(buf);
        assert.deepEqual(fresh, old, `new ${JSON.stringify(fresh)} vs old ${JSON.stringify(old)}`);
        assert.equal(fresh.textComparable, fx.expected, `expected verdict ${fx.expected}`);
    });
}

test("bookkeeping parity: empty body behaves like the old parse failure", () => {
    const buf = Buffer.alloc(0);
    const fresh = computeRawWireBookkeeping(buf, null);
    assert.equal(fresh.textComparable, false);
    assert.equal(fresh.wireHash, createHash("sha256").update(buf).digest("hex"));
});

// ---------------------------------------------------------------------------
// B2: scalar-gate unit — rememberPluginMessages consumes the scalars with the
// exact hash-gate semantics the Buffer version had.
// ---------------------------------------------------------------------------

const TEXT_MSG: CoreMessage[] = [{ id: "u1", role: "user", contentType: "text", text: "hello" }];

test("rememberPluginMessages: stores precomputed scalars when pluginAgent is bound", () => {
    const s = getSession("4753-scalar-a");
    s.metadata.pluginAgent = "test";
    rememberPluginMessages(s.id, TEXT_MSG, TEXT_MSG, undefined, { wireHash: "h1", textComparable: false });
    assert.equal(s.metadata.publicSnapshotWireHash, "h1");
    assert.equal(s.metadata.publicSnapshotTextComparable, false);
});

test("rememberPluginMessages: identical hash is a no-op (gate unchanged)", () => {
    const s = getSession("4753-scalar-b");
    s.metadata.pluginAgent = "test";
    rememberPluginMessages(s.id, TEXT_MSG, TEXT_MSG, undefined, { wireHash: "h1", textComparable: false });
    rememberPluginMessages(s.id, TEXT_MSG, TEXT_MSG, undefined, { wireHash: "h1", textComparable: true });
    assert.equal(s.metadata.publicSnapshotWireHash, "h1");
    assert.equal(s.metadata.publicSnapshotTextComparable, false, "verdict must NOT be re-walked while the hash is unchanged");
});

test("rememberPluginMessages: changed hash updates the verdict", () => {
    const s = getSession("4753-scalar-c");
    s.metadata.pluginAgent = "test";
    rememberPluginMessages(s.id, TEXT_MSG, TEXT_MSG, undefined, { wireHash: "h1", textComparable: false });
    rememberPluginMessages(s.id, TEXT_MSG, TEXT_MSG, undefined, { wireHash: "h2", textComparable: true });
    assert.equal(s.metadata.publicSnapshotWireHash, "h2");
    assert.equal(s.metadata.publicSnapshotTextComparable, true);
});

test("rememberPluginMessages: rawWire scalars ignored without a pluginAgent binding", () => {
    const s = getSession("4753-scalar-d");
    rememberPluginMessages(s.id, TEXT_MSG, TEXT_MSG, undefined, { wireHash: "hX", textComparable: false });
    assert.equal(s.metadata.publicSnapshotWireHash, undefined);
    assert.equal(s.metadata.publicSnapshotTextComparable, undefined);
});

// ---------------------------------------------------------------------------
// B3: e2e pipeline parity — the REAL handleRequest computes the same scalars
// the old post-forward Buffer walk produced (multimodal negative + text
// positive directions).
// ---------------------------------------------------------------------------

function proxyBaseOptions(upstreamPort: number, window: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: window } } } },
        modelContextLimit: window,
        kernelConfig: defaultConfig(window),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

interface JsonUpstream {
    server: http.Server;
    port: number;
}

async function jsonUpstream(): Promise<JsonUpstream> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" } ], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, port: (server.address() as { port: number }).port };
}

async function withProxy(t: test.TestContext, run: (proxyPort: number, upstream: JsonUpstream) => Promise<void>): Promise<void> {
    const upstream = await jsonUpstream();
    const proxy = await startServer(proxyBaseOptions(upstream.port, 200_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    t.after(async () => {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.server.close();
        upstream.server.closeIdleConnections?.();
        await once(upstream.server, "close");
    });
    await run(proxyPort, upstream);
}

test("e2e bookkeeping: multimodal plugin request marks textComparable=false with the EXACT inbound hash", async (t) => {
    await withProxy(t, async (proxyPort, upstream) => {
        const body = JSON.stringify({
            model: "claude-test",
            max_tokens: 1024,
            stream: false,
            messages: [
                { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
            ],
        });
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/chat/completions`;
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "4753-parity-mm" }, body });
        assert.equal(r.status, 200);
        await r.text();
        const s = listSessions().find((x) => x.id === "4753-parity-mm");
        assert.ok(s, "session exists");
        assert.equal(s!.metadata.publicSnapshotTextComparable, false, "image part must make history incomparable by text");
        assert.equal(s!.metadata.publicSnapshotWireHash, createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"), "hash must cover the EXACT inbound bytes");
    });
});

test("e2e bookkeeping: plain-text plugin request marks textComparable=true", async (t) => {
    await withProxy(t, async (proxyPort, upstream) => {
        const body = JSON.stringify({
            model: "claude-test",
            max_tokens: 1024,
            stream: false,
            messages: [{ role: "user", content: "plain text only" }],
        });
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/chat/completions`;
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "4753-parity-txt" }, body });
        assert.equal(r.status, 200);
        await r.text();
        const s = listSessions().find((x) => x.id === "4753-parity-txt");
        assert.ok(s, "session exists");
        assert.equal(s!.metadata.publicSnapshotTextComparable, true);
        assert.equal(s!.metadata.publicSnapshotWireHash, createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"));
    });
});

// ---------------------------------------------------------------------------
// C: settlement-ordering probes — onRetriesSettled fires exactly once, BEFORE
// the first response byte (200 streaming) / before the error response is
// written (400 passthrough), and NEVER on fast paths that answer before any
// attempt started.
// ---------------------------------------------------------------------------

function relayFixture(url: string) {
    const core = createCore();
    const config = defaultConfig(200_000);
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = url;
    req.headers = { "content-type": "application/json" };
    const res = new http.ServerResponse(req);
    const opts: ProxyOptions = {
        host: "127.0.0.1", port: 0, upstream: url, routes: {},
        proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: 200_000, kernelConfig: config,
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, compat: { roles: {} },
        streamErrorShape: "protocol", sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
    };
    return { core, config, req, res, opts };
}

function trackOrder(res: http.ServerResponse, order: string[]): void {
    const origWrite = (res.write as unknown as (...a: unknown[]) => boolean).bind(res);
    const origEnd = (res.end as unknown as (...a: unknown[]) => void).bind(res);
    (res as unknown as Record<string, unknown>).write = (...args: unknown[]) => { order.push("byte"); return origWrite(...args); };
    (res as unknown as Record<string, unknown>).end = (...args: unknown[]) => { order.push("end"); return origEnd(...args); };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("settlement hook: fires once and before the first streamed byte (200)", async (t) => {
    let calls = 0;
    const server = http.createServer((qreq, qres) => {
        qreq.resume();
        calls += 1;
        qres.writeHead(200, { "content-type": "text/event-stream" });
        void (async () => {
            qres.write("data: one\n\n");
            await delay(30);
            qres.write("data: two\n\n");
            qres.end();
        })();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.close();
        server.closeIdleConnections?.();
        await once(server, "close");
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
    const f = relayFixture(url);
    const order: string[] = [];
    let settled = 0;
    trackOrder(f.res, order);
    await forward(f.req, f.res, f.opts, Buffer.from("{}"), null, f.core, f.config, () => {}, undefined, "probe-200", undefined, undefined, undefined, () => { settled += 1; order.push("settled"); });
    assert.equal(calls, 1);
    assert.equal(settled, 1, "hook fires exactly once");
    assert.equal(order[0], "settled", `settlement precedes the first byte: ${JSON.stringify(order)}`);
    assert.ok(order.includes("byte"), "response bytes were delivered");
    assert.equal(order[order.length - 1], "end");
});

test("settlement hook: fires once before a passthrough 400 is written", async (t) => {
    const server = http.createServer((qreq, qres) => {
        qreq.resume();
        qres.writeHead(400, { "content-type": "application/json" });
        qres.end(JSON.stringify({ error: { message: "nope" } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.close();
        server.closeIdleConnections?.();
        await once(server, "close");
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
    const f = relayFixture(url);
    const order: string[] = [];
    let settled = 0;
    trackOrder(f.res, order);
    await forward(f.req, f.res, f.opts, Buffer.from("{}"), null, f.core, f.config, () => {}, undefined, "probe-400", undefined, undefined, undefined, () => { settled += 1; order.push("settled"); });
    assert.equal(settled, 1, "hook fires exactly once on the error path too");
    assert.equal(order[0], "settled", `settlement precedes the error write: ${JSON.stringify(order)}`);
});

test("settlement hook: never fires when the response is already closed (fast path)", async (t) => {
    let calls = 0;
    const server = http.createServer((qreq, qres) => { qreq.resume(); calls += 1; qres.end("unused"); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.close();
        server.closeIdleConnections?.();
        await once(server, "close");
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
    const f = relayFixture(url);
    f.res.destroy();
    f.res.emit("close");
    let settled = 0;
    await forward(f.req, f.res, f.opts, Buffer.from("{}"), null, f.core, f.config, () => {}, undefined, "probe-fast", undefined, undefined, undefined, () => { settled += 1; });
    assert.equal(settled, 0, "no attempt started, nothing to settle");
    assert.equal(calls, 0, "the main fetch must not start against a closed response");
});

// ---------------------------------------------------------------------------
// C2: same-session concurrency smoke — concurrent requests on one session each
// own their input cells; the shared released-body sentinel must not leak across
// them.
// ---------------------------------------------------------------------------

test("concurrency: two same-session requests both complete after input release", async (t) => {
    await withProxy(t, async (proxyPort, upstream) => {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/chat/completions`;
        // max_tokens must exceed 200 or the request takes the side-request
        // passthrough lane, which never runs the main pipeline.
        const mk = (n: number) => JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: [{ role: "user", content: `parallel turn ${n}` }] });
        const results = await Promise.all([1, 2].map((n) =>
            fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "4753-conc" }, body: mk(n) })
                .then(async (r) => ({ status: r.status, text: await r.text() })),
        ));
        for (const r of results) {
            assert.equal(r.status, 200, r.text);
        }
        const s = listSessions().find((x) => x.id === "4753-conc");
        assert.ok(s, "session exists");
        assert.equal(s!.metadata.publicSnapshotTextComparable, true);
    });
});
