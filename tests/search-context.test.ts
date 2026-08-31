import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createInitialState,
    type CompressionBlock,
    type CompressionState,
    type CoreMessage,
} from "acp-kernel";
import { handleSearchContext, parseSearchContextArgs } from "../src/search-context.js";
import {
    ACP_READONLY_TOOLS_RESPONSES,
    ACP_TOOLS_ANTHROPIC,
    ACP_TOOLS_OPENAI,
    ACP_TOOLS_RESPONSES,
    SEARCH_CONTEXT_TOOL,
    SEARCH_CONTEXT_TOOL_OPENAI,
    SEARCH_CONTEXT_TOOL_RESPONSES,
} from "../src/compress-tool.js";

function block(
    blockId: string,
    summary: string,
    opts: { active?: boolean; topic?: string; tier?: 1 | 2 | 3 } = {},
): CompressionBlock {
    return {
        blockId,
        runId: "r1",
        tier: opts.tier ?? 1,
        topic: opts.topic,
        summary,
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 100,
        createdAt: 0,
        survivedCount: 0,
        generation: "young",
        active: opts.active ?? true,
    };
}

function msg(id: string, role: CoreMessage["role"], text: string, contentType: CoreMessage["contentType"] = "text"): CoreMessage {
    return { id, role, contentType, text };
}

function stateWith(blocks: CompressionBlock[], byRaw: Record<string, string>): CompressionState {
    const state = createInitialState();
    state.blocks = blocks;
    state.messageRefs.byRaw = byRaw;
    return state;
}

test("parseSearchContextArgs: defaults and validation", () => {
    assert.deepEqual(parseSearchContextArgs({}), { query: "", limit: 5 });
    assert.deepEqual(parseSearchContextArgs({ query: "x", limit: 3 }), { query: "x", limit: 3 });
    assert.deepEqual(parseSearchContextArgs({ query: "x", limit: -1 }), { query: "x", limit: 5 });
    assert.deepEqual(parseSearchContextArgs({ query: "x", limit: 2.9 }), { query: "x", limit: 2 });
    assert.equal(parseSearchContextArgs({ query: 42 }).query, "");
});

test("empty query fails loudly", () => {
    assert.equal(handleSearchContext({}, stateWith([], {}), []), "[search_context FAILED: query is required]");
});

test("zero-block session: query words from the current round hit visible messages", () => {
    const state = stateWith([], { m1: "m00001", m2: "m00002" });
    const messages = [
        msg("m1", "user", "Please fix the gzip compression bug in the proxy"),
        msg("m2", "assistant", "I will look at the compression code path now"),
    ];
    const out = handleSearchContext({ query: "gzip compression" }, state, messages);
    assert.ok(out.startsWith("Found"), out);
    assert.ok(out.includes("m00001"), out);
    assert.ok(out.includes("m00002"), out);
});

test("CJK: Chinese query hits Chinese visible messages", () => {
    const state = stateWith([], { m1: "m00001" });
    const messages = [msg("m1", "user", "请帮我修复压缩上下文的问题，谢谢")];
    const out = handleSearchContext({ query: "压缩 上下文" }, state, messages);
    assert.ok(out.startsWith("Found"), out);
    assert.ok(out.includes("m00001"), out);
});

test("CJK: Chinese query hits a Chinese block summary", () => {
    const state = stateWith([block("b1", "讨论了压缩上下文的策略并决定采用分层方案", { topic: "压缩策略" })], {});
    const out = handleSearchContext({ query: "压缩 上下文" }, state, []);
    assert.ok(out.startsWith("Found"), out);
    assert.ok(out.includes("b1"), out);
});

test("a summary mentioning the query word ONCE passes the threshold", () => {
    const state = stateWith([block("b1", "Set the quorum size to five for the raft cluster.", { topic: "Raft" })], {});
    const out = handleSearchContext({ query: "quorum" }, state, []);
    assert.match(out, /^Found 1 block\(s\)/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(out.includes('"Raft"'), out);
});

test("mixed corpus: block + message hits reported together", () => {
    const state = stateWith([block("b1", "the quorum protocol summary")], { m1: "m00001" });
    const out = handleSearchContext({ query: "quorum" }, state, [msg("m1", "user", "explain the quorum protocol to me")]);
    assert.match(out, /Found 1 block\(s\), 1 message\(s\)/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(out.includes("m00001"), out);
});

test("inactive (consumed) blocks are excluded from the corpus", () => {
    const state = stateWith([block("b1", "quorum details", { active: false }), block("b2", "unrelated content about caching")], {});
    const out = handleSearchContext({ query: "quorum" }, state, []);
    assert.match(out, /^\[No matches for "quorum"/, out);
    assert.ok(out.includes("searched 1 block(s)"), out);
});

test("empty result states the searched corpus explicitly (no silent empty)", () => {
    const state = stateWith([block("b1", "alpha beta gamma")], { m1: "m00001" });
    const out = handleSearchContext({ query: "quixotic" }, state, [msg("m1", "user", "hello world")]);
    assert.match(out, /^\[No matches for "quixotic"/, out);
    assert.ok(out.includes("searched 1 block(s) and 1 visible message(s)"), out);
});

test("system messages are not searchable", () => {
    const state = stateWith([], { m1: "m00001" });
    const out = handleSearchContext({ query: "quorum" }, state, [msg("m1", "system", "quorum quorum quorum")]);
    assert.match(out, /^\[No matches for "quorum"/, out);
});

test("tool-result messages are labeled (tool)", () => {
    const state = stateWith([], { m1: "m00001" });
    const out = handleSearchContext({ query: "quorum" }, state, [msg("m1", "tool", "quorum config read from disk", "tool-result")]);
    assert.ok(out.includes("m00001 (tool)"), out);
});

test("unmapped messages (no ref) are skipped", () => {
    const state = stateWith([], {});
    const out = handleSearchContext({ query: "quorum" }, state, [msg("m1", "user", "quorum quorum")]);
    assert.match(out, /^\[No matches for "quorum"/, out);
    assert.ok(out.includes("0 visible message(s)"), out);
});

test("limit caps the combined results", () => {
    const blocks = [
        block("b1", "zebra one alpha"),
        block("b2", "zebra two alpha"),
        block("b3", "zebra three alpha"),
    ];
    const out = handleSearchContext({ query: "zebra", limit: 2 }, stateWith(blocks, {}), []);
    assert.equal((out.match(/\bb\d\b/g) ?? []).length, 2, out);
});

test("tool descriptions match the implementation (all wire formats)", () => {
    for (const desc of [
        SEARCH_CONTEXT_TOOL.description,
        SEARCH_CONTEXT_TOOL_OPENAI.function.description,
        SEARCH_CONTEXT_TOOL_RESPONSES.description,
    ]) {
        assert.ok(desc.includes("visible conversation"), desc);
        assert.ok(desc.includes("Chinese"), desc);
    }
    for (const tools of [ACP_TOOLS_ANTHROPIC, ACP_TOOLS_RESPONSES, ACP_READONLY_TOOLS_RESPONSES]) {
        const sc = tools.find((t) => t.name === "search_context");
        assert.ok(sc, "search_context present in tool array");
        assert.ok(typeof sc.description === "string" && sc.description.includes("visible conversation"), sc.description);
    }
    const scOpenai = ACP_TOOLS_OPENAI.find((t) => t.function?.name === "search_context");
    assert.ok(scOpenai, "search_context present in OpenAI tool array");
    assert.ok(scOpenai.function.description.includes("visible conversation"), scOpenai.function.description);
});
