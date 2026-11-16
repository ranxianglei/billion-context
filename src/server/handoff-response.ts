import type { CoreMessage } from "acp-kernel";
import { anthropicToCore, baseIdOfCore, ClusterCounter, googleToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
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
            // #6947 turn-final write-back: the reply rows historically only
            // persisted when a LATER request re-sent them (snapshotMessages
            // replaces lastMessages from the request array), so an idle
            // session's last turn never reached the store — the web UI kept
            // showing the previous (stale) reply forever. Append the captured
            // reply to the snapshot now, with ids derived EXACTLY as the next
            // codec pass will derive them: the SAME canonical seed the codecs
            // feed deriveCanonicalMessageId (#3642 — role|contentType with the
            // toolCallId slot pinned empty, toolName, and canonicalToolArgs for
            // tool calls; wire toolCallIds are transport plumbing, never
            // content identity) and the same cluster numbering (Nth occurrence
            // of the same base, counted in arrival order over the snapshot).
            // The re-send then JOINs these rows by msg_id+identity (#4390) on
            // EVERY content type — including tool calls — so the #3133 delta
            // fast path stays green (no per-tool-call refused-delta + O(n)
            // full re-ingest + retired-row accumulation on long sessions).
            // Legacy deriveMessageId (toolCallId slot filled, raw args text)
            // would only join for plain text/reasoning — superseded.
            // The #4182 stored-identity guard still makes the worst case
            // (client round-trip drift) one refused delta + one redundant
            // full re-ingest — never wrong rows.
            // Skipped when the snapshot is a bounded folded re-render: its
            // array is a pruned view, not the raw tail the store appends to.
            if (session.lastMessagesFolded !== true && Array.isArray(snapshot)) {
                const clusters = new ClusterCounter();
                for (const m of snapshot) {
                    const b = baseIdOfCore(m);
                    if (b !== null) clusters.next(b);
                }
                for (const entry of messages.values()) {
                    const m = entry.message;
                    const b = baseIdOfCore(m);
                    // b is null only for image-part cores (the #3751 payload
                    // fingerprint lives in sidecars the capture never sets —
                    // it has no imagePart); keep the synthetic id in that
                    // unreachable case rather than mint a wrong content id.
                    snapshot.push({ ...m, id: b !== null ? clusters.next(b) : m.id });
                }
            }
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

