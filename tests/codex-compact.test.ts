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
    codexCompactGatePre,
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
    assert.equal(isCodexClient({ "user-agent": "codex_sdk_ts/0.153.4 (Ubuntu 24.4.0; x86_64) vt100 (codex_exec; 0.153.4)" }), true, "TS-SDK client (#645 real-device UA)");
    assert.equal(isCodexClient({ "user-agent": "openai-node/3.0" }), false);
    assert.equal(isCodexClient({}), false, "no UA");
    assert.equal(isCodexClient({ "user-agent": ["codex_cli_rs/0.1.0", "other"] }), true, "array UA takes first");
    assert.equal(isCodexClient({ "user-agent": ["other", "codex_cli_rs/0.1.0"] }), false, "array UA first is not codex");
});

test("isCodexClient: lenient token-level 'codex' fallback for unknown client variants (#645, narrowed to token prefix #1641)", () => {
    assert.equal(isCodexClient({ "user-agent": "codex_new_variant/9.9.9" }), true, "unknown variant: component starting with codex");
    assert.equal(isCodexClient({ "user-agent": "relay/1.0 codex_cli_rs/0.21.0" }), true, "known variant behind a relay component still detected via token fallback");
    assert.equal(isCodexClient({ "user-agent": "Mozilla/5.0 (codex-embed)" }), false, "parenthesized mention mid-UA is NOT codex (#1641)");
    assert.equal(isCodexClient({ "user-agent": "my-ide/2.0 vendor/codex-wrapper/1.0" }), false, "mid-path substring hit is NOT codex (#1641)");
    assert.equal(isCodexClient({ "user-agent": "x-codex/1.0" }), false, "component containing codex after another prefix is NOT codex (#1641)");
    assert.equal(isCodexClient({ "user-agent": "Codex_CLI_RS/0.53.0" }), true, "known prefix matches case-insensitively (#1169)");
    assert.equal(isCodexClient({ "user-agent": "node-fetch/3.1" }), false, "no codex at all");
    assert.equal(isCodexClient({ "user-agent": "CodeXchange/1.0" }), false, "mixed-case 'codex'-shaped UA is NOT codex: fallback stays case-sensitive (#1106)");
});

test("isCodexClient: Codex Desktop UA (initial-capital 'Codex') is detected (#1169)", () => {
    assert.equal(isCodexClient({ "user-agent": "Codex Desktop/0.155.0-alpha.9" }), true, "exact UA from #1169 via registered prefix");
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

function mockSession(lastInputTokens: number, blocks: CompressionBlock[], opts: { source?: "usage" | "estimate" | "overflow-arm"; grade?: number } = {}): Session {
    const state = createInitialState();
    state.blocks = blocks;
    return {
        id: "test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens, lastInputTokensSource: opts.source, lastUsageGradeTokens: opts.grade, compressCreditTokens: 0, contextTokens: 0 , retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state,
        createdAt: 0,
        lastSeen: 0,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

test("codexCompactGate: safety-valve matrix", () => {
    const limit = 10_000;
    assert.equal(codexCompactGate(mockSession(1_000, [block(true)]), limit, true), true, "healthy + active block + transform ok");
    assert.equal(codexCompactGate(mockSession(1_000, [block(true)]), limit, false), false, "transform failed → pass through");
    assert.equal(codexCompactGate(mockSession(1_000, [block(false)]), limit, true), false, "no active block → pass through");
    assert.equal(codexCompactGate(mockSession(1_000, []), limit, true), false, "no blocks → pass through");
    assert.equal(codexCompactGate(mockSession(9_000, [block(true)], { source: "usage" }), limit, true), false, "at 90% (usage-grade) → ACP not keeping up → pass through");
    assert.equal(codexCompactGate(mockSession(9_500, [block(true)], { source: "usage" }), limit, true), false, "above 90% (usage-grade) → pass through");
    assert.equal(codexCompactGate(mockSession(8_999, [block(true)], { source: "usage" }), limit, true), true, "just below 90% (usage-grade) → forge");
    assert.equal(codexCompactGate(mockSession(1_000, [block(true)]), 0, true), false, "zero limit → pass through");
});

test("codexCompactGatePre: evidence-grade baseline only (#3008)", () => {
    const limit = 10_000;
    assert.equal(codexCompactGatePre(mockSession(9_500, [block(true)], { source: "estimate", grade: 7_000 }), limit), true, "estimate-grade phantom 9500 + usage-grade anchor 7000 → forge (phantom must not self-disable the valve)");
    assert.equal(codexCompactGatePre(mockSession(9_500, [block(true)], { source: "usage", grade: 9_500 }), limit), false, "usage-grade above 90% → pass through");
    assert.equal(codexCompactGatePre(mockSession(9_500, [block(true)], { source: "overflow-arm", grade: 4_000 }), limit), false, "overflow-arm above 90% → pass through");
    assert.equal(codexCompactGatePre(mockSession(9_500, [block(true)]), limit), true, "no source, no usage anchor → baseline 0 → forge");
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

// ---------------------------------------------------------------------------
// #3008: prompt-form auto-compact detection + forge
// ---------------------------------------------------------------------------

import {
    hasCompactionPrompt,
    buildPromptForgeBody,
    CODEX_COMPACT_PROMPT_ANCHOR,
} from "../src/codex-compact.ts";

const PROMPT_TEXT = `${CODEX_COMPACT_PROMPT_ANCHOR} Create a handoff summary for another LLM that will resume the task.`;

test("hasCompactionPrompt: last user message opening with the built-in template (#3008)", () => {
    const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    assert.equal(hasCompactionPrompt([user("hi"), user(PROMPT_TEXT)]), true, "template as last user message");
    assert.equal(hasCompactionPrompt([user(PROMPT_TEXT)]), true, "string content form");
    assert.equal(hasCompactionPrompt([user("hi")]), false, "ordinary last user message");
    assert.equal(hasCompactionPrompt([user(PROMPT_TEXT), { type: "message", role: "assistant", content: "x" }]), false, "assistant after the template disqualifies");
    assert.equal(hasCompactionPrompt([user("hi"), user(`Before you start: ${PROMPT_TEXT}`)]), false, "anchor must open the message, not appear mid-text");
    assert.equal(hasCompactionPrompt([user(PROMPT_TEXT), user("hi")]), false, "mid-history template (not last) is not the compaction turn");
    assert.equal(hasCompactionPrompt([{ type: "compaction_trigger" }]), false, "trigger form is not the prompt form");
    assert.equal(hasCompactionPrompt([]), false);
    assert.equal(hasCompactionPrompt("a string"), false);
    assert.equal(hasCompactionPrompt([{ type: "message", role: "user", content: [{ type: "input_text", text: "  " + PROMPT_TEXT }] }]), true, "leading whitespace tolerated");
    // A user-overridden compact_prompt (config.compact_prompt in codex) no
    // longer matches the built-in anchor → falls back to passthrough.
    assert.equal(hasCompactionPrompt([user("My own custom compaction instructions.")]), false, "overridden template falls out of detection");
});

test("buildPromptForgeBody: one assistant message codex adopts as its summary (#3008)", () => {
    const summary = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED";
    const stream = buildPromptForgeBody(summary, { inputTokens: 725_892, outputTokens: 0, totalTokens: 725_892 }, true);
    assert.equal(stream.contentType, "text/event-stream");
    assert.ok(stream.body.includes("response.created"), "created first");
    const doneMatch = stream.body.match(/data: (\{"type":"response\.output_item\.done".*})\n/);
    assert.ok(doneMatch, "output_item.done present");
    const doneItem = JSON.parse(doneMatch![1]!) as { item: { type: string; role: string; status: string; content: { type: string; text: string }[] } };
    assert.equal(doneItem.item.type, "message");
    assert.equal(doneItem.item.role, "assistant");
    assert.equal(doneItem.item.status, "completed");
    assert.equal(doneItem.item.content[0]!.type, "output_text");
    assert.equal(doneItem.item.content[0]!.text, summary, "codex's summary_suffix = this text");
    const completedMatch = stream.body.match(/data: (\{"type":"response\.completed".*})\n/);
    assert.ok(completedMatch, "response.completed present (codex parser requires id + usage)");
    const completed = JSON.parse(completedMatch![1]!) as { response: { id: string; usage: { input_tokens: number } } };
    assert.equal(completed.response.usage.input_tokens, 725_892);
    assert.ok(stream.body.trimEnd().endsWith("data: [DONE]"), "SSE terminator");

    const json = buildPromptForgeBody(summary, { inputTokens: 10, outputTokens: 0, totalTokens: 10 }, false);
    assert.equal(json.contentType, "application/json");
    const parsed = JSON.parse(json.body) as { id: string; output: { type: string; role: string; content: { text: string }[] }[]; usage: { total_tokens: number } };
    assert.equal(parsed.output.length, 1);
    assert.equal(parsed.output[0]!.role, "assistant");
    assert.equal(parsed.output[0]!.content[0]!.text, summary);
    assert.equal(parsed.usage.total_tokens, 10);
});

// ---------------------------------------------------------------------------
// #4035: trigger/prompt forge handed off ONLY the fold summaries — the recent
// work between the last fold and compaction time (assistant progress, tool
// drafts/results) sat in neither the summaries nor codex's retention (user
// messages only / prose summary), so it vanished from the model's view after
// a local forge compaction. Fix: coverage-aware handoff — the forged blob
// carries the uncovered tail (v2 envelope), the prompt form renders it into
// the adopted summary text, and echo-time expansion splices it back in place
// while deduping copies codex itself still retains.
// ---------------------------------------------------------------------------

import {
    collectUncoveredTailItems,
    renderUncoveredTailText,
    FORGED_TAIL_HEADER,
    CODEX_FORGED_HANDOFF_HEADER,
} from "../src/codex-compact.ts";

type Slot = { original: unknown; coreId?: string; coreIds?: string[] };

function slot(original: unknown, coreId?: string, coreIds?: string[]): Slot {
    return coreIds !== undefined ? { original, coreIds } : { original, coreId };
}

function coveredBlock(ids: string[], active = true): CompressionBlock {
    return { ...block(active), effectiveMessageIds: ids };
}

test("collectUncoveredTailItems: coverage-aware selection over the wire layout", () => {
    const coveredA = { type: "message", role: "user", content: [{ type: "input_text", text: "covered A" }] };
    const coveredB = { type: "message", role: "assistant", content: [{ type: "output_text", text: "covered B" }] };
    const subCovered = { type: "message", role: "assistant", content: [{ type: "output_text", text: "sub-id covered" }] };
    const trigger = { type: "compaction_trigger" };
    const dev = { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] };
    const partial = { type: "message", role: "user", content: "split item" };
    const tailA = { type: "message", role: "assistant", content: [{ type: "output_text", text: "recent draft" }] };
    const tailB = { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" };
    const tailC = { type: "function_call_output", call_id: "call_1", output: "ok" };
    const tailD = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking bytes" }] };
    const projection = { layout: [
        slot(coveredA, "id-a"),
        slot(coveredB, "id-b"),
        slot(subCovered, "id-z#2"),
        slot(trigger),
        slot(dev),
        slot(partial, undefined, ["id-c", "id-d"]),
        slot(tailA, "id-e"),
        slot(tailB, "id-f"),
        slot(tailC, "id-g"),
        slot(tailD, "id-h"),
    ] };
    const blocks = [
        coveredBlock(["id-a", "id-b"]),
        coveredBlock(["id-c"]),
        coveredBlock(["id-z"]),
        coveredBlock(["id-e"], false),
    ];
    const tail = collectUncoveredTailItems(projection as never, blocks);
    assert.deepEqual(tail, [tailA, tailB, tailC, tailD], "only uncovered slots ride, byte-exact, in wire order");
    assert.deepEqual(collectUncoveredTailItems({ layout: [slot(coveredA, "id-a")] } as never, [coveredBlock(["id-a"])]), [], "fully covered → empty");
    assert.deepEqual(collectUncoveredTailItems({ layout: [slot(coveredA)] } as never, [coveredBlock([])]), [], "core-less slot (preamble/sys-dev/unknown-type routing) is wire furniture → never carried");
});

test("collectUncoveredTailItems: prompt template excluded only when asked", () => {
    const u1 = { type: "message", role: "user", content: [{ type: "input_text", text: "early question" }] };
    const a1 = { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] };
    const template = { type: "message", role: "user", content: [{ type: "input_text", text: `${CODEX_COMPACT_PROMPT_ANCHOR} Create a handoff summary.` }] };
    const projection = { layout: [slot(u1, "1"), slot(a1, "2"), slot(template, "3")] };
    assert.deepEqual(collectUncoveredTailItems(projection as never, []), [u1, a1, template], "default: everything uncovered rides");
    assert.deepEqual(collectUncoveredTailItems(projection as never, [], { excludePromptTemplate: true }), [u1, a1], "prompt form: the template is the instruction, not content");
});

test("buildTriggerForgeBody: non-empty tail switches the blob to the v2 envelope; empty stays legacy-byte-stable", () => {
    const usage = { inputTokens: 100, outputTokens: 0, totalTokens: 100 };
    const tail = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "draft" }] }];
    const { body } = buildTriggerForgeBody("SUMMARY-TEXT", usage, false, tail);
    const parsed = JSON.parse(body) as { output: { type: string; id: string; encrypted_content: string }[] };
    const blob = parsed.output[0]!.encrypted_content;
    assert.ok(blob.startsWith("bili:acp:v2:"), "v2 prefix");
    const payload = JSON.parse(blob.slice("bili:acp:v2:".length)) as { v: number; summaries: string[]; tail: unknown[] };
    assert.equal(payload.v, 2);
    assert.deepEqual(payload.summaries, ["SUMMARY-TEXT"]);
    assert.deepEqual(payload.tail, tail);

    const legacy = JSON.parse(buildTriggerForgeBody("S", usage, false).body) as { output: { encrypted_content: string }[] };
    assert.equal(legacy.output[0]!.encrypted_content, "bili:acp:S", "no tail arg → legacy plain shape unchanged");
    const empty = JSON.parse(buildTriggerForgeBody("S", usage, false, []).body) as { output: { encrypted_content: string }[] };
    assert.equal(empty.output[0]!.encrypted_content, "bili:acp:S", "explicit empty tail → legacy plain shape (byte-stable across builds)");
});

test("replaceBiliCompactionItems: v2 blob expands into handoff + uncovered tail, deduping codex-retained copies", () => {
    const retained = { type: "message", role: "user", content: [{ type: "input_text", text: "retained recent question" }] };
    const draft = { type: "message", role: "assistant", content: [{ type: "output_text", text: "uncovered draft" }] };
    const toolCall = { type: "function_call", call_id: "call_x", name: "bash", arguments: "{}" };
    const payload = { v: 2, summaries: ["S1", "S2"], tail: [draft, retained, toolCall] };
    const v2Item = { type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}v2`, encrypted_content: `bili:acp:v2:${JSON.stringify(payload)}` };
    const next = { type: "message", role: "user", content: "next" };
    const { items, replaced, dropped, tailItems } = replaceBiliCompactionItems([v2Item, retained, next]);
    assert.equal(replaced, 1);
    assert.equal(dropped, 0);
    assert.equal(tailItems, 2, "the codex-retained copy is deduped, the two dropped-by-codex items ride");
    assert.equal(items.length, 5, "handoff + 2 tail + 2 originals, position-preserving");
    const handoff = items[0]! as { type: string; role: string; content: { type: string; text: string }[] };
    assert.equal(handoff.role, "user");
    assert.ok(handoff.content[0]!.text.startsWith(CODEX_FORGED_HANDOFF_HEADER), "handoff header");
    assert.ok(handoff.content[0]!.text.includes("S1\n\nS2"), "summaries joined verbatim");
    assert.deepEqual(items[1], draft, "order preserved: draft before tool call");
    assert.deepEqual(items[2], toolCall);
    assert.ok(items.includes(retained) && items.includes(next), "originals untouched");

    // Same logical item, different key order (codex re-serializes) — the
    // fingerprint must still catch the overlap.
    const reordered = { role: "user", content: [{ text: "retained recent question", type: "input_text" }], type: "message" };
    const r2 = replaceBiliCompactionItems([v2Item, reordered]);
    assert.equal(r2.tailItems, 2, "key order must not defeat the dedup");
});

test("replaceBiliCompactionItems: malformed v2 blobs drop (fail-safe); legacy plaintext still expands", () => {
    const badJson = { type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}a`, encrypted_content: "bili:acp:v2:{not json" };
    const badVersion = { type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}b`, encrypted_content: `bili:acp:v2:${JSON.stringify({ v: 3, summaries: [], tail: [] })}` };
    const badShape = { type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}c`, encrypted_content: `bili:acp:v2:${JSON.stringify({ v: 2, summaries: "s", tail: [] })}` };
    const legacy = { type: "compaction", id: `${CODEX_COMPACT_ID_PREFIX}d`, encrypted_content: "bili:acp:legacy summary" };
    const { items, replaced, dropped, tailItems } = replaceBiliCompactionItems([badJson, badVersion, badShape, legacy]);
    assert.equal(dropped, 3, "all three malformed v2 shapes drop");
    assert.equal(replaced, 1, "legacy plaintext still expands");
    assert.equal(tailItems, 0, "legacy blobs carry no tail");
    assert.equal(items.length, 1);
    assert.ok(JSON.stringify(items[0]).includes("legacy summary"));
});

test("renderUncoveredTailText: labeled lines per item kind; unrenderable types filtered", () => {
    const out = renderUncoveredTailText([
        { type: "reasoning", summary: [{ type: "summary_text", text: "T1" }, { type: "summary_text", text: "T2" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Q" }, { type: "input_image", image_url: "x" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "A" }] },
        { type: "function_call", call_id: "c1", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        { type: "custom_tool_call", call_id: "c2", input: { a: 1 } },
        { type: "custom_tool_call_output", call_id: "c2", output: "done" },
        { type: "extra_tools" },
    ] as never);
    assert.ok(out.includes("[thinking]\nT1T2"), "reasoning summary parts joined");
    assert.ok(out.includes("[user]\nQ[image]"), "user text + image placeholder");
    assert.ok(out.includes("[assistant]\nA"));
    assert.ok(out.includes('[tool call c1] bash({"cmd":"ls"})'), "tool call labeled with id/name/args");
    assert.ok(out.includes("[tool result c1]\nok"));
    assert.ok(out.includes('[custom tool call c2] {"a":1}'));
    assert.ok(out.includes("[custom tool result c2]\ndone"));
    assert.ok(!out.includes("extra_tools"), "unrenderable types filtered out");
    assert.equal(renderUncoveredTailText([]), "");
    assert.ok(FORGED_TAIL_HEADER.startsWith("["), "header is a bracketed label");
});
