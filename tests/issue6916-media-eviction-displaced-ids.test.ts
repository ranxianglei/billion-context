import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import { anthropicToCore } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { reconcileFoldCoverage } from "../src/fold-reconcile.ts";

// #6916, scrubbed from a real Claude Code session (2026-11-10): screenshot
// tool results share one caption, and at the request-size limit Claude Code
// swaps the older screenshots for a placeholder text and drops older top-level
// images. Every other message is resent byte-equal.
const PLACEHOLDER = "[media removed: request limit. placeholder]";
const CAPTION = `screenshot saved ${"c".repeat(200)}`;
const image = (n: number) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(`png-${n}-${"z".repeat(4000)}`).toString("base64") } });

function body(evictBelow: number) {
    const messages: unknown[] = [];
    const intro = evictBelow > 0 ? [] : [image(1), image(2)];
    messages.push({ role: "user", content: [{ type: "text", text: "intro A ".repeat(20) }, ...intro, { type: "text", text: "intro B ".repeat(20) }] });
    for (let t = 0; t < 30; t++) {
        messages.push({ role: "assistant", content: [{ type: "text", text: `step ${t} ${"r".repeat(3000)}` }, { type: "tool_use", id: `toolu_${t}`, name: "screenshot", input: { n: t } }] });
        const pic = t < evictBelow ? { type: "text", text: PLACEHOLDER } : image(100 + t);
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${t}`, content: [pic, { type: "text", text: CAPTION }] }] });
    }
    messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    messages.push({ role: "user", content: [{ type: "text", text: "next" }] });
    return anthropicToCore({ model: "claude-haiku", max_tokens: 100, messages } as Parameters<typeof anthropicToCore>[0]).msgs as CoreMessage[];
}

function makeSession(): Session {
    return { id: "issue6916", meta: {}, stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 }, metadata: {}, state: createInitialState(), createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false, pendingRetrievals: [] } as Session;
}

function foldEarlyScreenshots() {
    const core = createCore();
    const config = defaultConfig(200000);
    const before = body(0);
    const s = makeSession();
    const turn = core.processTurn({ messages: before, state: s.state, config, tokenCount: 9999, renderTags: "text-only" });
    const res = core.applyCompression({ ranges: [{ startRef: "m00001", endRef: "m00030", summary: "folded the early screenshots, their tool calls and their captions" }], messages: turn.messages, state: turn.state, config });
    s.state = res.state;
    assert.equal(s.state.blocks.length, 1, JSON.stringify({ ...res, state: undefined, messages: undefined }).slice(0, 600));
    assert.equal(reconcileFoldCoverage(s, before, { mode: "repair" }).kind, "resend");
    return s;
}

const coveredToolCalls = (s: Session, msgs: CoreMessage[]) => {
    const cov = new Set(s.state.blocks.flatMap((b) => b.effectiveMessageIds));
    return msgs.filter((m) => m.role === "tool" && m.id !== undefined && cov.has(m.id)).map((m) => Number(m.toolCallId?.slice(6)));
};

test("#6916: evicted screenshots keep their fold and later screenshots stay unfolded", () => {
    const s = foldEarlyScreenshots();
    const before = coveredToolCalls(s, body(0));
    assert.ok(before.length > 3 && before.every((t, i) => t === i), `fold covers the first results: ${before}`);
    const after = body(15);
    const r = reconcileFoldCoverage(s, after, { mode: "repair" });
    assert.deepEqual(coveredToolCalls(s, after), before);
    assert.equal(r.byTool, before.length);
    assert.equal(reconcileFoldCoverage(s, after, { mode: "repair" }).claims, 0);
});

test("#6916: duplicate results that keep their tool call are not displaced", () => {
    const s = foldEarlyScreenshots();
    const msgs = body(0);
    const before = coveredToolCalls(s, msgs);
    const r = reconcileFoldCoverage(s, msgs, { mode: "repair" });
    assert.equal(r.kind, "resend");
    assert.equal(r.claims, 0);
    assert.deepEqual(coveredToolCalls(s, msgs), before);
});
