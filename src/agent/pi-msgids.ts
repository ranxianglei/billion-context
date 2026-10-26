// #4491 pi host wiring (plugin-lane server history): resolve the pi session's
// stable message ids (SessionEntry.id — randomUUID first 8 hex, stable across
// every host operation) for the OUTGOING wire messages of a provider request,
// so the incremental lane can pin the client's own ids onto its server
// canonical (`msgIds`, parallel to the lane body's `messages`).
//
// The wire messages are NOT the session messages: pi converts the branch
// through buildContextEntries → convertToLlm → transformMessages →
// convertMessages (drop empty texts, merge consecutive tool results into one
// user message, sanitize lone surrogates, cross-model thinking rules). This
// walker never re-implements that pipeline — it walks wire messages and branch
// entries in lockstep and accepts an id only when the pair provably denotes
// the same message:
//   - each step compares an order-preserving content fingerprint (text,
//     image bytes, thinking text, redacted payload, tool-call ids) with EXACT
//     equality — never similarity, never position alone;
//   - entries that provably produce no wire message (empty text) are skipped;
//   - anything the walker cannot prove (agent-message roles with derived
//     text, compaction/branch summaries, alien block types, any mismatch)
//     aborts the whole resolution — all-or-nothing: one unresolvable message
//     and the turn ships WITHOUT msgIds, so the lane falls back to
//     content-derived ids, exactly today's behavior.
//
// Fingerprint mirroring (verified against pi 0.99.1 dist): text blocks drop
// when whitespace-only on BOTH sides; thinking blocks ride verbatim on the
// same model (empty text kept iff a signature exists) and mismatch → bail on
// cross-model rewrites; tool_use/tool_result match by call id (unique within
// a branch path — ids are minted once per call); lone surrogates are stripped
// with pi's own regex; cache_control decorations are ignored (the wire may
// add them; they never change identity).

type FpPart = { t: "text" | "img" | "tooluse" | "toolres" | "think" | "redact"; v: string };

/** Mirror of pi's sanitizeSurrogates (utils/sanitize-unicode.js): strips
 *  unpaired surrogates so both sides of a comparison normalize identically. */
function stripLoneSurrogates(text: string): string {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function textPart(text: unknown): FpPart | undefined {
    if (typeof text !== "string") return undefined;
    if (text.trim().length === 0) return undefined; // dropped by the conversion
    return { t: "text", v: stripLoneSurrogates(text) };
}

/** Fingerprint of a user-like content (string | text/image blocks) — the
 *  shape pi's user messages AND custom messages share on the wire. An empty
 *  result means the conversion provably drops the message. */
function userLikeParts(content: unknown): FpPart[] | undefined {
    if (content === null || content === undefined) return [];
    if (typeof content === "string") {
        const p = textPart(content);
        return p === undefined ? [] : [p];
    }
    if (!Array.isArray(content)) return undefined;
    const parts: FpPart[] = [];
    for (const raw of content) {
        if (raw === null || typeof raw !== "object") return undefined;
        const block = raw as Record<string, unknown>;
        if (block.type === "text") {
            const p = textPart(block.text);
            if (p !== undefined) parts.push(p);
        } else if (block.type === "image") {
            if (typeof block.data !== "string") return undefined;
            parts.push({ t: "img", v: block.data });
        } else {
            return undefined;
        }
    }
    return parts;
}

/** Fingerprint of an assistant AgentMessage content (text / thinking /
 *  toolCall blocks). undefined = shape this walker refuses to reason about. */
function assistantParts(content: unknown): FpPart[] | undefined {
    if (content === null || content === undefined) return [];
    if (!Array.isArray(content)) return undefined;
    const parts: FpPart[] = [];
    for (const raw of content) {
        if (raw === null || typeof raw !== "object") return undefined;
        const block = raw as Record<string, unknown>;
        if (block.type === "text") {
            const p = textPart(block.text);
            if (p !== undefined) parts.push(p);
        } else if (block.type === "thinking") {
            if (block.redacted === true) {
                if (typeof block.thinkingSignature !== "string") return undefined;
                parts.push({ t: "redact", v: block.thinkingSignature });
                continue;
            }
            if (typeof block.thinking !== "string") return undefined;
            const hasSignature = typeof block.thinkingSignature === "string" && block.thinkingSignature.trim().length > 0;
            // The conversion keeps an empty-text thinking block iff a
            // signature exists — mirror that, else the block is dropped.
            if (block.thinking.trim().length > 0 || hasSignature) parts.push({ t: "think", v: stripLoneSurrogates(block.thinking) });
        } else if (block.type === "toolCall") {
            if (typeof block.id !== "string" || block.id.length === 0) return undefined;
            parts.push({ t: "tooluse", v: block.id });
        } else {
            return undefined;
        }
    }
    return parts;
}

/** Fingerprint of one OUTGOING wire message (anthropic shape). undefined =
 *  unprovable (alien role/block); [] = cannot happen on the wire (the
 *  conversion drops empty messages) — treated as unprovable by the caller. */
function wireFingerprint(msg: unknown): FpPart[] | undefined {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return undefined;
    const role = (msg as Record<string, unknown>).role;
    const content = (msg as Record<string, unknown>).content;
    if (role !== "user" && role !== "assistant") return undefined;
    if (typeof content === "string") {
        if (role !== "assistant") {
            const p = textPart(content);
            return p === undefined ? [] : [p];
        }
        return undefined; // pi never sends assistant string content
    }
    if (!Array.isArray(content)) return undefined;
    const parts: FpPart[] = [];
    for (const raw of content) {
        if (raw === null || typeof raw !== "object") return undefined;
        const block = raw as Record<string, unknown>;
        if (block.type === "text") {
            const p = textPart(block.text);
            if (p !== undefined) parts.push(p);
        } else if (block.type === "thinking") {
            if (typeof block.thinking !== "string") return undefined;
            parts.push({ t: "think", v: stripLoneSurrogates(block.thinking) });
        } else if (block.type === "redacted_thinking") {
            if (typeof block.data !== "string") return undefined;
            parts.push({ t: "redact", v: block.data });
        } else if (block.type === "tool_use") {
            if (typeof block.id !== "string" || block.id.length === 0) return undefined;
            parts.push({ t: "tooluse", v: block.id });
        } else if (block.type === "tool_result") {
            if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) return undefined;
            parts.push({ t: "toolres", v: block.tool_use_id });
        } else if (block.type === "image") {
            const source = block.source;
            if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined;
            const data = (source as Record<string, unknown>).data;
            if (typeof data !== "string") return undefined;
            parts.push({ t: "img", v: data });
        } else {
            return undefined;
        }
    }
    return parts;
}

/** Fingerprint of one branch entry's context contribution. undefined =
 *  unprovable (unsupported entry/message shape); [] = provably produces no
 *  wire message. */
function entryFingerprint(entry: Record<string, unknown>): FpPart[] | undefined {
    if (entry.type === "message") {
        const raw = entry.message;
        if (raw === null || typeof raw !== "object") return undefined;
        const msg = raw as Record<string, unknown>;
        if (msg.role === "user" || msg.role === "custom") return userLikeParts(msg.content);
        if (msg.role === "assistant") return assistantParts(msg.content);
        if (msg.role === "toolResult") {
            if (typeof msg.toolCallId !== "string" || msg.toolCallId.length === 0) return undefined;
            return [{ t: "toolres", v: msg.toolCallId }];
        }
        return undefined; // bashExecution / branchSummary / compactionSummary / …
    }
    if (entry.type === "custom_message") return userLikeParts(entry.content);
    return undefined;
}

/** Session entry types that never contribute to the LLM context. */
const CONTEXT_SILENT_ENTRY_TYPES = new Set(["thinking_level_change", "model_change", "label", "session_info", "custom"]);

/** Walk the outgoing wire messages and the branch entries in lockstep; return
 *  the entry id for every wire message (aligned by index), or undefined when
 *  the alignment cannot be proven end-to-end (all-or-nothing). */
export function laneMsgIdsForWire(wire: unknown, branch: unknown): string[] | undefined {
    if (!Array.isArray(wire) || !Array.isArray(branch)) return undefined;
    const entries = branch as unknown[];
    let ei = 0;
    // Next visible (wire-producing) entry past every provably silent one.
    // "bail" = unprovable shape; "exhausted" = no entries left.
    const take = (): { id: string; parts: FpPart[] } | "bail" | "exhausted" => {
        while (ei < entries.length) {
            const raw = entries[ei];
            ei += 1;
            if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "bail";
            const entry = raw as Record<string, unknown>;
            if (typeof entry.type !== "string") return "bail";
            if (entry.type === "message" || entry.type === "custom_message") {
                const parts = entryFingerprint(entry);
                if (parts === undefined) return "bail";
                if (parts.length === 0) continue; // provably invisible on the wire
                if (typeof entry.id !== "string" || entry.id.length === 0) return "bail";
                return { id: entry.id, parts };
            }
            if (CONTEXT_SILENT_ENTRY_TYPES.has(entry.type)) continue;
            // compaction / branch_summary / unknown types: the context shape
            // (compaction-aware prefix replacement) is not derivable here.
            return "bail";
        }
        return "exhausted";
    };
    const ids: string[] = [];
    for (const w of wire) {
        const wParts = wireFingerprint(w);
        if (wParts === undefined || wParts.length === 0) return undefined;
        if (wParts.every((p) => p.t === "toolres")) {
            // Merged consecutive tool results: ONE wire message, N entries.
            for (const part of wParts) {
                const n = take();
                if (typeof n === "string" || n.parts.length !== 1 || n.parts[0].t !== "toolres" || n.parts[0].v !== part.v) return undefined;
                ids.push(n.id);
            }
            continue;
        }
        const n = take();
        if (typeof n === "string") return undefined;
        if (n.parts.length !== wParts.length || n.parts.some((p, i) => p.t !== wParts[i].t || p.v !== wParts[i].v)) return undefined;
        ids.push(n.id);
    }
    // A visible entry surviving past the wire's end means the request dropped
    // a message this walk cannot explain — refuse rather than guess.
    const leftover = take();
    return leftover === "exhausted" ? ids : undefined;
}

/** #4491 lane contract: `msgIds` pins 1:1 onto the FLATTENED core messages
 *  (the kernel's anthropicToCore maps every block to its own message), and
 *  the lane hard-fails (400) when the id count matches the wire count but the
 *  flattened count differs. A delta message is pinnable only when it flattens
 *  to exactly one core message: a string, or a single-block content array. */
export function lanePinnableContent(content: unknown): boolean {
    return typeof content === "string" || (Array.isArray(content) && content.length === 1);
}
