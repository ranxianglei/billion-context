// #7478: reconcilePluginFoldCallIds (the post-hoc adoption, src/plugin.ts) had
// the SAME blind spot as stripKernelSummaries — it only parsed the plugin-era
// JSON shapes (startId/endId), so a line-format fold's carrier call never
// registered and the synthetic plugin_<ts> callId was never adopted. It is
// called only on the responses wire (src/server/prepare-responses.ts), so dsh
// (openai wire) can't reach it — but the same mechanism family must be closed
// on every wire. The fix routes both sites through the shared parser
// (src/carrier-args.ts), so the adoption recognizes exactly the ranges the
// strip verdict recognizes.
//
// Both directions of the gate are pinned: line-format call present + the
// receipt carries the block's full-summary line -> adopted; absent /
// mismatched / no full-summary line / ambiguous -> not adopted.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { reconcilePluginFoldCallIds } from "../src/plugin.ts";
import { createSession, type Session } from "../src/session.ts";

function sessionWithBlock(startRef: string, endRef: string): Session {
    const s = createSession("reconcile-line-carrier");
    s.state.blocks.push({
        blockId: "b0", runId: "run-0", tier: 1,
        summary: "s".repeat(250),
        directMessageIds: [], effectiveMessageIds: [], directBlockIds: [],
        compressedTokens: 0, createdAt: 1, survivedCount: 0, generation: "young",
        active: true, compressCallId: "plugin_1", startRef, endRef,
    });
    return s;
}
const toolCall = (toolCallId: string, args: string): CoreMessage =>
    ({ id: `tc_${toolCallId}`, role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId, text: args });
const toolResult = (toolCallId: string, text: string): CoreMessage =>
    ({ id: `tr_${toolCallId}`, role: "user", contentType: "tool-result", toolCallId, text });
const lineArgs = (body: string): string => JSON.stringify({ content: body });
const receipt = (blockId: string): string =>
    `[Compressed m00150–m00220 → 1 block(s), ~250 tokens saved.\n · ${blockId} full summary ` + "s".repeat(250);

test("line-format fold call is adopted (the JSON-only parser never registered it)", () => {
    const s = sessionWithBlock("m00150", "m00220");
    const body = "m00150–m00220 topic\n" + "s".repeat(250);
    const messages = [toolCall("c1", lineArgs(body)), toolResult("c1", receipt("b0"))];
    const changed = reconcilePluginFoldCallIds(s, messages);
    assert.equal(changed, 1);
    assert.equal(s.state.blocks[0]!.compressCallId, "c1");
});

test("JSON-shape fold call is still adopted (regression: the old path keeps working)", () => {
    const s = sessionWithBlock("m00150", "m00220");
    const args = JSON.stringify({ startId: "m00150", endId: "m00220", summary: "s".repeat(300) });
    const messages = [toolCall("c1", args), toolResult("c1", receipt("b0"))];
    const changed = reconcilePluginFoldCallIds(s, messages);
    assert.equal(changed, 1);
    assert.equal(s.state.blocks[0]!.compressCallId, "c1");
});

test("line-format call quoting a different range -> not adopted", () => {
    const s = sessionWithBlock("m00150", "m00220");
    const body = "m00300–m00310 topic\n" + "s".repeat(250);
    const messages = [toolCall("c1", lineArgs(body)), toolResult("c1", receipt("b0"))];
    const changed = reconcilePluginFoldCallIds(s, messages);
    assert.equal(changed, 0);
    assert.equal(s.state.blocks[0]!.compressCallId, "plugin_1");
});

test("line-format call but the receipt cites a different block -> not adopted", () => {
    const s = sessionWithBlock("m00150", "m00220");
    const body = "m00150–m00220 topic\n" + "s".repeat(250);
    const messages = [toolCall("c1", lineArgs(body)), toolResult("c1", receipt("b1"))];
    const changed = reconcilePluginFoldCallIds(s, messages);
    assert.equal(changed, 0);
    assert.equal(s.state.blocks[0]!.compressCallId, "plugin_1");
});

test("two calls for the same range -> not adopted (ambiguous ownership)", () => {
    const s = sessionWithBlock("m00150", "m00220");
    const body = "m00150–m00220 topic\n" + "s".repeat(250);
    const messages = [
        toolCall("c1", lineArgs(body)), toolResult("c1", receipt("b0")),
        toolCall("c2", lineArgs(body)), toolResult("c2", receipt("b0")),
    ];
    const changed = reconcilePluginFoldCallIds(s, messages);
    assert.equal(changed, 0);
    assert.equal(s.state.blocks[0]!.compressCallId, "plugin_1");
});

test("unparseable args -> not adopted (fail-safe, same as the old catch)", () => {
    const s = sessionWithBlock("m00150", "m00220");
    const messages = [toolCall("c1", "{not json"), toolResult("c1", receipt("b0"))];
    const changed = reconcilePluginFoldCallIds(s, messages);
    assert.equal(changed, 0);
    assert.equal(s.state.blocks[0]!.compressCallId, "plugin_1");
});
