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

// #11: a relay that 500s an oversized request also never reports usage, so
// lastInputTokens stays frozen and every retry re-sends the same payload —
// a deadlock. On a 5xx the proxy must arm the emergency shrink with a local
// estimate of the body it just sent, so the NEXT turn's processTurn fires
// the kernel's emergency nudge + tool-result truncate and the payload
// shrinks. The recovery turn's real usage report must then overwrite the
// armed value.

const RELAY_500_BODY = JSON.stringify({
    error: { type: "new_api_error", message: "upstream error: do request failed (request id: abc)" },
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

function bigSession(): unknown[] {
    // Roughly the #11 shape: a long history whose bulk is chunky tool
    // results (what emergency-truncate targets), far past the 16k window
    // configured below. Each tool_result is 12k chars (~3k tokens) — above
    // the 1000-token floor and the 2k+2k keep-prefix/suffix, so each is a
    // truncation candidate.
    const msgs: unknown[] = [];
    for (let i = 0; i < 40; i++) {
        msgs.push({ role: "user", content: `turn ${i} ` + "x".repeat(500) });
        msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "run", input: {} }] });
        msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "z".repeat(12_000) }] });
        msgs.push({ role: "assistant", content: [{ type: "text", text: `reply ${i}` }] });
    }
    return msgs;
}

test("e2e: relay 5xx on oversized request → arm emergency shrink → next turn truncates", async () => {
    let call = 0;
    let sawShrunkPayload = false;
    let firstPayloadTokens = 0;
    let secondPayloadTokens = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const bodyText = Buffer.concat(chunks).toString("utf8");
            if (call === 0) {
                firstPayloadTokens = Math.ceil(bodyText.length / 4);
                // The relay fails the oversized request with its own error.
                res.writeHead(500, { "content-type": "application/json" });
                res.end(RELAY_500_BODY);
            } else {
                secondPayloadTokens = Math.ceil(bodyText.length / 4);
                sawShrunkPayload = bodyText.includes("[truncated for context space]");
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            }
            call += 1;
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const store = new SessionStore({ enabled: false });
    _setStoreForTest(store);
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-relay": { context: 16_000 } } } },
        modelContextLimit: 16_000,
        kernelConfig: defaultConfig(16_000),
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
        const headers = { "content-type": "application/json", "x-acp-session": "relay500-sess" };

        // --- Request 1: oversized payload → relay 500, passed through verbatim.
        const body1 = JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, messages: bigSession() });
        const r1 = await fetch(url, { method: "POST", headers, body: body1 });
        assert.equal(r1.status, 500);
        const r1text = await r1.text();
        assert.ok(r1text.includes("new_api_error"), "relay error body must pass through");

        // The 5xx armed the emergency shrink with a local estimate of the
        // body actually sent (>= a rough char/8 lower bound of the payload).
        const s = listSessions()[0];
        assert.ok(s, "session exists");
        assert.ok(
            s.stats.lastInputTokens >= Math.ceil(body1.length / 8),
            `armed with local estimate (lastInputTokens=${s.stats.lastInputTokens}, body ~${Math.ceil(body1.length / 4)} tokens)`,
        );

        // --- Request 2: same history resent by the client. The armed value
        // drives emergency nudge + tool-result truncate server-side, so the
        // forwarded payload shrinks and the (now healthy) relay accepts it.
        const r2 = await fetch(url, { method: "POST", headers, body: body1 });
        assert.equal(r2.status, 200, "second request recovers after emergency shrink");
        await r2.text();

        assert.ok(sawShrunkPayload, "recovery payload contains the truncation marker");
        assert.ok(secondPayloadTokens < firstPayloadTokens, `payload shrank (${firstPayloadTokens} → ${secondPayloadTokens} tokens)`);

        // The real usage report from the successful turn overwrote the armed value.
        const s2 = listSessions()[0];
        assert.equal(s2?.stats.lastInputTokens, 5000);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e: 4xx (auth) must NOT arm the emergency shrink", async () => {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "authentication_error", message: "invalid api key" } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const store = new SessionStore({ enabled: false });
    _setStoreForTest(store);
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-relay": { context: 16_000 } } } },
        modelContextLimit: 16_000,
        kernelConfig: defaultConfig(16_000),
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
        const body = JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "x".repeat(200_000) }] });
        const r1 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "auth4xx-sess" },
            body,
        });
        assert.equal(r1.status, 401);
        await r1.text();
        const s = listSessions()[0];
        assert.ok(s, "session exists");
        assert.equal(s.stats.lastInputTokens, 0, "4xx must not arm the emergency shrink");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
