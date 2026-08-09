import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesToCore, coreToResponses, patchResponsesInput, injectResponsesDeveloperMessage } from "../src/responses.ts";
import { compressLoopResponsesJson, compressLoopResponsesStream } from "../src/compress-loop-responses.ts";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { getSession } from "../src/session.ts";

function makeCtx(log: (m: string) => void): { core: ReturnType<typeof createCore>; config: Config; messages: CoreMessage[]; session: Session; log: (m: string) => void } {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: getSession("test-session"),
        log,
    };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of compressLoopResponsesStream(stream, makeCtx(() => {}), { model: "gpt-4o", input: [{ type: "message", role: "user", content: "hi" }], stream: true }, { url: "http://unused", headers: {} })) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function sse(type: string, data: unknown, eol = "\n"): string {
    return `event: ${type}${eol}data: ${JSON.stringify(data)}${eol}${eol}`;
}

// Standard function calls remain compressible. Codex custom items stay in the
// lossless sidecar and never enter ACP's mutable projection.
test("responses: preserves standard and custom tool-call item types", () => {
    const body = {
        model: "gpt-5.6-sol",
        input: [
            { type: "message", role: "user", content: "what's the weather?" },
            // a standard function tool call
            { type: "function_call", call_id: "call_std_1", name: "get_weather", arguments: '{"city":"NYC"}' },
            { type: "function_call_output", call_id: "call_std_1", output: "sunny" },
            // a custom (code_mode exec) tool call
            { type: "custom_tool_call", call_id: "call_cus_1", name: "exec", input: "ls", status: "completed" },
            { type: "custom_tool_call_output", call_id: "call_cus_1", output: "file.txt" },
        ],
    };
    const { msgs, customToolCallIds } = responsesToCore(body as never);
    assert.ok(customToolCallIds.has("call_cus_1"), "custom tool call_id recorded");
    assert.ok(!customToolCallIds.has("call_std_1"), "standard tool call_id NOT recorded as custom");
    const rebuilt = coreToResponses(msgs, customToolCallIds);
    const getWeather = rebuilt.find((i) => (i as { name?: string }).name === "get_weather");
    assert.equal(getWeather?.type, "function_call", "standard function tool stays function_call");
    const getWeatherOut = rebuilt.find((i) => i.type === "function_call_output");
    assert.ok(getWeatherOut, "standard function tool output is function_call_output");
    assert.equal(rebuilt.some((i) => i.type === "custom_tool_call"), false, "custom calls are not projected into mutable CoreMessages");
    assert.deepEqual(patchResponsesInput(responsesToCore(body as never), msgs), body.input);
});

// Review #4: unknown / future item type is preserved (not dropped).
test("responses: unknown item type is preserved in preamble", () => {
    const body = {
        model: "gpt-4o",
        input: [
            { type: "future_item_kind", payload: { anything: true } },
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs, preamble } = responsesToCore(body as never);
    assert.equal(preamble.length, 1, "unknown item preserved in preamble");
    assert.equal(preamble[0].type, "future_item_kind");
    assert.equal(msgs.length, 1, "only the real message enters compression");
});

test("responses: no-op projection is byte-structure lossless", () => {
    const input = [
        { type: "additional_tools", tools: [{ type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }] },
        { type: "message", id: "msg_u1", status: "completed", role: "user", content: [
            { type: "input_text", text: "inspect this", annotations: [] },
            { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "high" },
        ] },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ciphertext", status: "completed" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}", status: "completed" },
        { type: "function_call_output", id: "out_1", call_id: "call_1", output: "ok", status: "completed" },
        { type: "custom_tool_call", id: "ctc_1", call_id: "custom_1", name: "exec", input: "dir", status: "completed" },
        { type: "custom_tool_call_output", id: "ctco_1", call_id: "custom_1", output: "file.txt", status: "completed" },
        { type: "program", id: "future_1", code: "print(1)", vendor: { untouched: true } },
    ];
    const projection = responsesToCore({ model: "gpt-5", input } as never);
    const patched = patchResponsesInput(projection, projection.msgs);
    assert.deepEqual(patched, input);
});

test("responses: text patch preserves images, ids, status, opaque items and order", () => {
    const input = [
        { type: "reasoning", id: "r1", encrypted_content: "secret" },
        { type: "message", id: "m1", status: "completed", role: "user", content: [
            { type: "input_text", text: "hello", annotations: ["keep"] },
            { type: "input_image", image_url: "https://example.test/image.png", detail: "high" },
        ] },
        { type: "future_item", id: "z1", payload: 7 },
    ];
    const projection = responsesToCore({ input } as never);
    const changed = projection.msgs.map((message) => ({ ...message, text: "tagged hello" }));
    const patched = patchResponsesInput(projection, changed) as typeof input;
    assert.equal(patched[0], input[0]);
    assert.equal(patched[2], input[2]);
    assert.equal(patched[1].id, "m1");
    assert.equal(patched[1].status, "completed");
    assert.deepEqual((patched[1].content as Array<Record<string, unknown>>)[1], input[1].content[1]);
    assert.equal((patched[1].content as Array<Record<string, unknown>>)[0].text, "tagged hello");
});

test("responses: ACP developer prompt is inserted after leading additional_tools only", () => {
    const input = [
        { type: "additional_tools", tools: [] },
        { type: "reasoning", id: "r1", encrypted_content: "secret" },
        { type: "message", role: "user", content: "hello" },
    ];
    const out = injectResponsesDeveloperMessage(input as never, "ACP prompt");
    assert.deepEqual(out.map((item) => item.type), ["additional_tools", "message", "reasoning", "message"]);
    assert.equal(out[2], input[1]);
});

// Review #2: response.failed terminal is replayed verbatim and NOT followed by
// a fabricated response.completed (which would contradict the failure).
test("compressLoopResponsesStream: response.failed is replayed without a contradictory completed", async () => {
    const events = [
        sse("response.created", { response: { id: "resp_f", status: "in_progress" } }),
        sse("response.output_item.added", { item: { type: "message", id: "m1", role: "assistant", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "m1", output_index: 0, delta: "partial" }),
        sse("response.failed", { response: { id: "resp_f", status: "failed", error: { code: "rate_limit_exceeded", message: "boom" } } }),
    ].join("");
    const out = await drain(new Response(events).body!);
    assert.ok(out.includes("response.failed"), "response.failed replayed to client");
    assert.ok(out.includes("boom"), "failure detail preserved");
    // The critical assertion: NO fabricated response.completed after the failure.
    assert.ok(!out.includes("response.completed"), "no contradictory response.completed emitted");
});

// Review #3: CRLF line endings (\r\n\r\n separators) parse correctly — without
// the fix, these events vanish entirely and the proxy synthesizes a bogus id.
test("compressLoopResponsesStream: CRLF (\\r\\n) SSE line endings are parsed", async () => {
    const crlf = "\r\n";
    const events = [
        sse("response.created", { response: { id: "resp_crlf", status: "in_progress" } }, crlf),
        sse("response.output_item.added", { item: { type: "message", id: "m1", role: "assistant", content: [] }, output_index: 0 }, crlf),
        sse("response.output_text.delta", { item_id: "m1", output_index: 0, delta: "CRLF works" }, crlf),
        sse("response.output_item.done", { item: { type: "message", id: "m1" }, output_index: 0 }, crlf),
        sse("response.completed", { response: { id: "resp_crlf", status: "completed", output: [] } }, crlf),
    ].join("");
    const out = await drain(new Response(events).body!);
    assert.ok(out.includes("CRLF works"), "CRLF-delimited delta content passed through");
    assert.ok(out.includes("response.created"), "CRLF response.created parsed (stream opened)");
    assert.ok(out.includes("response.completed"), "CRLF response.completed parsed");
    // Must not fabricate a fallback id (sign the separator was missed).
    assert.ok(!out.includes("resp-proxy-"), "no synthesized fallback response id");
});

test("compressLoopResponsesJson: Codex text trigger is intercepted and re-requested", async () => {
    const previousFetch = globalThis.fetch;
    let forwarded: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
            id: "resp_final",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
        const initial = {
            id: "resp_trigger",
            status: "completed",
            output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: '<acp_compress>{"content":[]}</acp_compress>' }],
            }],
        };
        const request = {
            model: "gpt-5",
            input: [{ type: "additional_tools", tools: [{ type: "custom", name: "exec" }] }, { type: "message", role: "user", content: "hello" }],
        };
        const output = await compressLoopResponsesJson(initial, { ...makeCtx(() => {}), textProtocol: true }, request, {
            url: "https://unused.example/responses",
            headers: { "content-type": "application/json" },
        });
        const message = (output.output as Array<Record<string, unknown>>)[0]!;
        const part = (message.content as Array<Record<string, unknown>>)[0]!;
        assert.equal(part.text, "done");
        assert.ok(forwarded);
        const items = forwarded.input as Array<Record<string, unknown>>;
        assert.equal(items[0]!.type, "additional_tools");
        assert.equal(items.some((item) => item.type === "function_call" || item.type === "function_call_output"), false);
        assert.match(String(items.at(-1)?.content), /ACP/);
    } finally {
        globalThis.fetch = previousFetch;
    }
});
