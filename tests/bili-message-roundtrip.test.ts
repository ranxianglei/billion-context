import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "../src/anthropic.ts";
import { openaiToCore, coreToOpenai } from "../src/openai.ts";
import { responsesToCore, coreToResponses } from "../src/responses.ts";
import type { AnthropicBlock, AnthropicRequestBody } from "../src/anthropic.ts";
import type { OpenAIRequestBody } from "../src/openai.ts";
import type { ResponsesRequestBody } from "../src/responses.ts";

const IMG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DATA_URL = `data:image/png;base64,${IMG_DATA}`;

function block(rebuilt: { content: string | AnthropicBlock[] }, i: number): Record<string, unknown> {
    return (rebuilt.content as unknown[])[i] as Record<string, unknown>;
}

// 1. Anthropic image block round-trips losslessly (source.base64 + media_type).
test("anthropic: image block is restored verbatim via rawAnthropicBlock", () => {
    const source = { type: "base64", media_type: "image/png", data: IMG_DATA };
    const body: AnthropicRequestBody = {
        model: "claude",
        max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "image", source }] }],
    };
    const { msgs } = anthropicToCore(body);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.contentType, "text");
    assert.equal(msgs[0]?.text, "[image]");
    assert.ok(msgs[0]?.rawAnthropicBlock, "sidecar rawAnthropicBlock stored");
    const rebuilt = coreToAnthropic(msgs);
    assert.equal(rebuilt.length, 1);
    const img = block(rebuilt[0]!, 0);
    assert.equal(img.type, "image", "image block reconstructed (not a text placeholder)");
    assert.deepEqual(img.source, source, "source preserved verbatim (base64 + media_type)");
});

// 2. Anthropic thinking + signature round-trips (signature was previously dropped).
test("anthropic: thinking signature is restored", () => {
    const body: AnthropicRequestBody = {
        model: "claude",
        max_tokens: 100,
        messages: [
            { role: "assistant", content: [{ type: "thinking", thinking: "let me consider", signature: "sig_EqMAC" }] },
        ],
    };
    const { msgs } = anthropicToCore(body);
    assert.equal(msgs[0]?.contentType, "reasoning");
    assert.equal(msgs[0]?.thinkingSignature, "sig_EqMAC", "thinkingSignature sidecar stored");
    const rebuilt = coreToAnthropic(msgs);
    const th = block(rebuilt[0]!, 0);
    assert.equal(th.type, "thinking");
    assert.equal(th.thinking, "let me consider");
    assert.equal(th.signature, "sig_EqMAC", "signature reattached (Anthropic rejects thinking without it)");
});

// 3. Anthropic tool_result.is_error round-trips (was previously dropped).
test("anthropic: tool_result.is_error is restored", () => {
    const body: AnthropicRequestBody = {
        model: "claude",
        max_tokens: 100,
        messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
        ],
    };
    const { msgs } = anthropicToCore(body);
    const result = msgs.find((m) => m.contentType === "tool-result");
    assert.equal(result?.toolIsError, true, "toolIsError sidecar stored");
    const rebuilt = coreToAnthropic(msgs);
    const userMsg = rebuilt.find((m) => m.role === "user")!;
    const tr = block(userMsg, 0);
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.is_error, true, "is_error reconstructed");
});

// 3b. Sanity: a non-error tool_result does NOT gain is_error.
test("anthropic: tool_result without is_error stays clean", () => {
    const body: AnthropicRequestBody = {
        model: "claude",
        max_tokens: 100,
        messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        ],
    };
    const { msgs } = anthropicToCore(body);
    const result = msgs.find((m) => m.contentType === "tool-result");
    assert.equal(result?.toolIsError, undefined);
    const rebuilt = coreToAnthropic(msgs);
    const userMsg = rebuilt.find((m) => m.role === "user")!;
    const tr = block(userMsg, 0);
    assert.equal(tr.is_error, undefined, "no spurious is_error");
});

// 4. OpenAI developer role round-trips (was collapsed to system).
test("openai: developer role is restored", () => {
    const body: OpenAIRequestBody = { messages: [{ role: "developer", content: "you are a dev" }] };
    const { msgs } = openaiToCore(body);
    assert.equal(msgs[0]?.role, "system", "kernel sees system");
    assert.equal(msgs[0]?.originalRole, "developer", "originalRole sidecar stored");
    const rebuilt = coreToOpenai(msgs);
    assert.equal(rebuilt[0]?.role, "developer", "developer role reconstructed");
    assert.equal(rebuilt[0]?.content, "you are a dev");
});

// 4b. Sanity: a plain system role is NOT promoted to developer.
test("openai: system role stays system", () => {
    const body: OpenAIRequestBody = { messages: [{ role: "system", content: "sys" }] };
    const { msgs } = openaiToCore(body);
    assert.equal(msgs[0]?.originalRole, "system");
    const rebuilt = coreToOpenai(msgs);
    assert.equal(rebuilt[0]?.role, "system");
});

// 5. OpenAI image_url round-trips (image was previously dropped entirely).
test("openai: user image_url content part is restored", () => {
    const body: OpenAIRequestBody = {
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "what is this?" },
                    { type: "image_url", image_url: { url: DATA_URL } },
                ],
            },
        ],
    };
    const { msgs } = openaiToCore(body);
    assert.ok(msgs[0]?.text?.startsWith("what is this?"), "text preserved");
    assert.equal(msgs[0]?.imageMediaType, "image/png");
    assert.equal(msgs[0]?.imageBase64, IMG_DATA);
    assert.ok(msgs[0]?.rawOpenaiContent, "rawOpenaiContent sidecar stored");
    const rebuilt = coreToOpenai(msgs);
    const u = rebuilt[0]!;
    assert.equal(u.role, "user");
    assert.ok(Array.isArray(u.content), "content rebuilt as array (text + image)");
    const parts = u.content as unknown as { type: string; [k: string]: unknown }[];
    const text = parts.find((p) => p.type === "text");
    assert.ok(typeof text?.text === "string" && text.text.startsWith("what is this?"));
    const img = parts.find((p) => p.type === "image_url");
    assert.ok(img, "image_url part reconstructed");
    assert.deepEqual((img as unknown as { image_url: { url: string } }).image_url.url, DATA_URL, "image data URL restored");
});

// 6. Responses API input_image round-trips (image was previously dropped).
test("responses: user input_image is restored via rawResponsesItem", () => {
    const body: ResponsesRequestBody = {
        input: [
            {
                type: "message",
                role: "user",
                content: [
                    { type: "input_text", text: "see this" },
                    { type: "input_image", image_url: DATA_URL },
                ],
            },
        ],
    };
    const { msgs } = responsesToCore(body);
    assert.ok(msgs[0]?.text?.startsWith("see this"), "text preserved");
    assert.equal(msgs[0]?.imageMediaType, "image/png");
    assert.equal(msgs[0]?.imageBase64, IMG_DATA);
    assert.ok(msgs[0]?.rawResponsesItem, "rawResponsesItem sidecar stored");
    const rebuilt = coreToResponses(msgs);
    assert.equal(rebuilt.length, 1);
    const m = rebuilt[0] as { type: string; content: unknown };
    assert.equal(m.type, "message");
    assert.ok(Array.isArray(m.content), "message content rebuilt as array");
    const parts = m.content as unknown as { type: string; [k: string]: unknown }[];
    const img = parts.find((p) => p.type === "input_image");
    assert.ok(img, "input_image reconstructed");
    assert.equal(img?.image_url, DATA_URL, "image url restored");
});

// 7. Responses reasoning is routed into the compression pipeline (NOT the
// opaque preamble) so the kernel hides it once its turn is summarized. The raw
// item — including encrypted_content — round-trips verbatim via
// rawResponsesItem while the turn is still live.
test("responses: reasoning enters msgs[] as a tracked reasoning message (not preamble)", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "rs_abc", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "ENC_BLOB" },
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs, preamble } = responsesToCore(body);
    assert.equal(preamble.length, 0, "reasoning is NOT in the opaque preamble");
    const r = msgs.find((m) => m.contentType === "reasoning");
    assert.ok(r, "reasoning entered msgs[] as contentType reasoning");
    assert.ok(r?.rawResponsesItem, "raw reasoning item carried in rawResponsesItem");
    const rebuilt = coreToResponses(msgs);
    const out = rebuilt.find((i) => (i as { id?: string }).id === "rs_abc") as { type: string; encrypted_content?: string };
    assert.ok(out, "reasoning item rebuilt");
    assert.equal(out.type, "reasoning");
    assert.equal(out.encrypted_content, "ENC_BLOB", "encrypted_content preserved verbatim");
});

// 8. additional_tools (and other opaque host directives) still go to the
// preamble verbatim — only reasoning was promoted into compression.
test("responses: additional_tools stays in the opaque preamble", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "additional_tools", tools: [{ name: "exec" }] },
            { type: "reasoning", id: "rs_1" },
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs, preamble } = responsesToCore(body);
    assert.equal(preamble.length, 1, "only additional_tools is opaque");
    assert.equal(preamble[0]?.type, "additional_tools");
    assert.ok(msgs.find((m) => m.contentType === "reasoning"), "reasoning went to msgs[], not preamble");
});

// 9. ACP_REASONING_KEEP=none drops reasoning entirely (escape hatch).
test("responses: ACP_REASONING_KEEP=none drops all reasoning", () => {
    const prev = process.env.ACP_REASONING_KEEP;
    process.env.ACP_REASONING_KEEP = "none";
    try {
        const body: ResponsesRequestBody = {
            input: [
                { type: "reasoning", id: "rs_abc", encrypted_content: "ENC" },
                { type: "message", role: "user", content: "hi" },
            ],
        };
        const { msgs, preamble, droppedReasoning } = responsesToCore(body);
        assert.equal(preamble.length, 0);
        assert.ok(!msgs.find((m) => m.contentType === "reasoning"), "no reasoning in msgs[]");
        assert.equal(droppedReasoning, 1, "droppedReasoning counted");
    } finally {
        if (prev === undefined) delete process.env.ACP_REASONING_KEEP;
        else process.env.ACP_REASONING_KEEP = prev;
    }
});
