import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #1766: unknown keys on upstream Anthropic terminal frames (e.g. the
// auto-mode classifier's safeguard_results) must survive into the synthetic
// completion — the loop replaces those frames, so anything unmodeled vanishes.

const ANTHROPIC_BODY = { model: "claude", messages: [], stream: true, max_tokens: 10 };

const SAFEGUARDS = [{ action: "Bash(npm test)", verdict: "allow", reason: "read-only command" }];

function makeCtx(id: string): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
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

async function drain(stream: ReadableStream<Uint8Array>, ctx: ReturnType<typeof makeCtx>): Promise<string> {
    const adapter = createAnthropicAdapter(ANTHROPIC_BODY);
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, ANTHROPIC_BODY, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt())) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

const ev = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

const MESSAGE_START = ev("message_start", {
    type: "message_start",
    message: {
        id: "msg_1", type: "message", role: "assistant", model: "claude",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
    },
});
const textBlock = (index: number, text: string) =>
    ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }) +
    ev("content_block_stop", { type: "content_block_stop", index });
const MESSAGE_STOP = ev("message_stop", { type: "message_stop" });

function sseDataBlocks(out: string, eventType: string): Record<string, unknown>[] {
    const blocks: Record<string, unknown>[] = [];
    for (const block of out.split("\n\n")) {
        const lines = block.split("\n");
        if (lines[0] !== `event: ${eventType}`) continue;
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (dataLine) blocks.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
    }
    return blocks;
}

test("#1766 parseStream: message_delta unknown key rides the done event as terminalExtra", async () => {
    const sse =
        MESSAGE_START +
        textBlock(0, "ok") +
        ev("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: 5, output_tokens: 3 },
            request_id: "req_1",
            safeguard_results: SAFEGUARDS,
        }) +
        MESSAGE_STOP;
    const adapter = createAnthropicAdapter(ANTHROPIC_BODY);
    const events: ParsedStreamEvent[] = [];
    for await (const e of adapter.parseStream(new Response(sse, { status: 200 }).body!, 1)) events.push(e);
    const done = events.find((e) => e.kind === "done");
    if (!done || done.kind !== "done") assert.fail("no done event emitted");
    assert.deepEqual(done.terminalExtra, { safeguard_results: SAFEGUARDS });
});

test("#1766 parseStream: message_stop unknown key rides the done event", async () => {
    const sse =
        MESSAGE_START +
        textBlock(0, "ok") +
        ev("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: 5, output_tokens: 3 },
        }) +
        ev("message_stop", { type: "message_stop", safeguard_results: SAFEGUARDS });
    const adapter = createAnthropicAdapter(ANTHROPIC_BODY);
    const events: ParsedStreamEvent[] = [];
    for await (const e of adapter.parseStream(new Response(sse, { status: 200 }).body!, 1)) events.push(e);
    const done = [...events].reverse().find((e) => e.kind === "done");
    if (!done || done.kind !== "done") assert.fail("no done event emitted");
    assert.deepEqual(done.terminalExtra, { safeguard_results: SAFEGUARDS });
});

test("#1766 full loop: safeguard_results survives into the synthesized terminal (client-visible bytes)", async () => {
    const sse =
        MESSAGE_START +
        textBlock(0, "ok") +
        ev("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: 5, output_tokens: 3 },
            safeguard_results: SAFEGUARDS,
        }) +
        MESSAGE_STOP;
    const out = await drain(new Response(sse, { status: 200 }).body!, makeCtx("t1766-full"));
    const terminals = sseDataBlocks(out, "message_delta");
    assert.equal(terminals.length, 1, "exactly one (synthetic) terminal frame reaches the client");
    assert.deepEqual(terminals[0].safeguard_results, SAFEGUARDS);
});

test("#1766 full loop: no unknown keys → synthesized terminal shape unchanged", async () => {
    const sse =
        MESSAGE_START +
        textBlock(0, "ok") +
        ev("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: 5, output_tokens: 3 },
        }) +
        MESSAGE_STOP;
    const out = await drain(new Response(sse, { status: 200 }).body!, makeCtx("t1766-negative"));
    const terminals = sseDataBlocks(out, "message_delta");
    assert.equal(terminals.length, 1);
    assert.deepEqual(Object.keys(terminals[0]).sort(), ["delta", "id", "model", "type", "usage"]);
});
