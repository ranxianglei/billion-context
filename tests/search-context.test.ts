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
    opts: { active?: boolean; topic?: string; tier?: 1 | 2 | 3; effective?: string[]; directBlocks?: string[] } = {},
): CompressionBlock {
    return {
        blockId,
        runId: "r1",
        tier: opts.tier ?? 1,
        topic: opts.topic,
        summary,
        directMessageIds: opts.effective ?? [],
        effectiveMessageIds: opts.effective ?? [],
        directBlockIds: opts.directBlocks ?? [],
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

function stateWith(blocks: CompressionBlock[], byRaw: Record<string, string> = {}): CompressionState {
    const state = createInitialState();
    state.blocks = blocks;
    state.messageRefs.byRaw = byRaw;
    return state;
}

let sessionSeq = 0;
function makeSession(
    state: CompressionState,
    opts: { lastMessages?: CoreMessage[]; cachedFull?: Record<string, string> } = {},
): Session {
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

test("visible (uncovered) messages are NOT indexed — they are already in context", () => {
    const state = stateWith([], { m1: "m00001", m2: "m00002" });
    const log = [
        msg("m1", "user", "Please fix the gzip compression bug in the proxy"),
        msg("m2", "assistant", "I will look at the compression code path now"),
    ];
    const out = handleSearchContext({ query: "gzip compression" }, makeSession(state, { lastMessages: log }), []);
    assert.match(out, /^\[No matches for "gzip compression"/, out);
    assert.ok(out.includes("and 0 folded-away message(s)"), out);
});

test("folded-away original text is the primary corpus (EPERM not in summary)", () => {
    const state = stateWith(
        [block("b1", "Deploy failed with a disk write error during the release", { effective: ["m1"] })],
        { m1: "m00001" },
    );
    const log = [msg("m1", "assistant", "the daemon crashed: EPERM: operation not permitted, rename state.json")];
    const out = handleSearchContext({ query: "EPERM" }, makeSession(state, { lastMessages: log }), []);
    assert.ok(out.startsWith("Found"), out);
    assert.ok(out.includes("m00001 (assistant, in b1)"), out);
});

test("acceptance: original under an INACTIVE tier-1 block is found and attributed to the tier-1 block", () => {
    const state = stateWith(
        [
            block("b1", "routine config work", { active: false, tier: 1, effective: ["m1"] }),
            block("b2", "batch of prior task summaries", { active: true, tier: 2, effective: ["m1"], directBlocks: ["b1"] }),
        ],
        { m1: "m00001" },
    );
    const log = [msg("m1", "assistant", "EPERM: operation not permitted while renaming the state file")];
    const out = handleSearchContext({ query: "EPERM" }, makeSession(state, { lastMessages: log }), []);
    assert.ok(out.startsWith("Found"), out);
    assert.ok(out.includes("in b1"), out);
    assert.ok(!out.includes("in b2"), out);
});

test("the messages argument is the log fallback when lastMessages is empty", () => {
    const state = stateWith([block("b1", "routine work", { effective: ["m1"] })], { m1: "m00001" });
    const out = handleSearchContext(
        { query: "EPERM" },
        makeSession(state),
        [msg("m1", "user", "EPERM: operation not permitted")],
    );
    assert.ok(out.startsWith("Found"), out);
    assert.ok(out.includes("in b1"), out);
});

test("CJK: Chinese query hits a Chinese folded original", () => {
    const state = stateWith([block("b1", "早期讨论", { effective: ["m1"] })], { m1: "m00001" });
    const log = [msg("m1", "user", "请帮我修复压缩上下文的问题，谢谢")];
    const out = handleSearchContext({ query: "压缩 上下文" }, makeSession(state, { lastMessages: log }), []);
    assert.ok(out.startsWith("Found"), out);
    assert.ok(out.includes("m00001"), out);
});

test("CJK: Chinese query hits a Chinese block summary", () => {
    const state = stateWith([block("b1", "讨论了压缩上下文的策略并决定采用分层方案", { topic: "压缩策略" })]);
    const out = handleSearchContext({ query: "压缩 上下文" }, makeSession(state), []);
    assert.ok(out.startsWith("Found"), out);
    assert.ok(out.includes("b1"), out);
});

test("a summary mentioning the query word ONCE passes the threshold", () => {
    const state = stateWith([block("b1", "Set the quorum size to five for the raft cluster.", { topic: "Raft" })]);
    const out = handleSearchContext({ query: "quorum" }, makeSession(state), []);
    assert.match(out, /^Found 1 block\(s\)/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(out.includes('"Raft"'), out);
});

test("INACTIVE block summaries are also searched (tier-2 folds tier-1 away, not into oblivion)", () => {
    const state = stateWith([block("b1", "quorum details", { active: false }), block("b2", "unrelated content about caching")]);
    const out = handleSearchContext({ query: "quorum" }, makeSession(state), []);
    assert.match(out, /^Found 1 block\(s\)/, out);
    assert.ok(out.includes("b1"), out);
});

test("mixed corpus: block summary + folded original hits reported together", () => {
    const state = stateWith(
        [block("b1", "the quorum protocol summary", { effective: ["m1"] })],
        { m1: "m00001" },
    );
    const log = [msg("m1", "user", "explain the quorum protocol to me")];
    const out = handleSearchContext({ query: "quorum" }, makeSession(state, { lastMessages: log }), []);
    assert.match(out, /Found 1 block\(s\), 1 message\(s\)/, out);
    assert.ok(out.includes("b1"), out);
    assert.ok(out.includes("m00001 (user, in b1)"), out);
});

test("blocks whose originals left the log are searched via the blockContents cache", () => {
    const state = stateWith([block("b1", "Deploy failed with a disk write error", { effective: ["m1"] })], { m1: "m00001" });
    const session = makeSession(state, {
        cachedFull: { b1: "[assistant] the daemon crashed: EPERM: operation not permitted, rename state.json" },
        lastMessages: [],
    });
    const out = handleSearchContext({ query: "EPERM" }, session, []);
    assert.ok(out.startsWith("Found"), out);
    assert.ok(out.includes("b1"), out);
    assert.ok(!out.includes("summary only"), out);
    assert.ok(!out.includes("summary-only"), out);
});

test("blocks with neither log originals nor cache are marked summary only", () => {
    const withOriginals = stateWith([block("b1", "alpha config notes", { effective: ["m1"] })], { m1: "m00001" });
    const out1 = handleSearchContext(
        { query: "alpha" },
        makeSession(withOriginals, { lastMessages: [msg("m1", "user", "unrelated filler text")] }),
        [],
    );
    assert.ok(out1.includes("b1 (T1)"), out1);
    assert.ok(!out1.includes("summary only"), out1);

    const orphaned = stateWith([block("b2", "beta config notes")]);
    const out2 = handleSearchContext({ query: "beta" }, makeSession(orphaned), []);
    assert.ok(out2.includes("b2 (T1, summary only)"), out2);
});

test("a tier-2 block is NOT summary-only when its tier-1 children hold indexed originals", () => {
    const state = stateWith(
        [
            block("b1", "routine work", { tier: 1, effective: ["m1"] }),
            block("b2", "aggregated earlier work", { tier: 2, effective: ["m1"], directBlocks: ["b1"] }),
        ],
        { m1: "m00001" },
    );
    const log = [msg("m1", "user", "gamma ray burst detected in the data")];
    const out = handleSearchContext({ query: "aggregated" }, makeSession(state, { lastMessages: log }), []);
    assert.ok(out.includes("b2 (T2)"), out);
    assert.ok(!out.includes("summary only"), out);
});

test("empty result states the searched corpus explicitly (no silent empty)", () => {
    const state = stateWith([block("b1", "alpha beta gamma", { effective: ["m1"] })], { m1: "m00001" });
    const out = handleSearchContext(
        { query: "quixotic" },
        makeSession(state, { lastMessages: [msg("m1", "user", "hello world")] }),
        [],
    );
    assert.match(out, /^\[No matches for "quixotic"/, out);
    assert.ok(out.includes("searched 1 block(s) (1 with folded originals, 0 summary-only) and 1 folded-away message(s)"), out);
});

test("folded system messages are not searchable", () => {
    const state = stateWith([block("b1", "misc", { effective: ["m1"] })], { m1: "m00001" });
    const out = handleSearchContext(
        { query: "quorum" },
        makeSession(state, { lastMessages: [msg("m1", "system", "quorum quorum quorum")] }),
        [],
    );
    assert.match(out, /^\[No matches for "quorum"/, out);
    assert.ok(out.includes("0 folded-away message(s)"), out);
});

test("folded tool-result messages are labeled (tool) and attributed", () => {
    const state = stateWith([block("b1", "disk reads", { effective: ["m1"] })], { m1: "m00001" });
    const out = handleSearchContext(
        { query: "quorum" },
        makeSession(state, { lastMessages: [msg("m1", "tool", "quorum config read from disk", "tool-result")] }),
        [],
    );
    assert.ok(out.includes("m00001 (tool, in b1)"), out);
});

test("unmapped messages (no ref) are skipped even when blocks claim them", () => {
    const state = stateWith([block("b1", "misc", { effective: ["m1"] })]);
    const out = handleSearchContext(
        { query: "quorum" },
        makeSession(state, { lastMessages: [msg("m1", "user", "quorum quorum")] }),
        [],
    );
    assert.match(out, /^\[No matches for "quorum"/, out);
    assert.ok(out.includes("0 folded-away message(s)"), out);
});

test("the same message appearing twice in the log is indexed once", () => {
    const state = stateWith([block("b1", "misc", { effective: ["m1"] })], { m1: "m00001" });
    const log = [msg("m1", "user", "one"), msg("m1", "user", "two")];
    const out = handleSearchContext({ query: "quixotic" }, makeSession(state, { lastMessages: log }), []);
    assert.ok(out.includes("and 1 folded-away message(s)"), out);
});

test("limit caps the combined results", () => {
    const blocks = [
        block("b1", "zebra one alpha"),
        block("b2", "zebra two alpha"),
        block("b3", "zebra three alpha"),
    ];
    const out = handleSearchContext({ query: "zebra", limit: 2 }, makeSession(stateWith(blocks)), []);
    assert.equal((out.match(/\bb\d\b/g) ?? []).length, 2, out);
});

test("tool descriptions match the implementation (all wire formats)", () => {
    for (const desc of [
        SEARCH_CONTEXT_TOOL.description,
        SEARCH_CONTEXT_TOOL_OPENAI.function.description,
        SEARCH_CONTEXT_TOOL_RESPONSES.description,
    ]) {
        assert.ok(desc.includes("folded-away"), desc);
        assert.ok(desc.includes("Chinese/CJK"), desc);
        assert.ok(desc.includes("not indexed"), desc);
    }
    for (const tools of [ACP_TOOLS_ANTHROPIC, ACP_TOOLS_RESPONSES, ACP_READONLY_TOOLS_RESPONSES]) {
        const sc = tools.find((t) => t.name === "search_context");
        assert.ok(sc, "search_context present in tool array");
        assert.ok(typeof sc.description === "string" && sc.description.includes("folded-away"), sc.description);
    }
    const scOpenai = ACP_TOOLS_OPENAI.find((t) => t.function?.name === "search_context");
    assert.ok(scOpenai, "search_context present in OpenAI tool array");
    assert.ok(scOpenai.function.description.includes("folded-away"), scOpenai.function.description);
});
