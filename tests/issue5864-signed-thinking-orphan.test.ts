// #5864: Anthropic 400 "The final block in an assistant message cannot be
// `thinking`" right after a `[thinking, tool_use:compress]` turn whose
// compress block has gone inactive (a later fold consumed it).
//
// Root cause: two independent decisions about the same assistant turn can each
// be locally correct yet jointly illegal.
//   1. src/server.ts planReasoningDrop returns an EMPTY set whenever ANY signed
//      thinking block is in view (hasSignedThinkingBlock gate, #1658/#1960):
//      dropping a signed thinking block would desync its signature, so the
//      pre-compress reasoning is NEVER dropped on extended-thinking sessions.
//   2. kernel hideConsumedCompressCalls removes an INACTIVE compress call+result
//      pair independently of what precedes it.
// When both fire — the pair is hidden but the signed thinking survives — the
// assistant message collapses to `[thinking]`, which Anthropic rejects. Only
// turns where the fold boundary left the pair inactive while the signed
// thinking was still in the resent window hit it (hence 5-of-27 in the report).
//
// Fix: the hide decision must not strand a protected (signed) thinking block as
// the final block of its assistant message — keep the pair visible instead.
// On the Anthropic wire thinking is always signed (extended-thinking on ⇒
// signed; off ⇒ absent), so guarding signed thinking is sufficient and leaves
// the unsigned #3222 behavior (drop the reasoning, hide the pair) untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, type CompressionBlock } from "acp-kernel";
import { coreToAnthropic, type BiliMessage } from "acp-kernel/wire";
import { applyReasoningDrop, planReasoningDrop, stripKernelSummaries } from "../src/server.ts";
import { loadOptions } from "../src/config.ts";

const R = (id: string, text: string, sig?: string): BiliMessage => ({ id, role: "assistant", contentType: "reasoning", text, ...(sig ? { thinkingSignature: sig } : {}) });
const CALL = (toolName: string, toolCallId: string, id: string): BiliMessage => ({ id, role: "assistant", contentType: "tool-call", toolName, toolCallId, text: "{}" });
const RESULT = (toolName: string, toolCallId: string, id: string): BiliMessage => ({ id, role: "user", contentType: "tool-result", toolName, toolCallId, text: "ok" });
const USER = (id: string, text: string): BiliMessage => ({ id, role: "user", contentType: "text", text });

const CFG = { drop: true, threshold: 0 };
const NOOP_LOG = (_level: string, _msg: string): void => {};

/** Inactive compress block b1 (call c1) already consumed by active parent b2 —
 *  the exact shape that makes hideConsumedCompressCalls classify c1 "inactive". */
function inactiveBlockState(): ReturnType<typeof createInitialState> {
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
    return state;
}

function inboundWithThinking(sig?: string): BiliMessage[] {
    return [
        USER("h1", "old question"),
        { id: "h2", role: "assistant", contentType: "text", text: "old answer" },
        R("r1", "x".repeat(3000), sig),
        CALL("mcp__bili__compress", "c1", "c1"),
        RESULT("mcp__bili__compress", "c1", "c1r"),
        USER("u2", "continue"),
    ];
}

/** Drive the steady request path exactly as prepare-anthropic.ts does
 *  (plan before processTurn -> processTurn -> stripKernelSummaries ->
 *  applyReasoningDrop -> coreToAnthropic) and return the outbound wire. */
function outboundWire(inbound: BiliMessage[]) {
    const state = inactiveBlockState();
    const core = createCore();
    const config = loadOptions({}).kernelConfig;
    const plan = planReasoningDrop(inbound, CFG, false);
    const turn = core.processTurn({ messages: inbound, state, config, tokenCount: 100, renderTags: "text-only" });
    const processed = applyReasoningDrop(stripKernelSummaries(turn.messages as BiliMessage[], turn.state), plan, NOOP_LOG, "s5864");
    const wire = coreToAnthropic(processed, undefined) as Array<{ role: string; content: unknown }>;
    return { plan, wire, turnMessages: turn.messages.map((m) => m.id) };
}

/** True when any assistant message's FINAL content block is a thinking-family
 *  block — the exact shape Anthropic rejects with the 400 in #5864. */
function hasThinkingFinalAssistant(wire: Array<{ role: string; content: unknown }>): boolean {
    for (const msg of wire) {
        if (msg.role !== "assistant") continue;
        if (!Array.isArray(msg.content)) continue;
        const last = msg.content[msg.content.length - 1] as { type?: string } | undefined;
        if (last && (last.type === "thinking" || last.type === "redacted_thinking")) return true;
    }
    return false;
}

test("#5864: signed thinking before an inactive compress call must not be stranded as the final block", () => {
    const { plan, wire, turnMessages } = outboundWire(inboundWithThinking("sig-abc"));
    assert.equal(plan.size, 0, "signed thinking disables planReasoningDrop (#1658/#1960)");
    // #5864 FIX: the immediate predecessor of the inactive compress call is a
    // signed thinking block, so the consumed-call pass keeps the pair VISIBLE
    // instead of hiding it — hiding would strand the thinking block as the
    // final block of its assistant message (upstream 400).
    assert.ok(turnMessages.includes("c1"), "inactive compress call kept visible (signed-thinking predecessor)");
    assert.ok(turnMessages.includes("c1r"), "inactive compress result kept visible with its call");
    assert.equal(hasThinkingFinalAssistant(wire), false, "no assistant message ends in a thinking/redacted_thinking block (#5864)");
});

test("#5864 control: UNSIGNED thinking still takes the #3222 path (reasoning dropped, no orphan)", () => {
    const { plan, wire } = outboundWire(inboundWithThinking());
    assert.ok(plan.has("r1"), "unsigned closed-round reasoning is dropped (#3222/#651)");
    assert.equal(hasThinkingFinalAssistant(wire), false, "unsigned path never strands a thinking-final block");
});
