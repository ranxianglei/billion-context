import type { CoreMessage } from "acp-kernel";
import { anthropicToCore, googleToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
import { markDirty, type Session } from "../session.js";
import { log as loggerLog } from "../logger.js";

export const HANDOFF_REPLY_MAX_BYTES = 1_500_000;

export type HandoffReply = ReturnType<typeof createHandoffReply>;

export function createHandoffReply(session: Session, canSave: () => boolean = () => true) {
    const request = session.stats.requests;
    const snapshot = session.lastMessages;
    const messages = new Map<string, CoreMessage>();
    let bytes = 0;
    let discarded = false;
    const discard = () => { discarded = true; messages.clear(); };
    const put = (key: string, message: CoreMessage) => {
        if (discarded) return;
        const previous = messages.get(key);
        const size = (m: CoreMessage) => Buffer.byteLength(m.text ?? "") + Buffer.byteLength(m.toolName ?? "") + Buffer.byteLength(m.toolCallId ?? "") + 128;
        bytes += size(message) - (previous ? size(previous) : 0);
        if (bytes > HANDOFF_REPLY_MAX_BYTES) { discard(); return; }
        messages.set(key, message);
    };
    return {
        append(key: string, contentType: "text" | "reasoning", text: string) {
            if (!text || discarded) return;
            put(key, { id: `reply_${key}`, role: "assistant", contentType, text: (messages.get(key)?.text ?? "") + text });
        },
        tool(key: string, toolName: string, toolCallId: string, text: string) {
            put(key, { id: `reply_${key}`, role: "assistant", contentType: "tool-call", toolName, toolCallId, text });
        },
        replace(next: CoreMessage[]) {
            messages.clear();
            bytes = 0;
            for (const [i, m] of next.entries()) put(String(i), { id: `reply_${i}`, role: "assistant", contentType: m.contentType, text: m.text, toolName: m.toolName, toolCallId: m.toolCallId });
        },
        discard,
        save() {
            if (discarded || !messages.size || session.stats.requests !== request || session.lastMessages !== snapshot || !canSave()) return;
            session.metadata.handoffResponse = { request, messages: [...messages.values()] };
            markDirty(session);
        },
    };
}

export function captureHandoffJson(reply: HandoffReply | undefined, protocol: string | undefined, json: Record<string, unknown>): void {
    if (!reply) return;
    try {
        if (json.error || (protocol === "responses" && json.status && json.status !== "completed")) { reply.discard(); return; }
        let messages: CoreMessage[];
        if (protocol === "openai") {
            const message = (json.choices as Array<{ message?: unknown }> | undefined)?.[0]?.message;
            messages = openaiToCore({ messages: [message] } as Parameters<typeof openaiToCore>[0]).msgs;
        } else if (protocol === "anthropic") {
            messages = anthropicToCore({ messages: [json] } as Parameters<typeof anthropicToCore>[0]).msgs;
        } else if (protocol === "responses") {
            messages = responsesToCore({ input: json.output } as Parameters<typeof responsesToCore>[0]).msgs;
        } else if (protocol === "google") {
            const content = (json.candidates as Array<{ content?: unknown }> | undefined)?.[0]?.content;
            messages = googleToCore({ contents: [content] } as Parameters<typeof googleToCore>[0]).msgs;
        } else return;
        reply.replace(messages.filter((m) => m.role === "assistant"));
    } catch (err) {
        loggerLog("debug", `[handoff] JSON reply capture skipped (codec failed for protocol ${protocol ?? "unknown"}): ${err instanceof Error ? err.message : String(err)}`);
        reply.discard();
    }
}
