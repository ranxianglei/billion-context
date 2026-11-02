import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #5529: a "fat" Anthropic-compatible relay pads every terminal frame with the
// full schema-shaped key set, unused ones set to null (e.g. message_stop carries
// `delta: null`). The loop collects those unmodeled keys as terminalExtra and the
// synthetic completion spread them AFTER the synthesized `delta`, so `delta: null`
// clobbered the real one and clients crashed reading `event.delta.stop_reason`.
// Pinned here: the synthesized terminal delta is always an object, null padding
// does not ride the wire, and genuine foreign keys still survive (#1766 intact).

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
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 , compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
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

test("#5529 full loop: fat-relay null envelope keys must NOT clobber the synthesized terminal delta", async () => {
    const sse =
        MESSAGE_START +
        textBlock(0, "ok") +
        // Verbatim fat-relay terminal frames from the report: every key present,
        // unused ones set to null; message_stop carries `delta: null`.
        ev("message_delta", {
            type: "message_delta",
            content_block: null,
            delta: { container: null, stop_details: null, stop_reason: "end_turn", stop_sequence: null },
            error: null,
            index: 0,
            message: null,
            usage: { input_tokens: 5, output_tokens: 3 },
        }) +
        ev("message_stop", {
            content_block: null,
            delta: null,
            error: null,
            index: 0,
            message: null,
            type: "message_stop",
        });
    const out = await drain(new Response(sse, { status: 200 }).body!, makeCtx("t5529-fat"));
    const terminals = sseDataBlocks(out, "message_delta");
    assert.equal(terminals.length, 1, "exactly one synthetic terminal frame reaches the client");
    const terminal = terminals[0];
    // THE reported crash: pi-ai reads `event.delta.stop_reason` and threw
    // "Cannot read properties of null (reading 'stop_reason')" when delta was null.
    assert.notEqual(terminal.delta, null, "synthesized terminal delta must not be null");
    assert.equal(typeof terminal.delta, "object", "synthesized terminal delta must be an object");
    assert.equal((terminal.delta as Record<string, unknown>).stop_reason, "end_turn", "final stop_reason survives the clobber-prone path");
    // The null-valued schema padding must not ride the wire either.
    assert.equal(terminal.content_block, undefined, "null content_block padding dropped");
    assert.equal(terminal.message, undefined, "null message padding dropped");
    assert.equal(terminal.error, undefined, "null error padding dropped");
});

test("#5529 parseStream: fat message_stop drops null padding but keeps a genuine foreign key (#1766)", async () => {
    const sse =
        MESSAGE_START +
        textBlock(0, "ok") +
        ev("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: 5, output_tokens: 3 },
        }) +
        // fat message_stop: null padding PLUS one real foreign key.
        ev("message_stop", {
            type: "message_stop",
            content_block: null,
            delta: null,
            error: null,
            index: 0,
            message: null,
            safeguard_results: SAFEGUARDS,
        });
    const adapter = createAnthropicAdapter(ANTHROPIC_BODY);
    const events: ParsedStreamEvent[] = [];
    for await (const e of adapter.parseStream(new Response(sse, { status: 200 }).body!, 1)) events.push(e);
    const done = [...events].reverse().find((e) => e.kind === "done");
    if (!done || done.kind !== "done") assert.fail("no done event emitted");
    const te = done.terminalExtra ?? {};
    assert.ok(!("delta" in te), "a null delta must never ride as a terminalExtra (the crash vector)");
    for (const k of ["content_block", "message", "error"]) assert.ok(!(k in te), `null ${k} padding dropped`);
    assert.deepEqual(te.safeguard_results, SAFEGUARDS, "genuine foreign key still rides the terminal (#1766 preserved)");
});
