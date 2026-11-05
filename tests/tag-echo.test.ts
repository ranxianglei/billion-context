import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter, createAnthropicAdapter, createResponsesAdapter } from "../src/loop/index.ts";
import { stripAcpTags, createTagEchoFilter, containsRenderTagText, containsToolCallXmlFragment, mayStartRenderTag, isOrphanMarkupText } from "../src/loop/tag-echo-filter.ts";
import { rewriteJsonResponse } from "../src/stream.ts";
import { rewriteOpenaiJsonResponse } from "../src/stream-openai.ts";
import { rewriteResponsesJsonResponse } from "../src/stream-responses.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { setLogCapture } from "../src/logger.ts";
import { degenerateTurnWarning, isMaxOutputReason } from "../src/degenerate-turn.ts";

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
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0,             rangeRestores: 0 },
            pendingRetrievals: [],
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

test("stripAcpTags keeps prose between paired tags and strips only the tags (#1720)", () => {
    const Z = "Z".repeat(30);
    assert.equal(stripAcpTags(`${OPEN}tokens="1" type="text">${Z}${CLOSE}`), Z);
    assert.equal(stripAcpTags(`${OPEN}tokens="1" type="text">\n正文段落\n${CLOSE}`), "\n正文段落\n");
    assert.equal(stripAcpTags(`${OPEN}tokens="1" type="text">这是什么东西${CLOSE}`), "这是什么东西");
});

test("stripAcpTags still strips whitespace-padded ref echoes (#1720)", () => {
    assert.equal(stripAcpTags(`before ${OPEN}tokens="1" type="text"> m00123 ${CLOSE} after`), "before  after");
});

test("stripAcpTags removes lone open/close tags", () => {
    assert.equal(stripAcpTags(`a ${OPEN}tokens="1"> tail`), "a  tail");
    assert.equal(stripAcpTags(`x ${CLOSE} y`), "x  y");
});

test("stripAcpTags leaves underscore trigger tags intact", () => {
    const s = `${LT}acp_compress${LT}/acp_compress${OPEN}x="">m00123${CLOSE}`;
    assert.equal(stripAcpTags(s), `${LT}acp_compress${LT}/acp_compress`);
});

test("stripAcpTags leaves ordinary angle brackets alone", () => {
    assert.equal(stripAcpTags("a < b and </abcd> and <acpx>"), "a < b and </abcd> and <acpx>");
});

test("stripAcpTags: long paired content keeps content, strips tags", () => {
    const long = "x".repeat(80);
    assert.equal(stripAcpTags(`${OPEN}t="1">${long}${CLOSE}`), long);
});

// #644: a malformed render-tag close (the echoed `</acp` is missing its closing
// `>`) used to make the close-side tail regexes (TRUNC_CLOSE, PARTIAL_TAIL)
// swallow the ENTIRE following real content — they were unbounded, so `</acp`
// + 300 chars of prose was held/dropped and only the bare ref survived. Bounding
// the close-side tail to {0,32} (aligned with LONE_CLOSE) releases an over-long
// tail as content instead of holding/dropping it.
test("stripAcpTags: malformed close (missing >) does not eat following content (#644)", () => {
    const content = "这是真实的正文内容，不应被过滤器吃掉。".repeat(12);
    const malformed = `${LT}acp tokens="245" type="text">m01998${LT}/acp` + content;
    const out = stripAcpTags(malformed);
    // #2862 behavior change (was: ref+close survived as visible residue):
    // the attested echo makes the ref glued to the unterminated close head a
    // dead unit - it dies whole. The original #644 guarantee (real content
    // is never eaten) is unchanged.
    assert.equal(out, content, "dead unit dies whole; real content survives byte-exact");
});

test("streaming filter matches stripAcpTags for a malformed close at every split position (#644)", () => {
    const content = "这是真实的正文内容，不应被过滤器吃掉。".repeat(12);
    const full = `${LT}acp tokens="245" type="text">m01998${LT}/acp` + content;
    const expected = stripAcpTags(full);
    for (let split = 0; split <= full.length; split++) {
        const f = createTagEchoFilter();
        const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
        assert.equal(out, expected, `split=${split}`);
    }
});

// A genuinely short truncated close at end-of-stream (<= 32 chars) is still a
// truncated imitation and is dropped — the bound must not over-release.
test("stripAcpTags: short truncated close at end is still dropped (#644 bound)", () => {
    assert.equal(stripAcpTags(`ref m00001 ${LT}/acp`), "ref m00001 ");
    assert.equal(stripAcpTags(`ref m00001 ${LT}/acp tokens`), "ref m00001 ");
});

// The actual #644 incident shape: whitespace right after the malformed
// close. The unbounded close-side tails consumed content only through the
// \s[^<>]* group, so the no-whitespace variants above never triggered the
// bug on their own — this is the shape that ate the real prose.
test("stripAcpTags: malformed close with trailing space does not eat following content (#644 incident shape)", () => {
    const content = "这是真实的正文内容，不应被过滤器吃掉。".repeat(12);
    const malformed = `${LT}acp tokens="245" type="text">m01998${LT}/acp ` + content;
    const out = stripAcpTags(malformed);
    // Same #2862 evolution as the no-whitespace variant above.
    assert.equal(out, " " + content, "dead unit dies whole; real content survives byte-exact");
});

test("streaming filter matches stripAcpTags for the incident-shape malformed close at every split position (#644)", () => {
    const content = "这是真实的正文内容，不应被过滤器吃掉。".repeat(12);
    const full = `${LT}acp tokens="245" type="text">m01998${LT}/acp ` + content;
    const expected = stripAcpTags(full);
    for (let split = 0; split <= full.length; split++) {
        const f = createTagEchoFilter();
        const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
        assert.equal(out, expected, `split=${split}`);
    }
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
        `typo ${LT}acpi tokens="36" type="text"\x3em00473${LT}/acpi\x3e tail`,
        `mixed ${LT}acp tokens="36" type="text"\x3em00473${LT}/acip\x3e tail`,
        `rev ${LT}apic tokens="9" type="text"\x3em001${LT}/acp\x3e tail`,
        `safe #include ${LT}acpi/acpi.h\x3e and ${LT}caption\x3ex${LT}/caption\x3e ${LT}app id="1"\x3erun${LT}/app\x3e`,
        `${OPEN}tokens="1" type="text">${"Z".repeat(30)}${CLOSE}`,
        `${OPEN}tokens="1" type="text">\n正文段落\n${CLOSE}`,
        `回答开始。${OPEN}tokens="1" type="text">这是什么东西${CLOSE}回答结束。`,
        `lead ${OPEN}tokens="1" type="text"> m00123 ${CLOSE} tail`,
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

// #4179: prose GLUED to a multi-ref run + orphan close. When the chunk boundary
// falls between prose and run, the leftmost ORPHAN_REF_CLOSE match sits at the
// buffer head and its head is voided by the cross-chunk lookbehind (#644); the
// fix must re-scan for the valid MID-RUN start (a ref preceded by a joiner)
// instead of abandoning the drop, or the deletion depends on the chunking.
test("streaming filter matches stripAcpTags for a word-glued multi-ref orphan run at every split position (#4179)", () => {
    const cases = [
        `textm00123\u2013m00124${CLOSE} tail.`,
        `textm00123,m00124${CLOSE} tail.`,
        `textm00123-m00124${CLOSE} tail.`,
        `textm00123\u2013m00124,m00125${CLOSE} tail.`,
        `text m00123\u2013m00124${CLOSE} tail.`,
        `textm00124${CLOSE} tail.`,
    ];
    for (const full of cases) {
        const expected = stripAcpTags(full);
        for (let split = 0; split <= full.length; split++) {
            const f = createTagEchoFilter();
            const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
            assert.equal(out, expected, `split=${split} full=${JSON.stringify(full)}`);
        }
    }
    // Pin the drop semantics explicitly (parity alone would track any future
    // whole-text drift): word-glued head ref survives; joiner + last ref + close
    // die as one unit; a single word-glued ref is NOT an orphan (lone close only).
    assert.equal(stripAcpTags(`textm00123\u2013m00124${CLOSE} tail.`), `textm00123\u2013 tail.`);
    assert.equal(stripAcpTags(`textm00124${CLOSE} tail.`), `textm00124 tail.`);
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

test("non-stream responses rewriteResponsesJsonResponse strips echoed tags with no compress call (#460)", () => {
    const body = {
        id: "resp_1",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${TAG("m00155")} done` }] }],
        status: "incomplete",
    };
    const rewritten = rewriteResponsesJsonResponse(structuredClone(body), { core: createCore(), config: { modelContextLimit: 200000 } as Config, messages: [], session: makeCtx("ns-responses").session, log: () => {} });
    const parsed = rewritten as { output: Array<{ content: Array<{ text: string }> }> };
    assert.equal(parsed.output[0].content[0].text, "answer  done");
    assert.equal(JSON.stringify(rewritten).includes(OPEN), false, "a render tag survived the responses JSON rewrite");
});

test("non-stream responses rewriteResponsesJsonResponse strips sibling prose but never the compress note (#460)", () => {
    const args = "{\"content\":[]}";
    const clean = {
        id: "resp_c",
        output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "plain prose" }] },
        { type: "function_call", name: "compress", call_id: "c1", arguments: args },
    ],
    };
    const echoed = structuredClone(clean) as { output: Array<{ content: Array<{ text: string }> }> };
    echoed.output[0].content[0].text = `plain prose${TAG("m00155")}`;
    const cleanOut = rewriteResponsesJsonResponse(structuredClone(clean), { core: createCore(), config: { modelContextLimit: 200000 } as Config, messages: [], session: makeCtx("ns-note-clean").session, log: () => {} });
    const echoOut = rewriteResponsesJsonResponse(echoed, { core: createCore(), config: { modelContextLimit: 200000 } as Config, messages: [], session: makeCtx("ns-note-echo").session, log: () => {} });
    const note = (r: unknown) => {
        const o = (r as { output?: Array<{ content?: Array<{ text: string }> }> }).output ?? [];
        return o[0]?.content?.[0]?.text ?? "";
    };
    const prose = (r: unknown) => {
        const o = (r as { output?: Array<{ content?: Array<{ text: string }> }> }).output ?? [];
        return o[1]?.content?.[0]?.text ?? "";
    };
    assert.equal(note(cleanOut), note(echoOut), "the synthesized compress record must not be edited by the strip");
    assert.equal(prose(cleanOut), prose(echoOut), "echoed sibling prose must be stripped to the same text as clean prose");
    assert.ok(note(echoOut).length > 0, "no note was injected at all");
    assert.equal(JSON.stringify(echoOut).includes(OPEN), false, "no render tag reached the client body");
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

test("streaming filter keeps prose between paired tags, dropping only the tags (#1720)", () => {
    const full = `回答开始。${OPEN}tokens="1" type="text">这是什么东西${CLOSE}回答结束。`;
    const f = createTagEchoFilter();
    let visible = "";
    for (let i = 0; i < full.length; i += 5) visible += f.push(full.slice(i, i + 5));
    visible += f.flush();
    assert.equal(visible, "回答开始。这是什么东西回答结束。");
    assert.ok(f.dropped(), "the tag fragments are accounted as dropped");
});

test("streaming filter still drops a ref echo whose open tag arrives alone in a chunk (#1720)", () => {
    const open = `${OPEN}tokens="1" type="text">`;
    const f = createTagEchoFilter();
    let visible = f.push(open);
    visible += f.push(`m00123${CLOSE}`);
    visible += f.flush();
    assert.equal(visible, "");
    assert.ok(f.dropped());
});

// #4169: a nested bare open inside an attrs payload must take the same verdict
// in streaming as in whole-text (LONE_OPEN pass) — the close-resolution release
// used to hand the body to the client verbatim, leaking the nested tag while
// whole-text stripped it.
test("streaming strips a nested bare open inside an attrs payload like whole-text, at every split (#4169)", () => {
    const full = `A ${OPEN}tokens="1" type="text">junk${LT}acp>text${CLOSE}B.`;
    const expected = stripAcpTags(full);
    assert.equal(expected, "A junktextB.", "whole-text reference strips the nested bare open");
    for (let split = 0; split <= full.length; split++) {
        const f = createTagEchoFilter();
        const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
        assert.equal(out, expected, `split=${split}`);
    }
});

test("streaming matches whole-text for nested structures inside attrs payloads (#4169)", () => {
    const shapes = [
        `A ${OPEN}tokens="1" type="text">x${LT}acp>y${CLOSE}z${CLOSE}B.`,
        `A ${OPEN}tokens="1" type="text">x${LT}acp tokens="2">y${CLOSE}z${CLOSE}B.`,
        `A ${OPEN}tokens="1" type="text">${LT}acp>m00001${CLOSE}${CLOSE}B.`,
        `A ${OPEN}tokens="1" type="text">x${LT}acp tokens="2 y${CLOSE}z`,
    ];
    for (const full of shapes) {
        const expected = stripAcpTags(full);
        for (let split = 0; split <= full.length; split++) {
            const f = createTagEchoFilter();
            const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
            assert.equal(out, expected, `split=${split} full=${JSON.stringify(full)}`);
        }
    }
});

// #1731 replaced the old open-side attr caps ({0,256}/{0,512}): a longer run
// escaped every open-tag matcher while the loose close still went, leaving
// orphan markup on the wire. [^<>] cannot cross a bracket, so the uncapped
// matchers stay linear; a terminated open is now decided by body shape
// (#1720), never by attr length. These tests supersede the former
// "long attr run = prose" pins, which encoded the bypass itself.
test("long-attr paired render tags are stripped, whole-text and at every split (#1731)", () => {
    const attrs = "x".repeat(300);
    const full = `before ${OPEN}${attrs}>m00155${CLOSE} after`;
    const expected = stripAcpTags(full);
    assert.equal(expected, "before  after");
    for (let split = 0; split <= full.length; split++) {
        const f = createTagEchoFilter();
        const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
        assert.equal(out, expected, `split=${split}`);
    }
});

test("terminated long-attr open without a close is still a tag head (#1731)", () => {
    const span = `${OPEN}${"x".repeat(300)}>`;
    assert.equal(stripAcpTags(`before ${span} after`), "before  after");
    const f = createTagEchoFilter();
    assert.equal(f.push(`before ${span}`), "before ");
    assert.ok(f.pending());
    assert.equal(f.flush(), "");
});

test("case-drifted render tags are stripped, whole-text and at every split (#1731)", () => {
    const up = `\x3cACP tokens="1" type="text"\x3em00155\x3c/ACP\x3e`;
    const mixed = `\x3cAcP tokens="1" type="text"\x3em00009\x3c/aCP\x3e`;
    assert.equal(stripAcpTags(`pre ${up} post`), "pre  post");
    assert.equal(stripAcpTags(mixed), "");
    assert.equal(stripAcpTags(`pre \x3cACP tokens="1" type="text"\x3e post`), "pre  post");
    assert.equal(stripAcpTags(`pre \x3c/ACP\x3e post`), "pre  post");
    const full = `before ${up} after`;
    const expected = stripAcpTags(full);
    for (let split = 0; split <= full.length; split++) {
        const f = createTagEchoFilter();
        const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
        assert.equal(out, expected, `split=${split}`);
    }
});

test("case-drifted tag heads engage the streaming gates (#1731)", () => {
    assert.equal(containsRenderTagText(`\x3cACP tokens="1"\x3e`), true);
    assert.equal(mayStartRenderTag(`chunk \x3cAC`), true);
    assert.equal(mayStartRenderTag(`chunk \x3c/A`), true);
});

test("prose guards hold under case drift (#1731)", () => {
    assert.equal(stripAcpTags(`see the \x3cCaption\x3ex\x3c/Caption\x3e here`), `see the \x3cCaption\x3ex\x3c/Caption\x3e here`);
    assert.equal(stripAcpTags(`\x3capp id="1"\x3erun\x3c/app\x3e`), `\x3capp id="1"\x3erun\x3c/app\x3e`);
    assert.equal(stripAcpTags(`per the ACPI spec and #include \x3cacpi/acpi.h\x3e`), `per the ACPI spec and #include \x3cacpi/acpi.h\x3e`);
    assert.equal(stripAcpTags(`#include \x3cACPI/acpi.h\x3e`), `#include \x3cACPI/acpi.h\x3e`);
    assert.equal(stripAcpTags(`\x3cCAPTION\x3etext\x3c/CAPTION\x3e`), `\x3cCAPTION\x3etext\x3c/CAPTION\x3e`);
});

test("uncapped attr runs stay linear (no ReDoS) (#1731)", () => {
    const big = OPEN + "a".repeat(200_000) + ">m00155" + CLOSE;
    const t0 = process.hrtime.bigint();
    const out = stripAcpTags(big);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(out, "");
    assert.ok(ms < 500, `single 200KB attr run took ${ms.toFixed(1)}ms`);
    const heads = Array.from({ length: 500 }, () => OPEN + "b".repeat(400)).join(" prose ");
    const t1 = process.hrtime.bigint();
    stripAcpTags(heads);
    const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.ok(ms2 < 1000, `500 unterminated heads took ${ms2.toFixed(1)}ms`);
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

test("stripAcpTags removes typo'd acplike render tags (#673)", () => {
    assert.equal(stripAcpTags(`${LT}acpi tokens="36" type="text"\x3em00473${LT}/acpi\x3e`), "");
    assert.equal(stripAcpTags(`before ${LT}acp tokens="2" type="text"\x3em00473${LT}/acip\x3e after`), "before  after");
    for (const name of ["acpi", "acip", "apic", "cap", "cpa", "pac", "pca"]) {
        assert.equal(stripAcpTags(`${LT}${name} tokens="1" type="text"\x3em00473${LT}/${name}\x3e`), "", name);
    }
});

test("typo'd openers engage the streaming gate (#673)", () => {
    for (const s of [`${LT}acip `, `${LT}acpi`, `${LT}/acip`]) {
        assert.equal(mayStartRenderTag(s), true, s);
        assert.equal(containsRenderTagText(s + "\x3e"), true, s);
    }
});

test("legit angle-bracket text survives the loosened filter (#673)", () => {
    const safe = [
        "#include \\x3cacpi/acpi.h\\x3e",
        "\\x3ccaption\\x3ehi\\x3c/caption\\x3e",
        "\\x3capp id=\"1\"\\x3erun\\x3c/app\\x3e",
        "\\x3cACPI_DEVICE\\x3e",
        "a \\x3c b and b \\x3e c",
        "\\x3cacp_compress\\x3ex\\x3c/acp_compress\\x3e",
    ];
    for (const s of safe) {
        assert.equal(stripAcpTags(s), s);
        for (let split = 0; split <= s.length; split++) {
            const f = createTagEchoFilter();
            const out = f.push(s.slice(0, split)) + f.push(s.slice(split)) + f.flush();
            assert.equal(out, s, `split=${split} full=${JSON.stringify(s)}`);
        }
    }
});

// #2348: the self-closing render forms (<name attrs/>, bare <name/>) are the
// documented strip scope (module header) yet leaked on every path: whole-text
// had no matcher for the bare form at all, and streaming read the attrs form
// as an UNCLOSED opening whose EOF swallow then dropped the following prose
// (measured 57 -> 3 chars). The slash must stay mandatory so a genuinely
// unterminated open keeps its hold/swallow path.
const SELF_ATTRS = `${OPEN}tokens="0" type="text"/>`;
const SELF_BARE = `${LT}acp/>`;

test("stripAcpTags removes self-closing render forms, keeping surrounding prose (#2348)", () => {
    assert.equal(stripAcpTags(`前文 ${SELF_ATTRS} 后文`), "前文  后文");
    assert.equal(stripAcpTags(`前文 ${SELF_BARE} 后文`), "前文  后文");
    assert.equal(stripAcpTags(`${SELF_ATTRS}\n${SELF_ATTRS}\n${SELF_BARE}`), "\n\n");
    // typo'd acplike names follow the same rule as their paired form (#673)
    assert.equal(stripAcpTags(`${LT}acpi/>`), "");
});

test("self-close stripping never touches ordinary markup or non-acplike names (#2348)", () => {
    const safe = [
        `use ${LT}br/> here`,
        `see ${LT}caption/> and ${LT}app/> docs`,
        "a < b and b > c",
    ];
    for (const s of safe) {
        assert.equal(stripAcpTags(s), s);
        for (let split = 0; split <= s.length; split++) {
            const f = createTagEchoFilter();
            const out = f.push(s.slice(0, split)) + f.push(s.slice(split)) + f.flush();
            assert.equal(out, s, `split=${split} full=${JSON.stringify(s)}`);
        }
    }
});

test("streaming filter matches stripAcpTags for self-closing forms at every split position (#2348)", () => {
    const cases = [
        `前文 ${SELF_ATTRS} 后文 prose continues.`,
        `前文 ${SELF_BARE} 后文 prose continues.`,
        `lead ${SELF_ATTRS}${SELF_ATTRS}${SELF_BARE} tail`,
        `${SELF_ATTRS}\n${SELF_ATTRS}\n${SELF_ATTRS}`,
        `好的${SELF_BARE}完毕`,
    ];
    for (const full of cases) {
        const expected = stripAcpTags(full);
        for (let split = 0; split <= full.length; split++) {
            const f = createTagEchoFilter();
            const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
            assert.equal(out, expected, `split=${split} full=${JSON.stringify(full)}`);
        }
        for (let seed = 1; seed < 5; seed++) {
            const f = createTagEchoFilter();
            let out = "";
            let rest = full;
            while (rest.length > 0) {
                const take = (seed * 7 + rest.length) % rest.length + 1;
                out += f.push(rest.slice(0, take));
                rest = rest.slice(take);
            }
            out += f.flush();
            assert.equal(out, expected, `seed=${seed} full=${JSON.stringify(full)}`);
        }
    }
});

test("streaming filter accounts self-closing echoes as dropped, not swallowed prose (#2348)", () => {
    const full = `前文 ${SELF_ATTRS} 后文 prose continues.`;
    let dropped = "";
    const f = createTagEchoFilter((s) => { dropped = s; });
    let visible = "";
    for (let i = 0; i < full.length; i += 5) visible += f.push(full.slice(i, i + 5));
    visible += f.flush();
    assert.equal(visible, "前文  后文 prose continues.", "the prose after the self-close must survive");
    assert.ok(f.dropped(), "the echo is accounted as dropped");
    assert.ok(dropped.includes("acp"), "the drop callback saw the tag bytes");
});

test("self-closing forms engage the streaming gates, non-acplike names do not (#2348)", () => {
    assert.equal(containsRenderTagText(SELF_BARE), true);
    assert.equal(containsRenderTagText(SELF_ATTRS), true);
    assert.equal(mayStartRenderTag(`chunk ${SELF_BARE}`), true);
    assert.equal(mayStartRenderTag(`chunk ${LT}acp/`), true);
    assert.equal(mayStartRenderTag(`prose ${LT}br/>`), false);
    assert.equal(mayStartRenderTag(`prose ${LT}caption/>`), false);
});

test("anthropic adapter keeps prose after a self-closing echo (#2348)", async () => {
    const tagged = `好的 ${SELF_ATTRS}结论`;
    const parts: string[] = [];
    for (let i = 0; i < tagged.length; i += 9) parts.push(tagged.slice(i, i + 9));
    const sseParts: string[] = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 100 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        ...parts.map((p) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })}\n\n`),
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const out = await drain(sseFromStrings(sseParts), createAnthropicAdapter({ model: "test" }));
    const texts = [...out.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    assert.equal(texts.join(""), "好的 结论", "no prose may be swallowed by the self-closing echo");
});

// #2348 owner decision §4 (instance C): a valid acplike open + single bare ref
// closed by a FULLWIDTH corrupt close must die atomically in BOTH modes via
// the existing drop callback — never silently swallowed, never leaking orphan
// markup. The specimen bytes are the real ones (U+FF1C fullwidth less-than).
const C_SPECIMEN = `${OPEN}tokens="38" string="true"\x3em00282${CLOSE}\n${OPEN}tokens="44" type="text"\x3em00281${LT}/\uFF1C\uFF1CDSML\uFF1C\uFF1C parameter>`;

test("fullwidth-corrupt close dies atomically with its ref span, whole-text (#2348 §4)", () => {
    assert.equal(stripAcpTags(C_SPECIMEN), "\n", "both spans go, only the newline survives");
    assert.equal(stripAcpTags(`lead ${C_SPECIMEN} tail`), "lead \n tail", "no orphan ref+close residue");
});

test("streaming filter matches whole-text for the corrupt-close specimen at every split (#2348 §4)", () => {
    const full = `lead ${C_SPECIMEN} tail`;
    const expected = stripAcpTags(full);
    for (let split = 0; split <= full.length; split++) {
        const f = createTagEchoFilter();
        const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
        assert.equal(out, expected, `split=${split} full=${JSON.stringify(full)}`);
    }
});

test("the widened close path drops via the warn callback, not silently (#2348 §4 constraint b)", () => {
    // Mid-stream is the sharp case: without the widened class the fullwidth
    // close never ends the swallow, the cap releases the ref+garbage back into
    // the output, and only the trailing pair gets stripped.
    const tag2 = `${OPEN}tokens="44" type="text"\x3em00281${LT}/\uFF1C\uFF1CDSML\uFF1C\uFF1C parameter>`;
    const pair2 = `${LT}acpi tokens="1" type="text"\x3em00999${LT}/acpi\x3e`;
    const stream = `${tag2}  more prose ${pair2}`;
    const expected = stripAcpTags(stream);
    assert.equal(expected, "  more prose ", "the span dies atomically, prose survives");
    let warned = "";
    const f = createTagEchoFilter((s) => { warned = s; });
    let visible = "";
    for (let i = 0; i < stream.length; i += 7) visible += f.push(stream.slice(i, i + 7));
    visible += f.flush();
    assert.equal(visible, expected, "streaming matches whole-text");
    assert.ok(warned.length > 0, "the drop callback fired — the span went through drop(), not an EOF fallback");
    assert.ok(f.dropped(), "accounted as dropped");
});

test("empty-name close is NOT swallowed by the widened close class (#2348 §4 constraint a)", () => {
    const s = `ref m1234${LT}/> stays`;
    assert.equal(stripAcpTags(s), s, "{1,32} keeps a minimum char: an empty-name close stays visible");
    const f = createTagEchoFilter();
    assert.equal(f.push(s) + f.flush(), s, "streaming agrees");
});

test("bili's own retrieval pointer marker survives both modes untouched (#2348 negative sample)", () => {
    // The v1 census probe over-counted self-closing tags because \\b holds at
    // the p/- boundary and swept in bili's own CCR export pointer — this is the
    // family that must stay a permanent false negative.
    const marker = `${LT}acp-retrieved-file ref="m0123" path="/tmp/x.txt" lines="42"/>`;
    const s = `pointer ${marker} note`;
    assert.equal(stripAcpTags(s), s);
    for (let split = 0; split <= s.length; split++) {
        const f = createTagEchoFilter();
        const out = f.push(s.slice(0, split)) + f.push(s.slice(split)) + f.flush();
        assert.equal(out, s, `split=${split} full=${JSON.stringify(s)}`);
    }
});

test("attr-drifted self-closing (H-class sample) is stripped in both modes (#2348)", () => {
    const h = `${LT}acp test="m00430"/>`;
    assert.equal(stripAcpTags(`a ${h} b`), "a  b");
    const f = createTagEchoFilter();
    assert.equal(f.push(`a ${h} b`) + f.flush(), "a  b");
});

test("filter stats() accumulates lifetime input/output/dropped (#673)", () => {
    const first = `hello ${TAG("m00123")}`;
    const f = createTagEchoFilter();
    f.push(first);
    f.flush();
    f.push("world");
    const st = f.stats();
    assert.equal(st.inputChars, first.length + 5);
    assert.equal(st.outputChars, "hello world".length);
    assert.equal(st.dropped, true);
});

test("degenerateTurnWarning fires only on terminal zero-text zero-tool turns (#673)", () => {
    const base = {
        reason: "end_turn" as string | undefined,
        terminalReason: "end_turn",
        toolCalls: 0,
        text: { inputChars: 63, outputChars: 0, dropped: true, dropCount: 1 },
        sawThinking: true,
        wire: "anthropic",
    };
    const hit = degenerateTurnWarning(base);
    assert.match(hit ?? "", /\[degenerate-turn\] anthropic: turn ended end_turn/);
    assert.match(hit ?? "", /thinking present/);
    assert.match(hit ?? "", /stripped as render-tag echo/);
    assert.equal(degenerateTurnWarning({ ...base, reason: "tool_use" }), null);
    assert.equal(degenerateTurnWarning({ ...base, toolCalls: 1 }), null);
    assert.equal(degenerateTurnWarning({ ...base, text: { inputChars: 5, outputChars: 3, dropped: false, dropCount: 0 } }), null);
    assert.match(degenerateTurnWarning({ ...base, sawThinking: false, text: { inputChars: 0, outputChars: 0, dropped: false, dropCount: 0 } }) ?? "", /no visible text emitted/);
});

test("degenerateTurnWarning also fires on max-output truncations that left nothing visible (#2904)", () => {
    const empty = { inputChars: 0, outputChars: 0, dropped: false, dropCount: 0 };
    // Every wire's native max-output word must be recognized as a limit reason.
    for (const [reason, terminalReason, wire] of [
        ["length", "stop", "openai"],
        ["max_tokens", "end_turn", "anthropic"],
        ["MAX_TOKENS", "STOP", "google"],
        ["incomplete", "completed", "responses"],
        ["max_output_tokens", "completed", "responses"],
    ] as Array<[string, string, string]>) {
        const msg = degenerateTurnWarning({ reason, terminalReason, toolCalls: 0, text: empty, sawThinking: true, wire });
        assert.match(msg ?? "", new RegExp(`\\[degenerate-turn\\] ${wire}: turn ended ${reason} \\(max-output\\)`), `${reason} flagged as max-output`);
        assert.match(msg ?? "", /pathologically small/, "points at the too-small outgoing budget");
    }
    // A truncated turn that DID emit prose or a tool call is not degenerate here.
    assert.equal(degenerateTurnWarning({ reason: "length", terminalReason: "stop", toolCalls: 0, text: { inputChars: 5, outputChars: 3, dropped: false, dropCount: 0 }, sawThinking: true, wire: "openai" }), null);
    assert.equal(degenerateTurnWarning({ reason: "length", terminalReason: "stop", toolCalls: 1, text: empty, sawThinking: true, wire: "openai" }), null);
    // Non-limit non-terminal reasons stay silent (no over-match).
    assert.equal(degenerateTurnWarning({ reason: "content_filter", terminalReason: "stop", toolCalls: 0, text: empty, sawThinking: true, wire: "openai" }), null);
    assert.equal(isMaxOutputReason("stop_sequence"), false);
    assert.equal(isMaxOutputReason("length"), true);
    assert.equal(isMaxOutputReason(undefined), false);
});

test("anthropic adapter warns on degenerate typo-tag-only turn (#673)", async () => {
    const logs: string[] = [];
    setLogCapture((_level, msg) => { logs.push(msg); });
    try {
        const echo = `${LT}acpi tokens="36" type="text"\x3em00473${LT}/acpi\x3e`;
        const parts: string[] = [];
        for (let i = 0; i < echo.length; i += 7) parts.push(echo.slice(i, i + 7));
        const sseParts: string[] = [
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 100 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "next step: run the build" } })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
            ...parts.map((p) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: p } })}\n\n`),
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ];
        const out = await drain(sseFromStrings(sseParts), createAnthropicAdapter({ model: "test" }));
        assert.ok(!out.includes("acpi"), "typo'd tag must not leak to the client");
        assert.ok(logs.some((l) => l.includes("[degenerate-turn]")), `expected degenerate-turn warn, got: ${logs.join(" | ")}`);
    } finally {
        setLogCapture(null);
    }
});

// The wrapped-turn imitation, recorded in the architect session
// 01a0a0cb-4a90-74db-8e19-814e80cd4e20 at 2026-09-16T17:29:09: the model opens a
// render tag and writes the whole turn — its tool call included — where the
// attributes are still open, so no close is ever written and no tag regex can
// match the span. The client received the orphan markup, found no tool call in
// it and stalled until it was nudged by hand. Source: the session store at
// <omp-agent>/sessions/-Nextcloud-ai-joshwa-architect/…_01a0a0cb-….jsonl.
const DSML_PIPE = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
const dsmlClose = (name: string) => `${LT}/${DSML_PIPE} ${name}>`;

/** @param bracket what the recorded turn wrote where the opening's value was
 *  still open — nothing (the recorded bytes) or a stray `>`. Both reach the
 *  client today; both must end as an empty turn. */
function wrappedTurnEcho(bracket = ""): string {
    return [
        `${OPEN}tokens="1" text="text${bracket}${dsmlClose("parameter")}`,
        `${LT}parameter name="i">Rebuilding to test the source, not the build${dsmlClose("parameter")}`,
        `${LT}/invoke>`,
        `${dsmlClose("calls")}"`,
        dsmlClose("parameter"),
        `${LT}/invoke>`,
        dsmlClose("calls"),
    ].join("\n");
}

test("stripAcpTags swallows a wrapped-turn imitation whole, leaving no orphan markup", () => {
    for (const echo of [wrappedTurnEcho(), wrappedTurnEcho(">")]) {
        assert.ok(containsToolCallXmlFragment(echo), "the fixture holds the turn's tool-call markup");
        assert.equal(stripAcpTags(echo), "", "the whole wrapped span goes, not just the opening");
    }
});

test("stripAcpTags ends a wrapped span at a loose close, keeping prose after it", () => {
    const echo = wrappedTurnEcho();
    const prose = "然后是真正的回答：构建通过。";
    const out = stripAcpTags(`bad ${echo}${CLOSE} ${prose} tail`);
    assert.equal(out, `bad  ${prose} tail`, "prose after the imitation's close survives");
});

// A loose close anywhere in the buffer used to win the earliest-match race
// against the wrapped opening, so BROKEN_ATTRS was never consulted and the
// imitation — the turn's own tool-call markup among it — was emitted verbatim.
test("streaming filter swallows a wrapped span whose loose close shares its chunk", () => {
    const echo = wrappedTurnEcho();
    const prose = "然后是真正的回答：构建通过。";
    const full = `bad ${echo}${CLOSE} ${prose} tail`;
    const f = createTagEchoFilter();
    const out = f.push(full) + f.flush();
    assert.equal(out, stripAcpTags(full), "streaming matches stripAcpTags when the close shares the chunk");
    assert.ok(!containsToolCallXmlFragment(out), "no forged tool-call markup reaches the client");
});

test("streaming filter matches stripAcpTags for a wrapped-turn imitation at every split position", () => {
    for (const echo of [`${wrappedTurnEcho()}`, `${wrappedTurnEcho(">")}`, `${OPEN}tokens="1" text="unfinished${LT}invoke name="read">${LT}/invoke>`, TAG("m00155")]) {
        const full = `lead ${echo} tail`;
        const expected = stripAcpTags(full);
        for (let split = 0; split <= full.length; split++) {
            const f = createTagEchoFilter();
            const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
            assert.equal(out, expected, `split=${split} full=${JSON.stringify(full)}`);
        }
    }
});

test("streaming filter swallows a wrapped-turn imitation push by push, never emitting its payload", () => {
    const echo = wrappedTurnEcho();
    const f = createTagEchoFilter();
    let visible = "";
    for (let i = 0; i < echo.length; i += 7) visible += f.push(echo.slice(i, i + 7));
    visible += f.flush();
    assert.equal(visible, "", "nothing of the wrapped turn reaches the client");
    assert.ok(f.stats().dropped, "the span is accounted as dropped");
});

// #2348 pain-point corpus: real per-message leak samples from the issue's
// evidence zip (05-degenerate-tags: paired attr-drift forms embedded in CJK
// prose; instance-c-message: fullwidth-corrupt close; healthy-control: one
// canonical pair). Invariant: ZERO markup bytes reach the client in either
// mode, and streaming agrees with whole-text at every chunk size.
const PAINPOINT_DIR = new URL("./fixtures/painpoint-2348/", import.meta.url);
const PAINPOINT_FILES = [
    "sample-01-seq409-turn4.txt",
    "sample-02-seq424-turn4.txt",
    "sample-03-seq429-turn4.txt",
    "sample-04-seq454-turn4.txt",
    "sample-05-seq464-turn4.txt",
    "sample-06-seq469-turn4.txt",
    "sample-07-seq474-turn4.txt",
    "sample-08-seq522-turn8.txt",
    "instance-c-message.txt",
    "healthy-control-message.txt",
];

test("#2348 pain-point corpus: zero markup reaches the client; stream == whole-text at every chunk size", () => {
    for (const name of PAINPOINT_FILES) {
        const input = readFileSync(new URL(name, PAINPOINT_DIR), "utf8");
        const wt = stripAcpTags(input);
        assert.ok(!wt.includes(LT), `${name}: whole-text output leaves markup bytes`);
        for (const chunk of [1, 7, 32]) {
            const f = createTagEchoFilter();
            let out = "";
            for (let i = 0; i < input.length; i += chunk) out += f.push(input.slice(i, i + chunk));
            out += f.flush();
            assert.equal(out, wt, `${name} chunk=${chunk}: streaming diverges from whole-text`);
        }
    }
});

// #2348: pre-fix, an attr-self-closing render tag was read as an unclosed
// opening whose swallow state ate everything after it — the H-class shape
// below lost the model's ENTIRE visible reply before the fix. Pin the loss
// mode, not just the strip: output must equal the clean truth byte-for-byte.
test("#2348 self-closing forms keep all following prose byte-for-byte (pre-fix swallow-loss mode)", () => {
    const cases: Array<[string, string]> = [
        ["attr-selfclose mid-prose", `先说结论：缓存层没问题。\n\n${LT}acp tokens="12" type="text"/\x3e\n\n真正的原因在序列化那一环，下面展开。`],
        ["bare selfclose line-head", `${LT}acp/\x3e\n第二点，重试风暴来自上游限流而不是本地。`],
        ["mixed shapes one message", `核对完毕。\n${LT}acp tokens="38" string="true"\x3em00282${LT}/acp\x3e \n中间还夹了一个 ${LT}acp tokens="0" type="text"/\x3e 之类的残留。\n总之结论不变：先修序列化。`],
        ["H-class attr drift", `${LT}acp test="m00430"/\x3e\n收到，继续执行。`],
    ];
    for (const [label, input] of cases) {
        const truth = stripAcpTags(input);
        const f = createTagEchoFilter();
        let out = "";
        for (let i = 0; i < input.length; i += 7) out += f.push(input.slice(i, i + 7));
        out += f.flush();
        assert.equal(out, truth, `${label}: prose after the self-close was lost`);
        assert.ok(!out.includes(LT), `${label}: markup leaked`);
        assert.ok(f.stats().dropped, `${label}: drop accounting (warn path)`);
    }
});

// #2348 v4 corpus: the five new attr-drift families from the owner's
// EMIT-COUNTS audit (13-NEW-SHAPES-FIXTURES). The four paired shapes are
// ref-body echoes with impossible attribute sets (style / state / type_orig
// third attribute / hyphenated text-coercion) — stripped atomically in both
// modes like every other paired echo. The cache fixture is different: a
// LONE attrs-bearing opening followed by prose at EOF; whole-text keeps the
// prose (LONE_OPEN drops only the open) while streaming drops it (#1720
// wrapped-turn semantics, pre-existing — verified identical on pre-fix
// faea7caf4). Owner's own audit downgrades this family (0 ref-adjacent hits),
// so the divergence is pinned as-is rather than "fixed" against phantom data.
const NEWSHAPES_DIR = new URL("./fixtures/painpoint-2348/new-shapes/", import.meta.url);

test("#2348 v4: five attr-drift families — zero markup in either mode", () => {
    for (const name of ["type_orig.tag.txt", "style.tag.txt", "state.tag.txt", "text-coercion.tag.txt"]) {
        const input = readFileSync(new URL(name, NEWSHAPES_DIR), "utf8");
        assert.ok(input.includes(LT), name + ": fixture must contain markup");
        const wt = stripAcpTags(input);
        assert.equal(wt, "", name + ": whole-text must strip the tag atomically");
        for (const chunk of [1, 7, 32]) {
            const f = createTagEchoFilter();
            let out = "";
            for (let i = 0; i < input.length; i += chunk) out += f.push(input.slice(i, i + chunk));
            out += f.flush();
            assert.equal(out, "", name + ` chunk=${chunk}: streaming must strip atomically`);
            assert.ok(f.stats().dropped, name + " must be accounted as dropped");
        }
    }
    const msg = readFileSync(new URL("cache-message.txt", NEWSHAPES_DIR), "utf8");
    const wtMsg = stripAcpTags(msg);
    assert.equal(wtMsg, "Cache ledger: 6,672,281 tokens read / 55,971,908 t", "whole-text keeps the payload after a lone open");
    assert.ok(!wtMsg.includes(LT));
    const f = createTagEchoFilter();
    let out = "";
    for (let i = 0; i < msg.length; i += 7) out += f.push(msg.slice(i, i + 7));
    out += f.flush();
    assert.ok(!out.includes(LT), "no markup may leak in streaming");
});

test("#2348 v4: hard-cut close at EOF (</ap missing >) is dropped with its ref in both modes", () => {
    const open = `${OPEN}tokens="5" type="text"\x3e`;
    const cases: Array<[string, string]> = [
        [`${open}m00992${LT}/ap`, ""],
        [`前文 ${open}m00992${LT}/ap`, "前文 "],
        [`${open}m00992${LT}/apicdefghijklmnopqrstuvwxyz`, ""],
    ];
    for (const [input, expected] of cases) {
        assert.equal(stripAcpTags(input), expected, "whole-text: " + JSON.stringify(input));
        for (const chunk of [1, 5, 16]) {
            const f = createTagEchoFilter();
            let out = "";
            for (let i = 0; i < input.length; i += chunk) out += f.push(input.slice(i, i + chunk));
            out += f.flush();
            assert.equal(out, expected, `streaming chunk=${chunk}: ` + JSON.stringify(input));
        }
    }
    // controls: mid-text occurrences stay visible ($ anchor), complete closes
    // ride DEGEN_PAIR, and names over 32 chars are left alone.
    assert.equal(stripAcpTags(`x m00992${LT}/ap more`), `x m00992${LT}/ap more`);
    assert.equal(stripAcpTags(`${open}m00991${LT}/apc\x3e`), "");
    assert.equal(stripAcpTags(`${open}m00993${LT}/abcdefghijklmnopqrstuvwxyzabcdefg`), `m00993${LT}/abcdefghijklmnopqrstuvwxyzabcdefg`, "33-char name exceeds the cap and stays visible");
});

// #2348 pain point 1 (owner): ordinary turns carry 1-N canonical tags — that
// is 100% of real traffic (avg 49.7/file), not an edge case. The expanded
// matcher surface (SELF_CLOSE, widened close classes, TRUNC_REF_CLOSE) must
// leave such turns byte-for-byte intact in BOTH modes.
test("#2348 v4: ordinary tag-laden turns are byte-stable through both modes", () => {
    for (const n of [1, 8, 49, 80]) {
        let turn = "";
        let expected = "";
        for (let i = 1; i <= n; i++) {
            const tok = i % 7 === 0 ? "1.2K" : String((i * 37) % 900);
            turn += `第${i}段正文，结论先行。` + `${OPEN}tokens="${tok}" type="text"\x3em${String(i).padStart(4, "0")}${CLOSE}`;
            expected += `第${i}段正文，结论先行。`;
        }
        turn += "收尾句。";
        expected += "收尾句。";
        assert.equal(stripAcpTags(turn), expected, `n=${n}: whole-text must be byte-exact`);
        for (const chunk of [1, 7, 32, 512]) {
            const f = createTagEchoFilter();
            let out = "";
            for (let i = 0; i < turn.length; i += chunk) out += f.push(turn.slice(i, i + chunk));
            out += f.flush();
            assert.equal(out, expected, `n=${n} chunk=${chunk}: streaming must be byte-exact`);
        }
    }
});

// #2769 item 3 (filter-semantics pin): the chat-pipe fold sites account the
// push output (`released`) and the flush output (the folded `tail`) as two
// separate contributions. This pins the premise that makes their interplay
// non-trivial: ONE push can return a NON-EMPTY released prefix while leaving
// pending state whose flush() returns NON-ORPHAN prose — with onDrop firing in
// between. A bare opening (#1881) does exactly this: pre-open text releases
// immediately, the opening is dropped, and the post-open remainder stays held
// until EOF, where it resolves as content ("prose wearing a tag", #1720/#2023).
test("#2769: flush() can return non-orphan prose after a non-empty release with a drop", () => {
    let drops = 0;
    const f = createTagEchoFilter(() => drops++);
    const released = f.push(`pre${LT}acp\x3e    `);
    assert.equal(released, "pre", "pre-open text releases before the swallow starts");
    assert.equal(drops, 1, "the bare opening is dropped and onDrop fires");
    assert.ok(f.pending(), "the post-open remainder is still held");
    const tail = f.flush();
    assert.equal(tail, "    ", "the held remainder resolves as content at EOF");
    assert.equal(isOrphanMarkupText(tail), false, "that content is NOT orphan markup — the pipe must count it as prose");
});
