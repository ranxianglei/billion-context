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

function holdKey(url: string, headers: Record<string, string>): { key: string; host: string; cred: string | undefined } {
    let host = url;
    try {
        host = new URL(url).host;
    } catch { /* opaque url — key by the raw value */ }
    // Multi-account safety (#2131 fingerprint): two credentials on the same
    // origin are independent rate-limit pools and must not hold each other.
    const cred = credentialFingerprint(headers);
    return { key: cred === undefined ? host : `${host}\u0000${cred}`, host, cred };
}

function evictOldest(): void {
    const oldest = holds.keys().next().value;
    if (oldest !== undefined) holds.delete(oldest);
}

function makeReject(st: HoldState, now: number): ThrottleLocalReject {
    const maxC = throttle429MaxConsecutive();
    const terminal = st.streak >= maxC;
    const secsLeft = Math.max(1, Math.ceil((st.nextAttemptAt - now) / 1000));
    if (terminal) {
        const capSec = Math.ceil(throttle429MaxDelayMs() / 1000);
        return {
            status: 424,
            code: "bili_throttle_terminal",
            message: `upstream rate-limited ${st.streak} consecutive request(s) to ${st.host}; bili stops amplifying after ${maxC} consecutive rate limits — resend manually once the provider recovers (a background probe keeps checking at most every ${capSec}s) (#4204)`,
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
        message: `upstream rate-limited ${st.streak} consecutive request(s) to ${st.host}; bili is holding outbound sends until ${new Date(st.nextAttemptAt).toISOString()} (~${secsLeft}s, exponential backoff) instead of amplifying — zero egress while held, auto-resumes when the limit clears (#4204)`,
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
): ThrottleLocalReject | undefined {
    if (!throttle429Enabled()) return undefined;
    const { key } = holdKey(url, headers);
    const st = holds.get(key);
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
): void {
    if (!throttle429Enabled()) return;
    const { key, host, cred } = holdKey(url, headers);
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
    holds.set(key, { streak, nextAttemptAt, probeAt: 0, host, cred });
    const delaySec = Math.round(delay / 1000);
    const raNote = raMs !== null && raMs >= jittered ? ", upstream Retry-After honored" : "";
    if (streak === 1) {
        loggerLog("warn", `[acp-proxy] [429-hold] ${host}: upstream 429 — arming egress hold (~${delaySec}s backoff+jitter${raNote}) instead of letting host retries amplify (#4204)`);
    } else if (streak === maxC) {
        loggerLog("warn", `[acp-proxy] [429-hold] ${host}: ${streak} consecutive upstream 429s — hold is TERMINAL: answering locally with 424 (outside SDK retry sets) until a probe succeeds (${raNote.trim()}) (#4204)`);
    } else {
        loggerLog("info", `[acp-proxy] [429-hold] ${host}: consecutive 429 #${streak} — hold extended to ~${delaySec}s${raNote} (#4204)`);
    }
}

/** Observe ANY resolved non-429 verdict for this send (2xx included): the
 *  endpoint is reachable and processing again — clear the hold immediately. */
export function noteUpstreamThrottleResolved(
    url: string,
    headers: Record<string, string>,
    status: number,
    now: number = Date.now(),
): void {
    void now;
    if (!throttle429Enabled()) return;
    const { key, host } = holdKey(url, headers);
    const st = holds.get(key);
    if (st === undefined) return;
    holds.delete(key);
    loggerLog("info", `[acp-proxy] [429-hold] ${host}: cleared after HTTP ${status} (was ${st.streak} consecutive 429s) (#4204)`);
}

/** Display surface for acp_status / web overview (mirrors getOpenUpstreamCircuits). */
interface ActiveThrottleHold {
    host: string;
    streak: number;
    nextAttemptAt: number;
    terminal: boolean;
}

export function activeThrottleHolds(): ActiveThrottleHold[] {
    const maxC = throttle429MaxConsecutive();
    return [...holds.values()].map((st) => ({
        host: st.host,
        streak: st.streak,
        nextAttemptAt: st.nextAttemptAt,
        terminal: st.streak >= maxC,
    }));
}

export function _resetUpstreamThrottleForTest(): void {
    holds.clear();
}
