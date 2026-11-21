import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createOpenaiAdapter } from "../src/loop/adapter-openai.ts";
import { emitStreamError } from "../src/stream-error.ts";

// #7461: pin that the OpenAI chat stream the proxy synthesizes is accepted by
// the official `openai` SDK — the same guarantee #7402 established for the
// Responses wire. The three recent "synthesized stream rejected by the official
// client" bugs (#7401 content_index, #7405 buffer cap, #7136 usage) were all
// found only after the fact; this lane keeps them from regressing silently.

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
    const stream = client.chat.completions.stream({ model: "synthetic", messages: [{ role: "user", content: "synthetic" }] });
    const deltas: string[] = [];
    stream.on("content", (delta: string) => deltas.push(delta));
    const toolArgs: Array<{ name: string; index: number; arguments: string }> = [];
    stream.on("tool_calls.function.arguments.done", (event: { name: string; index: number; arguments: string }) => toolArgs.push(event));
    const final = await stream.finalChatCompletion();
    return { deltas, toolArgs, final };
}

// The upstream's first frame carries the assistant role; the adapter forwards it
// verbatim (firstRoundOnly) and never re-emits it. A synthesized stream must
// still open with it or the official SDK rejects the whole response
// ("missing role for choice 0").
const roleChunk =
    `data: ${JSON.stringify({ id: "chatcmpl-syn", object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`;

test("official OpenAI SDK consumes synthesized text content", async () => {
    const adapter = createOpenaiAdapter({ model: "synthetic" });
    const raw = roleChunk + adapter.emitText("generated text").toString() + adapter.emitCompletion().toString();
    const { deltas, final } = await consume(raw);
    assert.deepEqual(deltas, ["generated text"]);
    assert.equal(final.choices[0].message.content, "generated text");
    assert.equal(final.choices[0].finish_reason, "stop");
});

test("official OpenAI SDK consumes a synthesized tool call", async () => {
    const adapter = createOpenaiAdapter({ model: "synthetic" });
    const raw =
        roleChunk +
        adapter.emitToolCall({ name: "get_weather", callId: "call_1", arguments: '{"city":"Paris"}' }).toString() +
        adapter.emitCompletion({ finishReason: "tool_calls" }).toString();
    const { toolArgs, final } = await consume(raw);
    assert.equal(toolArgs.length, 1);
    assert.equal(toolArgs[0].name, "get_weather");
    assert.equal(toolArgs[0].arguments, '{"city":"Paris"}');
    const call = final.choices[0].message.tool_calls?.[0];
    assert.ok(call);
    assert.equal(call.function.name, "get_weather");
    assert.equal(call.function.arguments, '{"city":"Paris"}');
    assert.equal(final.choices[0].finish_reason, "tool_calls");
});

test("official OpenAI SDK keeps provider usage fields in the synthesized completion", async () => {
    // #7136: a synthesized completion must carry the provider's usage, not drop it.
    const adapter = createOpenaiAdapter({ model: "synthetic" });
    const raw =
        roleChunk +
        adapter.emitText("hi").toString() +
        adapter.emitCompletion({ finishReason: "stop", usage: { inputTokens: 11, outputTokens: 22, cachedTokens: 5 } }).toString();
    const { final } = await consume(raw);
    assert.ok(final.usage);
    assert.equal(final.usage.prompt_tokens, 11);
    assert.equal(final.usage.completion_tokens, 22);
    assert.equal(final.usage.total_tokens, 33);
    assert.equal((final.usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens, 5);
});

test("official OpenAI SDK consumes the legacy stream-error completion", async () => {
    // #7461: when the upstream dies before sending any bytes, this completion is
    // the client's FIRST frame — it must open with the assistant role or the
    // official SDK rejects the whole response ("missing role for choice 0"), the
    // same failure class as #7401 (Responses missing content_index).
    const { res, chunks } = collector();
    emitStreamError(res, "openai", "kaboom", undefined, "completion");
    const { final } = await consume(chunks.join(""));
    assert.equal(final.choices[0].message.content, "\n❌ [ACP] stream error: kaboom");
    assert.equal(final.choices[0].finish_reason, "stop");
});

test("official OpenAI SDK consumes the adapter's legacy error completion", async () => {
    // The loop-level twin of emitStreamError: an upstream HTTP error / empty body
    // before any bytes makes this the client's first frame — it must open with
    // the assistant role too.
    const adapter = createOpenaiAdapter({ model: "synthetic" }, undefined, undefined, undefined, "completion");
    const { final } = await consume(adapter.emitError("kaboom").toString());
    assert.equal(final.choices[0].message.content, "\n[acp-proxy: kaboom]\n");
    assert.equal(final.choices[0].finish_reason, "stop");
});

test("official OpenAI SDK still rejects the default native error", async () => {
    const { res, chunks } = collector();
    emitStreamError(res, "openai", "kaboom");
    await assert.rejects(consume(chunks.join("")), { message: "[acp-proxy: kaboom]" });
});

test("official OpenAI SDK consumes a proxy-mode re-emitted text stream", async () => {
    const upstream =
        `data: ${JSON.stringify({ id: "chatcmpl-up", object: "chat.completion.chunk", created: 1, model: "gpt-4", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "chatcmpl-up", object: "chat.completion.chunk", created: 1, model: "gpt-4", choices: [{ index: 0, delta: { content: "Length: 10 " }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "chatcmpl-up", object: "chat.completion.chunk", created: 1, model: "gpt-4", choices: [{ index: 0, delta: { content: "m" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "chatcmpl-up", object: "chat.completion.chunk", created: 1, model: "gpt-4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n";
    const { res, chunks } = collector();
    const adapter = createOpenaiAdapter({ model: "gpt-4" });
    let finishReason: string | undefined;
    for await (const event of adapter.parseStream(new Response(upstream).body!, 1)) {
        if (event.kind === "meta") chunks.push(event.chunk.toString());
        else if (event.kind === "text" && event.raw) chunks.push(event.raw.toString());
        else if (event.kind === "done") finishReason = event.finishReason;
    }
    chunks.push(adapter.emitCompletion({ finishReason }).toString());
    const { deltas, final } = await consume(chunks.join(""));
    assert.deepEqual(deltas, ["Length: 10 ", "m"]);
    assert.equal(final.choices[0].message.content, "Length: 10 m");
    assert.equal(final.choices[0].finish_reason, "stop");
});
