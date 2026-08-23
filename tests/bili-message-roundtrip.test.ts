import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "acp-kernel/wire";
import { openaiToCore, coreToOpenai } from "acp-kernel/wire";
import { responsesToCore, coreToResponses } from "acp-kernel/wire";
import type { AnthropicBlock, AnthropicRequestBody } from "acp-kernel/wire";
import type { OpenAIRequestBody } from "acp-kernel/wire";
import type { ResponsesRequestBody } from "acp-kernel/wire";

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

// 4. OpenAI developer role: leading prefixes are HOISTED out of the fold
// space (kernel 0.0.37 — system content is host runtime state and must not
// feed ids/fingerprints); a MID-conversation developer message still
// round-trips via the originalRole sidecar.
test("openai: leading developer prefix is hoisted, mid-conversation developer role is restored", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "developer", content: "you are a dev" },
            { role: "user", content: "hi" },
            { role: "developer", content: "mid-turn nudge" },
        ],
    };
    const { msgs, systemText } = openaiToCore(body);
    assert.equal(systemText, "you are a dev", "leading developer prefix is returned alongside the core stream");
    const mid = msgs.find((m) => m.role === "system");
    assert.equal(mid?.originalRole, "developer", "originalRole sidecar stored for the mid-conversation piece");
    const rebuilt = coreToOpenai(msgs);
    assert.equal(rebuilt.find((m) => m.role === "developer")?.content, "mid-turn nudge", "developer role reconstructed");
});

// 4b. A plain (mid-conversation) system role is NOT promoted to developer.
test("openai: system role stays system", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "system", content: "head sys" },
            { role: "user", content: "hi" },
            { role: "system", content: "mid sys" },
        ],
    };
    const { msgs, systemText } = openaiToCore(body);
    assert.equal(systemText, "head sys", "leading system hoisted");
    const mid = msgs.find((m) => m.role === "system");
    assert.equal(mid?.originalRole, "system");
    const rebuilt = coreToOpenai(msgs);
    assert.ok(rebuilt.some((m) => m.role === "system" && m.content === "mid sys"), "mid-conversation system reconstructed as system");
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

// 10. Reasoning VANISHES from the rebuilt input once its turn is covered by a
// compression block — the central guarantee of the fix (issue #15). The kernel
// drops covered message ids before coreToResponses runs; simulating that prune
// here, the reasoning item must disappear while ordinary messages survive.
test("responses: reasoning is dropped from output after its turn is compressed", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "rs_abc", encrypted_content: "ENC" },
            { type: "message", role: "user", content: "hi" },
            { type: "message", role: "assistant", content: "hello" },
        ],
    };
    const { msgs } = responsesToCore(body);
    const reasoningId = msgs.find((m) => m.contentType === "reasoning")!.id;
    const pruned = msgs.filter((m) => m.id !== reasoningId);
    const rebuilt = coreToResponses(pruned);
    const gone = rebuilt.find((i) => (i as { type?: string }).type === "reasoning");
    assert.equal(gone, undefined, "reasoning item disappears once its turn is compressed");
    assert.equal(rebuilt.length, 2, "user + assistant messages survive");
});

// 11. Reasoning id is stable across turns — Codex re-sends the same reasoning
// items every turn, so the same input item must yield the same BiliMessage id
// or the kernel would accumulate phantom duplicates.
test("responses: reasoning id is stable across turns (same item → same id)", () => {
    const body = (): ResponsesRequestBody => ({
        input: [
            { type: "reasoning", id: "rs_abc", summary: [{ type: "summary_text", text: "t" }] },
            { type: "message", role: "user", content: "hi" },
        ],
    });
    const a = responsesToCore(body()).msgs.find((m) => m.contentType === "reasoning")!.id;
    const b = responsesToCore(body()).msgs.find((m) => m.contentType === "reasoning")!.id;
    assert.equal(a, b, "same reasoning item yields the same message id across turns");
});

// 12. Multiple reasoning items in one turn each get distinct ids and survive
// round-trip in order.
test("responses: multiple reasoning items keep distinct ids and order", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "rs_1", encrypted_content: "A" },
            { type: "reasoning", id: "rs_2", encrypted_content: "B" },
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs } = responsesToCore(body);
    const rs = msgs.filter((m) => m.contentType === "reasoning");
    assert.equal(rs.length, 2);
    assert.notEqual(rs[0]!.id, rs[1]!.id, "distinct ids");
    const rebuilt = coreToResponses(msgs);
    const ids = rebuilt
        .filter((i) => (i as { type?: string }).type === "reasoning")
        .map((i) => (i as { id?: string }).id);
    assert.deepEqual(ids, ["rs_1", "rs_2"], "order + ids preserved on rebuild");
});

// 13. Reasoning without encrypted_content (older API shape) still round-trips
// via rawResponsesItem.
test("responses: reasoning without encrypted_content round-trips", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "rs_x", summary: [{ type: "summary_text", text: "t" }] },
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs } = responsesToCore(body);
    const rebuilt = coreToResponses(msgs);
    const out = rebuilt.find((i) => (i as { id?: string }).id === "rs_x") as
        | { type: string; encrypted_content?: string }
        | undefined;
    assert.ok(out, "reasoning without encrypted_content still rebuilt");
    assert.equal(out!.type, "reasoning");
    assert.equal(out!.encrypted_content, undefined);
});

// 14. Prior-response ACTION items (computer_call, mcp_call, ...) are routed
// through the compression pipeline (NOT the opaque preamble) so they don't
// accumulate unbounded every turn and break the prompt-cache prefix. They
// round-trip verbatim via rawResponsesItem while their turn is live.
test("responses: call items (computer_call/mcp_call) enter msgs[] not preamble", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "additional_tools", tools: [] } as ResponseInputItem,
            { type: "mcp_list_tools", server_label: "s" } as ResponseInputItem,
            { type: "computer_call", id: "cc_1", action: { type: "screenshot" } } as ResponseInputItem,
            { type: "mcp_call", id: "mc_1", name: "search", arguments: "{}" } as ResponseInputItem,
            { type: "message", role: "user", content: "go" },
        ],
    };
    const { msgs, preamble } = responsesToCore(body);
    assert.deepEqual(
        preamble.map((p) => p.type),
        ["additional_tools", "mcp_list_tools"],
        "only definitions stay in the preamble",
    );
    const calls = msgs.filter((m) => m.contentType === "reasoning" && m.rawResponsesItem);
    assert.equal(calls.length, 2, "both call items routed into msgs[]");
    const rebuilt = coreToResponses(msgs);
    const types = rebuilt.map((i) => i.type);
    assert.ok(types.includes("computer_call"), "computer_call round-trips verbatim");
    assert.ok(types.includes("mcp_call"), "mcp_call round-trips verbatim");
});

// 15. Call items are hidden once their turn is compressed (same prune
// semantics as reasoning).
test("responses: call items drop from output after their turn is compressed", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "computer_call", id: "cc_1", action: { type: "screenshot" } } as ResponseInputItem,
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs } = responsesToCore(body);
    const callMsg = msgs.find((m) => m.contentType === "reasoning" && (m.rawResponsesItem as { type?: string }).type === "computer_call");
    assert.ok(callMsg, "computer_call entered msgs[]");
    const pruned = msgs.filter((m) => m.id !== callMsg!.id);
    const rebuilt = coreToResponses(pruned);
    assert.equal(
        rebuilt.find((i) => i.type === "computer_call"),
        undefined,
        "computer_call disappears once its turn is compressed",
    );
});

// 16. A call item is given a distinct id namespace from reasoning, so the two
// never collide even when present in the same turn.
test("responses: call item and reasoning keep distinct ids in the same turn", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "shared", encrypted_content: "E" },
            { type: "mcp_call", id: "shared", name: "n", arguments: "{}" } as ResponseInputItem,
        ],
    };
    const { msgs } = responsesToCore(body);
    const ids = msgs.filter((m) => m.contentType === "reasoning").map((m) => m.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], "same raw id does not collide across kinds");
});

// 17. ACP_REASONING_KEEP=none drops chain-of-thought but MUST preserve call
// items: call items reuse the "reasoning" contentType only as a compression
// bucket, not because they are reasoning. Dropping a computer_call would
// corrupt the Responses conversation replay.
test("responses: ACP_REASONING_KEEP=none drops reasoning but keeps call items", () => {
    const prev = process.env.ACP_REASONING_KEEP;
    process.env.ACP_REASONING_KEEP = "none";
    try {
        const body: ResponsesRequestBody = {
            input: [
                { type: "reasoning", id: "rs_1", encrypted_content: "E" },
                { type: "computer_call", id: "cc_1", action: { type: "screenshot" } } as ResponseInputItem,
                { type: "mcp_call", id: "mc_1", name: "n", arguments: "{}" } as ResponseInputItem,
            ],
        };
        const { msgs } = responsesToCore(body);
        const reasoning = msgs.filter((m) => (m.rawResponsesItem as { type?: string }).type === "reasoning");
        const calls = msgs.filter((m) => (m.rawResponsesItem as { type?: string }).type !== "reasoning" && m.contentType === "reasoning");
        assert.equal(reasoning.length, 0, "chain-of-thought is dropped under ACP_REASONING_KEEP=none");
        assert.equal(calls.length, 2, "computer_call + mcp_call survive (replay-critical)");
    } finally {
        if (prev === undefined) delete process.env.ACP_REASONING_KEEP;
        else process.env.ACP_REASONING_KEEP = prev;
    }
});
