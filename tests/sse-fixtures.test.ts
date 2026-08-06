import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rewriteOpenaiSseStream } from "../src/stream-openai.ts";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";

function makeCtx() {
    const core = createCore();
    const config = defaultConfig(200000);
    const state = createInitialState();
    return { core, config, state, ctx: { core, config, messages: [], session: { id: "t", state }, log: () => {} } as never };
}

function parseToolCalls(sse: string) {
    const frags: Record<number, string> = {};
    const names: Record<number, string> = {};
    let finish: string | null = null;
    let done = false;
    let content = "";
    let reasoning = "";
    for (const evt of sse.split("\n\n")) {
        const dl = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!dl) continue;
        const data = dl.slice(5).trim();
        if (data === "[DONE]") { done = true; continue; }
        try {
            const obj = JSON.parse(data);
            const ch = obj.choices?.[0];
            if (ch?.finish_reason) finish = ch.finish_reason;
            const tcs = ch?.delta?.tool_calls;
            if (Array.isArray(tcs)) for (const tc of tcs) {
                const i = tc.index ?? 0;
                if (tc.function?.name) names[i] = tc.function.name;
                if (tc.function?.arguments) frags[i] = (frags[i] ?? "") + tc.function.arguments;
            }
            if (ch?.delta?.content) content += ch.delta.content;
            if (ch?.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
        } catch {}
    }
    return { frags, names, finish, done, content, reasoning };
}

async function rewrite(sse: string, ctx: never) {
    const upstream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
    const out: string[] = [];
    for await (const buf of rewriteOpenaiSseStream(upstream, ctx)) out.push(buf.toString("utf8"));
    return out.join("");
}

const FIXTURE_DIR = new URL("../tests/fixtures/", import.meta.url);

function fixture(name: string): string {
    return readFileSync(new URL(name, FIXTURE_DIR), "utf8");
}

test("fixture: real GLM bash tool call passes through with intact arguments", async () => {
    const { ctx } = makeCtx();
    const raw = fixture("glm-bash-toolcall.sse");
    const out = await rewrite(raw, ctx);
    const parsed = parseToolCalls(out);
    assert.equal(parsed.names[0], "bash");
    assert.equal(parsed.finish, "tool_calls");
    assert.equal(parsed.done, true);
    const args = JSON.parse(parsed.frags[0]);
    assert.equal(args.command, "echo capture-test");
    assert.ok(args.description, "description key preserved");
});

test("fixture: real GLM plain text response passes through verbatim", async () => {
    const { ctx } = makeCtx();
    const raw = fixture("glm-text-response.sse");
    const out = await rewrite(raw, ctx);
    const parsed = parseToolCalls(out);
    assert.equal(parsed.finish, "stop");
    assert.equal(parsed.done, true);
    assert.equal(parsed.content, "Done.");
});

test("fixture: real GLM reasoning_content (title gen) passes through unmodified", async () => {
    const { ctx } = makeCtx();
    const raw = fixture("glm-titlegen-reasoning.sse");
    const out = await rewrite(raw, ctx);
    const parsed = parseToolCalls(out);
    assert.ok(parsed.reasoning.length > 0, "reasoning_content must survive");
    assert.ok(parsed.content.length > 0, "content must survive");
    assert.equal(parsed.done, true);
    assert.ok(!out.includes("acp-proxy:"), "no compress note in pure text stream");
});

test("synthetic: tool call arguments fragmented across many chunks stay intact", async () => {
    const { ctx } = makeCtx();
    const frags = ['{"comm', 'and":"echo', ' frag-test",', '"description"', ':"run it"}'];
    const chunks = [
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: frags[0] } }] }, finish_reason: null }] })}\n\n`,
        ...frags.slice(1).map((f) => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: f } }] }, finish_reason: null }] })}\n\n`),
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const out = await rewrite(chunks, ctx);
    const parsed = parseToolCalls(out);
    assert.equal(parsed.names[0], "bash");
    assert.equal(parsed.finish, "tool_calls");
    assert.equal(parsed.done, true);
    const args = JSON.parse(parsed.frags[0]);
    assert.equal(args.command, "echo frag-test");
    assert.equal(args.description, "run it");
});

test("synthetic: last arguments fragment co-located with finish_reason stays intact", async () => {
    const { ctx } = makeCtx();
    const chunks = [
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: '{"filePa' } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/a/b.ts"}' } }] }, finish_reason: "tool_calls" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const out = await rewrite(chunks, ctx);
    const parsed = parseToolCalls(out);
    assert.equal(parsed.names[0], "read");
    const args = JSON.parse(parsed.frags[0]);
    assert.equal(args.filePath, "/a/b.ts");
    assert.equal(parsed.finish, "tool_calls");
});

test("synthetic: multiple parallel tool calls all pass through", async () => {
    const { ctx } = makeCtx();
    const chunks = [
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "bash", arguments: '{"command":"echo a"}' } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "c1", type: "function", function: { name: "read", arguments: '{"filePath":"/x"}' } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const out = await rewrite(chunks, ctx);
    const parsed = parseToolCalls(out);
    assert.equal(Object.keys(parsed.names).length, 2);
    assert.equal(parsed.names[0], "bash");
    assert.equal(parsed.names[1], "read");
    assert.equal(JSON.parse(parsed.frags[0]).command, "echo a");
    assert.equal(JSON.parse(parsed.frags[1]).filePath, "/x");
});

test("synthetic: usage object in finish chunk survives passthrough", async () => {
    const { ctx } = makeCtx();
    const usage = { prompt_tokens: 5330, completion_tokens: 23, total_tokens: 5353 };
    const chunks = [
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "" }, finish_reason: "tool_calls" }], usage })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const out = await rewrite(chunks, ctx);
    assert.ok(out.includes('"prompt_tokens":5330'), "usage object must survive");
    assert.ok(out.includes('"completion_tokens":23'), "completion_tokens must survive");
});
