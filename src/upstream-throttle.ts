// #4204 — egress-side 429 throttle governor.
//
// Problem: a concurrency-style provider limit (z.ai GLM coding plan: ~9-18
// allowed in parallel, dynamic, no Retry-After) plus a host that re-drives a
// failed turn every few seconds with the full history. bili forwarded every
// re-driven request, so the retry stream itself occupied the provider's slots
// and pinned the WHOLE account at the limit for minutes — every other session
// failed too, until the client (and proxy process) was restarted.
//
// Fix: when consecutive sends to one origin (+ credential) come back 429, stop
// amplifying. Further sends are answered LOCALLY instead of being forwarded:
//   - while under the budget: 429 + a Retry-After header (exponential backoff
//     ×2 per consecutive 429, jittered, capped; an upstream-provided
//     Retry-After wins when larger) — zero egress while held, so the provider
//     slots free up and well-behaved hosts pace off the header;
//   - once the budget is exhausted: a TERMINAL 424 — deliberately outside
//     every known client-SDK retry set ({408, 409, 429, ≥500}), so hosts give
//     up immediately and surface the error for a manual resend.
// One request per backoff window is admitted as a probe, so recovery is
// AUTOMATIC without a restart; ANY resolved non-429 response (including 400/401)
// proves the endpoint is processing again and clears the hold at once.
//
// #5201: the hold key carries a MODEL dimension whenever the send's model is
// identifiable (top-level body `model`, or the URL path on Google-native /
// Anthropic-on-Vertex wires). The credential-level key assumes one credential
// = one quota pool; gateways that front many models with independent pools
// under one credential (LiteLLM/one-api style) broke that assumption — one
// model's exhausted quota froze every sibling model behind the same key. A
// send whose model cannot be identified keeps the legacy origin+credential
// key, so worst-case protection is unchanged. Probe/clear stay per-key: a 200
// on deepseek no longer "fixes" minimax's hold.
//
// Deliberately separate from the #3148 circuit breaker: that one fails fast on
// PRE-RESPONSE transport deaths (endpoint unreachable); this one governs a
// REACHABLE endpoint that answers, just not right now. Both are in-memory
// process state by design — a restart re-learns from live traffic, which is
// the correct snapshot of "now" for a rate limit.

import { credentialFingerprint } from "./cache-ledger.js";
import { log as loggerLog } from "./logger.js";
import {
    throttle429BaseDelayMs,
    throttle429Enabled,
    throttle429MaxConsecutive,
    throttle429MaxDelayMs,
} from "./knobs.js";

/** Bounded state table (same posture as MAX_CIRCUITS in upstream-alerts.ts). */
const MAX_HOLDS = 64;
/** A probe that has been admitted but produced no verdict yet keeps its slot
 *  for this long before it self-releases — deadlock-free even if the response
 *  path never observes the verdict (e.g. the client vanished mid-flight). */
const PROBE_INFLIGHT_TTL_MS = 30_000;
/** An upstream Retry-After beyond this is treated as "later than we will
 *  locally wait" — the hold still arms at our own backoff ceiling. */
const RETRY_AFTER_CAP_MS = 600_000;

interface HoldState {
    streak: number;
    nextAttemptAt: number;
    /** When the last admitted probe was released (0 = none outstanding). */
    probeAt: number;
    host: string;
    cred: string | undefined;
    /** #5201: the model dimension of the key (undefined = legacy key). */
    model?: string;
}

const holds = new Map<string, HoldState>();

interface ThrottleLocalReject {
    /** 429 while under budget (Retry-After attached); 424 terminal. */
    status: 429 | 424;
    code: "bili_throttle_hold" | "bili_throttle_terminal";
    message: string;
    retryAfterSec: number | null;
    streak: number;
    maxConsecutive: number;
    nextAttemptAt: number;
    host: string;
}

function parseRetryAfterMs(headerValue: string | null, now: number): number | null {
    if (headerValue === null) return null;
    const v = headerValue.trim();
    if (/^\d+$/.test(v)) {
        const sec = Number(v);
        return Number.isFinite(sec) ? Math.min(sec, RETRY_AFTER_CAP_MS / 1000) * 1000 : null;
    }
    const t = Date.parse(v);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.min(t - now, RETRY_AFTER_CAP_MS));
}

// #5201: the model dimension of a send, for hold keying. Body-first (OpenAI
// chat/responses and Anthropic messages carry a top-level `model`), then the
// URL path (Google native and Anthropic-on-Vertex carry it only in the path —
// the regexes mirror server.ts's googleModelFromPath /
// vertexAnthropicModelFromPath, kept local to avoid a server.ts import cycle).
// Undefined when neither yields one — the caller then keys by the legacy
// origin+credential value, so worst-case protection is unchanged.
const GOOGLE_MODEL_PATH_RE = /\/models\/([^/:?]+):(?:streamGenerateContent|generateContent|countTokens)\b/;
const VERTEX_ANTHROPIC_MODEL_PATH_RE = /\/publishers\/anthropic\/models\/([^/:?]+):(?:streamRawPredict|rawPredict)\b/;

export function sendModelDimension(url: string, body?: string | Buffer | null): string | undefined {
    if (body) {
        try {
            const p = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as Record<string, unknown>;
            if (typeof p["model"] === "string" && p["model"] !== "") return p["model"];
        } catch { /* non-JSON body — fall through to the path */ }
    }
    const m = GOOGLE_MODEL_PATH_RE.exec(url) ?? VERTEX_ANTHROPIC_MODEL_PATH_RE.exec(url);
    if (!m || !m[1]) return undefined;
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return m[1];
    }
}

/** The origin+credential part of a hold key — cheap, no body involved. */
function holdBase(url: string, headers: Record<string, string>): { base: string; host: string; cred: string | undefined } {
    let host = url;
    try {
        host = new URL(url).host;
    } catch { /* opaque url — key by the raw value */ }
    // Multi-account safety (#2131 fingerprint): two credentials on the same
    // origin are independent rate-limit pools and must not hold each other.
    const cred = credentialFingerprint(headers);
    return { base: cred === undefined ? host : `${host}\u0000${cred}`, host, cred };
}

/** #5201: one credential can front many models with independent quota pools
 *  (LiteLLM/one-api style gateways) — narrow the key to the send's model when
 *  identifiable so an exhausted pool cannot hold its siblings. */
function holdKeyOf(base: string, model: string | undefined): string {
    return model === undefined ? base : `${base}\u0000${model}`;
}

function holdKey(url: string, headers: Record<string, string>, body?: string | Buffer | null): { key: string; host: string; cred: string | undefined; model: string | undefined } {
    const b = holdBase(url, headers);
    const model = sendModelDimension(url, body);
    return { key: holdKeyOf(b.base, model), host: b.host, cred: b.cred, model };
}

/** True when some armed hold sits on this send's base or one of its
 *  model-suffixed children — the only case where the full key could match.
 *  Lets the gate and resolved-note skip the outbound-body parse while a
 *  throttle episode rages on a DIFFERENT origin/credential. */
function anyHoldUnderBase(base: string): boolean {
    const prefix = `${base}\u0000`;
    for (const k of holds.keys()) {
        if (k === base || k.startsWith(prefix)) return true;
    }
    return false;
}

function evictOldest(): void {
    const oldest = holds.keys().next().value;
    if (oldest !== undefined) holds.delete(oldest);
}

function makeReject(st: HoldState, now: number): ThrottleLocalReject {
    const maxC = throttle429MaxConsecutive();
    const terminal = st.streak >= maxC;
    const secsLeft = Math.max(1, Math.ceil((st.nextAttemptAt - now) / 1000));
    // #5201: name the held model when the key carries one — the client needs
    // to know WHICH of its models is throttled, not just the endpoint.
    const where = st.model !== undefined ? `${st.host} (model ${st.model})` : st.host;
    if (terminal) {
        const capSec = Math.ceil(throttle429MaxDelayMs() / 1000);
        return {
            status: 424,
            code: "bili_throttle_terminal",
            message: `upstream rate-limited ${st.streak} consecutive request(s) to ${where}; bili stops amplifying after ${maxC} consecutive rate limits — resend manually once the provider recovers (a background probe keeps checking at most every ${capSec}s) (#4204)`,
            retryAfterSec: null,
            streak: st.streak,
            maxConsecutive: maxC,
            nextAttemptAt: st.nextAttemptAt,
            host: st.host,
        };
    }
    return {
        status: 429,
        code: "bili_throttle_hold",
        message: `upstream rate-limited ${st.streak} consecutive request(s) to ${where}; bili is holding outbound sends until ${new Date(st.nextAttemptAt).toISOString()} (~${secsLeft}s, exponential backoff) instead of amplifying — zero egress while held, auto-resumes when the limit clears (#4204)`,
        retryAfterSec: secsLeft,
        streak: st.streak,
        maxConsecutive: maxC,
        nextAttemptAt: st.nextAttemptAt,
        host: st.host,
    };
}

/** Pre-forward gate. Returns undefined = allow the send (and, when a backoff
 *  window just opened, marks the single in-flight probe slot). Returns a local
 *  reject descriptor when the send must be answered WITHOUT contacting the
 *  upstream. */
export function upstreamThrottleLocalReject(
    url: string,
    headers: Record<string, string>,
    now: number = Date.now(),
    body?: string | Buffer | null,
): ThrottleLocalReject | undefined {
    if (!throttle429Enabled()) return undefined;
    // #5201: no holds armed → nothing to gate. Skip the key work entirely so
    // the per-request cost stays zero while the governor is idle — and the
    // body parse inside sendModelDimension only runs for sends whose
    // origin+credential base actually has a hold armed, so an episode on one
    // origin never costs every other origin a per-request JSON.parse of the
    // full outbound body.
    if (holds.size === 0) return undefined;
    const b = holdBase(url, headers);
    if (!anyHoldUnderBase(b.base)) return undefined;
    const st = holds.get(holdKeyOf(b.base, sendModelDimension(url, body)));
    if (st === undefined) return undefined;
    if (now < st.nextAttemptAt) return makeReject(st, now);
    // Window open: admit exactly one probe at a time; the slot self-releases
    // after PROBE_INFLIGHT_TTL_MS so a never-observed verdict cannot wedge it.
    if (now - st.probeAt < PROBE_INFLIGHT_TTL_MS) return makeReject(st, now);
    st.probeAt = now;
    return undefined;
}

/** Observe an actual upstream 429 verdict for this send. Arms/extends the
 *  hold: exponential backoff ×2 per consecutive 429, jittered into [0.5×, 1×),
 *  capped; an upstream Retry-After (seconds or HTTP-date) wins when larger. */
export function noteUpstreamThrottle429(
    url: string,
    headers: Record<string, string>,
    retryAfterHeader: string | null,
    now: number = Date.now(),
    body?: string | Buffer | null,
): void {
    if (!throttle429Enabled()) return;
    const { key, host, cred, model } = holdKey(url, headers, body);
    const prev = holds.get(key);
    const streak = (prev?.streak ?? 0) + 1;
    const maxC = throttle429MaxConsecutive();
    const base = throttle429BaseDelayMs();
    const cap = throttle429MaxDelayMs();
    const exp = Math.min(cap, base * 2 ** Math.min(streak - 1, 30));
    const jittered = exp * (0.5 + Math.random() * 0.5);
    const raMs = parseRetryAfterMs(retryAfterHeader, now);
    const delay = Math.max(jittered, raMs ?? 0);
    const nextAttemptAt = now + delay;
    if (!prev && holds.size >= MAX_HOLDS) evictOldest();
    holds.set(key, { streak, nextAttemptAt, probeAt: 0, host, cred, ...(model !== undefined ? { model } : {}) });
    const delaySec = Math.round(delay / 1000);
    const raNote = raMs !== null && raMs >= jittered ? ", upstream Retry-After honored" : "";
    const where = model !== undefined ? `${host} (model ${model})` : host;
    if (streak === 1) {
        loggerLog("warn", `[acp-proxy] [429-hold] ${where}: upstream 429 — arming egress hold (~${delaySec}s backoff+jitter${raNote}) instead of letting host retries amplify (#4204)`);
    } else if (streak === maxC) {
        loggerLog("warn", `[acp-proxy] [429-hold] ${where}: ${streak} consecutive upstream 429s — hold is TERMINAL: answering locally with 424 (outside SDK retry sets) until a probe succeeds (${raNote.trim()}) (#4204)`);
    } else {
        loggerLog("info", `[acp-proxy] [429-hold] ${where}: consecutive 429 #${streak} — hold extended to ~${delaySec}s${raNote} (#4204)`);
    }
}

/** Observe ANY resolved non-429 verdict for this send (2xx included): the
 *  endpoint is reachable and processing again — clear the hold immediately. */
export function noteUpstreamThrottleResolved(
    url: string,
    headers: Record<string, string>,
    status: number,
    now: number = Date.now(),
    body?: string | Buffer | null,
): void {
    void now;
    // Same idle fast path as the gate (#5201): nothing armed → nothing to
    // clear, and this function runs on EVERY successful forward; the base
    // precheck keeps the body parse off sends whose origin+credential has no
    // hold (see upstreamThrottleLocalReject).
    if (!throttle429Enabled() || holds.size === 0) return;
    const b = holdBase(url, headers);
    if (!anyHoldUnderBase(b.base)) return;
    const key = holdKeyOf(b.base, sendModelDimension(url, body));
    const st = holds.get(key);
    if (st === undefined) return;
    holds.delete(key);
    const where = st.model !== undefined ? `${b.host} (model ${st.model})` : b.host;
    loggerLog("info", `[acp-proxy] [429-hold] ${where}: cleared after HTTP ${status} (was ${st.streak} consecutive 429s) (#4204)`);
}

/** Display surface for acp_status / web overview (mirrors getOpenUpstreamCircuits). */
interface ActiveThrottleHold {
    host: string;
    streak: number;
    nextAttemptAt: number;
    terminal: boolean;
    /** #5201: present when the hold key carries a model dimension. */
    model?: string;
}

export function activeThrottleHolds(): ActiveThrottleHold[] {
    const maxC = throttle429MaxConsecutive();
    return [...holds.values()].map((st) => ({
        host: st.host,
        streak: st.streak,
        nextAttemptAt: st.nextAttemptAt,
        terminal: st.streak >= maxC,
        ...(st.model !== undefined ? { model: st.model } : {}),
    }));
}

export function _resetUpstreamThrottleForTest(): void {
    holds.clear();
}
