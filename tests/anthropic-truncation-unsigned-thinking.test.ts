import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import type { LoopCtx } from "../src/loop/core.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #2501: a round-1 truncation during a THINKING block used to hand the client
// an unsigned thinking block: the start frame was forwarded immediately, the
// #413/#1455 blind re-fetch closed it with a bare content_block_stop, and the
// client persisted the signature-less block into its history. Next replay →
// Anthropic 400 "thinking.signature: Field required" → Claude Code strips ALL
// prior thinking from the session permanently ({"type":"thinking_stripped",
// "scope":"all"}) plus a cache break at the strip moment.
//
// Fix pinned here (host-only): (1) the adapter HOLDS each thinking start
// until the first payload-bearing delta (non-empty thinking_delta or
// signature_delta), so a pre-signature truncation is truly invisible to the
// client and the blind re-fetch stays zero-side-effect; (2) when a thinking
// block DID reach the client without its signature AND the upstream signs
// (history or in-attempt evidence), BOTH re-fetch shapes are refused and the
// truncation ends as a client-visible error, so the client discards the whole
// attempt instead of persisting the poisoned block. Never-signing relays keep
// the #1455 behavior (T3).

const UNSIGNED_BODY = { model: "claude", messages: [], stream: true, max_tokens: 10 };
// History-side evidence that the upstream signs: the client replays its
// persisted assistant turns, signed thinking included.
const SIGNED_HISTORY_BODY = {
    model: "claude",
    stream: true,
    max_tokens: 10,
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

const MESSAGE_START = ev("message_start", {
    type: "message_start",
    message: {
        id: "msg_1", type: "message", role: "assistant", model: "claude",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
    },
});
const textStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
const textDelta = (index: number, text: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
const textBlock = (index: number, text: string) => textStart(index) + textDelta(index, text) + blockStop(index);
const thinkingStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
const thinkingDelta = (index: number, thinking: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } });
const emptyThinkingDelta = (index: number) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "" } });
const signatureDelta = (index: number, signature: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature } });
const blockStop = (index: number) => ev("content_block_stop", { type: "content_block_stop", index });
const MESSAGE_DELTA = (stopReason = "end_turn") => ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 3 } });
const MESSAGE_STOP = ev("message_stop", { type: "message_stop" });

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

// Claude Code's stream-assembly rule: a content_block_delta or
// content_block_stop referencing a block whose content_block_start has NOT
// been delivered yet is answered with "Content block not found" and forces a
// non-streaming fallback. Every delta/stop must follow its own start.
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

// A thinking block closed WITHOUT a signature_delta is invalid client history
// — the exact poison #2501 fixes (next replay → 400 Field required).
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

async function drainAnthropic(
    first: string,
    attempts: string[],
    id: string,
    body: Record<string, unknown>,
): Promise<{ out: string; calls: number }> {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n += 1;
        return new Response(attempts[n - 1] ?? "", { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    const ctx = makeCtx(id);
    try {
        for await (const c of runCompressLoop(
            streamOf(first),
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

test("#2501 T1: signature-only thinking truncated before its signature — invisible to the client, blind re-fetch still recovers", async () => {
    // Opus 5.5 shape: nothing — or only EMPTY thinking_deltas — between the
    // start frame and the signature_delta. Truncation lands in that gap.
    const attempt1 = [MESSAGE_START, thinkingStart(0), emptyThinkingDelta(0)].join("");
    const attempt2 = [MESSAGE_START, thinkingStart(0), signatureDelta(0, "sig_abc"), blockStop(0), textBlock(1, "recovered"), MESSAGE_DELTA(), MESSAGE_STOP].join("");
    const { out, calls } = await drainAnthropic(attempt1, [attempt2], "i2501-t1", SIGNED_HISTORY_BODY);
    assert.equal(calls, 1, "the pre-signature truncation stayed zero-side-effect and was re-fetched once");
    assert.ok(out.includes("recovered"), "retried content reached the client");
    assert.ok(!out.includes("upstream stream truncated"), "self-healed: no error surfaced");
    assertBlockOrderLegal(out);
    assertNoUnsignedThinkingBlock(out);
    assert.equal((out.match(/event: content_block_start/g) ?? []).length, 2, "only the retry's blocks (thinking + text) reached the client — the dead attempt's held start was never forwarded");
    assert.equal((out.match(/event: message_start/g) ?? []).length, 1, "single response identity across the stitched stream");
});

test("#2501 T2: forwarded unsigned thinking on a signing upstream (history evidence) — re-fetch refused, error end, all blocks closed", async () => {
    const attempt1 = [MESSAGE_START, thinkingStart(0), thinkingDelta(0, "let me think")].join("");
    const attempt2 = [textBlock(0, "must never arrive"), MESSAGE_DELTA(), MESSAGE_STOP].join("");
    const { out, calls } = await drainAnthropic(attempt1, [attempt2], "i2501-t2", SIGNED_HISTORY_BODY);
    assert.equal(calls, 0, "no re-fetch — an unsigned block on the client wire can never be made valid by one");
    assert.ok(!out.includes("must never arrive"), "the refused re-fetch's response never reached the client");
    assert.ok(out.includes("upstream stream truncated"), "truncation surfaced as the client-visible error");
    assertBlockOrderLegal(out);
    const events = parseSse(out);
    assert.equal(events[events.length - 1].type, "error", "last event is the protocol-native error");
    assert.doesNotMatch(out, /event: message_(stop|delta)/, "no completion frame riding along with the failure");
});

test("#2501 T3: never-signing relay (no evidence anywhere) — #1455 re-fetch behavior retained", async () => {
    const attempt1 = [MESSAGE_START, thinkingStart(0), thinkingDelta(0, "let me think")].join("");
    const attempt2 = [textBlock(0, "recovered"), MESSAGE_DELTA(), MESSAGE_STOP].join("");
    const { out, calls } = await drainAnthropic(attempt1, [attempt2], "i2501-t3", UNSIGNED_BODY);
    assert.equal(calls, 1, "unsigned relay: the blind re-fetch still self-heals (#1455)");
    assert.ok(out.includes("recovered"), "retried content reached the client");
    assert.ok(!out.includes("upstream stream truncated"), "self-healed: no error surfaced");
    assertBlockOrderLegal(out);
    assert.ok(
        out.indexOf("\"type\":\"content_block_stop\",\"index\":0") < out.indexOf("\"type\":\"content_block_start\",\"index\":1"),
        "the dead attempt's dangling thinking block is closed BEFORE the retry's blocks continue at higher indices",
    );
});

test("#2501 T4: empty thinking_deltas before any release — event order stays legal (a naive non-empty-only hold would fail this)", async () => {
    const round = [
        MESSAGE_START,
        thinkingStart(0),
        emptyThinkingDelta(0),
        emptyThinkingDelta(0),
        thinkingDelta(0, "real thought"),
        signatureDelta(0, "sig_x"),
        blockStop(0),
        textBlock(1, "done"),
        MESSAGE_DELTA(),
        MESSAGE_STOP,
    ].join("");
    const { out, calls } = await drainAnthropic(round, [], "i2501-t4", SIGNED_HISTORY_BODY);
    assert.equal(calls, 0, "clean stream — no retry involved");
    assertBlockOrderLegal(out);
    assertNoUnsignedThinkingBlock(out);
    assert.ok(out.includes("real thought"), "payload preserved");
    const firstStart = out.indexOf("event: content_block_start");
    const firstDelta = out.indexOf("event: content_block_delta");
    assert.ok(firstStart > -1 && firstDelta > -1 && firstStart < firstDelta, "the held start must be released before ANY delta reaches the client");
});

test("#2501 T5: visible text THEN unsigned thinking truncation — the CONTINUATION re-fetch is refused too", async () => {
    const attempt1 = [MESSAGE_START, textStart(0), textDelta(0, "partial answer "), thinkingStart(1), thinkingDelta(1, "hmm")].join("");
    const attempt2 = [textBlock(0, "must never arrive"), MESSAGE_DELTA(), MESSAGE_STOP].join("");
    const { out, calls } = await drainAnthropic(attempt1, [attempt2], "i2501-t5", SIGNED_HISTORY_BODY);
    assert.equal(calls, 0, "continuation re-fetch refused — same poisoned-block hazard");
    assert.ok(!out.includes("must never arrive"), "the refused re-fetch's response never reached the client");
    assert.ok(out.includes("partial answer"), "already-forwarded text preserved");
    assert.ok(out.includes("upstream stream truncated"), "truncation surfaced as the client-visible error");
    assertBlockOrderLegal(out);
    const events = parseSse(out);
    assert.equal(events[events.length - 1].type, "error", "last event is the protocol-native error");
    assert.doesNotMatch(out, /event: message_(stop|delta)/, "no completion frame riding along with the failure");
});
