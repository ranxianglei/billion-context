import test from "node:test";
import assert from "node:assert/strict";
import { DEGENERATE_RETRY_NUDGE, injectContinuationNudge, makeContinuationRefetch } from "../src/degenerate-retry.ts";
import { FAKE_COMPLETION_HINT, injectFakeCompletionHint } from "../src/fake-completion.ts";
import { withFetchTransport } from "../src/fetch-transport.ts";
import { _resetFetchUtilForTest } from "../src/fetch-util.ts";

const builders = [
    { name: "continuation", build: injectContinuationNudge, hint: DEGENERATE_RETRY_NUDGE },
    { name: "fake completion", build: injectFakeCompletionHint, hint: FAKE_COMPLETION_HINT },
];

for (const { name, build, hint } of builders) {
    for (const buffer of [false, true]) {
        test(`${name} recovery preserves Responses string input (${buffer ? "Buffer" : "string"} body)`, () => {
            for (const prompt of ["hello", "first\n中文 😀 \\\"quoted\\\"", ""]) {
                const request = {
                    model: "m", input: prompt, instructions: "Keep this instruction",
                    previous_response_id: "prior", store: false, temperature: 0.3,
                    metadata: { test: "unchanged" }, tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
                };
                const serialized = JSON.stringify(request);
                const result = build("responses", buffer ? Buffer.from(serialized) : serialized);
                assert.notEqual(result, null);
                assert.deepEqual(JSON.parse(result!), { ...request, input: `${prompt}\n\n${hint}` });
            }
        });
    }

    test(`${name} recovery keeps existing Responses array behavior`, () => {
        const input = [{ role: "user", content: [{ type: "input_text", text: "prompt" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] }];
        const result = build("responses", JSON.stringify({ model: "m", input }));
        assert.deepEqual(JSON.parse(result!).input, [{ role: "user", content: [...input[0].content, { type: "input_text", text: hint }] }]);
        const assistant = [{ role: "assistant", content: "answer" }];
        assert.deepEqual(JSON.parse(build("responses", JSON.stringify({ input: assistant }))!).input,
            [...assistant, { role: "user", content: [{ type: "input_text", text: hint }] }]);
    });
}

test("recovery still declines absent, malformed and unsupported input shapes", () => {
    for (const { build } of builders) {
        for (const body of ["{broken", "{}", '{"input":null}', '{"input":42}', '{"input":{}}']) {
            assert.equal(build("responses", body), null);
        }
    }
});

for (const buffer of [false, true]) {
    test(`string-input continuation actually reaches the transport (${buffer ? "Buffer" : "string"} body)`, async () => {
        const request = { model: "m", input: "original prompt 😀", instructions: "preserve", store: false };
        const serialized = JSON.stringify(request);
        const controller = new AbortController();
        const bytes = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
        let calls = 0;
        try {
            const body = await withFetchTransport(async (url, options) => {
                calls++;
                assert.equal(url, "https://recovery.invalid/v1/responses");
                assert.equal(options.method, "POST");
                assert.equal(typeof options.body, "string");
                assert.deepEqual(JSON.parse(options.body as string), { ...request, input: `${request.input}\n\n${DEGENERATE_RETRY_NUDGE}` });
                return new Response(bytes, { headers: { "content-type": "text/event-stream" } });
            }, () => makeContinuationRefetch({
                protocol: "responses", body: buffer ? Buffer.from(serialized) : serialized,
                upstreamUrl: "https://recovery.invalid/v1/responses", reqHeaders: {},
                signal: controller.signal, label: "string-input", log: () => {},
            })());
            assert.equal(calls, 1);
            assert.ok(body);
            assert.equal(await new Response(body).text(), bytes);
        } finally {
            controller.abort();
            _resetFetchUtilForTest();
        }
    });
}

test("an already-aborted string-input continuation sends nothing", async () => {
    let calls = 0;
    const body = await withFetchTransport(async () => {
        calls++;
        return new Response("unexpected");
    }, () => makeContinuationRefetch({
        protocol: "responses", body: JSON.stringify({ input: "prompt" }),
        upstreamUrl: "https://recovery.invalid/v1/responses", reqHeaders: {},
        signal: AbortSignal.abort(), label: "aborted", log: () => {},
    })());
    assert.equal(body, null);
    assert.equal(calls, 0);
});
