import type { CoreMessage } from "acp-kernel";
import { anthropicToCore, googleToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
import { markDirty, type Session } from "../session.js";
import { log as loggerLog } from "../logger.js";

export const HANDOFF_REPLY_MAX_BYTES = 1_500_000;

export type HandoffReply = ReturnType<typeof createHandoffReply>;

export function createHandoffReply(session: Session, canSave: () => boolean = () => true) {
    const request = session.stats.requests;
    const snapshot = session.lastMessages;
    const messages = new Map<string, { message: CoreMessage; bytes: number; textBytes: number; lastCodeUnit: number }>();
    let bytes = 0;
    let discarded = false;
    const discard = () => { discarded = true; messages.clear(); };
    const put = (key: string, message: CoreMessage, textBytes?: number, lastCodeUnit?: number) => {
        if (discarded) return;
        const previous = messages.get(key);
        const text = message.text ?? "";
        const measuredTextBytes = textBytes ?? Buffer.byteLength(text);
        const size = measuredTextBytes + Buffer.byteLength(message.toolName ?? "") + Buffer.byteLength(message.toolCallId ?? "") + 128;
        bytes += size - (previous?.bytes ?? 0);
        if (bytes > HANDOFF_REPLY_MAX_BYTES) { discard(); return; }
        messages.set(key, { message, bytes: size, textBytes: measuredTextBytes, lastCodeUnit: lastCodeUnit ?? text.charCodeAt(text.length - 1) });
    };
    return {
        append(key: string, contentType: "text" | "reasoning", text: string) {
            if (!text || discarded) return;
            const previous = messages.get(key);
            const last = previous?.lastCodeUnit ?? 0;
            const first = text.charCodeAt(0);
            // Two separately encoded lone surrogates use six bytes; joined
            // across deltas they form one four-byte code point. Keep only the
            // trailing code unit so metering never rescans the growing prefix.
            const joinsPair = last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
            const textBytes = (previous?.textBytes ?? 0) + Buffer.byteLength(text) - (joinsPair ? 2 : 0);
            put(key, { id: `reply_${key}`, role: "assistant", contentType, text: (previous?.message.text ?? "") + text }, textBytes, text.charCodeAt(text.length - 1));
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
            session.metadata.handoffResponse = { request, messages: [...messages.values()].map((entry) => entry.message) };
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
