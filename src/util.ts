import { createHash } from "node:crypto";
import type { AnthropicRequestBody } from "acp-kernel/wire";

// #920: stamped per request by the opencode thin plugin for LEGACY
// opencode-acp sessions (acp state on disk). The proxy (server.ts) forwards
// such requests verbatim — no session binding, no tool injection, no
// compression — because acp owns those sessions' context in-process. Clients
// never send this header except through our own plugin.
export const BILI_PLUGIN_BYPASS_HEADER = "x-bili-plugin-bypass";

// #1117: stamped by the native fetch patch (agent/native-intercept.ts) on
// model requests the host CANNOT attribute to its own agent chain (dsh:
// AsyncLocalStorage currentInitiator absent — e.g. a third-party in-process
// plugin riding the host's LLM bridge) whose URL is already /bili/-routed by
// the settings overlay and thus cannot be refused client-side. The proxy
// relays such requests byte-untouched — no session, no injection, no guard —
// mirroring what a direct send without the overlay would have been.
export const BILI_PASSTHROUGH_HEADER = "x-bili-passthrough";

// #4079: the MINIMUM window both egress oversize guards size against. A
// configured or declared window can be wrong SMALL — a stale
// modelContextLimit, a registry miss, a model-catalog fallback (#3993:
// 475K→258K), a plugin under-reporting — and a catastrophic-only byte-floor
// guard keyed to an undersized window would false-block bodies the real
// upstream accepts. Both guards (relay egress fuse, dsh gate oversize arms)
// therefore never size below the largest COMMON window: 1,000,000 tokens.
// The trade is deliberate: bodies that are "only" 2–5× a small declared
// window pass (preflight + calibration own that range); only bodies no
// 1M-token window could hold are stopped.
export const MIN_ASSUMED_WINDOW_TOKENS = 1_000_000;

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

/**
 * #1954 safety signal. bili's Responses adapter replays `input` as the FULL
 * conversation and strips `previous_response_id`, so it CANNOT materialize the
 * history a native-chaining continuation references. When we strip a non-empty
 * id, this returns an operator-facing warning: the request still succeeds with
 * HTTP 200, so without it the context loss is silent. Keys off the id ALONE —
 * not off `store` — because Responses stores responses by default, so an omitted
 * `store` still leaves the referenced response resolvable upstream; judging on
 * explicit `store:true` would miss the common case. Returns null when there is
 * nothing to warn about (absent / empty / non-string id).
 */
export function strippedResponseIdWarning(prevId: unknown): string | null {
    if (typeof prevId !== "string" || prevId.length === 0) return null;
    return `responses previous_response_id=${prevId} stripped without rebuilding referenced history (#1954): bili replays input as full history, so a Responses native-chaining (delta) continuation loses prior turns upstream yet still returns 200. Send full input/output history, or set ACP_KEEP_RESPONSE_ID=1 to preserve the id.`;
}

/** True if a socket remote address is loopback. Covers the IPv4 127.0.0.0/8
 *  block and IPv6 ::1, including the IPv4-mapped ::ffff:127.x.x.x form Node
 *  reports for dual-stack sockets. Shared by the admin-endpoint gate
 *  (server.ts) and the MITM CONNECT gate (mitm.ts) — keep one definition so
 *  the two security checks cannot drift apart. */
export function isLoopbackAddress(addr: string | undefined): boolean {
    return !!addr && (addr.startsWith("127.") || addr === "::1" || addr.startsWith("::ffff:127."));
}

/** #1933: reduce an upstream URL/origin to a comparable route key
 *  (scheme://host[:port]). Lanes report different shapes — `new URL().origin`
 *  from the forward path, full URLs with paths from resolveUpstream — and the
 *  baseline-provenance / calibration checks compare keys, so both must land on
 *  the same form. Provider routes may carry the `mitm://` config-lookup scheme
 *  (#2645): the egress path rewrites it to https:// (forwardUpstreamUrl), so
 *  reduce it identically here — otherwise a mitm route normalizes to the opaque
 *  "null" origin and can never match the https:// key the egress side records
 *  (the pck ablation lookup and the server.ts baseline-origin compare both hit
 *  this). Unparseable input falls back to its trimmed raw value. */
export function normalizeUpstreamOrigin(u: string | undefined): string | undefined {
    if (!u) return undefined;
    try {
        return new URL(u.replace(/^mitm:\/\//, "https://")).origin;
    } catch {
        const t = u.trim();
        return t || undefined;
    }
}

/** #1933 F1: apply the session's learned estimator scale k̂ to a raw local
 *  text estimate. The chars/4 estimator is a proxy whose ratio to real billing
 *  varies per upstream, so it may only decide on the route where k̂ was
 *  learned: both origins known and equal → scaled; either unknown or the
 *  routes differ → raw estimate unchanged (legacy behavior). */
export function applyEstimateCalibration(raw: number, k: number | undefined, kOrigin: string | undefined, origin: string | undefined): number {
    // Invalid factors (null/0/NaN/±Infinity — e.g. a corrupted persisted
    // session.stats field) must degrade to no-correction, never zero or
    // poison the reading: raw×0 would blind the estimate arm entirely.
    if (k === undefined || !Number.isFinite(k) || k <= 0 || raw <= 0) return raw;
    const a = normalizeUpstreamOrigin(origin);
    const b = normalizeUpstreamOrigin(kOrigin);
    if (a === undefined || b === undefined || a !== b) return raw;
    return raw * k;
}

/** #2117: read-side gate for the learned estimator scale — the model dimension
 *  of k̂ provenance. A factor published against model X must not decide on
 *  model Y: tokenizers bill differently, and a stale cross-model factor can be
 *  dangerously wrong in EITHER direction (k̂<1 deflates → trigger too LATE).
 *  Both models known (non-empty strings) and different → factor absent (raw
 *  estimate, legacy conservative behavior); either side unknown/empty/non-
 *  string → factor kept as-is, so factors published before this field existed
 *  (or requests without a model stamp) are never invalidated by missing
 *  information — they retire through the normal ring rollover when new samples
 *  land. Invalid factors degrade to absent. */
export function currentCalibrationFactor(stats: { calibratedEstimate?: number; calibratedEstimateModel?: string }, lastModel?: unknown): number | undefined {
    const k = stats.calibratedEstimate;
    if (k === undefined || !Number.isFinite(k) || k <= 0) return undefined;
    if (stats.calibratedEstimateModel !== undefined && typeof lastModel === "string" && lastModel !== "" && stats.calibratedEstimateModel !== lastModel) return undefined;
    return k;
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
        // #4128: delegate to promptInputTotal so the split-vs-inclusive decision
        // has ONE home; `fresh ?? 0` keeps the read/creation-only degenerate case.
        return {
            total: any ? promptInputTotal("anthropic", fresh ?? 0, read, creation, declaredInclusiveFromUsage(usage)) : undefined,
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

/** #4128: read the upstream's self-declared input-token semantics from the
 *  optional `billing_usage` sidecar. A real Anthropic response never carries it;
 *  an anthropic-wire relay over an OpenAI backend stamps
 *  `billing_usage.semantic="openai"` alongside the raw OpenAI usage block. Returns
 *  true (input INCLUSIVE of cache_read), false (explicit split), or undefined
 *  (undeclared — caller falls back to heuristics). */
export function declaredInclusiveFromUsage(usage: Record<string, unknown>): boolean | undefined {
    const bu = usage["billing_usage"];
    if (bu && typeof bu === "object") {
        const b = bu as Record<string, unknown>;
        if (b["semantic"] === "openai") return true;
        if (b["semantic"] === "anthropic") return false;
        const oai = b["openai_usage"];
        if (oai && typeof oai === "object" && typeof (oai as Record<string, unknown>)["prompt_tokens"] === "number") return true;
    }
    return undefined;
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
 *  context size, but NOT a cache hit.
 *  #4128: an anthropic-LANE relay over an OpenAI backend reports input_tokens
 *  INCLUSIVE of cache_read (the mirror of the #408 violation). The signal is the
 *  billing_usage stamp (declaredInclusive=true). We deliberately do NOT infer it
 *  from the numbers: per-object, `input >= cached` cannot distinguish an inclusive
 *  relay from a genuine Anthropic turn whose fresh input happens to exceed the
 *  cached prefix, so any numeric heuristic would silently under-count real
 *  Anthropic traffic. Without an explicit stamp the lane keeps split semantics.
 *  When inclusive, the read segment is already inside input and must not be added
 *  back; the cache-creation piece stays additive on the Anthropic lane then too
 *  (total = input + creation). */
export function promptInputTotal(
    protocol: WireProtocol | undefined,
    input: number | undefined,
    cached: number | undefined,
    creation?: number,
    declaredInclusive?: boolean,
): number {
    if (input === undefined) return 0;
    const wireInclusive = protocol === "openai" || protocol === "responses" || protocol === "google";
    // Pre-existing decision, byte-for-byte unchanged for every non-Anthropic lane.
    const baseSplit = !wireInclusive || (typeof cached === "number" && input < cached);
    // #4128: the ONLY lane whose default can flip to inclusive here, and ONLY on an
    // explicit upstream declaration — never inferred from the numbers (see above).
    const anthropicInclusive = protocol === "anthropic" && declaredInclusive === true;
    const splitSemantics = baseSplit && !anthropicInclusive;
    const additive =
        (splitSemantics && typeof cached === "number" ? cached : 0) +
        // #790 additive piece; kept on the Anthropic lane even when the read
        // segment is inclusive (#4128: total = input + creation, not + read).
        ((splitSemantics || protocol === "anthropic") && typeof creation === "number" ? creation : 0);
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
    /** #3450: total token count the upstream says it RECEIVED, when the body
     *  states it ("you requested N tokens") — the rejected payload's own size,
     *  NOT the window; arming at the ceiling instead of this measurement is
     *  what turned a real deficit into "deficit 0". */
    requestedTotal?: number;
    /** #3450: message-channel share of the requested total ("N in the
     *  messages") — the foldable quantity an over-window provider bills. */
    requestedMessages?: number;
    /** #3450: completion-channel share ("N in the completion") — proves this
     *  provider bills OUTPUT against the same wall as input, so preflight
     *  must fold against window − reservation. */
    requestedCompletion?: number;
    /** #4124: per-prompt IMAGE-COUNT hard cap stated in the error body
     *  ("Too many images in request: 165 > 30"). A COUNT, not tokens — it must
     *  never ride the window/lastInputTokens channel (toTokenNumber rejects
     *  sub-1000 numbers, and that channel drives TOKEN-space shrink). Presence
     *  marks an image-count overflow; isOverflow stays token/context-only. */
    imageCountCap?: number;
    /** #4124: the request's own image count as the upstream counted it ("165")
     *  — cross-check/log evidence only; bili counts occurrences itself. */
    imageCountSeen?: number;
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
    // #3787: agnes/cch-family relay gateways reject over-window requests with
    // {"type":"error","error":{"type":"context_limit","message":"上下文长度超过模型限制，请减少对话历史或输入内容 (…)"} } —
    // no window number anywhere in the body; the emergency shrink then arms at
    // the rejected payload's own token estimate (#987). The CJK patterns cover
    // both word orders ("上下文…超出" and "超出…上下文").
    /context_limit/i,
    /上下文.{0,8}(?:超出|超过|超限)/,
    /(?:超出|超过|超限).{0,8}上下文/,
    // The #3787 pair above covers only 上下文 as the SUBJECT and 超出/超过/超限
    // as the predicate. Chinese relays phrase the same rejection several other
    // ways, and every one of them falls through to "generic bad request" today
    // — no shrink armed, the identical oversized payload re-forwarded on every
    // retry (#3240's field loop). Each entry below still pairs a subject with a
    // limit predicate INSIDE one clause ([^。；;！!\n] never crosses a sentence),
    // so throttle phrasing (请求频率超限 / 请求过于频繁 / 触发限流) and the
    // output-length notice (输出内容过长) stay dark: neither names an input-side
    // subject that has run past a limit.
    // (a) 上下文 described as full/over-long rather than exceeded.
    /上下文.{0,8}(?:已满|过长|超长|太大)/,
    // (b) the ceiling named 模型上限 / 上下文窗口 instead of 上下文.
    /(?:超出|超过|超限).{0,12}(?:模型上限|上下文窗口)/,
    // (c) the input side named instead of 上下文: "输入过长，请减少对话轮次",
    //     "提示词太长，请精简后重试", "消息超长".
    /(?:输入|请求|提示词|对话|消息)[^。；;！!\n]{0,10}(?:过长|太长|超长)/,
    // (d) the token counter itself as the subject: "输入 token 数量超出允许范围".
    /tokens?[^。；;！!\n]{0,10}(?:超出|超过|超限)/i,
    // (e) #3240/#3246 consolidation: the INPUT side named with an EXCEED
    //     predicate rather than a length predicate ("输入长度超出限制"). The
    //     exceed set stays input-only: extending (c)'s subjects to 超出/超过/
    //     超限 would light up throttle phrasings like "请求超出频率限制".
    /输入[^。；;！!\n]{0,12}(?:超出|超过|超限)/,
    // (f) #3240/#3246 consolidation: mixed-language gateways write "prompt 过长".
    /prompt[^。；;！!\n]{0,6}(?:过长|太长|超长)/i,
];

function toTokenNumber(s: string): number | undefined {
    const n = parseInt(s.replace(/,/g, ""), 10);
    // A plausible window is at least a few thousand tokens; smaller numbers in
    // the message (e.g. "5 inputs", a request id) are not the window.
    return Number.isFinite(n) && n >= 1000 ? n : undefined;
}

// #4124: per-prompt IMAGE-COUNT walls — a different dimension from the token
// patterns above. vLLM (--limit-mm-per-prompt) and gateway equivalents reject
// by COUNT of images, so a payload far under its token window still 400s on
// every round: images meter into tokens, but no fold decision ever looks at
// count. The cap is small (tens), which is exactly why it cannot ride the
// token-window channel (toTokenNumber rejects <1000; that channel drives
// token-space shrink). Known shapes:
//   vLLM: "Too many images in request: 165 > 30" — gateways re-serialize error
//         bodies with HTML-style escapes, so the wire form of ">" is "\u003e"
//         (#4124 field log); both spellings must match. $1 = the request's own
//         count (cross-check only), $2 = the cap.
//   generic: "At most N image(s) may be provided" — cap only.
const IMAGE_COUNT_OVERFLOW_PATTERNS: RegExp[] = [
    /too many images in request:\s*(\d+)\s*(?:>|\\u003e)\s*(\d+)/i,
    /at most\s+(\d+)\s+images?\s+may be provided/i,
];

/** #4124: extract the per-prompt image-count cap (+ the request's own count,
 *  when the body states both) from an error body. Returns an empty object
 *  unless a positive finite cap is present — a wrong guess would shed images
 *  the upstream actually accepts. */
function parseImageCountCap(text: string): { cap?: number; seen?: number } {
    let m = text.match(IMAGE_COUNT_OVERFLOW_PATTERNS[0]);
    if (m) {
        const seen = Number(m[1]);
        const cap = Number(m[2]);
        if (Number.isFinite(cap) && cap > 0) {
            return { cap, ...(seen > 0 ? { seen } : {}) };
        }
        return {};
    }
    m = text.match(IMAGE_COUNT_OVERFLOW_PATTERNS[1]);
    if (m) {
        const cap = Number(m[1]);
        if (Number.isFinite(cap) && cap > 0) return { cap };
    }
    return {};
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
    // CJK: the window is the number ATTACHED TO the limit word (上限 / 最大 /
    // 限制), never the payload size quoted elsewhere in the same sentence —
    // "本次请求约 1748713 tokens，超过单次上限 1500000 tokens" must read 1500000.
    // The trailing form ("200000 tokens 的上限") is tried FIRST: when a relay
    // states both numbers that way, the leading form would otherwise reach past
    // the limit word and grab the payload quoted after it. A trailing unit
    // (tokens / token / 个token) is required either way so a bare "上限 3 次"
    // throttle line cannot masquerade as a window.
    m =
        text.match(/(\d[\d,]*)\s*(?:个\s*)?tokens?\s*(?:的)?(?:上限|最大|限制)/i) ??
        text.match(/(?:上限|最大(?:值|限制)?|限制)[^。；;！!\n]{0,20}?(\d[\d,]*)\s*(?:个\s*)?tokens?/i);
    if (m) return toTokenNumber(m[1]);
    return undefined;
}

/** #3450: best-effort extraction of the REJECTED PAYLOAD'S OWN token counts
 *  from an overflow body — distinct from parseOverflowWindow (the ceiling). A
 *  wrong guess is worse than no guess, so each pattern is provider-specific. */
function parseOverflowCounts(text: string): { total?: number; messages?: number; completion?: number } {
    // OpenAI/DeepSeek: "...you requested 1160518 tokens (904518 in the
    // messages, 256000 in the completion)."
    let m = text.match(/requested\s+(\d[\d,]*)\s*tokens?\s*\(\s*(\d[\d,]*)\s*in the messages,\s*(\d[\d,]*)\s*in the completion\s*\)/i);
    if (m) return { total: toTokenNumber(m[1]), messages: toTokenNumber(m[2]), completion: toTokenNumber(m[3]) };
    // Anthropic: "prompt is too long: 130000 tokens > 128000 maximum" — the
    // first number IS the prompt (messages) size; no completion split stated.
    m = text.match(/prompt is too long:\s*(\d[\d,]*)\s*tokens?\s*>/i);
    if (m) return { total: toTokenNumber(m[1]), messages: toTokenNumber(m[1]) };
    // Gemini: "The input token count (1012345) exceeds the maximum number of
    // tokens allowed (1048576)."
    m = text.match(/input token count\s*\((\d[\d,]*)\)\s*exceeds/i);
    if (m) return { total: toTokenNumber(m[1]), messages: toTokenNumber(m[1]) };
    // CJK relay (#3947 field body): "本次请求约 1748713 tokens，超过单次上限
    // 1500000 tokens" — the rejected payload's count is the number ADJACENT TO
    // THE OVERFLOW PREDICATE (number-tokens-超过), never the limit attached to
    // 上限/最大/限制 (that half belongs to parseOverflowWindow). Subject-anchored
    // (请求/输入), and the span between subject and number must be free of limit
    // vocabulary: "您的请求最多支持 1500000 tokens，超出部分将被截断" states a
    // CEILING, not a measurement. A rejection bills input only — no completion
    // has run yet — so total and messages carry the same number (#3450).
    for (const mm of text.matchAll(/(?:请求|输入)([^。；;！!\n]{0,12}?)(\d[\d,]*)\s*(?:个\s*)?tokens?\s*[，,]?\s*(?:超过|超出|超限)/gi)) {
        const n = toTokenNumber(mm[2]);
        if (n !== undefined && !/(?:支持|最大|上限|限制|允许)/.test(mm[1])) return { total: n, messages: n };
    }
    return {};
}

/** Inspect an upstream response for a context-overflow error. `status` is the
 *  HTTP status; `bodyText` is the (usually small) error body. 400/413 and any
 *  5xx are checked against the recognized context-too-long markers; the marker
 *  match is the real gate, so a generic server error (no marker) never counts.
 *  5xx is included because some gateways relay the model provider's overflow
 *  rejection under 502/503 rather than 400 (#2484). */
export function inspectContextOverflow(status: number, bodyText: string): ContextOverflowInfo {
    const message = (bodyText ?? "").slice(0, 300);
    const plausible = status === 400 || status === 413 || status >= 500;
    if (!plausible) return { isOverflow: false, message };
    if (!bodyText) return { isOverflow: false, message };
    const isOverflow = CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(bodyText));
    // #4124: the image-count wall is checked INDEPENDENTLY of the token markers
    // — a "Too many images" body matches none of them (and must not arm any
    // token-space machinery), yet every call site sees ONE inspection result.
    const imageCount = parseImageCountCap(bodyText);
    if (!isOverflow && imageCount.cap === undefined) return { isOverflow: false, message };
    const counts = parseOverflowCounts(bodyText);
    return {
        isOverflow,
        ...(imageCount.cap !== undefined ? { imageCountCap: imageCount.cap } : {}),
        ...(imageCount.seen !== undefined ? { imageCountSeen: imageCount.seen } : {}),
        ...(isOverflow
            ? {
                window: parseOverflowWindow(bodyText),
                ...(counts.total !== undefined ? { requestedTotal: counts.total } : {}),
                ...(counts.messages !== undefined ? { requestedMessages: counts.messages } : {}),
                ...(counts.completion !== undefined ? { requestedCompletion: counts.completion } : {}),
            }
            : {}),
        message,
    };
}

// #4452: an intermediate gateway that rewrites EVERY rejection into one generic
// body (Cherry Studio et al. strip the token counts / window from each overflow
// 400) makes inspectContextOverflow return isOverflow:false even when the payload
// really overflows — so bili's whole overflow self-heal (#1195 same-request
// refold, armOverflowShrink, window learn) keys off a marker that is never there
// and silently never engages, starving the route of calibration. This predicate
// names exactly that shape — a 4xx overflow-SHAPED reject whose body matches no
// pattern — so the relay can log it loudly instead of the opaque `← upstream 400`
// line. Deliberately EXCLUDES 5xx (those already self-heal via the local estimate,
// #604) and any body that DOES carry a marker (self-heal engages normally then).
export function isMarkerlessOverflowReject(status: number, bodyText: string): boolean {
    return (status === 400 || status === 413) && !CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(bodyText));
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
const DEFAULT_OUTPUT_HEADROOM_MAX_PCT = 0.25;

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
 * whole-conversation prefix. In plugin/launcher mode the summary carrier is
 * usually the `compress` tool call in the agent's own re-sent history:
 * stripKernelSummaries removes the kernel's acp_summary anchor when that pair
 * rides inbound history, making this a no-op; when the pair does NOT ride
 * (pruned or line-form echo) the anchor survives, and this re-voicing is what
 * keeps strict backends legal then (#1999). A summary is a stand-in for the
 * folded history; re-voicing it as a user turn is the accepted trade-off for
 * SGLang compatibility + cache stability.
 * No-op (same array) when there is no system/developer message to convert.
 * #4166: pass `should` to narrow the re-voicing — with it, ONLY messages the
 * predicate approves are re-voiced (the host uses this to re-voice its OWN
 * summary carriers while leaving client-origin system/developer data
 * verbatim: mid-history system from the client is conversation data now, not
 * a bili artifact to rewrite).
 */
export function systemToUser<T extends { role: string }>(messages: T[], should?: (m: T, index: number) => boolean): T[] {
    let hasSys = false;
    for (const m of messages) {
        if (m.role === "system" || m.role === "developer") { hasSys = true; break; }
    }
    if (!hasSys) return messages;
    return messages.map((m, i) =>
        (m.role === "system" || m.role === "developer") && (!should || should(m, i))
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

// #1876: rebuild the outbound Anthropic `system` by APPENDING bili's added
// text (the compress prompt) instead of merging it into one block. The kernel's
// buildSystem(flattenedText, original) collapses a client's N-block system into
// a single joined block and relocates the first client cache_control onto it —
// which breaks downstream gateways that identify Claude Code traffic by system
// BLOCK SHAPE (sub2api's systemHasBillingAttributionBlock requires some block's
// text to startsWith the billing-attribution prefix — true pre-merge only when
// the billing block happened to lead) and shifts byte-prefix/sticky-hash
// anchors (#1754/#1631). Original blocks therefore ride out byte-exact, in
// order, with their cache_control in place; the added text becomes ONE fresh
// trailing text block with no mark (the "---" separator is redundant once the
// prompt stands alone as its own block). String/absent/empty originals have no
// block shape to preserve: the legacy flat join (base + "\n\n---\n\n" + added)
// stays byte-identical. REPLACEMENT semantics (#1085 anchor rollback, where the
// frozen text is NOT an extension of the current client text) stay on kernel
// buildSystem — this helper is for appends only.
export function appendSystemText(
    added: string,
    original: AnthropicRequestBody["system"],
): string | AnthropicRequestBody["system"] {
    if (Array.isArray(original) && original.length > 0) {
        return added ? [...original, { type: "text", text: added }] : [...original];
    }
    const base = typeof original === "string" ? original : "";
    if (!added) return base;
    return base ? `${base}\n\n---\n\n${added}` : added;
}

/** #4205/#3900: positive evidence that an anthropic-wire route enforces its
 *  input limit INDEPENDENTLY of max_tokens (separate output budget — reserving
 *  headroom there would just shift every band down for no safety gain). Two
 *  shapes carry that evidence: the canonical Anthropic API host (direct Claude
 *  Code / SDK traffic), or a claude-* model id on the wire (gateway / Bedrock /
 *  Vertex fronts of real Claude — their billing keeps the separate output
 *  budget too). Wrapper providers on the anthropic wire (DeepSeek /anthropic)
 *  bill completion against the SAME window and 400'd at the wall (#3900:
 *  1,070,269 + 128,000 vs 1,048,576) — they carry no evidence here, so they
 *  reserve. A claude-named model on a mis-billing wrapper keeps the documented
 *  first-shot residual: one 400 per fresh baseline, then the self-heal (#4093)
 *  and the proven-share learning (#3973) correct it. Evidence-permitlist
 *  discipline (KDD#9): extend with traffic evidence, never wholesale. */
const ANTHROPIC_API_HOST = "api.anthropic.com";
const CLAUDE_MODEL_ID_PREFIX = "claude-";

export function hasSeparateOutputBudgetEvidence(origin: string | undefined, modelId: string | undefined): boolean {
    if (origin !== undefined) {
        try {
            if (new URL(origin).hostname.toLowerCase() === ANTHROPIC_API_HOST) return true;
        } catch { /* unparseable origin — no evidence */ }
    }
    if (typeof modelId === "string" && modelId.length > CLAUDE_MODEL_ID_PREFIX.length && modelId.toLowerCase().startsWith(CLAUDE_MODEL_ID_PREFIX)) return true;
    return false;
}

/**
 * Whether the OUTPUT budget should be reserved from the context window for
 * THIS request. Every wire reserves by default — unknown/other protocols
 * included (conservative: a missed reservation at worst overflows once and
 * the self-heal corrects it). The Anthropic Messages API family is the one
 * whose canonical routes enforce the input limit INDEPENDENTLY of max_tokens,
 * so only routes carrying positive separate-wall evidence
 * (hasSeparateOutputBudgetEvidence) are exempt; everything else on the wire
 * reserves (#4205: the blanket protocol exemption was what let wrapper
 * providers on that wire 400 at the wall, #3900). Absent origin/model
 * evidence the call degrades to "reserve", never to "exempt". Proven-share
 * overrides (#3973) compose at the call site: live overflow evidence can
 * force a reservation even on an exempt route.
 */
export function shouldReserveOutputHeadroom(protocol: string | undefined, origin?: string, modelId?: string): boolean {
    if (protocol === "anthropic") return !hasSeparateOutputBudgetEvidence(origin, modelId);
    return true;
}

/**
 * The completion share an upstream PROVED it bills inside the context wall for
 * one (origin, model) pair, or 0 when this request cannot claim that proof.
 *
 * #3450 learns the share from a rejected request but books it on the one-shot
 * overflow arm, which retires on the next usage report (#1110) — the wrong
 * lifetime for "this endpoint counts max_tokens inside the window", a PROVIDER
 * fact that survives the fold which recovered the turn. Dropping it re-judges
 * every later turn on the declared window, so an anthropic-wire host that bills
 * completion inside the wall (DeepSeek's /anthropic: 1048576 stated,
 * "requested 1370540 (1114540 in the messages, 256000 in the completion)")
 * over-fills, 400s, and pays a new emergency fold each time.
 *
 * Scoped: a route or model change returns 0 and falls back to the plain
 * protocol rule, never silently reserving on an unrelated upstream.
 */
export function provenCompletionReserve(
    stats: { provenCompletionWall?: number; provenCompletionWallOrigin?: string; provenCompletionWallModel?: string } | undefined,
    origin: string | undefined,
    model: string | undefined,
): number {
    const wall = stats?.provenCompletionWall;
    if (typeof wall !== "number" || !Number.isFinite(wall) || wall <= 0) return 0;
    if (origin === undefined || origin === "" || stats?.provenCompletionWallOrigin !== origin) return 0;
    if (model === undefined || model === "" || stats?.provenCompletionWallModel !== model) return 0;
    return wall;
}

/** System-carrier texts of a parsed request body, covering all four wire shapes:
 *  anthropic/openai-hoisted top-level `system` (string or text-block array),
 *  responses `instructions`, google `systemInstruction.parts`, and system/developer
 *  entries kept inside `messages[]`/`input[]` by raw clients (identical carrier
 *  list to estimateWireOverhead, src/server/budget.ts). */
export function systemCarrierTexts(parsed: Record<string, unknown>): string[] {
    const out: string[] = [];
    const sys = parsed.system;
    if (typeof sys === "string") out.push(sys);
    else if (Array.isArray(sys)) pushBlockTexts(out, sys);
    const inst = parsed.instructions;
    if (typeof inst === "string") out.push(inst);
    const si = parsed.systemInstruction;
    if (typeof si === "object" && si !== null) {
        const parts = (si as Record<string, unknown>).parts;
        if (Array.isArray(parts)) pushBlockTexts(out, parts);
    }
    for (const key of ["messages", "input"]) {
        const arr = parsed[key];
        if (!Array.isArray(arr)) continue;
        for (const entry of arr) {
            if (typeof entry !== "object" || entry === null) continue;
            const rec = entry as Record<string, unknown>;
            if (rec.role !== "system" && rec.role !== "developer") continue;
            const c = rec.content;
            if (typeof c === "string") out.push(c);
            else if (Array.isArray(c)) pushBlockTexts(out, c);
        }
    }
    return out;
}

function pushBlockTexts(out: string[], blocks: unknown[]): void {
    for (const b of blocks) {
        const t = blockText(b);
        if (t !== undefined) out.push(t);
    }
}

function blockText(v: unknown): string | undefined {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null) {
        const t = (v as Record<string, unknown>).text;
        if (typeof t === "string") return t;
    }
    return undefined;
}
