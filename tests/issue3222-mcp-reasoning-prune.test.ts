// #3222 必改 1: dropCompressReasoning recognized only the bare "compress" tool
// name, so MCP-lane reasoning (mcp__bili__compress) was never cleaned even with
// compress.reasoning.drop enabled. On top of that, the drop ran AFTER
// core.processTurn, whose hide-compress-calls node removes inactive call+result
// pairs first — once the anchor is gone the preceding reasoning can no longer be
// located (the leak applies to the bare name too). Fix: plan on the INBOUND
// history before processTurn, apply by id after processing; the selector uses
// isMcpBiliCompress. No new config surface (reuses compress.reasoning.*).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, type CompressionBlock } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { dropCompressReasoning, type CompressReasoningConfig } from "../src/reasoning-drop.ts";
import { applyReasoningDrop, planReasoningDrop, stripKernelSummaries, withReasoningDrop } from "../src/server.ts";
import { loadOptions } from "../src/config.ts";

const R = (id: string, text: string): BiliMessage => ({ id, role: "assistant", contentType: "reasoning", text });
const CALL = (toolName: string, toolCallId: string, id: string): BiliMessage => ({ id, role: "assistant", contentType: "tool-call", toolName, toolCallId, text: "{}" });
const RESULT = (toolName: string, toolCallId: string, id: string): BiliMessage => ({ id, role: "user", contentType: "tool-result", toolName, toolCallId, text: "ok" });
const USER = (id: string, text: string): BiliMessage => ({ id, role: "user", contentType: "text", text });

const CFG: CompressReasoningConfig = { drop: true, threshold: 0 };
const NOOP_LOG = (_level: string, _msg: string): void => {};

function closedRound(name: string): BiliMessage[] {
    return [R("r1", "x".repeat(3000)), CALL(name, "c1", "c1"), RESULT(name, "c1", "c1r"), USER("u2", "continue")];
}

for (const name of ["compress", "mcp__bili__compress"]) {
    test(`#3222 parity (${name}): closed-round reasoning is dropped with {drop:true, threshold:0}`, () => {
        const out = dropCompressReasoning(closedRound(name), CFG);
        assert.equal(out.filter((m) => m.contentType === "reasoning").length, 0);
        assert.equal(out.length, 3);
    });

    test(`#3222 parity (${name}): drop:false kill-switch keeps reasoning`, () => {
        const out = dropCompressReasoning(closedRound(name), { drop: false, threshold: 0 });
        assert.equal(out.filter((m) => m.contentType === "reasoning").length, 1);
    });

    test(`#3222 parity (${name}): below-threshold reasoning survives default config`, () => {
        const out = dropCompressReasoning([R("r1", "small"), CALL(name, "c1", "c1"), RESULT(name, "c1", "c1r"), USER("u2", "next")]);
        assert.equal(out.filter((m) => m.contentType === "reasoning").length, 1);
    });

    test(`#3222 parity (${name}): pending call (no result) keeps its reasoning`, () => {
        const out = dropCompressReasoning([R("r1", "x".repeat(3000)), CALL(name, "c1", "c1"), USER("u2", "next")], CFG);
        assert.equal(out.filter((m) => m.contentType === "reasoning").length, 1);
    });

    test(`#3222 parity (${name}): result still the last message keeps its reasoning`, () => {
        const out = dropCompressReasoning([USER("q0", "q"), R("r1", "x".repeat(3000)), CALL(name, "c1", "c1"), RESULT(name, "c1", "c1r")], CFG);
        assert.equal(out.filter((m) => m.contentType === "reasoning").length, 1);
    });

    test(`#3222 parity (${name}): strictEcho disables the drop`, () => {
        const out = withReasoningDrop(closedRound(name), CFG, NOOP_LOG, "s3222", true);
        assert.equal(out.filter((m) => m.contentType === "reasoning").length, 1);
    });

    test(`#3222 parity (${name}): signed thinking blocks disable the drop`, () => {
        const msgs = [{ ...R("r1", "x".repeat(3000)), thinkingSignature: "sig" }, ...closedRound(name).slice(1)];
        const out = withReasoningDrop(msgs, CFG, NOOP_LOG, "s3222", false);
        assert.equal(out.filter((m) => m.contentType === "reasoning").length, 1);
    });
}

test("#3222: other tools keep their reasoning for both name forms", () => {
    for (const name of ["bash", "mcp__other__thing", "mcp__bili__acp_rule"]) {
        const out = dropCompressReasoning(closedRound(name), CFG);
        assert.equal(out.filter((m) => m.contentType === "reasoning").length, 1, `${name} must not be selected`);
    }
});

// Request-order regression: drive the REAL kernel pipeline. A superseded block's
// call+result pair is hidden by hide-compress-calls INSIDE processTurn; the old
// post-hoc drop then lost its anchor and leaked the pre-call reasoning. The fix
// plans on the inbound history (anchors present) and applies by id afterwards.
// syncBlocks keeps b1 inactive only while a parent (b2) consumes it via
// directBlockIds — a bare active:false flag would be re-activated mid-pipeline.
function orderFixture(name: string) {
    const state = createInitialState();
    state.blocks.push({
        blockId: "b1", runId: "r0", tier: 1, summary: "s1", directMessageIds: [],
        effectiveMessageIds: ["h1", "h2"], directBlockIds: [], createdAt: 0,
        survivedCount: 0, generation: "young", active: false, compressCallId: "c1",
        compressedTokens: 0,
    } as CompressionBlock);
    state.blocks.push({
        blockId: "b2", runId: "r1", tier: 2, summary: "s2", directMessageIds: [],
        effectiveMessageIds: [], directBlockIds: ["b1"], createdAt: 0,
        survivedCount: 0, generation: "young", active: true, compressedTokens: 0,
    } as CompressionBlock);
    const inbound: BiliMessage[] = [
        USER("h1", "old question"),
        { id: "h2", role: "assistant", contentType: "text", text: "old answer" },
        R("r1", "x".repeat(3000)),
        CALL(name, "c1", "c1"),
        RESULT(name, "c1", "c1r"),
        USER("u2", "continue"),
    ];
    return { state, inbound };
}

for (const name of ["compress", "mcp__bili__compress"]) {
    test(`#3222 ordering (${name}): hidden inactive pair does not leak its pre-call reasoning`, () => {
        const core = createCore();
        const config = loadOptions({}).kernelConfig;
        const { state, inbound } = orderFixture(name);

        const plan = planReasoningDrop(inbound, CFG, false);
        assert.ok(plan.has("r1"), "plan computed on inbound history sees the closed round");

        const turn = core.processTurn({ messages: inbound, state, config, tokenCount: 100, renderTags: "text-only" });
        const turnIds = turn.messages.map((m) => m.id);
        assert.ok(!turnIds.includes("c1") && !turnIds.includes("c1r"), "inactive pair is hidden inside processTurn (scenario precondition)");

        // Old behavior: computing the drop on the post-turn view misses the
        // anchor entirely and leaks r1. Pin that gap explicitly.
        const postHoc = dropCompressReasoning(turn.messages as BiliMessage[], CFG);
        assert.ok(postHoc.some((m) => m.id === "r1"), "post-hoc computation leaks the reasoning (pre-fix semantics)");

        const outbound = applyReasoningDrop(stripKernelSummaries(turn.messages as BiliMessage[], turn.state), plan, NOOP_LOG, "s3222");
        assert.ok(!outbound.some((m) => m.id === "r1"), "planned drop removes the reasoning despite the hidden anchor");
    });
}
