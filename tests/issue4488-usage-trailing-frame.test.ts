import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter } from "../src/loop/index.ts";

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(Buffer.from(events[i++], "utf8"));
            } else {
                controller.close();
            }
        },
    });
}

const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

type UsageSample = { inputTokens?: number; outputTokens?: number; cachedTokens?: number };

async function collect(adapter: ReturnType<typeof createOpenaiAdapter>, events: string[]): Promise<{ kinds: string[]; usages: UsageSample[]; meta: string }> {
    const kinds: string[] = [];
    const usages: UsageSample[] = [];
    let meta = "";
    for await (const ev of adapter.parseStream(streamOf(events), 1)) {
        kinds.push(ev.kind);
        if (ev.kind === "usage") usages.push({ inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedTokens: ev.cachedTokens });
        if (ev.kind === "meta") meta += ev.chunk.toString("utf8");
    }
    return { kinds, usages, meta };
}

// The exact #4488 repro shape: the finish chunk carries NO usage, and the real
// usage rides a SEPARATE trailing frame whose choices array stays NON-empty
// (one choice, EMPTY delta) with no finish_reason.
const textDelta = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "hello world" } }] };
const finishNoUsage = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const trailingUsage = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 50000, completion_tokens: 10, total_tokens: 50010 } };

test("#4488: usage on a non-empty-choices empty-delta trailing frame is harvested into the ledger", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const { usages } = await collect(adapter, [chunk(textDelta), chunk(finishNoUsage), chunk(trailingUsage), "data: [DONE]\n\n"]);
    // Before the fix the ONLY usage event came from the usage-less finish chunk
    // (all fields undefined); no event carried the real numbers.
    const hit = usages.find((u) => u.inputTokens === 50000 && u.outputTokens === 10);
    assert.ok(hit, `expected a harvested usage event prompt=50000 completion=10, got: ${JSON.stringify(usages)}`);
    // core.ts consumes usage last-wins: the trailing frame is the last usage-bearing
    // frame, so the final settled sample must be the real one, not the undefined one.
    const last = usages[usages.length - 1];
    assert.equal(last.inputTokens, 50000, `final usage sample must be the trailing frame's, got ${JSON.stringify(last)}`);
});

test("#4488: cached-token detail on the trailing frame is normalized too", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const withCache = { ...trailingUsage, usage: { prompt_tokens: 50000, completion_tokens: 10, total_tokens: 50010, prompt_tokens_details: { cached_tokens: 4096 } } };
    const { usages } = await collect(adapter, [chunk(textDelta), chunk(finishNoUsage), chunk(withCache), "data: [DONE]\n\n"]);
    const last = usages[usages.length - 1];
    assert.equal(last.cachedTokens, 4096, `expected cached=4096 from prompt_tokens_details, got ${JSON.stringify(last)}`);
});

test("#4488: an empty-delta trailing frame WITHOUT a usage field fabricates no usage event", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const noUsageFrame = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {} }] };
    const { usages } = await collect(adapter, [chunk(textDelta), chunk(noUsageFrame), "data: [DONE]\n\n"]);
    assert.equal(usages.length, 0, `guard must not emit a spurious usage event, got: ${JSON.stringify(usages)}`);
});

test("#4488: usage embedded on the finish_reason frame is still harvested (existing path intact)", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const finishWithUsage = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 777, completion_tokens: 5, total_tokens: 782 } };
    const { usages } = await collect(adapter, [chunk(textDelta), chunk(finishWithUsage), "data: [DONE]\n\n"]);
    const hit = usages.find((u) => u.inputTokens === 777 && u.outputTokens === 5);
    assert.ok(hit, `finish-frame usage must still be harvested, got: ${JSON.stringify(usages)}`);
});

test("#4488: client-visible stream unchanged — the trailing frame still reaches the client via the empty-delta forward", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const { meta } = await collect(adapter, [chunk(textDelta), chunk(finishNoUsage), chunk(trailingUsage), "data: [DONE]\n\n"]);
    // Pins the deliberate no-`continue`: the frame must STILL be forwarded to the
    // client exactly as pre-fix. Adding a `continue` in the harvest branch would drop
    // this and silently change the client-visible stream.
    assert.ok(meta.includes('"prompt_tokens":50000'), `trailing usage frame must still be forwarded to the client: ${meta}`);
    assert.ok(meta.includes('"total_tokens":50010'), meta);
    // The visible text rides the structured text channel, never this meta forward.
    assert.ok(!meta.includes("hello world"), `text must not leak into the meta forward: ${meta}`);
});

test("#4488: tool-call round also harvests the trailing frame's usage (raw forward preserved)", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const toolDelta = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] };
    const finishTool = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    const toolTrailing = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 60000, completion_tokens: 20, total_tokens: 60020 } };
    const { usages, meta } = await collect(adapter, [chunk(toolDelta), chunk(finishTool), chunk(toolTrailing), "data: [DONE]\n\n"]);
    const hit = usages.find((u) => u.inputTokens === 60000 && u.outputTokens === 20);
    assert.ok(hit, `tool-call round must harvest the trailing usage, got: ${JSON.stringify(usages)}`);
    const usageAt = meta.indexOf('"prompt_tokens":60000');
    const finishAt = meta.indexOf('"finish_reason":"tool_calls"');
    assert.ok(usageAt >= 0 && finishAt >= 0 && usageAt > finishAt, `trailing usage frame must follow the finish chunk: ${meta}`);
});
