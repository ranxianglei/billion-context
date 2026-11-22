import assert from "node:assert/strict";
import test from "node:test";
import { withoutDshClientExtensions } from "../src/server/handle.ts";

// #7168/#7439: DSH (deepseek-harness) rides top-level `dsh_*` client extensions
// on every request — `dsh_session_log` (the 8 MiB lossless session-log upload for
// the official DeepSeek API; the model never reads it) plus the sibling
// `dsh_plugin_packages`. During the transition bili intercepts them so the 8 MiB
// is not forwarded upstream. `withoutDshClientExtensions` does the strip; these
// tests pin its contract: ONLY top-level `dsh_*` keys are dropped, everything
// else (the model conversation) is preserved verbatim.

test("strips every top-level dsh_* key and keeps the model conversation intact", () => {
    const body = {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        dsh_session_log: { events: "x".repeat(8_000_000) },
        dsh_plugin_packages: { deps: { a: "1" } },
        dsh_custom_extension: { n: 1 },
    };
    const out = withoutDshClientExtensions(body) as Record<string, unknown>;
    assert.equal("dsh_session_log" in out, false, "dsh_session_log stripped");
    assert.equal("dsh_plugin_packages" in out, false, "dsh_plugin_packages stripped");
    assert.equal("dsh_custom_extension" in out, false, "an unknown dsh_* is stripped too");
    assert.deepEqual(out.messages, body.messages, "messages preserved");
    assert.equal(out.model, "deepseek-chat", "model preserved");
    assert.equal(out.stream, true, "stream preserved");
    assert.notEqual(out, body, "a new object is returned when something is dropped");
});

test("returns the SAME reference when there are no top-level dsh_* keys (fast path)", () => {
    const body = { model: "m", messages: [] };
    assert.equal(withoutDshClientExtensions(body), body);
});

test("leaves NESTED dsh_* inside the conversation untouched (top-level only)", () => {
    const nested = { dsh_note: "keep me", text: "x" };
    const body = {
        messages: [{ role: "user", content: nested }],
        dsh_session_log: { events: [] },
    };
    const out = withoutDshClientExtensions(body) as Record<string, unknown>;
    assert.equal("dsh_session_log" in out, false, "top-level dsh_session_log stripped");
    assert.equal((out.messages as Array<Record<string, unknown>>)[0].content, nested, "nested dsh_* survives");
});

test("passes non-object roots through unchanged (same reference)", () => {
    for (const v of [null, undefined, 42, "str", ["a", "b"]]) {
        assert.equal(withoutDshClientExtensions(v), v, `root ${String(v)} unchanged`);
    }
});

test("an array root is never treated as a top-level object to strip", () => {
    const arr = ["dsh_session_log", { model: "m" }];
    assert.equal(withoutDshClientExtensions(arr), arr, "array roots are returned as-is");
});
