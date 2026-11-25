import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

test("raw-body meters exclude thinking/reasoning cryptographic signatures", () => {
    const sig = "S".repeat(4_800_000);
    const body = {
        messages: [
            {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "brief", signature: sig },
                    { type: "text", text: "done" },
                ],
            },
            {
                role: "model",
                parts: [
                    { thought: true, text: "gem", thoughtSignature: sig },
                    { text: "ok", thought_signature: sig },
                ],
            },
        ],
    };
    const tok = estimateRawBodyTokens(body);
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.total, tok);
    assert.ok(tok < 1000, `opaque signature blobs must not inflate token count (got ${tok})`);
    assert.ok(
        tok >= defaultCountTokens("brief") + defaultCountTokens("done"),
        "visible text tokens remain counted",
    );
    // OpenAI Responses reasoning.encrypted_content carries encrypted reasoning
    // token mass that counts toward the context window and must stay metered.
    const responsesTok = estimateRawBodyTokens({ input: [{ type: "reasoning", encrypted_content: "Q".repeat(70_000), summary: [] }] });
    assert.ok(responsesTok > 10_000, `Responses encrypted_content must remain metered (got ${responsesTok})`);
});

test("e2e: signed thinking payloads under window are not 413'd by egress window fuse", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(
                "event: message_start\n"
                + `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], usage: { input_tokens: 100, output_tokens: 1 } } })}\n\n`
                + "event: message_stop\n"
                + `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
            );
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 300_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 300_000,
        kernelConfig: defaultConfig(300_000, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
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
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const blocks = Array.from({ length: 120 }, (_, i) => ({
            type: "thinking",
            thinking: `step ${i}`,
            signature: "A".repeat(40_000),
        }));
        const res = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sig-fuse-test" },
            body: JSON.stringify({
                stream: true,
                messages: [
                    { role: "user", content: "start" },
                    { role: "assistant", content: [...blocks, { type: "text", text: "ready" }] },
                    { role: "user", content: "continue" },
                ],
            }),
        });
        assert.equal(res.status, 200, `expected 200 from upstream, got ${res.status}: ${await res.text()}`);
    } finally {
        proxy.close();
        proxy.closeAllConnections?.();
        upstream.close();
        upstream.closeAllConnections?.();
    }
});
