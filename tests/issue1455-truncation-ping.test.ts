import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #1455: upstream truncation on the in-loop re-request path. GLM-style
// upstreams open the re-request stream, send message_start + a ping
// keep-alive, then EOF without any completion event. Old behavior: the gate
// counted the forwarded ping as "output already delivered", skipped the
// invisible retry, and the fallback emitted a SYNTHESIZED end_turn — a dead
// turn dressed as a normal completion, so the client's own retry budget was
// never spent. Pinned here: (A) inert pings do not lock the retry gate,
// (B) the exhausted-failure exit rides the protocol-native error channel.

const ANTHROPIC_BODY = { model: "claude", messages: [], stream: true, max_tokens: 10 };
const OPENAI_BODY = { model: "deepseek-chat", stream: true };

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

function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
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
const PING = ev("ping", { type: "ping" });
const textStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
const textDelta = (index: number, text: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
const blockStop = (index: number) => ev("content_block_stop", { type: "content_block_stop", index });
const toolUseBlock = (index: number, id: string, name: string, input: string) =>
    ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }) +
    ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: input } }) +
    blockStop(index);
const MESSAGE_DELTA = (stopReason = "end_turn") => ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 3 } });
const MESSAGE_STOP = ev("message_stop", { type: "message_stop" });

// Round 1: complete message carrying a proxy tool call → the loop re-requests.
const ROUND1_PROXY_TOOL = [MESSAGE_START, toolUseBlock(0, "toolu_1", "acp_status", "{}"), MESSAGE_DELTA("tool_use"), MESSAGE_STOP].join("");
// Incident shape: stream opens, keep-alive ping, EOF — no completion event.
const PING_THEN_EOF = MESSAGE_START + PING;
const GOOD_ROUND2 = [MESSAGE_START, textStart(0), textDelta(0, "recovered"), blockStop(0), MESSAGE_DELTA(), MESSAGE_STOP].join("");
// #1455 supplement (reporter's round-1 cases): thinking-only prefix — the identity
// frame plus an OPENED thinking block with live deltas, then EOF. Zero visible
// output reached the client; old gates (any-byte and framing-aware alike) locked
// this out because the reasoning bytes count as forwarded.
const THINKING_START = ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
const THINKING_DELTA = (text: string) => ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } });
const REASONING_ONLY_TRUNCATED = MESSAGE_START + THINKING_START + THINKING_DELTA("let me think about this");

async function drainAnthropic(first: string, attempts: string[], id: string, errorShape: "protocol" | "completion" = "protocol"): Promise<{ out: string; calls: number }> {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n += 1;
        return new Response(attempts[n - 1] ?? "", { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    const ctx = makeCtx(id);
    (ctx as Record<string, unknown>).protocol = "anthropic";
    try {
        for await (const c of runCompressLoop(
            streamOf(first),
            ctx,
            ANTHROPIC_BODY,
            { url: "http://mock", headers: {} },
            createAnthropicAdapter(ANTHROPIC_BODY, undefined, undefined, errorShape),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(c);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), calls: n };
}

const sseBlocks = (s: string): string[] => s.split("\n\n").map((b) => b.trim()).filter(Boolean);

test("#1455 A: ping-only prefix before EOF no longer locks the blind retry — the re-request recovers", async () => {
    const { out, calls } = await drainAnthropic(ROUND1_PROXY_TOOL, [PING_THEN_EOF, GOOD_ROUND2], "i1455-a");
    assert.equal(calls, 2, "re-request + one invisible truncation retry");
    assert.ok(out.includes("recovered"), "retried round-2 content reached the client");
    assert.ok(!out.includes("upstream stream truncated"), "self-healed: no error surfaced");
    assert.equal(sseBlocks(out).filter((b) => b.startsWith("event: message_start")).length, 1, "exactly one message_start for the whole request (round >= 2 starts are suppressed)");
});

test("#1455 B: exhausted ping-only retries terminate on the protocol-native error channel", async () => {
    const { out, calls } = await drainAnthropic(ROUND1_PROXY_TOOL, [PING_THEN_EOF, PING_THEN_EOF], "i1455-b");
    assert.equal(calls, 2, "one re-request + one retry, then give up");
    assert.ok(out.includes("upstream stream truncated"), "failure visible to the client");
    const blocks = sseBlocks(out);
    assert.ok(blocks[blocks.length - 1].startsWith("event: error"), `last event is the error event (got ${blocks[blocks.length - 1].slice(0, 40)})`);
    assert.match(blocks[blocks.length - 1], /"code":"upstream_error"/);
    assert.doesNotMatch(blocks[blocks.length - 1], /message_delta|message_stop|stop_reason/, "no completion frame riding along with the failure");
});

test("#1455 B opt-out: errorShape=\"completion\" restores the legacy synthesized end_turn", async () => {
    const { out, calls } = await drainAnthropic(ROUND1_PROXY_TOOL, [PING_THEN_EOF, PING_THEN_EOF], "i1455-bc", "completion");
    assert.equal(calls, 2);
    const tail = out.slice(out.lastIndexOf("[acp-proxy:"));
    assert.ok(tail.startsWith("[acp-proxy:"), "error marker found");
    assert.ok(tail.includes("upstream stream truncated"));
    assert.match(tail, /"stop_reason":"end_turn"/, "legacy shape: synthesized successful completion");
    assert.match(tail, /event: message_stop/);
});

test("#1455 A2: reasoning-only truncation on round 1 no longer locks the blind retry — recovers with a single start frame and no dangling block", async () => {
    const { out, calls } = await drainAnthropic(REASONING_ONLY_TRUNCATED, [GOOD_ROUND2], "i1455-a2");
    assert.equal(calls, 1, "one invisible truncation retry");
    assert.ok(out.includes("recovered"), "retried content reached the client");
    assert.ok(!out.includes("upstream stream truncated"), "self-healed: no error surfaced");
    const blocks = sseBlocks(out);
    assert.equal(blocks.filter((b) => b.startsWith("event: message_start")).length, 1, "exactly one message_start — the retry's start frame must be suppressed by forwarding state, not round number");
    const starts = (out.match(/event: content_block_start/g) ?? []).length;
    const stops = (out.match(/event: content_block_stop/g) ?? []).length;
    assert.equal(stops, starts, "every opened block is closed, including the dead attempt's dangling thinking block");
    assert.ok(
        out.indexOf('"type":"content_block_stop","index":0') < out.indexOf('"type":"content_block_start","index":1'),
        "dangling thinking block closed BEFORE the retry's blocks continue at higher indices",
    );
});

test("#1455 B2: exhausted reasoning-only retries terminate on the protocol-native error channel with all blocks closed", async () => {
    const { out, calls } = await drainAnthropic(REASONING_ONLY_TRUNCATED, [REASONING_ONLY_TRUNCATED], "i1455-b2");
    assert.equal(calls, 1, "one retry, then give up");
    const blocks = sseBlocks(out);
    assert.ok(blocks[blocks.length - 1].startsWith("event: error"), `last event is the error event (got ${blocks[blocks.length - 1].slice(0, 40)})`);
    assert.match(blocks[blocks.length - 1], /"code":"upstream_error"/);
    assert.doesNotMatch(out, /event: message_(stop|delta)/, "no completion event anywhere");
    assert.doesNotMatch(out, /"stop_reason":"end_turn"/, "no synthesized success terminal");
    const starts = (out.match(/event: content_block_start/g) ?? []).length;
    const stops = (out.match(/event: content_block_stop/g) ?? []).length;
    assert.equal(stops, starts, "both attempts' dangling thinking blocks are closed before the error frame");
});

const frames = (list: Array<Record<string, unknown>>): string => list.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
const oaiChunk = (id: string, delta: Record<string, unknown>): Record<string, unknown> => ({
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: null }],
});
const OAI_DONE = "data: [DONE]\n\n";
const ROUND1_OAI_TOOL = frames([
    oaiChunk("cm_1", { role: "assistant", content: "" }),
    oaiChunk("cm_1", { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "acp_status", arguments: "{}" } }] }),
    { id: "cm_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]) + OAI_DONE;

async function drainOpenai(first: string, attempts: string[], id: string): Promise<{ out: string; calls: number }> {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n += 1;
        return new Response(attempts[n - 1] ?? "", { status: 200 });
    }) as typeof fetch;
    const ctx = makeCtx(id);
    (ctx as Record<string, unknown>).protocol = "openai";
    const chunks: Buffer[] = [];
    try {
        for await (const c of runCompressLoop(
            streamOf(first),
            ctx,
            OPENAI_BODY,
            { url: "http://mock", headers: {} },
            createOpenaiAdapter(OPENAI_BODY),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(c);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), calls: n };
}

test("#1455 B: openai wire — exhausted failure terminates with a top-level error frame + [DONE]", async () => {
    const { out, calls } = await drainOpenai(ROUND1_OAI_TOOL, ["", ""], "i1455-oai");
    assert.equal(calls, 2, "one re-request + one retry, then give up");
    assert.ok(out.includes("upstream stream truncated"), "failure visible to the client");
    assert.match(out, /"error":\{"type":"server_error","code":"upstream_error"/);
    assert.match(out, /\[DONE\]/);
    const tail = out.slice(out.lastIndexOf('"error"'));
    assert.doesNotMatch(tail, /finish_reason/, "no fabricated completion after the failure point");
});
