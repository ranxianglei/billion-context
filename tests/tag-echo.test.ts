import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter, createAnthropicAdapter, createResponsesAdapter } from "../src/loop/index.ts";
import { stripAcpTags, createTagEchoFilter, containsRenderTagText, containsToolCallXmlFragment, mayStartRenderTag } from "../src/loop/tag-echo-filter.ts";
import { rewriteJsonResponse } from "../src/stream.ts";
import { rewriteOpenaiJsonResponse } from "../src/stream-openai.ts";
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
        `first ${TAG("m1")} mid prose ${TAG("m2")} last`,
        `好的 ${TAG("m00155")}${TAG("m00155", 44)}${TAG("m00156", 33)} 另外 5 < 6 成立${TAG("m00157")}完毕`,
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

test("streaming filter keeps prose between tags across chunk boundaries", () => {
    const parts = [`good ${TAG("m00155")}`, `${TAG("m00155", 44)}${TAG("m00156", 33)}`, `mid 5 < 6 tail${TAG("m00157")}END`];
    const f = createTagEchoFilter();
    let out = "";
    for (const p of parts) out += f.push(p);
    out += f.flush();
    assert.equal(out, stripAcpTags(parts.join("")));
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

test("tag-free anthropic deltas pass through byte-identical (no re-serialization drift)", async () => {
    const evt = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "plain 5 < 6 text" } };
    const line = `event: content_block_delta\ndata: ${JSON.stringify(evt)}\n\n`;
    const sseParts: string[] = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 100 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        line,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const out = await drain(sseFromStrings(sseParts), createAnthropicAdapter({ model: "test" }));
    assert.ok(out.includes(`data: ${JSON.stringify(evt)}\n\n`), "raw delta must be the canonical remapIndexInEvent serialization");
});

test("tag-free openai chunks pass through with original raw bytes", async () => {
    const chunk = { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "hello plain text" }, finish_reason: null }] };
    const raw = `data: ${JSON.stringify(chunk)}\n\n`;
    const sseParts: string[] = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        raw,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ];
    const out = await drain(sseFromStrings(sseParts), createOpenaiAdapter({ model: "gpt" }));
    assert.ok(out.includes(raw), "tag-free chunk must pass through as the original rawBuf");
});

test("tag-free responses deltas and done events pass through with original raw bytes", async () => {
    const deltaEvt = { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "plain delta text" };
    const doneEvt = { type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: "plain delta text" };
    const deltaRaw = `event: response.output_text.delta\ndata: ${JSON.stringify(deltaEvt)}\n\n`;
    const doneRaw = `event: response.output_text.done\ndata: ${JSON.stringify(doneEvt)}\n\n`;
    const sseParts: string[] = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } })}\n\n`,
        deltaRaw,
        doneRaw,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "plain delta text" }] } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "plain delta text" }] }], usage: { input_tokens: 10, output_tokens: 3 } } })}\n\n`,
    ];
    const out = await drain(sseFromStrings(sseParts), createResponsesAdapter());
    assert.ok(out.includes(deltaRaw), "tag-free delta must pass through as original rawBuf");
    assert.ok(out.includes(doneRaw), "tag-free done event must pass through as original rawBuf");
});

test("containsRenderTagText detects literal and JSON-escaped render tags", () => {
    const esc = JSON.stringify("x \x3cacp tokens=\"1\" type=\"text\"\x3em00155\x3c/acp\x3e y").slice(1, -1);
    assert.ok(containsRenderTagText(`a ${TAG("m1")} b`));
    assert.ok(containsRenderTagText(`a ${OPEN}x="">b`));
    assert.ok(containsRenderTagText(`a ${CLOSE} b`));
    assert.ok(containsRenderTagText(`escaped ${esc}`));
    assert.ok(containsRenderTagText(`escaped open only \\u003cacp tokens="1"\\u003e ref \\u003c/acp\\u003e`));
    assert.equal(containsRenderTagText("plain text with < b and </br> tags"), false);
    assert.equal(containsRenderTagText(`trigger ${LT}acp_compress${LT}/acp_compress`), false);
});

test("non-stream anthropic rewriteJsonResponse strips echoed tags", async () => {
    const body = {
        id: "msg_1",
        content: [
            { type: "text", text: `answer ${TAG("m00155")} done` },
            { type: "text", text: `second ${TAG("m00156", 44)}` },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
    };
    const c = makeCtx("ns-anthropic");
    const rewritten = rewriteJsonResponse(structuredClone(body), { core: c.core, config: c.config, messages: c.messages, session: c.session, log: () => {} });
    const parsed = rewritten as { content: Array<{ text: string }> };
    assert.equal(parsed.content[0].text, "answer  done");
    assert.equal(parsed.content[1].text, "second ");
});

test("non-stream openai rewriteOpenaiJsonResponse strips echoed tags", () => {
    const body = {
        id: "chatcmpl-1",
        choices: [{ index: 0, message: { role: "assistant", content: `answer ${TAG("m00155")} done` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const rewritten = rewriteOpenaiJsonResponse(structuredClone(body), { core: createCore(), config: { modelContextLimit: 200000 } as Config, messages: [], session: makeCtx("ns-openai").session, log: () => {} });
    const parsed = rewritten as { choices: Array<{ message: { content: string } }> };
    assert.equal(parsed.choices[0].message.content, "answer  done");
});

test("non-stream rewriters leave tag-free text untouched", async () => {
    const anthropicBody = { id: "m", content: [{ type: "text", text: "clean 5 < 6 text" }], usage: { input_tokens: 1, output_tokens: 1 } };
    const cc = makeCtx("ns-clean");
    const rewritten = rewriteJsonResponse(structuredClone(anthropicBody), { core: cc.core, config: cc.config, messages: cc.messages, session: cc.session, log: () => {} });
    assert.equal((rewritten as { content: Array<{ text: string }> }).content[0].text, "clean 5 < 6 text");
    const openaiBody = { id: "c", choices: [{ index: 0, message: { role: "assistant", content: "clean 5 < 6 text" }, finish_reason: "stop" }] };
    const rewrittenOpenai = rewriteOpenaiJsonResponse(structuredClone(openaiBody), { core: createCore(), config: { modelContextLimit: 200000 } as Config, messages: [], session: makeCtx("ns-openai-clean").session, log: () => {} });
    assert.equal((rewrittenOpenai as { choices: Array<{ message: { content: string } }> }).choices[0].message.content, "clean 5 < 6 text");
});

test("streaming filter holds a definite open tail beyond the small hold cap instead of leaking it", () => {
    const f = createTagEchoFilter();
    const attrs = "x".repeat(200);
    assert.equal(f.push(`text ${OPEN}${attrs}`), "text ");
    assert.ok(f.pending());
    assert.equal(f.push(`>m00001${CLOSE}`), "");
    assert.equal(f.flush(), "");
});

test("streaming filter drops a definite open tail beyond the tag-open cap instead of passing it through", () => {
    let dropped = "";
    const f = createTagEchoFilter((s) => { dropped = s; });
    assert.equal(f.push(`text ${OPEN}` + "x".repeat(5000)), "text ");
    assert.equal(dropped.length, 5005);
    assert.equal(f.push(`>m00001${CLOSE}`), ">m00001");
    assert.equal(f.flush(), "");
    assert.ok(f.dropped());
});

test("stripAcpTags drops arbitrary truncated open fragments, keeps ambiguous prefixes", () => {
    assert.equal(stripAcpTags(`text ${OPEN}type="text" tokens=`), "text ");
    assert.equal(stripAcpTags(`text ${OPEN}tok`), "text ");
    assert.equal(stripAcpTags(`text ${LT}acp`), `text ${LT}acp`);
    assert.equal(stripAcpTags(`text ${LT}/ac`), `text ${LT}/ac`);
});

test("stripAcpTags drops truncated close fragments (close side of #361)", () => {
    assert.equal(stripAcpTags(`text ${LT}/acp`), "text ");
    assert.equal(stripAcpTags(`text ${LT}/acp x="y"`), "text ");
    assert.equal(stripAcpTags(`text ${CLOSE}`), "text ");
});

test("streaming flush drops arbitrary truncated open fragments", () => {
    const f = createTagEchoFilter();
    assert.equal(f.push(`text ${OPEN}type="text" tokens=`), "text ");
    assert.equal(f.flush(), "");
    const g = createTagEchoFilter();
    assert.equal(g.push(`text ${LT}acp`), "text ");
    assert.equal(g.flush(), `${LT}acp`);
});

test("streaming filter drops truncated close fragments (close side of #361)", () => {
    const f = createTagEchoFilter();
    assert.equal(f.push(`text ${LT}/acp`) + f.flush(), "text ");
    const g = createTagEchoFilter();
    assert.equal(g.push(`text ${LT}/acp `), "text ");
    assert.ok(g.pending());
    assert.equal(g.push(`x="y">`) + g.flush(), "");
    const h = createTagEchoFilter();
    assert.equal(h.push(`text ${LT}/acp `) + h.push(`>`) + h.flush(), "text ");
});

test("streaming flush drops content of a tag left unclosed at end of stream", () => {
    const f = createTagEchoFilter();
    assert.equal(f.push(`text ${OPEN}tokens="1" type="text">m00001`), "text ");
    assert.equal(f.flush(), "");
    assert.ok(f.dropped());
});

test("long tag-like spans are prose, not tags (bounded open match)", () => {
    const span = `${OPEN}${"x".repeat(300)}>`;
    assert.equal(stripAcpTags(`before ${span} after`), `before ${span} after`);
    const f = createTagEchoFilter();
    assert.equal(f.push(`before ${span} after`) + f.flush(), `before ${span} after`);
    const g = createTagEchoFilter();
    assert.equal(g.push(`before ${OPEN}${"x".repeat(300)}`), "before ");
    assert.ok(g.pending());
    assert.equal(g.push(`> after`), `${span} after`);
    assert.equal(g.flush(), "");
});

test("prose with a tag-like opening beyond the attr bound survives intact", () => {
    const prose = `${OPEN}${"word ".repeat(60)}end > kept`;
    assert.equal(stripAcpTags(prose), prose);
    const f = createTagEchoFilter();
    assert.equal(f.push(prose) + f.flush(), prose);
});

test("containsToolCallXmlFragment detects tool-call XML fragments, not prose", () => {
    assert.equal(containsToolCallXmlFragment(`done ${LT}/invoke>`), true);
    assert.equal(containsToolCallXmlFragment(`x ${LT}/tool_calls> y`), true);
    assert.equal(containsToolCallXmlFragment(`x ${LT}/parameter> y`), true);
    assert.equal(containsToolCallXmlFragment(`x ${LT}antml:invoke name="t"> y`), true);
    assert.equal(containsToolCallXmlFragment(`x ${LT}/antml:invoke> y`), true);
    assert.equal(containsToolCallXmlFragment("escaped \\u003c/invoke\\u003e"), true);
    assert.equal(containsToolCallXmlFragment(`plain text with ${LT} b and invoke() calls`), false);
    assert.equal(containsToolCallXmlFragment(`the ${LT}/abcd> tag`), false);
});

test("tag-echo filter does not strip tool-call XML fragments (warn-only, #361)", () => {
    const f = createTagEchoFilter();
    const out = f.push(`done ${LT}/invoke> ${LT}/tool_calls>`) + f.flush();
    assert.equal(out, `done ${LT}/invoke> ${LT}/tool_calls>`);
});

test("mayStartRenderTag engages on complete tags and tag-head tails, not prose", () => {
    assert.equal(mayStartRenderTag(TAG("m0042")), true);
    assert.equal(mayStartRenderTag(`prose ${OPEN}tokens="1"`), true);
    assert.equal(mayStartRenderTag("ok \x3c"), true);
    assert.equal(mayStartRenderTag("ok \x3c/"), true);
    assert.equal(mayStartRenderTag("ok \x3ca"), true);
    assert.equal(mayStartRenderTag("ok \x3cac"), true);
    assert.equal(mayStartRenderTag(`x ${LT}/ac`), true);
    assert.equal(mayStartRenderTag(""), false);
    assert.equal(mayStartRenderTag("plain text"), false);
    assert.equal(mayStartRenderTag("a < b"), false);
    assert.equal(mayStartRenderTag("x\x3caction y"), false);
    assert.equal(mayStartRenderTag("\x3cdiv>"), false);
});
