import { test } from "node:test";
import assert from "node:assert/strict";
import { createResponsesAdapter, normalizeResponsesMessageItems, sanitizeResponsesInputIds } from "../src/loop/adapter-responses.ts";

const proxyId = "msg-proxy-2-7d1e132ded554149";

test("replayed full assistant messages drop only proxy-generated ids", () => {
    for (const id of [proxyId, "msg-proxy-1789893725000-0", `msg-proxy-2-${"x".repeat(60)}`]) {
        for (const content of ["answer", "", [], [{ type: "output_text", text: "answer", annotations: [] }], [{ type: "refusal", refusal: "no" }]]) {
            const message: Record<string, unknown> = {
                type: "message", role: "assistant", id, content,
                status: "completed", phase: "final_answer",
            };
            const expected = structuredClone(message);
            delete expected.id;
            sanitizeResponsesInputIds([message]);
            assert.deepEqual(message, expected);
            sanitizeResponsesInputIds([message]);
            assert.deepEqual(message, expected, "cleanup is idempotent");
        }
    }
});

test("ingress normalization makes typeless assistant replay eligible", () => {
    const input = [{ role: "assistant", id: proxyId, content: "answer" }];
    assert.equal(normalizeResponsesMessageItems(input), 1);
    sanitizeResponsesInputIds(input);
    assert.deepEqual(input, [{ type: "message", role: "assistant", content: "answer" }]);
});

test("native ids, references, non-assistant items and incomplete messages remain unchanged", () => {
    const input: unknown[] = [
        null, undefined, 0, "text", false,
        { type: "message", role: "assistant", id: "msg_native", content: "answer" },
        { type: "message", role: "assistant", id: "msg_native_2", content: "answer" },
        ...["user", "system", "developer"].map(role => ({ type: "message", role, id: proxyId, content: "text" })),
        ...[undefined, null, {}].map(content => ({ type: "message", role: "assistant", id: proxyId, content })),
        { type: "message", role: "assistant", id: 123, content: "answer" },
        { type: "message", role: "assistant", content: "answer" },
        { type: "item_reference", id: proxyId },
        { type: "reasoning", id: proxyId, summary: [] },
        { type: "compaction", id: proxyId, encrypted_content: "opaque" },
        { type: "function_call", id: proxyId, call_id: "call_1", name: "tool", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { type: "custom_tool_call", id: proxyId, call_id: "call_2", name: "tool", input: "text" },
    ];
    const expected = structuredClone(input);
    sanitizeResponsesInputIds(input);
    assert.deepEqual(input, expected);
    for (const value of [undefined, null, false, "text", {}]) {
        assert.doesNotThrow(() => sanitizeResponsesInputIds(value));
    }
});

test("provider-issued over-64 ids stay byte-identical across item types (#1474)", () => {
    const longId = "x".repeat(80);
    const input: unknown[] = [
        { type: "message", role: "assistant", id: longId, content: "answer" },
        { type: "message", role: "user", id: longId, content: "question" },
        { type: "reasoning", id: `rs_${"a".repeat(100)}`, encrypted_content: "opaque", summary: [] },
        { type: "function_call", id: `fc_${"b".repeat(100)}`, call_id: `call_${"c".repeat(80)}`, name: "tool", arguments: "{}" },
        { type: "custom_tool_call", id: `ctc_${"d".repeat(100)}`, call_id: "call_2", name: "tool", input: "text" },
        { type: "item_reference", id: `item_${"e".repeat(100)}` },
        { type: "compaction", id: `comp_${"f".repeat(100)}`, encrypted_content: "opaque" },
    ];
    const expected = structuredClone(input);
    sanitizeResponsesInputIds(input);
    assert.deepEqual(input, expected, "ids bili does not own reach the upstream byte-identical");
});

test("over-64 id healing stays scoped to the msg-proxy namespace (#242/#1474)", () => {
    const poisoned = `msg-proxy-2-${"x".repeat(60)}`;
    const input: Record<string, unknown>[] = [
        { type: "message", role: "assistant", id: "x".repeat(64), content: "answer" },
        { type: "message", role: "assistant", id: "x".repeat(65), content: "answer" },
        { type: "function_call", id: "x".repeat(65), call_id: "y".repeat(80) },
        { type: "message", role: "user", id: poisoned, content: [] },
    ];
    sanitizeResponsesInputIds(input);
    assert.equal(input[0].id, "x".repeat(64), "64-char boundary preserved");
    assert.equal(input[1].id, "x".repeat(65), "over-64 ids outside Bili's namespace are untouched");
    assert.equal(input[2].id, "x".repeat(65));
    assert.equal(input[2].call_id, "y".repeat(80));
    const healed = String(input[3].id);
    assert.match(healed, /^msg-fix-/);
    assert.ok(healed.length <= 64);
    const expected = structuredClone(input);
    sanitizeResponsesInputIds(input);
    assert.deepEqual(input, expected, "cleanup is idempotent");
    const again: Record<string, unknown>[] = [{ type: "message", role: "user", id: poisoned, content: [] }];
    sanitizeResponsesInputIds(again);
    assert.equal(String(again[0].id), healed, "rewrite is deterministic per source id");
});

test("emitText lifecycle keeps its local id while the next full-message replay omits it", () => {
    const wire = createResponsesAdapter(true).emitText("answer").toString("utf8");
    const events = wire.split("\n").filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const added = events.find(event => event.type === "response.output_item.added")?.item as Record<string, unknown>;
    const done = events.find(event => event.type === "response.output_item.done")?.item as Record<string, unknown>;
    assert.match(String(added.id), /^msg-proxy-\d+-\d+$/);
    assert.equal(done.id, added.id);
    for (const event of events) {
        if (event.item_id !== undefined) assert.equal(event.item_id, added.id);
    }
    const replay = structuredClone(done);
    const expected = structuredClone(done);
    delete expected.id;
    normalizeResponsesMessageItems([replay]);
    sanitizeResponsesInputIds([replay]);
    assert.deepEqual(replay, expected);
    assert.equal(done.id, added.id, "client-visible stream ids are not mutated");
});
