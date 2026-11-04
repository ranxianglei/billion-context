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

// #5671: field evidence (dsh persona sub-session, v0.1.212): payload ~7.3x the
// window — BELOW #2383's entry trigger (EMERGENCY_FOLD_COVERAGE = 19.2x) — with
// a fragmented foldable pool (1312 viable ranges, largest ~18K tok vs a ~590K
// chunk budget). The LLM path burned its full raised budget (32 folds) removing
// <10% of the deficit, then fail-fast 413 retryable=false killed an already
// unrecoverable session. The static coverage bound prices an IDEAL fold; this
// pins the adaptive trigger that prices the pool ACTUALLY in front of the
// walker: when even the summaryBudget largest ranges cannot close the gap by
// more than ADAPTIVE_EMERGENCY_SLACK, the remainder of the invocation switches
// to deterministic digests mid-flight. Both directions are asserted (#3617):
// fragmented mid-overshoot MUST switch; consolidated mid-overshoot MUST NOT.

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. " +
    "Key decisions: chose the preflight approach over lossy truncation because the payload must stay coherent. " +
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

function conversation(count: number, charsPerMessage: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    const filler = "The quick brown fox jumps over the lazy dog. ";
    for (let i = 0; i < count; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const head = `Message ${i} of the long forked conversation. MARKER_${i}_content_`;
        const tail = `TAIL_${i}_end`;
        const core = (head + " " + filler.repeat(Math.ceil(charsPerMessage / filler.length))).slice(0, charsPerMessage - tail.length - 1);
        msgs.push({ role, content: `${core} ${tail}` });
    }
    return msgs;
}

test("e2e: fragmented mid-overshoot switches to digests mid-flight; consolidated mid-overshoot keeps the LLM path", async () => {
    const calls: Array<{ stream: boolean; body: string }> = [];
    const upstream = http.createServer((req, res) => {
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
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary",
                    type: "message",
                    role: "assistant",
                    model: "claude-small",
                    content: [{ type: "text", text: SUMMARY_TEXT }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    try {
        // --- Scenario C: fragmented pool at ~8x the window ---
        // 400 messages x 8k chars ~= 800k estimated tokens (~8x the 100k
        // window): below the 19.2x entry trigger, so the invocation STARTS on
        // the LLM path. The kernel segments ~4 messages per range (turn-aligned
        // groups), so the pool is ~100 ranges of ~8k tok each: the 32 largest
        // hold ~256k tok vs a ~702k-tok deficit (>1.5x short even after
        // re-folds), while the WHOLE pool clears the #1841 aggregate gate. The
        // adaptive trigger must flip the remainder of the invocation to digests
        // BEFORE any summarization call is dispatched. (Window sized like the
        // field incident — 983k window vs 1312 ranges — so the ~207-tok-per-
        // range digest overhead leaves headroom to converge under the window.)
        const markC = calls.length;
        const rC = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "frag-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(400, 8_000) }),
        });
        const bodyC = await rC.text();
        assert.equal(rC.status, 200, `the fragmented mid-overshoot request succeeds instead of failing fast; body: ${bodyC.slice(0, 500)}`);

        const callsC = calls.slice(markC);
        assert.equal(callsC.filter((c) => !c.stream).length, 0, "#5671 regression: NO summarization calls once the achievable bound proves the LLM path doomed");
        assert.equal(callsC.filter((c) => c.stream).length, 1, "exactly one forward");

        const sC = listSessions().find((x) => x.id === "frag-sess");
        const blocksC = (sC?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(blocksC.length >= 1, `adaptive switch created compression block(s) (got ${blocksC.length})`);
        assert.ok(blocksC.every((b) => b.summary.startsWith("[deterministic digest")),
            `all active blocks hold deterministic digests (got: ${blocksC[0]?.summary?.slice(0, 80)})`);
        const forwardC = callsC[callsC.length - 1];
        assert.ok(forwardC.body.includes("[deterministic digest"), "the digest summaries ride the rebuilt payload");
        assert.ok(!forwardC.body.includes("TAIL_5_"), "mid-history message content is folded out of the payload");

        // --- Scenario D: same fragmentation, smaller pool — LLM path intact ---
        // 112 messages x 8k chars ~= 224k estimated tokens (~2.24x the window):
        // identical per-message shape to C, so the kernel still yields ~28
        // ranges of ~8k tok — but 28 <= the 32-fold budget, so the top-N mass
        // IS the whole pool and can clear the ~126k-tok deficit many times over
        // the slack. The adaptive bound must NOT fire, and the LLM walk must
        // converge within its 32-round / 32-call budgets.
        const markD = calls.length;
        const rD = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "cons-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(112, 8_000) }),
        });
        const bodyD = await rD.text();
        assert.equal(rD.status, 200, `the consolidated mid-overshoot request succeeds on the LLM path; body: ${bodyD.slice(0, 500)}`);

        const callsD = calls.slice(markD);
        const summaryCallsD = callsD.filter((c) => !c.stream);
        assert.ok(summaryCallsD.length >= 1, `#5671 negative direction: the LLM path still summarizes when its budget CAN close the gap (got ${summaryCallsD.length})`);
        const sD = listSessions().find((x) => x.id === "cons-sess");
        const blocksD = (sD?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(blocksD.length >= 1, "LLM path created compression block(s)");
        assert.ok(blocksD.every((b) => b.summary === SUMMARY_TEXT), "blocks hold the upstream-written summaries");
        assert.ok(!callsD.some((c) => c.body.includes("[deterministic digest")), "no digest artifacts when the achievable bound passes");
    } finally {
        proxy.close();
        upstream.close();
    }
});
