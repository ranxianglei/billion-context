import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// The configured window here is deliberately LARGE (400k) so it plays the role
// of a wrong/mis-detected window (the 200k-fallback footgun for an unknown
// model on a relay). The upstream truthfully reports its real window (128000)
// via a context-overflow 400. The proxy must:
//   1. detect the overflow and pass the 400 + body through verbatim;
//   2. learn the real window (128000) into session.metadata.learnedContextLimits,
//      keyed by the model that overflowed;
//   3. arm an emergency shrink (lastInputTokens >= window);
//   4. let the NEXT request recover (self-healed window, upstream 200);
//   5. NOT apply the learned limit to a different model in the same session
//      (the user can switch models mid-conversation).

const OVERFLOW_BODY = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" },
});

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 5000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

test("e2e: upstream context overflow → learn window + arm shrink + pass through, then recover", async () => {
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            // First call: a context-overflow 400 with the real window in the body.
            // Subsequent calls: a normal 200 SSE.
            if (call === 0) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(OVERFLOW_BODY);
            } else {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            }
            call += 1;
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 }, "claude-big": { context: 400_000 } } } },
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] });

        // --- Request 1: overflow 400 ---
        const r1 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "overflow-sess" },
            body,
        });
        // The 400 is passed through verbatim (no behavior change for the client).
        assert.equal(r1.status, 400);
        const r1text = await r1.text();
        assert.ok(r1text.includes("prompt is too long"), "error body must pass through");

        // The session learned the real window (per model) and armed the emergency shrink.
        const s = listSessions().find((x) => (x.metadata.learnedContextLimits as Record<string, number> | undefined)?.["claude-test"] === 128000);
        assert.ok(s, "a session learned the real window from the overflow (keyed by model)");
        assert.equal(s!.metadata.learnedContextLimit, undefined, "no legacy scalar when the model is known");
        assert.ok(s!.stats.lastInputTokens >= 128000, "emergency shrink armed (lastInputTokens >= window)");

        // --- Request 2: recovers (self-healed window; upstream is fine now) ---
        const r2 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "overflow-sess" },
            body,
        });
        assert.equal(r2.status, 200, "second request recovers");
        await r2.text(); // drain

        // The real usage report from the successful turn overwrote the armed value.
        const s2 = listSessions().find((x) => x.id === s!.id);
        assert.equal(s2?.stats.lastInputTokens, 5000);

        // --- Request 3: DIFFERENT model in the same session (user switched
        // models) — the learned limit from claude-test must NOT apply. The map
        // gains no entry for claude-big and the session keeps its 400k window.
        const body3 = JSON.stringify({ model: "claude-big", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] });
        const r3 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "overflow-sess" },
            body: body3,
        });
        assert.equal(r3.status, 200);
        await r3.text(); // drain
        const s3 = listSessions().find((x) => x.id === s!.id);
        const limits = s3?.metadata.learnedContextLimits as Record<string, number> | undefined;
        assert.equal(limits?.["claude-big"], undefined, "no learned limit for the other model");
        assert.deepEqual(Object.keys(limits ?? {}), ["claude-test"], "only the overflowing model is scoped");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
