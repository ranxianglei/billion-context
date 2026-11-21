import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexResponsesEgressItem, normalizeCodexResponsesEgressInput, normalizeCodexWsReplayItem, normalizeCodexWsReplayInput } from "../src/codex-ws-replay.ts";
import { ResponsesWsHistory } from "../src/responses-ws.ts";
import { createResponsesAdapter } from "../src/loop/adapter-responses.ts";
import { responsesToCore, type ResponsesRequestBody } from "acp-kernel/wire";

type Item = Record<string, unknown>;
const text = [{ type: "output_text", text: "hello", annotations: [], logprobs: [] }];
const pass = { turn_id: "turn-1", create_time: 1795117760.6655521 };
const oldItem: Item = {
    type: "message", id: "msg_123", metadata: { turn_id: "turn-1" },
    internal_chat_message_metadata_passthrough: { content_token_count: 48, create_time: pass.create_time, turn_id: pass.turn_id },
    role: "assistant", status: "completed", content: text, phase: "commentary",
};
const replayItem: Item = {
    type: "message", status: "completed", id: "msg_123", role: "assistant", content: text,
    phase: "commentary", internal_chat_message_metadata_passthrough: { ...pass, content_item_kinds: ["unknown"] },
};
const user = (s: string): Item => ({ type: "message", role: "user", content: s });

test("checkpoint and Codex replay forms normalize to identical bytes without editing either", () => {
    const oldBefore = JSON.stringify(oldItem);
    const replayBefore = JSON.stringify(replayItem);
    const oldResult = normalizeCodexWsReplayItem(oldItem);
    const newResult = normalizeCodexWsReplayItem(replayItem);
    assert.equal(JSON.stringify(oldResult), JSON.stringify(newResult));
    assert.deepEqual(oldResult, {
        type: "message", status: "completed", id: "msg_123", role: "assistant", content: text,
        phase: "commentary", internal_chat_message_metadata_passthrough: pass,
    });
    assert.deepEqual(normalizeCodexWsReplayItem(oldResult), oldResult);
    assert.equal(JSON.stringify(oldItem), oldBefore);
    assert.equal(JSON.stringify(replayItem), replayBefore);
    assert.equal(normalizeCodexWsReplayInput([oldItem, replayItem]).length, 2);
});

test("unknown structures, attribution, classifications, and unsafe metadata are left untouched", () => {
    const unsafe: unknown[] = [
        null,
        { ...oldItem, type: "reasoning" },
        { ...oldItem, role: "user" },
        { ...oldItem, id: "other" },
        { ...oldItem, status: "in_progress" },
        { ...oldItem, phase: "future-phase" },
        { ...oldItem, future_field: 1 },
        { ...oldItem, metadata: { turn_id: "another-turn" } },
        { ...oldItem, metadata: { turn_id: "turn-1", future: 1 } },
        { ...oldItem, internal_chat_message_metadata_passthrough: { ...pass, future_field: 1 } },
        { ...oldItem, internal_chat_message_metadata_passthrough: { ...pass, content_item_kinds: ["tool"] } },
        { ...oldItem, internal_chat_message_metadata_passthrough: { ...pass, content_item_kinds: ["unknown", "unknown"] } },
        { ...oldItem, internal_chat_message_metadata_passthrough: { ...pass, content_item_metadata: [{ provenance: { type: "tool" } }] } },
        { ...oldItem, internal_chat_message_metadata_passthrough: { ...pass, content_token_count: -1 } },
        { ...oldItem, internal_chat_message_metadata_passthrough: { ...pass, turn_id: "" } },
        { ...oldItem, internal_chat_message_metadata_passthrough: { ...pass, create_time: null } },
        { ...oldItem, content: [] },
        { ...oldItem, content: [...text, ...text] },
        { ...oldItem, content: [{ ...text[0], future_field: true }] },
        { ...oldItem, content: [{ ...text[0], annotations: [{ type: "citation" }] }] },
        { ...oldItem, content: [{ ...text[0], logprobs: [1] }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", arguments: "{}" },
        { type: "reasoning", id: "rs_1", encrypted_content: "signed" },
    ];
    for (const item of unsafe) assert.strictEqual(normalizeCodexWsReplayItem(item), item);
});

test("upstream continuation compares only recognized replay drift; ordinary WS clients retain strict comparison", () => {
    const previousInput = [user("first")];
    const full: Item = { model: "m", input: [...previousInput, replayItem, user("next")] };
    const history = new ResponsesWsHistory(1_000_000, true);
    history.commit({ model: "m", input: previousInput }, { id: "resp-1", status: "completed", output: [oldItem] });
    assert.deepEqual(history.continuation(full), { model: "m", input: [user("next")], previous_response_id: "resp-1" });
    const generic = new ResponsesWsHistory(1_000_000);
    generic.commit({ model: "m", input: previousInput }, { id: "resp-1", status: "completed", output: [oldItem] });
    assert.strictEqual(generic.continuation(full), full);

    const variants = [
        { ...replayItem, content: [{ ...text[0], text: "changed" }] },
        { ...replayItem, id: "msg_changed" },
        { ...replayItem, phase: "final_answer" },
        { ...replayItem, internal_chat_message_metadata_passthrough: { ...pass, turn_id: "another" } },
        { ...replayItem, internal_chat_message_metadata_passthrough: { ...pass, create_time: pass.create_time + 1 } },
        { ...replayItem, internal_chat_message_metadata_passthrough: { ...pass, content_item_kinds: ["tool"] } },
        { ...replayItem, internal_chat_message_metadata_passthrough: { ...pass, content_item_metadata: [{ provenance: { type: "tool" } }] } },
        { ...replayItem, future_field: true },
    ];
    for (const changed of variants) {
        const request = { model: "m", input: [...previousInput, changed, user("next")] };
        assert.strictEqual(history.continuation(request), request);
    }
});

const reasoningSummary = [{ type: "summary_text", text: "summary" }];
const oldReasoning: Item = {
    type: "reasoning", id: "rs_123", metadata: { turn_id: "turn-1" },
    internal_chat_message_metadata_passthrough: { create_time: pass.create_time, turn_id: pass.turn_id },
    summary: reasoningSummary, content: [], encrypted_content: "encrypted-signed-bytes",
};
const replayReasoning: Item = {
    type: "reasoning", id: "rs_123", summary: reasoningSummary, content: null,
    encrypted_content: "encrypted-signed-bytes", internal_chat_message_metadata_passthrough: pass,
};

test("reasoning is normalized only at egress and preserves encrypted bytes, summary and input identities", () => {
    const before = JSON.stringify([oldReasoning, replayReasoning]);
    const ingress = normalizeCodexWsReplayInput([oldReasoning, replayReasoning]);
    assert.strictEqual(ingress[0], oldReasoning);
    assert.strictEqual(ingress[1], replayReasoning);
    const [oldWire, newWire] = normalizeCodexResponsesEgressInput(ingress);
    assert.equal(JSON.stringify(oldWire), JSON.stringify(newWire));
    assert.deepEqual(oldWire, {
        type: "reasoning", id: "rs_123", summary: reasoningSummary,
        encrypted_content: "encrypted-signed-bytes", internal_chat_message_metadata_passthrough: pass,
    });
    assert.equal(JSON.stringify([oldReasoning, replayReasoning]), before);
    assert.deepEqual(normalizeCodexResponsesEgressItem(oldWire), oldWire);
    const absent = { type: "reasoning", id: "rs_123", summary: reasoningSummary, encrypted_content: "signed" };
    assert.deepEqual(normalizeCodexResponsesEgressItem({ ...absent, content: null }), absent);
    assert.deepEqual(normalizeCodexResponsesEgressItem({ ...absent, content: [] }), absent);
});

test("reasoning unknown structures, actual content and attribution are forwarded untouched", () => {
    const unsafe: unknown[] = [
        { ...oldReasoning, id: "other" },
        { ...oldReasoning, future_field: true },
        { ...oldReasoning, encrypted_content: null },
        { ...oldReasoning, encrypted_content: "" },
        { ...oldReasoning, summary: null },
        { ...oldReasoning, content: [{ type: "reasoning_text", text: "must survive" }] },
        { ...oldReasoning, content: {} },
        { ...oldReasoning, metadata: { turn_id: "different" } },
        { ...oldReasoning, metadata: { turn_id: "turn-1", other: "must survive" } },
        { ...oldReasoning, internal_chat_message_metadata_passthrough: { ...pass, content_item_metadata: [{ provenance: { type: "tool" } }] } },
        { ...oldReasoning, internal_chat_message_metadata_passthrough: null },
        { ...oldReasoning, internal_chat_message_metadata_passthrough: { ...pass, create_time: null } },
        { ...oldReasoning, internal_chat_message_metadata_passthrough: undefined },
        { type: "function_call", id: "fc_1", arguments: "{}" },
    ];
    for (const item of unsafe) assert.strictEqual(normalizeCodexResponsesEgressItem(item), item);
});

test("reasoning continuation accepts only the recognized empty-content envelope difference", () => {
    const previousInput = [user("first")];
    const history = new ResponsesWsHistory(1_000_000, true);
    history.commit({ model: "m", input: previousInput }, { id: "resp-1", status: "completed", output: [oldReasoning] });
    const full = { model: "m", input: [...previousInput, replayReasoning, user("next")] };
    assert.deepEqual(history.continuation(full), { model: "m", input: [user("next")], previous_response_id: "resp-1" });
    const generic = new ResponsesWsHistory(1_000_000);
    generic.commit({ model: "m", input: previousInput }, { id: "resp-1", status: "completed", output: [oldReasoning] });
    assert.strictEqual(generic.continuation(full), full);
    for (const changed of [
        { ...replayReasoning, id: "rs_other" },
        { ...replayReasoning, encrypted_content: "changed" },
        { ...replayReasoning, summary: [{ type: "summary_text", text: "changed" }] },
        { ...replayReasoning, content: [{ type: "reasoning_text", text: "new content" }] },
        { ...replayReasoning, internal_chat_message_metadata_passthrough: { ...pass, turn_id: "different" } },
        { ...replayReasoning, internal_chat_message_metadata_passthrough: { ...pass, create_time: pass.create_time + 1 } },
        { ...replayReasoning, internal_chat_message_metadata_passthrough: { ...pass, content_item_kinds: ["tool"] } },
        { ...replayReasoning, metadata: { turn_id: "different" } },
        { ...replayReasoning, future_field: true },
    ]) {
        const request = { model: "m", input: [...previousInput, changed, user("next")] };
        assert.strictEqual(history.continuation(request), request);
    }
});

test("Codex HTTP internal-loop rebuild uses the same egress form; generic Responses keeps the original", () => {
    const body = { model: "m", input: [user("first"), oldReasoning, user("next")], stream: true } as unknown as ResponsesRequestBody;
    const projection = responsesToCore(body);
    const codex = createResponsesAdapter(false, projection, undefined, undefined, true);
    const generic = createResponsesAdapter(false, projection);
    const rebuilt = codex.buildRequest(projection.msgs, "", body as unknown as Item) as Item;
    const plain = generic.buildRequest(projection.msgs, "", body as unknown as Item) as Item;
    const find = (value: Item): Item => {
        const item = (value.input as Item[]).find(entry => entry.id === "rs_123");
        assert.ok(item);
        return item;
    };
    assert.deepEqual(find(rebuilt), normalizeCodexResponsesEgressItem(oldReasoning));
    assert.deepEqual(find(plain), oldReasoning);
});
