// #7478: the carrier verdict misread the CURRENT compress args shape. The
// kernel COMPRESS_TOOL contract is `content` as a PLAIN STRING of line blocks
// ("m00150–m0220 topic\n<summary>…"), but buildCarrierIndex only parsed the
// plugin-era JSON shapes — so every dsh-style fold was judged carrier-less,
// the in-place anchor was fail-safely kept, and each summary was billed twice
// (anchor node + call args; 74K measured on a live session). The verdict also
// gained the full-text half of the contract: a call stubbed by
// hideConsumedCompressCalls (kernel/src/hide-consumed.ts) is NOT a complete
// carrier (#5866), so stub-shaped summaries keep the anchor too.
//
// Both directions of the gate are pinned: line-format call present + full →
// anchor stripped; absent / mismatched / stub-length / unparseable → kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, type CompressionBlock, type CompressionState } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { stripKernelSummaries } from "../src/server.ts";

function msg(partial: Partial<BiliMessage> & { id: string }): BiliMessage {
    return { role: "user", contentType: "text", text: "x", ...partial } as BiliMessage;
}
const summary = (blockId: string): BiliMessage => msg({ id: `acp_summary_${blockId}`, role: "system", text: "summary" });
const tail = (): BiliMessage => msg({ id: "u0", text: "tail" });
const toolCall = (toolCallId: string, args: string): BiliMessage =>
    msg({ id: `tc_${toolCallId}`, role: "assistant", contentType: "tool-call", toolCallId, toolName: "compress", text: args });

function stateWith(blocks: Array<Partial<CompressionBlock>>): CompressionState {
    const s = createInitialState();
    s.blocks = blocks.map((b, i) => ({ blockId: `b${i}`, ...b }) as CompressionBlock);
    return s;
}
const ids = (msgs: BiliMessage[]): string[] => msgs.map((m) => m.id);
const pluginState = (startRef: string, endRef: string) =>
    stateWith([{ blockId: "b0", active: true, compressCallId: "plugin_1", startRef, endRef }]);
// The current wire shape: {"content": "m00150–m00220 topic\n<summary>…"}
const lineArgs = (body: string): string => JSON.stringify({ content: body });

test("line-format call carrying the full summary -> anchor stripped", () => {
    const body = "m00150–m00220 任务进展\n" + "摘要 ".repeat(150);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("line-format call with ASCII hyphen separator -> stripped (tolerated variant)", () => {
    const body = "m00150-m00220 topic\n" + "s".repeat(250);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("line-format call, segment below the stub floor -> anchor kept (stub-class, not a full carrier)", () => {
    const body = "m00150–m00220 topic\n" + "short summary".repeat(3);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ids(messages));
});

// #4032 interaction: the kernel's line-form stubbing (serializeLineCompacted)
// truncates a re-sent line-form summary to EXACTLY 200 chars (199 + "…"). The
// old bare `segment.trim().length >= 200` floor read that stubbed entry as
// FULL (200-char stub + topic > 200) -> stripped the anchor -> zero full
// carriers on the wire. The stub-signature half of the check must keep it.
test("line-format call with the kernel's 200-char stub signature -> anchor kept (stub is not a full carrier)", () => {
    const stub = `${"s".repeat(199)}…`;
    const body = `m00150–m00220 topic\n${stub}`;
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ids(messages));
});

test("line-format call quoting a different range -> anchor kept", () => {
    const body = "m00300–m00310 topic\n" + "s".repeat(250);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ids(messages));
});

test("line-format range mentioned mid-line in prose does not register -> anchor kept", () => {
    const body = "m00150–m00300 topic\n" + "earlier I folded m00150–m00220 already\n" + "s".repeat(250);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ids(messages));
});

test("no compress call at all -> anchor kept (fail-safe unchanged)", () => {
    const messages = [summary("b0"), msg({ id: "t1", role: "assistant", contentType: "tool-call", toolCallId: "x", toolName: "bash", text: "{}" }), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ids(messages));
});

test("unparseable args -> anchor kept (fail-safe unchanged)", () => {
    const messages = [summary("b0"), toolCall("c1", "{not json"), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ids(messages));
});

test("multi-range line-format call strips only the block whose range carries full text", () => {
    const body = "m00150–m00220 first\n" + "A".repeat(250) + "\nm00300–m00310 second\ntiny";
    const messages = [summary("b0"), summary("b1"), toolCall("c1", lineArgs(body)), tail()];
    const s = createInitialState();
    s.blocks = [
        { blockId: "b0", active: true, compressCallId: "plugin_1", startRef: "m00150", endRef: "m00220" },
        { blockId: "b1", active: true, compressCallId: "plugin_2", startRef: "m00300", endRef: "m00310" },
    ] as CompressionBlock[];
    const out = stripKernelSummaries(messages, s);
    assert.deepEqual(ids(out), ["acp_summary_b1", "tc_c1", "u0"]);
});

test("stringified JSON array inside content (non-strict providers, #230) still recognized, fullness applied", () => {
    const full = JSON.stringify({ content: JSON.stringify([{ startId: "m00150", endId: "m00220", summary: "s".repeat(300) }]) });
    const messages = [summary("b0"), toolCall("c1", full), tail()];
    assert.deepEqual(ids(stripKernelSummaries(messages, pluginState("m00150", "m00220"))), ["tc_c1", "u0"]);
    const stub = `${"s".repeat(199)}…`;
    const stubbed = JSON.stringify({ content: JSON.stringify([{ startId: "m00150", endId: "m00220", summary: stub }]) });
    const messages2 = [summary("b0"), toolCall("c1", stubbed), tail()];
    assert.deepEqual(ids(stripKernelSummaries(messages2, pluginState("m00150", "m00220"))), ids(messages2));
});

test("preflight block (no compressCallId) always keeps its anchor, even with a full line-format call", () => {
    const body = "m00150–m00220 topic\n" + "s".repeat(250);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "b0", active: true }]));
    assert.deepEqual(ids(out), ids(messages));
});

// Kernel-parity rows: the carrier index must accept exactly the header forms
// the kernel's parseLineEntry accepts (kernel/src/parse-compress-input.ts) —
// the nudge's tier condensation/distillation drives b-ref (block-id) headers,
// and merged blocks keep startRef="bN" verbatim (kernel compress.ts).

test("line-format b-ref pair (the nudge's tier-condensation header) -> stripped", () => {
    const body = "b5–b9 合并\n" + "s".repeat(250);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("b5", "b9"));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("line-format unpadded m-refs normalize to the block's padded refs -> stripped", () => {
    const body = "m150–m220 topic\n" + "s".repeat(250);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("line-format alt separators (tilde / ellipsis / to) -> stripped", () => {
    for (const sep of ["~", "…", "to"]) {
        const body = `m00150${sep}m00220 topic\n` + "s".repeat(250);
        const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
        const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
        assert.deepEqual(ids(out), ["tc_c1", "u0"], `separator ${JSON.stringify(sep)}`);
    }
});

test("line-format single-ref header (startRef == endRef) -> stripped", () => {
    const body = "m00150\n" + "s".repeat(250);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00150"));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("line-format pair with unrecognized separator is kernel-rejected -> never registered -> kept", () => {
    const body = "m00150 ? m00220 topic\n" + "s".repeat(250);
    const messages = [summary("b0"), toolCall("c1", lineArgs(body)), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ids(messages));
});

test("JSON entries with the kernel's canonical startRef/endRef field names -> stripped", () => {
    const args = JSON.stringify({ content: [{ startRef: "m00150", endRef: "m00220", summary: "s".repeat(300) }] });
    const messages = [summary("b0"), toolCall("c1", args), tail()];
    const out = stripKernelSummaries(messages, pluginState("m00150", "m00220"));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});
