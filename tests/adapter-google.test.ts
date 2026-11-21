import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { coreToGoogle, googleToCore, type GooglePart } from "acp-kernel/wire";
import { createGoogleAdapter, runCompressLoop } from "../src/loop/index.ts";
import type { CompressLoopAdapter, ParsedStreamEvent } from "../src/loop/index.ts";
import { createSession } from "../src/session.ts";
import { rewriteGoogleJsonResponseAsync } from "../src/stream-google.ts";

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

async function collect(adapter: CompressLoopAdapter, body: string): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(new Response(body, { status: 200 }).body!, 1)) events.push(ev);
    return events;
}

function frameJson(buf: Buffer | undefined): Record<string, unknown> {
    assert.ok(buf, "frame buffer present");
    const m = /^data: ([\s\S]*)\n\n$/.exec(buf.toString("utf8"));
    assert.ok(m, `frame is an SSE data frame: ${buf.toString("utf8").slice(0, 80)}`);
    return JSON.parse(m[1]) as Record<string, unknown>;
}

function candidateOf(parsed: Record<string, unknown>): Record<string, unknown> {
    const candidates = parsed.candidates as Array<Record<string, unknown>>;
    assert.equal(candidates.length, 1, "exactly one candidate");
    return candidates[0];
}

function partsOf(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
    const content = candidateOf(parsed).content as { role: string; parts: Array<Record<string, unknown>> };
    assert.equal(content.role, "model", "synthesized chunks are model content");
    return content.parts;
}

const CORE_MESSAGES: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "fold the early history" },
    { id: "a1", role: "assistant", contentType: "text", text: "working on it" },
];

const REQUEST_BODY: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: "original" }] }],
    systemInstruction: { parts: [{ text: "client system" }] },
    tools: [{ functionDeclarations: [{ name: "compress", description: "fold ranges" }] }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    model: "gemini-3-pro-preview",
    stream: true,
    max_tokens: 4096,
};

test("google buildRequest: contents + merged systemInstruction, request fields kept, host keys dropped", () => {
    const adapter = createGoogleAdapter(REQUEST_BODY, "client system", "bili_absorb", "gemini-3-pro-preview");
    const body = adapter.buildRequest(CORE_MESSAGES, "compress prompt", REQUEST_BODY);

    const contents = body.contents as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(contents), "contents is an array");
    assert.ok(contents.length > 0, "contents rebuilt from the core messages");
    const wire = JSON.stringify(contents);
    assert.match(wire, /fold the early history/, "user text reached the wire");
    assert.match(wire, /working on it/, "assistant text reached the wire");
    assert.deepEqual(
        body.systemInstruction,
        { parts: [{ text: "client system" }, { text: "compress prompt" }] },
        "client system first, then the compress prompt",
    );
    assert.deepEqual(body.tools, REQUEST_BODY.tools, "tools preserved");
    assert.deepEqual(body.toolConfig, REQUEST_BODY.toolConfig, "toolConfig preserved");
    assert.deepEqual(body.generationConfig, REQUEST_BODY.generationConfig, "generationConfig preserved");
    assert.equal("model" in body, false, "model travels in the URL path, never the body");
    assert.equal("stream" in body, false, "alt=sse travels in the query, never the body");
    assert.equal("max_tokens" in body, false, "the output cap lives in generationConfig");
});

test("google parseStream: SSE frames yield text, reasoning, tool_call, usage, done in order", async () => {
    const events = await collect(
        createGoogleAdapter({}, undefined, undefined, "gemini-3-pro-preview"),
        sse({ candidates: [{ content: { role: "model", parts: [{ text: "Hello " }] }, index: 0 }] }) +
            sse({
                candidates: [{
                    content: { role: "model", parts: [{ thought: true, text: "weighing options", thoughtSignature: "sig-thinking" }] },
                    index: 0,
                }],
            }) +
            sse({
                candidates: [{
                    content: {
                        role: "model",
                        parts: [{
                            functionCall: {
                                name: "compress",
                                args: { content: [{ startId: "m00001", endId: "m00010", summary: "gist" }] },
                                id: "call_1",
                            },
                        }],
                    },
                    index: 0,
                }],
            }) +
            sse({
                candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
                usageMetadata: {
                    promptTokenCount: 100,
                    cachedContentTokenCount: 40,
                    candidatesTokenCount: 7,
                    thoughtsTokenCount: 3,
                },
            }),
    );

    assert.deepEqual(
        events.map((e) => e.kind),
        ["text", "reasoning", "tool_call", "usage", "done"],
        "all five event kinds in wire order",
    );
    const text = events[0];
    assert.ok(text.kind === "text" && text.delta === "Hello ", "text delta intact");
    const call = events[2];
    assert.ok(call.kind === "tool_call", "tool call event");
    if (call.kind === "tool_call") {
        assert.equal(call.name, "compress");
        assert.equal(call.callId, "call_1");
        assert.deepEqual(JSON.parse(call.arguments), {
            content: [{ startId: "m00001", endId: "m00010", summary: "gist" }],
        });
        assert.notEqual(call.passthrough, true, "a proxy call is executed server-side, not replayed");
    }
    const usage = events[3];
    assert.ok(usage.kind === "usage", "usage event");
    if (usage.kind === "usage") {
        assert.equal(usage.inputTokens, 100);
        assert.equal(usage.cachedTokens, 40);
        assert.equal(usage.outputTokens, 10, "candidates + thoughts tokens");
    }
    const done = events[4];
    assert.ok(done.kind === "done" && done.finishReason === "STOP", "done carries the wire finish reason");
    if (done.kind === "done") assert.notEqual(done.truncated, true, "STOP is not a truncation");
});

test("google parseStream: thought parts reach reasoning with their signature", async () => {
    const events = await collect(
        createGoogleAdapter({}, undefined, undefined, "gemini-3-pro-preview"),
        sse({
            candidates: [{
                content: { role: "model", parts: [{ thought: true, text: "weighing options", thoughtSignature: "sig-thinking" }] },
                index: 0,
            }],
        }),
    );
    const reasoning = events.find((e) => e.kind === "reasoning");
    assert.ok(reasoning, "thought part surfaced as reasoning");
    if (reasoning && reasoning.kind === "reasoning") {
        assert.equal(reasoning.delta, "weighing options");
        assert.equal(reasoning.signature, "sig-thinking", "signature rides the event so a re-request can echo it");
    }
    const text = events.find((e) => e.kind === "text");
    assert.equal(text, undefined, "thinking is never emitted as visible text");
});

test("google parseStream: a real tool call replays its verbatim part as a meta frame", async () => {
    const callFrame = sse({
        candidates: [{
            content: {
                role: "model",
                parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } }, thoughtSignature: "sig-real" }],
            },
            index: 0,
        }],
    });
    const events = await collect(
        createGoogleAdapter({}, undefined, undefined, "gemini-3-pro-preview"),
        callFrame + sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] }),
    );

    const call = events.find((e) => e.kind === "tool_call");
    assert.ok(call, "real call surfaced");
    if (call && call.kind === "tool_call") {
        assert.equal(call.name, "read_file");
        assert.equal(call.passthrough, true, "the loop must not emit a second copy of a replayed call");
    }
    const replay = events.find((e) => e.kind === "meta" && e.chunk.toString("utf8").includes("read_file"));
    assert.ok(replay, "the original call frame was replayed to the client");
    if (replay && replay.kind === "meta") {
        const parsed = frameJson(replay.chunk);
        const part = partsOf(parsed)[0];
        assert.deepEqual(part.functionCall, { name: "read_file", args: { path: "a.ts" } }, "call replayed verbatim");
        assert.equal(part.thoughtSignature, "sig-real", "the part's signature survives the replay");
    }
    const done = events.find((e) => e.kind === "done");
    assert.ok(done && done.kind === "done" && done.suppressCompletion === true, "the replayed finish chunk IS the completion");
});

test("google parseStream: an echoed render tag is stripped and the raw frame is re-serialized filtered", async () => {
    const echoed = `before \x3cacp tokens="177" type="text">m00155\x3c/acp> after`;
    const events = await collect(
        createGoogleAdapter({}, undefined, undefined, "gemini-3-pro-preview"),
        sse({
            modelVersion: "gemini-3-pro-preview",
            candidates: [{ content: { role: "model", parts: [{ text: echoed }] }, index: 0 }],
        }) +
            sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] }),
    );
    const text = events.find((e) => e.kind === "text");
    assert.ok(text && text.kind === "text", "text event emitted");
    if (text && text.kind === "text") {
        assert.equal(text.delta, "before  after", "the imitated render tag never reaches the client");
        const raw = frameJson(text.raw);
        const part = partsOf(raw)[0];
        assert.equal(part.text, "before  after", "the replayed frame carries the filtered text, not the echo");
        assert.equal(raw.modelVersion, "gemini-3-pro-preview", "the rewritten frame keeps the chunk's other fields");
        assert.equal(candidateOf(raw).finishReason, undefined, "a forwarded chunk never carries a finish reason");
    }
});

test("google parseStream: a blocked prompt ends the stream with the block reason", async () => {
    const events = await collect(
        createGoogleAdapter({}, undefined, undefined, "gemini-3-pro-preview"),
        sse({ promptFeedback: { blockReason: "SAFETY" } }),
    );
    const done = events.find((e) => e.kind === "done");
    assert.ok(done && done.kind === "done", "blocked prompt still terminates the stream");
    if (done && done.kind === "done") assert.equal(done.finishReason, "SAFETY", "the block reason is the terminal reason");
    assert.equal(events.filter((e) => e.kind === "done").length, 1, "exactly one terminal");
});

test("google parseStream: MAX_TOKENS finishes as a truncation", async () => {
    const events = await collect(
        createGoogleAdapter({}, undefined, undefined, "gemini-3-pro-preview"),
        sse({
            candidates: [{ content: { role: "model", parts: [{ text: "half a sen" }] }, finishReason: "MAX_TOKENS", index: 0 }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 },
        }),
    );
    const done = events.find((e) => e.kind === "done");
    assert.ok(done && done.kind === "done", "done emitted");
    if (done && done.kind === "done") {
        assert.equal(done.finishReason, "MAX_TOKENS");
        assert.equal(done.truncated, true, "core.ts keys its zero-side-effect retry off this flag");
    }
});

test("google parseStream: the JSON-array streaming form yields the same events", async () => {
    const body = JSON.stringify([
        { candidates: [{ content: { role: "model", parts: [{ text: "array form" }] }, index: 0 }] },
        { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] },
    ]);
    const events = await collect(createGoogleAdapter({}, undefined, undefined, "gemini-3-pro-preview"), body);
    const text = events.find((e) => e.kind === "text");
    assert.ok(text && text.kind === "text" && text.delta === "array form", "text came through the array form");
    const done = events.find((e) => e.kind === "done");
    assert.ok(done && done.kind === "done" && done.finishReason === "STOP", "finish reason came through the array form");
});

test("google emit*: text, tool call and completion frames carry the documented shape", () => {
    const adapter = createGoogleAdapter({}, undefined, undefined, "gemini-3-pro-preview");

    const textParts = partsOf(frameJson(adapter.emitText("delta")));
    assert.deepEqual(textParts, [{ text: "delta" }], "emitText emits one text part");

    const callParts = partsOf(frameJson(adapter.emitToolCall({
        name: "search_context",
        callId: "call_9",
        arguments: '{"query":"kv cache"}',
        signature: "sig-call",
    })));
    assert.deepEqual(callParts, [{
        functionCall: { name: "search_context", args: { query: "kv cache" }, id: "call_9" },
        thoughtSignature: "sig-call",
    }], "emitToolCall emits a functionCall part with object args, id and signature");

    const completion = frameJson(adapter.emitCompletion({
        finishReason: "length",
        usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 4 },
    }));
    assert.equal(candidateOf(completion).finishReason, "MAX_TOKENS", "a proxy-side 'length' maps onto Gemini's MAX_TOKENS");
    assert.deepEqual(completion.usageMetadata, {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        totalTokenCount: 12,
        cachedContentTokenCount: 4,
    }, "completion carries usage");

    const plain = frameJson(adapter.emitCompletion());
    assert.equal(candidateOf(plain).finishReason, "STOP", "a completion always carries a finish reason");

    const error = frameJson(adapter.emitError("upstream exploded"));
    assert.deepEqual(error, { error: { code: 500, message: "upstream exploded", status: "INTERNAL" } });
});

// Frames reach the client from two fields: `raw` on the streaming events, and
// `chunk` on meta events — the settle replay of a buffered call chunk arrives as
// a meta, so a collector that reads only `raw` sees none of it.
function framesOf(events: ParsedStreamEvent[]): string[] {
    const frames: string[] = [];
    for (const e of events) {
        if ("raw" in e && Buffer.isBuffer(e.raw)) frames.push(e.raw.toString("utf8"));
        if ("chunk" in e && Buffer.isBuffer(e.chunk)) frames.push(e.chunk.toString("utf8"));
    }
    return frames;
}

// A chunk may carry text and a functionCall part together. It is replayed whole
// at settle (the call needs its signature, id and order), so the immediate text
// frame must not also carry the chunk: the client would see the same content
// twice. The guard has to look at the WHOLE chunk, because a call that follows
// the text part in iteration order is still a call in this chunk.
test("google parseStream: a chunk holding text and a call does not forward its text twice", async () => {
    const adapter = createGoogleAdapter(REQUEST_BODY, "client system", "bili_absorb", "gemini-3-pro-preview");
    const events = await collect(
        adapter,
        sse({ candidates: [{ content: { role: "model", parts: [{ text: "checking " }, { functionCall: { name: "read", args: { path: "src/plugin.ts" } } }] }, index: 0 }] }) +
            sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }),
    );
    const frames = framesOf(events).join("");
    assert.equal((frames.match(/checking /g) ?? []).length, 1, `the text reaches the client once, got: ${frames}`);
    assert.equal((frames.match(/"name":"read"/g) ?? []).length, 1, `the call reaches the client once, got: ${frames}`);
});

// The edited copy an emptied tag leaves behind must not carry the chunk's
// sibling call parts: settle drops a proxy call, so letting it ride along in the
// immediate frame hands the client a proxy call that the proxy executes itself.
test("google parseStream: an edited text frame carries no sibling proxy call", async () => {
    const adapter = createGoogleAdapter(REQUEST_BODY, "client system", "bili_absorb", "gemini-3-pro-preview");
    const TAG = "\x3cacp tokens=\"1\" type=\"text\"\x3e";
    const CLOSE = "\x3c/acp\x3e";
    const events = await collect(
        adapter,
        sse({ candidates: [{ content: { role: "model", parts: [{ text: `${TAG}${CLOSE}kept prose` }, { functionCall: { name: "bili_absorb", args: {} } }] }, index: 0 }] }) +
            sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] }),
    );
    const frames = framesOf(events);
    const leaked = frames.filter((f) => f.includes("kept prose") && f.includes("bili_absorb"));
    assert.equal(leaked.length, 0, `no frame may carry the prose and the proxy call together, got: ${leaked.join(" | ")}`);
    assert.equal(frames.filter((f) => f.includes("kept prose")).length, 1, `the surviving prose still arrives once, got: ${frames.join(" | ")}`);
});

// A malformed upstream chunk can carry a null where a part object belongs. The
// edited copy filters sibling call parts out of the chunk, so it has to tolerate
// a null rather than dereference it: before the guard, this threw mid-stream and
// took the turn down with it.
test("google parseStream: a null sibling part does not break the edited frame", async () => {
    const adapter = createGoogleAdapter(REQUEST_BODY, "client system", "bili_absorb", "gemini-3-pro-preview");
    const TAG = "\x3cacp tokens=\"1\" type=\"text\"\x3e";
    const CLOSE = "\x3c/acp\x3e";
    const events = await collect(
        adapter,
        sse({ candidates: [{ content: { role: "model", parts: [{ text: `${TAG}m00155${CLOSE} kept prose` }, null] } }] }),
    );
    const frames = framesOf(events);
    assert.ok(frames.some((f) => f.includes("kept prose")), `the prose still reaches the client, got: ${frames.join(" | ")}`);
});

test("google parseStream: parallel [compress (signed), write_file (unsigned)] in same chunk promotes thoughtSignature onto write_file", async () => {
    const adapter = createGoogleAdapter(REQUEST_BODY, "client system", "bili_absorb", "gemini-4-argon-medium");
    const events = await collect(
        adapter,
        sse({
            candidates: [{
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "compress",
                                args: { content: "m00046-m00129: folded context\nsummary body" },
                                id: "call_compress_1",
                            },
                            thoughtSignature: "sig-parallel-same-chunk",
                        },
                        {
                            functionCall: {
                                name: "write_file",
                                args: { path: "src/app.ts", content: "export const ok = true;\n" },
                                id: "call_write_2",
                            },
                        },
                        {
                            functionCall: {
                                name: "read_file",
                                args: { path: "README.md" },
                                id: "call_read_3",
                            },
                        },
                    ],
                },
                index: 0,
            }],
        }) +
            sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] }),
    );

    const toolCalls = events.filter((e): e is Extract<ParsedStreamEvent, { kind: "tool_call" }> => e.kind === "tool_call");
    const writeEvent = toolCalls.find((e) => e.name === "write_file");
    const readEvent = toolCalls.find((e) => e.name === "read_file");
    const compressEvent = toolCalls.find((e) => e.name === "compress");
    assert.ok(writeEvent && writeEvent.passthrough === true, "write_file emitted as passthrough real call");
    assert.equal(writeEvent.signature, "sig-parallel-same-chunk", "first surviving real call event inherits thoughtSignature");
    assert.ok(readEvent && readEvent.passthrough === true, "read_file emitted as passthrough real call");
    assert.equal(readEvent.signature, undefined, "subsequent sibling real call stays unsigned");
    assert.ok(compressEvent && compressEvent.passthrough !== true, "compress emitted as server-side proxy call");

    const callMeta = events.find((e) => e.kind === "meta" && e.chunk.toString("utf8").includes("write_file"));
    assert.ok(callMeta && callMeta.kind === "meta", "replayed call frame present");
    const replayedParts = partsOf(frameJson(callMeta.chunk));
    assert.equal(replayedParts.length, 2, "compress stripped; two real calls kept");
    assert.deepEqual(replayedParts[0].functionCall, {
        name: "write_file",
        args: { path: "src/app.ts", content: "export const ok = true;\n" },
        id: "call_write_2",
    });
    assert.equal(replayedParts[0].thoughtSignature, "sig-parallel-same-chunk", "first surviving real functionCall part carries promoted thoughtSignature");
    assert.equal(replayedParts[1].thoughtSignature, undefined, "second surviving real functionCall part stays unsigned");
});

test("google parseStream: parallel [compress (signed), write_file (unsigned)] across separate chunks promotes thoughtSignature onto write_file chunk", async () => {
    const adapter = createGoogleAdapter(REQUEST_BODY, "client system", "bili_absorb", "gemini-4-argon-medium");
    const events = await collect(
        adapter,
        sse({
            candidates: [{
                content: {
                    role: "model",
                    parts: [{
                        functionCall: {
                            name: "compress",
                            args: { content: "m00001-m00010: folded\nsummary" },
                            id: "call_compress_chunk1",
                        },
                        thoughtSignature: "sig-parallel-chunk1",
                    }],
                },
                index: 0,
            }],
        }) +
            sse({
                candidates: [{
                    content: {
                        role: "model",
                        parts: [{
                            functionCall: {
                                name: "write_file",
                                args: { path: "src/index.ts", content: "console.log(1);\n" },
                                id: "call_write_chunk2",
                            },
                        }],
                    },
                    index: 0,
                }],
            }) +
            sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] }),
    );

    const allFrames = framesOf(events).join("");
    assert.equal(allFrames.includes("call_compress_chunk1"), false, "proxy-only chunk 1 is dropped from client stream");
    const callMeta = events.find((e) => e.kind === "meta" && e.chunk.toString("utf8").includes("write_file"));
    assert.ok(callMeta && callMeta.kind === "meta", "chunk 2 replayed with write_file");
    const replayedParts = partsOf(frameJson(callMeta.chunk));
    assert.equal(replayedParts.length, 1);
    assert.equal(replayedParts[0].thoughtSignature, "sig-parallel-chunk1", "chunk 2 real functionCall part inherits chunk 1 proxy call's thoughtSignature");
});

test("google parseStream: real call with its own thoughtSignature is never overwritten by a sibling proxy call", async () => {
    const adapter = createGoogleAdapter(REQUEST_BODY, "client system", "bili_absorb", "gemini-4-argon-medium");
    const events = await collect(
        adapter,
        sse({
            candidates: [{
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: { name: "write_file", args: { path: "a.ts" }, id: "call_1" },
                            thoughtSignature: "sig-own-real",
                        },
                        {
                            functionCall: { name: "compress", args: {}, id: "call_2" },
                            thoughtSignature: "sig-proxy-other",
                        },
                    ],
                },
                index: 0,
            }],
        }) +
            sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] }),
    );

    const callMeta = events.find((e) => e.kind === "meta" && e.chunk.toString("utf8").includes("write_file"));
    assert.ok(callMeta && callMeta.kind === "meta");
    const replayedParts = partsOf(frameJson(callMeta.chunk));
    assert.equal(replayedParts.length, 1);
    assert.equal(replayedParts[0].thoughtSignature, "sig-own-real", "real call's own signature is preserved");
});

test("rewriteGoogleJsonResponseAsync: promotes stripped proxy call thoughtSignature onto surviving real functionCall part", async () => {
    const core = createCore();
    const config = defaultConfig(400_000);
    const session = createSession("google-json-sig");
    const messages: CoreMessage[] = [
        { id: "m1", role: "user", contentType: "text", text: "step 1" },
        { id: "m2", role: "assistant", contentType: "text", text: "ack 1" },
        { id: "m3", role: "user", contentType: "text", text: "step 2" },
        { id: "m4", role: "assistant", contentType: "text", text: "ack 2" },
        { id: "m5", role: "user", contentType: "text", text: "step 3" },
        { id: "m6", role: "assistant", contentType: "text", text: "ack 3" },
        { id: "m7", role: "user", contentType: "text", text: "step 4" },
    ];
    const turn = core.processTurn({ messages, state: session.state, config, tokenCount: 0 });
    session.state = turn.state;

    const responseBody = {
        candidates: [{
            content: {
                role: "model",
                parts: [
                    {
                        functionCall: {
                            name: "compress",
                            args: { content: "m00001-m00003: early steps\ncompleted step 1 and step 2" },
                            id: "fc_compress",
                        },
                        thoughtSignature: "sig-json-parallel",
                    },
                    {
                        functionCall: {
                            name: "write_file",
                            args: { path: "out.txt", content: "done" },
                            id: "fc_write",
                        },
                    },
                ],
            },
            finishReason: "STOP",
        }],
    };

    const rewritten = (await rewriteGoogleJsonResponseAsync(responseBody, {
        core,
        config,
        messages,
        session,
        log: () => {},
    })) as { candidates: Array<{ content: { parts: GooglePart[] } }> };

    const outParts = rewritten.candidates[0].content.parts;
    const fcParts = outParts.filter((p) => p.functionCall !== undefined);
    assert.equal(fcParts.length, 1, "compress stripped, write_file kept");
    assert.equal(fcParts[0].functionCall?.name, "write_file");
    assert.equal(fcParts[0].thoughtSignature, "sig-json-parallel", "write_file inherited thoughtSignature from stripped compress call");
});

test("runCompressLoop + next-turn Google replay: mixed [compress, write_file] turn keeps thoughtSignature on write_file after fold", async () => {
    const core = createCore();
    const config = defaultConfig(400_000);
    const session = createSession("google-loop-mixed-sig");

    const initialContents = [
        { role: "user", parts: [{ text: "task 1" }] },
        { role: "model", parts: [{ text: "done 1" }] },
        { role: "user", parts: [{ text: "task 2" }] },
        { role: "model", parts: [{ text: "done 2" }] },
        { role: "user", parts: [{ text: "task 3" }] },
        { role: "model", parts: [{ text: "done 3" }] },
        { role: "user", parts: [{ text: "now compress and write file" }] },
    ];
    const flat1 = googleToCore({ contents: initialContents });
    const turn1 = core.processTurn({ messages: flat1.msgs, state: session.state, config, tokenCount: 0 });
    session.state = turn1.state;

    const upstreamSse =
        sse({
            candidates: [{
                content: {
                    role: "model",
                    parts: [
                        { thought: true, text: "I will compress m00001-m00004 and call write_file." },
                        {
                            functionCall: {
                                name: "compress",
                                args: { content: "m00001-m00004: tasks 1-2\ncompleted tasks 1 and 2" },
                                id: "call_compress_mixed",
                            },
                            thoughtSignature: "sig-gemini4-active-turn",
                        },
                        {
                            functionCall: {
                                name: "write_file",
                                args: { path: "result.txt", content: "hello" },
                                id: "call_write_mixed",
                            },
                        },
                    ],
                },
                index: 0,
            }],
        }) +
        sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] });

    const reqBody: Record<string, unknown> = { contents: initialContents };
    const adapter = createGoogleAdapter(reqBody, undefined, undefined, "gemini-4-argon-medium");
    const streamedChunks: string[] = [];
    for await (const chunk of runCompressLoop(
        new Response(upstreamSse, { status: 200 }).body!,
        {
            core,
            config,
            messages: turn1.messages,
            compressMessages: flat1.msgs,
            session,
            protocol: "google",
            log: () => {},
        },
        reqBody,
        { url: "http://127.0.0.1:1/v1beta/models/gemini-4-argon-medium:streamGenerateContent?alt=sse", headers: {} },
        adapter,
        "system prompt",
    )) {
        streamedChunks.push(chunk.toString("utf8"));
    }

    // Reconstruct the model turn parts exactly as a Google SSE client accumulates them.
    const clientReceivedParts: GooglePart[] = [];
    for (const raw of streamedChunks.join("").split("\n\n")) {
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const parsed = JSON.parse(line.slice(5).trim()) as {
            candidates?: Array<{ content?: { parts?: GooglePart[] } }>;
        };
        const ps = parsed.candidates?.[0]?.content?.parts ?? [];
        clientReceivedParts.push(...ps);
    }

    const writePartOnWire = clientReceivedParts.find((p) => p.functionCall?.name === "write_file");
    assert.ok(writePartOnWire, "client received write_file functionCall part");
    assert.equal(writePartOnWire.thoughtSignature, "sig-gemini4-active-turn", "streamed write_file part carries thoughtSignature");

    // Next turn: client appends the model turn + functionResponse for write_file, and bili prepares the folded outbound body.
    const nextTurnContents = [
        ...initialContents,
        { role: "model", parts: clientReceivedParts },
        {
            role: "user",
            parts: [{
                functionResponse: {
                    name: "write_file",
                    id: "call_write_mixed",
                    response: { output: "ok" },
                },
            }],
        },
    ];
    const flat2 = googleToCore({ contents: nextTurnContents });
    const turn2 = core.processTurn({ messages: flat2.msgs, state: session.state, config, tokenCount: 0 });
    const outboundContents = coreToGoogle(turn2.messages);
    const modelTurnWithWrite = outboundContents.find(
        (c) => c.role === "model" && c.parts.some((p) => p.functionCall?.name === "write_file"),
    );
    assert.ok(modelTurnWithWrite, "outbound Google contents contain the write_file model turn");
    const outboundWritePart = modelTurnWithWrite.parts.find((p) => p.functionCall?.name === "write_file");
    assert.ok(outboundWritePart, "write_file part present on outbound wire");
    assert.equal(
        outboundWritePart.thoughtSignature,
        "sig-gemini4-active-turn",
        "surviving write_file part retains thoughtSignature after fold on next turn",
    );
});

test("runCompressLoop Google re-request: parallel proxy-only calls [compress (signed), acp_status (unsigned)] keep thoughtSignature on every rebuilt model functionCall turn", async () => {
    const core = createCore();
    const config = defaultConfig(400_000);
    const session = createSession("google-loop-multi-proxy-sig");

    const initialContents = [
        { role: "user", parts: [{ text: "step 1" }] },
        { role: "model", parts: [{ text: "done 1" }] },
        { role: "user", parts: [{ text: "step 2" }] },
        { role: "model", parts: [{ text: "done 2" }] },
        { role: "user", parts: [{ text: "compress and check status" }] },
    ];
    const flat = googleToCore({ contents: initialContents });
    const turn = core.processTurn({ messages: flat.msgs, state: session.state, config, tokenCount: 0 });
    session.state = turn.state;

    const round1Sse =
        sse({
            candidates: [{
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "compress",
                                args: { content: "m00001-m00002: step 1\ncompleted step 1" },
                                id: "call_proxy_compress",
                            },
                            thoughtSignature: "sig-multi-proxy-round1",
                        },
                        {
                            functionCall: {
                                name: "acp_status",
                                args: {},
                                id: "call_proxy_status",
                            },
                        },
                    ],
                },
                index: 0,
            }],
        }) +
        sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] });

    const round2Sse =
        sse({ candidates: [{ content: { role: "model", parts: [{ text: "All folded and checked." }] }, index: 0 }] }) +
        sse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }] });

    let capturedRound2Body: { contents?: Array<{ role?: string; parts?: GooglePart[] }> } | undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        capturedRound2Body = JSON.parse(String(init?.body ?? "{}")) as {
            contents?: Array<{ role?: string; parts?: GooglePart[] }>;
        };
        return new Response(round2Sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        });
    }) as typeof fetch;

    try {
        const reqBody: Record<string, unknown> = { contents: initialContents };
        const adapter = createGoogleAdapter(reqBody, undefined, undefined, "gemini-4-argon-medium");
        for await (const _ of runCompressLoop(
            new Response(round1Sse, { status: 200 }).body!,
            {
                core,
                config,
                messages: turn.messages,
                compressMessages: flat.msgs,
                session,
                protocol: "google",
                log: () => {},
            },
            reqBody,
            { url: "http://127.0.0.1:1/v1beta/models/gemini-4-argon-medium:streamGenerateContent?alt=sse", headers: {} },
            adapter,
            "system prompt",
        )) {
            // drain
        }
    } finally {
        globalThis.fetch = origFetch;
    }

    assert.ok(capturedRound2Body?.contents, "round 2 re-request body captured");
    const modelFcTurns = capturedRound2Body.contents.filter(
        (c) => c.role === "model" && (c.parts ?? []).some((p) => p.functionCall !== undefined),
    );
    assert.ok(modelFcTurns.length >= 2, "both proxy tool calls are present in round 2 re-request");
    for (const modelTurn of modelFcTurns) {
        const firstFc = (modelTurn.parts ?? []).find((p) => p.functionCall !== undefined);
        assert.ok(firstFc, "model turn has functionCall part");
        assert.equal(
            firstFc.thoughtSignature,
            "sig-multi-proxy-round1",
            `functionCall ${firstFc.functionCall?.name} carries round thoughtSignature`,
        );
    }
});
