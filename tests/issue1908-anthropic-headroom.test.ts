import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #1908 mechanism 3: the anthropic wire skipped the #453 outgoing clamp on the
// false premise that Anthropic limits input independently of max_tokens — it does
// not, rejecting with 400 when input_tokens + max_tokens exceeds the window.
// Pins the backstop: forwarded max_tokens is capped so input+output fits.

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const RESPONSE: string[] = [
    sse("message_start", { type: "message_start", message: { id: "msg_h_1", role: "assistant", usage: { input_tokens: 3 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
    sse("message_stop", { type: "message_stop" }),
];

interface Harness {
    port: number;
    upPort: number;
    captured: Record<string, unknown>[];
    close(): Promise<void>;
}

async function startHarness(window: number): Promise<Harness> {
    const captured: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const line of RESPONSE) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upPort}`]: { models: { "claude-test": { context: window } } } },
        modelContextLimit: window, kernelConfig: defaultConfig(window),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;

    return {
        port, upPort, captured,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

interface Msg { role: string; content: string; }

async function post(h: Harness, sessionId: string, maxTokens: number, messages: Msg[]): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${h.port}/bili/http://127.0.0.1:${h.upPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model: "claude-test", max_tokens: maxTokens, stream: true, system: "You are a test assistant.", messages }),
    });
    assert.equal(resp.status, 200);
    await resp.text();
}

test("#1908: anthropic max_tokens is clamped so input+output fits the window", async () => {
    // A ~640k-char assistant turn puts the local estimate at ~160k of a 200k
    // window: UNDER the window (so preflight leaves it alone) yet 160k + 60k
    // requested output would overflow — only the outgoing clamp sees the
    // collision and caps max_tokens before the forward.
    const h = await startHarness(200_000);
    try {
        await post(h, "headroom-fire", 60_000, [
            { role: "user", content: "start" },
            { role: "assistant", content: "x".repeat(640_000) },
            { role: "user", content: "now" },
        ]);
        const t = h.captured[0] as { max_tokens?: number };
        assert.ok(typeof t.max_tokens === "number", "forwarded body carries a numeric max_tokens");
        assert.ok(t.max_tokens! < 60_000, `max_tokens clamped below the 60k request (got ${t.max_tokens})`);
        assert.ok(t.max_tokens! >= 1_024, "clamped budget stays above the floor");
    } finally {
        await h.close();
    }
});

test("#1908: anthropic max_tokens passes through unchanged when input+output fits", async () => {
    // Control: small history leaves ample room, so the clamp is a no-op.
    const h = await startHarness(200_000);
    try {
        await post(h, "headroom-ctrl", 40_000, [
            { role: "user", content: "hi" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "again" },
        ]);
        const t = h.captured[0] as { max_tokens?: number };
        assert.equal(t.max_tokens, 40_000, "unclamped when input+output fits the window");
    } finally {
        await h.close();
    }
});
