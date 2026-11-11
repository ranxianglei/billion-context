import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { apply, compactionConversationId, configureNativeCompaction, nativeAgent, nativeModel, nativeSummaryActive, requireNativeCompactionReady } from "../src/agent/dsh-native-compaction.ts";
import { selectiveBasicCompaction } from "../src/agent/dsh-compaction-disable.ts";

afterEach(() => configureNativeCompaction([]));
const message = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

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

test("adapter gates native methods and scopes summary bypass without leaking to concurrent bili sessions", async () => {
    configureNativeCompaction([{ model: "gpt-*" }]);
    let model = "kimi";
    const agent = { model: { current: () => ({ provider: "test", model }) }, session: { id: "a", surface: { replaceGeneration: 0 }, requestHeader: () => ({ config: { provider: "test", model } }) } };
    const calls: string[] = [];
    const engine = {
        compactIfNeeded: async () => { calls.push("auto"); return "auto"; },
        compactPressure: async () => { calls.push("pressure"); return "pressure"; },
        compactRegion: async () => { calls.push("region"); return "region"; },
        compactNow: async () => { calls.push("manual"); return "manual"; },
        summarize: async () => { assert.equal(nativeSummaryActive(), true); await Promise.resolve(); assert.equal(nativeSummaryActive(), true); return { summary: [{ type: "text", text: "summary" }] }; },
    };
    const ctx: Parameters<typeof apply>[0] = { compaction: engine, on: () => undefined };
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

test("overlapping native summary and bili work keep separate ownership across awaits and failure", async () => {
    configureNativeCompaction([{ model: "gpt-*" }]);
    const native = { model: { current: () => ({ provider: "test", model: "gpt-test" }) }, session: { id: "native-overlap", surface: { replaceGeneration: 0 } } };
    const bili = { model: { current: () => ({ provider: "test", model: "glm" }) }, session: { id: "bili-overlap", surface: { replaceGeneration: 0 } } };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const engine: Parameters<typeof apply>[0]["compaction"] = {
        compactIfNeeded: async () => { throw new Error("bili must not call native backend"); },
        compactPressure: async () => null, compactRegion: async () => null, compactNow: async () => null,
        summarize: async () => {
            assert.equal(nativeSummaryActive(), true);
            entered();
            await held;
            assert.equal(nativeSummaryActive(), true);
            throw new Error("held summary failed");
        },
    };
    apply({ compaction: engine, on: () => undefined });
    const pending = engine.summarize({ messages: [message("fact")] }, native);
    await ready;
    assert.equal(nativeSummaryActive(), false);
    assert.equal(await engine.compactIfNeeded(bili, "pressure"), null);
    await Promise.resolve();
    assert.equal(nativeSummaryActive(), false);
    assert.equal(compactionConversationId(bili, "bili-overlap"), "bili-overlap");
    const rejected = assert.rejects(pending, /held summary failed/);
    release();
    await rejected;
    assert.equal(nativeSummaryActive(), false);
});

test("native summary delegates the identical input once without budget, splitting or prompt changes", async () => {
    configureNativeCompaction([{ model: "gpt-*" }]);
    const agent = { session: { id: "transparent-native" }, model: { current: () => ({ model: "gpt-test" }) } };
    const input = { messages: [message("x".repeat(800000)), { role: "tool", toolCallId: "host-owned", content: [{ type: "text", text: "original" }] }], tools: [{ name: "large", description: "工具".repeat(200000) }] };
    const before = structuredClone(input);
    const controller = new AbortController();
    const result = { summary: [{ type: "text", text: "host summary" }], usage: { inputTokens: 12 }, hostMetadata: "unchanged" };
    let calls = 0;
    const engine: Parameters<typeof apply>[0]["compaction"] = {
        compactIfNeeded: async () => null, compactPressure: async () => null,
        compactRegion: async () => null, compactNow: async () => null,
        summarize: async function (actual, owner, signal) {
            calls++;
            assert.equal(this, engine);
            assert.equal(actual, input);
            assert.equal(owner, agent);
            assert.equal(signal, controller.signal);
            assert.equal(nativeSummaryActive(), true);
            return result;
        },
    };
    apply({ compaction: engine, on: () => undefined });
    assert.equal(await engine.summarize(input, agent, controller.signal), result);
    assert.equal(calls, 1);
    assert.deepEqual(input, before);
    assert.equal(nativeSummaryActive(), false);
});

test("native summary preserves host errors and aborted signals without adapter retries or validation", async () => {
    configureNativeCompaction([{ model: "gpt-*" }]);
    const agent = { session: { id: "native-error" }, model: { current: () => ({ model: "gpt-test" }) } };
    const input = { messages: [message("fact")] };
    const error = new Error("provider context window exceeded");
    const controller = new AbortController(); controller.abort(new Error("host cancellation"));
    let calls = 0;
    const engine: Parameters<typeof apply>[0]["compaction"] = {
        compactIfNeeded: async () => null, compactPressure: async () => null,
        compactRegion: async () => null, compactNow: async () => null,
        summarize: async (actual, owner, signal) => {
            calls++;
            assert.equal(actual, input); assert.equal(owner, agent); assert.equal(signal, controller.signal);
            throw error;
        },
    };
    apply({ compaction: engine, on: () => undefined });
    await assert.rejects(engine.summarize(input, agent, controller.signal), e => e === error);
    assert.equal(calls, 1);
    assert.equal(nativeSummaryActive(), false);
});
