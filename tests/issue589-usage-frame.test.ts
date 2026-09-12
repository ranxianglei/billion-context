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

const toolDelta = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] };
const finishChunk = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
const usageFrame = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 50000, completion_tokens: 10, total_tokens: 50010 } };

async function collect(adapter: ReturnType<typeof createOpenaiAdapter>, events: string[]): Promise<{ meta: string; kinds: string[] }> {
    let meta = "";
    const kinds: string[] = [];
    for await (const ev of adapter.parseStream(streamOf(events), 1)) {
        kinds.push(ev.kind);
        if (ev.kind === "meta") meta += ev.chunk.toString("utf8");
    }
    return { meta, kinds };
}

test("#589: raw tool-call round forwards the trailing usage-only frame verbatim", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const { meta } = await collect(adapter, [chunk(toolDelta), chunk(finishChunk), chunk(usageFrame), "data: [DONE]\n\n"]);
    const usageAt = meta.indexOf('"prompt_tokens":50000');
    const finishAt = meta.indexOf('"finish_reason":"tool_calls"');
    const doneAt = meta.indexOf("[DONE]");
    assert.ok(usageAt >= 0, `expected patched usage frame in client stream: ${meta}`);
    assert.ok(meta.includes('"total_tokens":50010'), meta);
    assert.ok(finishAt >= 0 && usageAt > finishAt, `usage frame must come after the finish chunk: ${meta}`);
    assert.ok(doneAt >= 0 && usageAt < doneAt, `usage frame must come before [DONE]: ${meta}`);
});

test("#589: non-tool rounds keep swallowing the trailing frame (rebuild embeds usage)", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const textDelta = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "hi there" } }] };
    const finishText = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    const { meta } = await collect(adapter, [chunk(textDelta), chunk(finishText), chunk(usageFrame), "data: [DONE]\n\n"]);
    assert.ok(!meta.includes("prompt_tokens"), `rebuild round must not forward the raw usage frame: ${meta}`);
});

test("#589: usage-only frame without usage field is not forwarded", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const emptyChoices = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [] };
    const { meta } = await collect(adapter, [chunk(toolDelta), chunk(finishChunk), chunk(emptyChoices), "data: [DONE]\n\n"]);
    assert.ok(!meta.includes("chat.completion.chunk\" }"), meta);
    const frames = meta.split("data: ").length - 1;
    assert.equal(frames, 3, `expected only tool-delta + finish + [DONE] frames: ${meta}`);
});
