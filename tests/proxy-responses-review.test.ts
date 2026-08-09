import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesToCore, coreToResponses } from "../src/responses.ts";
import { compressLoopResponsesStream } from "../src/compress-loop-responses.ts";
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

// Review #1: standard function_call must round-trip as function_call (NOT be
// rewritten as custom_tool_call), and custom_tool_call must stay custom.
test("responses: preserves original tool-call item type by call_id", () => {
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
    const exec = rebuilt.find((i) => (i as { name?: string }).name === "exec");
    assert.equal(exec?.type, "custom_tool_call", "custom tool stays custom_tool_call");
    const execOut = rebuilt.find((i) => i.type === "custom_tool_call_output");
    assert.ok(execOut, "custom tool output is custom_tool_call_output");
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

function runWithReasoningKeep(mode: string | undefined, body: unknown) {
    const prev = process.env.ACP_REASONING_KEEP;
    if (mode === undefined) delete process.env.ACP_REASONING_KEEP;
    else process.env.ACP_REASONING_KEEP = mode;
    try {
        return responsesToCore(body as never);
    } finally {
        if (prev === undefined) delete process.env.ACP_REASONING_KEEP;
        else process.env.ACP_REASONING_KEEP = prev;
    }
}

// Agentic loop across three responses: reasoning from the two oldest responses
// sits before the last tool output (old, completed); reasoning after the last
// tool output belongs to the most recent response.
const reasoningLoopBody = {
    model: "o4-mini",
    input: [
        { type: "additional_tools", tools: [{ name: "shell" }] },
        { type: "message", role: "user", content: "go" },
        { type: "reasoning", id: "rs_old_1" },
        { type: "reasoning", id: "rs_old_2" },
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "out" },
        { type: "reasoning", id: "rs_new_1" },
        { type: "reasoning", id: "rs_new_2" },
    ],
};
const reasoningOf = (preamble: { type: string }[]) => preamble.filter((i) => i.type === "reasoning");

test("responses: default (recent) trims old reasoning, keeps most recent response", () => {
    const { preamble } = runWithReasoningKeep(undefined, reasoningLoopBody);
    const reasoning = reasoningOf(preamble);
    assert.equal(preamble.find((i) => i.type === "additional_tools")?.type, "additional_tools", "additional_tools always preserved");
    assert.deepEqual(reasoning.map((r) => (r as { id: string }).id), ["rs_new_1", "rs_new_2"], "only reasoning after last external input survives");
});

test("responses: ACP_REASONING_KEEP=all preserves every reasoning item (legacy)", () => {
    const { preamble } = runWithReasoningKeep("all", reasoningLoopBody);
    const reasoning = reasoningOf(preamble);
    assert.equal(reasoning.length, 4, "all four reasoning items preserved");
});

test("responses: ACP_REASONING_KEEP=none drops all reasoning items", () => {
    const { preamble } = runWithReasoningKeep("none", reasoningLoopBody);
    assert.equal(reasoningOf(preamble).length, 0, "no reasoning survives");
    assert.ok(preamble.find((i) => i.type === "additional_tools"), "additional_tools still preserved in none mode");
});

test("responses: recent mode keeps reasoning when it is the only (most recent) response", () => {
    const body = {
        model: "o4-mini",
        input: [
            { type: "message", role: "user", content: "u" },
            { type: "reasoning", id: "rs_only_1" },
            { type: "reasoning", id: "rs_only_2" },
        ],
    };
    const { preamble } = runWithReasoningKeep(undefined, body);
    assert.equal(reasoningOf(preamble).length, 2, "reasoning after the only user message is the most recent response and is kept");
});

test("responses: computer_call_output is a turn boundary (CUA loop)", () => {
    const body = {
        model: "computer-use-preview",
        input: [
            { type: "message", role: "user", content: "click the button" },
            { type: "reasoning", id: "rs_cua_old" },
            { type: "computer_call", call_id: "cc1", action: {}, status: "completed" },
            { type: "computer_call_output", call_id: "cc1", output: {} },
            { type: "reasoning", id: "rs_cua_new" },
        ],
    };
    const { preamble } = runWithReasoningKeep(undefined, body);
    const ids = reasoningOf(preamble).map((r) => (r as { id: string }).id);
    assert.deepEqual(ids, ["rs_cua_new"], "only reasoning after the last computer_call_output survives");
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
