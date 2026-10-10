import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createCore, defaultConfig } from "acp-kernel";
import { resolveUpstream, startServer } from "../src/server.ts";
import { forward } from "../src/server/relay.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { DecodedRequestAdmission, MAX_REQUEST_BYTES } from "../src/request-body-budget.ts";

const isolation = mkdtempSync(join(tmpdir(), "bili-request-budget-"));
process.env.XDG_STATE_HOME = join(isolation, "state");
process.env.XDG_DATA_HOME = join(isolation, "data");
process.env.XDG_CACHE_HOME = join(isolation, "cache");
process.env.XDG_CONFIG_HOME = join(isolation, "config");
test.after(() => rmSync(isolation, { recursive: true, force: true }));

async function fixture(run: (base: string, opts: ProxyOptions, calls: Buffer[]) => Promise<void>): Promise<void> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const calls: Buffer[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            calls.push(Buffer.concat(chunks));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };

    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}`;
    try { await run(base, opts, calls); }
    finally {
        proxy.closeAllConnections(); upstream.closeAllConnections();
        await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    }
}

const recentImage = { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "high" };
const recent = { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }, recentImage] };

function largeBody(tool: boolean, extraBytes = 1024): Buffer {
    const image = { ...recentImage, image_url: "data:image/png;base64," + "QUJD".repeat((MAX_REQUEST_BYTES + extraBytes) / 4) };
    const old = tool
        ? [{ type: "custom_tool_call", call_id: "call_img", name: "screenshot", input: "{}" }, { type: "custom_tool_call_output", call_id: "call_img", output: [{ type: "input_text", text: "old screenshot" }, image] }]
        : [{ type: "message", role: "user", content: [{ type: "input_text", text: "old screenshot" }, image] }];
    const raw = Buffer.from(JSON.stringify({ model: "gpt-5", stream: false, input: [...old, recent] }));
    assert.ok(raw.length > MAX_REQUEST_BYTES);
    return gzipSync(raw);
}

async function send(base: string, body: Buffer, session: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/responses`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", "session-id": session, ...headers }, body: new Uint8Array(body) });
}

test("over-budget rebuilt bodies stop at the forward-stage byte budget without touching upstream, whether images sit in messages or tool outputs", async () => {
    await fixture(async (base, _opts, calls) => {
        for (const tool of [false, true]) {
            const r = await send(base, largeBody(tool), `large-forward-${tool}`);
            assert.equal(r.status, 413);
            const error = await r.json() as { error: { stage: string; type: string; message: string } };
            assert.equal(error.error.stage, "forward");
            assert.equal(error.error.type, "request_too_large");
            assert.match(error.error.message, /reduce historical images or content before retrying/);
        }
        assert.equal(calls.length, 0);
    });
});

test("rebuilt over-budget requests stop with a forward-stage 413 without contacting upstream", async () => {
    await fixture(async (base, _opts, calls) => {
        const r = await send(base, largeBody(false), "large-over-budget");
        assert.equal(r.status, 413);
        const error = await r.json() as { error: { stage: string; type: string } };
        assert.equal(error.error.stage, "forward");
        assert.equal(error.error.type, "request_too_large");
        assert.equal(calls.length, 0);
    });
});

test("third large decode gets retryable admission error, then hits the forward-stage budget once a slot is released", async () => {
    await fixture(async (base, _opts, calls) => {
        const a = new DecodedRequestAdmission(), b = new DecodedRequestAdmission();
        const compressed = largeBody(false);
        a.observe(MAX_REQUEST_BYTES + 1); b.observe(MAX_REQUEST_BYTES + 1);
        try {
            const r = await send(base, compressed, "busy-large");
            assert.equal(r.status, 503);
            assert.equal(r.headers.get("retry-after"), "1");
            assert.equal((await r.json() as { error: { stage: string } }).error.stage, "decode");
            assert.equal(calls.length, 0);
            const small = await send(base, gzipSync(Buffer.from(JSON.stringify({ model: "gpt-5", input: [recent] }))), "small-during-busy");
            assert.equal(small.status, 200, await small.text());
            assert.equal(calls.length, 1, "normal traffic must not use the large-body slots");
            a.release();
            const again = await send(base, compressed, "busy-large-retry");
            assert.equal(again.status, 413);
            const error = await again.json() as { error: { stage: string; type: string } };
            assert.equal(error.error.stage, "forward");
            assert.equal(error.error.type, "request_too_large");
            assert.equal(calls.length, 1, "the over-budget retry must not reach upstream either");
        } finally { a.release(); b.release(); }
    });
});


test("decompression bombs and malformed oversized JSON cannot escape through raw forwarding", async () => {
    await fixture(async (base, _opts, calls) => {
        for (const [bytes, stage] of [[2 * MAX_REQUEST_BYTES + 1, "decode"], [MAX_REQUEST_BYTES + 1, "forward"]] as const) {
            const r = await send(base, gzipSync(Buffer.alloc(bytes, 65)), `oversize-${stage}`);
            assert.equal(r.status, 413);
            assert.equal((await r.json() as { error: { stage: string } }).error.stage, stage);
            assert.equal(calls.length, 0);
        }
        const ok = await send(base, gzipSync(Buffer.from(JSON.stringify({ model: "gpt-5", input: [recent] }))), "after-size-error");
        assert.equal(ok.status, 200, await ok.text());
        assert.equal(calls.length, 1);
    });
});

test("disconnect during a large decode cancels before forwarding and releases the large-request slot", async () => {
    await fixture(async (base, _opts, calls) => {
        const compressed = largeBody(false, 12 * 1024 * 1024);
        const observe = DecodedRequestAdmission.prototype.observe;
        const release = DecodedRequestAdmission.prototype.release;
        let observed: DecodedRequestAdmission | undefined;
        let cancelled = false;
        let client: http.ClientRequest;
        let done: () => void = () => {};
        const finished = new Promise<void>(resolve => { done = resolve; });
        DecodedRequestAdmission.prototype.observe = function(bytes) {
            observe.call(this, bytes);
            if (bytes > MAX_REQUEST_BYTES && !cancelled) {
                observed = this;
                cancelled = true;
                client.destroy();
            }
        };
        DecodedRequestAdmission.prototype.release = function() {
            release.call(this);
            if (this === observed) done();
        };
        const timeout = setTimeout(done, 30_000);
        try {
            client = http.request(`${base}/responses`, { method: "POST", headers: { "content-encoding": "gzip", "session-id": "abort-large", "content-type": "application/json" } });
            client.on("error", () => {});
            client.end(compressed);
            await finished;
            assert.ok(cancelled, "the decode must actually cross the large-request threshold");
            assert.equal(calls.length, 0);
            const a = new DecodedRequestAdmission(), b = new DecodedRequestAdmission();
            try { a.observe(MAX_REQUEST_BYTES + 1); b.observe(MAX_REQUEST_BYTES + 1); }
            finally { a.release(); b.release(); }
        } finally {
            clearTimeout(timeout);
            DecodedRequestAdmission.prototype.observe = observe;
            DecodedRequestAdmission.prototype.release = release;
        }
    });
});


test("an oversized rebuilt body reports an in-band error after SSE headers are committed, without contacting upstream", async () => {
    await fixture(async (base, opts, calls) => {
        const core = createCore();
        const server = http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.flushHeaders();
            void forward(req, res, opts, Buffer.alloc(MAX_REQUEST_BYTES + 1), null, core, defaultConfig(400_000), () => {}, resolveUpstream(opts, req.url ?? "", req), "late-budget").catch(err => res.destroy(err));
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
            const port = (server.address() as { port: number }).port;
            const r = await fetch(`http://127.0.0.1:${port}${new URL(base).pathname}/responses`, { method: "POST" });
            assert.equal(r.status, 200, "committed headers cannot be changed to 413");
            const text = await r.text();
            assert.match(text, /rebuilt request exceeds 104857600 bytes/);
            assert.match(text, /error/);
            assert.equal(calls.length, 0);
        } finally {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
