import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// One attempt per summarization call: this test is about the post-fold baseline, not retries.
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { defaultConfig, type Config } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { type CompressSettings } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";

// #1987 facet A: after a preflight fold, the session usage baseline must be anchored to
// the payload that ACTUALLY ships (the normal-config rebuild), never to the kernel's
// no-emergency-truncate view. That view keeps the tool outputs prepare() trims away near
// the window edge — anchoring to it printed "~42619 tokens saved (2309870 → 2818817)"
// and inflated every later meter until a real usage report landed.

function sse(inputTokens: number, outputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

type Call = { stream: boolean };

function makeUpstream(calls?: Call[]): http.Server {
    let streamCalls = 0;
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls?.push({ stream: !!parsed.stream });
            if (parsed.stream) {
                streamCalls += 1;
                res.writeHead(200, { "content-type": "text/event-stream" });
                // Turn 1: a usage-grade 240k baseline — near the raw payload's own scale
                // (300k), the user's real regime (#1987: 2.3M baseline vs 2.8M raw view).
                // Preflight's per-fold netting keeps the meter high enough that the
                // rebuild's truncate budget (meter → 0.855·window) trims real mass, so the
                // shipped payload lands well BELOW the kernel's untruncated view while the
                // netted meter sits between them. Turn 2: ZERO usage on purpose (#793
                // parity) so the post-fold anchor state survives settlement.
                res.end(streamCalls === 1 ? sse(240_000, 3) : sse(0, 0));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ content: [{ type: "text", text: "SUMMARY: the large recent messages were deterministic load-growth payloads; their raw content is no longer needed." }] }));
            }
        });
    });
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>, kernelOverrides?: Partial<Config>, compressOverrides?: Partial<CompressSettings>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, kernelOverrides),
        compress: { injectTool: true, injectNudge: true, ...compressOverrides },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

test("e2e #1987: post-fold usage baseline anchors to the shipped payload, not the untruncated kernel view", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    const headers = { "content-type": "application/json", "x-acp-session": "issue1987-anchor-sess" };

    try {
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        // Twenty bash tool pairs (~300k tokens untruncated): preflight folds oldest-first
        // but its 16-call summary budget runs out far short of the list, so the kernel's
        // no-emergency-truncate view still carries a huge unfolded tail while the rebuilt
        // payload ships much less. The old anchor measured the untruncated view; the new
        // one measures what ships (or the netted meter, whichever is larger).
        const pairs: Array<{ role: string; content: unknown }> = [];
        for (let i = 0; i < 20; i++) {
            pairs.push({ role: "assistant", content: [{ type: "tool_use", id: `call_${i}`, name: "bash", input: { command: `step ${i}` } }] });
            pairs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: `OUT_${i}_`.repeat(8_571) }] });
        }
        pairs.push({ role: "user", content: "continue the task" });
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: pairs }),
        });
        // The rebuilt payload still exceeds the 10k window (only the meter-sized truncate
        // budget was spent), so the turn is refused — exactly the user's 502 path. The
        // regression is in the BASELINE left behind, not in the status.
        assert.equal(r2.status, 502, "the over-window turn is refused after preflight");
        await r2.text();

        assert.ok(calls.filter((c) => !c.stream).length >= 1, "preflight made the summarization call(s)");
        assert.equal(calls.filter((c) => c.stream).length, 1, "only turn 1 reached the upstream");

        const s = getSession("issue1987-anchor-sess");
        assert.ok(s, "session exists");
        // Netted meter ≈ 240k − folded mass (~80k) ≈ 160k; the OLD preflight-side anchor
        // would have raised it to the untruncated kernel view (~220k) instead. The gap is
        // invariant to fold volume (it equals raw−baseline minus summary costs), so the
        // bound sits between the two regimes with margin on both sides.
        assert.ok(s.stats.lastInputTokens < 190_000, `baseline stays at netted/shipped scale, got ${s.stats.lastInputTokens}`);
        assert.equal(s.stats.lastInputTokensSource, "usage");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
