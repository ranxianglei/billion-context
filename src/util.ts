import { createHash } from "node:crypto";

/**
 * Cryptographic hash of a string, truncated to a 64-bit id (16 hex chars).
 *
 * Used for session-id derivation. The seed is the first user message content,
 * which is stable across turns within one conversation (the conversation grows
 * but its first message doesn't change) — so this produces a *deterministic*
 * session id that lets the proxy accumulate compression state across turns for
 * clients that don't send an explicit `x-acp-session` header.
 *
 * Determinism is a deliberate trade-off: it enables session continuity at the
 * cost that two *different* conversations that happen to share an opening
 * message will collapse onto the same session. The mitigation for that case is
 * for multi-agent setups to send an explicit `x-acp-session` header (see
 * README). Using SHA-256 (vs the previous 32-bit FNV-1a) drops the accidental
 * birthday-collision probability to negligible levels while preserving the
 * same-content → same-id invariant.
 */
export function hashId(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

/** Parse JSON without throwing; returns {} for empty/invalid input. Used to
 *  tolerate malformed tool-call arguments and debug payloads. */
export function safeJsonParse(s: string): unknown {
    try {
        return s ? JSON.parse(s) : {};
    } catch {
        return {};
    }
}
