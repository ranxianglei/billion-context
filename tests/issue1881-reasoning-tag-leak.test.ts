// #1881: render-tag echoes leaking into client-visible output through channels
// the #206 stripping did not cover. Regression pins for each fix:
//   A. attribute-less ("bare") tag pairs — batch + streaming filter
//   B. per-adapter reasoning/thinking/thought/reasoning-summary deltas
//   C. openai dual-field frames and tool-frame replays carrying cleaned bytes
//   D. google all-proxy call chunks still delivering their sibling prose
//   E. openai dropped proxy-only frames still delivering their sibling prose
//   F. google finish-stub chunks never duplicating already-settled prose
// #1960 REVERSAL: the two SIGNED channels (anthropic thinking, google thought)
// are no longer filtered — thought text is signature-verified byte-for-byte
// on replay, so stripping desynchronizes text from signature and bricks the
// session. Their pins below now assert VERBATIM passthrough; the unsigned
// channels (openai reasoning_content, responses reasoning summaries) keep
// the #1881 strip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter, createAnthropicAdapter, createResponsesAdapter, createGoogleAdapter } from "../src/loop/index.ts";
import type { CompressLoopAdapter, ParsedStreamEvent } from "../src/loop/index.ts";
import { stripAcpTags, createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";

const TAG = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";
const BARE = "\x3cacp\x3em00001\x3c/acp\x3e";

const TAG_JSON = JSON.stringify(TAG).slice(1, -1); // TAG as it appears in JSON frame bytes

async function collect(adapter: CompressLoopAdapter, body: string): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(new Response(body, { status: 200 }).body!, 1)) events.push(ev);
    return events;
}

// Everything that reaches the client: raw payloads on structured events plus
// whole-frame chunks on meta events.
function clientBytes(events: ParsedStreamEvent[]): string {
    return events.map((e) => {
        const b = (e as { raw?: Buffer; chunk?: Buffer });
        return (b.raw ?? b.chunk)?.toString("utf8") ?? "";
    }).join("");
}

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// Anthropic frames carry an explicit event: line; the adapter keys its
// dispatch on it.
function sseEv(type: string, obj: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

test("#1881 stripAcpTags: a bare (attribute-less) tag pair is removed whole", () => {
    assert.equal(stripAcpTags(`${BARE}PASS`), "PASS");
});

test("#1881 streaming filter: a bare pair splits cleanly at EVERY split point", () => {
    const s = `${BARE}PASS`;
    for (let i = 0; i <= s.length; i++) {
        const f = createTagEchoFilter(() => {});
        const out = f.push(s.slice(0, i)) + f.push(s.slice(i)) + f.flush();
        assert.equal(out, "PASS", `split at ${i}: got ${JSON.stringify(out)}`);
    }
});

test("unified invariant: openai reasoning_content rides VERBATIM; same-frame content arrives once, cleaned", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events = await collect(
        adapter,
        sse({ choices: [{ index: 0, delta: { reasoning_content: TAG, content: `${TAG}kept` } }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
            "data: [DONE]\n\n",
    );
    const out = clientBytes(events);
    // Thinking channel: byte-verbatim (unified ACP invariant, #2229 direction).
    assert.ok(out.includes(TAG_JSON), `reasoning_content is the thinking channel and rides verbatim, got: ${out}`);
    // Visible text channel: still cleaned, exactly once.
    assert.equal((out.match(/kept/g) ?? []).length, 1, `content arrives once, got: ${out}`);
    assert.ok(out.includes(`\"content\":\"kept\"`), `content arrives cleaned of the tag, got: ${out}`);
});

test("unified invariant: a tool-frame replay carries reasoning VERBATIM, arguments verbatim", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const args = JSON.stringify({ path: "src/plugin.ts" });
    const events = await collect(
        adapter,
        sse({ choices: [{ index: 0, delta: { reasoning_content: TAG, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: args } }] } }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
            "data: [DONE]\n\n",
    );
    const out = clientBytes(events);
    assert.ok(out.includes(TAG_JSON), `reasoning bytes ride verbatim (thinking channel), got: ${out}`);
    assert.ok(out.includes('"name":"read"'), `the real call still reaches the client: ${out}`);
    // args is a STRING field of the frame: byte-exact means its JSON-escaped
    // form inside the frame equals JSON.stringify(args) (#1039).
    assert.ok(out.includes(JSON.stringify(args)), `arguments stay byte-exact (#1039): ${out}`);
});

test("#1960 anthropic: signed thinking_delta echo rides VERBATIM (filtering bricks the session)", async () => {
    const adapter = createAnthropicAdapter({ model: "test" });
    const events = await collect(
        adapter,
        sseEv("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1 } } }) +
            sseEv("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
            sseEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `${TAG}plan first` } }) +
            sseEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } }) +
            sseEv("content_block_stop", { type: "content_block_stop", index: 0 }) +
            sseEv("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) +
            sseEv("message_stop", { type: "message_stop" }),
    );
    const out = clientBytes(events);
    assert.ok(out.includes("\x3cacp"), `thinking is a SIGNED payload — the tag must ride verbatim or the signature breaks (#1960), got: ${out}`);
    assert.ok(out.includes("plan first"), `thinking prose survives: ${out}`);
});

test("unified invariant: responses reasoning_summary_text.delta rides VERBATIM", async () => {
    const adapter = createResponsesAdapter(false);
    const events = await collect(
        adapter,
        sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: `${TAG}think more` }) +
            sse({ type: "response.completed", response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
    );
    const out = clientBytes(events);
    // Thinking channel: byte-verbatim (unified ACP invariant).
    assert.ok(out.includes(TAG_JSON), `reasoning summary deltas ride verbatim, got: ${out}`);
    assert.ok(out.includes("think more"), `reasoning prose survives: ${out}`);
});

test("#1960 google: signed thought-part echo rides VERBATIM once (filtering bricks the session)", async () => {
    const adapter = createGoogleAdapter({ model: "gemini-3-pro-preview" }, undefined, "bili_absorb", "gemini-3-pro-preview");
    const events = await collect(
        adapter,
        sse({ candidates: [{ content: { role: "model", parts: [{ text: `${TAG}plan`, thought: true }] }, index: 0 }] }) +
            sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
    );
    const out = clientBytes(events);
    assert.ok(out.includes("\x3cacp"), `thought text carries thoughtSignature — the tag must ride verbatim (#1960), got: ${out}`);
    assert.equal((out.match(/plan/g) ?? []).length, 1, `thought prose arrives once, got: ${out}`);
});

test("#1881 google: an all-proxy call chunk still delivers its UNEDITED sibling text", async () => {
    const adapter = createGoogleAdapter({ model: "gemini-3-pro-preview" }, undefined, "bili_absorb", "gemini-3-pro-preview");
    const events = await collect(
        adapter,
        sse({ candidates: [{ content: { role: "model", parts: [{ text: "plain prose" }, { functionCall: { name: "bili_absorb", args: {} } }] }, index: 0 }] }) +
            sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
    );
    const out = clientBytes(events);
    assert.equal((out.match(/plain prose/g) ?? []).length, 1, `sibling text arrives once, got: ${out}`);
    assert.ok(!out.includes("bili_absorb"), `the proxy call must not ride along: ${out}`);
});

test("#1881 openai: an all-proxy tool frame still delivers its sibling content once", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events = await collect(
        adapter,
        sse({ choices: [{ index: 0, delta: { content: "sibling text", tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "bili_compress", arguments: "{}" } }] } }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
            "data: [DONE]\n\n",
    );
    const out = clientBytes(events);
    assert.equal((out.match(/sibling text/g) ?? []).length, 1, `withheld sibling prose arrives once, got: ${out}`);
    assert.ok(!out.includes("bili_compress"), `the proxy call must not ride along: ${out}`);
});
test("#1881 openai: a mixed round drops a proxy-only frame but keeps its sibling content", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events = await collect(
        adapter,
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_r", type: "function", function: { name: "read", arguments: "{}" } }] } }] }) +
            sse({ choices: [{ index: 0, delta: { content: "between the calls", tool_calls: [{ index: 1, id: "call_p", type: "function", function: { name: "bili_compress", arguments: "{}" } }] } }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
            "data: [DONE]\n\n",
    );
    const out = clientBytes(events);
    assert.equal((out.match(/between the calls/g) ?? []).length, 1, `dropped frame's prose arrives once, got: ${out}`);
    assert.ok(out.includes('"name":"read"'), `the real call still reaches the client: ${out}`);
    assert.ok(!out.includes("bili_compress"), `the proxy call must not ride along: ${out}`);
});

test("#1881 google: a terminal chunk carrying a REAL call sends its sibling prose exactly once", async () => {
    const adapter = createGoogleAdapter({ model: "gemini-3-pro-preview" }, undefined, "bili_absorb", "gemini-3-pro-preview");
    const events = await collect(
        adapter,
        sse({ candidates: [{ content: { role: "model", parts: [{ text: "Done reading." }, { functionCall: { name: "read_file", args: { path: "x" } } }] }, index: 0, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
    );
    const out = clientBytes(events);
    assert.equal((out.match(/Done reading\./g) ?? []).length, 1, `prose must not be duplicated by the finish stub, got: ${out}`);
});
test("#1881 google: a proxy-only finish chunk sends its sibling prose exactly once", async () => {
    const adapter = createGoogleAdapter({ model: "gemini-3-pro-preview" }, undefined, "bili_absorb", "gemini-3-pro-preview");
    const events = await collect(
        adapter,
        sse({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_file", args: {} } }] }, index: 0 }] }) +
            sse({ candidates: [{ content: { role: "model", parts: [{ text: "Bye now." }, { functionCall: { name: "bili_absorb", args: {} } }] }, index: 0, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
    );
    const out = clientBytes(events);
    assert.equal((out.match(/Bye now\./g) ?? []).length, 1, `settle delivery plus finish stub must total one copy, got: ${out}`);
});
