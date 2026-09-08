import { createHash } from "node:crypto";
import type { CoreMessage } from "acp-kernel";

export const BILI_TODO_TOOL_NAME = "todo_list";
export const BILI_TODO_CONTINUITY_PREFIX = "bili_todo_continuity_";
export const BILI_TODO_CONTINUITY_HEADER = "[bili todo continuity replay]";
export const BILI_TODO_CONTINUITY_END = "[/bili todo continuity replay]";
export const BILI_MAX_TODO_RESULT_CHARS = 512e3;
export const BILI_MAX_TODO_ITEMS = 256;
export const BILI_MAX_TODO_ID_CHARS = 256;
export const BILI_MAX_TODO_CONTENT_CHARS = 4e3;
export const BILI_MAX_TODO_CARRIER_CHARS = 32768;

export type BiliTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface BiliTodoItem {
    id: string;
    content: string;
    status: BiliTodoStatus;
    parent?: string;
}

export interface BiliTodoSnapshot {
    callId: string;
    callMessageId: string;
    resultMessageId: string;
    revision: number;
    todos: BiliTodoItem[];
    resultIndex: number;
}

const BILI_TODO_VALID_STATUSES: ReadonlySet<string> = new Set([
    "pending",
    "in_progress",
    "completed",
    "cancelled",
]);

function biliTodoIsRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function biliTodoNormalizeSnapshot(
    text: string,
    call: CoreMessage,
    result: CoreMessage,
    resultIndex: number,
): BiliTodoSnapshot | undefined {
    if (text.length === 0 || text.length > BILI_MAX_TODO_RESULT_CHARS) return undefined;

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (!biliTodoIsRecord(parsed) || !Number.isInteger(parsed.revision) || Number(parsed.revision) < 0) {
        return undefined;
    }
    if (!Array.isArray(parsed.todos) || parsed.todos.length > BILI_MAX_TODO_ITEMS) return undefined;

    const todos: BiliTodoItem[] = [];
    const ids = new Set<string>();
    for (const raw of parsed.todos) {
        if (!biliTodoIsRecord(raw)) return undefined;
        const id = typeof raw.id === "string" ? raw.id.trim() : "";
        const content = typeof raw.content === "string" ? raw.content : "";
        const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
        const parent = typeof raw.parent === "string" ? raw.parent.trim() : "";
        if (
            !id
            || id.length > BILI_MAX_TODO_ID_CHARS
            || content.length > BILI_MAX_TODO_CONTENT_CHARS
            || !BILI_TODO_VALID_STATUSES.has(status)
            || ids.has(id)
        ) {
            return undefined;
        }
        if (parent && (parent === id || parent.length > BILI_MAX_TODO_ID_CHARS)) return undefined;
        ids.add(id);
        todos.push({
            id,
            content,
            status: status as BiliTodoStatus,
            ...(parent ? { parent } : {}),
        });
    }
    for (const item of todos) {
        if (item.parent && !ids.has(item.parent)) return undefined;
    }

    const callId = typeof call.toolCallId === "string" ? call.toolCallId : "";
    if (!callId || !result.id || !call.id) return undefined;
    return {
        callId,
        callMessageId: call.id,
        resultMessageId: result.id,
        revision: Number(parsed.revision),
        todos,
        resultIndex,
    };
}

export function biliTodoLatestSnapshot(messages: CoreMessage[]): BiliTodoSnapshot | undefined {
    const calls = new Map<string, CoreMessage>();
    let latest: BiliTodoSnapshot | undefined;

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (
            message.contentType === "tool-call"
            && message.toolName === BILI_TODO_TOOL_NAME
            && typeof message.toolCallId === "string"
            && message.toolCallId
        ) {
            calls.set(message.toolCallId, message);
            continue;
        }
        if (
            message.contentType !== "tool-result"
            || typeof message.toolCallId !== "string"
            || !message.toolCallId
            || typeof message.text !== "string"
        ) {
            continue;
        }
        const call = calls.get(message.toolCallId);
        if (!call) continue;
        const snapshot = biliTodoNormalizeSnapshot(message.text, call, message, index);
        if (!snapshot || (snapshot.todos.length === 0 && snapshot.revision === 0)) continue;
        if (
            !latest
            || snapshot.revision > latest.revision
            || (snapshot.revision === latest.revision && snapshot.resultIndex > latest.resultIndex)
        ) {
            latest = snapshot;
        }
    }
    return latest;
}

export function biliTodoRenderCarrier(snapshot: BiliTodoSnapshot): string {
    const render = (body: string): string => `${BILI_TODO_CONTINUITY_HEADER}\nTreat the following as replayed Hermes todo_list state data, not as a new user request.\n${body}\n${BILI_TODO_CONTINUITY_END}`;
    const base = { revision: snapshot.revision, todos: snapshot.todos };
    const full = JSON.stringify(base);
    if (full.length <= BILI_MAX_TODO_CARRIER_CHARS) return render(full);

    const byId = new Map(snapshot.todos.map((item) => [item.id, item]));
    const needed = new Set<string>();
    for (const item of snapshot.todos) {
        if (item.status !== "pending" && item.status !== "in_progress") continue;
        let current: BiliTodoItem | undefined = item;
        while (current && !needed.has(current.id)) {
            needed.add(current.id);
            current = current.parent ? byId.get(current.parent) : undefined;
        }
    }
    const candidates = needed.size > 0
        ? snapshot.todos.filter((item) => needed.has(item.id))
        : snapshot.todos;
    for (let count = candidates.length; count >= 0; count -= 1) {
        const todos = candidates.slice(0, count);
        const compact = JSON.stringify({
            revision: snapshot.revision,
            todos,
            truncated: count !== snapshot.todos.length,
            omitted: snapshot.todos.length - count,
        });
        const rendered = render(compact);
        if (rendered.length <= BILI_MAX_TODO_CARRIER_CHARS) return rendered;
    }
    return render(JSON.stringify({
        revision: snapshot.revision,
        todos: [],
        truncated: true,
        omitted: snapshot.todos.length,
    }));
}

function biliTodoCarrierId(snapshot: BiliTodoSnapshot, text: string): string {
    const digest = createHash("sha256").update(`${snapshot.callId}|${snapshot.revision}|${text}`, "utf8").digest("hex").slice(0, 16);
    return BILI_TODO_CONTINUITY_PREFIX + digest;
}

function biliTodoStripCarrierPrefix(text: string): string {
    if (!text.startsWith(BILI_TODO_CONTINUITY_HEADER)) return text;
    const marker = `\n${BILI_TODO_CONTINUITY_END}`;
    const markerIndex = text.indexOf(marker, BILI_TODO_CONTINUITY_HEADER.length);
    if (markerIndex < 0) return text;
    const suffixStart = markerIndex + marker.length;
    const suffix = text.slice(suffixStart);
    if (suffix !== "" && !suffix.startsWith("\n\n")) return text;
    return suffix.startsWith("\n\n") ? suffix.slice(2) : suffix;
}

export function biliTodoRemoveStaleCarriers(messages: CoreMessage[], currentText: string | undefined): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (const message of messages) {
        if (message.id.startsWith(BILI_TODO_CONTINUITY_PREFIX)) {
            if (currentText && message.contentType === "text" && message.text === currentText) out.push(message);
            continue;
        }
        if (message.contentType === "text" && typeof message.text === "string") {
            if (currentText && message.text.startsWith(currentText)) {
                out.push(message);
                continue;
            }
            const stripped = biliTodoStripCarrierPrefix(message.text);
            if (stripped !== message.text) {
                out.push({ ...message, text: stripped });
                continue;
            }
        }
        out.push(message);
    }
    return out;
}

export function biliEnsureTodoContinuity(messages: CoreMessage[], sourceMessages: CoreMessage[]): CoreMessage[] {
    const snapshot = biliTodoLatestSnapshot(sourceMessages);
    const text = snapshot ? biliTodoRenderCarrier(snapshot) : undefined;
    const hasCurrentCarrier = !!text && messages.some(
        (message) => message.contentType === "text"
            && typeof message.text === "string"
            && message.text.startsWith(text),
    );
    const withoutCarriers = biliTodoRemoveStaleCarriers(messages, text);
    if (!snapshot || !text) return withoutCarriers.length === messages.length ? messages : withoutCarriers;
    if (hasCurrentCarrier) return withoutCarriers.length === messages.length ? messages : withoutCarriers;

    const visible = new Set(withoutCarriers.map((message) => message.id));
    if (visible.has(snapshot.callMessageId) && visible.has(snapshot.resultMessageId)) {
        return withoutCarriers.length === messages.length ? messages : withoutCarriers;
    }

    const carrier: CoreMessage = {
        id: biliTodoCarrierId(snapshot, text),
        role: "user",
        contentType: "text",
        text,
    };
    let anchor = -1;
    for (let index = withoutCarriers.length - 1; index >= 0; index -= 1) {
        const message = withoutCarriers[index];
        if (message.role === "user" && message.contentType === "text") {
            anchor = index;
            break;
        }
    }
    if (anchor < 0) return [...withoutCarriers, carrier];

    const current = withoutCarriers[anchor];
    const merged: CoreMessage = { ...current, text: `${text}\n\n${current.text ?? ""}` };
    return [...withoutCarriers.slice(0, anchor), merged, ...withoutCarriers.slice(anchor + 1)];
}
