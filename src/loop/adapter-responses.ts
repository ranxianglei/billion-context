import type { CoreMessage } from "acp-kernel";
import { coreToResponses, injectResponsesDeveloperMessage, patchResponsesInput, type ResponseInputItem, type ResponsesProjection } from "../responses.js";
import { buildVisibilityMarker } from "../compress-loop.js";
import { ACP_TEXT_OPEN, ACP_TEXT_CLOSE, ACP_STATUS_OPEN, ACP_STATUS_CLOSE, ACP_SEARCH_OPEN, ACP_SEARCH_CLOSE, ACP_DECOMPRESS_OPEN, ACP_DECOMPRESS_CLOSE, COMPRESS_TOOL_NAME } from "../compress-tool.js";
import type { BiliMessage } from "../bili-message.js";
import type {
    CompressLoopAdapter,
    EmitCompletionOpts,
    ExtractedTextTriggers,
    ParsedStreamEvent,
    ToolCallEmit,
} from "./core.js";

interface FunctionCallBuffer {
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
}

async function* iterSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
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
            buf += new TextDecoder().decode(value, { stream: true });
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

function extractEventType(rawEvent: string): string | null {
    for (const l of rawEvent.split("\n")) {
        if (l.startsWith("event:")) return l.slice(6).trim();
    }
    return null;
}

function extractDataLine(rawEvent: string): string | null {
    const parts: string[] = [];
    for (const l of rawEvent.split("\n")) {
        if (l.startsWith("data:")) {
            let v = l.slice(5);
            if (v.startsWith(" ")) v = v.slice(1);
            parts.push(v);
        }
    }
    return parts.length ? parts.join("\n") : null;
}

function buildMessageItemSequence(itemId: string, outputIndex: number, text: string): Buffer {
    const item = { type: "message", id: itemId, role: "assistant", content: [] as unknown[] };
    const part = { type: "output_text", text: "" };
    const doneItem = {
        type: "message",
        id: itemId,
        role: "assistant",
        content: [{ type: "output_text", text }],
    };
    return Buffer.from(
        [
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: outputIndex, item })}\n\n`,
            `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: itemId, output_index: outputIndex, part })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: itemId, output_index: outputIndex, delta: text })}\n\n`,
            `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: itemId, output_index: outputIndex, text })}\n\n`,
            `event: response.content_part.done\ndata: ${JSON.stringify({ type: "response.content_part.done", item_id: itemId, output_index: outputIndex, part: { type: "output_text", text } })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: outputIndex, item: doneItem })}\n\n`,
        ].join(""),
        "utf8",
    );
}

function buildFunctionCallEvents(fc: ToolCallEmit, itemId: string, outputIndex: number): Buffer {
    return Buffer.from(
        [
            `event: response.output_item.added\ndata: ${JSON.stringify({
                type: "response.output_item.added",
                output_index: outputIndex,
                item: { type: "function_call", id: itemId, call_id: fc.callId, name: fc.name, arguments: "" },
            })}\n\n`,
            `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
                type: "response.function_call_arguments.delta",
                item_id: itemId,
                delta: fc.arguments,
            })}\n\n`,
            `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
                type: "response.function_call_arguments.done",
                item_id: itemId,
                arguments: fc.arguments,
            })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({
                type: "response.output_item.done",
                output_index: outputIndex,
                item: { type: "function_call", id: itemId, call_id: fc.callId, name: fc.name, arguments: fc.arguments },
            })}\n\n`,
        ].join(""),
        "utf8",
    );
}

function buildCompleted(responseObj: Record<string, unknown> | null): Buffer {
    const resp = responseObj ?? { id: `resp-proxy-${Date.now()}`, status: "completed", output: [] };
    return Buffer.from(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: resp })}\n\n`,
        "utf8",
    );
}

export function createResponsesAdapter(textProtocol?: boolean, projection?: ResponsesProjection): CompressLoopAdapter {
    const suppressTextLifecycle = !!textProtocol;
    let outputIndex = 0;
    let responseObj: Record<string, unknown> | null = null;
    let terminalRaw: Buffer | null = null;
    let terminalKind: string | null = null;

    return {
        buildRequest(coreMessages, systemPrompt, requestBody) {
            const customToolCallIds = new Set<string>();
            for (const m of coreMessages) {
                const bm = m as BiliMessage;
                const raw = bm?.rawResponsesItem as Record<string, unknown> | undefined;
                if (raw && (raw.type === "custom_tool_call" || raw.type === "custom_tool_call_output")) {
                    const id = typeof raw.call_id === "string" ? raw.call_id : (typeof raw.id === "string" ? raw.id : "");
                    if (id) customToolCallIds.add(id);
                }
            }
            let inputItems: ResponseInputItem[];
            if (projection) {
                const rebuiltInput = patchResponsesInput(projection, coreMessages);
                inputItems = typeof rebuiltInput === "string"
                    ? [{ type: "message", role: "user", content: rebuiltInput }]
                    : rebuiltInput;
            } else {
                inputItems = coreToResponses(coreMessages, customToolCallIds);
            }
            const devParts = projection && projection.systemParts.length > 0
                ? [...projection.systemParts, systemPrompt]
                : [systemPrompt];
            const withDev = injectResponsesDeveloperMessage(inputItems, devParts.join("\n\n---\n\n"));
            const rebuilt: Record<string, unknown> = { ...requestBody, input: withDev };
            if (process.env.ACP_KEEP_RESPONSE_ID !== "1") delete rebuilt.previous_response_id;
            delete rebuilt.instructions;
            return rebuilt;
        },

        async *parseStream(upstream, round) {
            const pending = new Map<string, FunctionCallBuffer>();
            for await (const eventStr of iterSseEvents(upstream)) {
                const type = extractEventType(eventStr);
                const dataLine = extractDataLine(eventStr);
                if (!type || !dataLine) continue;
                let obj: Record<string, unknown>;
                try {
                    obj = JSON.parse(dataLine);
                } catch {
                    continue;
                }
                const rawBuf = Buffer.from(eventStr + "\n\n", "utf8");
                if (round === 1 && typeof obj.output_index === "number") {
                    outputIndex = Math.max(outputIndex, obj.output_index + 1);
                }

                if (type === "response.created" || type === "response.in_progress") {
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                } else if (type === "response.output_item.added") {
                    const item = obj.item as Record<string, unknown> | undefined;
                    if (item?.type === "function_call") {
                        const itemId = typeof item.id === "string" ? item.id : "";
                        pending.set(itemId, {
                            itemId,
                            callId: typeof item.call_id === "string" ? item.call_id : "",
                            name: typeof item.name === "string" ? item.name : "",
                            arguments: "",
                        });
                    } else if (item?.type === "custom_tool_call") {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                    } else if (item?.type !== "message" || !suppressTextLifecycle) {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (
                    type === "response.content_part.added" ||
                    type === "response.content_part.done" ||
                    type === "response.output_text.done"
                ) {
                    if (!suppressTextLifecycle) {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "response.output_text.delta") {
                    const delta = typeof obj.delta === "string" ? obj.delta : "";
                    if (delta.length > 0) {
                        yield { kind: "text", delta, raw: rawBuf } as ParsedStreamEvent;
                    }
                } else if (type === "response.function_call_arguments.delta") {
                    const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
                    const delta = typeof obj.delta === "string" ? obj.delta : "";
                    const fc = pending.get(itemId);
                    if (fc) fc.arguments += delta;
                } else if (type === "response.function_call_arguments.done") {
                    const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
                    const args = typeof obj.arguments === "string" ? obj.arguments : "";
                    const fc = pending.get(itemId);
                    if (fc && args) fc.arguments = args;
                } else if (type === "response.output_item.done") {
                    const item = obj.item as Record<string, unknown> | undefined;
                    if (item?.type === "function_call") {
                        const itemId = typeof item.id === "string" ? item.id : "";
                        const fc = pending.get(itemId);
                        if (fc) {
                            if (typeof item.arguments === "string" && item.arguments) fc.arguments = item.arguments;
                            pending.delete(itemId);
                            yield {
                                kind: "tool_call",
                                name: fc.name,
                                callId: fc.callId,
                                arguments: fc.arguments,
                            } as ParsedStreamEvent;
                        }
                    } else if (item?.type === "custom_tool_call") {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                    } else if (item?.type !== "message" || !suppressTextLifecycle) {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "response.completed") {
                    responseObj = (obj.response as Record<string, unknown>) ?? null;
                    terminalKind = "completed";
                    terminalRaw = null;
                    const respUsage = (responseObj as Record<string, unknown> | null)?.usage as
                        | Record<string, unknown>
                        | undefined;
                    const pd = respUsage?.input_tokens_details as Record<string, unknown> | undefined;
                    yield {
                        kind: "usage",
                        inputTokens: typeof respUsage?.input_tokens === "number" ? respUsage.input_tokens : undefined,
                        outputTokens: typeof respUsage?.output_tokens === "number" ? respUsage.output_tokens : undefined,
                        cachedTokens: typeof pd?.cached_tokens === "number" ? pd.cached_tokens : undefined,
                    } as ParsedStreamEvent;
                    yield { kind: "done", finishReason: "completed" } as ParsedStreamEvent;
                } else if (type === "response.incomplete") {
                    terminalKind = "incomplete";
                    terminalRaw = rawBuf;
                    yield { kind: "done", finishReason: "incomplete" } as ParsedStreamEvent;
                } else if (type === "response.failed" || type === "response.error") {
                    terminalKind = "failed";
                    terminalRaw = rawBuf;
                    yield { kind: "done", finishReason: "failed" } as ParsedStreamEvent;
                } else {
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                }
            }
            if (!terminalKind) {
                yield { kind: "done", finishReason: "failed" } as ParsedStreamEvent;
            }
        },

        emitText(delta) {
            return buildMessageItemSequence(`msg-proxy-${Date.now()}-${outputIndex}`, outputIndex++, delta);
        },

        emitToolCall(call) {
            const buf = buildFunctionCallEvents(call, `fc-proxy-${Date.now()}-${outputIndex}`, outputIndex);
            outputIndex += 1;
            return buf;
        },

        emitMarker(toolName, result) {
            return buildMessageItemSequence(
                `marker-${Date.now()}-${outputIndex}`,
                outputIndex++,
                buildVisibilityMarker(toolName, result),
            );
        },

        emitCompletion(opts?: EmitCompletionOpts) {
            if (terminalRaw && (terminalKind === "failed" || terminalKind === "incomplete")) {
                return terminalRaw;
            }
            if (!responseObj && opts?.finishReason === "failed") {
                const failed = {
                    id: `resp-error-${Date.now()}`,
                    status: "failed",
                    error: { code: "server_error", message: "upstream returned no response" },
                };
                return Buffer.from(
                    `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: failed })}\n\n`,
                    "utf8",
                );
            }
            let resp = responseObj
                ? ({ ...responseObj } as Record<string, unknown>)
                : { id: `resp-proxy-${Date.now()}`, status: "completed", output: [] };
            if (opts?.usage) {
                const usage: Record<string, unknown> = {
                    ...(typeof (resp as Record<string, unknown>).usage === "object"
                        ? ((resp as Record<string, unknown>).usage as Record<string, unknown>)
                        : {}),
                };
                if (typeof opts.usage.inputTokens === "number") usage.input_tokens = opts.usage.inputTokens;
                if (typeof opts.usage.outputTokens === "number") usage.output_tokens = opts.usage.outputTokens;
                if (typeof opts.usage.cachedTokens === "number") {
                    usage.input_tokens_details = {
                        ...((usage.input_tokens_details as Record<string, unknown>) ?? {}),
                        cached_tokens: opts.usage.cachedTokens,
                    };
                }
                resp = { ...resp, usage };
            }
            return buildCompleted(resp);
        },

        emitError(message) {
            const resp = {
                id: `resp-error-${Date.now()}`,
                status: "failed",
                error: { code: "server_error", message },
            };
            return Buffer.from(
                `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: resp })}\n\n`,
                "utf8",
            );
        },

        extractTextTriggers(text) {
            const calls: ToolCallEmit[] = [];
            let clean = text;
            let hadTrigger = false;
            const triggers = [
                { name: "compress", open: ACP_TEXT_OPEN, close: ACP_TEXT_CLOSE, requirePayload: true },
                { name: "acp_status", open: ACP_STATUS_OPEN, close: ACP_STATUS_CLOSE, requirePayload: false },
                { name: "search_context", open: ACP_SEARCH_OPEN, close: ACP_SEARCH_CLOSE, requirePayload: true },
                { name: "decompress", open: ACP_DECOMPRESS_OPEN, close: ACP_DECOMPRESS_CLOSE, requirePayload: true },
            ];
            for (const t of triggers) {
                let start = clean.indexOf(t.open);
                while (start >= 0) {
                    const end = clean.indexOf(t.close, start + t.open.length);
                    if (end < 0) break;
                    hadTrigger = true;
                    const payload = clean.slice(start + t.open.length, end).trim();
                    if (payload.length > 0 || !t.requirePayload) {
                        const stamp = `${Date.now()}-${calls.length}`;
                        calls.push({
                            name: t.name,
                            callId: `call_text_${stamp}`,
                            arguments: payload.length > 0 ? payload : "{}",
                        });
                    }
                    clean = clean.slice(0, start) + clean.slice(end + t.close.length);
                    start = clean.indexOf(t.open);
                }
            }
            return { clean: hadTrigger ? clean : text, calls } as ExtractedTextTriggers;
        },
    };
}
