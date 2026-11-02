import type { CoreMessage } from "acp-kernel";
import { coreToResponses, patchResponsesInput, responsesToCore, type BiliMessage, type ResponseContentPart, type ResponseInputItem, type ResponsesProjection, type ResponsesRequestBody } from "acp-kernel/wire";
import { isRenderedSummaryMessage } from "acp-kernel";
import { systemToUser } from "./util.js";

const responsesPartBinding = Symbol("responsesPartBinding");
type PartBoundMessage = CoreMessage & {
    [responsesPartBinding]?: { source: ResponseInputItem; part: ResponseContentPart; sourceId: string };
};

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
    // The layout supplies exact source ownership, including duplicate images.
    // Keep it on the core while it survives rendering; never guess ownership
    // later from text equality or the first image in a multipart carrier.
    const byId = new Map(projection.msgs.map(message => [message.id, message]));
    for (const slot of projection.layout) {
        const source = slot.original;
        if (source.role !== "user" || !Array.isArray(source.content)) continue;
        const parts = source.content as ResponseContentPart[];
        if (!parts.every(part => part.type === "input_image" || part.type === "input_text" || part.type === "output_text")) continue;
        const emitted = parts.filter(part => part.type === "input_image" || (typeof part.text === "string" && part.text.length > 0));
        const ids = slot.coreIds ?? (slot.coreId ? [slot.coreId] : []);
        if (ids.length !== emitted.length) continue;
        ids.forEach((id, index) => {
            const message = byId.get(id) as PartBoundMessage | undefined;
            if (message) message[responsesPartBinding] = { source, part: emitted[index]!, sourceId: id };
        });
    }
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function foldConfigurationFields(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        if (isPlainRecord(out[key]) && isPlainRecord(value)) out[key] = foldConfigurationFields(out[key], value);
        else out[key] = value;
    }
    return out;
}

// #1733 — upstream rejects consecutive configuration_update items (HTTP 400
// unsupported_value). History compression prunes the messages that separated
// them (untracked layout slots survive verbatim) and hoistTrappedToolItems can
// batch them together too. Fold each adjacent run into one item with
// sequential-assignment semantics: later updates win at the leaf, distinct
// fields from both survive. No-op (byte-stable) when nothing is adjacent.
export function mergeAdjacentConfigurationUpdates(items: readonly ResponseInputItem[]): ResponseInputItem[] {
    const out: ResponseInputItem[] = [];
    for (const item of items) {
        const prev = out[out.length - 1];
        if (item.type === "configuration_update" && prev !== undefined && prev.type === "configuration_update") {
            const base: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(prev)) base[key] = value;
            out[out.length - 1] = foldConfigurationFields(base, item) as ResponseInputItem;
        } else {
            out.push(item);
        }
    }
    return out;
}

// #1999 (same bug class as #377/#428 on the chat wire): the kernel renders each
// compressed block's summary as role:"system" anchored mid-history, and
// coreToResponses projects that to a `developer` item AT ITS POSITION — strict
// single-system backends (Qwen3-family "system-first" chat templates) 400 the
// whole session after any fold. Re-voice surviving summary-carrier core
// messages as user BEFORE the codec so they ride mid-history exactly like the
// chat wire's systemToUser does; the head system prompt is untouched (it rides
// instructions / the injected leading developer item, never this path). No-op
// (same array) when nothing needs converting. Covers BOTH compression modes: in
// plugin mode stripKernelSummaries removes the anchor when the compress pair
// rides inbound history, but pruned or line-form echoes leave it behind — this
// re-voicing is what keeps the wire legal then.
// #4166: the re-voicing is narrowed to bili's OWN carriers
// (isRenderedSummaryMessage) — client-origin mid system/developer cores are
// conversation data and re-emit verbatim through their rawResponsesItem
// sidecar; they are NOT rewritten here.
function boundCarrier(messages: PartBoundMessage[]): ResponseInputItem {
    const source = messages[0]![responsesPartBinding]!.source;
    const parts = messages.map(message => {
        const part = message[responsesPartBinding]!.part;
        return part.type === "input_image" || part.text === message.text ? part : { ...part, text: message.text ?? "" };
    });
    const original = source.content;
    const unchanged = Array.isArray(original) && original.length === parts.length
        && parts.every((part, index) => part === original[index]);
    return unchanged ? source : { type: "message", role: "user", content: parts };
}

function boundProjection(projection: ResponsesProjection, messages: CoreMessage[]): ResponsesProjection {
    const runs = new Map<ResponseInputItem, PartBoundMessage[][]>();
    let previous: PartBoundMessage | undefined;
    for (const message of messages) {
        const bound = message as PartBoundMessage;
        const binding = bound[responsesPartBinding];
        if (!binding || message.role !== "user" || isRenderedSummaryMessage(message)) {
            previous = undefined;
            continue;
        }
        const groups = runs.get(binding.source) ?? [];
        if (previous?.[responsesPartBinding]?.source === binding.source) groups.at(-1)!.push(bound);
        else groups.push([bound]);
        runs.set(binding.source, groups);
        previous = bound;
    }
    const sources = new Map(projection.msgs.map(message => [message.id, message]));
    const replaced = new Set<string>();
    const rebound: BiliMessage[] = [];
    const layout = projection.layout.flatMap(slot => {
        const groups = runs.get(slot.original);
        if (!groups) return [slot];
        for (const id of slot.coreIds ?? (slot.coreId ? [slot.coreId] : [])) replaced.add(id);
        return groups.map(group => {
            for (const message of group) {
                const source = sources.get(message[responsesPartBinding]!.sourceId);
                if (source) rebound.push({ ...source, id: message.id, text: message.text });
            }
            const ids = group.map(message => message.id);
            return { original: boundCarrier(group), coreId: ids[0], ...(ids.length > 1 ? { coreIds: ids } : {}) };
        });
    });
    // The virtual layout retains untracked wire items, but gives each surviving
    // part its actual current ID. Separate runs leave an insertion anchor for
    // a block summary between parts from the same original carrier.
    return { ...projection, layout, msgs: [...projection.msgs.filter(message => !replaced.has(message.id)), ...rebound] };
}

export function patchResponsesInputWithToolImages(projection: ResponsesProjection, messages: CoreMessage[]): string | ResponseInputItem[] {
    const voiced = systemToUser(messages, (m) => isRenderedSummaryMessage(m));
    const input = patchResponsesInput(boundProjection(projection, voiced), voiced);
    if (typeof input === "string") return input;
    const byOriginal = new Map<unknown, ResponseInputItem>();
    const byCall = new Map<string, ResponseInputItem>();
    for (const message of voiced) {
        const rebuilt = rebuildToolImages(message);
        if (!rebuilt) continue;
        byOriginal.set((message as BiliMessage).rawResponsesItem, rebuilt);
        byCall.set(`${rebuilt.type}:${message.toolCallId ?? ""}`, rebuilt);
    }
    return mergeAdjacentConfigurationUpdates(input.map((item) => byOriginal.get(item) ?? byCall.get(`${item.type}:${item.call_id ?? ""}`) ?? item));
}

// #1999: same pre-codec re-voicing as patchResponsesInputWithToolImages above.
// #4166: carriers only — client-origin mid system/developer stays verbatim.
export function coreToResponsesWithToolImages(messages: CoreMessage[], customToolCallIds: Set<string> = new Set()): ResponseInputItem[] {
    const out: ResponseInputItem[] = [];
    let pending: PartBoundMessage[] = [];
    const flush = (): void => {
        if (pending.length === 0) return;
        out.push(boundCarrier(pending));
        pending = [];
    };
    for (const message of systemToUser(messages, (m) => isRenderedSummaryMessage(m))) {
        const bound = message as PartBoundMessage;
        if (bound[responsesPartBinding] && message.role === "user" && !isRenderedSummaryMessage(message)) {
            if (pending.length && pending[0]![responsesPartBinding]!.source !== bound[responsesPartBinding].source) flush();
            pending.push(bound);
            continue;
        }
        flush();
        const rebuilt = rebuildToolImages(message);
        out.push(...(rebuilt ? [rebuilt] : coreToResponses([message], customToolCallIds)));
    }
    flush();
    return out;
}
