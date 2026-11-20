import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexWsReplayItem, normalizeCodexWsReplayInput } from "../src/codex-ws-replay.ts";
import { ResponsesWsHistory } from "../src/responses-ws.ts";

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
