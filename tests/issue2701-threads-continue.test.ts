import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import type { LoopCtx } from "../src/loop/core.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { readThreadTail, recordThreadTail, resetThreadTailTracking, rewriteInboundThreadContinue } from "../src/server/thread-tracking.ts";

// #2701: Anthropic Threads continue-turns. The conversation lives server-side
// behind `thread.previous_message_id`; the request body carries only this
// turn's delta messages. bili's compress loop consumes the client's continue
// target with its internal round-2 fetch — the legacy full-rebuild re-request
// re-sent that consumed target and died with upstream 400:
//   "The requested `previous_message_id` has already been continued. Each
//    response `id` may be continued at most once; continue from the ..."
// Fix under test: (1) re-requests continue from the LATEST observed upstream
// response id, (2) send only the loop's own additions since the last accepted
// send (tool results; NOT visibility markers), (3) every other body byte
// identical to round 1 (thread fingerprint: system/tools drift = the class-2
// 400s), (4) response ids persisted to session.metadata so an inbound
// continue targeting a proxy-consumed id is rewritten to the tail, and (5) the
// final terminal frame reports the tail id so the client's next continue is
// valid without a rewrite. Thread CREATE turns keep the legacy full rebuild.

function makeCtx(id: string): LoopCtx {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        } as Session,
        log: () => {},
        protocol: "anthropic",
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

const messageStart = (id: string) => ev("message_start", {
    type: "message_start",
    message: {
        id, type: "message", role: "assistant", model: "claude",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
    },
});
const blockStop = (index: number) => ev("content_block_stop", { type: "content_block_stop", index });
const toolUseBlock = (index: number, callId: string, name: string, args: string) =>
    ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: callId, name, input: {} } }) +
    ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args } }) +
    blockStop(index);
const textBlock = (index: number, text: string) =>
    ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }) +
    blockStop(index);
const messageDelta = (stopReason: string) => ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 3 } });
const messageStop = ev("message_stop", { type: "message_stop" });

// A realistic CC threads-continue body: system + tools fingerprint fields and
// a 1-message delta (the tool_result answering the PREVIOUS turn's tool_use).
const CLIENT_SYSTEM = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }];
const CLIENT_TOOLS = [{ name: "Bash", description: "Executes a given bash command.", input_schema: { type: "object", properties: {}, required: [] } }];
const clientContinueBody = (): Record<string, unknown> => ({
    model: "claude-sonnet-4-5",
    stream: true,
    max_tokens: 1024,
    system: CLIENT_SYSTEM,
    tools: CLIENT_TOOLS,
    thread: { type: "continue", previous_message_id: "msg_prev" },
    messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_prev", content: "ok" }] },
    ],
});

interface SseEvent { type: string; data: Record<string, unknown>; }
function parseSse(s: string): SseEvent[] {
    const out: SseEvent[] = [];
    for (const block of s.split("\n\n")) {
        if (!block.trim()) continue;
        let type = "";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!type) continue;
        const jsonStr = dataLines.join("\n").trim();
        out.push({ type, data: jsonStr ? (JSON.parse(jsonStr) as Record<string, unknown>) : {} });
    }
    return out;
}

async function drain(
    round1: string,
    ctx: LoopCtx,
    requestBody: Record<string, unknown>,
    fetchImpl: typeof fetch,
): Promise<string> {
    const chunks: Buffer[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    const adapter = createAnthropicAdapter(requestBody);
    try {
        for await (const chunk of runCompressLoop(
            streamOf(round1),
            ctx,
            requestBody,
            { url: "http://mock", headers: {} },
            adapter,
            buildCompressSystemPrompt(),
        )) {
            chunks.push(chunk);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return Buffer.concat(chunks).toString("utf8");
}

test("threads-continue: re-request continues from round-1 id, delta-only messages, fingerprint-stable, ids persisted, terminal id = tail", async () => {
    const ctx = makeCtx("t2701-main");
    const body = clientContinueBody();
    // Round 1: proxy tool call (acp_status) — executed by the loop, answered
    // in the re-request. Round 2: final text.
    const round1 = messageStart("msg_r1") + toolUseBlock(0, "toolu_1", "acp_status", "{}") + messageDelta("tool_use") + messageStop;
    const round2 = messageStart("msg_r2") + textBlock(0, "all done") + messageDelta("end_turn") + messageStop;

    const fetchBodies: Record<string, unknown>[] = [];
    const out = await drain(round1, ctx, body, (async (_input: unknown, init?: { body?: unknown }) => {
        const b = JSON.parse(String(init?.body));
        fetchBodies.push(b as Record<string, unknown>);
        return new Response(round2, { status: 200 });
    }) as typeof fetch);

    assert.equal(fetchBodies.length, 1, "exactly one re-request after the proxy tool round");

    const reReq = fetchBodies[0]!;
    // (1) continue target = round-1's response id, NOT the client's msg_prev
    assert.deepEqual(reReq.thread, { type: "continue", previous_message_id: "msg_r1" }, "re-request continues from round-1's upstream response id");

    // (2) delta-only: exactly one user message holding the tool_result; no
    // visibility-marker text (markers are client noise, kept out of the
    // server-side thread), no replayed history, no assistant tool_use.
    const messages = reReq.messages as { role: string; content: unknown }[];
    assert.equal(messages.length, 1, "thread re-request is delta-shaped (single message)");
    assert.equal(messages[0]!.role, "user");
    const content = messages[0]!.content as { type: string; tool_use_id?: string; content?: unknown }[];
    assert.equal(content.length, 1, "only the tool_result block rides the delta");
    assert.equal(content[0]!.type, "tool_result");
    assert.equal(content[0]!.tool_use_id, "toolu_1");
    assert.ok(typeof content[0]!.content === "string" && (content[0]!.content as string).length > 0, "tool_result carries the acp_status result text");

    // (3) fingerprint: system and tools byte-identical to round 1's body
    assert.deepEqual(reReq.system, CLIENT_SYSTEM, "system unchanged (thread fingerprint)");
    assert.deepEqual(reReq.tools, CLIENT_TOOLS, "tools unchanged (thread fingerprint)");

    // (4) both observed ids persisted: round-1's rolled into consumed, tail = final
    const tracking = readThreadTail(ctx.session);
    assert.deepEqual(tracking, { tail: "msg_r2", consumed: ["msg_r1"] }, "session metadata records consumed ids and the final tail");

    // (5) the terminal message_delta reports the TAIL id — the client pairs
    // its next continue off the id it last saw.
    const deltas = parseSse(out).filter((e) => e.type === "message_delta");
    assert.ok(deltas.length > 0, "terminal message_delta present");
    assert.equal(deltas[deltas.length - 1]!.data.id, "msg_r2", "terminal frame carries the latest upstream response id");
});

test("threads-continue: truncation BEFORE any response id — blind retry stays legal (byte-identical re-send)", async () => {
    const ctx = makeCtx("t2701-blind-safe");
    const body = clientContinueBody();
    // Round 1: stream closes with NO message_start (connection died before
    // the response began) → the continue target msg_prev is unconsumed.
    const round1 = "";
    const round2 = messageStart("msg_r2") + textBlock(0, "ok") + messageDelta("end_turn") + messageStop;

    const fetchBodies: Record<string, unknown>[] = [];
    const out = await drain(round1, ctx, body, (async (_input: unknown, init?: { body?: unknown }) => {
        const b = JSON.parse(String(init?.body));
        fetchBodies.push(b as Record<string, unknown>);
        return new Response(round2, { status: 200 });
    }) as typeof fetch);

    assert.equal(fetchBodies.length, 1, "blind truncation retry fired");
    assert.deepEqual(fetchBodies[0]!.thread, { type: "continue", previous_message_id: "msg_prev" }, "re-send keeps the unconsumed client target");
    assert.deepEqual(fetchBodies[0]!.messages, body.messages, "re-send is byte-identical (roundBody replay)");
    assert.ok(out.includes("ok"), "retry's answer reached the client");
    assert.equal(readThreadTail(ctx.session)?.tail, "msg_r2");
});

test("threads-continue: truncation AFTER the response started — blind re-send barred (target consumed)", async () => {
    const ctx = makeCtx("t2701-blind-unsafe");
    const body = clientContinueBody();
    // Round 1: message_start arrives (target msg_prev consumed upstream),
    // then the stream dies with no completion and nothing visible.
    const round1 = messageStart("msg_r1");

    let fetchCalls = 0;
    const out = await drain(round1, ctx, body, (async () => {
        fetchCalls++;
        return new Response("", { status: 200 });
    }) as typeof fetch);

    assert.equal(fetchCalls, 0, "no re-fetch of the consumed continue target (would 400: already continued)");
    assert.ok(out.includes("acp-proxy"), "turn ends as a client-visible error instead of a dead re-fetch");
});

test("threads-create: legacy full-rebuild path preserved (fold delivery channel)", async () => {
    const ctx = makeCtx("t2701-create");
    // In the relay flow ctx.messages = prepared.processedMessages — the kernel
    // view of the client's turn messages. Seed it like a real create turn.
    ctx.messages.push({ id: "orig_1", role: "user", contentType: "text", text: "please continue the work" });
    const body = {
        ...clientContinueBody(),
        thread: { type: "create" },
        messages: [{ role: "user", content: "please continue the work" }],
    };
    const round1 = messageStart("msg_c1") + toolUseBlock(0, "toolu_1", "acp_status", "{}") + messageDelta("tool_use") + messageStop;
    const round2 = messageStart("msg_c2") + textBlock(0, "done") + messageDelta("end_turn") + messageStop;

    const fetchBodies: Record<string, unknown>[] = [];
    const out = await drain(round1, ctx, body, (async (_input: unknown, init?: { body?: unknown }) => {
        const b = JSON.parse(String(init?.body));
        fetchBodies.push(b as Record<string, unknown>);
        return new Response(round2, { status: 200 });
    }) as typeof fetch);

    assert.equal(fetchBodies.length, 1);
    const reReq = fetchBodies[0]!;
    assert.deepEqual(reReq.thread, { type: "create" }, "create turns keep the full-rebuild re-request (thread unchanged)");
    const messages = reReq.messages as { role: string; content: unknown }[];
    assert.ok(messages.length >= 3, `legacy rebuild replays the full view (got ${messages.length} messages, not a 1-message delta)`);
    assert.ok(out.includes("done"));
});

test("thread-tracking unit: roll, cap, rewrite, reset", () => {
    const session = { metadata: {} } as Session;
    assert.equal(readThreadTail(session), undefined);

    recordThreadTail(session, "a");
    assert.deepEqual(readThreadTail(session), { tail: "a", consumed: [] });
    recordThreadTail(session, "b");
    assert.deepEqual(readThreadTail(session), { tail: "b", consumed: ["a"] });
    recordThreadTail(session, "b"); // idempotent
    assert.deepEqual(readThreadTail(session), { tail: "b", consumed: ["a"] });

    for (let i = 0; i < 30; i++) recordThreadTail(session, `id_${i}`);
    const t = readThreadTail(session)!;
    assert.equal(t.tail, "id_29");
    assert.ok(t.consumed.length <= 20, `consumed capped (got ${t.consumed.length})`);

    // rewrite: consumed target → tail; unknown target → untouched
    const logs: string[] = [];
    const log = (_l: string, m: string) => logs.push(m);
    const consumedBody = { thread: { type: "continue", previous_message_id: "id_28" } };
    rewriteInboundThreadContinue(consumedBody, session, log, "s1");
    assert.equal((consumedBody.thread as { previous_message_id: string }).previous_message_id, "id_29", "consumed target rewritten to the tracked tail");
    assert.ok(logs.some((l) => l.includes("#2701")), "rewrite logs with the issue tag");

    const unknownBody = { thread: { type: "continue", previous_message_id: "msg_from_elsewhere" } };
    rewriteInboundThreadContinue(unknownBody, session, log, "s1");
    assert.equal((unknownBody.thread as { previous_message_id: string }).previous_message_id, "msg_from_elsewhere", "unknown ids are passed through untouched");

    const noThread: { thread?: unknown } & Record<string, unknown> = { model: "claude" };
    rewriteInboundThreadContinue(noThread, session, log, "s1");
    assert.equal(noThread.thread, undefined);

    // create resets tracking
    const createBody = { thread: { type: "create" } };
    rewriteInboundThreadContinue(createBody, session, log, "s1");
    assert.equal(readThreadTail(session), undefined, "create resets tail tracking");

    resetThreadTailTracking(session);
    assert.equal(readThreadTail(session), undefined);
});
