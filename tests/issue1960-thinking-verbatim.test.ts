import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage, Prompts } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { anthropicToCore } from "acp-kernel/wire";
import type { AnthropicRequestBody } from "acp-kernel/wire";
import { createGoogleAdapter, runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import type { Session } from "../src/session.ts";

// #1960 (filter variant): signed thinking/thought text must NEVER be filtered.
// Anthropic's thinking blocks and Gemini's thoughtSignature parts are verified
// byte-for-byte when the latest assistant message is replayed, and the bytes the
// proxy forwards to the client become the client's persisted history — so a
// #1881/#1882-style tag/marker strip on the thinking channel desynchronizes the
// text from its signature and bricks the session (first on the in-turn
// re-request, then on every subsequent request via the client's echo). These
// tests pin: thinking that quotes a render tag AND a marker line rides the
// re-request and the client-visible stream VERBATIM, on both signed wires.

const TAG = "\x3cacp tokens=\"2\" type=\"text\"\x3em00176\x3c/acp\x3e";
const THINKING_TEXT = `Plan: the old turns ${TAG} are stale; the marker line below is quoted too.\n[ACP] Compressed m00176\u2013m00177 (shrink 20%)\nI will call compress now.`;
const SIG = "sig-verbatim-1960";
const COMPRESS_CALL_ID = "toolu_c1960f";
const SYSTEM_TEXT = "You are a coding agent.";

function sseEv(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function gSse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeSession(): Session {
    return {
        id: "issue1960-verbatim-test",
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

function inbound(): Record<string, unknown> {
    return {
        model: "claude-sonnet-5",
        stream: true,
        system: SYSTEM_TEXT,
        messages: [
            { role: "user", content: "seed: audit the migration, then answer follow-ups." },
            { role: "user", content: BIG("FOLDABLE-ONE") },
            { role: "assistant", content: BIG("OLD-ANSWER") },
            { role: "user", content: BIG("FOLDABLE-TWO") },
            { role: "assistant", content: "short answer A" },
            { role: "user", content: BIG("MID-Q1") },
            { role: "assistant", content: BIG("MID-A1") },
            { role: "user", content: BIG("MID-Q2") },
            { role: "assistant", content: BIG("MID-A2") },
            { role: "user", content: "and now the follow-up question, please continue" },
        ],
    };
}

function prepare(body: Record<string, unknown>, session: Session) {
    const core = createCore();
    const config = defaultConfig(200000);
    const { msgs } = anthropicToCore(body as AnthropicRequestBody) as { msgs: CoreMessage[] };
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 100, renderTags: "text-only" });
    session.state = turn.state;
    return { core, config, processed: turn.messages, original: msgs };
}

const ROUND2_SSE = [
    sseEv("message_start", { type: "message_start", message: { id: "msg_r2", usage: { input_tokens: 50 } } }),
    sseEv("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sseEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Continued after compression." } }),
    sseEv("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEv("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    sseEv("message_stop", { type: "message_stop" }),
].join("");

function round1(compressArgs: string): string {
    // Thinking quotes a render tag AND a full marker line — exactly the shapes
    // the #1881/#1882 filters strip. With the filter removed the text must
    // arrive whole on both the client stream and the re-request rebuild.
    return [
        sseEv("message_start", { type: "message_start", message: { id: "msg_r1", usage: { input_tokens: 100 } } }),
        sseEv("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sseEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING_TEXT.slice(0, 30) } }),
        sseEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING_TEXT.slice(30) } }),
        sseEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIG } }),
        sseEv("content_block_stop", { type: "content_block_stop", index: 0 }),
        sseEv("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: COMPRESS_CALL_ID, name: "compress", input: {} } }),
        sseEv("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: compressArgs } }),
        sseEv("content_block_stop", { type: "content_block_stop", index: 1 }),
        sseEv("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
        sseEv("message_stop", { type: "message_stop" }),
    ].join("");
}

async function runLoop(): Promise<{ out: string; bodies: string[]; calls: number; compressArgs: string }> {
    const session = makeSession();
    const body = inbound();
    const { core, config, processed, original } = prepare(body, session);
    const refMap = assignRefs(processed, { existing: emptyRefMap(), nextIndex: 0 }).map;
    session.state.messageRefs = refMap;
    const refsOf = (needle: string) => Object.entries(refMap.byRaw ?? {})
        .filter(([raw]) => processed.find((x) => x.id === raw)?.text?.includes(needle))
        .map(([, r]) => r);
    const f1 = refsOf("FOLDABLE-ONE")[0];
    const f2 = refsOf("FOLDABLE-TWO")[0];
    assert.ok(f1 && f2, "foldable payloads must resolve to refs");
    const compressArgs = JSON.stringify({ content: [{ startId: f1, endId: f2, summary: "SUMMARY-1960F: two large old user payloads and one old answer, all fully consumed by later turns." }] });

    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return new Response(ROUND2_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let out = "";
    try {
        const adapter = createAnthropicAdapter(body, SYSTEM_TEXT);
        const ctx = {
            core, config,
            messages: processed,
            session,
            log: () => {},
            protocol: "anthropic" as const,
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
        globalThis.fetch = orig;
    }
    return { out, bodies, calls: n, compressArgs };
}

test("#1960 anthropic: signed thinking that quotes a render tag + marker line replays VERBATIM on the re-request", async () => {
    const { bodies, calls, compressArgs } = await runLoop();
    assert.equal(calls, 1, "exactly one re-request after the compress executes");
    const rb = JSON.parse(bodies[0]) as { messages: Array<{ role: string; content: unknown }> };
    const lastAsst = [...rb.messages].reverse().find((m) => m.role === "assistant");
    assert.ok(lastAsst && Array.isArray(lastAsst.content), "re-request must end with the reconstructed assistant message");
    const thinking = (lastAsst.content as Array<Record<string, unknown>>).find((b) => b.type === "thinking");
    assert.ok(thinking, "thinking block present on the re-request");
    assert.equal(thinking!.thinking, THINKING_TEXT, "thinking text byte-identical to the model's original (tag AND marker line intact)");
    assert.equal(thinking!.signature, SIG, "signature unchanged");
    const toolUse = (lastAsst.content as Array<Record<string, unknown>>).find((b) => b.type === "tool_use");
    assert.ok(toolUse && toolUse.id === COMPRESS_CALL_ID, "compress tool_use still replayed");
    assert.deepEqual(toolUse!.input, JSON.parse(compressArgs), "tool_use arguments intact");
});

// Reassemble the thinking text the CLIENT would reconstruct from the stitched
// stream: pull every thinking_delta payload out of the forwarded SSE frames.
function clientThinking(out: string): string {
    let text = "";
    for (const m of out.matchAll(/data: (\{[^\n]*\})\n/g)) {
        try {
            const obj = JSON.parse(m[1]!) as { delta?: { type?: string; thinking?: string } };
            if (obj.delta?.type === "thinking_delta" && typeof obj.delta.thinking === "string") text += obj.delta.thinking;
        } catch {
            // non-JSON frames are irrelevant here
        }
    }
    return text;
}

test("#1960 anthropic: the client-visible stream carries the SAME verbatim thinking bytes", async () => {
    const { out } = await runLoop();
    // The stitched client stream forwards the round-1 thinking deltas raw; if
    // the filter were still in place these bytes would be gone (the tag and the
    // marker line stripped) and the client's persisted history would diverge
    // from the signature forever. The client reassembles the deltas, so the
    // reassembled text is the fidelity that matters.
    assert.equal(clientThinking(out), THINKING_TEXT, "client-visible thinking bytes reassemble to the model's original text");
});

test("#1960 google: thought parts quoting a render tag reach reasoning VERBATIM with their signature", async () => {
    const gThought = `Plan: fold ${TAG} now.`;
    const adapter = createGoogleAdapter({}, undefined, undefined, "gemini-3-pro-preview");
    let deltas = "";
    let signature: string | undefined;
    let rawText = "";
    for await (const ev of adapter.parseStream(new Response(
        gSse({ candidates: [{ content: { role: "model", parts: [{ thought: true, text: gThought, thoughtSignature: "sig-g-1960" }] }, index: 0 }] }) +
        gSse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
        { status: 200 }).body!, 1)) {
        if (ev.kind === "reasoning") {
            deltas += ev.delta;
            if (ev.signature) signature = (signature ?? "") + ev.signature;
            if (ev.raw) rawText += ev.raw.toString("utf8");
        }
    }
    assert.equal(deltas, gThought, "thought text unfiltered");
    assert.equal(signature, "sig-g-1960", "thoughtSignature rides the event");
    assert.ok(rawText.includes("acp tokens="), "client-visible raw frame carries the verbatim thought bytes (JSON-escaped inside the frame)");
});
