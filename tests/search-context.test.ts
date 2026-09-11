import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CompressionState } from "acp-kernel";
import { anthropicToCore, type AnthropicRequestBody } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { buildVisibilityMarker } from "../src/compress-loop.ts";
import { executeSearchContext } from "../src/decompress-shared.ts";

function makeSession(): Session {
    return {
        id: `sc-${Math.random().toString(36).slice(2)}`,
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

function makeSessionWithBlock(): { core: ReturnType<typeof createCore>; state: CompressionState } {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    for (let i = 0; i < 40; i++) {
        body.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `auth token flow message ${i} ${"y".repeat(2000)}` });
    }
    const { msgs } = anthropicToCore(body);
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00015", summary: "auth token exchange and refresh design decisions".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.blocksCreated, 1, "compression block should be created");
    return { core, state: res.state };
}

test("buildVisibilityMarker: zero-blocks search result is NOT a failure (#714)", () => {
    const marker = buildVisibilityMarker("search_context", "[No compressed blocks exist yet — nothing to search.]");
    assert.ok(marker.includes("🔍"), "search icon kept");
    assert.ok(!marker.includes("❌"), "no failure icon");
    assert.ok(marker.includes("No compressed blocks exist yet"), "message surfaced to client");
});

test("buildVisibilityMarker: no-match search result is NOT a failure (#714)", () => {
    const marker = buildVisibilityMarker("search_context", '[No blocks matched "quantum flux"]');
    assert.ok(marker.includes("🔍"), "search icon kept");
    assert.ok(!marker.includes("❌"), "no failure icon");
    assert.ok(marker.includes('No blocks matched "quantum flux"'), "query echoed back");
});

test("buildVisibilityMarker: hits still render normally", () => {
    const marker = buildVisibilityMarker("search_context", 'Found 1 block(s) for "auth":\n\nb0 (T1) "(no topic)"\n  auth token exchange');
    assert.ok(marker.includes("🔍"));
    assert.ok(!marker.includes("❌"));
    assert.ok(marker.includes('Found 1 block(s) for "auth"'));
});

test("buildVisibilityMarker: real failures still ❌", () => {
    assert.ok(buildVisibilityMarker("search_context", "[search_context FAILED: query is required]").includes("❌"), "missing query is a failure");
    assert.ok(buildVisibilityMarker("decompress", "[Block b9 not found]").includes("❌"), "not-found decompress is a failure");
});

test("executeSearchContext: missing query → FAILED string", () => {
    const core = createCore();
    const state = createInitialState();
    assert.equal(executeSearchContext({}, core, state), "[search_context FAILED: query is required]");
    assert.equal(executeSearchContext({ query: "" }, core, state), "[search_context FAILED: query is required]");
});

test("executeSearchContext: zero active blocks → explicit empty-state message (#714)", () => {
    const core = createCore();
    const state = createInitialState();
    assert.equal(executeSearchContext({ query: "anything" }, core, state), "[No compressed blocks exist yet — nothing to search.]");
});

test("executeSearchContext: active block exists but none match → no-match string", () => {
    const { core, state } = makeSessionWithBlock();
    assert.match(executeSearchContext({ query: "zzz-no-such-topic" }, core, state), /^\[No blocks matched "zzz-no-such-topic"\]$/);
});

test("executeSearchContext: matching block → Found listing with id/topic/preview", () => {
    const { core, state } = makeSessionWithBlock();
    const out = executeSearchContext({ query: "auth token" }, core, state);
    assert.match(out, /^Found \d+ block\(s\) for "auth token":/);
    assert.ok(out.includes("(T"), "tier present");
    assert.ok(out.includes("auth token exchange"), "summary preview present");
});
