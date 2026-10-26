import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { anthropicToCore, coreToAnthropic } from "acp-kernel/wire";
import type { AnthropicRequestBody } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";

// #1960 (steady path): after an in-turn compress, the client (pi) re-sends the
// FULL round-1 response as history — including the redacted_thinking block that
// sat between the signed thinking and the compress tool_use. The steady prepare
// path (anthropicToCore → processTurn → coreToAnthropic) used to drop that block
// silently (anthropicToCore had no case for it), so every later request rebuilt
// the latest assistant message without it and Anthropic answered 400 "thinking
// or redacted_thinking blocks ... cannot be modified" forever.
//
// This pins the steady contract: a client-echoed redacted_thinking block must
// come back out byte-identical and position-identical. Requires acp-kernel
// >= 0.0.101 (kernel PR ranxianglei/acp-kernel#500); fails on 0.0.99.

const THINKING_TEXT = "I should compress the old turns first before continuing.";
const SIG = "sig-steady-xyz789";
const RDT_DATA = "EvAFCkYIBxgCKkBkcm9kdGVkLXRoaW5raW5nLXByb2JlLTE5NjAAAA==";
const COMPRESS_CALL_ID = "toolu_c1960s";

const COMPRESS_CONTENT = [
    { type: "thinking", thinking: THINKING_TEXT, signature: SIG },
    { type: "redacted_thinking", data: RDT_DATA },
    { type: "tool_use", id: COMPRESS_CALL_ID, name: "compress", input: { ranges: ["m00003–m00004"] } },
] as const;

function makeSession(): Session {
    return {
        id: "issue1960-steady-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100, contextTokens: 100, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        pendingRetrievals: [],
        persisted: false,
    };
}

// pi's next request after the compress turn: the full round-1 assistant message
// (thinking + redacted + compress tool_use) echoed back, answered by its
// tool_result, then the user's follow-up.
function inbound(): Record<string, unknown> {
    return {
        model: "claude-sonnet-5",
        stream: true,
        system: "You are a coding agent.",
        messages: [
            { role: "user", content: "seed: audit the migration." },
            { role: "assistant", content: [{ type: "text", text: "Working on it." }] },
            { role: "user", content: "the context is getting long, please compress the old turns" },
            { role: "assistant", content: [...COMPRESS_CONTENT] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: COMPRESS_CALL_ID, content: "[ACP] Compressed m00003–m00004 (shrink 20%)" }] },
            { role: "user", content: "and now the follow-up question, please continue" },
        ],
    };
}

test("#1960 steady path: client-echoed redacted_thinking survives prepare→outbound verbatim", () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const { msgs } = anthropicToCore(inbound() as AnthropicRequestBody) as { msgs: CoreMessage[] };
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 100, renderTags: "text-only" });

    const outbound = coreToAnthropic(turn.messages) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const holder = outbound.find((m) =>
        m.role === "assistant" &&
        m.content.some((b) => b.type === "tool_use" && (b as { id?: string }).id === COMPRESS_CALL_ID)
    );
    assert.ok(holder, "outbound must still contain the assistant message holding the compress tool_use");
    assert.deepEqual(holder!.content, [...COMPRESS_CONTENT], "thinking + redacted_thinking + tool_use must round-trip byte-identical in order");
});
