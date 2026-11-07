// #3975 end state: after consumed-call cleanup + carrier-aware strip, a
// PLAIN-TEXT MCP compress call must end up exactly like its object-array twin
// — args stubbed to 200 chars while the kernel's acp_summary anchor stays as
// the SOLE complete carrier. Pins issue expectations 2/3 ("every active block
// keeps at least one full summary"; "a stub is not a complete carrier") and
// guards against the tempting wrong fix: widening buildCarrierIndex's tool-name
// match to mcp__bili__compress would strip this anchor and leave only the stub
// (full-text loss).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, hideConsumedCompressCalls, type CompressionBlock, type CompressionState, type CoreMessage } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { isMcpBiliCompress } from "../src/config.ts";
import { stripKernelSummaries } from "../src/server.ts";

// Single-line on purpose: the line form splits on ref-header lines, so a
// multi-line summary would make per-line assertions ambiguous (the stub keeps
// internal newlines verbatim).
const FULL = "# Task progress " + "detail line that carries real content ".repeat(60);

function makeState(): CompressionState {
    const state = createInitialState();
    const block: CompressionBlock = {
        blockId: "b0",
        runId: "r0",
        tier: 1,
        topic: "Task progress",
        summary: FULL,
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 0,
        createdAt: 1000,
        survivedCount: 0,
        generation: "young",
        active: true,
        compressCallId: "plugin_123",
        startRef: "m00100",
        endRef: "m00120",
    };
    state.blocks.push(block);
    return state;
}

function history(contentValue: unknown): CoreMessage[] {
    return [
        { id: "acp_summary_b0", role: "system", contentType: "text", text: FULL },
        { id: "tc_c1", role: "assistant", contentType: "tool-call", toolName: "mcp__bili__compress", toolCallId: "c1", text: JSON.stringify({ content: contentValue }) },
        { id: "tr_c1", role: "tool", contentType: "tool-result", toolCallId: "c1", text: "ok" },
        { id: "u1", role: "user", contentType: "text", text: "tail" },
    ];
}

function cleanedThenStripped(contentValue: unknown): CoreMessage[] {
    const state = makeState();
    const cleaned = hideConsumedCompressCalls(state, history(contentValue), isMcpBiliCompress).messages;
    return stripKernelSummaries(cleaned as BiliMessage[], state) as CoreMessage[];
}

test("#3975: plain-text MCP call ends stubbed, anchor kept as sole full carrier", () => {
    const out = cleanedThenStripped(`m00100–m00120 Task progress\n${FULL}`);

    const call = out.find((m) => m.id === "tc_c1");
    assert.ok(call, "call pair survives (active range)");
    const args: { content: unknown } = JSON.parse(call!.text!.slice(call!.text!.indexOf("{")));
    assert.equal(typeof args.content, "string", "line-form string shape preserved");
    const lines = (args.content as string).split("\n");
    assert.equal(lines[0], "m00100–m00120 Task progress", "header verbatim");
    assert.ok(lines[1]!.length <= 200 && lines[1]!.endsWith("…"), "call-arg summary stubbed");
    assert.ok(!call!.text!.includes(FULL), "no full copy left in rendered args");

    const anchor = out.find((m) => m.id === "acp_summary_b0");
    assert.ok(anchor, "anchor kept — the stub is NOT a complete carrier");
    assert.equal(anchor!.text, FULL, "sole remaining full summary is byte-complete");
});

test("#3975: object-array MCP call keeps its pre-existing end state (parity pin)", () => {
    const out = cleanedThenStripped([{ startId: "m00100", endId: "m00120", topic: "Task progress", summary: FULL }]);

    const call = out.find((m) => m.id === "tc_c1")!;
    const args: { content: unknown } = JSON.parse(call.text!.slice(call.text!.indexOf("{")));
    assert.ok(Array.isArray(args.content), "object-array shape preserved");
    const entry = (args.content as { summary: string }[])[0]!;
    assert.equal(entry.summary.length, 200, "stubbed exactly like the plain-text lane");
    assert.ok(!call.text!.includes(FULL));

    const anchor = out.find((m) => m.id === "acp_summary_b0");
    assert.ok(anchor, "anchor kept for object-array calls too (unchanged behavior)");
    assert.equal(anchor!.text, FULL);
});
