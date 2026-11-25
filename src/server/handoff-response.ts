import type { CoreMessage } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { anthropicToCore, canonicalToolArgs, ClusterCounter, deriveCanonicalMessageId, googleToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
import { markDirty, type Session } from "../session.js";
import { log as loggerLog } from "../logger.js";
import { planStoredMessageRow, type HandoffReplyStashRow } from "../storage/ingest.js";

export const HANDOFF_REPLY_MAX_BYTES = 1_500_000;

export type HandoffReply = ReturnType<typeof createHandoffReply>;

/**
 * #6947: canonical base id (WITHOUT the ClusterCounter `_N` suffix) re-derived
 * from a core message's OWN fields — the inverse of what each protocol codec
 * feeds deriveCanonicalMessageId (#3642). Lets the write-back pre-seed a
 * ClusterCounter from the cores already stored, so appended reply ids number
 * exactly as the next full codec pass over [stored…, reply…] would (the
 * re-send then joins by (msg_id, identity) onto the SAME rows instead of
 * retiring + re-ingesting). Host-side on purpose: the kernel boundary (#2092)
 * is human-gated and the kernel already exports both seed helpers.
 *
 * Returns null when the base cannot be derived from core fields alone: image
 * parts (the #3751 payload fingerprint lives in sidecars the handoff capture
 * never sets — unreachable here, null is the honest answer) and unknown
 * content types. Callers skip nulls: an under-count can only shift a cluster
 * SUFFIX for an identical repeated identity, never mint a wrong bare id.
 */
function baseIdOfCore(m: BiliMessage): string | null {
    const text = m.text ?? "";
    switch (m.contentType) {
        case "text":
            if (m.imagePart) return null;
            return deriveCanonicalMessageId(m.originalRole ?? m.role, "text", text);
        case "reasoning":
            return deriveCanonicalMessageId("assistant", "reasoning", text);
        case "tool-call":
            return deriveCanonicalMessageId("assistant", "tool-call", canonicalToolArgs(text), { toolName: m.toolName });
        case "tool-result":
            return deriveCanonicalMessageId("tool", "tool-result", text, { toolName: m.toolName });
        default:
            return null;
    }
}

/**
 * #6947 join polish: re-stamp the sidecars each protocol codec would add on
 * the NEXT re-send, so the write-back row's stored bytes join the re-send
 * row's by identity (identityOfStoredContent strips only id/wireIndex —
 * every other field counts). Without this, the re-send ingest lands a
 * second row for the same logical message (tombstone churn + the content
 * CAS storing the reply bytes twice) on long sessions:
 *  - openai reasoning cores carry `reasoningContent` (the codec stamps the
 *    reasoning text a second time — kernel/src/wire/openai.ts);
 *  - openai clients (pi) re-serialize tool-call args with parse +
 *    JSON.stringify (compact, key order preserved) and the anthropic codec
 *    stores safeStringify(input) — both reduce to the same normalization
 *    of the verbatim streamed args.
 * Lanes whose codecs attach payload sidecars the text capture cannot
 * reproduce (google rawGoogleParts / responses rawResponsesItem /
 * anthropic thinkingSignature) keep the write-back row byte-distinct —
 * accepted residual, same class as client round-trip drift.
 */
function restampForJoin(protocol: string | undefined, m: CoreMessage): CoreMessage {
    const b = m as BiliMessage;
    const text = b.text ?? "";
    if (b.contentType === "reasoning" && protocol === "openai") {
        const stamped: BiliMessage = { ...b, reasoningContent: text };
        return stamped as CoreMessage;
    }
    if (b.contentType === "tool-call" && (protocol === "openai" || protocol === "anthropic")) {
        try {
            const parsed: unknown = JSON.parse(text);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return { ...m, text: JSON.stringify(parsed) };
        } catch { /* non-JSON args: keep the verbatim bytes */ }
    }
    return m;
}

export function createHandoffReply(session: Session, canSave: () => boolean = () => true, protocol?: string) {
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
            // #6947 turn-final write-back (direction C — persistence is
            // separated from the session identity ledger): the reply rows
            // historically only persisted when a LATER request re-sent them
            // (snapshotMessages replaces lastMessages from the request
            // array), so an idle session's last turn never reached the store
            // — the web UI kept showing the previous (stale) reply forever.
            // We must NOT append the reply to the snapshot: lastMessages is
            // the single source of truth for the resident window (digest
            // parity, web view, fork refs), and the reply's REF is minted by
            // the kernel only when a request presents it — pushing it here
            // created a window where fork/snapshot saw a message with no
            // ref and 409'd (review regression, #6953).
            // Instead the captured reply is stashed as plan-ready rows in
            // metadata.handoffReply (persisted → both views digest-equal).
            // Ids are derived EXACTLY as the next codec pass will derive
            // them: the SAME canonical seed the codecs feed
            // deriveCanonicalMessageId (#3642 — role|contentType with the
            // toolCallId slot pinned empty, toolName, and canonicalToolArgs
            // for tool calls; wire toolCallIds are transport plumbing, never
            // content identity) and the same cluster numbering (Nth
            // occurrence of the same base, counted in arrival order over the
            // snapshot). The planners turn the stash into trailing
            // NON-TAIL log rows (never tailSeqs), and the re-send — full or
            // delta path — JOINs them in place by msg_id+identity (#4390)
            // on EVERY content type, so the #3133 fast path stays green.
            // Worst case (client round-trip drift): one refused delta + one
            // redundant full re-ingest — never wrong rows.
            // Skipped when the snapshot is a bounded folded re-render: its
            // array is a pruned view, not the raw tail the store appends to.
            if (session.lastMessagesFolded !== true && Array.isArray(snapshot)) {
                const clusters = new ClusterCounter();
                for (const m of snapshot) {
                    const b = baseIdOfCore(m);
                    if (b !== null) clusters.next(b);
                }
                const rows: HandoffReplyStashRow[] = [];
                for (const entry of messages.values()) {
                    const m = restampForJoin(protocol, entry.message);
                    const b = baseIdOfCore(m);
                    // b is null only for image-part cores (the #3751 payload
                    // fingerprint lives in sidecars the capture never sets —
                    // it has no imagePart). Skip the row in that unreachable
                    // case: without a content-derived id the row could never
                    // join the re-send and would only ever be a duplicate —
                    // the reply then persists on re-send, as pre-#6947.
                    if (b === null) continue;
                    rows.push(planStoredMessageRow({ ...m, id: clusters.next(b) }));
                }
                // Each turn's save() overwrites the stash; after the re-send
                // presents the reply as a view row the planner gates it out
                // by msgId — no explicit consumption needed. The row bytes
                // duplicate metadata.handoffResponse for one turn (both
                // bounded by the HANDOFF_REPLY_MAX_BYTES cap) — accepted to
                // close the idle-persistence gap without touching the view.
                if (rows.length > 0) session.metadata["handoffReply"] = { request, rows };
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

