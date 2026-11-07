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
// Fix: the hide decision must not strand a protected (signed thinking /
// redacted_thinking) block anywhere in the SAME assistant message — keep every
// compress pair whose assistant run holds one, not just the pair immediately
// after the thinking (an intervening text/tool core between the thinking and the
// call is common, and signed thinking must round-trip with its tool_use sibling
// per #1658/#1960/#684). On the Anthropic wire thinking is always signed
// (extended-thinking on ⇒ signed; off ⇒ absent), so guarding signed thinking is
// sufficient and leaves the unsigned #3222 behavior (drop the reasoning, hide the
// pair) untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, type CompressionBlock } from "acp-kernel";
import { coreToAnthropic, type BiliMessage } from "acp-kernel/wire";
import { applyReasoningDrop, planReasoningDrop, stripKernelSummaries } from "../src/server.ts";
import { loadOptions } from "../src/config.ts";

const THINKING = "x".repeat(3000);
const R = (id: string, sig?: string): BiliMessage => ({ id, role: "assistant", contentType: "reasoning", text: THINKING, ...(sig ? { thinkingSignature: sig } : {}) });
const REDACTED = (id: string): BiliMessage => ({ id, role: "assistant", contentType: "text", text: "[redacted_thinking]", rawAnthropicBlock: { type: "redacted_thinking", data: "dGVzdA==" } });
const TEXT = (id: string, text: string): BiliMessage => ({ id, role: "assistant", contentType: "text", text });
const CALL = (toolCallId: string, id: string): BiliMessage => ({ id, role: "assistant", contentType: "tool-call", toolName: "mcp__bili__compress", toolCallId, text: "{}" });
const RESULT = (toolCallId: string, id: string): BiliMessage => ({ id, role: "user", contentType: "tool-result", toolName: "mcp__bili__compress", toolCallId, text: "ok" });
const USER = (id: string, text: string): BiliMessage => ({ id, role: "user", contentType: "text", text });

const CFG = { drop: true, threshold: 0 };
const NOOP_LOG = (_level: string, _msg: string): void => {};

/** Inactive compress block(s) already consumed by an active parent — the exact
 *  shape that makes hideConsumedCompressCalls classify their calls "inactive". */
function blockState(callIds: string[]): ReturnType<typeof createInitialState> {
    const state = createInitialState();
    const consumed: string[] = [];
    callIds.forEach((callId, n) => {
        const blockId = `b${n + 1}`;
        state.blocks.push({
            blockId, runId: `r${n}`, tier: 1, summary: `s${n}`, directMessageIds: [],
            effectiveMessageIds: ["h1", "h2"], directBlockIds: [], createdAt: 0,
            survivedCount: 0, generation: "young", active: false, compressCallId: callId,
            compressedTokens: 0,
        } as CompressionBlock);
        consumed.push(blockId);
    });
    state.blocks.push({
        blockId: "bTop", runId: "rTop", tier: 2, summary: "top", directMessageIds: [],
        effectiveMessageIds: [], directBlockIds: consumed, createdAt: 0,
        survivedCount: 0, generation: "young", active: true, compressedTokens: 0,
    } as CompressionBlock);
    return state;
}

/** Drive the steady request path exactly as prepare-anthropic.ts does
 *  (plan before processTurn -> processTurn -> stripKernelSummaries ->
 *  applyReasoningDrop -> coreToAnthropic) and return the outbound wire. */
function outboundWire(inbound: BiliMessage[], callIds: string[] = ["c1"]) {
    const state = blockState(callIds);
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

/** The first signed thinking block on the outbound wire, for byte-equality
 *  checks (#1960: the block must round-trip verbatim even when its sibling
 *  compress pair's args are compacted elsewhere in hide-consumed). */
function thinkingBlockOf(wire: Array<{ role: string; content: unknown }>): { thinking?: string; signature?: string } | undefined {
    for (const msg of wire) {
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
        for (const b of msg.content as Array<{ type?: string; thinking?: string; signature?: string }>) {
            if (b.type === "thinking") return b;
        }
    }
    return undefined;
}

test("#5864: signed thinking before an inactive compress call must not be stranded", () => {
    const inbound = [USER("h1", "old question"), TEXT("h2", "old answer"), R("r1", "sig-abc"), CALL("c1", "c1"), RESULT("c1", "c1r"), USER("u2", "continue")];
    const { plan, wire, turnMessages } = outboundWire(inbound);
    assert.equal(plan.size, 0, "signed thinking disables planReasoningDrop (#1658/#1960)");
    assert.ok(turnMessages.includes("c1"), "inactive compress call kept visible (signed-thinking predecessor)");
    assert.ok(turnMessages.includes("c1r"), "inactive compress result kept visible with its call");
    assert.equal(hasThinkingFinalAssistant(wire), false, "no assistant message ends in a thinking/redacted_thinking block (#5864)");
    // #1960: the signed thinking block itself reaches the wire byte-exact,
    // independent of whatever the kept pair's args look like downstream.
    const tb = thinkingBlockOf(wire);
    assert.ok(tb, "a signed thinking block is present on the outbound wire");
    assert.equal(tb!.thinking, THINKING, "thinking text round-trips verbatim");
    assert.equal(tb!.signature, "sig-abc", "thinking signature round-trips verbatim");
});

test("#5864: intervening text between signed thinking and compress still keeps the sibling", () => {
    // [thinking, text, compress]: the immediate predecessor of the call is text,
    // so an immediate-predecessor guard would hide the pair and strand the signed
    // thinking (its tool_use sibling gone). The run-aware guard keeps it.
    const inbound = [USER("h1", "q"), R("r1", "sig-abc"), TEXT("t1", "I'll compress now"), CALL("c1", "c1"), RESULT("c1", "c1r"), USER("u2", "continue")];
    const { plan, wire, turnMessages } = outboundWire(inbound);
    assert.equal(plan.size, 0, "signed thinking disables planReasoningDrop");
    assert.ok(turnMessages.includes("c1"), "compress pair kept despite intervening text (run-aware, #5864)");
    assert.equal(hasThinkingFinalAssistant(wire), false, "no assistant message ends in a thinking block");
});

test("#5864: multi-compress turn keeps the thinking's sibling, hides the rest", () => {
    // [thinking, compress_1, compress_2]: compress_1 sits in the thinking's run and
    // is kept; compress_2 begins a new run after compress_1's user-role result and
    // is hidden. The thinking keeps a tool_use sibling either way.
    const inbound = [USER("h1", "q"), R("r1", "sig-abc"), CALL("c1", "c1"), RESULT("c1", "c1r"), CALL("c2", "c2"), RESULT("c2", "c2r"), USER("u2", "continue")];
    const { plan, wire, turnMessages } = outboundWire(inbound, ["c1", "c2"]);
    assert.equal(plan.size, 0, "signed thinking disables planReasoningDrop");
    assert.ok(turnMessages.includes("c1"), "first compress (same run as thinking) kept");
    assert.ok(!turnMessages.includes("c2"), "second compress (new run) hidden");
    assert.equal(hasThinkingFinalAssistant(wire), false, "no assistant message ends in a thinking block");
});

test("#5864: redacted_thinking before an inactive compress call is protected too", () => {
    // redacted_thinking rides a text core as rawAnthropicBlock (#1960); it arms
    // both the drop gate and the strand guard identically to signed thinking.
    const inbound = [USER("h1", "q"), REDACTED("rd1"), CALL("c1", "c1"), RESULT("c1", "c1r"), USER("u2", "continue")];
    const { plan, wire, turnMessages } = outboundWire(inbound);
    assert.equal(plan.size, 0, "redacted_thinking disables planReasoningDrop (#1960)");
    assert.ok(turnMessages.includes("c1"), "compress pair kept (redacted_thinking predecessor)");
    assert.equal(hasThinkingFinalAssistant(wire), false, "no assistant message ends in a thinking/redacted_thinking block");
});

test("#5864 control: UNSIGNED thinking takes the #3222 path (reasoning dropped, pair hidden)", () => {
    const inbound = [USER("h1", "old question"), TEXT("h2", "old answer"), R("r1"), CALL("c1", "c1"), RESULT("c1", "c1r"), USER("u2", "continue")];
    const { plan, wire, turnMessages } = outboundWire(inbound);
    assert.ok(plan.has("r1"), "unsigned closed-round reasoning is dropped (#3222/#651)");
    assert.ok(!turnMessages.includes("c1"), "unsigned path hides the consumed pair (#3222)");
    assert.equal(hasThinkingFinalAssistant(wire), false, "unsigned path never strands a thinking-final block");
});
