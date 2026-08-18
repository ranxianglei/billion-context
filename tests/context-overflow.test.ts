import test from "node:test";
import assert from "node:assert/strict";
import { inspectContextOverflow } from "../src/util.ts";

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

test("Anthropic: 'prompt is too long: X tokens > Y maximum' → window is Y", () => {
    const body = JSON.stringify({
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
