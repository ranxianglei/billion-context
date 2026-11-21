// Codex's live WebSocket checkpoint can contain the provider's output item,
// while a reconnect resends the same item serialized from Codex's history.
// Normalize only the observed, plain-text assistant shape. In particular,
// unknown fields and attribution are not safe to infer or discard.
type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: JsonObject, allowed: ReadonlySet<string>): boolean {
    return Object.keys(value).every((key) => allowed.has(key));
}

const ITEM_KEYS = new Set(["type", "id", "status", "role", "content", "phase", "metadata", "internal_chat_message_metadata_passthrough"]);
const CONTENT_KEYS = new Set(["type", "text", "annotations", "logprobs"]);
const PASSTHROUGH_KEYS = new Set(["turn_id", "create_time", "content_token_count", "content_item_kinds"]);

/** Return an equivalent replay item, or the original item when its safety
 * cannot be established. Never edit the caller's item or the streamed output. */
export function normalizeCodexWsReplayItem(item: unknown): unknown {
    if (!object(item) || !onlyKeys(item, ITEM_KEYS) || item.type !== "message" || item.role !== "assistant"
        || item.status !== "completed" || typeof item.id !== "string" || !item.id.startsWith("msg_")
        || (item.phase !== undefined && item.phase !== "commentary" && item.phase !== "final_answer")
        || !Array.isArray(item.content) || item.content.length !== 1) return item;
    const part: unknown = item.content[0];
    if (!object(part) || !onlyKeys(part, CONTENT_KEYS) || part.type !== "output_text" || typeof part.text !== "string"
        || (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length !== 0))
        || (part.logprobs !== undefined && (!Array.isArray(part.logprobs) || part.logprobs.length !== 0))) return item;
    const pass = item.internal_chat_message_metadata_passthrough;
    if (!object(pass) || !onlyKeys(pass, PASSTHROUGH_KEYS) || typeof pass.turn_id !== "string" || !pass.turn_id
        || typeof pass.create_time !== "number" || !Number.isFinite(pass.create_time)) return item;
    if (pass.content_token_count !== undefined
        && (typeof pass.content_token_count !== "number" || !Number.isSafeInteger(pass.content_token_count) || pass.content_token_count < 0)) return item;
    // Codex treats an unclassified historical content item as unknown. Do not
    // drop any explicit classification or per-item attribution.
    if (pass.content_item_kinds !== undefined
        && (!Array.isArray(pass.content_item_kinds) || pass.content_item_kinds.length !== 1 || pass.content_item_kinds[0] !== "unknown")) return item;
    if (item.metadata !== undefined
        && (!object(item.metadata) || !onlyKeys(item.metadata, new Set(["turn_id"])) || item.metadata.turn_id !== pass.turn_id)) return item;

    // content_token_count is read-only telemetry in Codex and is never replayed.
    // The only accepted top-level metadata is the same turn_id already kept in
    // passthrough; the only accepted classification is equivalent to missing.
    // Build the same order on both paths without touching content or phase.
    return {
        type: item.type,
        status: item.status,
        id: item.id,
        role: item.role,
        content: item.content,
        ...(item.phase !== undefined ? { phase: item.phase } : {}),
        internal_chat_message_metadata_passthrough: { turn_id: pass.turn_id, create_time: pass.create_time },
    };
}

export function normalizeCodexWsReplayInput(input: unknown[]): unknown[] {
    return input.map(normalizeCodexWsReplayItem);
}

const REASONING_KEYS = new Set(["type", "id", "summary", "content", "encrypted_content", "metadata", "internal_chat_message_metadata_passthrough"]);
const REASONING_PASSTHROUGH_KEYS = new Set(["turn_id", "create_time"]);
const TURN_METADATA_KEYS = new Set(["turn_id"]);

/** Normalize only the observed encrypted Codex reasoning envelope. This is
 * an egress operation: applying it to the incoming history would change the
 * kernel's opaque identity. The encrypted payload and summary stay verbatim.
 * Unknown fields, attribution, and nonempty content are left untouched. */
function normalizeCodexReasoningEgressItem(item: unknown): unknown {
    if (!object(item) || !onlyKeys(item, REASONING_KEYS) || item.type !== "reasoning"
        || typeof item.id !== "string" || !item.id.startsWith("rs_")
        || !Array.isArray(item.summary)
        || typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0
        || (item.content !== undefined && item.content !== null
            && (!Array.isArray(item.content) || item.content.length !== 0))) return item;

    const pass = item.internal_chat_message_metadata_passthrough;
    if (pass !== undefined && (!object(pass) || !onlyKeys(pass, REASONING_PASSTHROUGH_KEYS)
        || typeof pass.turn_id !== "string" || !pass.turn_id
        || (pass.create_time !== undefined && (typeof pass.create_time !== "number" || !Number.isFinite(pass.create_time))))) return item;
    if (item.metadata !== undefined
        && (!object(item.metadata) || !onlyKeys(item.metadata, TURN_METADATA_KEYS)
            || !object(pass) || item.metadata.turn_id !== pass.turn_id)) return item;

    return {
        type: item.type,
        id: item.id,
        summary: item.summary,
        encrypted_content: item.encrypted_content,
        ...(object(pass) ? { internal_chat_message_metadata_passthrough: {
            turn_id: pass.turn_id,
            ...(pass.create_time !== undefined ? { create_time: pass.create_time } : {}),
        } } : {}),
    };
}

/** The wire representation and the upstream continuation comparison must use
 * the same equivalence; ingress intentionally uses assistant normalization
 * only, so historical reasoning identifiers remain unchanged. */
export function normalizeCodexResponsesEgressItem(item: unknown): unknown {
    return normalizeCodexReasoningEgressItem(normalizeCodexWsReplayItem(item));
}

export function normalizeCodexResponsesEgressInput(input: unknown[]): unknown[] {
    return input.map(normalizeCodexResponsesEgressItem);
}
