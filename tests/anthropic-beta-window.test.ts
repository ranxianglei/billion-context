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

// #302: an `anthropic-beta: context-1m-…` header means the client negotiated a
// 1M-token upstream window. The proxy must size its OWN context window to 1M
// (not the model-table 200K) so the EMERGENCY / nudge / usage bands sit against
// the real limit. Regression: the client-facing instance missed the header and
// fired EMERGENCY at 261K input (131% of 200K) when it was only 26% of 1M.
//
// The window is resolved PER-REQUEST (the beta header may appear/disappear
// between requests of the same session), so the resolution must read the header
// on every request, not cache it on the session.

const MODEL = "claude-sonnet-4-5"; // table default 200K (config.ts:121)
const BETA = "context-1m-2025-08-07";
const MEASURED = 261_206; // the ~261K input from the issue's log evidence

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

// ~30K tokens of compressible content so the kernel has a viable T1 range
// (minCompressRange = 5000 chars) to offer if EMERGENCY fires. Without some
// compressible content the kernel suppresses the nudge even when over limit.
function bigConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const filler = `MARKER_${i}_content_`.repeat(250);
        msgs.push({ role, content: `Message ${i} of the long conversation. ${filler}` });
    }
    return msgs;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    forwards: string[]; // raw bodies the proxy forwarded upstream (stream calls)
    proxy: http.Server;
    upstream: http.Server;
}

async function startRig(): Promise<Rig> {
    const forwards: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            if (parsed.stream) {
                forwards.push(raw);
                res.writeHead(200, { "content-type": "text/event-stream" });
                // Teach the session its real context size on the first forward
                // (the upstream's own input_tokens); later forwards report a
                // small post-fold size so the baseline doesn't drift.
                res.end(okSse(forwards.length === 1 ? MEASURED : 1000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_s", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "s" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 5 } }));
            }
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
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
    return { proxyPort, upstreamPort, forwards, proxy, upstream };
}

function url(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

// The EMERGENCY nudge is rendered as a trailing user message whose text begins
// "⚠️ Context limit reached — compress now." (acp-kernel emergencyHeader).
function hasEmergencyNudge(body: string): boolean {
    return body.includes("Context limit reached");
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("e2e: anthropic-beta context-1m → 1M window → EMERGENCY suppressed at 261K input", async () => {
    const rig = await startRig();
    try {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": "beta-sess",
            "anthropic-beta": BETA,
        };
        // Request 1: tiny payload, but the upstream reports a 261K-token
        // context → session.stats.lastInputTokens = 261206.
        const r1 = await fetch(url(rig), { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(listSessions()[0]?.stats.lastInputTokens, MEASURED, "session context is 261K tokens");

        // Request 2: a long (compressible) conversation. Under the 1M window
        // this is 26% usage (< 75% nudge band) → no EMERGENCY, no nudge.
        const r2 = await fetch(url(rig), { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: bigConversation() }) });
        assert.equal(r2.status, 200);
        await r2.text();

        const lastForward = rig.forwards[rig.forwards.length - 1]!;
        assert.ok(!hasEmergencyNudge(lastForward), "no EMERGENCY nudge at 26% of the 1M window");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: without beta → 200K window → EMERGENCY fires at 261K input", async () => {
    const rig = await startRig();
    try {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": "no-beta-sess",
        };
        const r1 = await fetch(url(rig), { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(listSessions()[0]?.stats.lastInputTokens, MEASURED, "session context is 261K tokens");

        // Same 261K input, but no beta header → the window is the model-table
        // 200K → 131% usage (>= 95% EMERGENCY threshold) → nudge appended.
        const r2 = await fetch(url(rig), { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: bigConversation() }) });
        assert.equal(r2.status, 200);
        await r2.text();

        const lastForward = rig.forwards[rig.forwards.length - 1]!;
        assert.ok(hasEmergencyNudge(lastForward), "EMERGENCY nudge fires at 131% of the 200K window");
    } finally {
        await closeRig(rig);
    }
});

test("plugin: effectiveContextLimit honors anthropic-beta context-1m, per-request", async () => {
    const rig = await startRig();
    try {
        const base: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": "plugin-sess",
            "x-bili-plugin": "test-agent",
        };
        // With the beta header → the window reported to the plugin is 1M.
        await (await fetch(url(rig), { method: "POST", headers: { ...base, "anthropic-beta": BETA }, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }) })).text();
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, 1_000_000, "beta → 1M reported to plugin");

        // Same session, header disappears → the window drops back to the model
        // default 200K. This is the per-request resolution the issue requires:
        // the beta may appear/disappear between requests of one session.
        await (await fetch(url(rig), { method: "POST", headers: base, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi again" }] }) })).text();
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, 200_000, "no beta → 200K (per-request resolution)");
    } finally {
        await closeRig(rig);
    }
});
