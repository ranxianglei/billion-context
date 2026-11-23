import assert from "node:assert/strict";
import test from "node:test";
import { unwrapV1SseFrame, v1UnwrapStream, wrapV1SseFrame } from "../src/v1internal.ts";

const response = {
    candidates: [{ content: { role: "model", parts: [{ text: "你好🔥" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
};
const envelope = { response, traceId: "source-trace", metadata: { key: "value" } };

function multiline(value: unknown): string {
    const data = JSON.stringify(value, null, 2).split("\n").map(line => `data: ${line}`);
    return ["event: message", "id: 42", data[0]!, ": keep this comment", ...data.slice(1), "retry: 1000"].join("\n");
}

function payload(frame: string): unknown {
    const data = frame.split("\n").filter(line => line.startsWith("data:"))
        .map(line => line.charAt(5) === " " ? line.slice(6) : line.slice(5)).join("\n");
    return JSON.parse(data);
}

test("multiline unwrap consumes every data field and preserves the other SSE fields", () => {
    const frame = multiline(envelope);
    assert.deepEqual(payload(frame), envelope, "fixture is a complete SSE JSON payload");
    const actual = unwrapV1SseFrame(frame);
    assert.deepEqual(payload(actual), response);
    assert.deepEqual(actual.split("\n").filter(line => !line.startsWith("data:")),
        frame.split("\n").filter(line => !line.startsWith("data:")));
    assert.equal(unwrapV1SseFrame(actual), actual, "already-bare output is stable");
});

test("multiline wrap consumes every data field and produces one CloudCode envelope", () => {
    const actual = wrapV1SseFrame(multiline(response));
    assert.deepEqual(payload(actual), { response, traceId: "", metadata: {} });
    assert.equal(wrapV1SseFrame(actual), actual, "already-enveloped output is stable");
});

for (const eol of ["\n", "\r\n", "\r"]) {
    test(`multiline stream unwrapping survives one-byte chunks with ${JSON.stringify(eol)} line endings`, async () => {
        const text = (multiline(envelope) + "\n\n" + multiline(envelope) + "\n\n").replaceAll("\n", eol);
        const bytes = new TextEncoder().encode(text);
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
                controller.close();
            },
        });
        const actual = await new Response(v1UnwrapStream(stream)).text();
        assert.deepEqual(actual.trim().split("\n\n").map(payload), [response, response]);
    });
}

for (const frame of [
    "event: ping\n: keepalive",
    "data: [DONE]",
    "data: ",
    "data: not-json\ndata: still-not-json",
    "data: {\ndata: broken",
    "data: [\ndata: 1,2\ndata: ]",
]) {
    test(`non-object or incomplete data passes through unchanged: ${JSON.stringify(frame)}`, () => {
        assert.equal(unwrapV1SseFrame(frame), frame);
        assert.equal(wrapV1SseFrame(frame), frame);
    });
}
