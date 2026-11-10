import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { apply, boundedNativeSummary, compactionConversationId, configureNativeCompaction, nativeAgent, nativeModel, nativeSummaryActive, requireNativeCompactionReady, summaryGroups } from "../src/agent/dsh-native-compaction.ts";
import { selectiveBasicCompaction } from "../src/agent/dsh-compaction-disable.ts";

afterEach(() => configureNativeCompaction([]));
const message = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const estimate = (m: { content: readonly { text?: string }[] }) => m.content.reduce((n, b) => n + (b.text?.length ?? 0), 0);

test("native ownership is opt-in, exact provider, explicit model family, never substring", () => {
    configureNativeCompaction([]);
    assert.equal(nativeModel({ model: "gpt-5" }), false);
    configureNativeCompaction([{ model: "gpt-*", provider: "openai" }, { model: "exact" }]);
    assert.equal(nativeModel({ provider: "openai", model: "gpt-5" }), true);
    assert.equal(nativeModel({ provider: "other", model: "gpt-5" }), false);
    assert.equal(nativeModel({ provider: "openai", model: "fake-gpt-5" }), false);
    assert.equal(nativeModel({ provider: "other", model: "exact" }), true);
    assert.equal(nativeModel(undefined), false);
    for (const invalid of [{}, "gpt-*", [{ model: "*" }], [{ model: "g*t" }], [{ model: "gpt-*", typo: true }]]) {
        assert.throws(() => configureNativeCompaction(invalid));
    }
});

test("pending model selection outranks last request; persistent surface generation isolates old folds", () => {
    configureNativeCompaction([{ model: "gpt-*" }]);
    const agent = { model: { current: () => ({ model: "gpt-5" }) }, session: { surface: { replaceGeneration: 0 }, requestHeader: () => ({ config: { model: "kimi" } }) } };
    assert.equal(nativeAgent(agent), true);
    assert.equal(compactionConversationId(agent, "session-a"), "session-a");
    agent.session.surface.replaceGeneration = 3;
    assert.equal(compactionConversationId(agent, "session-a"), "session-a|dsh-generation:3");
    assert.equal(compactionConversationId({ session: { surface: { replaceGeneration: 3 } } }, "session-a"), "session-a|dsh-generation:3");
    configureNativeCompaction([]);
    assert.equal(nativeAgent(agent), false);
    assert.equal(compactionConversationId(agent, "session-a"), "session-a|dsh-generation:3", "clearing rules must not resurrect old folds");
    assert.throws(() => compactionConversationId({}, "session-a"));
    assert.throws(() => requireNativeCompactionReady(agent));
});

test("preset rewrite keeps stock settings, respects disabled rows, adds adapter in the compaction group once", () => {
    const inner = [{ name: "@deepseek-ai/dsh-compaction-basic", config: { thresholdRatio: 0.75 } }, { name: "@deepseek-ai/dsh-command-compact", disabled: true }];
    const rows = [{ group: true, config: inner }];
    const output = selectiveBasicCompaction(rows) as typeof rows;
    assert.deepEqual(output[0].config.slice(0, 2), inner);
    assert.equal(output[0].config.length, 3);
    assert.deepEqual(selectiveBasicCompaction(output), output);
    assert.equal(inner.length, 2);
});

test("handoff groups retain complete parallel tool calls/results", () => {
    const messages = [{ role: "assistant", content: [{ type: "tool-call", id: "a" }, { type: "tool-call", id: "b" }] },
        { role: "tool", toolCallId: "a", content: [{ type: "text", text: "A" }] },
        { role: "tool", toolCallId: "b", content: [{ type: "text", text: "B" }] }, message("tail")];
    assert.deepEqual(summaryGroups(messages), [messages.slice(0, 3), [messages[3]]]);
    assert.throws(() => summaryGroups(messages.slice(0, 2)), /unfinished/);
    assert.throws(() => summaryGroups(messages.slice(1)), /unpaired/);
});

test("bounded summary covers every original message, retains system and tool schema, does not mutate input", async () => {
    const input = { messages: [{ ...message("system"), role: "system" }, ...Array.from({ length: 10 }, (_, i) => message(`fact-${i} `.repeat(5)))], tools: [{ name: "read" }] };
    const before = structuredClone(input);
    const seen: string[] = [];
    const result = await boundedNativeSummary(input, 110, estimate, async part => {
        assert.equal(part.messages[0].role, "system");
        assert.deepEqual(part.tools, input.tools);
        assert.ok(part.messages.reduce((n, m) => n + estimate(m as ReturnType<typeof message>), 0) <= 110);
        seen.push(...part.messages.slice(1).flatMap(m => m.content.map(b => b.text ?? "")));
        return { summary: [{ type: "text", text: "summary" }] };
    });
    assert.deepEqual(result.summary, [{ type: "text", text: "summary" }]);
    for (let i = 0; i < 10; i++) assert.ok(seen.some(text => text.includes(`fact-${i}`)));
    assert.deepEqual(input, before);
});

test("bounded summary propagates cancellation/failure and rejects no-progress or oversized indivisible messages", async () => {
    const input = { messages: [message("x".repeat(60)), message("y".repeat(60))] };
    const stop = new AbortController(); stop.abort(new Error("cancelled"));
    await assert.rejects(boundedNativeSummary(input, 100, estimate, async () => { throw new Error("should not run"); }, stop.signal), /cancelled/);
    await assert.rejects(boundedNativeSummary(input, 100, estimate, async () => { throw new Error("provider failure"); }), /provider failure/);
    await assert.rejects(boundedNativeSummary(input, 100, estimate, async p => ({ summary: p.messages[0].content })), /no progress/);
    await assert.rejects(boundedNativeSummary(input, 30, estimate, async () => ({ summary: [] })), /larger/);
});

test("adapter gates native methods and scopes summary bypass without leaking to concurrent bili sessions", async () => {
    configureNativeCompaction([{ model: "gpt-*" }]);
    let model = "kimi";
    const agent = { model: { current: () => ({ provider: "test", model }) }, session: { id: "a", surface: { replaceGeneration: 0 }, requestHeader: () => ({ config: { provider: "test", model } }) } };
    const calls: string[] = [];
    const engine = {
        config: { summarizationProvider: "", summarizationModel: "", maxTokens: 100 },
        compactIfNeeded: async () => { calls.push("auto"); return "auto"; },
        compactPressure: async () => { calls.push("pressure"); return "pressure"; },
        compactRegion: async () => { calls.push("region"); return "region"; },
        compactNow: async () => { calls.push("manual"); return "manual"; },
        summarize: async () => { assert.equal(nativeSummaryActive(), true); await Promise.resolve(); assert.equal(nativeSummaryActive(), true); return { summary: [{ type: "text", text: "summary" }] }; },
    };
    const ctx: Parameters<typeof apply>[0] = { compaction: engine, tokenMeter: { estimateMessage: () => 20 }, llm: { resolveModelInfo: async () => ({ context: { contextWindow: 20000 } }) }, on: () => undefined };
    apply(ctx);
    assert.equal(await ctx.compaction.compactIfNeeded(agent, "pressure"), null);
    await assert.rejects(ctx.compaction.compactNow(agent), /bili owns/);
    model = "gpt-5";
    assert.equal(await ctx.compaction.compactIfNeeded(agent, "pressure"), "auto");
    requireNativeCompactionReady(agent);
    const summary = ctx.compaction.summarize({ messages: [message("fact")] }, agent);
    assert.equal(nativeSummaryActive(), false);
    await summary;
    assert.equal(nativeSummaryActive(), false);
    model = "kimi";
    assert.equal(await ctx.compaction.compactPressure(agent, { config: { model } }), null);
    assert.deepEqual(calls, ["auto"]);
});
