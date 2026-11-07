import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import type { LoopCtx } from "../src/loop/core.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #4679: a cut inside bili's OWN re-request round (round >= 2, i.e. after a proxy
// tool such as `compress` committed work and bili re-requested) lost the whole
// turn UNRECOVERABLY on an Anthropic-format upstream that SIGNS thinking blocks:
// the round-2 thinking deltas streamed to the client live, the socket died before
// the signature_delta arrived, the client persisted an UNSIGNED thinking block,
// and #2501's `unsignedThinkingBarsRefetch` correctly barred the only re-fetch
// that could have healed it (a signed block arriving later WOULD be legal history)
// → terminal error, user loses the turn and pays twice.
//
// Why it is specific to round >= 2: in round 1 the CLIENT owns the turn, so refusing
// the re-fetch hands the client an actionable error (it can replay). In round >= 2
// bili owns the turn (hard error, nothing to replay) — but bili itself can re-fetch
// its own request. The fix makes bili's OWN rounds replay-safe: when there is
// EVIDENCE the upstream signs (signed history OR an earlier round produced a
// signature), the round >= 2 adapter HOLDS the thinking block OFF the wire until
// its signature arrives. A pre-signature cut then leaves ZERO client state, so the
// existing #413 blind re-fetch fires and heals. A signed block is flushed to the
// wire atomically (start + payload + signature together); a signature-less close is
// discarded. Nothing in #2501 changes — round-1 behavior and the bar are intact.
//
// Residual hole (honest, matches the issue): an upstream that signs but offers no
// evidence yet (no signed history AND no earlier-round signature) keeps the old
// live-streaming behavior for that one round — detecting it would force holding
// every relay's thinking to block end, a latency regression GLM/DeepSeek-class
// relays cannot take.

const UNSIGNED_BODY = { model: "claude", messages: [], stream: true, max_tokens: 10 };
// History-side evidence that the upstream signs: the client replays its persisted
// assistant turns, signed thinking included.
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

function makeAnthropicCtx(messages: CoreMessage[]): LoopCtx {
    return {
        core: createCore(),
        config: defaultConfig(200000) as Config,
        messages,
        session: {
            id: "i4679",
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

// The compress loop does not run the kernel's ref-assignment pipeline (the proxy
// runs processTurn once per client turn, BEFORE the loop). To create a REAL block,
// the ref map must be pre-populated — otherwise resolveBoundaries finds nothing.
function withRefs(ctx: LoopCtx): LoopCtx {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

// Kernel default compress.minCompressRange is 5000 chars; ranges below that are
// rejected and create NO block. Use big text so a real active block is created.
function bigText(n: number): string {
    return "x".repeat(n);
}

// Seven big messages: the kernel protects the LAST 5, so m00001/m00002 are
// compressible — a real successful compress commits work and forces a round-2
// re-request (exactly the incident's shape).
function sevenBigCtx(): LoopCtx {
    return withRefs(makeAnthropicCtx([
        textMsg("raw_1", "user", bigText(5000)),
        textMsg("raw_2", "assistant", bigText(5000)),
        textMsg("raw_3", "user", bigText(5000)),
        textMsg("raw_4", "assistant", bigText(5000)),
        textMsg("raw_5", "user", bigText(5000)),
        textMsg("raw_6", "assistant", bigText(5000)),
        textMsg("raw_7", "user", bigText(5000)),
    ]));
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
const textStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
const textDelta = (index: number, text: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
const textBlock = (index: number, text: string) => textStart(index) + textDelta(index, text) + blockStop(index);
const thinkingStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
const thinkingDelta = (index: number, thinking: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } });
const signatureDelta = (index: number, signature: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature } });
const toolUseStart = (index: number, id: string, name: string) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
const inputJsonDelta = (index: number, partial: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partial } });
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

// Claude Code's stream-assembly rule: a content_block_delta or content_block_stop
// referencing a block whose content_block_start has NOT been delivered yet is
// answered with "Content block not found". Every delta/stop must follow its own start.
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

// A thinking block closed WITHOUT a signature_delta is invalid client history —
// the exact poison #2501 fixes (next replay → 400 Field required).
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

// Round 1 is the `first` stream (an initial-response ReadableStream); every
// re-request / re-fetch is a mocked globalThis.fetch returning attempts[n-1].
async function drain(
    first: string,
    attempts: string[],
    ctx: LoopCtx,
    body: Record<string, unknown>,
): Promise<{ out: string; calls: number }> {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n += 1;
        return new Response(attempts[n - 1] ?? "", { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
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

// Round 1: a successful `compress` tool call (Anthropic tool_use shape) over the
// seven big messages → commits a real block → bili re-requests round 2.
const COMPRESS_ARGS = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "PAIR-SUMMARY-PAYLOAD-THAT-IS-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
function round1Compress(): string {
    return [
        messageStart("msg_r1"),
        toolUseStart(0, "toolu_c", "compress"),
        inputJsonDelta(0, COMPRESS_ARGS),
        blockStop(0),
        MESSAGE_DELTA("tool_use"),
        MESSAGE_STOP,
    ].join("");
}

test("#4679 T1: history-evidence signing upstream — round-2 thinking cut before its signature is held off the wire, blind re-fetch heals (was: unrecoverable)", async () => {
    // The incident: round 1 compresses (~120k ctx), round 2 streams a long
    // thinking block, the socket dies mid-thinking before the signature arrives.
    const attempt1 = [messageStart("msg_r2"), thinkingStart(0), thinkingDelta(0, "let me reason "), thinkingDelta(0, "about the fold")].join("");
    const attempt2 = [messageStart("msg_r2"), thinkingStart(0), thinkingDelta(0, "let me reason "), thinkingDelta(0, "about the fold"), signatureDelta(0, "sig_r2"), blockStop(0), textBlock(1, "done-after-retry"), MESSAGE_DELTA(), MESSAGE_STOP].join("");
    const { out, calls } = await drain(round1Compress(), [attempt1, attempt2], sevenBigCtx(), SIGNED_HISTORY_BODY);
    // On master: the unsigned round-2 thinking hit the wire, #2501 barred the
    // re-fetch, the turn ended in a hard error (calls == 1, no recovery).
    assert.equal(calls, 2, "the held round-2 attempt left zero client state, so the blind re-fetch fired and recovered");
    assert.ok(out.includes("done-after-retry"), "the retried round-2 content reached the client");
    assert.ok(!out.includes("upstream stream truncated"), "self-healed: no error surfaced");
    assertBlockOrderLegal(out);
    assertNoUnsignedThinkingBlock(out);
});

test("#4679 T2: never-signing relay (no evidence anywhere) — round-2 thinking still streams live, #1455 blind re-fetch retained (no regression)", async () => {
    // No signed history AND no earlier-round signature → no evidence → the hold is
    // NOT armed. Round-2 thinking streams live exactly as today; a pre-signature cut
    // is healed by the blind re-fetch (the dead block is closed before the retry).
    const attempt1 = [messageStart("msg_r2"), thinkingStart(0), thinkingDelta(0, "let me think")].join("");
    const attempt2 = [textBlock(0, "recovered-relay"), MESSAGE_DELTA(), MESSAGE_STOP].join("");
    const { out, calls } = await drain(round1Compress(), [attempt1, attempt2], sevenBigCtx(), UNSIGNED_BODY);
    // Two fetches: the round-2 RE-REQUEST after round-1's compress committed, then
    // the BLIND RE-FETCH of the cut round-2 attempt. (Round 1 itself is the initial
    // stream, not a fetch.) The relay self-heals exactly as today.
    assert.equal(calls, 2, "unsigned relay: round-2 re-request + blind re-fetch both fired, no error end");
    assert.ok(out.includes("recovered-relay"), "retried content reached the client");
    assert.ok(!out.includes("upstream stream truncated"), "self-healed: no error surfaced");
    assertBlockOrderLegal(out);
    assert.ok(
        out.indexOf('"type":"content_block_stop","index":0') < out.indexOf('"type":"content_block_start","index":1'),
        "the dead attempt's dangling thinking block is closed BEFORE the retry's blocks continue at higher indices",
    );
});

test("#4679 T3: turn-level evidence — round 1 signs its own thinking, arming round 2 (no history evidence needed)", async () => {
    // A FRESH session whose round 1 signs its thinking: the loop records the
    // signature turn-wide (sawSignedThinkingThisTurn), so round 2's thinking is held
    // even though the request body carries no signed history. On master the round-2
    // thinking streamed live and landed on the wire unsigned (poison).
    const round1 = [
        messageStart("msg_r1"),
        thinkingStart(0),
        thinkingDelta(0, "kickoff reasoning"),
        signatureDelta(0, "sig_r1"),
        blockStop(0),
        toolUseStart(1, "toolu_c", "compress"),
        inputJsonDelta(1, COMPRESS_ARGS),
        blockStop(1),
        MESSAGE_DELTA("tool_use"),
        MESSAGE_STOP,
    ].join("");
    const attempt1 = [messageStart("msg_r2"), thinkingStart(0), thinkingDelta(0, "follow-up reasoning ")].join("");
    const attempt2 = [messageStart("msg_r2"), thinkingStart(0), thinkingDelta(0, "follow-up reasoning "), signatureDelta(0, "sig_r2"), blockStop(0), textBlock(1, "done-turn-evidence"), MESSAGE_DELTA(), MESSAGE_STOP].join("");
    const { out, calls } = await drain(round1, [attempt1, attempt2], sevenBigCtx(), UNSIGNED_BODY);
    assert.equal(calls, 2, "turn-level evidence armed the round-2 hold; the cut left zero client state and the blind re-fetch healed");
    assert.ok(out.includes("done-turn-evidence"), "the retried round-2 content reached the client");
    assert.ok(!out.includes("upstream stream truncated"), "self-healed: no error surfaced");
    assertBlockOrderLegal(out);
    assertNoUnsignedThinkingBlock(out);
});
