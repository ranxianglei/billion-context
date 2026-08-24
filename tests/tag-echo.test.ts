import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter, createAnthropicAdapter, createResponsesAdapter } from "../src/loop/index.ts";
import { stripAcpTags, createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

const TAG = (ref: string, tokens = 177) => `\x3cacp tokens="${tokens}" type="text">${ref}\x3c/acp>`;
const LT = "\x3c";
const OPEN = `${LT}acp `;
const CLOSE = `${LT}/acp>`;

function makeCtx(id: string): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    proxyUrl?: string;
    textProtocol?: boolean;
} {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [],
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
    };
}

function sseFromStrings(parts: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= parts.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(parts[i++]));
        },
    });
}

async function drain(stream: ReadableStream<Uint8Array>, adapter: Parameters<typeof runCompressLoop>[4], textProtocol = false): Promise<string> {
    const ctx = makeCtx("tag-echo-test");
    if (textProtocol) ctx.textProtocol = true;
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, {}, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt())) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

test("stripAcpTags removes paired render tags with their ref", () => {
    assert.equal(stripAcpTags(`before ${TAG("m00155")} after`), "before  after");
});

test("stripAcpTags removes lone open/close tags", () => {
    assert.equal(stripAcpTags(`a ${OPEN}tokens="1"> tail`), "a  tail");
    assert.equal(stripAcpTags(`x ${CLOSE} y`), "x  y");
});

test("stripAcpTags leaves underscore trigger tags intact", () => {
    const s = `${LT}acp_compress${LT}/acp_compress${OPEN}x="">ref${CLOSE}`;
    assert.equal(stripAcpTags(s), `${LT}acp_compress${LT}/acp_compress`);
});

test("stripAcpTags leaves ordinary angle brackets alone", () => {
    assert.equal(stripAcpTags("a < b and </abcd> and <acpx>"), "a < b and </abcd> and <acpx>");
});

test("stripAcpTags: long paired content keeps content, strips tags", () => {
    const long = "x".repeat(80);
    assert.equal(stripAcpTags(`${OPEN}t="1">${long}${CLOSE}`), long);
});

test("streaming filter matches stripAcpTags for every split position", () => {
    const cases = [
        `answer ${TAG("m00155")}${TAG("m00155", 44)} done`,
        TAG("m00155").repeat(21),
        `edge ${OPEN}tok`,
        `half ${CLOSE} tail`,
        `trigger ${LT}acp_compress${LT}/acp_compress end`,
        `plain < <a </a <ac text`,
        `${TAG("m1")}${TAG("m2")}`,
    ];
    for (const full of cases) {
        const expected = stripAcpTags(full);
        for (let split = 0; split <= full.length; split++) {
            const f = createTagEchoFilter();
            const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
            assert.equal(out, expected, `split=${split} full=${JSON.stringify(full)}`);
        }
        for (let seed = 1; seed < 8; seed++) {
            const f = createTagEchoFilter();
            let out = "";
            let rest = full;
            while (rest.length > 0) {
                const take = (seed * 7 + rest.length) % (rest.length) + 1;
                out += f.push(rest.slice(0, take));
                rest = rest.slice(take);
            }
            out += f.flush();
            assert.equal(out, expected, `seed=${seed} full=${JSON.stringify(full)}`);
        }
    }
});

test("streaming filter: unterminated open tag at flush is dropped", () => {
    const f = createTagEchoFilter();
    const out = f.push(`text ${OPEN}tokens="9"`);
    assert.equal(out, "text ");
    assert.equal(f.flush(), "");
});

test("anthropic adapter strips echoed tags across split deltas", async () => {
    const full = `好的 ${TAG("m00155")}${TAG("m00156", 33)}结论`;
    const splitAt = [6, 19, 25, 40, 47];
    const parts: string[] = [];
    let prev = 0;
    for (const s of splitAt) {
        parts.push(full.slice(prev, s));
        prev = s;
    }
    parts.push(full.slice(prev));
    const sseParts: string[] = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 100 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        ...parts.map((p) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })}\n\n`),
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const out = await drain(sseFromStrings(sseParts), createAnthropicAdapter({ model: "test" }));
    assert.equal(out.includes(OPEN), false);
    assert.equal(out.includes(CLOSE), false);
    const texts = [...out.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    assert.equal(texts.join(""), "好的 结论");
    const stopIdx = out.indexOf("content_block_stop");
    const lastDeltaIdx = out.lastIndexOf("content_block_delta");
    assert.ok(lastDeltaIdx < stopIdx, "flushed tail must precede block stop");
});

test("openai adapter strips echoed tags", async () => {
    const sseParts: string[] = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: `repeat ${TAG("m00155")}` }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: `${TAG("m00155", 44)}end` }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ];
    const out = await drain(sseFromStrings(sseParts), createOpenaiAdapter({ model: "gpt" }));
    assert.equal(out.includes(OPEN), false);
    assert.equal(out.includes(CLOSE), false);
    const contents = [...out.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    assert.equal(contents.join(""), "repeat end");
});

test("openai adapter: tag split across deltas is fully stripped", async () => {
    const sseParts: string[] = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: `${OPEN}tokens="2"` }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: ` type="text">m00001${CLOSE}ok` }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ];
    const out = await drain(sseFromStrings(sseParts), createOpenaiAdapter({ model: "gpt" }));
    assert.equal(out.includes(OPEN), false);
    assert.equal(out.includes(CLOSE), false);
});

test("responses adapter strips echoed tags from deltas and full-text events", async () => {
    const echoed = `repeat ${TAG("m00155")}${TAG("m00156", 33)}done`;
    const sseParts: string[] = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `repeat ${TAG("m00155")}` })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `${TAG("m00156", 33)}done` })}\n\n`,
        `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: echoed })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: echoed }] } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: echoed }] }], usage: { input_tokens: 10, output_tokens: 3 } } })}\n\n`,
    ];
    const out = await drain(sseFromStrings(sseParts), createResponsesAdapter());
    assert.equal(out.includes(OPEN), false);
    assert.equal(out.includes(CLOSE), false);
});
