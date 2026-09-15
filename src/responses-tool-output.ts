import type { CoreMessage } from "acp-kernel";
import { coreToResponses, patchResponsesInput, responsesToCore, type BiliMessage, type ResponseContentPart, type ResponseInputItem, type ResponsesProjection, type ResponsesRequestBody } from "acp-kernel/wire";

export function responsesToolImageParts(item: unknown): ResponseContentPart[] | undefined {
    if (typeof item !== "object" || item === null) return undefined;
    const raw = item as Record<string, unknown>;
    if (raw.type !== "function_call_output" && raw.type !== "custom_tool_call_output") return undefined;
    if (!Array.isArray(raw.output)) return undefined;
    let hasImage = false;
    for (const part of raw.output) {
        if (typeof part !== "object" || part === null) return undefined;
        if (part.type === "input_text" && typeof part.text === "string") continue;
        if (part.type === "input_image" && typeof part.image_url === "string") {
            hasImage = true;
            continue;
        }
        return undefined;
    }
    return hasImage ? raw.output : undefined;
}

function outputText(parts: ResponseContentPart[]): string {
    return parts.filter((part) => part.type === "input_text").map((part) => part.text).join("\n");
}

export function responsesToCoreWithToolImages(body: ResponsesRequestBody): ResponsesProjection {
    const projection = responsesToCore(body);
    for (const message of projection.msgs) {
        const parts = responsesToolImageParts(message.rawResponsesItem);
        // Keep the codec's original content-derived id so persisted refs still
        // identify the same image-bearing message after the text-only repair.
        if (parts) message.text = outputText(parts);
    }
    return projection;
}

function rebuildToolImages(message: CoreMessage): ResponseInputItem | undefined {
    if (message.role !== "tool" || message.contentType !== "tool-result") return undefined;
    const raw = (message as BiliMessage).rawResponsesItem as ResponseInputItem | undefined;
    const parts = responsesToolImageParts(raw);
    if (!raw || !parts) return undefined;
    const text = message.text ?? "";
    if (text === outputText(parts) && message.toolCallId === raw.call_id) return raw;
    let written = false;
    const output = parts.map((part) => {
        if (part.type !== "input_text") return part;
        const next = { ...part, text: written ? "" : text };
        written = true;
        return next;
    });
    if (!written && text) output.unshift({ type: "input_text", text });
    return { ...raw, call_id: message.toolCallId ?? raw.call_id, output };
}

export function patchResponsesInputWithToolImages(projection: ResponsesProjection, messages: CoreMessage[]): string | ResponseInputItem[] {
    const input = patchResponsesInput(projection, messages);
    if (typeof input === "string") return input;
    const byOriginal = new Map<unknown, ResponseInputItem>();
    const byCall = new Map<string, ResponseInputItem>();
    for (const message of messages) {
        const rebuilt = rebuildToolImages(message);
        if (!rebuilt) continue;
        byOriginal.set((message as BiliMessage).rawResponsesItem, rebuilt);
        byCall.set(`${rebuilt.type}:${message.toolCallId ?? ""}`, rebuilt);
    }
    return input.map((item) => byOriginal.get(item) ?? byCall.get(`${item.type}:${item.call_id ?? ""}`) ?? item);
}

export function coreToResponsesWithToolImages(messages: CoreMessage[], customToolCallIds: Set<string> = new Set()): ResponseInputItem[] {
    return messages.flatMap((message) => {
        const rebuilt = rebuildToolImages(message);
        return rebuilt ? [rebuilt] : coreToResponses([message], customToolCallIds);
    });
}
