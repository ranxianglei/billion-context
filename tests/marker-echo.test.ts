import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { stripAcpTags, stripMarkerLines, containsMarkerLineText, createMarkerLineFilter, composeStreamFilters, createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";
import { rewriteJsonResponse } from "../src/stream.ts";
import { rewriteOpenaiJsonResponse } from "../src/stream-openai.ts";
import { rewriteResponsesJsonResponse } from "../src/stream-responses.ts";
import { buildCompressSystemPrompt, withMarkerIntegrityNote } from "../src/compress-tool.ts";
import { setLogCapture } from "../src/logger.ts";

const LT = "\x3c";
const OPEN = `${LT}acp tokens="1" type="text">m00155`;
const CLOSE = `${LT}/acp>`;
const FORGED = "📦 [ACP] Compressed m00876–m01100 → 1 block(s), ~54134 tokens saved.";

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

async function drain(stream: ReadableStream<Uint8Array>, adapter: Parameters<typeof runCompressLoop>[4]): Promise<string> {
    const ctx = makeCtx("marker-echo-test");
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, {}, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt())) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

test("stripAcpTags strips forged compression confirmation markers (#717)", () => {
    const exact = `thinking out loud\n${FORGED}\n继续干活`;
    assert.equal(stripAcpTags(exact), "thinking out loud\n继续干活");
    const failed = "❌ [ACP] compress FAILED: invalid range spec";
    assert.equal(stripAcpTags(`a\n${failed}\nb`), "a\nb");
});

test("stripAcpTags strips the acp_status marker head line but keeps its body", () => {
    const s = `intro\n📊 [ACP] acp_status result:\nBreakdown: 4.2K system (21%)\nCOMPRESSED BLOCKS — 2 active`;
    assert.equal(stripAcpTags(s), "intro\nBreakdown: 4.2K system (21%)\nCOMPRESSED BLOCKS — 2 active");
});

test("stripAcpTags strips every real marker icon", () => {
    for (const icon of ["📦", "❌", "📤", "🔍", "📊", "🫧"]) {
        assert.equal(stripAcpTags(`x\n${icon} [ACP] something happened\ny`), "x\ny", icon);
    }
});

test("stripAcpTags leaves non-marker [ACP] prose intact", () => {
    assert.equal(stripAcpTags(`  ${FORGED}`), `  ${FORGED}`, "indented occurrence is quoting, not emitting");
    assert.equal(stripAcpTags("X [ACP] is a label"), "X [ACP] is a label");
    assert.equal(stripAcpTags(`see ${FORGED} inline`), `see ${FORGED} inline`);
    assert.equal(stripAcpTags("注意 [ACP] 标记是代理发出的"), "注意 [ACP] 标记是代理发出的");
    assert.equal(stripAcpTags("📊 see [ACP] docs later"), "📊 see [ACP] docs later");
});

test("containsMarkerLineText detects marker text in raw wire strings", () => {
    assert.equal(containsMarkerLineText(JSON.stringify({ text: `a\n${FORGED}\nb` })), true);
    assert.equal(containsMarkerLineText(JSON.stringify({ text: "plain prose about compression" })), false);
    assert.equal(containsMarkerLineText(JSON.stringify({ text: `tag ${OPEN}${CLOSE} here` })), false);
});

test("streaming createMarkerLineFilter matches stripMarkerLines at every split position (#717)", () => {
    const full = `好的，先说结论。\n${FORGED}\n  ${FORGED}\n继续：下一步跑测试。\n📊 [ACP] acp_status result:\nBreakdown: 4.2K system (21%)`;
    const expected = stripMarkerLines(full);
    for (let split = 0; split <= full.length; split++) {
        const f = createMarkerLineFilter();
        const out = f.push(full.slice(0, split)) + f.push(full.slice(split)) + f.flush();
        assert.equal(out, expected, `split=${split}`);
    }
});

test("streaming createMarkerLineFilter survives arbitrary chunking", () => {
    const full = `开头文本\n${FORGED}\n结尾文本\n🫧 [ACP] absorb done\n压`;
    const expected = stripMarkerLines(full);
    for (const nChunks of [1, 2, 3, 5, 9]) {
        const f = createMarkerLineFilter();
        let out = "";
        const size = Math.ceil(full.length / nChunks);
        for (let off = 0; off < full.length; off += size) {
            out += f.push(full.slice(off, off + size));
        }
        out += f.flush();
        assert.equal(out, expected, `nChunks=${nChunks}`);
    }
});

test("createMarkerLineFilter drops forged markers char-by-char and notifies once", () => {
    const drops: string[] = [];
    const f = createMarkerLineFilter((snippet) => drops.push(snippet));
    const input = `hello\n${FORGED}\nmiddle\n❌ [ACP] decompress FAILED: no such block\nworld`;
    let out = "";
    for (const ch of input) out += f.push(ch);
    out += f.flush();
    assert.equal(out, "hello\nmiddle\nworld");
    assert.equal(drops.length, 1, "onDrop fires once per filter lifetime");
    assert.ok(drops[0].includes(FORGED));
    assert.equal(f.dropped(), true);
    assert.equal(f.stats().dropped, true);
});

test("createMarkerLineFilter flush emits undecidable prefixes (content preservation)", () => {
    const f = createMarkerLineFilter();
    assert.equal(f.push("压"), "");
    assert.equal(f.pending(), true);
    assert.equal(f.flush(), "压");
    const g = createMarkerLineFilter();
    assert.equal(g.push("压 [AC"), "");
    assert.equal(g.flush(), "压 [AC");
});

test("composeStreamFilters strips render tags AND marker lines in sequence", () => {
    const f = composeStreamFilters(createTagEchoFilter(), createMarkerLineFilter());
    const input = `noise ${OPEN}inner${CLOSE} tail\n${FORGED}\nclean end`;
    const out = f.push(input) + f.flush();
    assert.equal(out, `noise  tail\nclean end`);
    const st = f.stats();
    assert.ok(st.dropped);
    assert.ok(st.inputChars === input.length && st.outputChars === out.length);
});

test("runCompressLoop strips model-emitted marker from client stream and warns (#717)", async () => {
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const text = `hello\n${FORGED}\nbye`;
        const parts: string[] = [];
        for (let i = 0; i < text.length; i += 7) parts.push(text.slice(i, i + 7));
        const sseParts = [
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 100 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
            ...parts.map((p) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })}\n\n`),
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ];
        const out = await drain(sseFromStrings(sseParts), createAnthropicAdapter({ model: "test" }));
        assert.ok(!out.includes("[ACP] Compressed"), "forged marker must not reach the client");
        const texts = [...out.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
        assert.equal(texts.join(""), "hello\nbye");
        assert.ok(logs.some((l) => l.includes("[marker-echo]")), `expected [marker-echo] warn, got: ${logs.join(" | ")}`);
    } finally {
        setLogCapture(null);
    }
});

test("non-stream anthropic rewriteJsonResponse strips forged markers", async () => {
    const body = {
        id: "msg_1",
        content: [{ type: "text", text: `before\n${FORGED}\nafter` }],
        usage: { input_tokens: 10, output_tokens: 5 },
    };
    const c = makeCtx("ns-anthropic-marker");
    const rewritten = rewriteJsonResponse(structuredClone(body), { core: c.core, config: c.config, messages: c.messages, session: c.session, log: () => {} });
    const parsed = rewritten as { content: Array<{ text: string }> };
    assert.equal(parsed.content[0].text, "before\nafter");
});

test("non-stream openai rewriteOpenaiJsonResponse strips forged markers", () => {
    const body = {
        id: "chatcmpl-1",
        choices: [{ index: 0, message: { role: "assistant", content: `before\n${FORGED}\nafter` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const rewritten = rewriteOpenaiJsonResponse(structuredClone(body), { core: createCore(), config: { modelContextLimit: 200000 } as Config, messages: [], session: makeCtx("ns-openai-marker").session, log: () => {} });
    const parsed = rewritten as { choices: Array<{ message: { content: string } }> };
    assert.equal(parsed.choices[0].message.content, "before\nafter");
});

test("non-stream responses rewriteResponsesJsonResponse strips forged markers", () => {
    const body = {
        id: "resp_1",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `before\n${FORGED}\nafter` }] }],
        status: "incomplete",
    };
    const rewritten = rewriteResponsesJsonResponse(structuredClone(body), { core: createCore(), config: { modelContextLimit: 200000 } as Config, messages: [], session: makeCtx("ns-responses-marker").session, log: () => {} });
    const parsed = rewritten as { output: Array<{ content: Array<{ text: string }> }> };
    assert.equal(parsed.output[0].content[0].text, "before\nafter");
});

test("withMarkerIntegrityNote appends the anti-forgery rule", () => {
    const out = withMarkerIntegrityNote("Nudge: OVER-LIMIT T1");
    assert.ok(out.startsWith("Nudge: OVER-LIMIT T1"));
    assert.ok(out.includes("NEVER emit such a line as your own text"));
    assert.ok(out.includes("call acp_status and confirm the block count increased"));
});
