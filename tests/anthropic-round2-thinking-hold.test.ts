import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import type { LoopCtx } from "../src/loop/core.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// round2-hold: bili's OWN re-request (round ≥ 2) must stay recoverable.
//
// Round 1 belongs to the client: it wrote the request, so after a truncation it
// can replay the whole turn itself — #2501 settled that round by holding each
// thinking start until a payload-bearing delta and then REFUSING the loop's
// re-fetch once an unsigned block reached the wire.
//
// Round ≥ 2 is different. It exists because a proxy tool (compress, acp_status,
// retrieve …) already executed and bili re-requests on the client's behalf. By
// then round 1 has put its own bytes on the client's wire (the `📦 [ACP] …`
// receipt IS an assistant text block), so the client cannot replay that turn —
// its next request would just be the same conversation. Only the loop's blind
// re-fetch can heal a truncated round ≥ 2, and that re-fetch is legitimate only
// while the dead attempt left no stateful bytes.
//
// On a signing upstream an unsigned thinking block IS stateful bytes: the
// client persists it, and the next faithful replay is rejected with 400
// "thinking.signature: Field required", after which Claude Code strips every
// prior thinking block (#2501). So a round-≥2 cut inside a thinking block used
// to be unrecoverable: the block was streamed unsigned, #2501's gate refused
// both re-fetch shapes, and the client got a hard `event: error` for a turn it
// cannot re-drive itself.
//
// The fix: when the upstream is evidenced to sign (`historyHasSignedThinking ||
// sawSignedThinkingThisTurn`, plus self-arming once the parse sees a signature),
// a bili-owned round buffers its thinking payload off the wire. `signature_delta`
// releases start + payload + signature together; a death before that leaves
// nothing behind, so the existing blind re-fetch recovers the turn. A relay that
// never signs has no signature contract to violate, so it keeps streaming live
// (T2 pins that: no perceived-regression for GLM/DeepSeek anthropic-compat).

const SIGNED_HISTORY_BODY = {
    model: "claude",
    stream: true,
    max_tokens: 1000,
    messages: [
        { role: "user", content: "hi" },
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "earlier reasoning", signature: "sig_earlier" },
                { type: "text", text: "ok" },
            ],
        },
        { role: "user", content: "more" },
    ],
};

// Never-signing relay: no signed thinking anywhere in history, and the round-1
// stream below carries no signature either.
const UNSIGNED_BODY = { model: "claude", messages: [], stream: true, max_tokens: 1000 };

function makeCtx(id: string, messages: CoreMessage[] = []): LoopCtx {
    return {
        core: createCore(),
        config: defaultConfig(200000) as Config,
        messages,
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

// Kernel default compress.minCompressRange is 5000 chars: below it compress is
// rejected with "content too small" and no block is created, so round 2 would
// never happen. Mirror tests/issue1453-rerequest-transport.test.ts's layout.
function compressibleMessages(): CoreMessage[] {
    const big = (n: number) => "x".repeat(n);
    return [
        textMsg("u1", "user", big(5000)),
        textMsg("a1", "assistant", big(5000)),
        textMsg("u2", "user", big(5000)),
        textMsg("a2", "assistant", big(5000)),
        textMsg("u3", "user", big(5000)),
        textMsg("a3", "assistant", big(5000)),
        textMsg("u4", "user", big(5000)),
    ];
}

function withRefs(ctx: LoopCtx): LoopCtx {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
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
        id: "msg_r2h", type: "message", role: "assistant", model: "claude",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
    },
});
const textStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
const textDelta = (index: number, text: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
const textBlock = (index: number, text: string) => textStart(index) + textDelta(index, text) + blockStop(index);
const thinkingStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
const thinkingDelta = (index: number, thinking: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } });
const signatureDelta = (index: number, signature: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature } });
const blockStop = (index: number) => ev("content_block_stop", { type: "content_block_stop", index });
const toolUseBlock = (index: number, id: string, name: string, input: string) =>
    ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }) +
    ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: input } }) +
    blockStop(index);
const MESSAGE_DELTA = (stopReason = "end_turn") => ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 3 } });
const MESSAGE_STOP = ev("message_stop", { type: "message_stop" });

const COMPRESS_ARGS = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "S".repeat(80) }] });

function round1WithCompress(opts: { signedThinking: boolean }): string {
    const thinking = opts.signedThinking
        ? thinkingStart(0) + thinkingDelta(0, "planning the fold") + signatureDelta(0, "sig_round1") + blockStop(0)
        : "";
    return [
        MESSAGE_START,
        thinking,
        toolUseBlock(opts.signedThinking ? 1 : 0, "toolu_cmp", "compress", COMPRESS_ARGS),
        MESSAGE_DELTA("tool_use"),
        MESSAGE_STOP,
    ].join("");
}

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

// Claude Code's stream-assembly rule: a delta or stop for a block whose start
// has not been delivered forces a non-streaming fallback.
function assertBlockOrderLegal(s: string): void {
    const open = new Map<number, string>();
    for (const e of parseSse(s)) {
        if (e.type === "content_block_start") {
            const idx = e.data.index as number;
            assert.ok(!open.has(idx), `block ${idx} started twice`);
            open.set(idx, String(((e.data.content_block ?? {}) as Record<string, unknown>).type));
        } else if (e.type === "content_block_delta" || e.type === "content_block_stop") {
            const idx = e.data.index as number;
            assert.ok(open.has(idx), `${e.type} for block ${idx} arrived before its content_block_start`);
            if (e.type === "content_block_stop") open.delete(idx);
        }
    }
}

// A thinking block closed without a signature is invalid client history (#2501).
function assertNoUnsignedThinkingBlock(s: string): void {
    const openThinking = new Map<number, boolean>();
    for (const e of parseSse(s)) {
        if (e.type === "content_block_start") {
            const cb = (e.data.content_block ?? {}) as Record<string, unknown>;
            if (cb.type === "thinking") openThinking.set(e.data.index as number, false);
        } else if (e.type === "content_block_delta") {
            const d = (e.data.delta ?? {}) as Record<string, unknown>;
            if (d.type === "signature_delta" && typeof d.signature === "string" && d.signature.length > 0) {
                const idx = e.data.index as number;
                if (openThinking.has(idx)) openThinking.set(idx, true);
            }
        } else if (e.type === "content_block_stop") {
            const idx = e.data.index as number;
            if (openThinking.has(idx)) {
                assert.equal(openThinking.get(idx), true, `thinking block ${idx} closed WITHOUT a signature — invalid client history`);
                openThinking.delete(idx);
            }
        }
    }
}

function countEvents(s: string, predicate: (e: SseEvent) => boolean): number {
    return parseSse(s).filter(predicate).length;
}

async function drainRound2(
    round1: string,
    attempts: string[],
    id: string,
    body: Record<string, unknown>,
    messages: CoreMessage[] = compressibleMessages(),
): Promise<{ out: string; calls: number }> {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n += 1;
        return new Response(attempts[n - 1] ?? "", { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    const ctx = withRefs(makeCtx(id, messages));
    try {
        for await (const c of runCompressLoop(
            streamOf(round1),
            ctx,
            body,
            { url: "http://mock", headers: {} },
            createAnthropicAdapter(body),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(c);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), calls: n };
}

// Incident shape (2026-10-25): round 1 folds a range and streams the receipt as
// assistant TEXT, then the re-request dies 95 s into a thinking block. Before
// round2-hold this produced `event: error` and the turn was lost.
const DEAD_ROUND2 = [
    MESSAGE_START,
    thinkingStart(0),
    thinkingDelta(0, "ROUND2_HIDDEN_PAYLOAD"),
    thinkingDelta(0, " still hidden"),
].join("");

const GOOD_ROUND2 = [
    MESSAGE_START,
    thinkingStart(0),
    thinkingDelta(0, "ROUND2_VISIBLE_PAYLOAD"),
    signatureDelta(0, "sig_round2"),
    blockStop(0),
    textBlock(1, "recovered"),
    MESSAGE_DELTA(),
    MESSAGE_STOP,
].join("");

test("round2-hold T1: cut inside a round-2 thinking block (history evidence) — nothing unsigned reaches the client, the blind re-fetch recovers the turn", async () => {
    const { out, calls } = await drainRound2(round1WithCompress({ signedThinking: false }), [DEAD_ROUND2, GOOD_ROUND2], "r2h-t1", SIGNED_HISTORY_BODY);

    assert.equal(calls, 2, "the dead round-2 attempt was re-fetched once instead of ending the turn");
    assert.ok(!out.includes("ROUND2_HIDDEN_PAYLOAD"), "the withheld round-2 payload never reached the client wire");
    assert.ok(!/event: error/.test(out), "no client-visible error — the turn recovered");
    assert.ok(out.includes("ROUND2_VISIBLE_PAYLOAD"), "the retried attempt's thinking was delivered");
    assert.ok(out.includes("sig_round2"), "…with its signature");
    assert.ok(out.includes("recovered"), "the retried attempt's answer reached the client");
    assert.ok(out.includes("\u{1F4E6} [ACP] Compressed"), "round 1 still surfaces its receipt on the text channel");
    assert.equal(countEvents(out, (e) => e.type === "message_start"), 1, "exactly one response identity frame across the whole client stream");
    assertBlockOrderLegal(out);
    assertNoUnsignedThinkingBlock(out);
});

test("round2-hold T2: never-signing relay keeps streaming round-2 thinking live (no evidence → no hold, no regression)", async () => {
    // UNSIGNED_BODY: nothing signed in history, and round 1 emits no signature —
    // so the upstream is not evidenced to sign and the payload must NOT be held.
    const dead = [MESSAGE_START, thinkingStart(0), thinkingDelta(0, "RELAY_LIVE_PAYLOAD")].join("");
    const { out, calls } = await drainRound2(round1WithCompress({ signedThinking: false }), [dead, GOOD_ROUND2], "r2h-t2", UNSIGNED_BODY);

    assert.equal(calls, 2, "a relay cut is still re-fetched (it never had signing evidence to bar it)");
    assert.ok(out.includes("RELAY_LIVE_PAYLOAD"), "relay thinking still streams live — no perceived regression");
    assert.ok(out.includes("recovered"), "the retried attempt's answer reached the client");
    assertBlockOrderLegal(out);
});

test("round2-hold T3: a round-2 thinking block that completes with its signature arrives as ONE block, start-first", async () => {
    const complete = [
        MESSAGE_START,
        thinkingStart(0),
        thinkingDelta(0, "alpha-"),
        thinkingDelta(0, "beta-"),
        thinkingDelta(0, "gamma"),
        signatureDelta(0, "sig_round2"),
        blockStop(0),
        textBlock(1, "done"),
        MESSAGE_DELTA(),
        MESSAGE_STOP,
    ].join("");
    const { out, calls } = await drainRound2(round1WithCompress({ signedThinking: false }), [complete], "r2h-t3", SIGNED_HISTORY_BODY);

    assert.equal(calls, 1, "a completed round 2 needs no re-fetch");
    const starts = countEvents(out, (e) => e.type === "content_block_start" && ((e.data.content_block ?? {}) as Record<string, unknown>).type === "thinking");
    assert.equal(starts, 1, "the buffered payload formed exactly one thinking block");
    assert.equal(countEvents(out, (e) => e.type === "content_block_stop" && e.data.index === 0), 1, "and closed once");
    for (const frag of ["alpha-", "beta-", "gamma"]) assert.ok(out.includes(frag), `payload fragment ${frag} preserved`);
    assertBlockOrderLegal(out);
    assertNoUnsignedThinkingBlock(out);
});

test("round2-hold T4: turn-level evidence — a signature seen in round 1 arms the hold for round 2 even when the client's history has none", async () => {
    const { out, calls } = await drainRound2(
        round1WithCompress({ signedThinking: true }),
        [DEAD_ROUND2, GOOD_ROUND2],
        "r2h-t4",
        UNSIGNED_BODY,
    );

    assert.equal(calls, 2, "round 2 was held and re-fetched");
    assert.ok(!out.includes("ROUND2_HIDDEN_PAYLOAD"), "round-2 payload stayed off the wire: round 1 proved this upstream signs");
    assert.ok(out.includes("sig_round1"), "round 1's own signature still reached the client");
    assert.ok(out.includes("recovered"), "turn recovered");
    assert.ok(!/event: error/.test(out), "no client-visible error");
    assertBlockOrderLegal(out);
    assertNoUnsignedThinkingBlock(out);
});
