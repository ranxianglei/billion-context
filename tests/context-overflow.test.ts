import test from "node:test";
import assert from "node:assert/strict";
import { inspectContextOverflow, provenCompletionReserve, reserveOutputHeadroom, shouldReserveOutputHeadroom } from "../src/util.ts";

// A context-overflow error is the only reliable signal that the configured
// window is wrong (e.g. the 200k fallback for an unknown model on a relay).
// The detector must recognize the common provider phrasings, learn the real
// window when present, and — critically — NOT false-positive on rate limits /
// Bedrock's "too many tokens" throttle (a 429 the client should back off on).

test("OpenAI: 'maximum context length is N tokens' → overflow + window", () => {
    const body = JSON.stringify({
        error: {
            message:
                "This model's maximum context length is 128000 tokens. However, you requested 132096 tokens (your request used 20 inputs and 4096 output tokens). Please reduce the length of the inputs or output.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
        },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 128000);
});

test("OpenAI Responses: 'exceeds the model's maximum context size of N' → overflow + window", () => {
    // The newer Responses-API phrasing (the chat-completions one above says
    // "maximum context LENGTH is") — must be detected too, or self-heal never
    // fires for /responses relays.
    const body = JSON.stringify({
        error: {
            message:
                "This request's total token count is 130000, which exceeds the model's maximum context size of 128000 tokens.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
        },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 128000);
});
test("sglang: 'input (N tokens) is longer than the model's context length (M tokens)' → overflow + window M", () => {
    // Captured verbatim from a real sglang server; both wire formats share the
    // message. The learned window must be the LIMIT (M), not the input size (N)
    // — learning N would self-heal to a window larger than the real one.
    const message = "The input (400013 tokens) is longer than the model's context length (262144 tokens).";
    const chatBody = JSON.stringify({ object: "error", message, type: "BadRequestError", param: null, code: 400 });
    const info = inspectContextOverflow(400, chatBody);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 262144);
    const responsesBody = JSON.stringify({ error: { message, type: "invalid_request_error", param: null, code: 400 } });
    const info2 = inspectContextOverflow(400, responsesBody);
    assert.equal(info2.isOverflow, true);
    assert.equal(info2.window, 262144);
});

test("llama.cpp: 'exceed_context_size_error (N / M > W)' → overflow + window W (#570)", () => {
    // Captured shape from a real llama-server rejection. The window must be W
    // (the limit AFTER '>'), not N or M — learning either of those would
    // self-heal to a window far above the real one.
    const body = JSON.stringify({
        error: { message: "exceed_context_size_error (198,277 / 198,661 > 150,528)", type: "invalid_request_error", code: 400 },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 150528);
});

test("Anthropic: 'prompt is too long: X tokens > Y maximum' → window is Y", () => {    const body = JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 128000); // the maximum, not the 130000 total
});

// #3450: when the body ALSO states the rejected payload's own counts, they are
// distinct from the ceiling — arming the shrink at the ceiling instead of the
// measurement is what turned a real deficit into "deficit 0". Each pattern is
// provider-specific; a wrong guess is worse than no guess.
test("DeepSeek/OpenAI: 'requested N tokens (M in the messages, K in the completion)' → all three counts (#3450)", () => {
    // Verbatim from incident #3450.
    const body = JSON.stringify({
        error: {
            code: "context_length_exceeded",
            message:
                "This model's maximum context length is 1048576 tokens. However, you requested 1160518 tokens (904518 in the messages, 256000 in the completion). Please reduce the length of the inputs or output.",
        },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 1048576); // the ceiling
    assert.equal(info.requestedTotal, 1160518);
    assert.equal(info.requestedMessages, 904518);
    assert.equal(info.requestedCompletion, 256000);
});

test("DeepSeek/OpenAI counts survive comma grouping (#3450)", () => {
    const body = JSON.stringify({
        error: {
            code: "context_length_exceeded",
            message: "you requested 1,160,518 tokens (904,518 in the messages, 256,000 in the completion).",
        },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.requestedTotal, 1160518);
    assert.equal(info.requestedMessages, 904518);
    assert.equal(info.requestedCompletion, 256000);
});

test("Anthropic 'prompt is too long' states the prompt count — no completion split (#3450)", () => {
    const body = JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.window, 128000);
    assert.equal(info.requestedTotal, 130000);
    assert.equal(info.requestedMessages, 130000); // input side only
    assert.equal(info.requestedCompletion, undefined);
});

test("Gemini 'input token count (N) exceeds' states the input count (#3450)", () => {
    const info = inspectContextOverflow(
        400,
        '{"error":{"message":"The input token count (1012345) exceeds the maximum number of tokens allowed (1048576)."}}',
    );
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 1048576);
    assert.equal(info.requestedTotal, 1012345);
    assert.equal(info.requestedMessages, 1012345);
    assert.equal(info.requestedCompletion, undefined);
});

test("overflow body WITHOUT stated counts → no requested* fields (#3450 regression guard)", () => {
    // The legacy phrasing must keep behaving exactly as before (selfheal T3
    // relies on it): window only, no invented counts.
    const body = JSON.stringify({
        error: {
            code: "context_length_exceeded",
            message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 13000 tokens.",
        },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 8192);
    assert.equal(info.requestedTotal, undefined);
    assert.equal(info.requestedMessages, undefined);
    assert.equal(info.requestedCompletion, undefined);
});

test("legacy OpenAI 'requested N tokens (your request used ...)' does NOT match the counts pattern (#3450)", () => {
    // The chat-completions phrasing splits inputs/output differently — it must
    // not be misread as a messages/completion pair.
    const body = JSON.stringify({
        error: {
            message:
                "This model's maximum context length is 128000 tokens. However, you requested 132096 tokens (your request used 20 inputs and 4096 output tokens). Please reduce the length of the inputs or output.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
        },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 128000);
    assert.equal(info.requestedTotal, undefined);
    assert.equal(info.requestedMessages, undefined);
    assert.equal(info.requestedCompletion, undefined);
});

test("context_length_exceeded code with comma-grouped window", () => {
    const body = JSON.stringify({ error: { code: "context_length_exceeded", message: "exceeds the limit of 1,048,576 tokens" } });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 1048576);
});

test("413 + 'maximum context length' is an overflow", () => {
    const info = inspectContextOverflow(413, "Request body too large: maximum context length is 65536 tokens");
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 65536);
});

test("overflow with no parseable window → isOverflow true, window undefined", () => {
    const info = inspectContextOverflow(400, '{"error":{"message":"context length exceeded"}}');
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, undefined);
});

test("Codex: context_window_exceeded code (no window number) → overflow, window undefined", () => {
    // Codex/ChatGPT relays reject an oversized context with this body — no
    // window number anywhere, so self-heal must fall back to the rejected
    // payload size (see the e2e in e2e-overflow-selfheal.test.ts).
    const body = JSON.stringify({
        error: {
            code: "context_window_exceeded",
            message: "The model's context window was exceeded. Start a new thread or clear earlier history before retrying.",
        },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, undefined);
});

test("Codex client phrasing 'ran out of room in the model's context window' → overflow", () => {
    const info = inspectContextOverflow(
        400,
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    );
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, undefined);
});

test("agnes/cch relay: 'context_limit' type + CJK message → overflow, window undefined (#3787)", () => {
    // Captured shape from a real agnes/cch relay rejection (dsh proxy mode,
    // bili 0.1.201). No window number anywhere in the body — self-heal must
    // arm at the rejected payload's own size; the session id must never be
    // mistaken for a token count.
    const body = JSON.stringify({
        type: "error",
        error: { type: "context_limit", message: "上下文长度超过模型限制，请减少对话历史或输入内容 (cch_session_id: sess_abc123)" },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, undefined);
});

test("CJK overflow phrasings in both word orders → overflow (#3787)", () => {
    assert.equal(inspectContextOverflow(400, '{"error":{"message":"上下文窗口超限，请精简对话历史"}}').isOverflow, true);
    assert.equal(inspectContextOverflow(400, '{"error":{"message":"输入 token 数超出最大上下文限制"}}').isOverflow, true);
});

test("CJK text mentioning 上下文 without an overflow verb is NOT an overflow", () => {
    assert.equal(inspectContextOverflow(400, '{"error":{"message":"无效的请求体：messages 字段格式错误（上下文历史解析失败）"}}').isOverflow, false);
});

test("auth error (400, no context marker) is NOT an overflow", () => {
    const info = inspectContextOverflow(400, '{"error":{"message":"Invalid API key","type":"authentication_error"}}');
    assert.equal(info.isOverflow, false);
});

test("Bedrock 'too many tokens' throttle (429) is NOT an overflow", () => {
    // Bedrock phrases its *throttle* as "Too many tokens, please wait before
    // trying again" — must not be treated as a context overflow.
    const info = inspectContextOverflow(429, '{"message":"Too many tokens, please wait before trying again."}');
    assert.equal(info.isOverflow, false);
});

test("plain 429 rate limit is NOT an overflow", () => {
    const info = inspectContextOverflow(429, '{"error":{"message":"Rate limit reached"}}');
    assert.equal(info.isOverflow, false);
});

test("2xx with a context-looking phrase is NOT an overflow (only 400/413)", () => {
    const info = inspectContextOverflow(200, '{"note":"maximum context length is 128000 tokens"}');
    assert.equal(info.isOverflow, false);
});

test("a 5xx carrying an overflow marker IS an overflow (gateway-relayed rejection, #2484)", () => {
    // Some gateways relay the model provider's overflow rejection under
    // 502/503 instead of 400 — the body marker is the real gate, so these count.
    assert.equal(inspectContextOverflow(502, '{"error":{"message":"exceeds the context window","type":"upstream_error"}}').isOverflow, true);
    assert.equal(inspectContextOverflow(500, "context length exceeded").isOverflow, true);
});

test("a bare 5xx without an overflow marker is NOT an overflow", () => {
    assert.equal(inspectContextOverflow(500, "Internal Server Error").isOverflow, false);
    assert.equal(inspectContextOverflow(503, '{"error":"upstream unavailable"}').isOverflow, false);
});

test("empty body is NOT an overflow", () => {
    assert.equal(inspectContextOverflow(400, "").isOverflow, false);
});

// reserveOutputHeadroom: the effective window handed to the kernel after
// reserving the model's per-request output budget. The kernel's nudge/truncate
// bands are a fraction of this window, so reserving maxOutput keeps the context
// below (window - maxOutput) — a context+output overflow can't happen.
test("reserveOutputHeadroom: reserves maxOutput when it leaves a usable window", () => {
    // 100k window, 8k requested output → effective 92k.
    assert.equal(reserveOutputHeadroom(100_000, 8_000), 92_000);
    // 100k window, 40k requested output → effective 60k.
    assert.equal(reserveOutputHeadroom(100_000, 40_000), 60_000);
});

test("reserveOutputHeadroom: no-op for non-positive / non-finite maxOutput", () => {
    assert.equal(reserveOutputHeadroom(100_000, 0), 100_000);
    assert.equal(reserveOutputHeadroom(100_000, -5), 100_000);
    assert.equal(reserveOutputHeadroom(100_000, Number.NaN), 100_000);
    assert.equal(reserveOutputHeadroom(100_000, Infinity), 100_000);
});

test("reserveOutputHeadroom: no-op when maxOutput >= window (degenerate request)", () => {
    // Output budget equal to the window → nothing left for context; don't
    // reserve (a <=0 window is invalid for the kernel) — self-heal handles it.
    assert.equal(reserveOutputHeadroom(100_000, 100_000), 100_000);
    assert.equal(reserveOutputHeadroom(100_000, 150_000), 100_000);
});

test("reserveOutputHeadroom: no-op for a non-positive / non-finite window", () => {
    assert.equal(reserveOutputHeadroom(0, 8_000), 0);
    assert.equal(reserveOutputHeadroom(-1, 8_000), -1);
    assert.equal(reserveOutputHeadroom(Number.NaN, 8_000), Number.NaN);
});

// #896: capPct caps the reservation at a fraction of the WINDOW —
// reserved = min(maxOutput, capPct × window) — aligned with billion-context-pi #207.
test("reserveOutputHeadroom: capPct caps the reservation at a fraction of the window (#896)", () => {
    // Cap binding: max_tokens 131072 on a 262144 window, cap 0.25 → reserved = min(131072, 65536).
    assert.equal(reserveOutputHeadroom(262_144, 131_072, 0.25), 196_608);
    // max_tokens binding: 32768 < 0.25 × 262144 → the full max_tokens is reserved.
    assert.equal(reserveOutputHeadroom(262_144, 32_768, 0.25), 229_376);
    assert.equal(reserveOutputHeadroom(100_000, 16_384, 0.25), 83_616);
    assert.equal(reserveOutputHeadroom(100_000, 8_000, 0.5), 92_000, "8000 < 0.5 × 100000 → full max_tokens reserved");
    assert.equal(reserveOutputHeadroom(100_000, 8_000, 1), 92_000);
    assert.equal(reserveOutputHeadroom(100_000, 8_000, 0), 100_000, "cap 0 disables the reservation");
});

test("reserveOutputHeadroom: out-of-range caps clamp, non-finite falls back to the legacy full reservation", () => {
    assert.equal(reserveOutputHeadroom(100_000, 8_000, 1.5), 92_000, ">= 1 clamps to the legacy full reservation");
    assert.equal(reserveOutputHeadroom(100_000, 8_000, -0.25), 100_000, "negative clamps to 0 (no reservation)");
    assert.equal(reserveOutputHeadroom(100_000, 8_000, Number.NaN), 92_000, "non-finite → legacy");
    assert.equal(reserveOutputHeadroom(100_000, 8_000, Infinity), 92_000, "non-finite → legacy");
});

test("reserveOutputHeadroom: degenerate maxOutput >= window stays a no-op even with a small cap", () => {
    assert.equal(reserveOutputHeadroom(100_000, 100_000, 0.25), 100_000);
    assert.equal(reserveOutputHeadroom(100_000, 150_000, 0.25), 100_000);
});

// #4205: every wire reserves by default. The anthropic family is exempt ONLY
// with positive separate-output-budget evidence (real-Claude routing —
// api.anthropic.com or a claude-* model id): the blanket protocol exemption
// was what let wrapper providers on that wire bill completion against the
// same window and 400 at the wall (#3900). Both directions pinned (#3617).
test("shouldReserveOutputHeadroom: reserve-by-default, real-Claude routing exempt (#4205)", () => {
    assert.equal(shouldReserveOutputHeadroom("openai"), true);
    assert.equal(shouldReserveOutputHeadroom("responses"), true);
    assert.equal(shouldReserveOutputHeadroom("google"), true);
    assert.equal(shouldReserveOutputHeadroom(undefined), true, "unknown protocol → conservative (reserve)");
    assert.equal(shouldReserveOutputHeadroom("anthropic"), true, "no route evidence → conservative (reserve)");
    assert.equal(shouldReserveOutputHeadroom("anthropic", "https://api.deepseek.com"), true, "wrapper origin → reserve");
    assert.equal(shouldReserveOutputHeadroom("anthropic", "https://api.anthropic.com", "claude-sonnet-4-5"), false, "canonical Anthropic host → exempt");
    assert.equal(shouldReserveOutputHeadroom("anthropic", "http://127.0.0.1:8787", "claude-test"), false, "claude-* model id → exempt (gateway front)");
    assert.equal(shouldReserveOutputHeadroom("anthropic", "http://127.0.0.1:8787", "DeepSeek-V3.2-Exp"), true, "#3900 shape: deepseek model on the anthropic wire → reserve");
    assert.equal(shouldReserveOutputHeadroom("anthropic", "https://api.anthropic.com.evil.example"), true, "host match is exact — no suffix tricks");
});

// #3450 follow-up: a stated completion share is a PROVIDER fact, so it outlives
// the one-shot arm — but only for the origin+model that stated it.
const PROVEN = { provenCompletionWall: 7_000, provenCompletionWallOrigin: "http://127.0.0.1:9", provenCompletionWallModel: "deepseek-flash" };

test("provenCompletionReserve: matching origin+model returns the proven share", () => {
    assert.equal(provenCompletionReserve(PROVEN, "http://127.0.0.1:9", "deepseek-flash"), 7_000);
});

test("provenCompletionReserve: no proof / incomplete proof → 0 (protocol rule unchanged)", () => {
    assert.equal(provenCompletionReserve(undefined, "http://127.0.0.1:9", "deepseek-flash"), 0);
    assert.equal(provenCompletionReserve({}, "http://127.0.0.1:9", "deepseek-flash"), 0);
    assert.equal(provenCompletionReserve({ provenCompletionWallOrigin: PROVEN.provenCompletionWallOrigin, provenCompletionWallModel: PROVEN.provenCompletionWallModel }, "http://127.0.0.1:9", "deepseek-flash"), 0);
});

test("provenCompletionReserve: a different origin or model cannot claim the proof", () => {
    assert.equal(provenCompletionReserve(PROVEN, "http://127.0.0.1:10", "deepseek-flash"), 0, "different upstream");
    assert.equal(provenCompletionReserve(PROVEN, "http://127.0.0.1:9", "deepseek-chat"), 0, "different model");
    assert.equal(provenCompletionReserve(PROVEN, undefined, "deepseek-flash"), 0, "unknown origin");
    assert.equal(provenCompletionReserve(PROVEN, "http://127.0.0.1:9", undefined), 0, "unknown model");
    assert.equal(provenCompletionReserve(PROVEN, "", "deepseek-flash"), 0, "empty origin");
    assert.equal(provenCompletionReserve(PROVEN, "http://127.0.0.1:9", ""), 0, "empty model");
});

test("provenCompletionReserve: corrupt walls are rejected outright", () => {
    for (const wall of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "7000"]) {
        assert.equal(provenCompletionReserve({ ...PROVEN, provenCompletionWall: wall as number }, "http://127.0.0.1:9", "deepseek-flash"), 0, `wall=${String(wall)}`);
    }
});
