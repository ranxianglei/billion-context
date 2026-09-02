import type { CoreMessage } from "acp-kernel";
import { coreToResponses, injectResponsesDeveloperMessage, patchResponsesInput, type ResponseInputItem, type ResponsesProjection } from "acp-kernel/wire";
import { buildVisibilityMarker } from "../compress-loop.js";
import { hashId } from "../util.js";
import { createTagEchoFilter, stripResponsesText, containsRenderTagText } from "./tag-echo-filter.js";
import { log as loggerLog } from "../logger.js";
import { ACP_TEXT_OPEN, ACP_TEXT_CLOSE, ACP_STATUS_OPEN, ACP_STATUS_CLOSE, ACP_SEARCH_OPEN, ACP_SEARCH_CLOSE, ACP_DECOMPRESS_OPEN, ACP_DECOMPRESS_CLOSE, COMPRESS_TOOL_NAME, PROXY_TOOL_NAMES } from "../compress-tool.js";
import type { BiliMessage } from "acp-kernel/wire";
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

// Upstream rejects Responses input item ids longer than 64 chars. All
// proxy-synthesized ids stay well below this cap (#242).
const RESPONSES_ITEM_ID_MAX = 64;

/**
 * Heal client rollouts already poisoned with over-long ids (they 400 every
 * request otherwise). Rewrites in place, deterministically, so repeated
 * requests keep referencing the same replacement id (#242).
 */
export function normalizeResponsesMessageItems(input: unknown): number {
    if (!Array.isArray(input)) return 0;
    let typed = 0;
    for (const item of input) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        if (rec["type"] !== undefined) continue;
        if (rec["role"] !== "user" && rec["role"] !== "assistant") continue;
        if (rec["content"] === undefined) continue;
        // omp (pi-ai) sends user items without the spec-required "type" field;
        // responsesToCore switches on item.type and silently drops type-less
        // items, so user prompts never enter the kernel (no refs, never
        // compressible, invisible to nudge/preflight). Stamp the standard
        // type at ingress.
        rec["type"] = "message";
        typed++;
    }
    return typed;
}

export function sanitizeResponsesInputIds(input: unknown): void {
    if (!Array.isArray(input)) return;
    for (const item of input) {
        const rec = item as Record<string, unknown>;
        if (typeof rec?.id === "string" && rec.id.length > RESPONSES_ITEM_ID_MAX) {
            rec.id = `msg-fix-${hashId(rec.id)}`;
        }
    }
}

/**
 * Responses input flattens a mixed assistant turn (text + tool calls) into
 * separate items, so the whitespace-only text deltas SGLang/vllm-class models
 * emit before tool calls land as standalone 1-2 token message items (omp
 * serializes exactly this shape). Left alone, every one gets an acp render
 * tag — a 42-token wrapper around pure whitespace — and burns a message ref
 * the model later has to reason about. Content-free by definition, so drop
 * them before projection; deterministic per request, keeping refs stable.
 */
export function dropWhitespaceResponsesMessages(input: unknown): number {
    if (!Array.isArray(input)) return 0;
    let dropped = 0;
    for (let i = input.length - 1; i >= 0; i--) {
        const rec = input[i] as Record<string, unknown>;
        if (rec === null || typeof rec !== "object") continue;
        const type = rec.type;
        // message items carry type "message"; omp's user items omit the field
        // entirely (role + content only) — treat those as messages too.
        if (type !== "message" && type !== undefined) continue;
        const role = rec.role;
        if (role !== "user" && role !== "assistant") continue;
        const content = rec.content;
        let text: string | undefined;
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
            let mixed = false;
            let joined = "";
            for (const part of content) {
                const p = part as Record<string, unknown>;
                // Malformed parts (non-objects) make emptiness unknowable —
                // treat as mixed and preserve the item.
                if (p === null || typeof p !== "object") {
                    mixed = true;
                    break;
                }
                const pt = p.type;
                if (pt !== undefined && pt !== "input_text" && pt !== "output_text" && pt !== "text") {
                    mixed = true;
                    break;
                }
                if (typeof p.text === "string") joined += p.text;
            }
            if (!mixed) text = joined;
        }
        // Replay stickiness: an originally-whitespace message comes back on
        // every later request carrying the render tag a previous turn
        // stamped onto it (tag + whitespace, still semantically empty). A
        // tag wrapping a real ref over real content keeps the message alive;
        // only tag-over-nothing is droppable.
        if (text !== undefined && stripRenderTags(text).trim() === "") {
            input.splice(i, 1);
            dropped++;
        }
    }
    return dropped;
}

const RENDER_TAG_RE = /\x3cacp\s[^>]*\x3e[^<]*\x3c\/acp\x3e|\x3cacp\s[^>]*\/\x3e/g;

function stripRenderTags(text: string): string {
    return text.replace(RENDER_TAG_RE, "");
}

interface MappedItem {
    id: string;
    index: number;
}

function rewriteItemEvent(type: string, obj: Record<string, unknown>, mapped: MappedItem): Buffer {
    const item = { ...((obj.item as Record<string, unknown>) ?? {}), id: mapped.id };
    return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ ...obj, output_index: mapped.index, item })}\n\n`, "utf8");
}

function rewriteRefEvent(type: string, obj: Record<string, unknown>, mapped: MappedItem): Buffer {
    return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ ...obj, item_id: mapped.id, output_index: mapped.index })}\n\n`, "utf8");
}

function rebuildResponsesEvent(type: string, obj: Record<string, unknown>): Buffer {
    return Buffer.from(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`, "utf8");
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
    // #440: response.failed with no preceding response.created is an orphan that
    // crashes strict clients (codex) — same class as the anthropic gap (#413).
    let createdForwarded = false;
    let createdRespId: string | null = null;
    const ensureCreated = (): Buffer | null => {
        if (createdForwarded) return null;
        createdForwarded = true;
        if (!createdRespId) createdRespId = `resp-proxy-${Date.now()}`;
        return Buffer.from(
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: createdRespId, status: "in_progress", output: [] } })}\n\n`,
            "utf8",
        );
    };

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
            const remapped = new Map<string, MappedItem>();
            // #206: render-tag echo filter — deltas stream through the filter;
            // full-text events (.done / output_item.done / completed response)
            // are stripped wholesale via stripResponsesText.
            const tagFilter = createTagEchoFilter((snippet) => {
                loggerLog("warn", `[tag-echo] stripped model-emitted render tag: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
            });
            let lastTextRef: { itemId: string; outputIndex: number } | null = null;
            const flushFilter = function* (): Generator<ParsedStreamEvent> {
                const tail = tagFilter.flush();
                if (tail.length > 0) {
                    const raw = lastTextRef
                        ? rebuildResponsesEvent("response.output_text.delta", { type: "response.output_text.delta", item_id: lastTextRef.itemId, output_index: lastTextRef.outputIndex, delta: tail })
                        : undefined;
                    yield { kind: "text", delta: tail, ...(raw ? { raw } : {}) } as ParsedStreamEvent;
                }
            };
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
                    if (type === "response.created") {
                        const resp = obj.response as Record<string, unknown> | undefined;
                        if (resp && typeof resp.id === "string") createdRespId = resp.id;
                        if (round === 1) createdForwarded = true;
                    }
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                } else if (type === "response.output_item.added") {
                    const item = obj.item as Record<string, unknown> | undefined;
                    if (item?.type === "function_call") {
                        const fcName = typeof item.name === "string" ? item.name : "";
                        if (PROXY_TOOL_NAMES.has(fcName)) {
                            const itemId = typeof item.id === "string" ? item.id : "";
                            pending.set(itemId, {
                                itemId,
                                callId: typeof item.call_id === "string" ? item.call_id : "",
                                name: fcName,
                                arguments: "",
                            });
                        } else {
                            yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                        }
                    } else if (item?.type === "custom_tool_call") {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                    } else if (item?.type === "message" && round > 1 && !suppressTextLifecycle) {
                        const origId = typeof item.id === "string" ? item.id : "";
                        const mapped = { id: `msg-proxy-${round}-${hashId(origId || String(outputIndex))}`, index: outputIndex++ };
                        if (origId) remapped.set(origId, mapped);
                        yield { kind: "meta", chunk: rewriteItemEvent(type, obj, mapped), firstRoundOnly: false } as ParsedStreamEvent;
                    } else if (item?.type !== "message" || !suppressTextLifecycle) {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (
                    type === "response.content_part.added" ||
                    type === "response.content_part.done" ||
                    type === "response.output_text.done"
                ) {
                    const mapped = remapped.get(typeof obj.item_id === "string" ? obj.item_id : "");
                    if (mapped) {
                        yield { kind: "meta", chunk: rewriteRefEvent(type, stripResponsesText(obj), mapped), firstRoundOnly: false } as ParsedStreamEvent;
                    } else if (!suppressTextLifecycle) {
                        const chunk = containsRenderTagText(eventStr) ? rebuildResponsesEvent(type, stripResponsesText(obj)) : rawBuf;
                        yield { kind: "meta", chunk, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "response.output_text.delta") {
                    const delta = typeof obj.delta === "string" ? obj.delta : "";
                    if (delta.length > 0) {
                        const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
                        const outputIndex = typeof obj.output_index === "number" ? obj.output_index : 0;
                        const mapped = remapped.get(itemId);
                        lastTextRef = { itemId: mapped ? mapped.id : itemId, outputIndex: mapped ? mapped.index : outputIndex };
                        const clean = tagFilter.push(delta);
                        if (clean.length > 0) {
                            if (mapped) {
                                yield { kind: "text", delta: clean, raw: rewriteRefEvent(type, { ...obj, delta: clean }, mapped) } as ParsedStreamEvent;
                            } else if (round === 1) {
                                const raw = clean === delta ? rawBuf : rebuildResponsesEvent(type, { ...obj, delta: clean });
                                yield { kind: "text", delta: clean, raw } as ParsedStreamEvent;
                            } else {
                                yield { kind: "text", delta: clean } as ParsedStreamEvent;
                            }
                        }
                    }
                } else if (type === "response.function_call_arguments.delta") {
                    const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
                    const delta = typeof obj.delta === "string" ? obj.delta : "";
                    const fc = pending.get(itemId);
                    if (fc) fc.arguments += delta;
                    else yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                } else if (type === "response.function_call_arguments.done") {
                    const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
                    const args = typeof obj.arguments === "string" ? obj.arguments : "";
                    const fc = pending.get(itemId);
                    if (fc && args) fc.arguments = args;
                    else yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
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
                        } else {
                            yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                            yield {
                                kind: "tool_call",
                                name: typeof item.name === "string" ? item.name : "",
                                callId: typeof item.call_id === "string" ? item.call_id : "",
                                arguments: typeof item.arguments === "string" ? item.arguments : "",
                                passthrough: true,
                            } as ParsedStreamEvent;
                        }
                    } else if (item?.type === "custom_tool_call") {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                    } else if (item?.type === "message") {
                        const origId = typeof item.id === "string" ? item.id : "";
                        const mapped = remapped.get(origId);
                        if (mapped) {
                            remapped.delete(origId);
                            yield { kind: "meta", chunk: rewriteItemEvent(type, stripResponsesText(obj), mapped), firstRoundOnly: false } as ParsedStreamEvent;
                        } else if (!suppressTextLifecycle) {
                            const chunk = containsRenderTagText(eventStr) ? rebuildResponsesEvent(type, stripResponsesText(obj)) : rawBuf;
                            yield { kind: "meta", chunk, firstRoundOnly: true } as ParsedStreamEvent;
                        }
                    } else if (item?.type !== "message" || !suppressTextLifecycle) {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "response.completed") {
                    yield* flushFilter();
                    responseObj = stripResponsesText((obj.response as Record<string, unknown>) ?? null);
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
                    yield* flushFilter();
                    terminalKind = "incomplete";
                    terminalRaw = rawBuf;
                    yield { kind: "done", finishReason: "incomplete" } as ParsedStreamEvent;
                } else if (type === "response.failed" || type === "response.error") {
                    yield* flushFilter();
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
                const parts: Buffer[] = [];
                const created = ensureCreated();
                if (created) parts.push(created);
                const failed = {
                    id: createdRespId ?? `resp-error-${Date.now()}`,
                    status: "failed",
                    error: { code: "server_error", message: "upstream returned no response" },
                };
                parts.push(Buffer.from(
                    `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: failed })}\n\n`,
                    "utf8",
                ));
                return Buffer.concat(parts);
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
            const parts: Buffer[] = [];
            const created = ensureCreated();
            if (created) parts.push(created);
            const resp = {
                id: createdRespId ?? `resp-error-${Date.now()}`,
                status: "failed",
                error: { code: "server_error", message },
            };
            parts.push(Buffer.from(
                `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: resp })}\n\n`,
                "utf8",
            ));
            return Buffer.concat(parts);
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
