import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type CompressSettings, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { normalizeUpstreamOrigin } from "../src/util.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #6395: the preflight `fits` check (no-compression branch) judged fit on the
// UNCAlibrated estimateCoreMessages while the trigger used the calibrated
// estimate (k̂-scaled). When k̂ > 1 the trigger fires (calibrated ≥ limit) but
// the fits check says the payload fits (uncalibrated < limit) → forwards a
// guaranteed-400. The fix: the fits check uses calibratedPayload, the same
// scale the trigger and the if-branch (rebuiltCalibrated) already use.

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
                res.end(okSse(1000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ content: [{ type: "text", text: "SUMMARY: compressed." }] }));
            }
        });
    });
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>, compressOverrides?: Partial<CompressSettings>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 20_000,
        kernelConfig: defaultConfig(20_000),
        compress: { injectTool: true, injectNudge: true, minCompressRange: 100_000, ...compressOverrides },
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

// Build a conversation whose uncalibrated estimate sits just under the
// effective window (100K − output headroom) but whose calibrated estimate
// (× k̂) exceeds it — the exact shape from #6395's log (k̂=1.18, uncalibrated
// ~671K, calibrated ~793K, window 792K).
function calibratedOverflowConversation(): Array<{ role: string; content: string }> {
    // A single large user message: nothing to fold (0 compressible ranges —
    // minCompressRange=100K chars, message is ~50K chars).
    // ~50K chars → ~12.5K tokens uncalibrated. With k̂=10.0 → ~125K calibrated.
    // Effective window = 20K − 5K (output headroom, max_tokens=30000 →
    // min(30000, 0.25×20K)=5K) = 15K.
    // 12.5K < 15K (uncalibrated fits) but 125K > 15K (calibrated over).
    const filler = `CALIB_TEST_SINGLE_`.repeat(3125);
    return [{ role: "user", content: `Single large message. ${filler}` }];
}

test("#6395: calibrated estimate over window + uncalibrated under + 0 compressible ranges → fail-fast 413, not forward", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstreamOk(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "test-model": { context: 20_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const sessionId = "issue6395-calibrated-fits";
        // Seed the session with a calibration factor > 1 so the calibrated
        // estimate exceeds the window while the uncalibrated estimate does not.
        // We do this by first sending a small request that gets a usage
        // report, then manually setting the calibration factor.
        const smallBody = {
            model: "test-model",
            stream: true,
            max_tokens: 1024,
            messages: [{ role: "user", content: "hello" }],
        };
        const smallRes = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            body: JSON.stringify(smallBody),
        });
        await smallRes.text();

        const session = getSession(sessionId);
        assert.ok(session, "session must exist after first request");
        // Set the calibration factor to 10.0 (the log shows k̂=1.18; we use a
        // larger value to make the calibrated estimate clearly over the window
        // while the uncalibrated estimate stays under it).
        session.stats.calibratedEstimate = 10.0;
        session.stats.calibratedEstimateOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${upstreamPort}`);
        // Set a usage baseline so the trigger uses the baseline floor.
        session.stats.lastInputTokens = 100;
        session.stats.lastInputTokensSource = "usage";
        session.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${upstreamPort}`);

        // Now send a request whose uncalibrated estimate is under the
        // effective window but whose calibrated estimate is over it.
        // The conversation is ~70K uncalibrated → ~84K calibrated.
        // Effective window = 100K − output headroom. For a non-Anthropic
        // model with no separate output budget evidence, the headroom is
        // min(maxOutput, 0.25 × window) = min(1024, 25000) = 1024.
        // So effective window ≈ 98976. 84K < 98976 → still fits.
        //
        // Hmm, the output headroom is too small. Let me use a bigger
        // max_tokens to make the headroom bigger.
        // Actually, the headroom is min(maxOutput, capPct × window).
        // With maxOutput=1024 and capPct=0.25: headroom = min(1024, 25000) = 1024.
        // So effective window = 100000 - 1024 = 98976.
        // 84K < 98976 → still fits.
        //
        // I need a bigger headroom. Let me set max_tokens to 30000.
        // headroom = min(30000, 25000) = 25000.
        // effective window = 100000 - 25000 = 75000.
        // 84K > 75000 → calibrated over. 70K < 75000 → uncalibrated under.
        // This is the right shape.
        const conv = calibratedOverflowConversation();
        const body = {
            model: "test-model",
            stream: true,
            max_tokens: 30000,
            messages: conv,
        };
        const res = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            body: JSON.stringify(body),
        });
        const resBody = await res.text();

        // The preflight should fail-fast with 413 (calibrated over window,
        // 0 compressible ranges) instead of forwarding (which would 400).
        assert.equal(res.status, 413, `expected 413 fail-fast, got ${res.status}: ${resBody.slice(0, 300)}`);
        // The upstream should NOT have received the forwarded request
        // (only the small request and possibly the preflight summary call).
        const forwardedCalls = calls.filter(c => c.stream && c.body.includes("CALIB_TEST"));
        assert.equal(forwardedCalls.length, 0, "the over-window payload must NOT be forwarded to the upstream");
    } finally {
        proxy.close(); proxy.closeIdleConnections?.();
        upstream.close(); upstream.closeIdleConnections?.();
    }
});
