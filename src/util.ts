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

/** True if a socket remote address is loopback. Covers the IPv4 127.0.0.0/8
 *  block and IPv6 ::1, including the IPv4-mapped ::ffff:127.x.x.x form Node
 *  reports for dual-stack sockets. Shared by the admin-endpoint gate
 *  (server.ts) and the MITM CONNECT gate (mitm.ts) — keep one definition so
 *  the two security checks cannot drift apart. */
export function isLoopbackAddress(addr: string | undefined): boolean {
    return !!addr && (addr.startsWith("127.") || addr === "::1" || addr.startsWith("::ffff:127."));
}

export type WireProtocol = "anthropic" | "openai" | "responses";

/**
 * Compute the true TOTAL input-token count and the cached subset from a
 * protocol-native `usage` object.
 *
 * The three wire protocols report input tokens differently:
 *   - Anthropic: `input_tokens` is the NEW (uncached) portion ONLY; the cached
 *     (`cache_read_input_tokens`) and cache-write (`cache_creation_input_tokens`)
 *     portions are reported as separate fields.
 *   - OpenAI Chat: `prompt_tokens` is the TOTAL — it ALREADY includes the
 *     `prompt_tokens_details.cached_tokens` subset.
 *   - Responses: `input_tokens` is the TOTAL — it ALREADY includes the
 *     `input_tokens_details.cached_tokens` subset.
 *
 * The nudge decision (context size) and the cache-hit ratio both need the
 * TOTAL. The previous code computed `prompt + cached` uniformly, which is only
 * correct for Anthropic; for OpenAI/Responses it double-counts the cached
 * portion, inflating the reported context size (→ premature compression) and
 * deflating the reported cache-hit rate.
 */
export function usageTotals(
    protocol: WireProtocol,
    usage: Record<string, unknown>,
): { total: number | undefined; cached: number | undefined } {
    const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
    if (protocol === "anthropic") {
        const fresh = num(usage["input_tokens"]);
        const read = num(usage["cache_read_input_tokens"]);
        const creation = num(usage["cache_creation_input_tokens"]);
        const any = fresh !== undefined || read !== undefined || creation !== undefined;
        return {
            total: any ? (fresh ?? 0) + (read ?? 0) + (creation ?? 0) : undefined,
            cached: read,
        };
    }
    if (protocol === "openai") {
        return {
            total: num(usage["prompt_tokens"]),
            cached: num((usage["prompt_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]),
        };
    }
    // responses
    return {
        total: num(usage["input_tokens"]),
        cached: num((usage["input_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]),
    };
}
