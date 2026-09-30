import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Config, CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { executeProxyTool } from "../src/loop/core.ts";
import { createOpenaiAdapter, runCompressLoop } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #1502: strict JSON.parse failure on proxy-tool arguments used to discard the
// raw string and execute against {} — bypassing the kernel's lenient salvage
// ladder for compress and mislabeling corrupt calls as empty ones.

const enc = new TextEncoder();
const sseChunk = (delta: Record<string, unknown>, finishReason?: string) =>
    enc.encode(
        `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt",
            choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
        })}\n\n`,
    );

const mockStream = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.enqueue(enc.encode(`data: [DONE]\n\n`));
            controller.close();
        },
    });

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

type Ctx = {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    logs: string[];
};

function makeCtx(): Ctx {
    const logs: string[] = [];
    const messages = [
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ];
    const refMap = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const session: Session = {
        id: "issue1502-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
    session.state.messageRefs = refMap;
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session,
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

const LONG_SUMMARY = "OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK";

test("#1502: salvageable args that strict JSON.parse rejects compress via rawArguments (trailing comma)", () => {
    const raw = `{"content": [{"startId": "m00001", "endId": "m00002", "summary": "${LONG_SUMMARY}"}],}`;
    assert.throws(() => JSON.parse(raw), "premise: strict JSON.parse really fails");
    const ctx = makeCtx();
    const out = executeProxyTool("compress", {}, ctx, "c1", raw);
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);
    assert.equal(ctx.session.state.blocks.length, 1, "block created");
});

test("#1502: lenient ladder variants all salvage via rawArguments (fenced / single-quote / truncated prefix)", () => {
    const variants: Array<[string, string]> = [
        ["fenced", "```json\n" + `{"content": [{"startId": "m00001", "endId": "m00002", "summary": "${LONG_SUMMARY}"}]}` + "\n```"],
        ["single-quote", `{'content': [{'startId': 'm00001', 'endId': 'm00002', 'summary': '${LONG_SUMMARY}'}]}`],
        ["truncated prefix", `{"content": [{"startId": "m00001", "endId": "m00002", "summary": "${LONG_SUMMARY}"}`],
    ];
    for (const [label, raw] of variants) {
        const ctx = makeCtx();
        const out = executeProxyTool("compress", {}, ctx, `c_${label}`, raw);
        assert.ok(out.startsWith("[Compressed"), `${label}: expected success, got: ${out}`);
        assert.equal(ctx.session.state.blocks.length, 1, `${label}: block created`);
    }
});

test("#1502: without rawArguments the degraded {} still gets the #1384 empty-call receipt (unchanged)", () => {
    const ctx = makeCtx();
    const out = executeProxyTool("compress", {}, ctx, "c_empty");
    assert.ok(out.includes("carried no content at all"), out);
    assert.ok(out.includes("Do NOT re-issue an empty call"), out);
});

test("#1502: unparseable garbage gets the corruption receipt, not the empty-call verdict (unbalanced → truncated)", () => {
    const raw = '{"content": [{"startId": "m00001"';
    const ctx = makeCtx();
    const out = executeProxyTool("compress", {}, ctx, "c_garbage", raw);
    assert.ok(out.startsWith("[Compression FAILED"), out);
    assert.ok(out.includes(`(${raw.length} chars)`), "safe len label present: " + out);
    assert.ok(out.includes("were not parseable JSON"), out);
    assert.ok(out.includes("(looks truncated)"), out);
    assert.ok(!out.includes("carried no content at all"), "not mislabeled as empty: " + out);
    assert.ok(!out.includes("Do NOT re-issue an empty call"), out);
    const keys = ctx.session.metadata["compressFailKeys"] as unknown[];
    assert.match(String(keys[0]), /^parse:truncated:0:/, String(keys));
});

test("#1502: balanced garbage → malformed-json label without the truncation note", () => {
    const raw = "{this is not json at all}";
    const ctx = makeCtx();
    const out = executeProxyTool("compress", {}, ctx, "c_garbage2", raw);
    assert.ok(out.includes("were not parseable JSON"), out);
    assert.ok(!out.includes("(looks truncated)"), out);
    const keys = ctx.session.metadata["compressFailKeys"] as unknown[];
    assert.match(String(keys[0]), /^parse:malformed-json:0:/, String(keys));
});

test("#1502 loop: unparseable-but-salvageable compress args execute instead of degrading to {}", async () => {
    const rawArgs = `{"content": [{"startId": "m00001", "endId": "m00002", "summary": "Preserve every decision, file path and exact value in this range for the regression test."}],}`;
    assert.throws(() => JSON.parse(rawArgs), "premise: strict JSON.parse really fails");
    const ctx = makeCtx();
    const round1 = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_c", type: "function", function: { name: "compress", arguments: rawArgs } }] }, "tool_calls"),
    );
    const originalFetch = globalThis.fetch;
    let refetches = 0;
    globalThis.fetch = (async () => {
        refetches++;
        return new Response(
            `data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { status: 200 },
        );
    }) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(
            round1,
            ctx,
            { model: "gpt", stream: true },
            { url: "http://mock", headers: {} },
            createOpenaiAdapter({ model: "gpt" }),
            buildCompressSystemPrompt(),
        )) chunks.push(chunk);
        const output = Buffer.concat(chunks).toString("utf8");
        assert.match(output, /Compressed m00001/, "salvaged range compressed end-to-end");
        assert.doesNotMatch(output, /executing with \{\}/, "no degradation log");
        assert.doesNotMatch(output, /not parseable JSON/, "no parse-failure log");
        assert.ok(ctx.session.state.blocks.length >= 1, "block created");
        assert.equal(refetches, 1, "re-request proceeds after successful compress");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("#1502 loop: garbage args log head+tail and yield the corruption marker, not the empty-call verdict", async () => {
    const garbage = '{"content": [{"startId": "m00001", "endId": "m00002", "summary": "some summary payload';
    const ctx = makeCtx();
    const round1 = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_g", type: "function", function: { name: "compress", arguments: garbage } }] }, "tool_calls"),
    );
    const originalFetch = globalThis.fetch;
    let refetches = 0;
    globalThis.fetch = (async () => {
        refetches++;
        return new Response(
            `data: ${JSON.stringify({ id: "c3", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { status: 200 },
        );
    }) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(
            round1,
            ctx,
            { model: "gpt", stream: true },
            { url: "http://mock", headers: {} },
            createOpenaiAdapter({ model: "gpt" }),
            buildCompressSystemPrompt(),
        )) chunks.push(chunk);
        const output = Buffer.concat(chunks).toString("utf8");
        assert.match(ctx.logs.join("\n"), /arguments not parseable JSON \(len=\d+, head=.*tail=/s, "diag log carries head+tail");
        assert.doesNotMatch(output, /executing with \{\}/, "old degradation wording gone");
        assert.match(output, /were not parseable JSON/, "corruption marker streamed to client");
        assert.doesNotMatch(output, /carried no content at all/, "not mislabeled as empty");
        assert.equal(refetches, 1, "re-request proceeds after failed compress too");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
