// #4950: an HTTP-200 SSE stream can carry an EXPLICIT context overflow inside
// it (a response.failed / error frame with a context-window marker) that
// inspectContextOverflow's status gate never sees: it passed through untouched
// while recording NO evidence, so the #2313 estimate-only probe re-forwarded
// the same oversized body forever. This pins the fix contract:
//   1. every explicit structured in-stream overflow arms the emergency shrink
//      exactly like the HTTP overflow path (same shared arming function), on
//      every lane that observes the stream;
//   2. when NOTHING client-visible was delivered yet, the failure frame may be
//      swallowed and replaced by a folded re-send within the SAME request
//      (one-shot, sharing the single re-issue budget);
//   3. otherwise the frame passes through verbatim — armed evidence still
//      breaks the probe loop on the next round;
//   4. healthy completions, non-overflow errors, incomplete frames and
//      truncation NEVER arm (#570 mis-learning discipline).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { classifyStructuredOverflow, structuredErrorFields, normalizeUpstreamOrigin } from "../src/util.ts";
import { armSessionOverflow } from "../src/overflow-arm.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";
import type { Session } from "../src/session.ts";

_setStoreForTest(new SessionStore({ enabled: false }));
setRegistryForTest({});

type Chunk = string;
const sse = (event: string, data: unknown): Chunk => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function streamOf(events: Chunk[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const e of events) controller.enqueue(enc.encode(e));
            controller.close();
        },
    });
}

function makeRes(chunks: string[]): any {
    let ended = false;
    return {
        chunks,
        get destroyed() { return false; },
        get writableEnded() { return ended; },
        write(c: string | Uint8Array): boolean { chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8")); return true; },
        end(): void { ended = true; },
        once(): void {},
    };
}

function makeSession(): Session {
    return {
        id: "testsess",
        protocol: "openai",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        metadata: {},
        stats: {},
        dirty: false,
    } as unknown as Session;
}

// ── classifier ──────────────────────────────────────────────────────────────

test("classifier: explicit structured context-overflow frames are recognized across wire shapes", () => {
    const positives: Array<[string, Record<string, unknown>]> = [
        ["codex response.failed", { type: "response.failed", response: { id: "resp_1", status: "failed", error: { code: "context_window_exceeded", message: "Your input exceeds the context window of this model. Please adjust your input and try again." } } }],
        ["codex generic error frame", { type: "error", code: "context_length_exceeded", message: "Input exceeds context length" }],
        ["anthropic error envelope", { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 33000 tokens > 20000 maximum" } }],
        ["gemini numeric-code error", { error: { message: "The input token count (204800) exceeds the maximum number of tokens allowed (131072)." } }],
        ["cjk relay wording", { type: "error", error: { type: "context_limit", message: "上下文长度超过模型限制，请减少对话历史或输入内容" } }],
    ];
    for (const [name, ev] of positives) {
        const info = classifyStructuredOverflow(structuredErrorFields(ev));
        assert.equal(info.isOverflow, true, `${name} must classify as overflow`);
    }
    // the two numbered shapes must extract their evidence exactly
    const anthropic = classifyStructuredOverflow(structuredErrorFields(positives[2][1]));
    assert.equal(anthropic.window, 20000);
    assert.equal(anthropic.requestedMessages, 33000);
    const gemini = classifyStructuredOverflow(structuredErrorFields(positives[3][1]));
    assert.equal(gemini.window, 131072);
    assert.equal(gemini.requestedMessages, 204800);
});

test("classifier: non-overflow failures and non-error frames stay dark (#570 discipline)", () => {
    const negatives: Array<[string, Record<string, unknown> | null]> = [
        ["rate limit", { type: "error", error: { type: "rate_limit_exceeded", message: "Rate limit reached" } }],
        ["quota", { type: "error", error: { type: "insufficient_quota", message: "You exceeded your current quota" } }],
        ["generic server error", { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "An internal error has occurred" } } }],
        ["incomplete is not an overflow", { type: "response.incomplete", response: { status: "incomplete", reason: "max_output_tokens" } }],
    ];
    for (const [name, ev] of negatives) {
        const info = classifyStructuredOverflow(structuredErrorFields(ev!));
        assert.equal(info.isOverflow, false, `${name} must NOT arm`);
    }
});

// ── shared arming (unit) ────────────────────────────────────────────────────

test("arm: stated-window overflow books min(judging limit, measured payload) with the ceiling kept separate", () => {
    const session = makeSession();
    (session.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    armSessionOverflow(session, {
        isOverflow: true, window: 872_000, requestedTotal: 1_472_312, requestedMessages: 1_472_312,
        message: "Your input exceeds the context window of this model.",
    }, "http://127.0.0.1:9/v1/responses", JSON.stringify({ model: "gpt-6.1-sol", messages: [] }), () => {});
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm");
    // measured (1.47M) clamped to the judging limit (872K) — #3738
    assert.equal(session.stats.lastInputTokens, 872_000);
    // the stated ceiling stays recorded separately so a later usage sample can retire it (#1110)
    assert.equal(session.stats.overflowArmTokens, 872_000);
    assert.equal(session.stats.lastInputTokensOrigin, normalizeUpstreamOrigin("http://127.0.0.1:9/v1/responses"));
});

test("arm: reserved-judging-limit clamp wins over the effective window", () => {
    const session = makeSession();
    (session.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    (session.metadata as Record<string, unknown>)["reservedContextLimit"] = 744_000;
    armSessionOverflow(session, {
        isOverflow: true, window: 872_000, message: "exceeds the context window",
    }, "http://127.0.0.1:9/v1/responses", undefined, () => {});
    assert.equal(session.stats.lastInputTokens, 744_000);
    assert.equal(session.stats.overflowArmTokens, 872_000);
});

test("arm: numberless overflow arms at min(judging window, payload estimate)", () => {
    const session = makeSession();
    (session.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    armSessionOverflow(session, {
        isOverflow: true, message: "context length exceeded",
    }, "http://127.0.0.1:9/v1/responses", JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(4000) }] }), () => {});
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm");
    assert.ok((session.stats.lastInputTokens ?? 0) > 0 && (session.stats.lastInputTokens ?? 0) < 872_000, `estimate-bounded arm, got ${session.stats.lastInputTokens}`);
});

test("arm: non-overflow info leaves the session untouched", () => {
    const session = makeSession();
    armSessionOverflow(session, { isOverflow: false, message: "rate limit reached" }, "http://127.0.0.1:9/v1", undefined, () => {});
    assert.equal(session.stats.lastInputTokensSource, undefined);
});

// ── responses pipe ──────────────────────────────────────────────────────────

// The wire body the relay would pass as requestText — the arm's estimate needs it.
const PAYLOAD = JSON.stringify({ model: "gpt-6.1-sol", messages: [{ role: "user", content: "x".repeat(4000) }] });

const R_CREATED = sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } });
const R_FAILED = sse("response.failed", {
    type: "response.failed",
    response: { id: "resp_1", status: "failed", error: { code: "context_window_exceeded", message: "Your input exceeds the context window of this model." } },
});
const R_ERR_FRAME = sse("error", { type: "error", code: "context_length_exceeded", message: "Input exceeds context length" });

test("responses pipe: in-stream overflow without hook passes through verbatim and arms evidence", async () => {
    const session = makeSession();
    (session.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    const res = makeRes([]);
    await pipePluginResponsesWithStrip(streamOf([R_CREATED, R_FAILED]), res, session, undefined, undefined, "http://127.0.0.1:9/v1/responses", undefined, PAYLOAD);
    assert.equal(res.chunks.join(""), R_CREATED + R_FAILED, "frame must pass through byte-exact");
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm");
    assert.ok((session.stats.lastInputTokens ?? 0) > 0);
    assert.equal(session.stats.lastInputTokensOrigin, normalizeUpstreamOrigin("http://127.0.0.1:9/v1/responses"));
});

test("responses pipe: generic error-frame shape arms too", async () => {
    const session = makeSession();
    (session.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    const res = makeRes([]);
    await pipePluginResponsesWithStrip(streamOf([R_CREATED, R_ERR_FRAME]), res, session, undefined, undefined, "http://127.0.0.1:9/v1/responses", undefined, PAYLOAD);
    const out = res.chunks.join("");
    // Unlike response.failed, a bare error frame is NOT terminal on this wire:
    // the EOF behind it gets the pre-existing in-band truncation signal appended
    // (#721) — additive only, both frames stay byte-exact.
    assert.ok(out.startsWith(R_CREATED + R_ERR_FRAME), "both frames pass through verbatim");
    assert.ok(out.includes("upstream_stream_truncated"), "pre-existing EOF truncation signal still emitted");
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm");
});

test("responses pipe: zero-visible failed-first takes over with the folded re-send", async () => {
    const session = makeSession();
    (session.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    const replacement = streamOf([
        sse("response.created", { type: "response.created", response: { id: "resp_2", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "msg_r2", type: "message", role: "assistant", status: "in_progress", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: "msg_r2", output_index: 0, content_index: 0, part: { type: "output_text", text: "", status: "in_progress" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_r2", output_index: 0, content_index: 0, delta: "folded answer" }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: "msg_r2", output_index: 0, content_index: 0, text: "folded answer" }),
        sse("response.content_part.done", { type: "response.content_part.done", item_id: "msg_r2", output_index: 0, content_index: 0, part: { type: "output_text", text: "folded answer", status: "completed" } }),
        sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: "msg_r2", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "folded answer" }] } }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_2", status: "completed", output: [{ id: "msg_r2", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "folded answer" }] }] } }),
    ]);
    let hookCalls = 0;
    const hook = async (info: { isOverflow: boolean }): Promise<ReadableStream<Uint8Array> | null> => {
        hookCalls++;
        assert.equal(info.isOverflow, true);
        return replacement;
    };
    const res = makeRes([]);
    await pipePluginResponsesWithStrip(streamOf([R_CREATED, R_FAILED]), res, session, undefined, undefined, "http://127.0.0.1:9/v1/responses", undefined, PAYLOAD, undefined, undefined, hook);
    const out = res.chunks.join("");
    assert.equal(hookCalls, 1, "hook fires exactly once per stream");
    assert.ok(!out.includes("context_window_exceeded"), "the swallowed failure must not reach the client");
    assert.ok(out.includes("folded answer"), "the folded re-send's content reaches the client");
    assert.ok(out.includes("response.completed"), "terminal success delivered");
    assert.equal((out.match(/^event: response\.created$/gm) ?? []).length, 1, "attempt-1 created already delivered; replacement framing absorbed under it");
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm");
});

test("responses pipe: visible output already delivered → no takeover, verbatim passthrough, still armed", async () => {
    const session = makeSession();
    (session.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    const events = [
        R_CREATED,
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", status: "in_progress" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "partial" }),
        R_FAILED,
    ];
    const hook = async (): Promise<ReadableStream<Uint8Array> | null> => streamOf([]);
    const res = makeRes([]);
    await pipePluginResponsesWithStrip(streamOf(events), res, session, undefined, undefined, "http://127.0.0.1:9/v1/responses", undefined, PAYLOAD, undefined, undefined, hook);
    const out = res.chunks.join("");
    assert.ok(!out.includes("context_window_exceeded") === false, "failure frame passes through verbatim");
    assert.ok(out.includes("partial"), "already-delivered deltas intact");
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm");
});

test("responses pipe: healthy completion, non-overflow failure and EOF cut never arm", async () => {
    const healthy = [
        R_CREATED,
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "msg_h", type: "message", role: "assistant", status: "in_progress", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: "msg_h", output_index: 0, content_index: 0, part: { type: "output_text", text: "", status: "in_progress" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_h", output_index: 0, content_index: 0, delta: "ok" }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: "msg_h", output_index: 0, content_index: 0, text: "ok" }),
        sse("response.content_part.done", { type: "response.content_part.done", item_id: "msg_h", output_index: 0, content_index: 0, part: { type: "output_text", text: "ok", status: "completed" } }),
        sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: "msg_h", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] } }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_h", status: "completed", output: [] } }),
    ];
    let hookCalls = 0;
    const hook = async (): Promise<ReadableStream<Uint8Array> | null> => { hookCalls++; return streamOf([]); };

    const s1 = makeSession();
    (s1.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    await pipePluginResponsesWithStrip(streamOf(healthy), makeRes([]), s1, undefined, undefined, "http://127.0.0.1:9/v1/responses", undefined, PAYLOAD, undefined, undefined, hook);
    assert.equal(s1.stats.lastInputTokensSource, undefined, "healthy completion must not arm");

    const s2 = makeSession();
    (s2.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    const nonOverflowFailed = sse("response.failed", { type: "response.failed", response: { id: "resp_n", status: "failed", error: { code: "server_error", message: "An internal error has occurred" } } });
    await pipePluginResponsesWithStrip(streamOf([R_CREATED, nonOverflowFailed]), makeRes([]), s2, undefined, undefined, "http://127.0.0.1:9/v1/responses", undefined, PAYLOAD, undefined, undefined, hook);
    assert.equal(s2.stats.lastInputTokensSource, undefined, "non-overflow failure must not arm");

    const s3 = makeSession();
    (s3.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    // mid-stream EOF cut: no terminal, no error frame — truncation territory (#570)
    await pipePluginResponsesWithStrip(streamOf([R_CREATED, sse("response.output_text.delta", { type: "response.output_text.delta", delta: "x" })]), makeRes([]), s3, undefined, undefined, "http://127.0.0.1:9/v1/responses", undefined, PAYLOAD, undefined, undefined, hook);
    assert.equal(s3.stats.lastInputTokensSource, undefined, "truncation must not arm");
    assert.equal(hookCalls, 0, "hook never fires on negatives");
});

// ── chat pipes ──────────────────────────────────────────────────────────────

test("chat pipe (anthropic): visible block already delivered → no takeover, verbatim, armed", async () => {
    const session = makeSession();
    (session.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    const events = [
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
        sse("error", { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 33000 tokens > 20000 maximum" } }),
    ];
    let hookCalls = 0;
    const hook = async (): Promise<ReadableStream<Uint8Array> | null> => { hookCalls++; return streamOf([]); };
    const res = makeRes([]);
    await pipePluginChatWithStrip(streamOf(events), res, "anthropic", session, undefined, undefined, "http://127.0.0.1:9/v1/messages", undefined, PAYLOAD, undefined, undefined, hook);
    const out = res.chunks.join("");
    assert.equal(hookCalls, 0, "visible output already delivered — no takeover");
    assert.ok(out.includes("prompt is too long"), "error frame passes through verbatim");
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm");
    assert.equal(session.stats.overflowArmTokens, 20000);
});

test("chat pipe (openai): zero-visible error-first takes over with the folded re-send", async () => {
    const session = makeSession();
    (session.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    const errChunk = `data: ${JSON.stringify({ error: { message: "prompt is too long: 33000 tokens > 20000 maximum", type: "invalid_request_error" } })}\n\n`;
    const turn = proseTurn("real answer after fold");
    let hookCalls = 0;
    const hook = async (): Promise<ReadableStream<Uint8Array> | null> => { hookCalls++; return streamOf(turn); };
    const res = makeRes([]);
    await pipePluginChatWithStrip(streamOf([errChunk]), res, "openai", session, undefined, undefined, "http://127.0.0.1:9/v1/chat/completions", undefined, PAYLOAD, undefined, undefined, hook);
    const out = res.chunks.join("");
    assert.equal(hookCalls, 1);
    assert.ok(!out.includes("prompt is too long"), "swallowed failure must not reach the client");
    assert.ok(out.includes("real answer after fold"));
    assert.equal((out.match(/\[DONE\]/g) ?? []).length, 1, "one terminal marker total");
    assert.equal((out.match(/finish_reason/g) ?? []).length, 1, "one finish reason total");
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm");
});

test("chat pipe: healthy turn and non-overflow error never arm", async () => {
    let hookCalls = 0;
    const hook = async (): Promise<ReadableStream<Uint8Array> | null> => { hookCalls++; return streamOf([]); };

    const s1 = makeSession();
    (s1.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    await pipePluginChatWithStrip(streamOf(proseTurn("fine")), makeRes([]), "openai", s1, undefined, undefined, "http://127.0.0.1:9/v1/chat/completions", undefined, PAYLOAD, undefined, undefined, hook);
    assert.equal(s1.stats.lastInputTokensSource, undefined, "healthy turn must not arm");

    const s2 = makeSession();
    (s2.metadata as Record<string, unknown>)["effectiveContextLimit"] = 872_000;
    const rateErr = `data: ${JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit" } })}\n\n`;
    const res = makeRes([]);
    await pipePluginChatWithStrip(streamOf([rateErr]), res, "openai", s2, undefined, undefined, "http://127.0.0.1:9/v1/chat/completions", undefined, PAYLOAD, undefined, undefined, hook);
    assert.equal(s2.stats.lastInputTokensSource, undefined, "non-overflow error must not arm");
    assert.ok(res.chunks.join("").includes("Rate limit reached"), "passes through verbatim");
    assert.equal(hookCalls, 0);
});

function proseTurn(text: string): Chunk[] {
    return [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
    ];
}

// ── preflight integration: the #2313 probe loop actually breaks ─────────────

const WINDOW = 20_000;
// Same marker + payload profile as the #2313 harness: detected on the RAW body
// (string-content scanning misses how the prompt rides the wire) and long
// enough to clear minSummaryLength.
const SUMMARY_MARKER = /TASK: The conversation segment below/;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held deterministic load-growth payloads across turns; every marker derives from the turn index, so folding loses nothing.";

interface CallRec { url: string; body: string; summary: boolean; status: number; contentChars: number }

async function setup(): Promise<{ proxyPort: number; upstreamPort: number; calls: CallRec[]; close: () => Promise<void> }> {
    const calls: CallRec[] = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
            const body = Buffer.concat(chunks).toString("utf8");
            let parsed: { messages?: Array<{ content?: unknown }> } = {};
            try { parsed = JSON.parse(body); } catch { /* keep empty */ }
            // #2313 harness rule: detect the summary prompt on the RAW body
            // (string-content scanning misses how the prompt rides the wire).
            const isSummaryCall = SUMMARY_MARKER.test(body);
            const status = isSummaryCall ? 200 : body.length > 100_000 ? 200 : 200;
            calls.push({ url: req.url ?? "/", body, summary: isSummaryCall, status, contentChars: body.length });
            if (isSummaryCall) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                return;
            }
            if (body.length > 100_000) {
                // #4950 repro: HTTP 200 stream carrying an EXPLICIT in-band context overflow
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(`data: ${JSON.stringify({ error: { message: "prompt is too long: 33000 tokens > 20000 maximum", type: "invalid_request_error" } })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: 2, total_tokens: Math.ceil(body.length / 4) + 2 } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    await once(upstream.listen(0, "127.0.0.1"), "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxyOptions: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        streamErrorShape: "protocol",
        promptCache: { routing: "auto" },
        log: false, debug: false, passthrough: false,
        autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const server = await startServer(proxyOptions);
    // Some option shapes defer the listen past startServer's return; the
    // control harness (issue2313) awaits "listening" unconditionally — do the
    // same only when needed so a pre-bound server can't double-await.
    if (server.address() === null) await once(server, "listening");
    const proxyPort = (server.address() as { port: number }).port;
    return {
        proxyPort, upstreamPort, calls,
        close: async () => {
            server.closeAllConnections?.();
            await new Promise<void>((r) => server.close(() => r()));
            upstream.close();
        },
    };
}

function bigMessages(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 30; i++) {
        // ~115K chars total: must stay ABOVE the mock's 100K overflow-branch
        // threshold or the repro silently degrades to a healthy small turn.
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}: ${"lorem ipsum dolor sit amet ".repeat(600).trim()}` });
    }
    return msgs;
}

async function seedStuckMeter(ctx: Awaited<ReturnType<typeof setup>>, id: string): Promise<void> {
    const url = `http://127.0.0.1:${ctx.proxyPort}/bili/http://127.0.0.1:${ctx.upstreamPort}/chat/completions`;
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": id }, body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] }) });
    await r.text();
    const s = getSession(id);
    if (!s) throw new Error("seed turn did not register a session");
    s.stats.lastInputTokens = 7_300_000;
    s.stats.lastInputTokensSource = "estimate";
    s.stats.lastInputTokensOrigin = "http://127.0.0.1:1";
}

test("#4950 e2e: an in-band overflow forward records evidence, so the next round compresses instead of re-probing", async (t) => {
    let ctx: Awaited<ReturnType<typeof setup>> | undefined;
    t.after(async () => { if (ctx) await ctx.close(); });
    ctx = await setup();
    const url = `http://127.0.0.1:${ctx.proxyPort}/bili/http://127.0.0.1:${ctx.upstreamPort}/chat/completions`;
    const post = (messages: Array<{ role: string; content: string }>) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "i4950-a" }, body: JSON.stringify({ model: "gpt-test", stream: true, messages }) });

    await seedStuckMeter(ctx, "i4950-a");
    const raw = bigMessages();
    const rawJson = JSON.stringify({ model: "gpt-test", stream: true, messages: raw });

    // Round 1: estimate-only baseline → probe forwards the oversized body ONCE.
    // The upstream answers 200 + in-band overflow. That evidence MUST be armed.
    const r1 = await post(raw);
    const b1 = await r1.text();
    assert.equal(r1.status, 200, `round-1 body: ${b1.slice(0, 600)}`);
    assert.ok(b1.includes("prompt is too long"), `the in-band error reaches the client; got: ${b1.slice(0, 600)}`);
    const s = getSession("i4950-a");
    assert.ok(s, "session registered");
    assert.equal(s!.stats.lastInputTokensSource, "overflow-arm", "the failed forward must record overflow evidence");
    assert.equal(s!.stats.lastInputTokensOrigin, normalizeUpstreamOrigin(`http://127.0.0.1:${ctx.upstreamPort}/chat/completions`), "evidence bound to the current route");
    assert.ok((s!.stats.lastInputTokens ?? 1e18) < 100_000, `armed baseline back under the window scale, got ${s!.stats.lastInputTokens}`);

    // Round 2: same oversized request. On master this re-probes the RAW body
    // forever (zero summary calls ever). With the armed evidence the preflight
    // FOLDS instead — this assertion is the regression pin.
    const forwardsBefore = ctx.calls.filter((c) => !c.summary).length;
    const r2 = await post(raw);
    const b2 = await r2.text();
    assert.equal(r2.status, 200, `round-2 body: ${b2.slice(0, 600)}`);
    assert.ok(ctx.calls.some((c) => c.summary), "round 2 must run the compression pipeline (summary call) instead of re-probing raw");
    const lastForward = ctx.calls.filter((c) => !c.summary).at(-1)!;
    assert.ok(lastForward.contentChars < rawJson.length, `folded body (${lastForward.contentChars}) smaller than raw (${rawJson.length})`);
    assert.ok(forwardsBefore >= 1, "round 1 did forward the raw body");
    assert.equal(s!.stats.lastInputTokensSource, "usage", "the successful folded forward settles usage and retires the arm (#1110)");
    void b2;
});
