import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { findRoute, parseRouteEntry } from "../src/config.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #661: per-route `passthrough` — upstreams that fingerprint the request body
// (ZCode 405/3012) must get byte-verbatim forwarding without a global flag.

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("parseRouteEntry: passthrough boolean round-trips, non-boolean ignored", () => {
    assert.equal(parseRouteEntry({ passthrough: true })?.passthrough, true);
    assert.equal(parseRouteEntry({ passthrough: false })?.passthrough, false);
    assert.equal(parseRouteEntry({ passthrough: "yes" })?.passthrough, undefined, "non-boolean must be ignored");
    assert.equal(parseRouteEntry({ passthrough: 1 })?.passthrough, undefined, "non-boolean must be ignored");
    assert.deepEqual(parseRouteEntry(null), {});
    assert.equal(parseRouteEntry({ models: { m1: { context: 100 } }, passthrough: true })?.passthrough, true, "coexists with models");
});

test("findRoute: mitm:// key matches only MITM traffic to that host (ZCode case)", () => {
    const routes = { "mitm://zcode.z.ai": { passthrough: true } };
    const mitmHit = findRoute(routes, "mitm://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
    assert.equal(mitmHit?.passthrough, true, "MITM traffic to zcode.z.ai matches the mitm:// key");
    assert.equal(findRoute(routes, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"), undefined, "https:// (API-key /bili/) traffic must NOT match a mitm:// key");
    assert.equal(findRoute(routes, "mitm://zcode.z.ai.evil/"), undefined, "host boundary: sibling host must not match");
});

test("findRoute: shallow host key matches all paths on the host", () => {
    const routes = { "https://open.bigmodel.cn": { passthrough: true } };
    assert.equal(findRoute(routes, "https://open.bigmodel.cn/api/anthropic/v1/messages")?.passthrough, true);
    assert.equal(findRoute(routes, "https://open.bigmodel.cn")?.passthrough, true, "exact key match");
});

// max_tokens must exceed SIDE_REQUEST_MAX_TOKENS (200) or the control case
// takes the side-request passthrough instead of the kernel round-trip.
const ANTHROPIC_BODY = '{\n  "prompt_cache_key": "keep-me-please",\n  "model": "claude-test",\n  "max_tokens": 4096,\n  "messages": [\n    {\n      "role": "user",\n      "content": [\n        { "type": "text", "text": "hi there" }\n      ]\n    }\n  ]\n}';

const ANTHROPIC_RESPONSE = JSON.stringify({
    id: "msg_test_1",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", "text": "hello back" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
});

function makeUpstream(capture: { url: string; body: string }, respond: (res: http.ServerResponse) => void): http.Server {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            capture.url = req.url ?? "";
            capture.body = Buffer.concat(chunks).toString("utf8");
            respond(res);
        });
    });
    return upstream;
}

function makeOpts(routes: Record<string, { passthrough?: boolean }>, upstream: string): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream,
        routes,
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
    };
}

async function postMessages(proxyPort: number, upstreamHost: string, sessionId: string): Promise<{ status: number; body: string }> {
    return await new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port: proxyPort,
                method: "POST",
                path: `/bili/http://${upstreamHost}/v1/messages`,
                headers: {
                    "content-type": "application/json",
                    host: upstreamHost,
                    "x-acp-session": sessionId,
                    "content-length": String(Buffer.byteLength(ANTHROPIC_BODY)),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            },
        );
        req.on("error", reject);
        req.write(ANTHROPIC_BODY);
        req.end();
    });
}

test("route passthrough: body forwarded byte-for-byte, response piped verbatim, kernel bypassed", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const capture = { url: "", body: "" };
    const upstream = makeUpstream(capture, (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(ANTHROPIC_RESPONSE);
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const upstreamHost = `127.0.0.1:${upstreamPort}`;

    const opts = makeOpts({ [`http://${upstreamHost}`]: { passthrough: true } }, `https://${upstreamHost}`);
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const out = await postMessages(proxyPort, upstreamHost, "route-passthrough-test");
        assert.equal(out.status, 200, `client must see the upstream 200; got ${out.status}: ${out.body}`);
        assert.equal(capture.body, ANTHROPIC_BODY, "upstream must receive the EXACT client bytes (no re-serialization, field order + whitespace intact)");
        assert.ok(capture.body.includes("prompt_cache_key"), "prompt_cache_key must survive (kernel rebuild deletes it)");
        assert.ok(!capture.body.includes("\x3cacp "), "no ACP render tags may be injected");
        assert.equal(out.body, ANTHROPIC_RESPONSE, "response must be piped verbatim to the client");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("control: same request WITHOUT a passthrough route goes through the kernel round-trip", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const capture = { url: "", body: "" };
    const upstream = makeUpstream(capture, (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(ANTHROPIC_RESPONSE);
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const upstreamHost = `127.0.0.1:${upstreamPort}`;

    const opts = makeOpts({}, `https://${upstreamHost}`);
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const out = await postMessages(proxyPort, upstreamHost, "route-passthrough-control");
        assert.equal(out.status, 200, `client must see the upstream 200; got ${out.status}: ${out.body}`);
        assert.notEqual(capture.body, ANTHROPIC_BODY, "kernel round-trip must re-serialize the body");
        assert.ok(!capture.body.includes("prompt_cache_key"), "kernel rebuild deletes prompt_cache_key");
        assert.ok(capture.body.includes("\x3cacp "), "kernel round-trip injects ACP render tags");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("route passthrough: global passthrough=false still compresses OTHER routes", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const bypassCapture = { url: "", body: "" };
    const normalCapture = { url: "", body: "" };
    const respondJson = (res: http.ServerResponse) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(ANTHROPIC_RESPONSE);
    };
    const bypassUpstream = makeUpstream(bypassCapture, respondJson);
    const normalUpstream = makeUpstream(normalCapture, respondJson);
    bypassUpstream.listen(0, "127.0.0.1");
    normalUpstream.listen(0, "127.0.0.1");
    await listen(bypassUpstream);
    await listen(normalUpstream);
    const bypassHost = `127.0.0.1:${(bypassUpstream.address() as { port: number }).port}`;
    const normalHost = `127.0.0.1:${(normalUpstream.address() as { port: number }).port}`;

    const opts = makeOpts({ [`http://${bypassHost}`]: { passthrough: true } }, `http://${normalHost}`);
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const outBypass = await postMessages(proxyPort, bypassHost, "route-passthrough-mixed-1");
        const outNormal = await postMessages(proxyPort, normalHost, "route-passthrough-mixed-2");
        assert.equal(outBypass.status, 200);
        assert.equal(outNormal.status, 200);
        assert.equal(bypassCapture.body, ANTHROPIC_BODY, "bypassed route: byte-identical");
        assert.notEqual(normalCapture.body, ANTHROPIC_BODY, "non-bypassed route: kernel round-trip still active");
        assert.ok(!bypassCapture.body.includes("\x3cacp "), "bypassed route: no tags");
        assert.ok(normalCapture.body.includes("\x3cacp "), "non-bypassed route: tags injected");
    } finally {
        await close(proxy);
        await close(bypassUpstream);
        await close(normalUpstream);
    }
});
