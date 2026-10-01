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
import { MAX_SUMMARY_CALLS_PER_PREFLIGHT } from "../src/preflight.ts";

// #574/#569: preflight used to try exactly ONE range per round (the oldest)
// and declare GLOBAL exhaustion when that single range yielded no applied
// chunk — so one bad leading edge (an unusable summary) produced a false 502
// on a still-recoverable session while later spans were compressible. These
// E2E tests drive the real proxy against a mock Anthropic upstream whose
// summarization responses can be made usable or unusable per call, and pin the
// fixed walk: try every viable range until one folds, bound the summarization
// cost, and report a truthful exhaustion.

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. " +
    "Key decisions: chose the multi-range walk over lossy truncation because the payload must stay coherent. " +
    "Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

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

function conversation(n: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

type Call = { stream: boolean; body: string };

// Mock Anthropic upstream. Main requests are stream:true (answered with SSE);
// preflight summarization calls are stream:false (answered with a JSON message
// whose text is SUMMARY_TEXT when usable(idx) else empty — the proxy treats an
// empty/too-short summary as unusable and skips that range).
function makeUpstream(usable: (idx: number) => boolean): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    let summaryIdx = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                summaryIdx += 1;
                const text = usable(summaryIdx) ? SUMMARY_TEXT : "";
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary", type: "message", role: "assistant", model: "claude-small",
                    content: [{ type: "text", text }], stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    return { server, calls };
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
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
}

test("#574 regression: oldest range's summary unusable → preflight moves to the next range and forwards (200)", async () => {
    // First summarization call (the oldest range) returns an unusable summary;
    // every later call is usable. Legacy stopped at the first bad range → 502.
    const { server: upstream, calls } = makeUpstream((idx) => idx > 1);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    // Window sits between the post-fold floor (un-foldable oldest range +
    // preserved-recent zone ≈ 10.2k for this 24-message history) and the raw
    // total (~26.6k), so folding the later usable ranges brings it under.
    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 15_000 } });
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "multi-range-regress-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(24) }),
        });
        assert.equal(r.status, 200, "the request succeeds even though the oldest range's summary is unusable");
        await r.text();

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.ok(summaryCalls.length >= 2, `preflight moved past the bad oldest range to a later one (got ${summaryCalls.length} summary call(s))`);
        assert.equal(calls.filter((c) => c.stream).length, 1, "the rebuilt, fitting payload was forwarded");

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(activeBlocks.length >= 1, `a later range was folded into a block (got ${activeBlocks.length})`);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("#574 truthful exhaustion: every range's summary unusable → honest 502 (full walk or provably-futile bail), no forward, no blocks", async () => {
    const { server: upstream, calls } = makeUpstream(() => false);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "multi-range-exhaust-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(16) }),
        });
        assert.equal(r.status, 502, "nothing compressible → fail-fast 502");
        const json = JSON.parse(await r.text()) as { error?: { code?: string; retryable?: boolean; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, false);
        // #1841: the verdict may now be the futility bail (provably cannot
        // close the gap → stop early with a quantified detail) instead of the
        // full walk-to-end exhaustion — both are honest, neither claims success.
        assert.match(json.error?.message ?? "", /(futile round|no range could be compressed)/i, `exhaustion names the multi-range attempt (got: ${json.error?.message})`);

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.ok(summaryCalls.length >= 2, `preflight moved past the bad oldest range before stopping (got ${summaryCalls.length}; legacy made exactly 1)`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded");

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.equal(activeBlocks.length, 0, "no blocks created when nothing could be compressed");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("#574 budget cap: many unusable ranges → exactly MAX_SUMMARY_CALLS_PER_PREFLIGHT summary calls, budget-exhausted detail", async () => {
    const { server: upstream, calls } = makeUpstream(() => false);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "multi-range-budget-sess" },
            // #1841 sizing: 192 messages = 48 ranges × ~5K tokens each. Every
            // failing range costs 2 summary calls (whole + minimum size), so the
            // 16-call cap fires during the 8th failed range — while the
            // mid-walk futility bail threshold only lands at the 10th. The cap
            // therefore stays the binding bound and keeps its dedicated pin;
            // smaller payloads now bail out as provably futile first.
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(192) }),
        });
        assert.equal(r.status, 502, "still over-window after the budget → fail-fast 502");
        const json = JSON.parse(await r.text()) as { error?: { code?: string; retryable?: boolean; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, false);
        assert.match(json.error?.message ?? "", /summarization budget/i, `the budget variant is reported (got: ${json.error?.message})`);
        assert.match(json.error?.message ?? "", /compressible range\(s\) still visible/, `reports how many compressible ranges remain (got: ${json.error?.message})`);

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.equal(summaryCalls.length, MAX_SUMMARY_CALLS_PER_PREFLIGHT, `the call cap bounds the walk (got ${summaryCalls.length})`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded");

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.equal(activeBlocks.length, 0, "no blocks created when nothing could be compressed");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
