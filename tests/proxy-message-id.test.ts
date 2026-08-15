import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore } from "acp-kernel/wire";
import { openaiToCore } from "acp-kernel/wire";
import { responsesToCore } from "acp-kernel/wire";
import type { AnthropicMessage, AnthropicRequestBody } from "acp-kernel/wire";
import type { OpenAIRequestBody } from "acp-kernel/wire";
import type { ResponsesRequestBody } from "acp-kernel/wire";

// --- Anthropic ---

function anthropicBody(...messages: AnthropicMessage[]): AnthropicRequestBody {
    return { model: "claude", max_tokens: 100, messages };
}

test("fingerprint ids are stable: identical content across two conversions yields the same id", () => {
    const body = anthropicBody(
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "do something" },
    );
    const a = anthropicToCore(body).msgs;
    const b = anthropicToCore(body).msgs;
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].id, b[i].id, `id stable across conversions at index ${i}`);
        assert.ok(a[i].id.startsWith("h_"), "fingerprint prefix");
    }
});

test("fingerprint ids survive client reordering (reordering keeps ids bound to content, not position)", () => {
    // A realistic case: another plugin summarized away a middle message, and
    // the client reorders the rest. With raw-${idx} the ids would shift and
    // downstream compression effectiveMessageIds would point at the wrong
    // messages. With content fingerprints each message keeps its own id.
    const bodyA = anthropicBody(
        { role: "user", content: "alpha" },
        { role: "assistant", content: "beta" },
        { role: "user", content: "gamma" },
        { role: "assistant", content: "delta" },
        { role: "user", content: "epsilon" },
    );
    // Drop "beta" and "delta", reorder epsilon before gamma.
    const bodyB = anthropicBody(
        { role: "user", content: "alpha" },
        { role: "user", content: "epsilon" },
        { role: "user", content: "gamma" },
    );
    const idsA = new Map(anthropicToCore(bodyA).msgs.map((m) => [m.text, m.id]));
    const msgsB = anthropicToCore(bodyB).msgs;
    for (const m of msgsB) {
        assert.equal(m.id, idsA.get(m.text), `id for "${m.text}" follows the content, not the position`);
    }
});

test("duplicate messages get distinct cluster ids (not collapsed onto one id)", () => {
    // Two identical "ok" turns must not share an id — otherwise a compression
    // `covered` set keyed on that id would swallow BOTH (losing recent content).
    const body = anthropicBody(
        { role: "user", content: "ok" },
        { role: "user", content: "do work" },
        { role: "user", content: "ok" },
    );
    const msgs = anthropicToCore(body).msgs;
    const ids = msgs.filter((m) => m.text === "ok").map((m) => m.id);
    assert.equal(ids.length, 2, "both ok messages present");
    assert.notEqual(ids[0], ids[1], "duplicates get distinct cluster suffixes");
    // The first is the bare hash, the second is the hash with _1.
    assert.ok(!/_\d+$/.test(ids[0]), "first occurrence has no cluster suffix");
    assert.ok(/_1$/.test(ids[1]), "second occurrence gets _1 suffix");
});

// --- OpenAI Chat ---

test("openaiToCore: fingerprint ids distinct from mNNNNN and stable", () => {
    const body: OpenAIRequestBody = {
        model: "gpt",
        messages: [
            { role: "user", content: "ping" },
            { role: "assistant", content: "pong" },
        ],
    };
    const ids = openaiToCore(body).msgs.map((m) => m.id);
    for (const id of ids) {
        assert.ok(id.startsWith("h_"), `id ${id} has h_ prefix`);
        assert.ok(!/^m\d+$/.test(id), "does not collide with kernel mNNNNN");
    }
    // Stable across conversions.
    const ids2 = openaiToCore(body).msgs.map((m) => m.id);
    assert.deepEqual(ids, ids2, "stable across conversions");
});

// --- Responses ---

test("responsesToCore: fingerprint ids stable + duplicates distinct", () => {
    const body: ResponsesRequestBody = {
        model: "gpt",
        input: [
            { type: "message", role: "user", content: "hello" },
            { type: "message", role: "user", content: "hello" },
            { type: "message", role: "assistant", content: "world" },
        ],
    };
    const msgs = responsesToCore(body).msgs;
    assert.equal(msgs.length, 3);
    const helloIds = msgs.filter((m) => m.text === "hello").map((m) => m.id);
    assert.notEqual(helloIds[0], helloIds[1], "duplicate hellos distinct");
    assert.ok(helloIds[0].startsWith("h_"));
    assert.ok(helloIds[1].endsWith("_1"));
    // Stable.
    const ids2 = responsesToCore(body).msgs.map((m) => m.id);
    assert.deepEqual(msgs.map((m) => m.id), ids2);
});

test("responsesToCore: tool call + result ids bind to call_id, not position", () => {
    // Same function name/args in two distinct calls must differ via call_id.
    const body: ResponsesRequestBody = {
        model: "gpt",
        input: [
            { type: "message", role: "user", content: "run it twice" },
            { type: "function_call", name: "exec", call_id: "c1", arguments: "{}" },
            { type: "function_call_output", call_id: "c1", output: "done1" },
            { type: "function_call", name: "exec", call_id: "c2", arguments: "{}" },
            { type: "function_call_output", call_id: "c2", output: "done2" },
        ],
    };
    const msgs = responsesToCore(body).msgs;
    const callIds = msgs.filter((m) => m.contentType === "tool-call").map((m) => m.id);
    assert.equal(callIds.length, 2);
    assert.notEqual(callIds[0], callIds[1], "two same-name same-args calls differ via call_id");
    const resultIds = msgs.filter((m) => m.contentType === "tool-result").map((m) => m.id);
    assert.notEqual(resultIds[0], resultIds[1], "two results differ via call_id");
});
