import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createInitialState,
    type CompressionBlock,
    type CompressionState,
    type CoreMessage,
} from "acp-kernel";
import { handleSearchContext, parseSearchContextArgs } from "../src/search-context.js";
import { getSession, type Session } from "../src/session.js";
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
    opts: { active?: boolean; topic?: string; tier?: 1 | 2 | 3; effectiveMessageIds?: string[] } = {},
): CompressionBlock {
    return {
        blockId,
        runId: "r1",
        tier: opts.tier ?? 1,
        topic: opts.topic,
        summary,
        directMessageIds: opts.effectiveMessageIds ?? [],
        effectiveMessageIds: opts.effectiveMessageIds ?? [],
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

function stateWith(blocks: CompressionBlock[]): CompressionState {
    const state = createInitialState();
    state.blocks = blocks;
    return state;
}

let sessionSeq = 0;
function makeSession(state: CompressionState, opts: { lastMessages?: CoreMessage[]; cachedFull?: Record<string, string> } = {}): Session {
    const session = getSession(`search-ctx-test-${++sessionSeq}`);
    session.state = state;
    session.lastMessages = opts.lastMessages;
    for (const [blockId, text] of Object.entries(opts.cachedFull ?? {})) {
        session.blockContents.set(blockId, { one: { text, count: 1 }, full: { text, count: 1 } });
    }
    return session;
}

test("parseSearchContextArgs: defaults and validation", () => {
    assert.deepEqual(parseSearchContextArgs({}), { query: "", limit: 5 });
    assert.deepEqual(parseSearchContextArgs({ query: "x", limit: 3 }), { query: "x", limit: 3 });
    assert.deepEqual(parseSearchContextArgs({ query: "x", limit: -1 }), { query: "x", limit: 5 });
    assert.deepEqual(parseSearchContextArgs({ query: "x", limit: 2.9 }), { query: "x", limit: 2 });
    assert.equal(parseSearchContextArgs({ query: 42 }).query, "");
});

test("empty query fails loudly", () => {
    assert.equal(handleSearchContext({}, makeSession(stateWith([])), []), "[search_context FAILED: query is required]");
});

test("acceptance: folded original hits where the summary does not (EPERM)", () => {
    const b1 = block("b1", "Deploy failed with a disk write error during the release", {
        topic: "Deploy failure",
        effectiveMessageIds: ["m1", "m2"],
    });
    const session = makeSession(stateWith([b1]), {
        lastMessages: [
            msg("m1", "user", "deploy the service to the staging cluster"),
            msg("m2", "tool", "Error: EPERM: operation not permitted, open '/var/lib/data/db'"),
        ],
    });
    assert.ok(!JSON.stringify(b1).includes("EPERM"), "sanity: the summary must NOT contain EPERM");
    const out = handleSearchContext({ query: "EPERM" }, session, []);
    assert.match(out, /^Found 1 block\(s\) for "EPERM"/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(out.includes('"Deploy failure"'), out);
    assert.ok(out.includes("EPERM"), out);
});

test("blockContents cache is the fast path when the payload no longer has the originals", () => {
    const b1 = block("b1", "raft tuning notes", { topic: "Raft", effectiveMessageIds: ["m1"] });
    const session = makeSession(stateWith([b1]), {
        cachedFull: { b1: "[assistant]\nSet the quorum size to five and raised the election timeout." },
    });
    const out = handleSearchContext({ query: "quorum" }, session, []);
    assert.match(out, /^Found 1 block\(s\)/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(!out.includes("[summary-only]"), out);
});

test("CJK: Chinese query hits the folded original of a block", () => {
    const b1 = block("b1", "Discussed the compression strategy for long sessions", {
        topic: "Compression strategy",
        effectiveMessageIds: ["m1"],
    });
    const session = makeSession(stateWith([b1]), {
        lastMessages: [msg("m1", "user", "请帮我修复压缩上下文的问题，谢谢")],
    });
    const out = handleSearchContext({ query: "压缩 上下文" }, session, []);
    assert.match(out, /^Found 1 block\(s\)/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(out.includes("压缩上下文"), out);
});

test("CJK: Chinese query hits a Chinese block summary (secondary signal)", () => {
    const b1 = block("b1", "讨论了压缩上下文的策略并决定采用分层方案", { topic: "压缩策略" });
    const session = makeSession(stateWith([b1]));
    const out = handleSearchContext({ query: "压缩 上下文" }, session, []);
    assert.match(out, /^Found 1 block\(s\)/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(out.includes("[summary-only]"), out);
});

test("a summary mentioning the query word ONCE passes the threshold", () => {
    const b1 = block("b1", "Set the quorum size to five for the raft cluster.", { topic: "Raft" });
    const out = handleSearchContext({ query: "quorum" }, makeSession(stateWith([b1])), []);
    assert.match(out, /^Found 1 block\(s\)/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(out.includes('"Raft"'), out);
});

test("inactive (consumed) blocks are excluded from the corpus", () => {
    const dead = block("b1", "unrelated", { active: false, effectiveMessageIds: ["m1"] });
    const live = block("b2", "unrelated content about caching");
    const session = makeSession(stateWith([dead, live]), {
        lastMessages: [msg("m1", "tool", "Error: EPERM: operation not permitted")],
    });
    const out = handleSearchContext({ query: "EPERM" }, session, []);
    assert.match(out, /^\[No matches for "EPERM"/, out);
    assert.ok(out.includes("searched 1 active block(s)"), out);
});

test("graceful degradation: originals gone from every payload → summary-only hit annotated", () => {
    const b1 = block("b1", "the quorum protocol was tuned for the raft cluster", {
        topic: "Raft",
        effectiveMessageIds: ["m1"],
    });
    // lastMessages exists but no longer carries the block's messages (the
    // client's native compaction deleted the history) and no cache.
    const session = makeSession(stateWith([b1]), {
        lastMessages: [msg("m9", "user", "unrelated later turn")],
    });
    const out = handleSearchContext({ query: "quorum" }, session, []);
    assert.match(out, /^Found 1 block\(s\)/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(out.includes("[summary-only]"), out);
});

test("empty result states the searched corpus explicitly (no silent empty)", () => {
    const b1 = block("b1", "alpha beta gamma", { effectiveMessageIds: ["m1"] });
    const b2 = block("b2", "delta epsilon");
    const session = makeSession(stateWith([b1, b2]), {
        lastMessages: [msg("m1", "user", "hello world")],
    });
    const out = handleSearchContext({ query: "quixotic" }, session, []);
    assert.match(out, /^\[No matches for "quixotic"/, out);
    assert.ok(out.includes("searched 2 active block(s) (1 with folded originals, 1 summary-only)"), out);
});

test("visible (uncompressed) messages are NOT searchable", () => {
    const session = makeSession(stateWith([]), {
        lastMessages: [msg("m1", "user", "explain the quorum protocol to me")],
    });
    const out = handleSearchContext({ query: "quorum" }, session, [msg("m1", "user", "explain the quorum protocol to me")]);
    assert.match(out, /^\[No matches for "quorum"/, out);
    assert.ok(out.includes("searched 0 active block(s)"), out);
});

test("limit caps the results", () => {
    const blocks = [
        block("b1", "one", { effectiveMessageIds: ["m1"] }),
        block("b2", "two", { effectiveMessageIds: ["m2"] }),
        block("b3", "three", { effectiveMessageIds: ["m3"] }),
    ];
    const session = makeSession(stateWith(blocks), {
        lastMessages: [
            msg("m1", "user", "zebra stripe one"),
            msg("m2", "user", "zebra stripe two"),
            msg("m3", "user", "zebra stripe three"),
        ],
    });
    const out = handleSearchContext({ query: "zebra", limit: 2 }, session, []);
    assert.equal((out.match(/\bb\d\b/g) ?? []).length, 2, out);
});

test("originals take precedence over the summary in the preview", () => {
    const b1 = block("b1", "the quorum setting was changed", {
        topic: "Raft",
        effectiveMessageIds: ["m1"],
    });
    const session = makeSession(stateWith([b1]), {
        lastMessages: [msg("m1", "assistant", "I raised the raft log index 42 quorum threshold to five")],
    });
    const out = handleSearchContext({ query: "quorum" }, session, []);
    assert.ok(out.includes("raft log index 42"), out);
});

test("tool descriptions match the implementation (all wire formats)", () => {
    for (const desc of [
        SEARCH_CONTEXT_TOOL.description,
        SEARCH_CONTEXT_TOOL_OPENAI.function.description,
        SEARCH_CONTEXT_TOOL_RESPONSES.description,
    ]) {
        assert.ok(desc.includes("FOLDED ORIGINAL"), desc);
        assert.ok(desc.includes("secondary signal"), desc);
        assert.ok(desc.includes("Chinese"), desc);
        assert.ok(desc.includes("[summary-only]"), desc);
    }
    for (const tools of [ACP_TOOLS_ANTHROPIC, ACP_TOOLS_RESPONSES, ACP_READONLY_TOOLS_RESPONSES]) {
        const sc = tools.find((t) => t.name === "search_context");
        assert.ok(sc, "search_context present in tool array");
        assert.ok(typeof sc.description === "string" && sc.description.includes("FOLDED ORIGINAL"), sc.description);
    }
    const scOpenai = ACP_TOOLS_OPENAI.find((t) => t.function?.name === "search_context");
    assert.ok(scOpenai, "search_context present in OpenAI tool array");
    assert.ok(scOpenai.function.description.includes("FOLDED ORIGINAL"), scOpenai.function.description);
});
