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
