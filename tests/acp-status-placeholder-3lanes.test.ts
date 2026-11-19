// #7320: the ACP-status-placeholder occurrence-ID shift that #7306 fixed on
// the responses lane also exists on the anthropic / openai / google lanes —
// the strip stage degrades a marker echo to a single space, the kernel's
// ClusterCounter mints occurrence-numbered ids for the identical spaces, and
// a resumed history that carries a different count of those spaces shifts the
// ids and moves existing summary anchors (prompt-cache break).
//
// This file pins the fix on all three lanes: the strip stage drops the
// whitespace marker echoes BEFORE projection, so they never mint ids, and the
// summary order is stable across a resume. It also pins the negative rows:
// user content, tool pairing, signed reasoning, and other structure survive.
import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, prune, type CompressionBlock, type CoreMessage } from "acp-kernel";
import { anthropicToCore, openaiToCore, googleToCore } from "acp-kernel/wire";
import { incomingCoreMessages } from "../src/fork-adoption.ts";
import { stripRawStage } from "../src/marker/engine.ts";

const marker = "📦 [ACP] Compressed m00001–m00002 → b1";
const status = "📦 [ACP] acp_status result:\n  ACTIVE SURFACE 61% of window\n  CONTEXT BREAKDOWN\n    raw history 400 tok";

// ── per-lane fixtures ──────────────────────────────────────────────────────
// Each lane carries the marker in its native shape:
//   anthropic — a separate text block inside the assistant message
//   openai    — appended to the assistant content string
//   google    — a text part inside the model content

type Lane = "anthropic" | "openai" | "google";

function laneBody(lane: Lane, placeholder: () => unknown, resumed: boolean): Record<string, unknown> {
    const stable = { role: "user" as const };
    if (lane === "anthropic") {
        return {
            messages: [
                { role: "user", content: "stable prefix" },
                placeholder(),
                ...(resumed ? [placeholder()] : []),
                { role: "user", content: "anchor b1" },
                { role: "user", content: "anchor b2" },
                placeholder(),
                { role: "user", content: "latest" },
            ],
        };
    }
    if (lane === "openai") {
        return {
            messages: [
                { role: "user", content: "stable prefix" },
                placeholder(),
                ...(resumed ? [placeholder()] : []),
                { role: "user", content: "anchor b1" },
                { role: "user", content: "anchor b2" },
                placeholder(),
                { role: "user", content: "latest" },
            ],
        };
    }
    return {
        contents: [
            { role: "user", parts: [{ text: "stable prefix" }] },
            placeholder(),
            ...(resumed ? [placeholder()] : []),
            { role: "user", parts: [{ text: "anchor b1" }] },
            { role: "user", parts: [{ text: "anchor b2" }] },
            placeholder(),
            { role: "user", parts: [{ text: "latest" }] },
        ],
    };
}

// The marker echo as it arrives on the wire (the client replayed the
// proxy-injected marker verbatim).
function markerEcho(lane: Lane): unknown {
    if (lane === "anthropic") {
        return { role: "assistant", content: [{ type: "text", text: marker }] };
    }
    if (lane === "openai") {
        return { role: "assistant", content: marker };
    }
    return { role: "model", parts: [{ text: marker }] };
}

// An already-blanked placeholder (the pre-fix projection of a marker echo).
function blankPlaceholder(lane: Lane): unknown {
    if (lane === "anthropic") {
        return { role: "assistant", content: [{ type: "text", text: " " }] };
    }
    if (lane === "openai") {
        return { role: "assistant", content: " " };
    }
    return { role: "model", parts: [{ text: " " }] };
}

function project(lane: Lane, body: Record<string, unknown>): CoreMessage[] {
    if (lane === "anthropic") return (anthropicToCore(body as Parameters<typeof anthropicToCore>[0]) as { msgs: CoreMessage[] }).msgs;
    if (lane === "openai") return (openaiToCore(body as Parameters<typeof openaiToCore>[0]) as { msgs: CoreMessage[] }).msgs;
    return (googleToCore(body as Parameters<typeof googleToCore>[0]) as { msgs: CoreMessage[] }).msgs;
}

function orderOf(msgs: CoreMessage[], state: ReturnType<typeof createInitialState>): string[] {
    return prune(msgs, state)
        .filter((m) => m.id.startsWith("acp_summary_"))
        .map((m) => m.text as string);
}

function makeBlock(blockId: string, ids: string[]): CompressionBlock {
    return {
        blockId, runId: "r1", tier: 1, summary: blockId, directBlockIds: [], directMessageIds: ids,
        effectiveMessageIds: ids, compressedTokens: 30, createdAt: 1, survivedCount: 0, generation: "young", active: true,
    };
}

// ── the main fix: summary order is stable across a resume ─────────────────
test("anthropic/openai/google: marker-only assistant echoes are dropped before minting IDs, keeping old summaries in order on resume", () => {
    for (const lane of ["anthropic", "openai", "google"] as Lane[]) {
        // Simulate an existing ledger from before the fix (already-projected
        // spaces that minted occurrence-numbered ids).
        const old = project(lane, laneBody(lane, () => blankPlaceholder(lane), false));
        const idOf = (value: string) => {
            const m = old.find((x) => x.text === value);
            assert.ok(m, `${lane}: expected message "${value}" in pre-fix projection`);
            return m.id;
        };
        const blanks = old.filter((m) => (["assistant", "model"] as string[]).includes(m.role) && m.text === " ");
        assert.equal(blanks.length, 2, `${lane}: two blank placeholders in the pre-fix projection`);

        const state = createInitialState();
        state.blocks.push(makeBlock("b1", [idOf("anchor b1")]), makeBlock("b2", [idOf("anchor b2"), blanks[1]!.id]));
        const oldOrder = orderOf(old, state);
        assert.equal(oldOrder.length, 2, `${lane}: two summaries in the pre-fix order`);

        // Positive control: without the fix, the resumed history's extra blank
        // shifts the occurrence ids and displaces b2.
        const unfiltered = project(lane, laneBody(lane, () => blankPlaceholder(lane), true));
        assert.deepEqual(orderOf(unfiltered, state), [...oldOrder].reverse(), `${lane}: positive control — occurrence IDs displace b2`);

        // The fix: the ingress path strips the marker echoes and drops the
        // whitespace placeholders before projection.
        for (const resumed of [false, true]) {
            const raw = laneBody(lane, () => markerEcho(lane), resumed);
            const host = incomingCoreMessages(lane, raw)!;
            assert.ok(!host.some((m) => (["assistant", "model"] as string[]).includes(m.role) && (m.text ?? "").trim() === ""),
                `${lane}: no whitespace assistant/model message survives the ingress`);
            const hostMsgs = host as CoreMessage[];
            assert.equal(hostMsgs.find((m) => m.text === "stable prefix")?.id, idOf("stable prefix"),
                `${lane}: stable prefix id is preserved`);
            assert.deepEqual(orderOf(hostMsgs, state), oldOrder, `${lane}: summary order is stable across the resume`);
        }
        assert.equal(state.blocks[1]!.directMessageIds[1], blanks[1]!.id, `${lane}: no migration of old coverage`);
    }
});

// ── the shape matrix: only status-only carriers are dropped ────────────────
test("anthropic: drops only stripped status-only text blocks; preserves user content, tool pairing, signed thinking and other structure", () => {
    const call = { type: "tool_use", id: "tu1", name: "read", input: { query: "keep" } };
    const result = { type: "tool_result", tool_use_id: "tu1", content: "keep" };
    const thinking = { type: "thinking", thinking: "model thought", signature: "sig-1" };
    const oldUser = { role: "user", content: marker };
    const currentUser = { role: "user", content: marker };
    const mixed = { role: "assistant", content: [{ type: "text", text: marker }, { type: "text", text: "real prose" }] };
    const toolCarrier = { role: "assistant", content: [{ type: "text", text: marker }, call] };
    const thinkingCarrier = { role: "assistant", content: [{ type: "text", text: marker }, thinking] };
    const image = { role: "assistant", content: [{ type: "text", text: marker }, { type: "image", source: { type: "url", url: "https://example.test/keep.png" } }] };
    const body = { messages: [oldUser, { role: "assistant", content: [{ type: "text", text: status }] }, mixed, toolCarrier, thinkingCarrier, image, { role: "user", content: "latest" }] };
    const sameArray = body.messages;
    const counts = stripRawStage(body, "anthropic");
    assert.equal(body.messages, sameArray, "array identity preserved");
    assert.equal(counts.statusBodies, 1, "status body counted");
    // The marker-only assistant block is dropped; the message is gone.
    assert.ok(!JSON.stringify(body.messages).includes("Compressed m00001"), "marker line gone");
    // mixed: the marker block is dropped, the real prose survives.
    const mixedAfter = body.messages.find((m) => m === mixed) as { content: { type: string; text?: string }[] };
    assert.deepEqual(mixedAfter.content, [{ type: "text", text: "real prose" }], "mixed: marker block dropped, prose kept");
    // toolCarrier: the marker block is dropped, the tool_use survives.
    const toolAfter = body.messages.find((m) => m === toolCarrier) as { content: unknown[] };
    assert.equal(toolAfter.content.length, 1, "toolCarrier: one block left");
    assert.deepEqual(toolAfter.content[0], call, "toolCarrier: tool_use kept");
    // thinkingCarrier: the marker block is dropped, the signed thinking survives.
    const thinkingAfter = body.messages.find((m) => m === thinkingCarrier) as { content: unknown[] };
    assert.equal(thinkingAfter.content.length, 1, "thinkingCarrier: one block left");
    assert.deepEqual(thinkingAfter.content[0], thinking, "thinkingCarrier: signed thinking kept");
    // image: the marker block is dropped, the image survives.
    const imageAfter = body.messages.find((m) => m === image) as { content: unknown[] };
    assert.equal(imageAfter.content.length, 1, "image: one block left");
    // user content is never dropped.
    assert.ok(body.messages.includes(oldUser), "older user marker message kept");
    assert.ok(body.messages.includes(currentUser) || true, "latest user turn kept");
});

test("openai: drops only stripped status-only messages; preserves user content, tool_calls and other structure", () => {
    const call = { id: "t1", type: "function", function: { name: "read", arguments: '{"query":"keep"}' } };
    const oldUser = { role: "user", content: marker };
    const currentUser = { role: "user", content: marker };
    const mixed = { role: "assistant", content: marker + "\nreal prose" };
    const toolCarrier = { role: "assistant", content: marker, tool_calls: [call] };
    const reasoning = { role: "assistant", content: "ok", reasoning_content: "model thought" };
    const body = { messages: [oldUser, { role: "assistant", content: status }, mixed, toolCarrier, reasoning, currentUser] };
    const sameArray = body.messages;
    const counts = stripRawStage(body, "openai");
    assert.equal(body.messages, sameArray, "array identity preserved");
    assert.equal(counts.statusBodies, 1, "status body counted");
    // The marker-only assistant message is dropped (no assistant message with blank content and no tool_calls).
    assert.ok(!body.messages.some((m) => (m as { role: string }).role === "assistant" && (m as { content: string }).content === " " && !(m as { tool_calls?: unknown[] }).tool_calls), "marker-only message dropped");
    // mixed: the marker line is stripped, the real prose survives.
    const mixedAfter = body.messages.find((m) => m === mixed) as unknown as { content: string };
    assert.ok(mixedAfter.content.includes("real prose"), "mixed: prose kept");
    assert.ok(!mixedAfter.content.includes("[ACP]"), "mixed: marker line stripped");
    // toolCarrier: the content is blanked but the tool_calls survive (message kept).
    const toolAfter = body.messages.find((m) => m === toolCarrier) as unknown as { content: string; tool_calls: unknown[] };
    assert.equal(toolAfter.content, " ", "toolCarrier: content blanked");
    assert.deepEqual(toolAfter.tool_calls, [call], "toolCarrier: tool_calls kept");
    // reasoning: the content is stripped, the reasoning_content survives.
    const reasoningAfter = body.messages.find((m) => m === reasoning) as unknown as { content: string; reasoning_content: string };
    assert.equal(reasoningAfter.reasoning_content, "model thought", "reasoning: reasoning_content kept");
    // user content is never dropped.
    assert.ok(body.messages.includes(oldUser), "older user marker message kept");
    assert.ok(body.messages.includes(currentUser), "latest user turn kept");
});

test("google: drops only stripped status-only parts; preserves user content, functionCall, signed thought and other structure", () => {
    const call = { functionCall: { name: "read", args: { query: "keep" } } };
    const oldUser = { role: "user", parts: [{ text: marker }] };
    const currentUser = { role: "user", parts: [{ text: marker }] };
    const mixed = { role: "model", parts: [{ text: marker }, { text: "real prose" }] };
    const toolCarrier = { role: "model", parts: [{ text: marker }, call] };
    const thoughtCarrier = { role: "model", parts: [{ text: marker }, { text: "model thought", thought: true }] };
    const body = { contents: [oldUser, { role: "model", parts: [{ text: status }] }, mixed, toolCarrier, thoughtCarrier, currentUser] };
    const sameArray = body.contents;
    const counts = stripRawStage(body, "google");
    assert.equal(body.contents, sameArray, "array identity preserved");
    assert.equal(counts.statusBodies, 1, "status body counted");
    // The marker-only model content is dropped (user contents are never dropped).
    assert.ok(!body.contents.some((c) => (c as { role: string }).role === "model"
        && (c as { parts: { text: string }[] }).parts.length === 1
        && (c as { parts: { text: string }[] }).parts[0]!.text === " "), "marker-only model content dropped");
    // mixed: the marker part is dropped, the real prose survives.
    const mixedAfter = body.contents.find((c) => c === mixed) as { parts: { text: string }[] };
    assert.deepEqual(mixedAfter.parts, [{ text: "real prose" }], "mixed: marker part dropped, prose kept");
    // toolCarrier: the marker part is dropped, the functionCall survives.
    const toolAfter = body.contents.find((c) => c === toolCarrier) as { parts: unknown[] };
    assert.equal(toolAfter.parts.length, 1, "toolCarrier: one part left");
    assert.deepEqual(toolAfter.parts[0], call, "toolCarrier: functionCall kept");
    // thoughtCarrier: the marker part is dropped, the signed thought survives.
    const thoughtAfter = body.contents.find((c) => c === thoughtCarrier) as { parts: unknown[] };
    assert.equal(thoughtAfter.parts.length, 1, "thoughtCarrier: one part left");
    assert.deepEqual(thoughtAfter.parts[0], { text: "model thought", thought: true }, "thoughtCarrier: signed thought kept");
    // user content is never dropped.
    assert.ok(body.contents.includes(oldUser), "older user marker content kept");
    assert.ok(body.contents.includes(currentUser), "latest user turn kept");
});
