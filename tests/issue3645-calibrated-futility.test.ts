import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { normalizeUpstreamOrigin } from "../src/util.ts";

// #4185: an identified fresh session whose preflight ends in deterministic
// exhaustion now forwards once for upstream arbitration instead of failing
// fast locally. This control asserts the LOCAL futility-skip contract, so it
// carries a settled usage baseline to keep testing the evidence-driven path.
function seedEvidence(upstreamPort: number, sessionId: string): void {
    const s = getSession(sessionId);
    s.stats.lastInputTokens = 100;
    s.stats.lastInputTokensSource = "usage";
    s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${upstreamPort}`);
}

// #3645: the raw-range futility gate compared an UNCALIBRATED foldable mass against
// a CALIBRATED payload deficit. Once a matching-origin k̂>1 is set (#1933 F1), the
// deficit is inflated ×k while kernel range.tokens stay on the raw scale, so a fold
// that would fit the window was declared futile and skipped → non-retryable 502
// (incident: k̂=2.13, raw pool 163K vs calibrated deficit 313K → skip, then 502).
// The gate must compare like with like: calibrate the fold mass onto the deficit's
// scale before judging. Identity for k̂=1 / absent / mismatched-origin (#1841 byte-stable).
//
// All token math is ASCII filler → ceil(len/4), matching the host estimator.
// Sizing (WINDOW=30K, slack 1.2, k̂=2): bash pairs are hard-protected (never
// foldable) and set the calibrated deficit D = 2·payload − 30K strictly between
// pool×1.2 (old raw gate → futile, the bug) and pool×2×1.2 (new calibrated gate →
// viable), while the protected bulk keeps the post-fold payload under the window so
// the recovered walk forwards.

const WINDOW = 30_000;
const K = 2; // seeded calibration factor — deliberately >1 to expose the unit mismatch
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: this segment is a load-growth fixture whose every marker is derivable from its turn index.";

type Call = { summary: boolean; raw: string };
type MockWire = "openai" | "responses";
let CALLS: Call[] = [];
let summaryResponder: (raw: string) => { content: string; finishReason: string };

function chatSse(text: string, finishReason: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, finishReason) + "data: [DONE]\n\n";
}

function responsesSse(text: string): string {
    const responseId = "resp_issue3645";
    const itemId = "msg_issue3645";
    const event = (type: string, payload: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const output = { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    return [
        event("response.created", { response: { id: responseId, object: "response", status: "in_progress", output: [] } }),
        event("response.output_item.added", { output_index: 0, item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] } }),
        event("response.content_part.added", { item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
        event("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: text }),
        event("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text }),
        event("response.output_item.done", { output_index: 0, item: output }),
        event("response.completed", { response: { id: responseId, object: "response", status: "completed", output: [output] } }),
    ].join("");
}

function mockUpstream(wire: MockWire = "openai"): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            CALLS.push({ summary: isSummary, raw });
            if (!isSummary) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(wire === "responses" ? responsesSse("forwarded answer") : chatSse("forwarded answer", "stop"));
                return;
            }
            const r = summaryResponder(raw);
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(wire === "responses" ? responsesSse(r.content) : chatSse(r.content, r.finishReason));
        });
    });
}

function proxyOptions(upstreamPort: number, recentTokens: number, extraKernel: Record<string, unknown> = {}): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } } as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: recentTokens,
            protectedTools: ["bash"],
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
            ...extraKernel,
        }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
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

async function boot(recentTokens = 2000, extraKernel: Record<string, unknown> = {}, wire: MockWire = "openai"): Promise<{ proxyPort: number; upstreamPort: number; cleanup: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = mockUpstream(wire);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort, recentTokens, extraKernel));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        cleanup: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
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

function responsesPlain(role: "user" | "assistant", text: string): Record<string, unknown> {
    return { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] };
}

function responsesBashPair(id: number, resultRepeat: number): Record<string, unknown>[] {
    return [
        { type: "function_call", call_id: `call_${id}`, name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
        { type: "function_call_output", call_id: `call_${id}`, output: `BASH_RESULT_${id}_payload_`.repeat(resultRepeat) },
    ];
}

function postResponses(p: { proxyPort: number; upstreamPort: number }, session: string, input: Record<string, unknown>[], plugin = true): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": session };
    if (plugin) {
        headers["x-bili-plugin"] = "dsh";
        headers["x-bili-plugin-conversation"] = session;
    }
    return fetch(`http://127.0.0.1:${p.proxyPort}/bili/http://127.0.0.1:${p.upstreamPort}/v1/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-test", stream: true, input }),
    });
}

// Stamp a matching-origin calibration factor onto a fresh session (the incident had
// known usage evidence + persisted k̂). Pre-creating the session lets us set stats
// before the over-window request reaches preflight. No baseline is seeded: a
// named (non-anonymous) session is baseline-known from its first request (#1841).
function seedCalibratedSession(sessionId: string, upstreamPort: number): void {
    const s = getSession(sessionId);
    s.stats.calibratedEstimate = K;
    s.stats.calibratedEstimateOrigin = `http://127.0.0.1:${upstreamPort}`; // == currentOrigin → ×K applies
}

test("#3645: matching-origin k̂>1 no longer skips a raw fold that fits the window", async () => {
    CALLS = [];
    summaryResponder = () => ({ content: SUMMARY_TEXT, finishReason: "stop" });
    const p = await boot(9_000);
    try {
        // Plain-text only (tool turns couple into the protected-zone carve and shrink the
        // exposed pool). OLD block = foldable pool P; RECENT block = last 2 runs, protected
        // by preserveRecentTokens=9000, and kept under the calibrated half-window (K·floor<30K)
        // so folding genuinely closes the gap.
        const oldA = "OLD_A ".repeat(3334);
        const oldB = "OLD_B ".repeat(3334);
        const oldC = "OLD_C ".repeat(3334);
        const oldD = "OLD_D ".repeat(3334);
        const recA = "REC_A ".repeat(3000);
        const recB = "REC_B ".repeat(3000);
        const poolTok = defaultCountTokens(oldA) + defaultCountTokens(oldB) + defaultCountTokens(oldC) + defaultCountTokens(oldD);
        const floorTok = defaultCountTokens(recA) + defaultCountTokens(recB);
        assert.ok(poolTok > 15_000, `foldable pool must be large (got ${poolTok})`);
        assert.ok(floorTok < WINDOW / K - 1_000, `recent floor must stay under the calibrated half-window (got ${floorTok})`);
        assert.ok(K * (poolTok + floorTok) > WINDOW, `fixture must overflow on the calibrated scale (raw ${poolTok + floorTok} × ${K})`);

        const sessionId = "issue3645-calibrated";
        seedCalibratedSession(sessionId, p.upstreamPort);

        const messages: Record<string, unknown>[] = [
            plain("user", oldA),
            plain("assistant", oldB),
            plain("user", oldC),
            plain("assistant", oldD),
            plain("user", recA),
            plain("assistant", recB),
        ];
        const resp = await post(p, sessionId, messages);
        const body = await resp.text();
        // The distinguishing signal: the walk PROCEEDS instead of skipping as futile.
        const summaries = CALLS.filter((c) => c.summary).length;
        assert.ok(summaries >= 1, `walk proceeded — ${summaries} summary call(s); the buggy raw gate made ZERO (futility skip)`);
        assert.ok(!/futile round/.test(body), `must not declare a viable fold futile (got: ${body.slice(0, 240)})`);
        assert.equal(resp.status, 200, `the recovered fold closes the gap and forwards: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
    } finally {
        await p.cleanup();
    }
});

// #3645 symptom 2: the post-fold fail-fast message must quote the SAME scale as the fit
// decision. Fixture: k̂=2 with a summary HEAVIER than any single foldable span, so once
// the walk has folded everything reachable the payload is STILL over the window on the
// calibrated scale while its RAW mass stayed under it (tiers disabled → exhaustion is
// the terminal verdict). The old code quoted the raw size there: a sub-window number
// claiming to "exceed" the window. Head bash pairs are hard-protected (never foldable)
// and pin the terminal RAW mass; the contiguous plain runs merge into one range each
// (measured kernel behavior), so the terminal state is bulk + two heavy summaries.
const SUMMARY_HEAVY = "SUMMARY_PAYLOAD ".repeat(1750); // ~7000 tokens

test("#3645 display: fail-fast quotes the calibrated post-fold size, not the raw one", async () => {
    CALLS = [];
    summaryResponder = () => ({ content: SUMMARY_HEAVY, finishReason: "stop" });
    const p = await boot(8_000, { tiers: { enabled: false }, compress: { minCompressRange: 1000, maxSummaryLength: 30_000, minSummaryLength: 50 } });
    try {
        const oldText = (tag: string) => `${tag} `.repeat(1667); // ~2501 tokens
        const recText = (tag: string) => `${tag} `.repeat(2334); // ~3501 tokens
        const spanTok = defaultCountTokens(oldText("OLD_A"));
        const recTok = defaultCountTokens(recText("REC_A"));
        const sumTok = defaultCountTokens(SUMMARY_HEAVY);
        const bulkTok = 2 * defaultCountTokens(`BASH_RESULT_1_payload_`.repeat(175)) + 40;
        const poolTok = 4 * spanTok;
        const floorTok = 2 * recTok;
        assert.ok(spanTok >= 2_000 && spanTok <= 3_000, `span sizing drifted (${spanTok})`);
        assert.ok(sumTok > spanTok, `summary must outgrow a single span so folds cannot close the gap (${sumTok} vs ${spanTok})`);
        assert.ok(K * (bulkTok + poolTok + floorTok) > WINDOW, `fixture must overflow on the calibrated scale`);
        assert.ok(bulkTok + 2 * sumTok < WINDOW, `terminal RAW mass (protected bulk + two heavy summaries) must stay sub-window`);
        assert.ok(K * (bulkTok + 2 * sumTok) > WINDOW, `terminal calibrated mass must stay over the window`);

        const sessionId = "issue3645-display";
        seedCalibratedSession(sessionId, p.upstreamPort);

        const messages: Record<string, unknown>[] = [
            ...bashPair(1, 175),
            ...bashPair(2, 175),
            plain("user", oldText("OLD_A")),
            plain("assistant", oldText("OLD_B")),
            plain("user", oldText("OLD_C")),
            plain("assistant", oldText("OLD_D")),
            plain("user", recText("REC_A")),
            plain("assistant", recText("REC_B")),
        ];
        const resp = await post(p, sessionId, messages);
        const body = await resp.text();
        let json: { error?: { code?: string; message?: string } };
        try { json = JSON.parse(body); } catch { assert.fail(`expected a JSON fail-fast error, got HTTP ${resp.status}: ${body.slice(0, 240)}`); return; }
        const summaries = CALLS.filter((c) => c.summary).length;
        assert.ok(summaries >= 1, `folds actually landed before exhaustion — ${summaries} summary call(s)`);
        assert.equal(resp.status, 413, `deterministic exhaustion must fail fast non-retryably: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.equal(json.error?.code, "preflight_compress_failed");
        const m = /context ~(\d+) tokens/.exec(json.error?.message ?? "");
        assert.ok(m, `fail-fast must quote a context figure (got: ${json.error?.message})`);
        assert.ok(Number(m[1]) > WINDOW, `quoted figure must be on the calibrated (over-window) scale like the fit decision — got ~${m?.[1]} vs window ${WINDOW}; quoting the raw sub-window size is the #3645 display bug`);
    } finally {
        await p.cleanup();
    }
});

test("#3645 Responses dsh plugin lane: calibrated fail-fast does not forward the folded payload", async () => {
    CALLS = [];
    summaryResponder = () => ({ content: SUMMARY_HEAVY, finishReason: "stop" });
    const p = await boot(8_000, { tiers: { enabled: false }, compress: { minCompressRange: 1000, maxSummaryLength: 30_000, minSummaryLength: 50 } }, "responses");
    try {
        const oldText = (tag: string) => `${tag} `.repeat(1667);
        const recText = (tag: string) => `${tag} `.repeat(2334);
        const spanTok = defaultCountTokens(oldText("OLD_A"));
        const recTok = defaultCountTokens(recText("REC_A"));
        const sumTok = defaultCountTokens(SUMMARY_HEAVY);
        const bulkTok = 2 * defaultCountTokens(`BASH_RESULT_1_payload_`.repeat(175)) + 40;
        const poolTok = 4 * spanTok;
        const floorTok = 2 * recTok;
        assert.ok(spanTok >= 2_000 && spanTok <= 3_000, `span sizing drifted (${spanTok})`);
        assert.ok(sumTok > spanTok, `summary must outgrow a single span so folds cannot close the gap (${sumTok} vs ${spanTok})`);
        assert.ok(K * (bulkTok + poolTok + floorTok) > WINDOW, "fixture must overflow on the calibrated scale");
        assert.ok(bulkTok + 2 * sumTok < WINDOW, "terminal raw Responses payload must stay sub-window");
        assert.ok(K * (bulkTok + 2 * sumTok) > WINDOW, "terminal calibrated Responses payload must stay over-window");

        const sessionId = "issue3645-responses-dsh";
        seedCalibratedSession(sessionId, p.upstreamPort);
        const input: Record<string, unknown>[] = [
            ...responsesBashPair(1, 175),
            ...responsesBashPair(2, 175),
            responsesPlain("user", oldText("OLD_A")),
            responsesPlain("assistant", oldText("OLD_B")),
            responsesPlain("user", oldText("OLD_C")),
            responsesPlain("assistant", oldText("OLD_D")),
            responsesPlain("user", recText("REC_A")),
            responsesPlain("assistant", recText("REC_B")),
        ];
        const resp = await postResponses(p, sessionId, input, true);
        const body = await resp.text();
        let json: { error?: { code?: string; message?: string } };
        try { json = JSON.parse(body); } catch { assert.fail(`expected a JSON fail-fast error, got HTTP ${resp.status}: ${body.slice(0, 240)}`); return; }
        const summaries = CALLS.filter((c) => c.summary).length;
        const forwarded = CALLS.filter((c) => !c.summary).length;
        assert.ok(summaries >= 1, `Responses plugin lane must perform summary folding (got ${summaries} summary call(s))`);
        assert.equal(forwarded, 0, `the over-window Responses payload must not be forwarded (got ${forwarded} main call(s))`);
        assert.equal(resp.status, 413, `deterministic calibrated exhaustion must fail fast: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.equal(json.error?.code, "preflight_compress_failed");
        const m = /context ~(\d+) tokens/.exec(json.error?.message ?? "");
        assert.ok(m, `fail-fast must quote a context figure (got: ${json.error?.message})`);
        assert.ok(Number(m[1]) > WINDOW, `quoted Responses figure must be calibrated and over-window (got ~${m?.[1]} vs ${WINDOW})`);
    } finally {
        await p.cleanup();
    }
});

test("#3645 control: uncalibrated (k̂ absent) futility skip is unchanged (#1841)", async () => {
    CALLS = [];
    summaryResponder = () => ({ content: SUMMARY_TEXT, finishReason: "stop" });
    const p = await boot();
    try {
        // Same shape, NO calibration seeded (identity path). Pool tiny vs a huge
        // protected bulk → genuinely futile on the raw scale → the skip must remain.
        const REPEAT = 3157;
        const poolTok = 4 * 440;
        const estTok = 2 * Math.round((REPEAT * 22 + 45) / 4) + poolTok;
        assert.ok(estTok > WINDOW && estTok - WINDOW > poolTok * 1.2, `fixture must be raw-futile (${estTok} vs ${WINDOW}, pool ${poolTok})`);

        // No calibration seeded → identity path (k̂ absent), matching #1841 A exactly.
        const sessionId = "issue3645-control";

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
        seedEvidence(p.upstreamPort, sessionId);
        const resp = await post(p, sessionId, messages);
        const body = await resp.text();
        assert.equal(resp.status, 413, `a raw-futile round must still fail fast non-retryably: HTTP ${resp.status} ${body.slice(0, 240)}`);
        const json = JSON.parse(body) as { error?: { code?: string; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.match(json.error?.message ?? "", /futile round/, `still names the futility verdict (got: ${json.error?.message})`);
        assert.equal(CALLS.filter((c) => c.summary).length, 0, "the uncalibrated skip must spend ZERO summarization calls");
    } finally {
        await p.cleanup();
    }
});
