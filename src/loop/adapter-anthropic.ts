import type { CoreMessage } from "acp-kernel";
import { coreToAnthropic, extractSystem, buildSystem, type AnthropicRequestBody } from "acp-kernel/wire";
import { buildVisibilityMarker } from "../compress-loop.js";
import { createTagEchoFilter } from "./tag-echo-filter.js";
import { log as loggerLog } from "../logger.js";
import type {
    CompressLoopAdapter,
    EmitCompletionOpts,
    ParsedStreamEvent,
    ToolCallEmit,
} from "./core.js";

interface ToolUseBuffer {
    id: string;
    name: string;
    json: string;
}

async function* iterSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
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
            while ((idx = buf.indexOf("\n\n")) >= 0) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (raw.trim().length > 0) yield raw;
            }
        }
        if (buf.trim().length > 0) yield buf;
    } finally {
        reader.releaseLock();
    }
}

function parseAnthropicSse(eventStr: string): { type: string; data: Record<string, unknown> } | null {
    const lines = eventStr.split("\n");
    let type = "";
    const dataLines: string[] = [];
    for (const l of lines) {
        if (l.startsWith("event:")) type = l.slice(6).trim();
        else if (l.startsWith("data:")) dataLines.push(l.slice(5).replace(/^ /, ""));
    }
    if (!type) return null;
    const jsonStr = dataLines.join("\n").trim();
    if (!jsonStr) return { type, data: {} };
    try {
        return { type, data: JSON.parse(jsonStr) as Record<string, unknown> };
    } catch {
        return { type, data: {} };
    }
}

function remapIndexInEvent(eventStr: string, newIndex: number): Buffer {
    const lines = eventStr.split("\n");
    const rebuilt: string[] = [];
    let touched = false;
    for (const l of lines) {
        if (!touched && l.startsWith("data:")) {
            const jsonStr = l.slice(5).replace(/^ /, "");
            try {
                const obj = JSON.parse(jsonStr) as Record<string, unknown>;
                if (typeof obj === "object" && obj !== null && typeof obj.index === "number") {
                    obj.index = newIndex;
                    rebuilt.push(`data: ${JSON.stringify(obj)}`);
                    touched = true;
                    continue;
                }
            } catch {
            }
        }
        rebuilt.push(l);
    }
    return Buffer.from(rebuilt.join("\n") + "\n\n", "utf8");
}

function rewriteTextDeltaEvent(eventStr: string, newIndex: number, newText: string): Buffer {
    const lines = eventStr.split("\n");
    const rebuilt: string[] = [];
    for (const l of lines) {
        if (l.startsWith("data:")) {
            const jsonStr = l.slice(5).replace(/^ /, "");
            try {
                const obj = JSON.parse(jsonStr) as Record<string, unknown>;
                if (typeof obj === "object" && obj !== null && typeof obj.index === "number") {
                    obj.index = newIndex;
                    const d = obj.delta as Record<string, unknown> | undefined;
                    if (d && typeof d.text === "string") d.text = newText;
                    rebuilt.push(`data: ${JSON.stringify(obj)}`);
                    continue;
                }
            } catch {
            }
        }
        rebuilt.push(l);
    }
    return Buffer.from(rebuilt.join("\n") + "\n\n", "utf8");
}

function buildTextDeltaEvent(index: number, text: string): Buffer {
    return Buffer.from(
        `event: content_block_delta\n` +
        `data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } })}\n\n`,
        "utf8",
    );
}

export function createAnthropicAdapter(requestBody: Record<string, unknown>, originalSystem?: AnthropicRequestBody["system"]): CompressLoopAdapter {
    const model = (requestBody.model as string) ?? undefined;
    let messageId: string | undefined;
    let clientIndex = 0;
    let messageStartForwarded = false;
    const openBlocks: number[] = [];

    const removeOpenBlock = (index: number): void => {
        const i = openBlocks.indexOf(index);
        if (i >= 0) openBlocks.splice(i, 1);
    };

    // #413: emitError must terminate a well-formed stream even when the
    // upstream died before sending message_start — synthesize the start frame
    // so content blocks are never orphaned (strict clients reject them).
    const buildSyntheticMessageStart = (): Buffer => {
        const extra: Record<string, unknown> = {};
        if (model) extra.model = model;
        const msg: Record<string, unknown> = {
            id: messageId ?? `msg_acp_error_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            ...extra,
        };
        return Buffer.from(
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: msg })}\n\n`,
            "utf8",
        );
    };

    const buildTextBlock = (index: number, text: string): Buffer =>
        Buffer.from(
            `event: content_block_start\n` +
            `data: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n` +
            `event: content_block_delta\n` +
            `data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } })}\n\n` +
            `event: content_block_stop\n` +
            `data: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`,
            "utf8",
        );

    const buildToolUseBlock = (index: number, call: ToolCallEmit): Buffer =>
        Buffer.from(
            `event: content_block_start\n` +
            `data: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.callId, name: call.name, input: {} } })}\n\n` +
            `event: content_block_delta\n` +
            `data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: call.arguments } })}\n\n` +
            `event: content_block_stop\n` +
            `data: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`,
            "utf8",
        );

    const buildTerminal = (
        stopReason: string,
        outputTokens: number,
        inputTokens: number,
        cachedTokens: number,
    ): Buffer => {
        const usage: Record<string, unknown> = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cachedTokens,
        };
        const extra: Record<string, unknown> = {};
        if (messageId) extra.id = messageId;
        if (model) extra.model = model;
        return Buffer.from(
            `event: message_delta\n` +
            `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage, ...extra })}\n\n` +
            `event: message_stop\n` +
            `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
            "utf8",
        );
    };

    return {
        buildRequest(coreMessages, systemPrompt, body) {
            const messages = coreToAnthropic(coreMessages);
            const baseText = originalSystem !== undefined ? extractSystem(originalSystem) : "";
            const full = baseText ? `${baseText}\n\n---\n\n${systemPrompt}` : systemPrompt;
            const system = originalSystem !== undefined ? buildSystem(full, originalSystem) : full;
            return { ...body, system, messages };
        },

        async *parseStream(upstream, round) {
            const pending = new Map<number, ToolUseBuffer>();
            let roundInput: number | undefined;
            let roundCached: number | undefined;
            let roundOutput: number | undefined;
            let stopReason: string | undefined;
            let usageYielded = false;
            const indexMap = new Map<number, number>();
            const thinkingIndexes = new Set<number>();
            // #206: strip model-imitated render tags from text deltas before
            // they reach the client (and before coreText accumulates them for
            // re-request rounds). Flush at the owning block's stop so held-back
            // fragments still emit while the block is open.
            const tagFilter = createTagEchoFilter((snippet) => {
                loggerLog("warn", `[tag-echo] stripped model-emitted render tag: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
            });
            let lastTextIndex: number | null = null;

            for await (const eventStr of iterSseEvents(upstream)) {
                const parsed = parseAnthropicSse(eventStr);
                if (!parsed) continue;
                const { type, data } = parsed;
                const rawBuf = Buffer.from(eventStr + "\n\n", "utf8");

                if (type === "message_start") {
                    const msg = (data.message ?? {}) as Record<string, unknown>;
                    if (typeof msg.id === "string" && !messageId) messageId = msg.id;
                    const u = (msg.usage ?? {}) as Record<string, unknown>;
                    if (typeof u.input_tokens === "number") roundInput = u.input_tokens;
                    if (typeof u.cache_read_input_tokens === "number") roundCached = u.cache_read_input_tokens;
                    if (round === 1) {
                        messageStartForwarded = true;
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "ping") {
                    yield { kind: "meta", chunk: rawBuf } as ParsedStreamEvent;
                } else if (type === "content_block_start") {
                    const upstreamIndex = (data.index as number) ?? 0;
                    const block = (data.content_block ?? {}) as Record<string, unknown>;
                    if (block.type === "tool_use") {
                        const name = typeof block.name === "string" ? block.name : "";
                        const id = typeof block.id === "string" ? block.id : `toolu_${upstreamIndex}`;
                        pending.set(upstreamIndex, { id, name, json: "" });
                    } else {
                        if (block.type === "thinking" || block.type === "redacted_thinking") thinkingIndexes.add(upstreamIndex);
                        const ci = clientIndex++;
                        indexMap.set(upstreamIndex, ci);
                        openBlocks.push(ci);
                        yield { kind: "meta", chunk: remapIndexInEvent(eventStr, ci), firstRoundOnly: round === 1 } as ParsedStreamEvent;
                    }
                } else if (type === "content_block_delta") {
                    const upstreamIndex = (data.index as number) ?? 0;
                    const delta = (data.delta ?? {}) as Record<string, unknown>;
                    if (pending.has(upstreamIndex)) {
                        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                            pending.get(upstreamIndex)!.json += delta.partial_json;
                        }
                    } else if (delta.type === "text_delta" && typeof delta.text === "string") {
                        const ci = indexMap.get(upstreamIndex) ?? upstreamIndex;
                        lastTextIndex = ci;
                        const clean = tagFilter.push(delta.text);
                        if (clean.length > 0) {
                            const raw = clean === delta.text ? remapIndexInEvent(eventStr, ci) : rewriteTextDeltaEvent(eventStr, ci, clean);
                            yield { kind: "text", delta: clean, raw } as ParsedStreamEvent;
                        }
                    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
                        const ci = indexMap.get(upstreamIndex) ?? upstreamIndex;
                        yield {
                            kind: "reasoning",
                            delta: delta.thinking,
                            raw: remapIndexInEvent(eventStr, ci),
                        } as ParsedStreamEvent;
                    } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
                        const ci = indexMap.get(upstreamIndex) ?? upstreamIndex;
                        yield {
                            kind: "reasoning",
                            delta: "",
                            signature: delta.signature,
                            raw: remapIndexInEvent(eventStr, ci),
                        } as ParsedStreamEvent;
                    } else if (round === 1) {
                        const ci = indexMap.get(upstreamIndex) ?? upstreamIndex;
                        yield { kind: "meta", chunk: remapIndexInEvent(eventStr, ci), firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "content_block_stop") {
                    const upstreamIndex = (data.index as number) ?? 0;
                    const tb = pending.get(upstreamIndex);
                    if (tb) {
                        pending.delete(upstreamIndex);
                        yield {
                            kind: "tool_call",
                            name: tb.name,
                            callId: tb.id,
                            arguments: tb.json,
                        } as ParsedStreamEvent;
                    } else if (thinkingIndexes.delete(upstreamIndex)) {
                        // Seal the current thinking segment so interleaved thinking
                        // blocks each keep their own signature on rebuild.
                        const ci = indexMap.get(upstreamIndex) ?? upstreamIndex;
                        removeOpenBlock(ci);
                        yield { kind: "meta", chunk: remapIndexInEvent(eventStr, ci), firstRoundOnly: false } as ParsedStreamEvent;
                        yield { kind: "reasoning", delta: "", blockEnd: true } as ParsedStreamEvent;
                    } else {
                        const ci = indexMap.get(upstreamIndex) ?? upstreamIndex;
                        removeOpenBlock(ci);
                        if (lastTextIndex !== null) {
                            const tail = tagFilter.flush();
                            if (tail.length > 0) {
                                yield { kind: "text", delta: tail, raw: buildTextDeltaEvent(lastTextIndex, tail) } as ParsedStreamEvent;
                            }
                            lastTextIndex = null;
                        }
                        yield { kind: "meta", chunk: remapIndexInEvent(eventStr, ci), firstRoundOnly: round === 1 } as ParsedStreamEvent;
                    }
                } else if (type === "message_delta") {
                    const u = (data.usage ?? {}) as Record<string, unknown>;
                    if (typeof u.output_tokens === "number") roundOutput = u.output_tokens;
                    const input = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
                    const cached = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined;
                    if (input !== undefined && input > 0 && cached !== undefined) {
                        // Complete authoritative usage object — e.g. the synthetic
                        // terminal of a stitched multi-round stream (round1
                        // message_start + final-round terminal). Adopt atomically so
                        // the final round's cache_read — legitimately 0 after a
                        // compress re-request — overwrites the stale value carried by
                        // an earlier round's message_start. Per-field merging would
                        // double-count (new input + old cache) and trip false
                        // EMERGENCY nudges (issue #299).
                        roundInput = input;
                        roundCached = cached;
                    } else {
                        // Incomplete usage object: the input context is FIXED within
                        // a turn, so message_start is authoritative for input/cache
                        // tokens. Some relays echo a schema-shaped `usage` in
                        // message_delta with `input_tokens: 0` (the field is normally
                        // absent); adopting a 0 would overwrite message_start's real
                        // value and under-report the context size (→ nudge/compression
                        // never fires, cache hit rate collapses). A 0 can never be a
                        // legitimate update, so adopt only > 0.
                        if (input !== undefined && input > 0) roundInput = input;
                        if (cached !== undefined && cached > 0) roundCached = cached;
                    }
                    const d = (data.delta ?? {}) as Record<string, unknown>;
                    if (typeof d.stop_reason === "string") stopReason = d.stop_reason;
                    if (!usageYielded) {
                        usageYielded = true;
                        yield {
                            kind: "usage",
                            inputTokens: roundInput,
                            outputTokens: roundOutput,
                            cachedTokens: roundCached,
                        } as ParsedStreamEvent;
                    }
                    yield { kind: "done", finishReason: stopReason } as ParsedStreamEvent;
                } else if (type === "message_stop") {
                    if (lastTextIndex !== null) {
                        const tail = tagFilter.flush();
                        if (tail.length > 0) {
                            yield { kind: "text", delta: tail, raw: buildTextDeltaEvent(lastTextIndex, tail) } as ParsedStreamEvent;
                        }
                        lastTextIndex = null;
                    }
                    if (!usageYielded) {
                        usageYielded = true;
                        yield {
                            kind: "usage",
                            inputTokens: roundInput,
                            outputTokens: roundOutput,
                            cachedTokens: roundCached,
                        } as ParsedStreamEvent;
                    }
                    yield { kind: "done", finishReason: stopReason ?? "end_turn" } as ParsedStreamEvent;
                } else if (round === 1) {
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                }
            }
        },

        emitText(delta) {
            return buildTextBlock(clientIndex++, delta);
        },
        emitReasoning(delta) {
            const index = clientIndex++;
            return Buffer.from(
                `event: content_block_start\n` +
                `data: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } })}\n\n` +
                `event: content_block_delta\n` +
                `data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: delta } })}\n\n` +
                `event: content_block_stop\n` +
                `data: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`,
                "utf8",
            );
        },


        emitToolCall(call) {
            return buildToolUseBlock(clientIndex++, call);
        },

        emitMarker(toolName, result) {
            return buildTextBlock(clientIndex++, buildVisibilityMarker(toolName, result));
        },

        emitCompletion(opts?: EmitCompletionOpts) {
            const stopReason = opts?.finishReason ?? "end_turn";
            return buildTerminal(
                stopReason,
                opts?.usage?.outputTokens ?? 0,
                opts?.usage?.inputTokens ?? 0,
                opts?.usage?.cachedTokens ?? 0,
            );
        },

        emitError(message) {
            const parts: Buffer[] = [];
            if (!messageStartForwarded) {
                parts.push(buildSyntheticMessageStart());
                messageStartForwarded = true;
            }
            for (const index of openBlocks.splice(0)) {
                parts.push(Buffer.from(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`, "utf8"));
            }
            parts.push(buildTextBlock(clientIndex++, `\n[acp-proxy: ${message}]\n`));
            parts.push(buildTerminal("end_turn", 0, 0, 0));
            return Buffer.concat(parts);
        },
    };
}
