// #3918: a preflight that EXHAUSTS its summarization budget after committing
// real folds was reported terminal (502 retryable=false) even though the folds
// persist in the session and the NEXT attempt starts from a smaller baseline —
// the incident's 64 effective folds each got a "doomed" verdict. Non-
// deterministic exhaustion WITH progress must now be retryable=true with a
// progress note; zero-progress exhaustion keeps today's terminal verdict
// (pinned here AND in tests/preflight-multi-range.test.ts), and deterministic
// exhaustion keeps its 413 path (tests/issue3461-overlimit-exits.test.ts).
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

function conversation(n: number, tag: string): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `${tag} Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

type Call = { stream: boolean; body: string };

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

function startProxy(upstreamPort: number, contextWindow: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: contextWindow } } } },
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

test("#3918: budget exhaustion WITH committed folds → 502 retryable=true + progress note (not terminal)", async () => {
    // First two summarization draws are usable (two real folds land), every
    // later draw is unusable: the walk burns the rest of the budget on failed
    // ranges while the payload stays over-window — the incident's shape.
    // Window 100K vs ~230K raw payload: even generous two-fold savings leave
    // it well over-window, and the deficit stays below the remaining foldable
    // pool so the #1841 futility bail never pre-empts the budget.
    const { server: upstream, calls } = makeUpstream((idx) => idx <= 2);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, 100_000);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue3918-progress-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(200, "t3918-prog") }),
        });
        assert.equal(r.status, 502, "still over-window after the budget → fail-fast 502");
        const json = JSON.parse(await r.text()) as { error?: { code?: string; retryable?: boolean; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, true, `progress persists → the next attempt continues, so the verdict must be retryable (got: ${json.error?.retryable})`);
        assert.match(json.error?.message ?? "", /summarization budget/i, `the budget variant is reported (got: ${json.error?.message})`);
        assert.match(json.error?.message ?? "", /smaller baseline/i, `the progress note says the next attempt continues (got: ${json.error?.message})`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded");

        const s = listSessions().find((x) => x.id === "issue3918-progress-sess") ?? listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(activeBlocks.length >= 1, `the committed folds persist in the session (got ${activeBlocks.length} active block(s))`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("#3918 negative direction: budget exhaustion with ZERO progress stays terminal (retryable=false, no progress note)", async () => {
    // Every draw unusable → nothing folds → today's terminal verdict stands.
    // Window 230K reuses the proven sizing of
    // tests/preflight-multi-range.test.ts (deficit far below the foldable
    // pool, so the budget — not the futility bail — is the binding bound).
    const { server: upstream, calls } = makeUpstream(() => false);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, 230_000);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue3918-noprogress-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(200, "t3918-none") }),
        });
        assert.equal(r.status, 502, "nothing folded → fail-fast 502");
        const json = JSON.parse(await r.text()) as { error?: { code?: string; retryable?: boolean; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, false, `zero progress → retries are genuinely doomed (got: ${json.error?.retryable})`);
        assert.match(json.error?.message ?? "", /summarization budget/i, `the budget variant is reported (got: ${json.error?.message})`);
        assert.doesNotMatch(json.error?.message ?? "", /smaller baseline/, `no progress note when nothing was folded (got: ${json.error?.message})`);
        assert.ok(calls.filter((c) => !c.stream).length >= 2, `the walk ran before giving up (got ${calls.filter((c) => !c.stream).length} summary call(s))`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded");

        const s = listSessions().find((x) => x.id === "issue3918-noprogress-sess") ?? listSessions()[0];
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
