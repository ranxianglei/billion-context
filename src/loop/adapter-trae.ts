// #1295: compress-loop adapter for the TRAE SOLO wire. The stream is an SSE
// dialect — \`event:<name>\` / \`data:<json>\` with NO space after the colon and no
// [DONE] sentinel (WC-12c); the done frame is the terminator. Reuses the
// openai adapter's request building because the loop always speaks flat
// OpenAI internally, then restores the envelope at the wire boundary.

import { createOpenaiAdapter } from "./adapter-openai.js";
import { buildVisibilityMarker } from "./core.js";
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

interface ToolBuffer {
    id: string;
    name: string;
    arguments: string;
}

interface SseFrame {
    event: string;
    data: string;
}

async function* iterSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let event = "";
    let data: string[] = [];
    const flush = (): SseFrame | undefined => {
        const frame = data.length > 0 ? { event, data: data.join("\n") } : undefined;
        event = "";
        data = [];
        return frame;
    };
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
            buf = buf.replace(/\r\n|\r/g, "\n");
            let idx: number;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                if (line.length === 0) {
                    const frame = flush();
                    if (frame !== undefined) yield frame;
                    continue;
                }
                if (line.startsWith("event:")) {
                    event = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                    data.push(line.slice(5));
                }
            }
        }
        const last = flush();
        if (last !== undefined) yield last;
    } finally {
        try {
            reader.releaseLock();
        } catch { /* already released */ }
    }
}

function frameBuf(event: string, payload: Record<string, unknown>): Buffer {
    return Buffer.from("event:" + event + "\ndata:" + JSON.stringify(payload) + "\n\n", "utf8");
}

function rawFrame(frame: SseFrame): Buffer {
    return Buffer.from("event:" + frame.event + "\ndata:" + frame.data + "\n\n", "utf8");
}

function rewriteFrame(frame: SseFrame, patch: Record<string, unknown>): Buffer {
    const parsed = JSON.parse(frame.data) as Record<string, unknown>;
    return frameBuf(frame.event, { ...parsed, ...patch });
}

function outputPayload(extra: Record<string, unknown>): Record<string, unknown> {
    return {
        response: "",
        reasoning_content: null,
        tool_calls: null,
        multimodal_contents: null,
        phase: null,
        ...extra,
    };
}

export function createTraeAdapter(
    requestBody: Record<string, unknown>,
    clientSystem?: string,
    absorbName?: string,
    notes?: string[],
): CompressLoopAdapter {
    const base = createOpenaiAdapter(requestBody, clientSystem, absorbName, notes);
    return {
        ...base,

        async *parseStream(upstream: ReadableStream<Uint8Array>, round: number): AsyncGenerator<ParsedStreamEvent> {
            const tagFilter = composeStreamFilters(createTagEchoFilter((snippet) => {
                loggerLog("warn", "[tag-echo] stripped model-emitted render tag (trae proxy mode): " + snippet.slice(0, 80).replace(/\n/g, " "));
            }), createMarkerLineFilter());
            let sawReasoning = false;
            let sawRealToolCall = false;
            let visibleTextChars = 0;
            let toolCallsEmitted = 0;
            let finalFinishReason: string | undefined;
            const pending = new Map<number, ToolBuffer>();

            for await (const frame of iterSseFrames(upstream)) {
                if (frame.event !== "output" && frame.event !== "token_usage" && frame.event !== "done" && frame.event !== "error") {
                    // WC-12c: metadata / timing_cost / extra_info and any future
                    // frame type — forward verbatim in round 1 only so synthetic
                    // rounds do not replay upstream frames.
                    if (round === 1) yield { kind: "meta", chunk: rawFrame(frame), firstRoundOnly: true } as ParsedStreamEvent;
                    continue;
                }
                let ev: Record<string, unknown>;
                try {
                    ev = JSON.parse(frame.data) as Record<string, unknown>;
                } catch {
                    // WC-12e: undecodable frame — forward verbatim in round 1
                    // only, never fabricate meaning.
                    if (round === 1) yield { kind: "meta", chunk: rawFrame(frame), firstRoundOnly: true } as ParsedStreamEvent;
                    continue;
                }
                if (frame.event === "output") {
                    const calls = ev.tool_calls;
                    if (Array.isArray(calls)) {
                        for (const c of calls) {
                            if (c === null || typeof c !== "object" || Array.isArray(c)) continue;
                            const tc = c as Record<string, unknown>;
                            const idx = typeof tc.index === "number" ? tc.index : 0;
                            let buf = pending.get(idx);
                            if (buf === undefined) {
                                buf = { id: "", name: "", arguments: "" };
                                pending.set(idx, buf);
                            }
                            if (typeof tc.id === "string" && tc.id.length > 0) buf.id = tc.id;
                            const fn = tc.function_call;
                            if (fn !== null && typeof fn === "object" && !Array.isArray(fn)) {
                                const f = fn as Record<string, unknown>;
                                if (typeof f.name === "string" && f.name.length > 0) buf.name = f.name;
                                if (typeof f.arguments === "string") buf.arguments += f.arguments;
                            }
                        }
                    }
                    if (typeof ev.response === "string" && ev.response.length > 0) {
                        const clean = tagFilter.push(ev.response);
                        visibleTextChars += clean.length;
                        if (clean.length > 0) {
                            yield {
                                kind: "text",
                                delta: clean,
                                raw: clean === ev.response ? rawFrame(frame) : rewriteFrame(frame, { response: clean }),
                            } as ParsedStreamEvent;
                        }
                    }
                    if (typeof ev.reasoning_content === "string" && ev.reasoning_content.length > 0) {
                        sawReasoning = true;
                        yield { kind: "reasoning", delta: ev.reasoning_content, raw: rawFrame(frame) } as ParsedStreamEvent;
                    }
                    continue;
                }
                if (frame.event === "token_usage") {
                    // WC-12f: the *_total fields are always 0 upstream; only the
                    // per-request counters carry meaning.
                    yield {
                        kind: "usage",
                        inputTokens: typeof ev.prompt_tokens === "number" ? ev.prompt_tokens : undefined,
                        outputTokens: typeof ev.completion_tokens === "number" ? ev.completion_tokens : undefined,
                        cachedTokens: typeof ev.cache_read_input_tokens === "number" ? ev.cache_read_input_tokens : undefined,
                    } as ParsedStreamEvent;
                    continue;
                }
                if (frame.event === "error") {
                    const message = typeof ev.message === "string" ? ev.message
                        : typeof ev.error === "string" ? ev.error
                            : "upstream error";
                    yield { kind: "error", message } as ParsedStreamEvent;
                    return;
                }
                const tail = tagFilter.flush();
                if (tail.length > 0) {
                    visibleTextChars += tail.length;
                    yield { kind: "text", delta: tail, raw: frameBuf("output", outputPayload({ response: tail })) } as ParsedStreamEvent;
                }
                sawRealToolCall = false;
                for (const tc of pending.values()) {
                    if (tc.name.length === 0) continue;
                    toolCallsEmitted++;
                    if (!PROXY_TOOL_SET.has(tc.name) && tc.name !== absorbName) sawRealToolCall = true;
                }
                for (const tc of pending.values()) {
                    if (tc.name.length === 0) continue;
                    yield { kind: "tool_call", name: tc.name, callId: tc.id, arguments: tc.arguments } as ParsedStreamEvent;
                }
                pending.clear();
                finalFinishReason = typeof ev.finish_reason === "string" ? ev.finish_reason : undefined;
                if (!sawRealToolCall) {
                    const st = tagFilter.stats();
                    const msg = degenerateTurnWarning({
                        reason: finalFinishReason,
                        terminalReason: "stop",
                        toolCalls: toolCallsEmitted,
                        text: { inputChars: st.inputChars, outputChars: visibleTextChars, dropped: st.dropped, dropCount: st.dropCount },
                        sawThinking: sawReasoning,
                        wire: "trae-proxy",
                    });
                    if (msg) loggerLog("warn", msg);
                }
                yield { kind: "done", finishReason: finalFinishReason ?? "stop", thinking: sawReasoning, ...(sawRealToolCall ? { suppressCompletion: true } : {}) } as ParsedStreamEvent;
                return;
            }
        },

        emitText(delta: string): Buffer {
            return frameBuf("output", outputPayload({ response: delta }));
        },

        emitReasoning(delta: string): Buffer {
            return frameBuf("output", outputPayload({ reasoning_content: delta }));
        },

        emitToolCall(call: ToolCallEmit): Buffer {
            return frameBuf("output", outputPayload({
                tool_calls: [{
                    index: 0,
                    id: call.callId,
                    type: "function",
                    function_call: {
                        name: call.name,
                        arguments: call.arguments,
                        partial_arguments: null,
                        namespace: null,
                    },
                }],
            }));
        },

        emitMarker(toolName, result) {
            // WC-12g: the marker rides as prose inside an output frame.
            return frameBuf("output", outputPayload({ response: buildVisibilityMarker(toolName, result) }));
        },

        emitCompletion(opts?: EmitCompletionOpts): Buffer {
            const u = opts?.usage;
            // Numeric fields must never be absent: dsh's mapUsage computes over
            // them and a missing field yields NaN (same rule as adapter-openai).
            const usage = frameBuf("token_usage", {
                name: "",
                prompt_tokens: u?.inputTokens ?? 0,
                completion_tokens: u?.outputTokens ?? 0,
                total_tokens: (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0),
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: u?.cachedTokens ?? 0,
                reasoning_tokens: 0,
                prompt_tokens_total: 0,
                completion_tokens_total: 0,
                total_tokens_total: 0,
                cache_creation_input_tokens_total: 0,
                cache_read_input_tokens_total: 0,
                reasoning_tokens_total: 0,
            });
            const done = frameBuf("done", { finish_reason: opts?.finishReason ?? "stop" });
            return Buffer.concat([usage, done]);
        },

        emitError(message: string): Buffer {
            return frameBuf("error", { message });
        },
    };
}
