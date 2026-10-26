import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage, Prompts } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { anthropicToCore } from "acp-kernel/wire";
import type { AnthropicRequestBody } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #1960: on Anthropic extended thinking, an in-turn compress re-request rebuilt the
// latest assistant message WITHOUT the redacted_thinking block(s) it contained —
// the block arrives whole in content_block_start and no delta ever carries its
// payload, so nothing was recorded for rebuild. Anthropic rejects a modified latest
// assistant message with 400 "thinking or redacted_thinking blocks ... cannot be
// modified", and every later request re-sends the same lossy shape, stranding the
// session.
//
// Facts these tests pin (verified against the unfixed loop):
//  - a redacted_thinking block emitted between thinking and tool_use replays
//    byte-exact AND position-exact in the re-request's last assistant message;
//  - the plain signed-thinking tail (no redacted block) is unchanged by the
//    ordered-parts restructure (regression guard for #539/#221 behavior);
//  - a 400 whose body matches the "cannot be modified" class skips the degraded
//    strip retry (which can only produce a second guaranteed 400) and surfaces the
//    original upstream error to the client.

type WireMessage = Record<string, unknown>;

const THINKING_TEXT = "I should compress the old turns first before continuing.";
const SIG = "sig-round1-abc123";
const RDT_DATA = "EvAFCkYIBxgCKkBkcm9kdGVkLXRoaW5raW5nLXByb2JlLTE5NjAAAA==";
const COMPRESS_CALL_ID = "toolu_c1960";
const SYSTEM_TEXT = "You are a coding agent.";

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeSession(): Session {
    return {
        id: "issue1960-loop-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100, contextTokens: 100, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        pendingRetrievals: [],
        persisted: false,
    };
}

const BIG = (tag: string) => `${tag}\n${"x".repeat(4000)}`;

// Realistic pi mid-session inbound: prior turn had thinking+sig+real tool_use
// followed by its tool_result; big mid messages leave the two foldables outside
// the kernel's preserve-recent zone; ends with a plain user message.
function inbound(): Record<string, unknown> {
    return {
        model: "claude-sonnet-5",
        stream: true,
        system: SYSTEM_TEXT,
        messages: [
            { role: "user", content: "seed: audit the migration, then answer follow-ups." },
            { role: "assistant", content: [
                { type: "thinking", thinking: "HIST-THINK-A", signature: "sig-hist-a" },
                { type: "text", text: "Let me look at the files." },
                { type: "tool_use", id: "toolu_hist_1", name: "bash", input: { command: "ls -la" } },
            ] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_hist_1", content: "file_a.ts\nfile_b.ts" }] },
            { role: "user", content: BIG("FOLDABLE-ONE") },
            { role: "assistant", content: BIG("OLD-ANSWER") },
            { role: "user", content: BIG("FOLDABLE-TWO") },
            { role: "assistant", content: "short answer A" },
            { role: "user", content: BIG("MID-Q1") },
            { role: "assistant", content: BIG("MID-A1") },
            { role: "user", content: BIG("MID-Q2") },
            { role: "assistant", content: BIG("MID-A2") },
            { role: "user", content: BIG("MID-Q3") },
            { role: "assistant", content: BIG("MID-A3") },
            { role: "user", content: "and now the follow-up question, please continue" },
        ],
    };
}

// Mirror of server.prepareAnthropic: anthropicToCore → processTurn.
function prepare(body: Record<string, unknown>, session: Session) {
    const core = createCore();
    const config = defaultConfig(200000);
    const { msgs } = anthropicToCore(body as AnthropicRequestBody) as { msgs: CoreMessage[] };
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 100, renderTags: "text-only" });
    session.state = turn.state;
    return { core, config, processed: turn.messages, original: msgs };
}

function reFetchProbe(respond: (n: number) => Response): { calls: () => number; bodies: () => string[]; restore: () => void } {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return respond(n);
    }) as typeof fetch;
    return { calls: () => n, bodies: () => bodies, restore: () => { globalThis.fetch = orig; } };
}

const ROUND2_SSE = [
    sse("message_start", { type: "message_start", message: { id: "msg_r2", usage: { input_tokens: 50 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Continued after compression." } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    sse("message_stop", { type: "message_stop" }),
].join("");

// Round 1 shape A: thinking + signature, then a WHOLE redacted_thinking block
// (real Anthropic wire form: full payload in content_block_start, no deltas),
// then the compress tool_use.
function round1Redacted(compressArgs: string): string {
    return [
        sse("message_start", { type: "message_start", message: { id: "msg_r1", usage: { input_tokens: 100 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING_TEXT.slice(0, 20) } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING_TEXT.slice(20) } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIG } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: RDT_DATA } }),
        sse("content_block_stop", { type: "content_block_stop", index: 1 }),
        sse("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: COMPRESS_CALL_ID, name: "compress", input: {} } }),
        sse("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: compressArgs } }),
        sse("content_block_stop", { type: "content_block_stop", index: 2 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
        sse("message_stop", { type: "message_stop" }),
    ].join("");
}

// Round 1 shape B (the common case): thinking + signature, then the compress
// tool_use — no redacted block.
function round1Plain(compressArgs: string): string {
    return [
        sse("message_start", { type: "message_start", message: { id: "msg_r1", usage: { input_tokens: 100 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING_TEXT.slice(0, 20) } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING_TEXT.slice(20) } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIG } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: COMPRESS_CALL_ID, name: "compress", input: {} } }),
        sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: compressArgs } }),
        sse("content_block_stop", { type: "content_block_stop", index: 1 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
        sse("message_stop", { type: "message_stop" }),
    ].join("");
}

async function runLoop(round1: (args: string) => string, respond: (n: number) => Response): Promise<{ out: string; bodies: string[]; calls: number; compressArgs: string }> {
    const session = makeSession();
    const body = inbound();
    const { core, config, processed, original } = prepare(body, session);
    // The loop does not run the kernel ref-assignment pipeline (in production the
    // proxy populates refs before the loop) — mirror issue539's test so the
    // compress range resolves.
    const refMap = assignRefs(processed, { existing: emptyRefMap(), nextIndex: 0 }).map;
    session.state.messageRefs = refMap;
    const refsOf = (needle: string) => Object.entries(refMap.byRaw ?? {})
        .filter(([raw]) => processed.find((x) => x.id === raw)?.text?.includes(needle))
        .map(([, r]) => r);
    const f1 = refsOf("FOLDABLE-ONE")[0];
    const f2 = refsOf("FOLDABLE-TWO")[0];
    assert.ok(f1 && f2, "foldable payloads must resolve to refs");
    const compressArgs = JSON.stringify({ content: [{ startId: f1, endId: f2, summary: "SUMMARY-1960: two large old user payloads and one old answer, all fully consumed by later turns." }] });

    const probe = reFetchProbe(respond);
    let out = "";
    try {
        const adapter = createAnthropicAdapter(body, SYSTEM_TEXT);
        const ctx = {
            core, config,
            messages: processed,
            session,
            log: () => {},
            protocol: "anthropic" as const,
            // Host mirror of server.ts refreshFolded: fresh fold from the ORIGINAL
            // messages with the post-compress state + this round's acp_loop_*
            // records riding on top.
            refreshFolded: (current: CoreMessage[]) => {
                const t = core.processTurn({ messages: original, state: session.state, config, tokenCount: 100, renderTags: "text-only" });
                session.state = t.state;
                const records = current.filter((m) => typeof m.id === "string" && m.id.startsWith("acp_loop_"));
                return [...t.messages, ...records];
            },
        };
        for await (const c of runCompressLoop(new Response(round1(compressArgs), { status: 200 }).body!, ctx, body, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt(config as unknown as Prompts))) {
            out += c.toString("utf8");
        }
    } finally {
        probe.restore();
    }
    return { out, bodies: probe.bodies(), calls: probe.calls(), compressArgs };
}

const okResponse = () => new Response(ROUND2_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });

test("#1960: redacted_thinking replays byte-exact and position-exact on the compress re-request", async () => {
    const { bodies, calls, compressArgs } = await runLoop(round1Redacted, okResponse);
    assert.equal(calls, 1, "exactly one re-request after the compress executes");
    const rb = JSON.parse(bodies[0]) as { messages: WireMessage[] };
    const lastAsst = [...rb.messages].reverse().find((m) => m.role === "assistant") as WireMessage | undefined;
    assert.ok(lastAsst && Array.isArray(lastAsst.content), "re-request must end with the reconstructed assistant message");
    // The exact block order and bytes the real round-1 response carried:
    assert.deepStrictEqual(lastAsst!.content, [
        { type: "thinking", thinking: THINKING_TEXT, signature: SIG },
        { type: "redacted_thinking", data: RDT_DATA },
        { type: "tool_use", id: COMPRESS_CALL_ID, name: "compress", input: JSON.parse(compressArgs) },
    ]);
});

test("#1960 regression guard: plain signed-thinking tail is unchanged by the ordered-parts restructure", async () => {
    const { bodies, calls, compressArgs } = await runLoop(round1Plain, okResponse);
    assert.equal(calls, 1, "exactly one re-request after the compress executes");
    const rb = JSON.parse(bodies[0]) as { messages: WireMessage[] };
    const lastAsst = [...rb.messages].reverse().find((m) => m.role === "assistant") as WireMessage | undefined;
    assert.ok(lastAsst && Array.isArray(lastAsst.content));
    assert.deepStrictEqual(lastAsst!.content, [
        { type: "thinking", thinking: THINKING_TEXT, signature: SIG },
        { type: "tool_use", id: COMPRESS_CALL_ID, name: "compress", input: JSON.parse(compressArgs) },
    ]);
});

test("#1960 recovery: 'cannot be modified' 400 skips the guaranteed-failing strip retry", async () => {
    const rejectBody = JSON.stringify({
        type: "error",
        error: {
            type: "invalid_request_error",
            message: "messages.19.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
        },
    });
    const { out, calls } = await runLoop(round1Plain, (n) =>
        n === 1 ? new Response(rejectBody, { status: 400, headers: { "content-type": "application/json" } }) : okResponse());
    assert.equal(calls, 1, "no degraded strip retry after a 'cannot be modified' rejection");
    assert.ok(out.includes("cannot be modified"), "client sees the original upstream error text");
});
