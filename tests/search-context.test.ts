import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CompressionState } from "acp-kernel";
import { anthropicToCore, type AnthropicRequestBody } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { buildVisibilityMarker } from "../src/loop/core.ts";
import { executeSearchContext } from "../src/decompress-shared.ts";

function makeSession(): Session {
    return {
        id: `sc-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function hasUnpairedSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const n = s.charCodeAt(i + 1);
            if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
            i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            return true;
        }
    }
    return false;
}

function makeSessionWithBlock(summary?: string): { core: ReturnType<typeof createCore>; state: CompressionState } {
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
        ranges: [{ startRef: "m00001", endRef: "m00015", summary: summary ?? "auth token exchange and refresh design decisions".repeat(3) }],
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
    assert.equal(executeSearchContext({}, core, state).text, "[search_context FAILED: query is required]");
    assert.equal(executeSearchContext({ query: "" }, core, state).text, "[search_context FAILED: query is required]");
});

test("executeSearchContext: zero active blocks → explicit empty-state message (#714)", () => {
    const core = createCore();
    const state = createInitialState();
    assert.equal(executeSearchContext({ query: "anything" }, core, state).text, "[No compressed blocks exist yet — nothing to search.]");
});

test("executeSearchContext: active block exists but none match → scope-limited no-match (#2751)", () => {
    const { core, state } = makeSessionWithBlock();
    // Negative result states what was searched (active topics/summaries) and never
    // reads as "history doesn't contain it".
    assert.match(executeSearchContext({ query: "zzz-no-such-topic" }, core, state).text, /^\[No blocks matched "zzz-no-such-topic" among 1 active block\(s\)\. Scope = active compressed topics\/summaries only/);
});

test("executeSearchContext: matching block → Found listing with id/topic/preview", () => {
    const { core, state } = makeSessionWithBlock();
    const out = executeSearchContext({ query: "auth token" }, core, state).text;
    assert.match(out, /^Found \d+ block\(s\) for "auth token":/);
    assert.ok(out.includes("(T"), "tier present");
    // #2751: the distinctive matched term is surfaced + marked inside the window.
    assert.ok(out.includes("\u3010auth\u3011"), "distinctive term marked");
    assert.ok(out.includes("token exchange and refresh design decisions"), "summary preview present");
});

test("executeSearchContext: clamp cut straddling an astral char leaves no lone surrogate (#816)", () => {
    const straddle = "a".repeat(199) + "\u{1F980}" + "tail";
    assert.equal(straddle.length, 205);
    assert.equal(straddle.charCodeAt(199), 0xd83e, "high half sits exactly on the 200-unit cut");
    const { core, state } = makeSessionWithBlock(straddle);
    const out = executeSearchContext({ query: "aaaa" }, core, state).text;
    assert.match(out, /^Found 1 block\(s\)/);
    assert.ok(!hasUnpairedSurrogate(out), "no unpaired surrogate anywhere in the result");
    const previewLine = out.split("\n").find((l) => l.startsWith("  ")) ?? "";
    assert.ok(previewLine.length > 0, "preview line present");
    assert.ok(previewLine.endsWith("..."), "clamp marker kept");
    assert.ok(!hasUnpairedSurrogate(previewLine), "no lone high surrogate at the cut");
});

test("executeSearchContext: single-occurrence keyword in summary still matches (#2158)", () => {
    const { core, state } = makeSessionWithBlock("probe alphaone, unique-marker-2026 and review_github_issues.py recorded once during the zebrafish run");
    const hit = executeSearchContext({ query: "unique-marker-2026" }, core, state);
    assert.match(hit.text, /^Found 1 block\(s\) for "unique-marker-2026":/);
    assert.equal(hit.outcome, "success", "a positive search is not a failure (#1875)");
    assert.match(executeSearchContext({ query: "alphaone" }, core, state).text, /^Found 1 block\(s\)/);
    assert.match(executeSearchContext({ query: "review_github_issues.py" }, core, state).text, /^Found 1 block\(s\)/);
    assert.match(executeSearchContext({ query: "zebrafish" }, core, state).text, /^Found 1 block\(s\)/);
});

test("executeSearchContext: astral char fully inside the prefix is kept (#816 control)", () => {
    const inside = "a".repeat(197) + "\u{1F980}" + "b".repeat(20);
    assert.equal(inside.length, 219);
    const { core, state } = makeSessionWithBlock(inside);
    const out = executeSearchContext({ query: "aaaa" }, core, state).text;
    const previewLine = out.split("\n").find((l) => l.startsWith("  ")) ?? "";
    assert.ok(previewLine.includes("\u{1F980}"), "intact pair survives the clamp");
    assert.ok(!hasUnpairedSurrogate(out));
});
