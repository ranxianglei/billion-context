import type { CoreMessage } from "acp-kernel";
import { randomUUID } from "node:crypto";
import { ClusterCounter, deriveMessageId } from "./message-id.js";
import type { ConversationIdentity } from "./session-id.js";
import { hashId } from "./util.js";
import { parseDataUrl, type BiliMessage } from "./bili-message.js";

export type ResponseContentPart =
    | { type: "input_text"; text: string; [key: string]: unknown }
    | { type: "output_text"; text: string; [key: string]: unknown }
    | { type: "input_image"; image_url: string; [key: string]: unknown }
    | { type: string; [key: string]: unknown };

export type ResponseInputMessage = {
    type: "message";
    role: "system" | "developer" | "user" | "assistant";
    content: string | ResponseContentPart[];
    [key: string]: unknown;
};

export type ResponseFunctionCall = {
    type: "function_call";
    id?: string;
    call_id: string;
    name: string;
    arguments: string;
    [key: string]: unknown;
};

export type ResponseFunctionCallOutput = {
    type: "function_call_output";
    call_id: string;
    output: string;
    [key: string]: unknown;
};

export type ResponseInputItem =
    | ResponseInputMessage
    | ResponseFunctionCall
    | ResponseFunctionCallOutput
    | { type: string; [key: string]: unknown };

export type ResponsesRequestBody = {
    model?: string;
    input: string | ResponseInputItem[];
    instructions?: string;
    tools?: unknown[];
    stream?: boolean;
    session_id?: string;
    previous_response_id?: string;
    prompt_cache_key?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
};

type ResponseLayoutSlot = {
    original: ResponseInputItem;
    coreId?: string;
};

export type ResponsesProjection = {
    msgs: BiliMessage[];
    systemParts: string[];
    preamble: ResponseInputItem[];
    customToolCallIds: Set<string>;
    layout: ResponseLayoutSlot[];
    stringInput?: { original: string; coreId: string };
    /** Reasoning items dropped because ACP_REASONING_KEEP=none. 0 by default —
     *  reasoning is normally routed through the compression pipeline so it is
     *  hidden automatically once its turn is summarized. */
    droppedReasoning: number;
};

/** Item types that are host DIRECTIVES (tool/definition listings), not
 *  conversation history: preserved verbatim and re-prepended at input[0..].
 *  `additional_tools` carries the Codex code_mode exec/wait tool definitions
 *  and MUST stay at input[0]. `mcp_list_tools` is a stable per-session listing.
 *
 *  Only definitions belong here. Output/action items from a prior response
 *  (reasoning, computer_call, function_call, mcp_call, ...) ARE conversation
 *  history and are routed as tracked BiliMessages, so the compression pipeline
 *  hides them once their turn is summarized — preserving them verbatim in the
 *  preamble instead made them accumulate unbounded every turn and broke Codex's
 *  prompt-cache prefix. */
const OPAQUE_ITEM_TYPES = new Set([
    "additional_tools",
    "mcp_list_tools",
]);

function isOpaqueItem(item: ResponseInputItem): boolean {
    return OPAQUE_ITEM_TYPES.has(item.type);
}

function shouldDropAllReasoning(): boolean {
    return (process.env.ACP_REASONING_KEEP ?? "").trim().toLowerCase() === "none";
}

function partText(part: ResponseContentPart): string {
    if (part.type === "input_text" || part.type === "output_text") {
        return typeof part.text === "string" ? part.text : "";
    }
    return "";
}

function messageContent(content: string | ResponseContentPart[]): string {
    return typeof content === "string" ? content : content.map(partText).join("\n");
}

export function responsesToCore(body: ResponsesRequestBody): ResponsesProjection {
    const msgs: BiliMessage[] = [];
    const systemParts: string[] = [];
    const preamble: ResponseInputItem[] = [];
    const customToolCallIds = new Set<string>();
    const layout: ResponseLayoutSlot[] = [];
    let droppedReasoning = 0;
    const clusters = new ClusterCounter();
    let idx = 0;
    if (typeof body.instructions === "string" && body.instructions.trim()) systemParts.push(body.instructions);
    if (typeof body.input === "string") {
        const id = clusters.next(deriveMessageId("user", "text", body.input));
        msgs.push({ id, role: "user", contentType: "text", text: body.input });
        return { msgs, systemParts, preamble, customToolCallIds, layout, droppedReasoning, stringInput: { original: body.input, coreId: id } };
    }
    for (const item of body.input) {
        let coreId: string | undefined;
        if (isOpaqueItem(item)) preamble.push(item);
        switch (item.type) {
            case "reasoning": {
                if (shouldDropAllReasoning()) {
                    droppedReasoning++;
                    continue;
                }
                const rid =
                    typeof (item as { id?: unknown }).id === "string"
                        ? String((item as { id?: string }).id)
                        : hashId(JSON.stringify(item));
                coreId = clusters.next(deriveMessageId("assistant", "reasoning", rid));
                msgs.push({
                    id: coreId,
                    role: "assistant",
                    contentType: "reasoning",
                    text: rid,
                    rawResponsesItem: item,
                });
                break;
            }
            case "message": {
                const message = item as ResponseInputMessage;
                const text = messageContent(message.content);
                if (message.role === "system" || message.role === "developer") {
                    systemParts.push(text);
                    idx++;
                    continue;
                } else if (message.role === "user" || (message.role === "assistant" && text)) {
                    const role = message.role;
                    coreId = clusters.next(deriveMessageId(role, "text", text));
                    const imageUrl = Array.isArray(message.content)
                        ? message.content.find((part) => part.type === "input_image" && typeof part.image_url === "string")?.image_url
                        : undefined;
                    const image = typeof imageUrl === "string" ? parseDataUrl(imageUrl) : undefined;
                    msgs.push({
                        id: coreId,
                        role,
                        contentType: "text",
                        text,
                        rawResponsesItem: item,
                        ...(image ? { imageMediaType: image.mediaType, imageBase64: image.base64 } : {}),
                    });
                }
                break;
            }
            case "function_call": {
                const call = item as ResponseFunctionCall;
                coreId = clusters.next(deriveMessageId("assistant", "tool-call", call.arguments ?? "", {
                    toolCallId: call.call_id,
                    toolName: call.name,
                }));
                msgs.push({
                    id: coreId,
                    role: "assistant",
                    contentType: "tool-call",
                    toolName: call.name,
                    toolCallId: call.call_id,
                    text: call.arguments ?? "",
                    rawResponsesItem: item,
                });
                break;
            }
            case "function_call_output": {
                const output = item as ResponseFunctionCallOutput;
                const text = typeof output.output === "string" ? output.output : JSON.stringify(output.output);
                coreId = clusters.next(deriveMessageId("tool", "tool-result", text, { toolCallId: output.call_id }));
                msgs.push({ id: coreId, role: "tool", contentType: "tool-result", toolCallId: output.call_id, text, rawResponsesItem: item });
                break;
            }
            case "computer_call":
            case "computer_call_output":
            case "file_search_call":
            case "web_search_call":
            case "image_generation_call":
            case "code_interpreter_call":
            case "mcp_call": {
                const rid =
                    typeof (item as { id?: unknown }).id === "string"
                        ? String((item as { id?: string }).id)
                        : hashId(JSON.stringify(item));
                coreId = clusters.next(deriveMessageId("assistant", "responses-call", rid));
                msgs.push({ id: coreId, role: "assistant", contentType: "reasoning", text: rid, rawResponsesItem: item });
                break;
            }
            case "custom_tool_call": {
                const ctc = item as { call_id?: string; name?: string; input?: string; arguments?: string };
                const callId = ctc.call_id ?? `call_${idx}`;
                customToolCallIds.add(callId);
                const argText = ctc.input ?? ctc.arguments ?? "";
                coreId = clusters.next(deriveMessageId("assistant", "tool-call", argText, { toolCallId: callId, toolName: ctc.name ?? "custom" }));
                msgs.push({ id: coreId, role: "assistant", contentType: "tool-call", toolName: ctc.name ?? "custom", toolCallId: callId, text: argText, rawResponsesItem: item });
                break;
            }
            case "custom_tool_call_output": {
                const ctco = item as { call_id?: string; output?: string };
                const callId = ctco.call_id ?? `call_${idx}`;
                customToolCallIds.add(callId);
                const outText = typeof ctco.output === "string" ? ctco.output : JSON.stringify(ctco.output ?? "");
                coreId = clusters.next(deriveMessageId("tool", "tool-result", outText, { toolCallId: callId }));
                msgs.push({ id: coreId, role: "tool", contentType: "tool-result", toolCallId: callId, text: outText, rawResponsesItem: item });
                break;
            }
            default:
                if (!isOpaqueItem(item)) preamble.push(item);
                break;
        }
        layout.push({ original: item, coreId });
        idx++;
    }
    return { msgs, systemParts, preamble, customToolCallIds, layout, droppedReasoning };
}

function patchTextParts(parts: ResponseContentPart[], text: string): ResponseContentPart[] {
    const textIndexes = parts.flatMap((part, index) =>
        part.type === "input_text" || part.type === "output_text" ? [index] : [],
    );
    if (textIndexes.length === 0) return [{ type: "input_text", text }, ...parts];
    const first = textIndexes[0];
    const remaining = new Set(textIndexes.slice(1));
    return parts.map((part, index) => {
        if (index === first) return { ...part, text };
        if (remaining.has(index)) return { ...part, text: "" };
        return part;
    });
}

function patchOriginalItem(original: ResponseInputItem, source: CoreMessage, next: CoreMessage): ResponseInputItem {
    if (
        source.text === next.text &&
        source.toolName === next.toolName &&
        source.toolCallId === next.toolCallId &&
        source.role === next.role &&
        source.contentType === next.contentType
    ) return original;
    if (original.type === "message") {
        const message = original as ResponseInputMessage;
        const content = typeof message.content === "string" ? next.text ?? "" : patchTextParts(message.content, next.text ?? "");
        return { ...message, content };
    }
    if (original.type === "function_call") {
        return {
            ...original,
            name: next.toolName ?? String(original.name ?? "unknown"),
            call_id: next.toolCallId ?? String(original.call_id ?? ""),
            arguments: next.text ?? "",
        };
    }
    if (original.type === "function_call_output") {
        return { ...original, call_id: next.toolCallId ?? String(original.call_id ?? ""), output: next.text ?? "" };
    }
    return original;
}

export function patchResponsesInput(projection: ResponsesProjection, messages: CoreMessage[]): string | ResponseInputItem[] {
    if (projection.stringInput) {
        const original = projection.msgs.find((message) => message.id === projection.stringInput?.coreId);
        const next = messages.find((message) => message.id === projection.stringInput?.coreId);
        if (original && next && messages.length === 1 && next.role === "user" && next.contentType === "text") {
            return next.text === original.text ? projection.stringInput.original : next.text ?? "";
        }
        return coreToResponses(messages, projection.customToolCallIds);
    }
    const sourceById = new Map(projection.msgs.map((message) => [message.id, message]));
    const nextById = new Map(messages.map((message) => [message.id, message]));
    const slotById = new Map<string, number>();
    projection.layout.forEach((slot, index) => {
        if (slot.coreId) slotById.set(slot.coreId, index);
    });
    const insertions = new Map<number, ResponseInputItem[]>();
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (sourceById.has(message.id)) continue;
        let target = projection.layout.length;
        for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex++) {
            const slot = slotById.get(messages[nextIndex].id);
            if (slot !== undefined) {
                target = slot;
                break;
            }
        }
        const generated = coreToResponses([message], projection.customToolCallIds);
        if (generated.length > 0) insertions.set(target, [...(insertions.get(target) ?? []), ...generated]);
    }
    const out: ResponseInputItem[] = [];
    projection.layout.forEach((slot, index) => {
        out.push(...(insertions.get(index) ?? []));
        if (!slot.coreId) {
            out.push(slot.original);
            return;
        }
        const source = sourceById.get(slot.coreId);
        const next = nextById.get(slot.coreId);
        if (source && next) out.push(patchOriginalItem(slot.original, source, next));
    });
    out.push(...(insertions.get(projection.layout.length) ?? []));
    return out;
}

export function coreToResponses(
    messages: CoreMessage[],
    customToolCallIds: Set<string> = new Set(),
): ResponseInputItem[] {
    const out: ResponseInputItem[] = [];
    for (const message of messages) {
        const biliMessage = message as BiliMessage;
        const raw = biliMessage.rawResponsesItem as ResponseInputItem | undefined;
        if (message.role === "system") {
            out.push({ type: "message", role: "developer", content: message.text ?? "" });
        } else if (message.role === "user") {
            if (raw?.type === "message" && messageContent((raw as ResponseInputMessage).content) === (message.text ?? "")) out.push(raw);
            else out.push({ type: "message", role: "user", content: message.text ?? "" });
        } else if (message.role === "assistant") {
            if (message.contentType === "text") {
                out.push({ type: "message", role: "assistant", content: message.text ?? "" });
            } else if (message.contentType === "tool-call") {
                const callId = message.toolCallId ?? `call_${message.id}`;
                if (customToolCallIds.has(callId)) {
                    out.push({ type: "custom_tool_call", call_id: callId, name: message.toolName ?? "unknown", input: message.text ?? "", status: "completed" } as ResponseInputItem);
                } else {
                    out.push({ type: "function_call", call_id: callId, name: message.toolName ?? "unknown", arguments: message.text ?? "" });
                }
            } else if (message.contentType === "reasoning") {
                if (raw) out.push(raw);
            }
        } else if (message.role === "tool") {
            const callId = message.toolCallId ?? "";
            if (customToolCallIds.has(callId)) {
                out.push({ type: "custom_tool_call_output", call_id: callId, output: message.text ?? "" } as ResponseInputItem);
            } else {
                out.push({ type: "function_call_output", call_id: callId, output: message.text ?? "" });
            }
        }
    }
    return out;
}

export function injectResponsesDeveloperMessage(
    input: string | ResponseInputItem[],
    content: string,
): ResponseInputItem[] {
    const items: ResponseInputItem[] = typeof input === "string"
        ? [{ type: "message", role: "user", content: input }]
        : [...input];
    let index = 0;
    while (items[index]?.type === "additional_tools") index++;
    items.splice(index, 0, { type: "message", role: "developer", content });
    return items;
}

export function conversationIdentityResponses(
    body: ResponsesRequestBody,
    headerValue?: string,
): ConversationIdentity {
    if (headerValue?.trim()) return { value: headerValue.trim(), source: "header", clientProvided: true };
    if (typeof body.session_id === "string" && body.session_id.trim()) {
        return { value: body.session_id.trim(), source: "body-session", clientProvided: true };
    }
    const metadataSession = body.metadata?.session_id;
    if (typeof metadataSession === "string" && metadataSession.trim()) {
        return { value: metadataSession.trim(), source: "metadata-session", clientProvided: true };
    }
    return { value: `generated-${randomUUID()}`, source: "generated", clientProvided: false };
}

export function conversationSignalResponses(body: ResponsesRequestBody, headerValue?: string): string {
    return conversationIdentityResponses(body, headerValue).value;
}
