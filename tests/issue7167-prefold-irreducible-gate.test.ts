import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type CompressSettings, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #7167: the tool surface is IRREDUCIBLE — preflight folding rewrites
// messages[] only, while tools[]/system/other ride through verbatim on every
// outbound. A session whose tools[] alone measures ≥ the window spent an
// LLM-summarization fold (real money + permanent history rewrite) and still
// died at the egress 413, every round. The gate added to
// preflightCompressIfNeeded prices the non-message surface on the #554 meter
// (the same ruler as the egress fuse) BEFORE the trigger guard and fails fast
// with an actionable message instead of burning folds.

type Call = { stream: boolean; body: string };

function makeUpstreamOk(calls?: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls?.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(
                    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 100 } } })}\n\n` +
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
                    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
                    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
                );
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ content: [{ type: "text", text: "SUMMARY: history folded." }] }));
            }
        });
    });
}

const WINDOW = 400_000;

function startProxy(upstreamPort: number, compressOverrides?: Partial<CompressSettings>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-tools": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true, ...compressOverrides },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

test("#7167: a tools[] surface ≥ the window fails fast 413 BEFORE any fold (zero upstream calls, actionable message, structured evidence)", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstreamOk(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // 70_000 × 29 chars = 2.03M chars of tool description ≈ 508K tokens on
        // the #554 meter (4 ASCII chars/token) — 27% over the 400K window —
        // while the conversation itself is tiny.
        const fatTool = {
            type: "function",
            function: {
                name: "do_thing",
                description: "A very detailed description. ".repeat(70_000),
                parameters: { type: "object", properties: {} },
            },
        };
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "tools-doom" },
            body: JSON.stringify({ model: "gpt-tools", messages: [{ role: "user", content: "hello" }], tools: [fatTool] }),
        });
        const text = await response.text();
        assert.equal(response.status, 413, `expected the irreducible-surface 413, got ${response.status}: ${text.slice(0, 300)}`);
        const err = JSON.parse(text);
        assert.equal(err.error.code, "preflight_compress_failed");
        assert.match(err.error.message, /non-message surface/, err.error.message);
        assert.match(err.error.message, /can never shrink the tool surface/);
        assert.equal(err.error.retryable, false);
        assert.equal(err.error.windowTokens, WINDOW, "the structured 413 names the window it was judged against (#7382)");
        assert.ok(typeof err.error.inboundBytes === "number" && err.error.inboundBytes > 0, "the structured 413 carries the inbound size the client could not see (#7382)");
        assert.equal(calls.length, 0, "no fold, no forward — the doomed bet is never spent (#7167)");
    } finally {
        proxy.close();
        upstream.close();
    }
});

test("#7167 control: a tool surface well UNDER the window forwards normally (the gate only bites at doom scale)", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstreamOk(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "tools-fine" },
            body: JSON.stringify({
                model: "gpt-tools",
                messages: [{ role: "user", content: "hello" }],
                tools: [{ type: "function", function: { name: "do_thing", description: "short", parameters: { type: "object", properties: {} } } }],
            }),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text.slice(0, 300));
        assert.ok(calls.length >= 1, "the fitting payload reached the upstream");
    } finally {
        proxy.close();
        upstream.close();
    }
});
