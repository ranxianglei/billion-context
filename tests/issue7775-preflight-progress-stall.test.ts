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

// #7775 problem 2: a session 2.4x over the post-headroom window ran the full
// 32-round preflight marathon saving only ~13.7K/round against a ~730K gap —
// a fold that cannot converge, and the user waited ~2.5 minutes for the
// refusal. The progress-stall check fails fast when the average net saving
// over the last few rounds cannot close the gap in the remaining rounds.
//
// This is the POSITIVE direction of the gate (#3617: both directions must be
// asserted). The existing preflight-round-budget and issue3918 suites cover
// the NEGATIVE direction (their per-round progress rates sit above the 3%
// threshold, so the stall check must NOT fire there — and it does not).
//
// Fixture shape (adapted from tests/issue3918-preflight-progress-verdict.test.ts):
// a large window (200k) and a payload ~2.8x over it, split into many small
// messages (~1.1k tokens each) so each fold removes only a small range
// (~4-5k tokens) — a per-round progress rate of ~2%, under the 3% gate. Every
// summary draw is usable, so folds land every round and the net-saving history
// fills. The projected saving over the remaining rounds is a small fraction of
// the ~370k deficit, so the check must fire within the first couple of rounds
// instead of running the full 32-round budget.

const WINDOW = 200_000;
const COUNT = 500;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. " +
    "Key decisions: chose the multi-range walk over lossy truncation because the payload must stay coherent. " +
    "Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

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
                res.end(
                    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000 } } })}\n\n` +
                    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
                    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
                    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
                );
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
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

test("#7775: a fold that cannot close the gap fails fast on progress stall, not the full round budget", async () => {
    // Every summary draw is usable, so a fold lands every round. Each fold
    // removes a small range (~4-5k tokens) replaced by a ~50-token summary, so
    // the per-round net saving is ~2% of the 200k window — under the 3% gate.
    // The projected saving over the remaining rounds is a small fraction of the
    // ~370k deficit, so the stall check must fire within the first couple of
    // rounds instead of running the full 32-round budget.
    const { server: upstream, calls } = makeUpstream(() => true);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, WINDOW);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue7775-stall-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(COUNT, "t7775-stall") }),
        });
        assert.equal(r.status, 502, `a non-converging fold must be refused: HTTP ${r.status}`);
        const json = JSON.parse(await r.text()) as { error?: { code?: string; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.match(json.error?.message ?? "", /progress stall/i, `the verdict must name the progress stall, not the round budget (got: ${json.error?.message})`);
        assert.match(json.error?.message ?? "", /cannot close/i, `the verdict must state the gap cannot be closed (got: ${json.error?.message})`);
        // The whole point of the gate: fail within a couple of rounds, not the
        // full 32-round budget. A marathon would have issued one summary call
        // per round; a fail-fast issues only a handful.
        const summaries = calls.filter((c) => !c.stream);
        assert.ok(summaries.length <= 6, `the stall check must fail fast, got ${summaries.length} summary call(s) (a full marathon would issue ~32)`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
