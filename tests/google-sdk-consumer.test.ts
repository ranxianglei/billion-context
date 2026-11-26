import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ServerResponse } from "node:http";
import { createGoogleAdapter } from "../src/loop/adapter-google.ts";

// #7461: pin that the Gemini stream the proxy synthesizes is accepted by the
// official `@google/genai` SDK — the same guarantee #7402 established for the
// Responses wire and the openai/anthropic consumers in this suite. Unlike the
// other two SDKs, `@google/genai`'s `models.generateContentStream` path uses the
// GLOBAL fetch (no `fetch` option on the client), so the consumer runs against a
// local HTTP server that serves the synthesized byte stream.

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
    const { GoogleGenAI } = await import(pathToFileURL(requireSdk.resolve("@google/genai")).href);
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(raw);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
        const client = new GoogleGenAI({ apiKey: "synthetic-test-key", httpOptions: { baseUrl: `http://127.0.0.1:${port}` } });
        const stream = await client.models.generateContentStream({ model: "synthetic", contents: "synthetic" });
        const chunks: Array<{ text?: string; candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }>; usageMetadata?: Record<string, unknown> }> = [];
        for await (const chunk of stream) chunks.push(chunk);
        return { chunks };
    } finally {
        server.close();
    }
}

test("official Google SDK consumes synthesized text content", async () => {
    const adapter = createGoogleAdapter({ model: "synthetic" });
    const raw = adapter.emitText("generated ").toString() + adapter.emitText("text").toString() + adapter.emitCompletion({ finishReason: "stop" }).toString();
    const { chunks } = await consume(raw);
    const text = chunks.flatMap((c) => (c.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "")).join("");
    assert.equal(text, "generated text");
    assert.equal(chunks[chunks.length - 1].candidates?.[0]?.finishReason, "STOP");
});

test("official Google SDK consumes a synthesized tool call", async () => {
    const adapter = createGoogleAdapter({ model: "synthetic" });
    const raw =
        adapter.emitToolCall({ name: "get_weather", callId: "call_1", arguments: '{"city":"Paris"}' }).toString() +
        adapter.emitCompletion({ finishReason: "tool_calls" }).toString();
    const { chunks } = await consume(raw);
    const parts = chunks.flatMap((c) => c.candidates?.[0]?.content?.parts ?? []);
    const fc = parts.find((p) => p.functionCall) as { functionCall: { name: string; args: unknown } } | undefined;
    assert.ok(fc);
    assert.equal(fc.functionCall.name, "get_weather");
    assert.deepEqual(fc.functionCall.args, { city: "Paris" });
    assert.equal(chunks[chunks.length - 1].candidates?.[0]?.finishReason, "STOP");
});

test("official Google SDK keeps provider usage fields in the synthesized completion", async () => {
    const adapter = createGoogleAdapter({ model: "synthetic" });
    const raw =
        adapter.emitText("hi").toString() +
        adapter.emitCompletion({ finishReason: "stop", usage: { inputTokens: 11, outputTokens: 22, cachedTokens: 7 } }).toString();
    const { chunks } = await consume(raw);
    const usage = chunks[chunks.length - 1].usageMetadata;
    assert.equal(usage?.promptTokenCount, 11);
    assert.equal(usage?.candidatesTokenCount, 22);
    assert.equal(usage?.totalTokenCount, 33);
    assert.equal(usage?.cachedContentTokenCount, 7);
});

test("official Google SDK consumes the adapter's error frame as an empty chunk", async () => {
    // Unlike the OpenAI/Anthropic SDKs (which throw on their native error frame so
    // the client's retry logic fires), the Google SDK's streaming parser does not
    // recognize the top-level `error` frame as a failure — it parses it as a chunk
    // with no candidates. Pinned here so a future SDK change that DOES surface the
    // error (or a change to this frame's shape) is a visible, deliberate diff.
    const adapter = createGoogleAdapter({ model: "synthetic" });
    const raw = adapter.emitError("kaboom").toString();
    const { chunks } = await consume(raw);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].candidates?.length ?? 0, 0);
    assert.equal(chunks[0].usageMetadata, undefined);
});

test("official Google SDK consumes a proxy-mode re-emitted text stream", async () => {
    const upstream =
        `data: ${JSON.stringify({ modelVersion: "gemini-up", candidates: [{ content: { role: "model", parts: [{ text: "Length: 10 " }] }, index: 0 }] })}\n\n` +
        `data: ${JSON.stringify({ modelVersion: "gemini-up", candidates: [{ content: { role: "model", parts: [{ text: "m" }] }, index: 0 }] })}\n\n` +
        `data: ${JSON.stringify({ modelVersion: "gemini-up", candidates: [{ content: { role: "model", parts: [] }, index: 0, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 } })}\n\n`;
    const { res, chunks } = collector();
    const adapter = createGoogleAdapter({ model: "synthetic" });
    let finishReason: string | undefined;
    for await (const event of adapter.parseStream(new Response(upstream).body!, 1)) {
        if (event.kind === "meta") chunks.push(event.chunk.toString());
        else if (event.kind === "text" && event.raw) chunks.push(event.raw.toString());
        else if (event.kind === "done") finishReason = event.finishReason;
    }
    chunks.push(adapter.emitCompletion({ finishReason }).toString());
    const { chunks: consumed } = await consume(chunks.join(""));
    const text = consumed.flatMap((c) => (c.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "")).join("");
    assert.equal(text, "Length: 10 m");
});
