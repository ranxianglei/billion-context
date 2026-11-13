// #3926: gateways that stamp EVERY chunk with `tool_calls: []` (WorkBuddy /
// DeepSeek-family private deployments) routed every frame into the tool-frame
// branch of the openai adapter: text events lost their raw passthrough, core
// forwarded nothing in round 1, and the settle-time prose rescue (#1881/#1882)
// early-returned because an empty array absorbs no pending entries — ALL
// round-1 text was silently dropped while finish_reason/usage looked healthy.
// Pins: an empty array takes the normal text path (raw passthrough, exact-once,
// no fabricated tool calls); a NON-empty array keeps the tool-frame path
// (gate negative row).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Config, CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { createOpenaiAdapter, runCompressLoop } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import type { CompressLoopAdapter, ParsedStreamEvent } from "../src/loop/index.ts";
import type { WireProtocol } from "../src/util.ts";

async function collect(adapter: CompressLoopAdapter, body: string): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(new Response(body, { status: 200 }).body!, 1)) events.push(ev);
    return events;
}

// Everything that reaches the client: raw payloads on structured events plus
// whole-frame chunks on meta events.
function clientBytes(events: ParsedStreamEvent[]): string {
    return events.map((e) => {
        const b = e as { raw?: Buffer; chunk?: Buffer };
        return (b.raw ?? b.chunk)?.toString("utf8") ?? "";
    }).join("");
}

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// WorkBuddy upstream shape (#3926 evidence): every delta carries an EMPTY
// tool_calls array plus empty sibling fields.
const wbDelta = (content: string, extra: Record<string, unknown> = {}) => ({
    content,
    reasoning_content: "",
    function_call: null,
    refusal: "",
    tool_calls: [],
    extra_fields: null,
    ...extra,
});

test("#3926 openai: empty tool_calls chunks stream their round-1 text to the client", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events = await collect(
        adapter,
        sse({ choices: [{ index: 0, delta: wbDelta("", { role: "assistant" }), finish_reason: null }] }) +
            sse({ choices: [{ index: 0, delta: wbDelta("9"), finish_reason: null }] }) +
            sse({ choices: [{ index: 0, delta: wbDelta("+"), finish_reason: null }] }) +
            sse({ choices: [{ index: 0, delta: wbDelta(""), finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) +
            "data: [DONE]\n\n",
    );
    const out = clientBytes(events);
    assert.ok(out.includes(`"role":"assistant"`), `the role framing chunk still reaches the client, got: ${out}`);
    assert.equal((out.match(/"content":"9"/g) ?? []).length, 1, `round-1 text "9" reaches the client exactly once, got: ${out}`);
    assert.equal((out.match(/"content":"\+"/g) ?? []).length, 1, `round-1 text "+" reaches the client exactly once, got: ${out}`);
    assert.ok(!events.some((e) => e.kind === "tool_call"), `an empty array must not fabricate tool calls: ${JSON.stringify(events.map((e) => e.kind))}`);
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "stop", "finish_reason preserved as-is");
});

// Gate negative row (#3617): the normalization must not swallow REAL tool
// calls — a non-empty array keeps the tool-frame path verbatim.
test("#3926 openai gate: a non-empty tool_calls array still takes the tool-frame path", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const args = JSON.stringify({ city: "SF" });
    const events = await collect(
        adapter,
        sse({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: args } }] }, finish_reason: null }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
            "data: [DONE]\n\n",
    );
    const out = clientBytes(events);
    assert.equal((out.match(/get_weather/g) ?? []).length, 1, `the real call reaches the client verbatim, got: ${out}`);
    // args is a STRING field of the frame: byte-exact means its JSON-escaped
    // form inside the frame equals JSON.stringify(args) (#1039).
    assert.ok(out.includes(JSON.stringify(args)), `arguments stay byte-exact (#1039): ${out}`);
    const tc = events.find((e) => e.kind === "tool_call");
    assert.ok(tc?.kind === "tool_call" && tc.name === "get_weather", "structured passthrough event");
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "tool_calls", "finish_reason unchanged");
});

function makeLoopCtx(): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (message: string) => void;
    protocol?: WireProtocol;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [],
        session: {
            id: "issue3926-empty-tool-calls-loop",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            pendingRetrievals: [],
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
        protocol: "openai",
    };
}

// Loop-level pin: the user-visible symptom was at the client boundary — the
// adapter now emits raw-carrying text events, but only core.ts decides what
// round-1 forwards. This drives the full loop against the WorkBuddy-shaped
// stream and asserts the streamed text actually lands in the client output.
test("#3926 openai loop: empty tool_calls stream delivers round-1 text end-to-end", async () => {
    const enc = new TextEncoder();
    const frame = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, unknown>) =>
        enc.encode(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(frame(wbDelta("", { role: "assistant" })));
            controller.enqueue(frame(wbDelta("9")));
            controller.enqueue(frame(wbDelta("+")));
            controller.enqueue(frame(wbDelta(""), "stop", { prompt_tokens: 1, completion_tokens: 2 }));
            controller.enqueue(enc.encode(`data: [DONE]\n\n`));
            controller.close();
        },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(
        stream,
        makeLoopCtx(),
        { model: "gpt", stream: true },
        { url: "http://mock", headers: {} },
        createOpenaiAdapter({ model: "gpt" }),
        buildCompressSystemPrompt(),
    )) chunks.push(chunk);
    const output = Buffer.concat(chunks).toString("utf8");
    assert.equal((output.match(/"content":"9"/g) ?? []).length, 1, `streamed round-1 text "9" reaches the client exactly once, got: ${output}`);
    assert.equal((output.match(/"content":"\+"/g) ?? []).length, 1, `streamed round-1 text "+" reaches the client exactly once, got: ${output}`);
    assert.match(output, /"finish_reason":"stop"/);
    assert.match(output, /\[DONE\]/);
});
