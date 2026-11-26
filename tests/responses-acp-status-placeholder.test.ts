import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, prune, type CompressionBlock } from "acp-kernel";
import { responsesToCore } from "acp-kernel/wire";
import { responsesBodyToCore } from "../src/agent/fork-adopt.ts";
import { incomingCoreMessages } from "../src/fork-adoption.ts";
import { stripRawStage } from "../src/marker/engine.ts";

const marker = "📦 [ACP] Compressed m00001–m00002 → b1";
const status = "📦 [ACP] acp_status result:\n  ACTIVE SURFACE 61% of window\n  CONTEXT BREAKDOWN\n    raw history 400 tok";
const text = (value: string) => ({ type: "output_text", text: value });
const message = (content: unknown, extra: Record<string, unknown> = {}) =>
    ({ type: "message", role: "assistant", content, ...extra });
const user = (value: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text: value }] });
const echo = () => message([{ ...text(marker), annotations: [], logprobs: [] }], {
    id: "msg_echo", status: "completed", internal_chat_message_metadata_passthrough: { turn: 2 },
});

test("Responses strips marker-only assistant items before minting IDs, keeping old summaries in order on resume", () => {
    const makeBody = (placeholder: () => ReturnType<typeof message>, resumed: boolean) => ({
        input: [user("stable prefix"), placeholder(), ...(resumed ? [placeholder()] : []),
            user("anchor b1"), user("anchor b2"), placeholder(), user("latest")],
    });
    // Simulate an existing ledger from before the fix (already-projected spaces).
    const old = responsesToCore(makeBody(() => message([text(" ")]), false) as Parameters<typeof responsesToCore>[0]).msgs;
    const idOf = (value: string) => old.find((m) => m.text === value)!.id;
    const blanks = old.filter((m) => m.role === "assistant" && m.text === " ");
    assert.equal(blanks.length, 2);
    const state = createInitialState();
    const block = (blockId: string, ids: string[]): CompressionBlock => ({
        blockId, runId: "r1", tier: 1, summary: blockId, directBlockIds: [], directMessageIds: ids,
        effectiveMessageIds: ids, compressedTokens: 30, createdAt: 1, survivedCount: 0, generation: "young", active: true,
    });
    state.blocks.push(block("b1", [idOf("anchor b1")]), block("b2", [idOf("anchor b2"), blanks[1]!.id]));
    const order = (msgs: typeof old) => prune(msgs, state)
        .filter((m) => m.id.startsWith("acp_summary_")).map((m) => m.text);
    const unfiltered = responsesToCore(makeBody(() => message([text(" ")]), true) as Parameters<typeof responsesToCore>[0]).msgs;
    assert.deepEqual(order(unfiltered), [...order(old)].reverse(), "positive control: occurrence IDs actually displace b2");
    assert.equal(order(old).length, 2);

    for (const resumed of [false, true]) {
        const raw = makeBody(echo, resumed);
        const host = incomingCoreMessages("responses", raw)!;
        assert.deepEqual(responsesBodyToCore(raw), host, "both fork projections use the same ingress identity");
        assert.ok(!host.some((m) => m.role === "assistant" && m.text?.trim() === ""));
        assert.equal(host.find((m) => m.text === "stable prefix")?.id, idOf("stable prefix"));
        assert.deepEqual(order(host), order(old));
    }
    assert.equal(state.blocks[1]!.directMessageIds[1], blanks[1]!.id, "no migration of old coverage");
});

test("Responses drops only stripped status-only carriers; preserves user content, tool pairing and other structure", () => {
    const call = { type: "function_call", id: "fc1", call_id: "call_1", name: "read", arguments: '{"query":"keep"}' };
    const result = { type: "function_call_output", call_id: "call_1", output: "keep" };
    const reasoning = { type: "reasoning", encrypted_content: "unchanged", summary: [] };
    const oldUser = user(marker);
    const currentUser = user(marker);
    const mixed = message([text(marker), text("real prose")]);
    const image = message([text(marker), { type: "input_image", image_url: "https://example.test/keep.png" }]);
    const annotated = message([{ ...text(marker), annotations: [{ type: "url_citation", url: "https://example.test" }] }]);
    const toolCarrier = message(marker, { tool_calls: [call] });
    const unknown = message(marker, { extension: { mustKeep: true } });
    const incomplete = message(marker, { status: "incomplete" });
    const alreadyBlank = message(" ");
    const body = { input: [oldUser, echo(), message(status), mixed, image, annotated, toolCarrier, unknown,
        incomplete, alreadyBlank, call, result, reasoning, currentUser] };
    const sameArray = body.input;
    const keep = [oldUser, mixed, image, annotated, toolCarrier, unknown, incomplete, alreadyBlank, call, result, reasoning, currentUser];
    const expectedTail = structuredClone([call, result, reasoning, currentUser]);
    const counts = stripRawStage(body, "responses");
    assert.equal(body.input, sameArray);
    assert.deepEqual(body.input, keep);
    assert.equal(counts.statusBodies, 1);
    assert.deepEqual(mixed.content, [text(" "), text("real prose")]);
    assert.deepEqual(toolCarrier, message(" ", { tool_calls: [call] }));
    assert.deepEqual(body.input.slice(-4), expectedTail);
});
