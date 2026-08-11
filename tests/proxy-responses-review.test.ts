import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesToCore, coreToResponses, patchResponsesInput, injectResponsesDeveloperMessage } from "../src/responses.ts";
import { compressLoopResponsesJson } from "../src/compress-loop-responses.ts";
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
    assert.equal(rebuilt.some((i) => i.type === "custom_tool_call"), true, "custom calls ARE projected into tracked CoreMessages (PR#75)");
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

test("compressLoopResponsesJson: read-only acp_status executes once, surfaces marker, NO upstream re-request (炸锅 regression, JSON path)", async () => {
    let fetchCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(JSON.stringify({ id: "resp_never", status: "completed", output: [] }), {
            status: 200, headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
    try {
        const initial = {
            id: "resp_st_json",
            status: "completed",
            output: [{
                type: "function_call",
                id: "fc_st",
                call_id: "call_st",
                name: "acp_status",
                arguments: "{}",
            }],
        };
        const out = await compressLoopResponsesJson(initial, makeCtx(() => {}), {
            model: "gpt-4o",
            input: [{ type: "message", role: "user", content: "status?" }],
        }, { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        assert.equal(fetchCalls, 0, "read-only acp_status must NOT trigger an upstream re-request (JSON path)");
        const outputs = out.output as Array<Record<string, unknown>>;
        const joined = JSON.stringify(outputs);
        assert.ok(joined.includes("📊"), "acp_status marker (📊) appended to JSON output");
        assert.ok(joined.includes("[ACP]"), "[ACP] visibility tag present in marker");
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("compressLoopResponsesJson: real tool + read-only acp_status surfaces marker AND preserves real call (Q2 stream/JSON parity)", async () => {
    let fetchCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(JSON.stringify({ id: "resp_never", status: "completed", output: [] }), {
            status: 200, headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
    try {
        const initial = {
            id: "resp_rmx_json",
            status: "completed",
            output: [
                { type: "function_call", id: "fc_shell", call_id: "call_shell", name: "shell", arguments: '{"cmd":"ls"}' },
                { type: "function_call", id: "fc_st", call_id: "call_st", name: "acp_status", arguments: "{}" },
            ],
        };
        const out = await compressLoopResponsesJson(initial, makeCtx(() => {}), {
            model: "gpt-4o",
            input: [{ type: "message", role: "user", content: "run + status" }],
        }, { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        assert.equal(fetchCalls, 0, "no MUTATING tool present → must NOT re-request");
        const outputs = out.output as Array<Record<string, unknown>>;
        const joined = JSON.stringify(outputs);
        assert.ok(joined.includes("📊"), "acp_status marker surfaced even when a real tool accompanies it (regression: JSON used to drop it)");
        assert.ok(joined.includes('"shell"'), "the real tool call is preserved in output so the client can execute it");
    } finally {
        globalThis.fetch = previousFetch;
    }
});
