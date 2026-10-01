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

// #1841: when the cumulative mass of ALL foldable content cannot close the gap
// between the payload and the preflight target, the old behavior walked every
// range anyway — burning summarization calls minutes at a time (incident
// 08cc0df7: ~9 calls over 5 min, net −5.5%) — then failed with a generic
// exhaustion message. The futility gate must:
//   A. skip the whole round with ZERO summary calls when the pool is provably
//      insufficient (checking the relaxed soft-zone view before declaring doom,
//      so the #330 recovery path is never regressed);
//   B. bail mid-walk once consumed/skipped ranges leave less potential than the
//      remaining deficit, so untried ranges are never summarized.
// All token math here is ASCII filler → chars/4, matching the host estimator.
// Sizing (WINDOW=30K, slack 1.2): bash pairs are hard-protected (never
// foldable) and set the required reduction D = payload − 30K strictly between
// (pool-after-failures)×1.2 and (full pool)×1.2.

const WINDOW = 30_000;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: this segment is a load-growth fixture whose every marker is derivable from its turn index.";

type Call = { summary: boolean; raw: string };
let CALLS: Call[] = [];
let summaryResponder: (raw: string) => { content: string; finishReason: string };

function chatSse(text: string, finishReason: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, finishReason) + "data: [DONE]\n\n";
}

function mockUpstream(): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            CALLS.push({ summary: isSummary, raw });
            if (!isSummary) {
                if (raw.includes('"stream":true')) {
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.end(chatSse("forwarded answer", "stop"));
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-fwd", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "forwarded answer" }, finish_reason: "stop" }] }));
                }
                return;
            }
            // finish_reason=length with no text → diagnoseEmptySummary carries
            // "finish_reason=length" → size-driven → NON-transient (no retries).
            const r = summaryResponder(raw);
            if (raw.includes('"stream":true')) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse(r.content, r.finishReason));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: r.content }, finish_reason: r.finishReason }] }));
            }
        });
    });
}

function proxyOptions(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } } as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            protectedTools: ["bash"],
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

function plain(role: string, text: string): Record<string, unknown> {
    return { role, content: text };
}

function bashPair(id: number, resultRepeat: number): Record<string, unknown>[] {
    return [
        { role: "assistant", content: null, tool_calls: [{ id: `call_${id}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] },
        { role: "tool", tool_call_id: `call_${id}`, content: `BASH_RESULT_${id}_payload_`.repeat(resultRepeat) },
    ];
}

async function boot(): Promise<{ proxyPort: number; upstreamPort: number; cleanup: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = mockUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        cleanup: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

function post(p: { proxyPort: number; upstreamPort: number }, session: string, messages: Record<string, unknown>[]): Promise<Response> {
    return fetch(`http://127.0.0.1:${p.proxyPort}/bili/http://127.0.0.1:${p.upstreamPort}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
    });
}

// Each bash pair carries 22*repeat chars of tool result (+~45 chars of call).
function bulkTokens(repeat: number, pairs: number): number {
    return Math.round((pairs * (22 * repeat + 45)) / 4);
}

test("#1841 A: a payload whose foldable pool cannot close the gap skips the round with zero summary calls", async () => {
    CALLS = [];
    summaryResponder = () => ({ content: SUMMARY_TEXT, finishReason: "stop" });
    const p = await boot();
    try {
        // Pool = four plain runs of 440 tok each (1760 total). Bulk =
        // 2 x 3157 repeats ≈ 34.7K tok → payload ≈ 36.5K, D ≈ 6.5K ≫ 1760×1.2.
        const REPEAT = 3157;
        const poolTok = 4 * 440;
        const est = bulkTokens(REPEAT, 2) + poolTok;
        assert.ok(est > WINDOW && est - WINDOW > poolTok * 1.2, `fixture must be futile (${est} vs ${WINDOW}, pool ${poolTok})`);
        const messages: Record<string, unknown>[] = [
            plain("user", "OLD_WORK_A ".repeat(160)),
            plain("assistant", "ANSWER_A ".repeat(160)),
            ...bashPair(1, REPEAT),
            ...bashPair(2, REPEAT),
            plain("user", "OLD_WORK_B ".repeat(160)),
            plain("assistant", "ANSWER_B ".repeat(160)),
            plain("user", "ok"),
            plain("assistant", "done"),
        ];
        const resp = await post(p, "issue1841-futility-skip", messages);
        const body = await resp.text();
        assert.equal(resp.status, 502, `a futile round must fail fast: HTTP ${resp.status} ${body.slice(0, 240)}`);
        const json = JSON.parse(body) as { error?: { code?: string; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.match(json.error?.message ?? "", /futile round/, `names the futility verdict (got: ${json.error?.message})`);
        assert.match(json.error?.message ?? "", /maximum possible saving/, `quotes the pool bound (got: ${json.error?.message})`);
        assert.equal(CALLS.filter((c) => c.summary).length, 0, "a skipped round must spend ZERO summarization calls");
        assert.equal(CALLS.length, 0, "the over-window payload must not be forwarded either");
    } finally {
        await p.cleanup();
    }
});

test("#1841 A control: a payload whose pool CAN close the gap still walks and folds", async () => {
    CALLS = [];
    summaryResponder = () => ({ content: SUMMARY_TEXT, finishReason: "stop" });
    const p = await boot();
    try {
        // Pool = four plain runs of 4400 tok each (17.6K total) → 17.6K×1.2
        // comfortably covers D ≈ 11K. Bulk = 2 x 2127 repeats ≈ 23.4K tok.
        const REPEAT = 2127;
        const poolTok = 4 * 4400;
        const est = bulkTokens(REPEAT, 2) + poolTok;
        assert.ok(est > WINDOW && est - WINDOW < poolTok * 1.2, `fixture must be viable (${est} vs ${WINDOW}, pool ${poolTok})`);
        const messages: Record<string, unknown>[] = [
            plain("user", "OLD_WORK_A ".repeat(1600)),
            plain("assistant", "ANSWER_A ".repeat(1600)),
            ...bashPair(1, REPEAT),
            ...bashPair(2, REPEAT),
            plain("user", "OLD_WORK_B ".repeat(1600)),
            plain("assistant", "ANSWER_B ".repeat(1600)),
            plain("user", "ok"),
            plain("assistant", "done"),
        ];
        const resp = await post(p, "issue1841-futility-control", messages);
        const body = await resp.text();
        assert.equal(resp.status, 200, `a viable round must fold and forward: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.ok(CALLS.filter((c) => c.summary).length >= 1, "the walk must have summarized at least one range");
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
    } finally {
        await p.cleanup();
    }
});

test("#1841 B: mid-walk bail stops before summarizing ranges that cannot change the outcome", async () => {
    CALLS = [];
    summaryResponder = () => ({ content: "", finishReason: "length" });
    const p = await boot();
    try {
        // Sized against the calibrated host estimator (~3.636 ASCII chars/tok,
        // measured): the pool OUTSIDE the recent zone (R1+R2 ≈ 9K tok) cannot
        // close D ≈ 17.5K, but the relaxed-pool bound can — so round 1 takes
        // the up-front relax path (#330 preserved), round 2 draws the doomed
        // early range (it fails below meaningful size and is skipped), and the
        // mid-walk bail must stop the rest: after that draw, the remaining
        // potential (~6.6K × 1.2) still cannot close the gap. Without the
        // gate the walk keeps drawing every later range (5+ calls) before a
        // generic exhaustion message; with it, at most the doomed early range
        // is spent and the verdict names futility. (Per-range content
        // attribution is not asserted: the kernel may normalize ranges across
        // hard-protected islands via BLOCKED boundary refs, #1001.)
        const r1 = "MARKER_R1_OLD ".repeat(833);
        const r2 = "MARKER_R2_MID ".repeat(1750);
        const r3 = "MARKER_R3_LATE ".repeat(1750);
        const REPEAT = 2520;
        const est = bulkTokens(REPEAT, 2) + Math.round((r1.length + r2.length + r3.length) / 4);
        assert.ok(est > WINDOW, `fixture must overflow the window (${est} vs ${WINDOW})`);
        const messages: Record<string, unknown>[] = [
            plain("user", r1),
            plain("assistant", "ack-one"),
            ...bashPair(1, REPEAT),
            plain("user", r2),
            plain("assistant", "ack-two"),
            ...bashPair(2, REPEAT),
            plain("user", r3),
            plain("user", "ok"),
            plain("assistant", "done"),
        ];
        const resp = await post(p, "issue1841-futility-midbail", messages);
        const body = await resp.text();
        assert.equal(resp.status, 502, `a bailed walk must fail fast: HTTP ${resp.status} ${body.slice(0, 240)}`);
        const json = JSON.parse(body) as { error?: { code?: string; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.match(json.error?.message ?? "", /futile round/, `names the futility verdict (got: ${json.error?.message})`);
        const summaries = CALLS.filter((c) => c.summary);
        assert.ok(summaries.length >= 1, "the oldest doomed range must have been genuinely tried first");
        assert.ok(summaries.length <= 3, `only the doomed early range(s) may be drawn before the bail, got ${summaries.length} call(s) — the gate must stop the walk`);
        assert.equal(CALLS.filter((c) => !c.summary).length, 0, "the over-window payload must not be forwarded either");
    } finally {
        await p.cleanup();
    }
});
