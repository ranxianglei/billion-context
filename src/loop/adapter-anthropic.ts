import type { CoreMessage } from "acp-kernel";
import { coreToAnthropic } from "../anthropic.js";
import { buildVisibilityMarker } from "../compress-loop.js";
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
    let buf = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += new TextDecoder().decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (raw.trim().length > 0) yield raw.replace(/\r\n/g, "\n");
            }
        }
        if (buf.trim().length > 0) yield buf.replace(/\r\n/g, "\n");
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

export function createAnthropicAdapter(requestBody: Record<string, unknown>): CompressLoopAdapter {
    const model = (requestBody.model as string) ?? undefined;
    let messageId: string | undefined;
    let clientIndex = 0;

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
            return { ...body, system: systemPrompt, messages };
        },

        async *parseStream(upstream, round) {
            const pending = new Map<number, ToolUseBuffer>();
            let roundInput: number | undefined;
            let roundCached: number | undefined;
            let roundOutput: number | undefined;
            let stopReason: string | undefined;
            let usageYielded = false;

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
                    } else if (round === 1) {
                        clientIndex += 1;
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "content_block_delta") {
                    const upstreamIndex = (data.index as number) ?? 0;
                    const delta = (data.delta ?? {}) as Record<string, unknown>;
                    if (pending.has(upstreamIndex)) {
                        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                            pending.get(upstreamIndex)!.json += delta.partial_json;
                        }
                    } else if (delta.type === "text_delta" && typeof delta.text === "string") {
                        if (round === 1) {
                            yield { kind: "text", delta: delta.text, raw: rawBuf } as ParsedStreamEvent;
                        } else {
                            yield { kind: "text", delta: delta.text } as ParsedStreamEvent;
                        }
                    } else if (round === 1) {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
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
                    } else if (round === 1) {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "message_delta") {
                    const u = (data.usage ?? {}) as Record<string, unknown>;
                    if (typeof u.output_tokens === "number") roundOutput = u.output_tokens;
                    if (typeof u.input_tokens === "number") roundInput = u.input_tokens;
                    if (typeof u.cache_read_input_tokens === "number") roundCached = u.cache_read_input_tokens;
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
            const errBlock = buildTextBlock(clientIndex++, `\n[acp-proxy: ${message}]\n`);
            return Buffer.concat([errBlock, buildTerminal("end_turn", 0, 0, 0)]);
        },
    };
}
