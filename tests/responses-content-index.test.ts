import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createResponsesAdapter } from "../src/loop/adapter-responses.ts";
import { pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { emitStreamError } from "../src/stream-error.ts";
import { validateResponsesContentIndex } from "./wire-contract-fakes.ts";

function frame(event: Record<string, unknown>): string {
    return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function created(): string {
    return frame({ type: "response.created", response: { id: "resp_fixture", object: "response", status: "in_progress", output: [] } });
}

function payloads(raw: string): Record<string, unknown>[] {
    return raw.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function collector(): { res: ServerResponse; chunks: string[] } {
    const chunks: string[] = [];
    const res = {
        write(chunk: string | Buffer) { chunks.push(chunk.toString()); return true; },
        end() { return this; },
        once() { return this; },
        destroyed: false,
        writableEnded: false,
    } as unknown as ServerResponse;
    return { res, chunks };
}

async function consume(raw: string) {
    const requireSdk = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { default: OpenAI } = await import(pathToFileURL(requireSdk.resolve("openai")).href);
    const client = new OpenAI({
        apiKey: "synthetic-test-key",
        fetch: async () => new Response(raw, { headers: { "content-type": "text/event-stream" } }),
    });
    const stream = client.responses.stream({ model: "synthetic", input: "synthetic" });
    const deltas: Array<{ delta: string; content_index: number; output_index: number }> = [];
    stream.on("response.output_text.delta", (event: { delta: string; content_index: number; output_index: number }) => deltas.push(event));
    const response = await stream.finalResponse();
    return { deltas, response };
}

function upstreamText(text: string, contentIndex: number, id = "msg_fixture"): string {
    const earlier = Array.from({ length: contentIndex }, () => ({ type: "output_text", text: "earlier part" }));
    const content = [...earlier, { type: "output_text", text }];
    const item = { type: "message", id, role: "assistant", content };
    const ref = { item_id: id, output_index: 0, content_index: contentIndex };
    return created() + [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        ...earlier.map((part, index) => ({ type: "response.content_part.added", item_id: id, output_index: 0, content_index: index, part })),
        { type: "response.content_part.added", ...ref, part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", ...ref, delta: text },
        { type: "response.output_text.done", ...ref, text },
        { type: "response.content_part.done", ...ref, part: { type: "output_text", text } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item] } },
    ].map(frame).join("");
}

test("official Responses SDK consumes a legacy stream-error completion", async () => {
    const { res, chunks } = collector();
    emitStreamError(res, "responses", "kaboom", undefined, "completion");
    const { deltas, response } = await consume(created() + chunks.join(""));
    assert.deepEqual(deltas.map((event) => event.delta), ["\n❌ [ACP] stream error: kaboom"]);
    assert.equal(response.status, "completed");
    assert.equal(response.output[0].content[0].text, deltas[0].delta);
});

test("official Responses SDK still rejects the default native error", async () => {
    const { res, chunks } = collector();
    emitStreamError(res, "responses", "kaboom");
    await assert.rejects(consume(created() + chunks.join("")), { type: "error", code: "stream_error", message: "[acp-proxy: kaboom]" });
});

for (const kind of ["text", "marker"] as const) {
    test(`official Responses SDK consumes synthesized ${kind} content`, async () => {
        const adapter = createResponsesAdapter();
        const chunk = kind === "text" ? adapter.emitText("generated text") : adapter.emitMarker("acp_status", "ready");
        const events = payloads(chunk.toString());
        const item = events.find((event) => event.type === "response.output_item.done")?.item;
        assert.ok(item);
        const { deltas } = await consume(created() + chunk + frame({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item] } }));
        assert.equal(deltas.length, 1);
        assert.equal(deltas[0].content_index, 0);
        if (kind === "text") assert.equal(deltas[0].delta, "generated text");
        else assert.match(deltas[0].delta, /\[ACP\]/);
        assert.deepEqual(events.flatMap(validateResponsesContentIndex), []);
    });
}

for (const mode of ["proxy", "plugin"] as const) {
    for (const contentIndex of [0, 1]) {
        test(`${mode} Responses text flush preserves content index ${contentIndex}`, async () => {
            const input = upstreamText("Length: 10 m", contentIndex);
            const { res, chunks } = collector();
            if (mode === "plugin") {
                await pipePluginResponsesWithStrip(new Response(input).body!, res);
            } else {
                const adapter = createResponsesAdapter();
                for await (const event of adapter.parseStream(new Response(input).body!, 1)) {
                    if (event.kind === "meta") chunks.push(event.chunk.toString());
                    else if (event.kind === "text" && event.raw) chunks.push(event.raw.toString());
                }
                chunks.push(adapter.emitCompletion().toString());
            }
            const { deltas, response } = await consume(chunks.join(""));
            assert.deepEqual(deltas.map((event) => event.delta), ["Length: 10 ", "m"]);
            for (const delta of deltas) assert.equal(delta.content_index, contentIndex);
            assert.equal(response.output[0].content[contentIndex].text, "Length: 10 m");
            if (contentIndex > 0) assert.equal(response.output[0].content[0].text, "earlier part");
            assert.deepEqual(payloads(chunks.join("")).flatMap(validateResponsesContentIndex), []);
        });
    }
}

test("plugin Responses retry flush preserves its content index", async () => {
    const { res, chunks } = collector();
    let retries = 0;
    const echo = "\x3cacp tokens=\"1\" type=\"text\"\x3em00001\x3c/acp\x3e";
    await pipePluginResponsesWithStrip(new Response(upstreamText(echo, 0)).body!, res, undefined, undefined, async () => {
        retries++;
        return new Response(upstreamText("Length: 10 m", 0, "msg_retry")).body;
    });
    assert.equal(retries, 1);
    const { deltas } = await consume(chunks.join(""));
    assert.equal(deltas.map((event) => event.delta).join(""), "Length: 10 m");
    for (const delta of deltas) assert.equal(delta.content_index, 0);
    assert.deepEqual(payloads(chunks.join("")).flatMap(validateResponsesContentIndex), []);
});
