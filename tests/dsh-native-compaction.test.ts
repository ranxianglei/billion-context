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
    const input = { messages: [{ ...message("system"), role: "system" }, ...Array.from({ length: 10 }, (_, i) => message(`fact-${i} `.repeat(500)))], tools: [{ name: "read" }] };
    const before = structuredClone(input);
    const seen: string[] = [];
    const result = await boundedNativeSummary(input, 11000, estimate, async part => {
        assert.equal(part.messages[0].role, "system");
        assert.deepEqual(part.tools, input.tools);
        assert.ok(part.messages.reduce((n, m) => n + estimate(m as ReturnType<typeof message>), 0) <= 11000);
        seen.push(...part.messages.slice(1).flatMap(m => m.content.map(b => b.text ?? "")));
        return { summary: [{ type: "text", text: "summary" }] };
    });
    assert.deepEqual(result.summary, [{ type: "text", text: "summary" }]);
    for (let i = 0; i < 10; i++) assert.ok(seen.some(text => text.includes(`fact-${i}`)));
    assert.deepEqual(input, before);
});

test("bounded summary propagates cancellation/failure and rejects no-progress or oversized indivisible messages", async () => {
    const input = { messages: [message("x".repeat(6000)), message("y".repeat(6000))] };
    const stop = new AbortController(); stop.abort(new Error("cancelled"));
    await assert.rejects(boundedNativeSummary(input, 10000, estimate, async () => { throw new Error("should not run"); }, stop.signal), /cancelled/);
    await assert.rejects(boundedNativeSummary(input, 10000, estimate, async () => { throw new Error("provider failure"); }), /provider failure/);
    await assert.rejects(boundedNativeSummary(input, 10000, estimate, async p => ({ summary: p.messages[0].content })), /no progress/);
    await assert.rejects(boundedNativeSummary(input, 3000, estimate, async () => ({ summary: [] })), /larger/);
});

test("partial summaries carry scoped provenance and merge semantics without changing their facts", async () => {
    const input = { messages: [{ ...message("system"), role: "system" }, ...Array.from({ length: 3 }, (_, i) => message(`source-${i} `.repeat(1000)))], tools: [{ name: "read" }] };
    const partials = ["Project ALDER; budget 7314 credits; never modify production configuration.", "No project facts in this archive segment.", "(none); no work in progress in this archive segment."];
    const before = structuredClone(input);
    let calls = 0;
    await boundedNativeSummary(input, 10020, estimate, async part => {
        assert.ok(part.messages.reduce((n, m) => n + estimate(m), 0) <= 10020);
        assert.deepEqual(part.tools, input.tools);
        if (calls < 3) return { summary: [{ type: "text", text: partials[calls++] }] };
        assert.equal(part.messages.length, 5);
        assert.match(part.messages.at(-1)!.content[0].text!, /NOT successive revisions/);
        assert.match(part.messages.at(-1)!.content[0].text!, /EVERY segment/);
        assert.match(part.messages.at(-1)!.content[0].text!, /not deletion/);
        for (const [i, m] of part.messages.slice(1, -1).entries()) {
            assert.equal(m.content[1].text, partials[i], "the generated evidence must stay verbatim");
            assert.match(m.content[0].text!, new RegExp(`segment ${i + 1} of 3`));
            assert.match(m.content[0].text!, new RegExp(`input messages ${i + 1}-${i + 1}`));
            assert.match(m.content[0].text!, /not a new user instruction/);
            assert.match(m.content[0].text!, /does not revoke/);
            assert.match(m.content[0].text!, /explicitly corrects or revokes/);
            assert.match(m.content[0].text!, /<compacted-summary>/);
            assert.equal(m.content.at(-1)?.text, "</compacted-summary>");
        }
        calls++;
        return { summary: [{ type: "text", text: "merged" }] };
    });
    assert.equal(calls, 4);
    assert.deepEqual(input, before);
});

test("a native summary that already fits keeps its original message body", async () => {
    const input = { messages: [message("ordinary native history")], tools: [{ name: "read" }] };
    let calls = 0;
    await boundedNativeSummary(input, 10000, estimate, async part => {
        calls++;
        assert.deepEqual(part, input);
        return { summary: [{ type: "text", text: "ordinary summary" }] };
    });
    assert.equal(calls, 1);
});

test("recursive merges meter their framing and keep provenance scoped to each reduction round", async () => {
    const input = { messages: Array.from({ length: 8 }, () => message("x".repeat(3500))) };
    let calls = 0, recursive = false;
    await boundedNativeSummary(input, 5000, estimate, async part => {
        calls++;
        const size = part.messages.reduce((n, m) => n + estimate(m), 0);
        assert.ok(size <= 5000, "framing must be included in every provider input budget");
        if (part.messages.some(m => m.content[0].text?.includes("reduction round 2"))) recursive = true;
        return { summary: [{ type: "text", text: "small summary" }] };
    });
    assert.ok(calls > 9, "framed summaries need a second bounded reduction");
    assert.equal(recursive, true);
});

test("framing that cannot shrink within a tiny budget fails before an oversized merge call", async () => {
    const input = { messages: [message("x".repeat(60)), message("y".repeat(60))] };
    let calls = 0;
    await assert.rejects(boundedNativeSummary(input, 100, estimate, async part => {
        calls++;
        assert.ok(part.messages.reduce((n, m) => n + estimate(m), 0) <= 100);
        return { summary: [{ type: "text", text: "tiny" }] };
    }), /no progress/);
    assert.equal(calls, 2);
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

test("native summary budgets large multilingual tool catalogs in host tokens, preserving schemas on every batch", async () => {
    configureNativeCompaction([{ model: "gpt-*" }]);
    const agent = { session: { id: "large-tools", requestHeader: () => ({ config: { provider: "test", model: "gpt-luna" } }) } };
    const meter = (m: Parameters<Parameters<typeof apply>[0]["tokenMeter"]["estimateMessage"]>[0]) =>
        m.content.reduce((n, b) => n + Math.ceil((b.text?.length ?? 0) / 4) + 4, 4);
    const tools = Array.from({ length: 327 }, (_, i) => ({ name: `tool_${i}`, description: "Synthetic 工具目录 description. ".repeat(40), parameters: { type: "object", properties: {} } }));
    assert.ok(Buffer.byteLength(JSON.stringify(tools)) > 272000);
    const input = { tools, messages: [{ ...message("System rules."), role: "system" }, ...Array.from({ length: 6 }, (_, i) => message(`fact-${i} `.repeat(15000)))] };
    const before = structuredClone(input);
    let calls = 0;
    const seen = new Set<string>();
    const engine: Parameters<typeof apply>[0]["compaction"] = {
        config: { summarizationProvider: "", summarizationModel: "", maxTokens: 65536 },
        compactIfNeeded: async () => null, compactPressure: async () => null,
        compactRegion: async () => null, compactNow: async () => null,
        summarize: async part => {
            calls++;
            assert.equal(nativeSummaryActive(), true);
            assert.deepEqual(part.tools, tools);
            const schemaTokens = meter(message(JSON.stringify(part.tools)));
            assert.ok(part.messages.reduce((n, m) => n + meter(m), 0) + schemaTokens + 65536 + 4096 <= Math.floor(272000 * 0.9));
            for (const m of part.messages) for (const b of m.content) for (const fact of b.text?.match(/fact-\d/g) ?? []) seen.add(fact);
            return { summary: [{ type: "text", text: "Short retained facts." }] };
        },
    };
    const ctx: Parameters<typeof apply>[0] = { compaction: engine, tokenMeter: { estimateMessage: meter }, llm: { resolveModelInfo: async () => ({ context: { contextWindow: 272000 } }) }, on: () => undefined };
    apply(ctx);
    await engine.summarize(input, agent);
    assert.ok(calls > 1, "the tool reservation must force bounded batches");
    assert.equal(seen.size, 6);
    assert.deepEqual(input, before);
    const previousCalls = calls;
    await assert.rejects(engine.summarize({ messages: [message("fact")], tools: [{ description: "x".repeat(800000) }] }, agent), /insufficient input budget/);
    assert.equal(calls, previousCalls, "genuinely oversized schemas fail before egress");
});

test("multi-batch handoff discards partial reductions after a later failure or cancellation and can retry", async () => {
    const input = { messages: Array.from({ length: 4 }, (_, i) => message(`fact-${i} `.repeat(800))) };
    const before = structuredClone(input);
    let failedCalls = 0;
    await assert.rejects(boundedNativeSummary(input, 10000, estimate, async () => {
        if (++failedCalls === 2) throw new Error("second batch failed");
        return { summary: [{ type: "text", text: "partial" }] };
    }), /second batch failed/);
    assert.equal(failedCalls, 2);
    assert.deepEqual(input, before);

    const controller = new AbortController();
    let cancelledCalls = 0;
    await assert.rejects(boundedNativeSummary(input, 10000, estimate, async () => {
        if (++cancelledCalls === 2) controller.abort(new Error("cancelled during reduction"));
        return { summary: [{ type: "text", text: "partial" }] };
    }, controller.signal), /cancelled during reduction/);
    assert.equal(cancelledCalls, 2);
    assert.deepEqual(input, before);

    const seen = new Set<string>();
    const recovered = await boundedNativeSummary(input, 10000, estimate, async part => {
        for (const m of part.messages) for (const b of m.content) for (const fact of b.text?.match(/fact-\d/g) ?? []) seen.add(fact);
        return { summary: [{ type: "text", text: "recovered" }] };
    });
    assert.equal(seen.size, 4);
    assert.equal(recovered.summary[0].text, "recovered");
    assert.deepEqual(input, before);
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
        config: { summarizationProvider: "", summarizationModel: "", maxTokens: 100 },
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
    apply({ compaction: engine, tokenMeter: { estimateMessage: () => 10 }, llm: { resolveModelInfo: async () => ({ context: { contextWindow: 20000 } }) }, on: () => undefined });
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
