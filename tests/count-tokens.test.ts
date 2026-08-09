import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, coveredMessageIds } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { prepareCountTokens, isCountTokensRequest } from "../src/server.ts";
import { anthropicToCore, type AnthropicRequestBody } from "../src/anthropic.js";

function makeSession(): Session {
    return {
        id: `ct-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

// 40 alternating user/assistant messages. Compressing m00001-m00015 lands
// entirely in the "old history" zone (the kernel protects the recent/last-user
// zone), so all 15 are actually covered (no protection exclusion). IDs are
// derived through anthropicToCore (content-hash) so they match what
// prepareCountTokens will re-derive from the same body.
function buildSessionWithCoverage(): { session: Session; core: ReturnType<typeof createCore>; body: AnthropicRequestBody } {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const body: AnthropicRequestBody = {
        model: "claude-test",
        messages: [],
    };
    for (let i = 0; i < 40; i++) {
        body.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i} ${"y".repeat(2000)}` });
    }
    const { msgs } = anthropicToCore(body);
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00015", summary: "early history summary long enough to pass min length check".repeat(3) }],
        state: session.state,
        config,
        messages: turn.messages,
    });
    session.state = res.state;
    assert.equal(res.result.blocksCreated, 1, "compression block should be created");
    assert.equal(coveredMessageIds(session.state).size, 15, "all 15 messages should be covered (no protection)");
    return { session, core, body };
}

test("prepareCountTokens prunes covered messages when a compression block is active", () => {
    const { session, core, body } = buildSessionWithCoverage();
    const config = defaultConfig(200000);
    const logs: string[] = [];
    const log = (_level: string, msg: string) => logs.push(msg);
    const inputCount = body.messages.length;
    const prepared = prepareCountTokens(body, core, config, log, session);
    const out = JSON.parse(prepared.body);
    assert.ok(out.messages.length < inputCount, `pruned output (${out.messages.length}) must be < input (${inputCount})`);
    const hasSummary = out.messages.some((m: { content: unknown }) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return /early history summary/i.test(text);
    });
    assert.ok(hasSummary, "a summary block should be injected");
    assert.ok(logs.some((l) => /count_tokens pruned:/.test(l)), "should log the prune delta");
});

test("prepareCountTokens is READ-ONLY: session.state + stats unchanged", () => {
    const { session, core, body } = buildSessionWithCoverage();
    const config = defaultConfig(200000);
    const stateBefore = JSON.stringify(session.state);
    const statsBefore = JSON.stringify(session.stats);
    const blockCountBefore = session.state.blocks.length;
    prepareCountTokens(body, core, config, () => {}, session);
    assert.equal(JSON.stringify(session.state), stateBefore, "session.state byte-identical (incl. survivedCount/generation/nudge baselines)");
    assert.equal(JSON.stringify(session.stats), statsBefore, "session.stats unchanged (requests/lastInputTokens)");
    assert.equal(session.state.blocks.length, blockCountBefore, "no new blocks created");
    assert.equal(coveredMessageIds(session.state).size, 15, "coverage unchanged");
});

test("prepareCountTokens leaves messages unchanged when no compression blocks exist", () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const body: AnthropicRequestBody = {
        model: "claude-test",
        messages: [],
    };
    for (let i = 0; i < 10; i++) {
        body.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `fresh ${i}` });
    }
    const inputCount = body.messages.length;
    const prepared = prepareCountTokens(body, core, config, () => {}, session);
    const out = JSON.parse(prepared.body);
    assert.equal(out.messages.length, inputCount, "no compression → no pruning");
    assert.equal(session.state.blocks.length, 0, "no blocks created");
});

test("prepareCountTokens forwards unchanged body on prune failure", () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const parsed: AnthropicRequestBody = {
        model: "claude-test",
        messages: [{ role: "user" as const, content: "hi" }],
    };
    // Force processTurn to throw by passing a bogus state shape: cast to never
    // and inject a non-iterable messages field that makes assignRefs throw.
    const bogus = { ...session, state: { ...session.state, messageRefs: null as unknown } } as Session;
    const logs: string[] = [];
    prepareCountTokens(parsed, core, config, (_l, m) => logs.push(m), bogus);
    assert.ok(logs.some((l) => /count_tokens prune failed/i.test(l)), "should log the fallback warning");
});

test("isCountTokensRequest detects count_tokens URLs across path variants", () => {
    assert.ok(isCountTokensRequest("POST", "/v1/messages/count_tokens", true));
    assert.ok(isCountTokensRequest("POST", "/messages/count_tokens", true));
    assert.ok(isCountTokensRequest("POST", "/some/prefix/messages/count_tokens", true));
});

test("isCountTokensRequest rejects non-count_tokens requests", () => {
    assert.ok(!isCountTokensRequest("POST", "/v1/messages", true), "/v1/messages is a real turn, not count_tokens");
    assert.ok(!isCountTokensRequest("GET", "/v1/messages/count_tokens", true), "GET is not a count body");
    assert.ok(!isCountTokensRequest("POST", "/v1/messages/count_tokens", false), "empty body is not a count body");
    assert.ok(!isCountTokensRequest("POST", "/v1/chat/completions", true), "openai endpoint");
    assert.ok(!isCountTokensRequest("POST", "/v1/responses", true), "responses endpoint");
});

test("isCountTokensRequest honors ACP_COUNT_TOKENS_PASSTHROUGH=1 escape hatch", () => {
    const prev = process.env.ACP_COUNT_TOKENS_PASSTHROUGH;
    process.env.ACP_COUNT_TOKENS_PASSTHROUGH = "1";
    try {
        assert.ok(!isCountTokensRequest("POST", "/v1/messages/count_tokens", true), "passthrough=1 must skip compression");
    } finally {
        if (prev === undefined) delete process.env.ACP_COUNT_TOKENS_PASSTHROUGH;
        else process.env.ACP_COUNT_TOKENS_PASSTHROUGH = prev;
    }
    assert.ok(isCountTokensRequest("POST", "/v1/messages/count_tokens", true), "restored env re-enables compression");
});
