// Unified ACP remediation invariants (owner directive, #2229/#2248 family).
//
// Four hard rules govern every text-rewriting surface (loop adapters, plugin
// passthrough, JSON strip functions, exit audits):
//   I1. The thinking channel is byte-verbatim: anthropic thinking, google
//       thought, openai reasoning_content/reasoning, responses reasoning
//       summaries. Never stripped, never rewritten (echo-shaped reasoning
//       rides as-is; signature/replay validation would break otherwise).
//   I2. Model PROSE output is manageable: render-tag echoes, marker lines,
//       bili-internal text and (when absorb-instructed) whole emissions are
//       stripped from the visible text channel.
//   I3. Model output bound for files (tool arguments) is byte-identical —
//       (#1039) tool_calls arguments never enter any filter.
//   I4. User-sent bytes are never rewritten: a verbatim echo of the user's
//       own fragment survives even when stripping is armed (#463 exemption).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter, createResponsesAdapter } from "../src/loop/index.ts";
import type { CompressLoopAdapter, ParsedStreamEvent } from "../src/loop/index.ts";
import { stripOpenaiChatText, stripResponsesText } from "../src/loop/tag-echo-filter.ts";

const TAG = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";
const TAG_JSON = JSON.stringify(TAG).slice(1, -1); // TAG as it appears in JSON frame bytes
const EMISSION = "\x3cacp_tool_call name=\"write\"\x3e\x3cparameter=ref\x3em00999\x3c/parameter\x3e\x3c/acp_tool_call\x3e";

// ── helpers ────────────────────────────────────────────────────────────────
async function collect(adapter: CompressLoopAdapter, body: string): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(new Response(body, { status: 200 }).body!, 1)) events.push(ev);
    return events;
}
function clientBytes(events: ParsedStreamEvent[]): string {
    return events.map((e) => {
        const b = (e as { raw?: Buffer; chunk?: Buffer });
        return (b.raw ?? b.chunk)?.toString("utf8") ?? "";
    }).join("");
}
function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// ── I1: thinking channel is byte-verbatim ─────────────────────────────────
test("I1 adapter lane: openai reasoning_content echo rides VERBATIM while content is cleaned", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const out = clientBytes(await collect(
        adapter,
        sse({ choices: [{ index: 0, delta: { reasoning_content: TAG, content: `${TAG}kept` } }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
            "data: [DONE]\n\n",
    ));
    assert.ok(out.includes(TAG_JSON), `thinking channel verbatim, got: ${out}`);
    assert.ok(out.includes('"content":"kept"'), `visible text channel still cleaned, got: ${out}`);
});

test("I1 adapter lane: responses reasoning_summary delta AND done-event ride VERBATIM", async () => {
    const adapter = createResponsesAdapter(false);
    const out = clientBytes(await collect(
        adapter,
        sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: `${TAG}think` }) +
            sse({ type: "response.reasoning_summary_part.done", item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: `${TAG} done` } }) +
            sse({ type: "response.completed", response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
    ));
    const tagCount = out.split(TAG_JSON).length - 1;
    assert.equal(tagCount, 2, `both reasoning summary frames carry the tag verbatim, got: ${out}`);
});

test("I1 strip functions (defense in depth): reasoning fields survive the strip pass", () => {
    const body = { choices: [{ delta: { content: `${TAG}kept`, reasoning_content: `${TAG}think`, reasoning: `${TAG}plan` } }] };
    const out = stripOpenaiChatText(body);
    const d = out.choices[0].delta!;
    assert.equal(d.content, "kept", "prose channel still stripped");
    assert.equal(d.reasoning_content, `${TAG}think`, "reasoning_content verbatim");
    assert.equal(d.reasoning, `${TAG}plan`, "reasoning verbatim");
});

test("I1 strip functions: responses reasoning summary survives armed strip", () => {
    const body = { output: [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: EMISSION }] }] };
    const armed = stripResponsesText(body, true);
    const rs = (armed.output as Array<{ summary: Array<{ text: string }> }>)[0];
    assert.equal(rs.summary[0].text, EMISSION, "reasoning summary verbatim");
});

// ── I2: model prose remains manageable ─────────────────────────────────────
test("I2 adapter lane: render-tag echo is still stripped from the content channel", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const out = clientBytes(await collect(
        adapter,
        sse({ choices: [{ index: 0, delta: { content: `${TAG}kept` } }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
            "data: [DONE]\n\n",
    ));
    assert.ok(!out.includes('"content":"<acp'), `no tag reaches the content channel, got: ${out}`);
    assert.ok(out.includes("kept"), `prose survives the strip, got: ${out}`);
});

// ── I3: tool arguments byte-identical ──────────────────────────────────────
test("I3 adapter lane: tool_calls arguments carry echo-shaped bytes byte-identically", async () => {
    const args = JSON.stringify({ content: `write ${TAG} and ${EMISSION} to disk` });
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const out = clientBytes(await collect(
        adapter,
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: args } }] } }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
            "data: [DONE]\n\n",
    ));
    assert.ok(out.includes(JSON.stringify(args)), `file-bound arguments byte-identical (#1039): ${out}`);
});

test("I3 strip functions: tool_calls never rewritten even when armed", () => {
    const args = JSON.stringify({ content: `${TAG}${EMISSION}` });
    const body = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "write", arguments: args } }] } }] };
    const armed = stripOpenaiChatText(body, true);
    const got = armed.choices[0].delta!.tool_calls![0].function.arguments;
    assert.equal(got, args, "arguments untouched");
});

// ── I4: user-sent bytes never rewritten ────────────────────────────────────
test("I4 strip functions: the #463 user-echo exemption keys on request text, not shape", () => {
    const reqBody = { messages: [{ role: "user", content: `Output exactly:\n${EMISSION}` }] };
    const armed = stripOpenaiChatText({ choices: [{ delta: { content: EMISSION } }] }, true, JSON.stringify(reqBody.messages[0].content));
    assert.equal(armed.choices[0].delta!.content, EMISSION, "verbatim echo of the user's own bytes survives armed strip");
});
