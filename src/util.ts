import { createHash } from "node:crypto";
import type { NudgeDecision } from "acp-kernel";

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

/**
 * The kernel's own lower-bound estimate of the current context size, from the
 * nudge decision's tier breakdown: pending T1 (uncompressed messages) plus the
 * current size of the active T2/T3 block summaries. The context also carries
 * the system prompt, tool schemas and protected messages, so this is a floor,
 * never an overcount of the truth — except that the fast tokenizer
 * undercounts CJK (see server.ts tokenCount comment), which makes the floor
 * even more conservative.
 */
export function pendingEstimateTokens(nudge: NudgeDecision | null | undefined): number {
    const b = nudge?.breakdown;
    if (!b) return 0;
    return (b.pendingT1 ?? 0) + (b.pendingT2 ?? 0) + (b.pendingT3 ?? 0);
}

/**
 * Floor a relay-reported context size against the kernel's estimate. Some
 * relays report `input_tokens` far below the real context (aihub/MiniMax-M3
 * reported 5720 while the kernel counted 29238 pending T1 alone — issue #256);
 * a nudge keyed on that number never fires, so compression never happens
 * proactively. The floor engages only when the report is materially below the
 * estimate (>10% AND >=2048 tokens) — small discrepancies are tokenizer
 * noise, and the estimate is a lower bound, so flooring can only ever make
 * the nudge slightly more eager, never less. A 0 report is never legitimate
 * for a non-empty prompt; it is replaced by the estimate when that is
 * significant.
 */
export function applyUsageFloor(reported: number, floor: number): number {
    if (floor <= 0) return reported;
    if (reported <= 0) return floor > 2048 ? floor : reported;
    if (floor - reported <= Math.max(2048, Math.round(reported * 0.1))) return reported;
    return floor;
}

/** Result of inspecting an upstream response for a "context too long" error. */
export interface ContextOverflowInfo {
    /** True if the response looks like an upstream context-overflow error. */
    isOverflow: boolean;
    /** The real context window (tokens) learned from the error body, if any
     *  confident number is present. */
    window?: number;
    /** Truncated error-body text, for logging. */
    message: string;
}

// Upstream "context too long" markers across providers. Deliberately specific:
// NO bare "too many tokens" — that is Bedrock's *throttle* phrase (a 429 the
// client should back off on), not a context overflow.
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
    /context_length_exceeded/i,
    /context length exceeded/i,
    /maximum context length/i,
    /max context length/i,
    /maximum context size/i,
    /exceeds the context window/i,
    /exceeded model token limit/i,
    /prompt is too long/i,
    /prompt_too_long/i,
    /prompt_is_too_long/i,
    /request_too_large/i,
    /token limit exceeded/i,
];

function toTokenNumber(s: string): number | undefined {
    const n = parseInt(s.replace(/,/g, ""), 10);
    // A plausible window is at least a few thousand tokens; smaller numbers in
    // the message (e.g. "5 inputs", a request id) are not the window.
    return Number.isFinite(n) && n >= 1000 ? n : undefined;
}

/** Best-effort extraction of the real context window from an overflow error
 *  body. Returns undefined when no confident window number is present — a wrong
 *  guess (e.g. the prompt size, not the limit) is worse than no guess. */
function parseOverflowWindow(text: string): number | undefined {
    // "130000 tokens > 128000 maximum" (Anthropic) → the maximum, not the total.
    let m = text.match(/>\s*(\d[\d,]*)\s*maximum/i);
    if (m) return toTokenNumber(m[1]);
    m =
        text.match(/maximum context length is (\d[\d,]*)/i) ??
        text.match(/maximum context length of (\d[\d,]*)/i) ??
        text.match(/maximum context size (?:is|of) (\d[\d,]*)/i) ??
        text.match(/(?:maximum|max)\s+(?:context\s+)?length\s+(?:is\s+)?(\d[\d,]*)/i) ??
        text.match(/limit of (\d[\d,]*)\s*token/i) ??
        text.match(/(\d[\d,]*)\s*maximum\b/i);
    if (m) return toTokenNumber(m[1]);
    return undefined;
}

/** Inspect an upstream response for a context-overflow error. `status` is the
 *  HTTP status; `bodyText` is the (usually small) error body. Only 400/413 with
 *  a recognized context-too-long marker counts. */
export function inspectContextOverflow(status: number, bodyText: string): ContextOverflowInfo {
    const message = (bodyText ?? "").slice(0, 300);
    if (status !== 400 && status !== 413) return { isOverflow: false, message };
    if (!bodyText) return { isOverflow: false, message };
    const isOverflow = CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(bodyText));
    if (!isOverflow) return { isOverflow: false, message };
    return { isOverflow: true, window: parseOverflowWindow(bodyText), message };
}

/**
 * Reserve the model's OUTPUT budget from the context window so the kernel's
 * nudge/truncate bands (a fraction of the window) sit below (window - maxOutput)
 * and a context+output overflow can't happen on a small window (e.g. 100k with a
 * large max_tokens). Returns the effective window to hand to the kernel. No-op
 * unless maxOutput is a positive finite number that leaves a usable window
 * (maxOutput < window) — a request whose output budget is >= the whole window is
 * degenerate and the self-heal handles the resulting overflow instead.
 */
export function reserveOutputHeadroom(window: number, maxOutput: number): number {
    if (Number.isFinite(window) && window > 0 && Number.isFinite(maxOutput) && maxOutput > 0 && maxOutput < window) {
        return window - maxOutput;
    }
    return window;
}

/**
 * Whether the OUTPUT budget should be reserved from the context window at all.
 * Anthropic's Messages API enforces the input limit INDEPENDENTLY of
 * max_tokens (the output budget is separate — input up to the window works
 * with any max_tokens), so reserving it would shift the nudge/truncate bands
 * down by maxOutput on every session with no safety gain. The OpenAI-family
 * APIs count output against the window, so the reservation is only needed
 * there. Unknown/other protocols reserve (conservative — a missed reservation
 * at worst overflows once and the self-heal corrects it).
 */
export function shouldReserveOutputHeadroom(protocol: string | undefined): boolean {
    return protocol !== "anthropic";
}
