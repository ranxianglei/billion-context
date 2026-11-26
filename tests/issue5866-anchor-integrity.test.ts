// #5866 regression: plugin-lane array-form folds end with ZERO full summaries
// on the wire after the first turn. The kernel's hideConsumedCompressCalls
// stubs the re-sent compress call's summary to a 200-char prefix, but the
// host's stripKernelSummaries only checked range-pair EXISTENCE (not whether
// the call still carries the full text), so it stripped the in-place anchor
// too — leaving zero full carriers.
//
// Option A (integrity-aware anchor stripping): strip the anchor only when some
// matching re-sent call's summary is verbatim-equal to the anchor's body. A
// stubbed (or drifted) call keeps the anchor as the sole full carrier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, type CompressionBlock, type CompressionState } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { stripKernelSummaries } from "../src/server.ts";

function msg(partial: Partial<BiliMessage> & { id: string }): BiliMessage {
    return { role: "user", contentType: "text", text: "x", ...partial } as BiliMessage;
}

// A realistic anchor: topic line + body (the kernel's renderSummary format).
const anchor = (blockId: string, body: string): BiliMessage =>
    msg({ id: `acp_summary_${blockId}`, role: "system", text: `[Compressed conversation section]\n${body}` });
const tail = (n: string | number): BiliMessage => msg({ id: `u${n}`, text: "tail" });
const toolCall = (toolCallId: string, toolName: string, args?: string): BiliMessage =>
    msg({ id: `tc_${toolCallId}`, role: "assistant", contentType: "tool-call", toolCallId, toolName, ...(args !== undefined ? { text: args } : {}) });

function stateWith(blocks: Array<Partial<CompressionBlock>>): CompressionState {
    const s = createInitialState();
    s.blocks = blocks.map((b, i) => ({ blockId: `b${i}`, ...b }) as CompressionBlock);
    return s;
}
const ids = (msgs: BiliMessage[]): string[] => msgs.map((m) => m.id);

// The full summary body that the kernel rendered into the anchor.
const FULL_BODY = "This is the full summary of the compressed conversation section. It is longer than two hundred characters so that the stub prefix (first 200 chars) is strictly shorter than the body and therefore NOT verbatim-equal to it, which is exactly the condition that must keep the anchor as the sole full carrier.";
const STUB_BODY = FULL_BODY.slice(0, 199) + "\u2026"; // hideConsumedCompressCalls stub: 199-char prefix + ellipsis.

test("fresh call: summary verbatim-equals anchor body -> anchor stripped", () => {
    const messages = [anchor("pb0", FULL_BODY), toolCall("c1", "compress", JSON.stringify({ startId: "m1", endId: "m9", summary: FULL_BODY })), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("stubbed call: summary is 200-char prefix, NOT equal to anchor body -> anchor KEPT (the #5866 fix)", () => {
    const messages = [anchor("pb0", FULL_BODY), toolCall("c1", "compress", JSON.stringify({ startId: "m1", endId: "m9", summary: STUB_BODY })), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    // The anchor must survive: the stubbed call is not a full carrier.
    assert.deepEqual(ids(out), ["acp_summary_pb0", "tc_c1", "u0"]);
});

test("stubbed call via content array: anchor KEPT", () => {
    const messages = [anchor("pb0", FULL_BODY), toolCall("c1", "compress", JSON.stringify({ content: [{ startId: "m1", endId: "m9", summary: STUB_BODY }] })), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ["acp_summary_pb0", "tc_c1", "u0"]);
});

test("call with empty summary field: anchor KEPT", () => {
    const messages = [anchor("pb0", FULL_BODY), toolCall("c1", "compress", JSON.stringify({ startId: "m1", endId: "m9" })), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ["acp_summary_pb0", "tc_c1", "u0"]);
});

test("call summary whitespace-padded but otherwise equal: anchor stripped (trim normalization)", () => {
    const messages = [anchor("pb0", FULL_BODY), toolCall("c1", "compress", JSON.stringify({ startId: "m1", endId: "m9", summary: `  ${FULL_BODY}  ` })), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("two blocks, one fresh + one stubbed: only the fresh anchor is stripped", () => {
    const messages = [
        anchor("fresh", FULL_BODY),
        anchor("stub", FULL_BODY),
        toolCall("c1", "compress", JSON.stringify({ content: [{ startId: "m1", endId: "m2", summary: FULL_BODY }, { startId: "m3", endId: "m4", summary: STUB_BODY }] })),
        tail(0),
    ];
    const state = stateWith([
        { blockId: "fresh", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m2" },
        { blockId: "stub", active: true, compressCallId: "plugin_2", startRef: "m3", endRef: "m4" },
    ]);
    const out = stripKernelSummaries(messages, state);
    // The fresh block's anchor is stripped (full carrier); the stubbed block's
    // anchor is kept (no full carrier).
    assert.deepEqual(ids(out), ["acp_summary_stub", "tc_c1", "u0"]);
});

test("anchor absent from messages (already stripped upstream): no crash, call still rides", () => {
    const messages = [toolCall("c1", "compress", JSON.stringify({ startId: "m1", endId: "m9", summary: STUB_BODY })), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("proxy-mode block (non-plugin callId): summary match does NOT apply, id match governs", () => {
    // Proxy-mode blocks use the plain toolCallId match; the integrity check is
    // plugin-only. A proxy call with no summary field still strips its anchor.
    const messages = [anchor("b0", FULL_BODY), toolCall("proxy_call_b0", "compress", JSON.stringify({ startId: "m1", endId: "m9" })), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "b0", active: true, compressCallId: "proxy_call_b0" }]));
    assert.deepEqual(ids(out), ["tc_proxy_call_b0", "u0"]);
});
