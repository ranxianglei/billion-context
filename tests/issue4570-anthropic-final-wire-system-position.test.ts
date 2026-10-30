import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createAnthropicAdapter } from "../src/loop/index.ts";
import { VALIDATORS } from "./wire-contract-fakes.ts";

// #4570 / WC-023: the compress-loop adapter appends system notes AFTER
// coreToAnthropic's position heal. A trailing client system (legal on its
// own) then sits before a user note — Anthropic 400s "role 'system' must
// precede an 'assistant' message or end the array". The re-request body must
// obey both halves of the rule on the array actually sent.

const BODY = { model: "claude", messages: [], stream: true, max_tokens: 10 };

function sidecar(id: string, text: string): CoreMessage {
    return { id, role: "system", contentType: "text", text, rawAnthropicMessage: { role: "system", content: [{ type: "text", text }] } } as CoreMessage;
}

test("#4570: compress-loop notes after a trailing system leave a legal wire array", () => {
    const adapter = createAnthropicAdapter(BODY, undefined, ["[bili] retrieval note"]);
    const body = adapter.buildRequest([
        { id: "u1", role: "user", contentType: "text", text: "q1" },
        { id: "a1", role: "assistant", contentType: "text", text: "a1" },
        { id: "u2", role: "user", contentType: "text", text: "q2" },
        sidecar("s1", "<system-reminder>env</system-reminder>"),
    ] as CoreMessage[], "sys", BODY) as { messages: { role: string; content: unknown }[] };
    assert.deepEqual(VALIDATORS.anthropic(body).filter((v) => v.startsWith("WC-023")), []);
    const wire = JSON.stringify(body.messages);
    assert.ok(wire.includes("<system-reminder>env</system-reminder>"), "system text kept");
    assert.ok(wire.includes("[bili] retrieval note"), "note kept");
});

test("#4570 must-follow: a post-fold sidecar after an assistant is healed on the re-request", () => {
    const adapter = createAnthropicAdapter(BODY);
    const body = adapter.buildRequest([
        { id: "anchor", role: "user", contentType: "text", text: "[Compressed conversation section] x" },
        { id: "a1", role: "assistant", contentType: "text", text: "a1" },
        sidecar("s1", "tools updated"),
        { id: "a2", role: "assistant", contentType: "text", text: "a2" },
        { id: "u2", role: "user", contentType: "text", text: "q2" },
    ] as CoreMessage[], "sys", BODY) as { messages: { role: string; content: unknown }[] };
    assert.deepEqual(VALIDATORS.anthropic(body).filter((v) => v.startsWith("WC-023")), []);
    assert.ok(JSON.stringify(body.messages).includes("tools updated"));
});

test("#4570 negative: a legal trailing system with no notes stays a system", () => {
    const adapter = createAnthropicAdapter(BODY);
    const body = adapter.buildRequest([
        { id: "u1", role: "user", contentType: "text", text: "q1" },
        sidecar("s1", "env"),
    ] as CoreMessage[], "sys", BODY) as { messages: { role: string; content: unknown }[] };
    assert.equal(body.messages[body.messages.length - 1]!.role, "system");
    assert.deepEqual(VALIDATORS.anthropic(body).filter((v) => v.startsWith("WC-023")), []);
});
