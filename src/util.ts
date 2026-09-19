import { createHash } from "node:crypto";

// #920: stamped per request by the opencode thin plugin for LEGACY
// opencode-acp sessions (acp state on disk). The proxy (server.ts) forwards
// such requests verbatim — no session binding, no tool injection, no
// compression — because acp owns those sessions' context in-process. Clients
// never send this header except through our own plugin.
export const BILI_PLUGIN_BYPASS_HEADER = "x-bili-plugin-bypass";

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

export type WireProtocol = "anthropic" | "openai" | "responses" | "google";

/**
 * Compute the true TOTAL input-token count and the cached subset from a
 * protocol-native `usage` object.
 *
 * The three wire protocols report input tokens differently:
 *   - Anthropic: `input_tokens` is the NEW (uncached) portion ONLY; the cached
 *     (`cache_read_input_tokens`) and cache-write (`cache_creation_input_tokens`)
 *     portions are reported as separate fields.
 *   - OpenAI Chat: `prompt_tokens` is the TOTAL — it ALREADY includes the
 *     `prompt_tokens_details.cached_tokens` subset (DeepSeek-style upstreams
 *     carry that subset as top-level `prompt_cache_hit_tokens`; both are
 *     normalized here, #779).
 *   - Responses: `input_tokens` is the TOTAL — it ALREADY includes the
 *     `input_tokens_details.cached_tokens` subset.
 *   - Google: `promptTokenCount` is the TOTAL of the `usageMetadata` object —
 *     it ALREADY includes the `cachedContentTokenCount` subset.
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
        const prompt = num(usage["prompt_tokens"]);
        // #779: DeepSeek-style upstreams carry the cached subset as top-level
        // prompt_cache_hit_tokens instead of prompt_tokens_details.cached_tokens.
        const cached = num((usage["prompt_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]) ?? num(usage["prompt_cache_hit_tokens"]);
        return {
            total: prompt !== undefined ? promptInputTotal("openai", prompt, cached) : undefined,
            cached,
        };
    }
    if (protocol === "google") {
        // Gemini reports the whole context as promptTokenCount, already
        // including the cachedContentTokenCount prefix (cached implicit
        // caching) — the OpenAI/Responses shape, not Anthropic's split one.
        const prompt = num(usage["promptTokenCount"]);
        const cached = num(usage["cachedContentTokenCount"]);
        return {
            total: prompt !== undefined ? promptInputTotal("google", prompt, cached) : undefined,
            cached,
        };
    }
    // responses
    return {
        total: num(usage["input_tokens"]),
        cached: num((usage["input_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]),
    };
}

/** #408: input-side total from a protocol-native input/cached pair.
 *  OpenAI/Responses report the TOTAL (cached already included); Anthropic
 *  reports fresh-only. Some OpenAI-wire upstreams violate that and report
 *  Anthropic-style split semantics (prompt_tokens = fresh-only, cached
 *  separate) — under true OpenAI semantics prompt_tokens >= cached_tokens
 *  always holds, so a violation proves the cached segment is NOT part of
 *  prompt_tokens and must be added back (e.g. {prompt_tokens:6,
 *  cached_tokens:26278} is a real ~26284-token prompt, not 6).
 *  #790: under split semantics the Anthropic cache-WRITE segment
 *  (`cache_creation_input_tokens`) is a third additive piece — part of the
 *  context size, but NOT a cache hit. */
export function promptInputTotal(
    protocol: WireProtocol | undefined,
    input: number | undefined,
    cached: number | undefined,
    creation?: number,
): number {
    if (input === undefined) return 0;
    const includesCached = protocol === "openai" || protocol === "responses" || protocol === "google";
    const splitSemantics = !includesCached || (typeof cached === "number" && input < cached);
    const additive =
        (splitSemantics && typeof cached === "number" ? cached : 0) +
        (splitSemantics && typeof creation === "number" ? creation : 0);
    return input + additive;
}

/** Output-side counterpart of usageTotals: the tokens the upstream billed for
 *  the reply. Google splits the number — `candidatesTokenCount` (visible text)
 *  plus `thoughtsTokenCount` (thinking), both billed — while every other wire
 *  reports a single field (kept permissive: some OpenAI-wire upstreams answer
 *  with `output_tokens`). Returns undefined when nothing was reported. */
export function usageOutputTotal(protocol: WireProtocol, usage: Record<string, unknown>): number | undefined {
    const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
    if (protocol === "google") {
        const candidates = num(usage["candidatesTokenCount"]);
        const thoughts = num(usage["thoughtsTokenCount"]);
        if (candidates === undefined && thoughts === undefined) return undefined;
        return (candidates ?? 0) + (thoughts ?? 0);
    }
    return num(usage["completion_tokens"]) ?? num(usage["output_tokens"]);
}

/** Result of inspecting an upstream response for a "context too long" error. */
export interface ContextOverflowInfo {
    /** True if the response looks like an upstream context-overflow error. */
    isOverflow: boolean;
    /** The context-window number stated in the error body, if a confident
     *  number is present. #987: this arms the one-shot emergency shrink — it
     *  is never persisted as a learned window. */
    window?: number;
    /** Truncated error-body text, for logging. */
    message: string;
}

// Upstream "context too long" markers across providers. Deliberately specific:
// NO bare "too many tokens" — that is Bedrock's *throttle* phrase (a 429 the
// client should back off on), not a context overflow.
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
    /context_length_exceeded/i,
    /context_window_exceeded/i,
    /context length exceeded/i,
    /maximum context length/i,
    /max context length/i,
    /maximum context size/i,
    /longer than the model'?s context length/i,
    /exceeds the context window/i,
    /out of room in the model/i,
    /exceeded model token limit/i,
    /prompt is too long/i,
    /prompt_too_long/i,
    /prompt_is_too_long/i,
    /request_too_large/i,
    /token limit exceeded/i,
    // #554: llama.cpp-family "exceed_context_size_error (A / B > W)" — carried by
    // side requests that bypass preflight; its number arms the emergency shrink.
    // #570: its body also carries the real window, see parseOverflowWindow.
    /exceed[_\s]?context[_\s]?size/i,
    // Gemini (generativelanguage.googleapis.com) 400 INVALID_ARGUMENT:
    // "The input token count (N) exceeds the maximum number of tokens allowed (W)."
    /exceeds the maximum number of tokens/i,
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
    // #554/#570: "exceed_context_size_error (198,277 / 198,661 > 150,528)"
    // (llama.cpp family) — A/B are payload sizes; only the number after ">" inside
    // the parens is the limit.
    m = text.match(/\(\s*\d[\d,]*\s*\/\s*\d[\d,]*\s*>\s*(\d[\d,]+)\s*\)/);
    if (m) return toTokenNumber(m[1]);
    // Gemini: "The input token count (1012345) exceeds the maximum number of
    // tokens allowed (1048576)." — the number after "allowed" is the window; the
    // first parenthesized number is the rejected payload and must not be used.
    m = text.match(/maximum number of tokens allowed\s*\((\d[\d,]*)\)/i);
    if (m) return toTokenNumber(m[1]);
    m =
        text.match(/maximum context length is (\d[\d,]*)/i) ??
        text.match(/maximum context length of (\d[\d,]*)/i) ??
        text.match(/maximum context size (?:is|of) (\d[\d,]*)/i) ??
        text.match(/(?:maximum|max)\s+(?:context\s+)?length\s+(?:is\s+)?(\d[\d,]*)/i) ??
        text.match(/context length\s*\((\d[\d,]*)\s*token/i) ??
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

/** Default cap on the output-headroom reservation, as a fraction of the
 *  context window (#896, aligned with billion-context-pi #207). Reserving the
 *  FULL registered max output halves the effective input budget on models whose
 *  max_tokens is a large share of the window (e.g. 131072 on a 262144 window),
 *  while real per-turn replies rarely approach it. Capping at 25% keeps the
 *  guarantee where it matters — any single-turn reply up to the reserved amount
 *  still fits at the 95% emergency threshold — while bounding the budget loss.
 *  A reply longer than the reservation overflows once; the overflow self-heal
 *  (armed emergency) recovers it on the next turn. */
export const DEFAULT_OUTPUT_HEADROOM_MAX_PCT = 0.25;

/** Resolve the user's `outputHeadroomMaxPct` (ratio or "N%" string) to a
 *  numeric cap, falling back to DEFAULT_OUTPUT_HEADROOM_MAX_PCT when unset.
 *  Shared by every headroom call site so they all measure against the SAME
 *  capped limit (#896). */
export function resolveOutputHeadroomCap(value: number | string | undefined): number {
    if (value === undefined) return DEFAULT_OUTPUT_HEADROOM_MAX_PCT;
    if (typeof value === "number") return value;
    const s = value.trim();
    return s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s);
}

/**
 * Reserve the model's OUTPUT budget from the context window so the kernel's
 * nudge/truncate bands (a fraction of the window) sit below (window - reserved)
 * and a context+output overflow can't happen on a small window (e.g. 100k with a
 * large max_tokens). Returns the effective window to hand to the kernel. No-op
 * unless maxOutput is a positive finite number that leaves a usable window
 * (maxOutput < window) — a request whose output budget is >= the whole window is
 * degenerate and the self-heal handles the resulting overflow instead.
 * `capPct` bounds the reservation as a fraction of the window: reserved =
 * min(maxOutput, capPct * window) (#896, same formula as billion-context-pi
 * #207). capPct semantics: <= 0 → no reservation; (0,1) → capped reservation;
 * >= 1 or non-finite → legacy full-capability reservation (input + a response
 * using its ENTIRE output budget always fits — what strict backends like
 * SGLang/vLLM enforce).
 */
export function reserveOutputHeadroom(window: number, maxOutput: number, capPct: number = 1): number {
    if (Number.isFinite(window) && window > 0 && Number.isFinite(maxOutput) && maxOutput > 0 && maxOutput < window) {
        const cap = Number.isFinite(capPct) ? Math.max(0, Math.min(capPct, 1)) : 1;
        const reserved = Math.min(maxOutput, cap * window);
        return reserved > 0 ? window - reserved : window;
    }
    return window;
}

/**
 * Convert mid-conversation system/developer messages to role "user", leaving
 * them at their original (mid-conversation) position. acp-kernel renders each
 * compressed block's summary as role:"system" anchored at the earliest message
 * its block covered. In PROXY mode (plain OpenAI client) the `compress` tool
 * call is ephemeral — it runs in the proxy's server-side loop and never enters
 * the client's re-sent history — and preflight blocks have no tool call at all,
 * so the summary must ride on a standalone message. A "user" message is allowed
 * anywhere in the conversation, whereas strict OpenAI-compatible backends
 * (sglang/vLLM with the Qwen3-family "system-first" chat template) require
 * EXACTLY ONE "system" message at index 0 and reject a mid-conversation or
 * second system message with 400 "System message must be at the beginning"
 * (#377). Keeping the summary mid-stream at its anchor (instead of hoisting it
 * to the head) also keeps the head system message — the prefix-cache anchor —
 * byte-stable across compress turns, so a new block does not invalidate the
 * whole-conversation prefix. In plugin/launcher mode the summary carrier is the
 * `compress` tool call (in the agent's own re-sent history), so the kernel's
 * acp_summary is stripped by stripKernelSummaries and this is a no-op there.
 * A summary is a stand-in for the folded history; re-voicing it as a user turn
 * is the accepted trade-off for SGLang compatibility + cache stability. No-op
 * (same array) when there is no system/developer message to convert.
 */
export function systemToUser<T extends { role: string }>(messages: T[]): T[] {
    let hasSys = false;
    for (const m of messages) {
        if (m.role === "system" || m.role === "developer") { hasSys = true; break; }
    }
    if (!hasSys) return messages;
    return messages.map((m) =>
        m.role === "system" || m.role === "developer"
            ? ({ ...m, role: "user" } as T)
            : m
    );
}

/** #719: Some OpenAI-compatible backends (DeepSeek) reject assistant messages
 * whose `content` is null — they require a string content (possibly "") or
 * tool_calls ("Invalid assistant message: content or tool_calls must be set").
 * coreToOpenai emits `content: null` for reasoning-only assistant turns (an
 * upstream stream truncated before any completion event leaves 0 text chars +
 * N reasoning chars; openaiToCore drops empty text, so both `content:""` and
 * `content:null` inputs rebuild as null). Force an empty string so the rebuilt
 * wire payload is always accepted; no-op when content is already a string or
 * an array of parts. Deterministic across turns → prefix-cache stable.
 */
export function hardenOpenaiAssistantContent<T extends { role: string }>(messages: T[]): T[] {
    return messages.map((m) => {
        if (m.role !== "assistant") return m;
        const c = (m as { content?: unknown }).content;
        if (c === null || c === undefined) return { ...m, content: "" } as T;
        return m;
    });
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
