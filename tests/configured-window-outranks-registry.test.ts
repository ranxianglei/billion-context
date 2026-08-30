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

// #344: gpt-5.6-sol behind a private relay (host absent from the registry
// host table) — models.dev lists openai/gpt-5.6-sol at 1,050,000, but the
// relay serves it at 272K and the user declared context=272000 on the route.
// The warm-registry peek must NOT outrank the user's explicit per-route
// per-model declaration (config.ts contract: "The per-route declaration
// (which the user controls) always wins"). Regression: the #212 priority
// change put peekRegistryContext above resolveConfiguredContextLimit, so the
// nudge denominator became 1,050,000 − max_tokens (922000 / 988782 in the
// issue log) instead of 272000 − max_tokens.

const MODEL = "gpt-5.6-sol"; // table /^gpt-5/i → 400K; registry → 1,050,000; declared → 272K
const DECLARED = 272_000;
const REGISTRY = 1_050_000;

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
}

async function startRig(models?: Record<string, { context?: number }>): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(500));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({ [`openai/${MODEL}`]: { limit: { context: REGISTRY } } });
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: models ? { models } : {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
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
    return { proxyPort, upstreamPort, proxy, upstream };
}

function url(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("#344: per-route model declaration outranks the warm models.dev registry", async () => {
    const rig = await startRig({ [MODEL]: { context: DECLARED } });
    try {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": "declared-sess",
            "x-bili-plugin": "test-agent",
        };
        const r = await fetch(url(rig), { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }) });
        assert.equal(r.status, 200);
        await r.text();
        // The declared 272K must win over the registry's 1,050,000 (which
        // itself outranks the built-in table's 400K).
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, DECLARED, "declared context outranks the registry");
    } finally {
        await closeRig(rig);
    }
});

test("#344: without a declaration the warm registry still outranks the built-in table", async () => {
    const rig = await startRig();
    try {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": "registry-sess",
            "x-bili-plugin": "test-agent",
        };
        const r = await fetch(url(rig), { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }) });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, REGISTRY, "registry 1,050,000 outranks the table's 400K when nothing is declared");
    } finally {
        await closeRig(rig);
    }
});
