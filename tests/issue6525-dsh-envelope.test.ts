/**
 * #6525: dsh full-resend envelope (carrier ①) — resolver tests.
 *
 * The envelope stamps the model body's own parallel id array
 * (`biliMsgIds`, core-aligned) so host-pinned prefixes exist on EVERY
 * full-resend turn, not only the anthropic-wire incremental lane.
 * Resolution never re-implements the host's wire transforms: the pi-ai
 * lockstep walkers prove wire-element ⇔ host-message pairing, and the
 * kernel's own converters prove core-alignment via the #3642 wireIndex
 * back-pointer. These tests pin the resulting accept/bail matrix against
 * REAL kernel + REAL walker behavior (no re-implementations).
 */
import assert from "node:assert";
import { test } from "node:test";
import { _envelopeMsgIdsForTest as resolve } from "../src/agent/dsh-native.js";

// dsh host messages = pi-ai Message shape (id added by the host):
// user: string | (text|image)[]; assistant: (text|thinking|toolCall)[];
// toolResult: toolCallId + (text|image)[]; system: hoisted/folded prefix.
const sys = (content: string) => ({ id: "s0", role: "system", content, timestamp: 1 });
const user = (id: string, content: string | unknown[]) => ({ id, role: "user", content, timestamp: 1 });
const asst = (id: string, content: unknown[]) => ({ id, role: "assistant", content, api: "openai-completions", provider: "fake", model: "fake-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 });
const toolResult = (id: string, toolCallId: string, text: string) => ({ id, role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 1 });
const text = (t: string) => ({ type: "text", text: t });
const oai = (messages: unknown[]) => ({ model: "fake-model", messages });

test("openai: leading system + plain conversation → core-aligned ids, lead dropped", () => {
    const wire = oai([
        { role: "system", content: "S" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "tool", tool_call_id: "c1", content: "r1" },
    ]);
    const host = [sys("S"), user("u1", "hello"), asst("a1", [text("hi")]), toolResult("t1", "c1", "r1")];
    assert.deepStrictEqual(resolve(wire, host), ["u1", "a1", "t1"]);
});

test("openai: no leading system → every id", () => {
    const wire = oai([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
    const host = [user("u1", "a"), user("u2", "b")];
    assert.deepStrictEqual(resolve(wire, host), ["u1", "u2"]);
});

test("openai: user [text, image_url] → bail (kernel splits one element into N cores)", () => {
    const wire = oai([{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "x" } }] }]);
    const host = [user("u1", [text("see"), { type: "image", data: "x", mimeType: "image/png" }])];
    assert.strictEqual(resolve(wire, host), undefined);
});

test("openai: assistant with parallel tool_calls → bail (N tool_call cores, one host id)", () => {
    const wire = oai([{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }, { id: "c2", type: "function", function: { name: "g", arguments: "{}" } }] }]);
    const host = [asst("a1", [{ type: "toolCall", id: "c1", name: "f", arguments: {} }, { type: "toolCall", id: "c2", name: "g", arguments: {} }])];
    assert.strictEqual(resolve(wire, host), undefined);
});

test("openai: reasoning_content anywhere → bail (walker refuse, conversion not statically provable)", () => {
    const wire = oai([{ role: "user", content: "a" }, { role: "assistant", content: "hi", reasoning_content: "R" }]);
    const host = [user("u1", "a"), asst("a1", [text("hi")])];
    assert.strictEqual(resolve(wire, host), undefined);
});

test("openai: non-leading system element → bail (ambiguous placement)", () => {
    const wire = oai([{ role: "user", content: "a" }, { role: "system", content: "mid" }, { role: "user", content: "b" }]);
    const host = [user("u1", "a"), sys("mid"), user("u2", "b")];
    assert.strictEqual(resolve(wire, host), undefined);
});

test("openai: host list shorter than the wire (dropped message) → bail (leftover proof fails)", () => {
    const wire = oai([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
    const host = [user("u1", "a")];
    assert.strictEqual(resolve(wire, host), undefined);
});

test("openai: host entry with a different byte stream → bail (fingerprint mismatch, never positional)", () => {
    const wire = oai([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
    const host = [user("u1", "a"), user("u2", "c")];
    assert.strictEqual(resolve(wire, host), undefined);
});

test("duplicate host ids → bail (reject-class parity with hostMsgIdsOf / validateMsgIds)", () => {
    const wire = oai([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
    const host = [user("dup", "a"), user("dup", "b")];
    assert.strictEqual(resolve(wire, host), undefined);
});

test("openai: host entry missing an id → bail (all-or-nothing)", () => {
    const wire = oai([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
    const host = [user("u1", "a"), { role: "user", content: "b", timestamp: 1 }];
    assert.strictEqual(resolve(wire, host), undefined);
});

test("openai: dsh flat host shape (role tool + block tool-call) → core-aligned (churn fix #6525 B7)", () => {
    // dsh's flat host messages differ from the pi-ai form the shared walker's
    // host fingerprint assumes: tool results carry role "tool" (not
    // "toolResult") and assistant tool-call blocks are type "tool-call"
    // (hyphen, not camel "toolCall"). Without the resolver's fingerprint-only
    // normalization, EVERY tool-bearing turn bailed the all-or-nothing
    // envelope and the host ids churned back to content digests on the next
    // full-resend (the B7 root cause found via a real-dsh e2e dump).
    const wire = oai([
        { role: "system", content: "S" },
        { role: "user", content: "hello" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "acp_status", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "r1" },
        { role: "assistant", content: "done" },
    ]);
    const host = [
        sys("S"),
        user("u1", "hello"),
        { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "acp_status", arguments: "{}" }], timestamp: 1 },
        { id: "t1", role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "r1" }], timestamp: 1 },
        { id: "a2", role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1 },
    ];
    assert.deepStrictEqual(resolve(wire, host), ["u1", "a1", "t1", "a2"]);
});

test("openai: dsh parallel tool_calls still bail (one host id cannot cover N cores)", () => {
    const wire = oai([{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }, { id: "c2", type: "function", function: { name: "g", arguments: "{}" } }] }]);
    const host = [{ id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "f", arguments: "{}" }, { type: "tool-call", id: "c2", name: "g", arguments: "{}" }], timestamp: 1 }];
    assert.strictEqual(resolve(wire, host), undefined);
});

test("anthropic: system field separate, full conversation → 1:1 ids", () => {
    const wire = { model: "fake-model", max_tokens: 100, system: "S", messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "yo" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "r1" }] },
    ] };
    const host = [sys("S"), user("u1", "hi"), asst("a1", [text("yo")]), toolResult("t1", "c1", "r1")];
    assert.deepStrictEqual(resolve(wire, host), ["u1", "a1", "t1"]);
});

test("non-openai/anthropic payload → undefined (google/responses stay content-derived, #6525 v1)", () => {
    const wire = { model: "fake-model", input: [{ role: "user", content: "hi" }] };
    assert.strictEqual(resolve(wire, [user("u1", "hi")]), undefined);
});

test("degenerate inputs → undefined (never throws)", () => {
    assert.strictEqual(resolve({ model: "m" }, []), undefined);
    assert.strictEqual(resolve({ model: "m", messages: [] }, [user("u1", "a")]), undefined);
    assert.strictEqual(resolve({ model: "m", messages: [{ role: "user", content: "a" }] }, null), undefined);
    assert.strictEqual(resolve({ model: "m", messages: [{ role: "user", content: "a" }] }, [null]), undefined);
});
