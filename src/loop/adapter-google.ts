import type { CoreMessage } from "acp-kernel";
import { coreToGoogle } from "acp-kernel/wire";
import type { GooglePart } from "acp-kernel/wire";
import { buildVisibilityMarker } from "../compress-loop.js";
import { composeStreamFilters, createMarkerLineFilter, createTagEchoFilter } from "./tag-echo-filter.js";
import { degenerateTurnWarning } from "../degenerate-turn.js";
import { log as loggerLog } from "../logger.js";

import type {
    CompressLoopAdapter,
    EmitCompletionOpts,
    ParsedStreamEvent,
    ToolCallEmit,
} from "./core.js";

const PROXY_TOOL_SET = new Set([
    "compress", "decompress", "search_context", "acp_status",
    "bili_compress", "bili_decompress", "bili_search_context", "bili_status",
]);

// Gemini's own finish vocabulary. The loop hands emitCompletion whatever the
// round's `done` event carried, which may be another wire's word ("length"
// from a proxy-side truncation, "tool_calls" from the openai adapter) — every
// value must land on a real Gemini reason because the client THROWS on a
// stream that ends without one.
const GOOGLE_FINISH_REASONS: Record<string, true> = {
    STOP: true,
    MAX_TOKENS: true,
    SAFETY: true,
    RECITATION: true,
    OTHER: true,
    BLOCKLIST: true,
    PROHIBITED_CONTENT: true,
    SPII: true,
    MALFORMED_FUNCTION_CALL: true,
    IMAGE_SAFETY: true,
    LANGUAGE: true,
    FINISH_REASON_UNSPECIFIED: true,
};

function googleFinishReason(reason: string | undefined): string {
    if (!reason) return "STOP";
    const upper = reason.toUpperCase();
    if (GOOGLE_FINISH_REASONS[upper] === true) return upper;
    if (upper === "LENGTH") return "MAX_TOKENS";
    if (upper === "END_TURN" || upper === "TOOL_CALLS" || upper === "TOOL_USE" || upper === "COMPLETED" || upper === "STOP_SEQUENCE") return "STOP";
    return "OTHER";
}

function readUsageMetadata(usage: Record<string, unknown>): {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
} {
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const candidates = num(usage.candidatesTokenCount);
    const thoughts = num(usage.thoughtsTokenCount);
    return {
        inputTokens: num(usage.promptTokenCount),
        cachedTokens: num(usage.cachedContentTokenCount),
        // Thinking tokens are billed as output; the client's own accounting
        // reads a single output number, so they are folded in here.
        outputTokens: candidates === undefined && thoughts === undefined ? undefined : (candidates ?? 0) + (thoughts ?? 0),
    };
}

function sseFrame(parsed: Record<string, unknown>): Buffer {
    return Buffer.from(`data: ${JSON.stringify(parsed)}\n\n`, "utf8");
}

// One chunk is edited in place — its parts replaced, and/or an early
// finishReason dropped. A forwarded chunk must never carry a finishReason
// unless it IS the round's completion: the loop may run another upstream round
// after this one (core.ts reRequest), and a leaked early finish makes every
// later token "content after the finish reason" to the client.
function cloneChunk(
    parsed: Record<string, unknown>,
    edit: { parts?: GooglePart[]; dropFinishReason?: boolean },
): Record<string, unknown> {
    const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
    if (!candidates || candidates.length === 0) return parsed;
    const candidate = { ...candidates[0] };
    if (edit.dropFinishReason) delete candidate.finishReason;
    if (edit.parts) {
        candidate.content = { role: "model", ...(candidate.content as Record<string, unknown> | undefined), parts: edit.parts };
    }
    return { ...parsed, candidates: [candidate, ...candidates.slice(1)] };
}

interface FunctionCallBuffer {
    index: number;
    id: string;
    name: string;
    args: string;
    signature: string;
}

// A decision per buffered chunk that carried functionCall parts: "keep" = every
// call in it is real (replay verbatim, preserving signatures/ids/order), null =
// only proxy calls (drop — the proxy executes them server-side), or a rewritten
// copy keeping the chunk's other parts plus its real calls.
function filterRealCallChunk(
    parsed: Record<string, unknown>,
    realIndexes: Set<number>,
    callIndexes: number[],
): "keep" | null | Record<string, unknown> {
    const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
    const parts = (candidates?.[0]?.content as { parts?: GooglePart[] } | undefined)?.parts;
    if (!Array.isArray(parts)) return "keep";
    let anyReal = false;
    let anyProxy = false;
    const keep: boolean[] = [];
    let call = 0;
    for (const part of parts) {
        if (part && typeof part === "object" && part.functionCall) {
            const real = realIndexes.has(callIndexes[call] ?? -1);
            call += 1;
            keep.push(real);
            if (real) anyReal = true;
            else anyProxy = true;
        } else {
            keep.push(true);
        }
    }
    if (!anyProxy) return "keep";
    if (!anyReal) return null;
    return cloneChunk(parsed, { parts: parts.filter((_, i) => keep[i]) });
}

function dataLine(frame: string): string | null {
    for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) return line.slice(5).trim();
    }
    return null;
}

interface GoogleChunk {
    /** The chunk's own SSE text, or a synthesized one in JSON-array mode. */
    frame: string;
    json: string;
}

// Gemini streams either as SSE (`?alt=sse`, what the real client asks for) or,
// without that query parameter, as one JSON array whose elements are the same
// chunk objects. Both forms are read here: the first non-whitespace byte of the
// body decides which, and array elements are emitted as they complete so text
// still reaches the client incrementally.
async function* iterGoogleChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<GoogleChunk> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let mode: "unknown" | "sse" | "array" = "unknown";
    let cursor = 0;
    let started = false;
    let elementStart = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let arrayDone = false;
    try {
        while (true) {
            let done: boolean;
            let value: Uint8Array | undefined;
            try {
                ({ done, value } = await reader.read());
            } catch {
                break;
            }
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            if (mode === "unknown") {
                const lead = buf.replace(/^[\uFEFF\s]+/, "");
                if (lead.length === 0) continue;
                if (lead.startsWith("[")) {
                    mode = "array";
                    cursor = buf.indexOf("[") + 1;
                } else {
                    mode = "sse";
                }
            }
            if (mode === "sse") {
                buf = buf.replace(/\r\n|\r/g, "\n");
                let idx: number;
                while ((idx = buf.indexOf("\n\n")) >= 0) {
                    const raw = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const json = dataLine(raw);
                    if (json !== null) yield { frame: raw, json };
                }
                continue;
            }
            for (; cursor < buf.length && !arrayDone; cursor++) {
                const ch = buf[cursor];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (ch === "\\") escaped = true;
                    else if (ch === '"') inString = false;
                    continue;
                }
                if (!started) {
                    if (ch === "," || /\s/.test(ch)) continue;
                    if (ch === "]") {
                        arrayDone = true;
                        break;
                    }
                    started = true;
                    elementStart = cursor;
                }
                if (ch === '"') inString = true;
                else if (ch === "{" || ch === "[") depth += 1;
                else if (ch === "}" || ch === "]") {
                    depth -= 1;
                    if (depth === 0) {
                        const json = buf.slice(elementStart, cursor + 1);
                        started = false;
                        elementStart = -1;
                        yield { frame: `data: ${json}`, json };
                    }
                }
            }
        }
        if (mode !== "array") {
            buf = buf.replace(/\r\n|\r/g, "\n");
            const json = dataLine(buf);
            if (json !== null) yield { frame: buf, json };
        }
    } finally {
        reader.releaseLock();
    }
}

export function createGoogleAdapter(
    requestBody: Record<string, unknown>,
    clientSystem?: string,
    absorbName?: string,
    model?: string,
): CompressLoopAdapter {
    // Gemini carries the model in the URL path, not the body, so the server
    // hands it in; the body lookup only covers hand-built requests.
    const modelVersion = model ?? (typeof requestBody.model === "string" ? requestBody.model : undefined);

    const buildChunk = (
        parts: GooglePart[],
        extra: { candidate?: Record<string, unknown>; top?: Record<string, unknown> } = {},
    ): Buffer =>
        sseFrame({
            ...(modelVersion ? { modelVersion } : {}),
            candidates: [{ content: { role: "model", parts }, index: 0, ...(extra.candidate ?? {}) }],
            ...(extra.top ?? {}),
        });

    const buildToolArgs = (args: string): unknown => {
        if (args.length === 0) return {};
        try {
            const parsed: unknown = JSON.parse(args);
            return parsed === null || typeof parsed !== "object" ? {} : parsed;
        } catch {
            loggerLog("warn", "[google-adapter] tool-call arguments were not valid JSON; emitting an empty args object");
            return {};
        }
    };

    return {
        buildRequest(coreMessages, systemPrompt, body) {
            const rebuilt: Record<string, unknown> = { ...body, contents: coreToGoogle(coreMessages) };
            // The model lives in the URL path, `alt=sse` in the query, and the
            // output cap in generationConfig.maxOutputTokens — a body carrying
            // any of these keys is rejected upstream.
            delete rebuilt.model;
            delete rebuilt.stream;
            delete rebuilt.max_tokens;
            const parts = [clientSystem, systemPrompt]
                .filter((p): p is string => typeof p === "string" && p.length > 0)
                .map((text) => ({ text }));
            if (parts.length > 0) rebuilt.systemInstruction = { parts };
            return rebuilt;
        },

        async *parseStream(upstream, _round) {
            const pending = new Map<number, FunctionCallBuffer>();
            const rawCallChunks: { json: string; parsed: Record<string, unknown>; callIndexes: number[] }[] = [];
            // #206/#717: strip model-imitated render tags and forged ACP
            // confirmation markers from text parts; both filters may hold back a
            // short tail, flushed on finish (and at stream end).
            const tagFilter = composeStreamFilters(
                createTagEchoFilter((snippet) => {
                    loggerLog("warn", `[tag-echo] stripped model-emitted render tag: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                }),
                createMarkerLineFilter((snippet) => {
                    loggerLog("warn", `[marker-echo] stripped model-emitted ACP confirmation marker: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                }),
            );
            const flushFilter = function* (): Generator<ParsedStreamEvent> {
                const tail = tagFilter.flush();
                if (tail.length > 0) {
                    yield { kind: "text", delta: tail, raw: buildChunk([{ text: tail }]) } as ParsedStreamEvent;
                }
            };
            let callIndex = 0;
            let sawReasoning = false;
            let toolCallsEmitted = 0;
            let degenerateWarned = false;
            let lastUsage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } | null = null;
            let usageEmitted = false;
            let sawDone = false;
            let sawRealToolCall = false;
            const maybeWarnDegenerate = (reason: string | undefined) => {
                if (degenerateWarned) return;
                const msg = degenerateTurnWarning({
                    reason,
                    terminalReason: "STOP",
                    toolCalls: toolCallsEmitted,
                    text: tagFilter.stats(),
                    sawThinking: sawReasoning,
                    wire: "google",
                });
                if (msg) {
                    degenerateWarned = true;
                    loggerLog("warn", msg);
                }
            };
            const usageEvent = (): ParsedStreamEvent => ({ kind: "usage", ...(lastUsage ?? {}) }) as ParsedStreamEvent;
            const flushPendingAsStructured = function* (): Generator<ParsedStreamEvent> {
                for (const [, tc] of pending) {
                    if (tc.name.length > 0 || tc.id.length > 0) {
                        toolCallsEmitted++;
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.args,
                            ...(tc.signature ? { signature: tc.signature } : {}),
                        } as ParsedStreamEvent;
                    }
                }
                pending.clear();
            };
            // Decide proxy-vs-real from the buffered calls and emit events: real
            // calls → raw part replay (verbatim parts, original signatures/ids)
            // + passthrough-flagged structured events so the loop counts them;
            // proxy calls → structured events (executed server-side).
            const settleToolCalls = function* (): Generator<ParsedStreamEvent> {
                const realIndexes = new Set<number>();
                for (const [idx, tc] of pending) {
                    // absorb joins PROXY_TOOL_SET dynamically: its name is
                    // configurable per session, and misclassifying it as real
                    // would raw-replay its part to the client.
                    if (tc.name.length > 0 && !PROXY_TOOL_SET.has(tc.name) && tc.name !== absorbName) realIndexes.add(idx);
                }
                sawRealToolCall = realIndexes.size > 0;
                if (!sawRealToolCall) {
                    yield* flushPendingAsStructured();
                    return;
                }
                for (const [idx, tc] of pending) {
                    if (realIndexes.has(idx) && tc.name.length > 0) {
                        toolCallsEmitted++;
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.args,
                            passthrough: true,
                            ...(tc.signature ? { signature: tc.signature } : {}),
                        } as ParsedStreamEvent;
                    }
                }
                for (const { json, parsed, callIndexes } of rawCallChunks) {
                    const filtered = filterRealCallChunk(parsed, realIndexes, callIndexes);
                    if (filtered === "keep") {
                        yield { kind: "meta", chunk: Buffer.from(`data: ${json}\n\n`, "utf8") } as ParsedStreamEvent;
                    } else if (filtered !== null) {
                        yield { kind: "meta", chunk: sseFrame(filtered) } as ParsedStreamEvent;
                    }
                }
                for (const [idx, tc] of pending) {
                    if (!realIndexes.has(idx) && tc.name.length > 0) {
                        toolCallsEmitted++;
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.args,
                            ...(tc.signature ? { signature: tc.signature } : {}),
                        } as ParsedStreamEvent;
                    }
                }
                pending.clear();
            };

            for await (const { frame, json } of iterGoogleChunks(upstream)) {
                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(json) as Record<string, unknown>;
                } catch {
                    continue;
                }
                const rawBuf = Buffer.from(`${frame}\n\n`, "utf8");
                const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
                const candidate = candidates?.[0];
                const content = candidate?.content as { parts?: GooglePart[] } | undefined;
                const parts = Array.isArray(content?.parts) ? content.parts : [];
                const finishReason = typeof candidate?.finishReason === "string" ? candidate.finishReason : undefined;
                const feedback = parsed.promptFeedback as { blockReason?: unknown } | undefined;
                const blockReason = typeof feedback?.blockReason === "string" ? feedback.blockReason : undefined;
                const usageMetadata = parsed.usageMetadata as Record<string, unknown> | undefined;
                if (usageMetadata) lastUsage = readUsageMetadata(usageMetadata);

                // A prompt the safety filter refused up front carries no
                // candidate at all; the client needs the reason as a terminal.
                if (blockReason && !candidate && !sawDone) {
                    yield* flushFilter();
                    sawDone = true;
                    yield { kind: "meta", chunk: rawBuf } as ParsedStreamEvent;
                    yield { kind: "done", finishReason: blockReason } as ParsedStreamEvent;
                    continue;
                }
                if (!candidate) {
                    if (usageMetadata && !usageEmitted) {
                        usageEmitted = true;
                        yield usageEvent();
                    } else if (!usageMetadata) {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                    continue;
                }

                const callIndexes: number[] = [];
                // Whether THIS chunk carries a functionCall part anywhere, not
                // only before the part being forwarded: a chunk that will be
                // replayed whole at settle must not also hand the client its
                // text or reasoning now, and its sibling call parts must not
                // ride along in an edited copy (a proxy call would leak there
                // even when settle drops the chunk).
                const hasCallPart = parts.some((p) => p && typeof p === "object" && p.functionCall !== undefined);
                let emitted = false;
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    if (!part || typeof part !== "object") continue;
                    const fc = part.functionCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
                    if (fc) {
                        const idx = callIndex++;
                        callIndexes.push(idx);
                        pending.set(idx, {
                            index: idx,
                            id: typeof fc.id === "string" ? fc.id : "",
                            name: typeof fc.name === "string" ? fc.name : "",
                            args: typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args ?? {}),
                            signature: typeof part.thoughtSignature === "string" ? part.thoughtSignature : "",
                        });
                        continue;
                    }
                    if (typeof part.text !== "string" || part.text.length === 0) continue;
                    if (part.thought === true) {
                        sawReasoning = true;
                        emitted = true;
                        const reasoningRaw = !hasCallPart ? (finishReason ? sseFrame(cloneChunk(parsed, { dropFinishReason: true })) : rawBuf) : undefined;
                        yield {
                            kind: "reasoning",
                            delta: part.text,
                            ...(reasoningRaw ? { raw: reasoningRaw } : {}),
                            ...(typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
                                ? { signature: part.thoughtSignature }
                                : {}),
                        } as ParsedStreamEvent;
                        continue;
                    }
                    const clean = tagFilter.push(part.text);
                    if (clean.length === 0) continue;
                    emitted = true;
                    let raw: Buffer | undefined;
                    if (clean === part.text) {
                        // A chunk that also carries functionCall parts is replayed
                        // whole at settle, so its text must not be forwarded twice.
                        if (!hasCallPart) raw = finishReason ? sseFrame(cloneChunk(parsed, { dropFinishReason: true })) : rawBuf;
                    } else {
                        raw = sseFrame(cloneChunk(parsed, {
                            parts: parts
                                .map((p, j) => (j === i ? { ...p, text: clean } : p))
                                .filter((p) => !p || typeof p !== "object" || p.functionCall === undefined),
                            dropFinishReason: true,
                        }));
                    }
                    yield { kind: "text", delta: clean, ...(raw ? { raw } : {}) } as ParsedStreamEvent;
                }
                if (callIndexes.length > 0) rawCallChunks.push({ json, parsed, callIndexes });
                if (!emitted && callIndexes.length === 0 && !finishReason && parts.length === 0) {
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                }

                if (finishReason && !sawDone) {
                    yield* flushFilter();
                    yield* settleToolCalls();
                    if (lastUsage && !usageEmitted) {
                        usageEmitted = true;
                        yield usageEvent();
                    }
                    sawDone = true;
                    maybeWarnDegenerate(finishReason);
                    const truncated = finishReason === "MAX_TOKENS";
                    if (sawRealToolCall) {
                        // A finish chunk that also carried the functionCall was
                        // already replayed by settleToolCalls; re-sending it
                        // verbatim would duplicate the call on the wire.
                        const finishChunk = parts.some((p) => p && typeof p === "object" && p.functionCall !== undefined)
                            ? sseFrame(cloneChunk(parsed, { parts: [] }))
                            : rawBuf;
                        yield { kind: "meta", chunk: finishChunk } as ParsedStreamEvent;
                        yield { kind: "done", finishReason, suppressCompletion: true, ...(truncated ? { truncated: true } : {}) } as ParsedStreamEvent;
                    } else {
                        yield { kind: "done", finishReason, ...(truncated ? { truncated: true } : {}) } as ParsedStreamEvent;
                    }
                }
            }

            // A stream that died mid-flight still has to hand the client the
            // usage it reported, and a held-back filter tail must not be lost.
            yield* flushFilter();
            if (!sawDone && lastUsage && !usageEmitted) {
                usageEmitted = true;
                yield usageEvent();
            }
        },

        emitText(delta) {
            return buildChunk([{ text: delta }]);
        },

        emitReasoning(delta) {
            return buildChunk([{ text: delta, thought: true }]);
        },

        emitToolCall(call: ToolCallEmit) {
            return buildChunk([{
                functionCall: {
                    name: call.name,
                    args: buildToolArgs(call.arguments),
                    ...(call.callId ? { id: call.callId } : {}),
                },
                ...(call.signature ? { thoughtSignature: call.signature } : {}),
            }]);
        },

        emitMarker(toolName, result) {
            return buildChunk([{ text: buildVisibilityMarker(toolName, result) }]);
        },

        emitCompletion(opts?: EmitCompletionOpts) {
            const usage = opts?.usage
                ? {
                      usageMetadata: {
                          promptTokenCount: opts.usage.inputTokens ?? 0,
                          candidatesTokenCount: opts.usage.outputTokens ?? 0,
                          totalTokenCount: (opts.usage.inputTokens ?? 0) + (opts.usage.outputTokens ?? 0),
                          ...(typeof opts.usage.cachedTokens === "number"
                              ? { cachedContentTokenCount: opts.usage.cachedTokens }
                              : {}),
                      },
                  }
                : {};
            return buildChunk([], { candidate: { finishReason: googleFinishReason(opts?.finishReason) }, top: usage });
        },

        emitError(message) {
            return sseFrame({ error: { code: 500, message, status: "INTERNAL" } });
        },
    };
}
