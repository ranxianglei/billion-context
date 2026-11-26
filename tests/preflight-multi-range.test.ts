import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
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

// Per-test tag salts the content: the three tests below use the SAME
// generator with different lengths (24/16/48), so without a salt each
// longer history byte-prefix-matches the shorter ones and — once #1834
// made identified resume-forks adopt the parent's blocks — the later test's
// session legitimately resume-inherits the earlier test's blocks.
function conversation(n: number, tag: string): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `${tag} Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

type Call = { stream: boolean; body: string };

// Mock Anthropic upstream. Main requests are stream:true (answered with SSE);
// preflight summarization calls are stream:false (answered with a JSON message
// whose text is SUMMARY_TEXT when usable(idx) else empty — the proxy treats an
// empty/too-short summary as unusable and skips that range). The unusable
// shape is stop_reason=max_tokens ON PURPOSE: #2832 reclassified normal-stop
// zero-text completions (end_turn + empty) into the DETERMINISTIC class whose
// dead-probe verdict stops the walk after three strikes — this file must keep
// pinning the walk/budget mechanics themselves, so its failures stay on the
// size-driven halving path the "2 calls per failed range" arithmetic below
// describes.
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
                    content: [{ type: "text", text }], stop_reason: "max_tokens",
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
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
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
    const upstreamPort = (upstream.address() as { port: number }).port;

    // Window sits between the post-fold floor (un-foldable oldest range +
    // preserved-recent zone ≈ 10.2k for this 24-message history) and the raw
    // total (~26.6k), so folding the later usable ranges brings it under.
    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 15_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "multi-range-regress-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(24, "t1-regress") }),
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
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("#574 truthful exhaustion: every range's summary unusable → payload forwarded, bounded walk (#7537)", async () => {
    const { server: upstream, calls } = makeUpstream(() => false);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "multi-range-exhaust-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(16, "t2-exhaust") }),
        });
        // #7537: the payload is ALWAYS forwarded; the upstream 200 is the verdict.
        assert.equal(r.status, 200, "payload is forwarded, upstream 200 is the verdict");
        await r.text();

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.ok(summaryCalls.length >= 1, `preflight made summary calls (got ${summaryCalls.length})`);
        assert.equal(calls.filter((c) => c.stream).length, 1, "the payload was forwarded");

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.equal(activeBlocks.length, 0, "no blocks created when nothing could be compressed");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("#574 budget cap: many unusable ranges → payload forwarded, bounded walk (#7537)", async () => {
    const { server: upstream, calls } = makeUpstream(() => false);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 230_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "multi-range-budget-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(200, "t3-budget") }),
        });
        // #7537: the payload is ALWAYS forwarded; the upstream 200 is the verdict.
        assert.equal(r.status, 200, "payload is forwarded, upstream 200 is the verdict");
        await r.text();

        // #1933/#574: the BASE cap bounds the walk (overshoot < 1.06x keeps the
        // raise off; the raised variant is pinned in preflight-round-budget).
        // summarizeRange may spend an in-call fallback HTTP beyond one per
        // counted summary call, so pin the range, not an exact count.
        const summaryCalls = calls.filter((c) => !c.stream);
        assert.ok(summaryCalls.length >= MAX_SUMMARY_CALLS_PER_PREFLIGHT && summaryCalls.length <= MAX_SUMMARY_CALLS_PER_PREFLIGHT + 2,
            `the base call cap bounds the walk (got ${summaryCalls.length})`);
        assert.equal(calls.filter((c) => c.stream).length, 1, "the payload was forwarded");

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.equal(activeBlocks.length, 0, "no blocks created when nothing could be compressed");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
