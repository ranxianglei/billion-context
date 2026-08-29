import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createInitialState, type CompressionBlock } from "acp-kernel";
import type { Session } from "../src/session.ts";
import {
    codexCompactMode,
    isCodexClient,
    hasCompactionTrigger,
    isBiliCompactionItem,
    stripBiliCompactionItems,
    replaceBiliCompactionItems,
    codexCompactGate,
    buildTriggerForgeBody,
    renderForgedSummary,
    mergeForgedSummaries,
    CODEX_COMPACT_ID_PREFIX,
    CODEX_COMPACT_SENTINEL,
} from "../src/codex-compact.ts";

test("codexCompactMode: kill-switch two states + default + case/trim", () => {
    const prev = process.env.BILI_CODEX_COMPACT;
    try {
        delete process.env.BILI_CODEX_COMPACT;
        assert.equal(codexCompactMode(), "intercept", "default is intercept");
        process.env.BILI_CODEX_COMPACT = "pass";
        assert.equal(codexCompactMode(), "pass");
        process.env.BILI_CODEX_COMPACT = "intercept";
        assert.equal(codexCompactMode(), "intercept");
        process.env.BILI_CODEX_COMPACT = "INTERCEPT";
        assert.equal(codexCompactMode(), "intercept", "case-insensitive");
        process.env.BILI_CODEX_COMPACT = "  pass  ";
        assert.equal(codexCompactMode(), "pass", "trimmed");
        process.env.BILI_CODEX_COMPACT = "banana";
        assert.equal(codexCompactMode(), "intercept", "unknown value stays on intercept");
    } finally {
        if (prev === undefined) delete process.env.BILI_CODEX_COMPACT;
        else process.env.BILI_CODEX_COMPACT = prev;
    }
});

test("isCodexClient: UA prefix detection (Node lowercases header keys)", () => {
    assert.equal(isCodexClient({ "user-agent": "codex_cli_rs/0.1.0 (linux x86_64)" }), true);
    assert.equal(isCodexClient({ "user-agent": "codex_cli_rs/0.2.1" }), true);
    assert.equal(isCodexClient({ "user-agent": "codex_exec/0.147.0 (linux x86_64)" }), true, "exec-mode originator (codex 0.147 real-device UA)");
    assert.equal(isCodexClient({ "user-agent": "openai-node/3.0" }), false);
    assert.equal(isCodexClient({}), false, "no UA");
    assert.equal(isCodexClient({ "user-agent": ["codex_cli_rs/0.1.0", "other"] }), true, "array UA takes first");
    assert.equal(isCodexClient({ "user-agent": ["other", "codex_cli_rs/0.1.0"] }), false, "array UA first is not codex");
});

test("hasCompactionTrigger: only a FINAL compaction_trigger counts", () => {
    assert.equal(hasCompactionTrigger([{ type: "message" }, { type: "compaction_trigger" }]), true);
    assert.equal(hasCompactionTrigger([{ type: "compaction_trigger" }]), true);
    assert.equal(hasCompactionTrigger([{ type: "message" }]), false);
    assert.equal(hasCompactionTrigger([{ type: "compaction_trigger" }, { type: "message" }]), false, "trigger must be final");
    assert.equal(hasCompactionTrigger([]), false);
    assert.equal(hasCompactionTrigger("a string"), false);
});

test("isBiliCompactionItem: our-vs-real-blob distinction", () => {
    assert.equal(isBiliCompactionItem({ type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}abc` }), true, "id prefix");
    assert.equal(isBiliCompactionItem({ type: "compaction", encrypted_content: `${CODEX_COMPACT_SENTINEL}summary` }), true, "sentinel");
    assert.equal(isBiliCompactionItem({ type: "compaction", id: "fc_real", encrypted_content: "opaque-blob" }), false, "real OpenAI blob untouched");
    assert.equal(isBiliCompactionItem({ type: "message", role: "user", content: "hi" }), false, "not a compaction item");
    assert.equal(isBiliCompactionItem(null), false);
});

test("stripBiliCompactionItems: removes ours, keeps real blobs + messages", () => {
    const ours = { type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}x`, encrypted_content: `${CODEX_COMPACT_SENTINEL}s` };
    const real = { type: "compaction", id: "fc_real", encrypted_content: "opaque" };
    const msg = { type: "message", role: "user", content: "hi" };
    const out = stripBiliCompactionItems([ours, real, msg]);
    assert.equal(out.length, 2);
    assert.ok(out.includes(real), "real blob kept");
    assert.ok(out.includes(msg), "message kept");
    assert.ok(!out.includes(ours), "ours removed");
});

function block(active: boolean): CompressionBlock {
    return {
        blockId: "b1", runId: "r1", tier: 1, summary: "S",
        directMessageIds: [], effectiveMessageIds: [], directBlockIds: [],
        compressedTokens: 100, createdAt: 0, survivedCount: 0, generation: "young", active,
    };
}

function mockSession(lastInputTokens: number, blocks: CompressionBlock[]): Session {
    const state = createInitialState();
    state.blocks = blocks;
    return {
        id: "test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state,
        createdAt: 0,
        lastSeen: 0,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("codexCompactGate: safety-valve matrix", () => {
    const limit = 10_000;
    assert.equal(codexCompactGate(mockSession(1_000, [block(true)]), limit, true), true, "healthy + active block + transform ok");
    assert.equal(codexCompactGate(mockSession(1_000, [block(true)]), limit, false), false, "transform failed → pass through");
    assert.equal(codexCompactGate(mockSession(1_000, [block(false)]), limit, true), false, "no active block → pass through");
    assert.equal(codexCompactGate(mockSession(1_000, []), limit, true), false, "no blocks → pass through");
    assert.equal(codexCompactGate(mockSession(9_000, [block(true)]), limit, true), false, "at 90% → ACP not keeping up → pass through");
    assert.equal(codexCompactGate(mockSession(9_500, [block(true)]), limit, true), false, "above 90% → pass through");
    assert.equal(codexCompactGate(mockSession(8_999, [block(true)]), limit, true), true, "just below 90% → forge");
    assert.equal(codexCompactGate(mockSession(1_000, [block(true)]), 0, true), false, "zero limit → pass through");
});

test("replaceBiliCompactionItems: echo becomes a summary handoff message in place", () => {
    const ours = { type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}x`, encrypted_content: `${CODEX_COMPACT_SENTINEL}summary text` };
    const real = { type: "compaction", id: "fc_real", encrypted_content: "opaque" };
    const msg = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };
    const { items, replaced, dropped } = replaceBiliCompactionItems([msg, ours, real]);
    assert.equal(replaced, 1);
    assert.equal(dropped, 0);
    assert.equal(items.length, 3, "position-preserving replacement, real blob kept");
    const handoff = items[1] as { type: string; role: string; content: { type: string; text: string }[] };
    assert.equal(handoff.type, "message");
    assert.equal(handoff.role, "user");
    assert.equal(handoff.content[0]!.type, "input_text");
    assert.ok(handoff.content[0]!.text.includes("summary text"), "extracted summary rides in the message");
    assert.ok(items.includes(real) && items.includes(msg), "neighbors untouched");
});

test("replaceBiliCompactionItems: legacy id-only marker items still drop; empty blob drops", () => {
    const legacy = { type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}old`, encrypted_content: "not-ours" };
    const empty = { type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}e`, encrypted_content: CODEX_COMPACT_SENTINEL };
    const { items, replaced, dropped } = replaceBiliCompactionItems([legacy, empty]);
    assert.equal(replaced, 0);
    assert.equal(dropped, 2);
    assert.equal(items.length, 0);
});

test("buildTriggerForgeBody: minimal legal 2-frame stream", () => {
    const { body: sse, contentType } = buildTriggerForgeBody("SUMMARY-TEXT", { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 }, true);
    assert.equal(contentType, "text/event-stream");
    const frames = sse.split("\n\n").filter((f) => f.length > 0);
    assert.equal(frames.length, 2, "exactly two data frames");
    const e1 = JSON.parse(frames[0]!.slice("data: ".length)) as { type: string; item: { type: string; id: string; encrypted_content: string } };
    assert.equal(e1.type, "response.output_item.done");
    assert.equal(e1.item.type, "compaction");
    assert.ok(e1.item.id.startsWith(CODEX_COMPACT_ID_PREFIX), "compaction id has bili prefix");
    assert.ok(e1.item.encrypted_content.startsWith(CODEX_COMPACT_SENTINEL), "blob carries the sentinel");
    assert.ok(e1.item.encrypted_content.includes("SUMMARY-TEXT"), "summary text in blob");
    const e2 = JSON.parse(frames[1]!.slice("data: ".length)) as { type: string; response: { id: string; usage: { input_tokens: number; output_tokens: number; total_tokens: number } } };
    assert.equal(e2.type, "response.completed");
    assert.ok(e2.response.id.startsWith("resp_bili_"), "completed response id");
    assert.equal(e2.response.usage.input_tokens, 1000);
    assert.equal(e2.response.usage.output_tokens, 0);
    assert.equal(e2.response.usage.total_tokens, 1000);
});

test("buildTriggerForgeBody: non-streaming JSON shape", () => {
    const { body, contentType } = buildTriggerForgeBody("S", { inputTokens: 7, outputTokens: 0, totalTokens: 7 }, false);
    assert.equal(contentType, "application/json");
    const parsed = JSON.parse(body) as { id: string; output: { type: string; id: string; encrypted_content: string }[]; usage: { input_tokens: number; total_tokens: number } };
    assert.ok(parsed.id.startsWith("resp_bili_"));
    assert.equal(parsed.output.length, 1);
    assert.equal(parsed.output[0]!.type, "compaction");
    assert.ok(parsed.output[0]!.id.startsWith(CODEX_COMPACT_ID_PREFIX));
    assert.ok(parsed.output[0]!.encrypted_content.startsWith(CODEX_COMPACT_SENTINEL));
    assert.equal(parsed.usage.input_tokens, 7);
    assert.equal(parsed.usage.total_tokens, 7);
});

function blockWith(summary: string, active: boolean, topic?: string): CompressionBlock {
    const b = block(active);
    b.summary = summary;
    if (topic !== undefined) b.topic = topic;
    return b;
}

test("renderForgedSummary: kernel render format (topic, no topic, empty body)", () => {
    assert.equal(renderForgedSummary({ summary: "S", topic: "T" }), "[Compressed conversation section] — T\nS");
    assert.equal(renderForgedSummary({ summary: "S" }), "[Compressed conversation section]\nS");
    assert.equal(renderForgedSummary({ summary: "   " }), "[Compressed conversation section]");
});

test("mergeForgedSummaries: append active, skip inactive, dedup, accumulate across forges", () => {
    const a = blockWith("SUMMARY-A", true, "Topic A");
    const b = blockWith("SUMMARY-B", true);
    const c = blockWith("SUMMARY-C", false);
    let merged = mergeForgedSummaries(undefined, [a, b, c]);
    assert.equal(merged.length, 2, "inactive block skipped");
    assert.equal(merged[0], "[Compressed conversation section] — Topic A\nSUMMARY-A");
    assert.equal(merged[1], "[Compressed conversation section]\nSUMMARY-B");
    merged = mergeForgedSummaries(merged, [a, b]);
    assert.equal(merged.length, 2, "exact-text dedup on re-capture");
    const d = blockWith("SUMMARY-D", true);
    merged = mergeForgedSummaries(merged, [d]);
    assert.equal(merged.length, 3, "second forge accumulates");
    assert.equal(merged[2], "[Compressed conversation section]\nSUMMARY-D");
    assert.deepEqual(mergeForgedSummaries(undefined, []), []);
});
