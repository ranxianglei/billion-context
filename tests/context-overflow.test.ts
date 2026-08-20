import test from "node:test";
import assert from "node:assert/strict";
import { inspectContextOverflow, reserveOutputHeadroom, shouldReserveOutputHeadroom } from "../src/util.ts";

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

test("Anthropic: 'prompt is too long: X tokens > Y maximum' → window is Y", () => {    const body = JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" },
    });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 128000); // the maximum, not the 130000 total
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

test("5xx is NOT an overflow (server error, not context)", () => {
    const info = inspectContextOverflow(500, "context length exceeded");
    assert.equal(info.isOverflow, false);
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

// Protocol gate: Anthropic's Messages API enforces the input limit
// independently of max_tokens (separate output budget), so reserving there
// would shift every nudge/truncate band down by maxOutput for no safety gain.
// OpenAI-family APIs count output against the window — reserve there.
test("shouldReserveOutputHeadroom: anthropic exempt, other protocols reserve", () => {
    assert.equal(shouldReserveOutputHeadroom("anthropic"), false, "Anthropic: output budget is separate from the context window");
    assert.equal(shouldReserveOutputHeadroom("openai"), true);
    assert.equal(shouldReserveOutputHeadroom("responses"), true);
    assert.equal(shouldReserveOutputHeadroom(undefined), true, "unknown protocol → conservative (reserve)");
});
