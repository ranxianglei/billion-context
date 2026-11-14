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
    normalizeForgedEntries,
    pruneForgedEntries,
    carriesConversationTurns,
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

test("mergeForgedSummaries: append active, skip inactive, dedup, accumulate across forges (#4600 entries)", () => {
    const mk = (blockId: string, summary: string, active: boolean, topic?: string): CompressionBlock => {
        const b = blockWith(summary, active, topic);
        b.blockId = blockId;
        return b;
    };
    const a = mk("b_a", "SUMMARY-A", true, "Topic A");
    const b = mk("b_b", "SUMMARY-B", true);
    const c = mk("b_c", "SUMMARY-C", false);
    let merged = mergeForgedSummaries(undefined, [a, b, c]);
    assert.equal(merged.length, 2, "inactive block skipped");
    assert.deepEqual(merged[0], { text: "[Compressed conversation section] — Topic A\nSUMMARY-A", blockId: "b_a" });
    assert.deepEqual(merged[1], { text: "[Compressed conversation section]\nSUMMARY-B", blockId: "b_b" });
    merged = mergeForgedSummaries(merged, [a, b]);
    assert.equal(merged.length, 2, "exact-text dedup on re-capture");
    const d = mk("b_d", "SUMMARY-D", true);
    merged = mergeForgedSummaries(merged, [d]);
    assert.equal(merged.length, 3, "second forge accumulates");
    assert.deepEqual(merged[2], { text: "[Compressed conversation section]\nSUMMARY-D", blockId: "b_d" });
    assert.deepEqual(mergeForgedSummaries(undefined, []), []);
});

test("normalizeForgedEntries: legacy strings, object entries, garbage (#4600)", () => {
    assert.deepEqual(normalizeForgedEntries(undefined), []);
    assert.deepEqual(normalizeForgedEntries("not-an-array"), []);
    assert.deepEqual(normalizeForgedEntries(["legacy-a", "legacy-b"]), [{ text: "legacy-a" }, { text: "legacy-b" }]);
    assert.deepEqual(normalizeForgedEntries([
        { text: "obj-entry", blockId: "b1" },
        { text: "obj-entry", blockId: "OTHER" },
        "plain-string",
        null,
        42,
        { blockId: "no-text" },
        { text: 7 },
    ]), [
        { text: "obj-entry", blockId: "b1" },
        { text: "plain-string" },
    ], "duplicate text keeps first-seen provenance; non-entry garbage dropped");
});

// #4600: supersession pruning. Helper builds full blocks with explicit ids.
function blk(blockId: string, active: boolean, effectiveMessageIds: string[]): CompressionBlock {
    return {
        blockId, runId: `r_${blockId}`, tier: 1, summary: `S-${blockId}`,
        directMessageIds: [], effectiveMessageIds, directBlockIds: [],
        compressedTokens: 10, createdAt: 0, survivedCount: 0, generation: "young", active,
    };
}

test("pruneForgedEntries: supersession matrix (#4600)", () => {
    // Truncation debt stays: block deactivated without any consumer folding its summary message.
    const debt = pruneForgedEntries([{ text: "T-debt", blockId: "b_debt" }], [blk("b_debt", false, ["orig-x"])]);
    assert.equal(debt.length, 1, "unconsumed truncation debt is load-bearing and stays");

    const pruned = pruneForgedEntries(
        [{ text: "T-old", blockId: "b_old" }, { text: "T-new", blockId: "b_new" }],
        [blk("b_old", false, ["orig-1"]), blk("b_new", true, ["orig-1", "acp_summary_b_old"])],
    );
    assert.deepEqual(pruned, [{ text: "T-new", blockId: "b_new" }], "entry dropped once an ACTIVE consumer carries the content");

    const viaEntry = pruneForgedEntries(
        [{ text: "T-old", blockId: "b_old" }, { text: "T-mid", blockId: "b_mid" }],
        [blk("b_old", false, []), blk("b_mid", false, ["acp_summary_b_old"])],
    );
    assert.deepEqual(viaEntry, [{ text: "T-mid", blockId: "b_mid" }], "represented-by-own-entry consumer also supersedes");

    const unrep = pruneForgedEntries(
        [{ text: "T-old", blockId: "b_old" }],
        [blk("b_old", false, []), blk("b_mid", false, ["acp_summary_b_old"])],
    );
    assert.equal(unrep.length, 1, "unrepresented consumer does not transfer representation");

    const chain = pruneForgedEntries(
        [
            { text: "T-g1", blockId: "b_g1" },
            { text: "T-g2", blockId: "b_g2" },
            { text: "T-g3", blockId: "b_g3" },
        ],
        [
            blk("b_g1", false, []),
            blk("b_g2", false, ["acp_summary_b_g1"]),
            blk("b_g3", false, ["acp_summary_b_g2"]),
            blk("b_top", true, ["acp_summary_b_g3"]),
        ],
    );
    assert.deepEqual(chain, [], "chain g1→g2→g3→active top: all links redundant");

    const legacy = pruneForgedEntries([{ text: "T-legacy" }], [blk("b_top", true, [])]);
    assert.deepEqual(legacy, [{ text: "T-legacy" }], "legacy entry without provenance is never pruned");

    const ghost = pruneForgedEntries([{ text: "T-ghost", blockId: "b_ghost" }], [blk("b_top", true, ["acp_summary_b_ghost"])]);
    assert.deepEqual(ghost, [{ text: "T-ghost", blockId: "b_ghost" }], "absent block cannot be verified as superseded");

    const live = pruneForgedEntries([{ text: "T-live", blockId: "b_live" }], [blk("b_live", true, []), blk("b_other", true, ["acp_summary_b_live"])]);
    assert.deepEqual(live, [{ text: "T-live", blockId: "b_live" }], "still-active block's entry is never pruned");

    const subid = pruneForgedEntries([{ text: "T-old", blockId: "b_old" }], [blk("b_old", false, []), blk("b_new", true, ["acp_summary_b_old#r0"])]);
    assert.deepEqual(subid, [], "sub-id form of the summary id counts as coverage");

    const same = [{ text: "T-debt", blockId: "b_debt" }];
    assert.equal(pruneForgedEntries(same, [blk("b_debt", false, ["orig-x"])]), same, "no-op returns the same array reference");
    const empty: typeof same = [];
    assert.equal(pruneForgedEntries(empty, []), empty, "empty input returns the same reference");
});

test("carriesConversationTurns: completed-turn evidence vs context-only traffic (#4600)", () => {
    const msg = (role: string) => ({ type: "message", role, content: "x" });
    assert.equal(carriesConversationTurns([msg("user"), msg("assistant")]), true, "assistant message");
    assert.equal(carriesConversationTurns([{ type: "function_call", call_id: "c1", name: "bash", arguments: "{}" }]), true, "function_call");
    assert.equal(carriesConversationTurns([{ type: "function_call_output", call_id: "c1", output: "ok" }]), true, "function_call_output");
    assert.equal(carriesConversationTurns([{ type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "" }]), true, "custom_tool_call");
    assert.equal(carriesConversationTurns([{ type: "custom_tool_call_output", call_id: "c2", output: "ok" }]), true, "custom_tool_call_output");
    assert.equal(carriesConversationTurns([{ type: "computer_call", call_id: "c3", status: "completed", actions: [] }]), true, "computer_call");
    assert.equal(carriesConversationTurns([{ type: "mcp_call", call_id: "c4", status: "completed", server_label: "s", tool: "t", arguments: {}, result: {} }]), true, "mcp_call");
    assert.equal(carriesConversationTurns([{ type: "reasoning", id: "rs_1", summary: [] }]), true, "reasoning item");
    assert.equal(carriesConversationTurns([null, 42, { role: "assistant" }]), true, "type-less assistant shorthand counts (lenient by design)");
    assert.equal(carriesConversationTurns([msg("developer"), msg("user"), { type: "additional_tools" }]), false, "context-only probe traffic");
    assert.equal(carriesConversationTurns([{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }, msg("user")]), false, "compaction item + user context only");
    assert.equal(carriesConversationTurns([null, 42, { type: "message", role: "user" }]), false, "non-object noise and user-only items are not evidence");
    assert.equal(carriesConversationTurns([]), false);
    assert.equal(carriesConversationTurns("string input"), false);
    assert.equal(carriesConversationTurns(null), false);
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
