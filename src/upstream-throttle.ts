// #4204 — egress-side 429 throttle governor.
//
// Problem: a concurrency-style provider limit (z.ai GLM coding plan: ~9-18
// allowed in parallel, dynamic, no Retry-After) plus a host that re-drives a
// failed turn every few seconds with the full history. bili forwarded every
// re-driven request, so the retry stream itself occupied the provider's slots
// and pinned the WHOLE account at the limit for minutes — every other session
// failed too, until the client (and proxy process) was restarted.
//
// Fix: consecutive 429s create a local hold by origin+credential. A verified
// KeyRing model-endpoint refusal is keyed by origin+credential+request-model;
// account quota and every ambiguous/unrecognized 429 remain origin+credential.
// Further sends covered by that scope are answered LOCALLY instead of forwarded:
//   - while under the budget: 429 + a Retry-After header (exponential backoff
//     ×2 per consecutive 429, jittered, capped; an upstream-provided
//     Retry-After wins when larger) — zero egress while held, so the provider
//     slots free up and well-behaved hosts pace off the header;
//   - once the budget is exhausted: a TERMINAL 424 — deliberately outside
//     every known client-SDK retry set ({408, 409, 429, ≥500}), so hosts give
//     up immediately and surface the error for a manual resend.
// One request per backoff window is admitted as a probe. A completion can
// release only slots owned by its admission token; resolved non-429s clear
// confirmed account holds, while a model hold clears only for that same model.
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
    throttle429Scope,
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
/** Only parse small structured errors; large/malformed bodies keep legacy scope. */
const MAX_KEYRING_ERROR_BODY_BYTES = 16 * 1024;
const KEYRING_MODEL_LIMIT_CODE = "keyring_model_temporarily_unavailable";

function recordOf(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function parseSmallJsonRecord(body: string | Uint8Array): Record<string, unknown> | undefined {
    if (body.length > MAX_KEYRING_ERROR_BODY_BYTES) return undefined;
    try {
        const text = typeof body === "string" ? body : new TextDecoder().decode(body);
        return recordOf(JSON.parse(text) as unknown);
    } catch {
        return undefined;
    }
}

function jsonCodeAt(body: string | Uint8Array, index: number): number {
    if (typeof body === "string") return index < body.length ? body.charCodeAt(index) : -1;
    return index < body.length ? body[index] ?? -1 : -1;
}

function skipJsonWhitespace(body: string | Uint8Array, start: number): number {
    let index = start;
    while (index < body.length) {
        const code = jsonCodeAt(body, index);
        if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
        index += 1;
    }
    return index;
}

function skipJsonString(body: string | Uint8Array, start: number): number | undefined {
    if (jsonCodeAt(body, start) !== 0x22) return undefined;
    let index = start + 1;
    while (index < body.length) {
        const code = jsonCodeAt(body, index);
        if (code === 0x22) return index + 1;
        if (code < 0x20) return undefined;
        if (code === 0x5c) {
            index += 1;
            if (index >= body.length) return undefined;
            const escaped = jsonCodeAt(body, index);
            if (escaped === 0x75) {
                for (let digit = index + 1; digit <= index + 4; digit += 1) {
                    const value = jsonCodeAt(body, digit);
                    if (!((value >= 0x30 && value <= 0x39) || (value >= 0x41 && value <= 0x46) || (value >= 0x61 && value <= 0x66))) return undefined;
                }
                index += 5;
                continue;
            }
            if (escaped !== 0x22 && escaped !== 0x5c && escaped !== 0x2f
                && escaped !== 0x62 && escaped !== 0x66 && escaped !== 0x6e && escaped !== 0x72 && escaped !== 0x74) return undefined;
        }
        index += 1;
    }
    return undefined;
}

function readJsonString(body: string | Uint8Array, start: number, end: number): string | undefined {
    try {
        const source = typeof body === "string" ? body.slice(start, end) : new TextDecoder().decode(body.subarray(start, end));
        const value = JSON.parse(source) as unknown;
        return typeof value === "string" ? value : undefined;
    } catch {
        return undefined;
    }
}

function skipJsonNumber(body: string | Uint8Array, start: number): number | undefined {
    let index = start;
    if (jsonCodeAt(body, index) === 0x2d) index += 1;
    const integer = jsonCodeAt(body, index);
    if (integer === 0x30) {
        index += 1;
    } else if (integer >= 0x31 && integer <= 0x39) {
        index += 1;
        while (jsonCodeAt(body, index) >= 0x30 && jsonCodeAt(body, index) <= 0x39) index += 1;
    } else {
        return undefined;
    }
    if (jsonCodeAt(body, index) === 0x2e) {
        index += 1;
        const fraction = index;
        while (jsonCodeAt(body, index) >= 0x30 && jsonCodeAt(body, index) <= 0x39) index += 1;
        if (index === fraction) return undefined;
    }
    const exponent = jsonCodeAt(body, index);
    if (exponent === 0x65 || exponent === 0x45) {
        index += 1;
        const sign = jsonCodeAt(body, index);
        if (sign === 0x2b || sign === 0x2d) index += 1;
        const digits = index;
        while (jsonCodeAt(body, index) >= 0x30 && jsonCodeAt(body, index) <= 0x39) index += 1;
        if (index === digits) return undefined;
    }
    return index;
}

function skipJsonValue(body: string | Uint8Array, start: number, depth = 0): number | undefined {
    if (depth > 256) return undefined;
    const index = skipJsonWhitespace(body, start);
    const code = jsonCodeAt(body, index);
    if (code === 0x22) return skipJsonString(body, index);
    if (code === 0x5b || code === 0x7b) {
        const object = code === 0x7b;
        const close = object ? 0x7d : 0x5d;
        let cursor = skipJsonWhitespace(body, index + 1);
        if (jsonCodeAt(body, cursor) === close) return cursor + 1;
        while (cursor < body.length) {
            if (object) {
                const keyEnd = skipJsonString(body, cursor);
                if (keyEnd === undefined) return undefined;
                cursor = skipJsonWhitespace(body, keyEnd);
                if (jsonCodeAt(body, cursor) !== 0x3a) return undefined;
                cursor += 1;
            }
            const valueEnd = skipJsonValue(body, cursor, depth + 1);
            if (valueEnd === undefined) return undefined;
            cursor = skipJsonWhitespace(body, valueEnd);
            const separator = jsonCodeAt(body, cursor);
            if (separator === close) return cursor + 1;
            if (separator !== 0x2c) return undefined;
            cursor = skipJsonWhitespace(body, cursor + 1);
        }
        return undefined;
    }
    if (code === 0x74 && jsonCodeAt(body, index + 1) === 0x72 && jsonCodeAt(body, index + 2) === 0x75 && jsonCodeAt(body, index + 3) === 0x65) return index + 4;
    if (code === 0x66 && jsonCodeAt(body, index + 1) === 0x61 && jsonCodeAt(body, index + 2) === 0x6c && jsonCodeAt(body, index + 3) === 0x73 && jsonCodeAt(body, index + 4) === 0x65) return index + 5;
    if (code === 0x6e && jsonCodeAt(body, index + 1) === 0x75 && jsonCodeAt(body, index + 2) === 0x6c && jsonCodeAt(body, index + 3) === 0x6c) return index + 4;
    return skipJsonNumber(body, index);
}

/** Extract only the top-level model without materializing large passthrough bodies. */
function scanRequestModel(body: string | Uint8Array): string | undefined {
    let index = skipJsonWhitespace(body, 0);
    if (jsonCodeAt(body, index) !== 0x7b) return undefined;
    index = skipJsonWhitespace(body, index + 1);
    let model: string | undefined;
    if (jsonCodeAt(body, index) === 0x7d) return undefined;
    while (index < body.length) {
        const keyStart = index;
        const keyEnd = skipJsonString(body, keyStart);
        if (keyEnd === undefined) return undefined;
        const key = keyEnd - keyStart <= 32 ? readJsonString(body, keyStart, keyEnd) : undefined;
        index = skipJsonWhitespace(body, keyEnd);
        if (jsonCodeAt(body, index) !== 0x3a) return undefined;
        const valueStart = skipJsonWhitespace(body, index + 1);
        let valueEnd: number | undefined;
        if (key === "model" && jsonCodeAt(body, valueStart) === 0x22) {
            valueEnd = skipJsonString(body, valueStart);
            if (valueEnd === undefined) return undefined;
            model = readJsonString(body, valueStart, valueEnd);
        } else {
            if (key === "model") model = undefined;
            valueEnd = skipJsonValue(body, valueStart);
            if (valueEnd === undefined) return undefined;
        }
        index = skipJsonWhitespace(body, valueEnd);
        const separator = jsonCodeAt(body, index);
        if (separator === 0x7d) return skipJsonWhitespace(body, index + 1) === body.length ? model : undefined;
        if (separator !== 0x2c) return undefined;
        index = skipJsonWhitespace(body, index + 1);
    }
    return undefined;
}

/** Read the top-level request model without materializing a large passthrough body. */
export function requestModelFromBody(body: string | Uint8Array): string | undefined {
    const model = scanRequestModel(body);
    return typeof model === "string" && model.length > 0 ? model : undefined;
}

/**
 * KeyRing emits this code only for a model-endpoint refusal after fresh usage
 * confirms account headroom. Bili's local relay hold also carries an explicit
 * model scope. Recognize either only when the structured marker and model both
 * match the exact request; malformed bodies and every mismatch remain key-wide.
 */
export function keyringModel429Scope(
    status: number,
    requestModel: string | undefined,
    responseBody: string | Uint8Array | null | undefined,
): string | undefined {
    if (status !== 429 || !requestModel || responseBody == null) return undefined;
    const error = recordOf(parseSmallJsonRecord(responseBody)?.error);
    if (error?.model !== requestModel) return undefined;
    if (error.code === KEYRING_MODEL_LIMIT_CODE) return requestModel;
    if (error.code === "bili_throttle_hold" && error.scope === "model") return requestModel;
    return undefined;
}

/**
 * The hold scope for an observed 429, combining #5696's marker discipline with
 * the #5199/#5853 knob: a recognized KeyRing / bili-relay marker wins exactly
 * as before; otherwise, when network.throttle429Scope is "model" and the send
 * carried an identifiable request model, a marker-less gateway 429 (RPM/quota
 * text, opaque relay-rewritten bodies — LiteLLM/one-api/opencode.ai shapes
 * where one model's pool exhaustion must not freeze its siblings) settles
 * model-scoped instead of credential-wide. Model-less sends keep the legacy
 * credential key, so worst-case protection never widens beyond legacy.
 */
export function throttle429ModelScope(
    status: number,
    requestModel: string | undefined,
    responseBody: string | Uint8Array | null | undefined,
): string | undefined {
    const recognized = keyringModel429Scope(status, requestModel, responseBody);
    if (recognized !== undefined) return recognized;
    if (status !== 429 || throttle429Scope() !== "model") return undefined;
    return requestModel !== undefined && requestModel.length > 0 ? requestModel : undefined;
}

function modelHoldKey(key: string, model: string): string {
    return `${key}\u0000model\u0000${model}`;
}

type HoldSlotKey = string | symbol;

interface HoldState {
    streak: number;
    nextAttemptAt: number;
    /** Admission token and time for the probe currently owning this slot. */
    probeToken: symbol | undefined;
    probeAt: number | undefined;
    host: string;
    cred: string | undefined;
    /** Account key shared by the account, model, and provisional group. */
    accountKey: string;
    /** Present only after the refusal is verified as model-scoped. */
    model?: string;
    /** A pending body refinement remains account-scoped until it settles. */
    provisional: boolean;
    provisionalRequestModel?: string;
}

export interface ThrottleClassificationReservation {
    release(): void;
}

interface ClassificationReservationState {
    accountKey: string;
    active: boolean;
    claimed: boolean;
    onRelease?: () => void;
}

interface ProvisionalGroup {
    /** One account-scoped gate shared by every pending observation for a key. */
    state: HoldState;
    /** Individual records keep each observation's settlement independent. */
    observations: Set<HoldState>;
}

const holds = new Map<HoldSlotKey, HoldState>();
const provisionalGroups = new Map<string, ProvisionalGroup>();
const MAX_CLASSIFICATIONS_PER_ACCOUNT = 64;
const MAX_CLASSIFICATION_ACCOUNTS = 64;
const activeClassificationCounts = new Map<string, number>();
const classificationReservations = new Map<ThrottleClassificationReservation, ClassificationReservationState>();
const NOOP_CLASSIFICATION_RESERVATION: ThrottleClassificationReservation = {
    release(): void {},
};

export interface ThrottleLocalReject {
    /** 429 while under budget (Retry-After attached); 424 terminal. */
    status: 429 | 424;
    code: "bili_throttle_hold" | "bili_throttle_terminal";
    message: string;
    retryAfterSec: number | null;
    streak: number;
    maxConsecutive: number;
    nextAttemptAt: number;
    host: string;
    model?: string;
}

interface UpstreamThrottleGate {
    reject?: ThrottleLocalReject;
    /** Present only when this send claimed one or more expired hold slots. */
    probeToken?: symbol;
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

function releaseClassificationReservation(
    reservation: ThrottleClassificationReservation,
    state: ClassificationReservationState,
): void {
    if (!state.active) return;
    state.active = false;
    classificationReservations.delete(reservation);

    const activeCount = activeClassificationCounts.get(state.accountKey);
    if (activeCount === undefined || activeCount <= 1) {
        activeClassificationCounts.delete(state.accountKey);
    } else {
        activeClassificationCounts.set(state.accountKey, activeCount - 1);
    }

    const onRelease = state.onRelease;
    state.onRelease = undefined;
    onRelease?.();
}

/**
 * Reserve one classification slot before forwarding a continuation.
 * `undefined` means capacity is saturated; disabled throttling returns a no-op reservation.
 */
export function reserveUpstreamThrottleClassification(
    url: string,
    headers: Record<string, string>,
): ThrottleClassificationReservation | undefined {
    if (!throttle429Enabled()) return NOOP_CLASSIFICATION_RESERVATION;
    const { key } = holdKey(url, headers);
    const activeCount = activeClassificationCounts.get(key) ?? 0;
    if (
        activeCount >= MAX_CLASSIFICATIONS_PER_ACCOUNT
        || (activeCount === 0 && activeClassificationCounts.size >= MAX_CLASSIFICATION_ACCOUNTS)
    ) return undefined;

    activeClassificationCounts.set(key, activeCount + 1);
    const state: ClassificationReservationState = {
        accountKey: key,
        active: true,
        claimed: false,
    };
    let reservation: ThrottleClassificationReservation;
    reservation = {
        release(): void {
            releaseClassificationReservation(reservation, state);
        },
    };
    classificationReservations.set(reservation, state);
    return reservation;
}

function evictOldestModel(): boolean {
    for (const [slotKey, state] of holds) {
        if (state.model === undefined || state.provisional) continue;
        holds.delete(slotKey);
        return true;
    }
    return false;
}

function evictOldestAccountWide(): boolean {
    for (const [slotKey, state] of holds) {
        if (state.model !== undefined || state.provisional) continue;
        holds.delete(slotKey);
        return true;
    }
    return false;
}

/**
 * Keep the 64-slot table bounded. A new account verdict evicts the oldest
 * model slot first, then the oldest confirmed account slot if necessary.
 * Model-local and provisional evidence can never displace confirmed accounts.
 */
function storeHold(slotKey: HoldSlotKey, state: HoldState, preserveAccountWide: boolean): boolean {
    if (!holds.has(slotKey) && holds.size >= MAX_HOLDS) {
        if (state.model !== undefined || state.provisional || preserveAccountWide) {
            if (!evictOldestModel()) return false;
        } else if (!evictOldestModel() && !evictOldestAccountWide()) {
            return false;
        }
    }
    holds.set(slotKey, state);
    return true;
}

function makeReject(st: HoldState, now: number): ThrottleLocalReject {
    const maxC = throttle429MaxConsecutive();
    const terminal = st.streak >= maxC;
    const secsLeft = Math.max(1, Math.ceil((st.nextAttemptAt - now) / 1000));
    const modelText = st.model === undefined ? "" : ` for model "${st.model}"`;
    if (terminal) {
        const capSec = Math.ceil(throttle429MaxDelayMs() / 1000);
        return {
            status: 424,
            code: "bili_throttle_terminal",
            message: `upstream rate-limited ${st.streak} consecutive request(s) to ${st.host}${modelText}; bili stops amplifying after ${maxC} consecutive rate limits — resend manually once the provider recovers (a background probe keeps checking at most every ${capSec}s) (#4204)`,
            retryAfterSec: null,
            streak: st.streak,
            maxConsecutive: maxC,
            nextAttemptAt: st.nextAttemptAt,
            host: st.host,
            ...(st.model === undefined ? {} : { model: st.model }),
        };
    }
    return {
        status: 429,
        code: "bili_throttle_hold",
        message: `upstream rate-limited ${st.streak} consecutive request(s) to ${st.host}${modelText}; bili is holding outbound sends until ${new Date(st.nextAttemptAt).toISOString()} (~${secsLeft}s, exponential backoff) instead of amplifying — zero egress while held, auto-resumes when the limit clears (#4204)`,
        retryAfterSec: secsLeft,
        streak: st.streak,
        maxConsecutive: maxC,
        nextAttemptAt: st.nextAttemptAt,
        host: st.host,
        ...(st.model === undefined ? {} : { model: st.model }),
    };
}

function createHoldState(
    accountKey: string,
    host: string,
    cred: string | undefined,
    retryAfterHeader: string | null,
    now: number,
    previous: HoldState | undefined,
    model: string | undefined,
    provisional: boolean,
    provisionalRequestModel?: string,
): HoldState {
    const streak = (previous?.streak ?? 0) + 1;
    const base = throttle429BaseDelayMs();
    const cap = throttle429MaxDelayMs();
    const exp = Math.min(cap, base * 2 ** Math.min(streak - 1, 30));
    const jittered = exp * (0.5 + Math.random() * 0.5);
    const raMs = parseRetryAfterMs(retryAfterHeader, now);
    const delay = Math.max(jittered, raMs ?? 0);
    return {
        streak,
        nextAttemptAt: now + delay,
        probeAt: previous?.probeAt,
        probeToken: previous?.probeToken,
        host,
        cred,
        accountKey,
        ...(model === undefined ? {} : { model }),
        provisional,
        ...(provisionalRequestModel === undefined ? {} : { provisionalRequestModel }),
    };
}

function logThrottle429(state: HoldState, retryAfterHeader: string | null, now: number): void {
    const streak = state.streak;
    const maxC = throttle429MaxConsecutive();
    const delay = state.nextAttemptAt - now;
    const raMs = parseRetryAfterMs(retryAfterHeader, now);
    const raNote = raMs !== null && raMs >= delay ? ", upstream Retry-After honored" : "";
    const modelNote = state.model === undefined ? "" : ` for model "${state.model}"`;
    const delaySec = Math.round(delay / 1000);
    if (streak === 1) {
        loggerLog("warn", `[acp-proxy] [429-hold] ${state.host}${modelNote}: upstream 429 — arming egress hold (~${delaySec}s backoff+jitter${raNote}) instead of letting host retries amplify (#4204)`);
    } else if (streak === maxC) {
        loggerLog("warn", `[acp-proxy] [429-hold] ${state.host}${modelNote}: ${streak} consecutive upstream 429s — hold is TERMINAL: answering locally with 424 (outside SDK retry sets) until a probe succeeds (${raNote.trim()}) (#4204)`);
    } else {
        loggerLog("info", `[acp-proxy] [429-hold] ${state.host}${modelNote}: consecutive 429 #${streak} — hold extended to ~${delaySec}s${raNote} (#4204)`);
    }
}

function expireProbeToken(state: HoldState, now: number): void {
    if (
        state.probeToken === undefined
        || state.probeAt === undefined
        || now - state.probeAt < PROBE_INFLIGHT_TTL_MS
    ) return;
    state.probeToken = undefined;
    state.probeAt = undefined;
}

function releaseProbeToken(probeToken: symbol | undefined, now: number, accountKey?: string): void {
    for (const state of holds.values()) {
        if (accountKey !== undefined && state.accountKey !== accountKey) continue;
        expireProbeToken(state, now);
        if (probeToken === undefined || state.probeToken !== probeToken) continue;
        state.probeToken = undefined;
        state.probeAt = undefined;
    }
    for (const group of provisionalGroups.values()) {
        const state = group.state;
        if (accountKey !== undefined && state.accountKey !== accountKey) continue;
        expireProbeToken(state, now);
        if (probeToken === undefined || state.probeToken !== probeToken) continue;
        state.probeToken = undefined;
        state.probeAt = undefined;
    }
}

/** Release only the in-flight probe slots claimed by this failed or cancelled send. */
export function releaseUpstreamThrottleProbe(probeToken?: symbol): void {
    if (probeToken === undefined) return;
    releaseProbeToken(probeToken, Date.now());
}

function slotBlocked(state: HoldState, now: number): boolean {
    expireProbeToken(state, now);
    return now < state.nextAttemptAt || state.probeToken !== undefined;
}
function strongerReject(current: HoldState | undefined, candidate: HoldState): HoldState {
    if (current === undefined) return candidate;
    const maxC = throttle429MaxConsecutive();
    const candidateTerminal = candidate.streak >= maxC;
    const currentTerminal = current.streak >= maxC;
    if (candidateTerminal && !currentTerminal) return candidate;
    if (candidateTerminal === currentTerminal && candidate.nextAttemptAt > current.nextAttemptAt) return candidate;
    return current;
}
function refreshProvisionalGroup(group: ProvisionalGroup): void {
    const first = group.observations.values().next().value;
    if (first === undefined) return;

    let strongest = first;
    for (const observation of group.observations) {
        strongest = strongerReject(strongest, observation);
    }

    const probeToken = group.state.probeToken;
    const probeAt = group.state.probeAt;
    group.state = {
        ...strongest,
        probeToken,
        probeAt,
        model: undefined,
        provisional: true,
        provisionalRequestModel: undefined,
    };
}

function settleProvisionalObservation(
    key: string,
    state: HoldState,
    requestModel: string | undefined,
    modelScope: string | undefined,
): void {
    const exactModel = modelScope !== undefined
        && modelScope.length > 0
        && requestModel !== undefined
        && modelScope === requestModel
        ? modelScope
        : undefined;
    const preserveAccountWide = exactModel !== undefined;
    const targetKey = exactModel === undefined ? key : modelHoldKey(key, exactModel);
    const target = holds.get(targetKey);

    state.provisional = false;
    state.provisionalRequestModel = undefined;
    if (exactModel === undefined) {
        delete state.model;
    } else {
        state.model = exactModel;
    }

    if (target === undefined) {
        if (exactModel !== undefined) state.streak = 1;
        storeHold(targetKey, state, preserveAccountWide);
    } else if (target.probeToken !== state.probeToken) {
        // Keep separate ownership records; a response may release only its
        // own probe even when several observations converge on one scope.
        state.streak = target.streak + 1;
        state.nextAttemptAt = Math.max(state.nextAttemptAt, target.nextAttemptAt);
        storeHold(Symbol("settled upstream throttle observation"), state, preserveAccountWide);
    } else {
        target.streak += 1;
        target.nextAttemptAt = Math.max(target.nextAttemptAt, state.nextAttemptAt);
    }
}

/** Admit a send and return the token owning every open hold slot it claimed. */
export function upstreamThrottleGate(
    url: string,
    headers: Record<string, string>,
    now: number = Date.now(),
    requestModel?: string,
): UpstreamThrottleGate {
    if (!throttle429Enabled()) return {};
    const { key } = holdKey(url, headers);
    let hasApplicable = false;
    let rejectState: HoldState | undefined;
    for (const state of holds.values()) {
        if (state.accountKey !== key) continue;
        if (!state.provisional && state.model !== undefined && state.model !== requestModel) continue;
        hasApplicable = true;
        if (slotBlocked(state, now)) rejectState = strongerReject(rejectState, state);
    }
    for (const group of provisionalGroups.values()) {
        const state = group.state;
        if (state.accountKey !== key) continue;
        hasApplicable = true;
        if (slotBlocked(state, now)) rejectState = strongerReject(rejectState, state);
    }
    if (rejectState !== undefined) return { reject: makeReject(rejectState, now) };
    if (!hasApplicable) return {};

    const probeToken = Symbol("upstream throttle probe");
    for (const state of holds.values()) {
        if (state.accountKey !== key) continue;
        if (!state.provisional && state.model !== undefined && state.model !== requestModel) continue;
        state.probeToken = probeToken;
        state.probeAt = now;
    }
    for (const group of provisionalGroups.values()) {
        const state = group.state;
        if (state.accountKey !== key) continue;
        state.probeToken = probeToken;
        state.probeAt = now;
    }
    return { probeToken };
}

/**
 * #5795: read-only counterpart of upstreamThrottleGate's REJECT branch.
 * Returns the local rejection a send to this url+headers would receive RIGHT
 * NOW, without minting probe tokens or mutating any hold state — the real
 * gate in forward() still owns admission and probe accounting. Used by the
 * pre-ingest fast path in server/handle.ts to refuse held sends BEFORE they
 * pay the O(history) parse/convert/pin cost of a request that will not
 * egress anyway. The reject loop is deliberately duplicated rather than
 * shared: the gate's loop and its mutation are atomic, while this one must
 * never mutate — a flag-based shared loop would couple the two.
 */
export function upstreamThrottlePeekReject(
    url: string,
    headers: Record<string, string>,
    now: number = Date.now(),
    requestModel?: string,
): ThrottleLocalReject | undefined {
    if (!throttle429Enabled()) return undefined;
    const { key } = holdKey(url, headers);
    let rejectState: HoldState | undefined;
    for (const state of holds.values()) {
        if (state.accountKey !== key) continue;
        if (!state.provisional && state.model !== undefined && state.model !== requestModel) continue;
        if (slotBlocked(state, now)) rejectState = strongerReject(rejectState, state);
    }
    for (const group of provisionalGroups.values()) {
        const state = group.state;
        if (state.accountKey !== key) continue;
        if (slotBlocked(state, now)) rejectState = strongerReject(rejectState, state);
    }
    return rejectState === undefined ? undefined : makeReject(rejectState, now);
}

/** Observe a classified upstream 429 verdict for this send. */
export function noteUpstreamThrottle429(
    url: string,
    headers: Record<string, string>,
    retryAfterHeader: string | null,
    now: number = Date.now(),
    modelScope?: string,
    probeToken?: symbol,
): void {
    if (!throttle429Enabled()) return;
    const { key, host, cred } = holdKey(url, headers);
    releaseProbeToken(probeToken, now, key);
    const scopeModel = modelScope === undefined || modelScope.length === 0 ? undefined : modelScope;
    const stateKey = scopeModel === undefined ? key : modelHoldKey(key, scopeModel);
    const previous = holds.get(stateKey);
    const observedState = createHoldState(key, host, cred, retryAfterHeader, now, previous, scopeModel, false);
    if (previous === undefined) {
        if (!storeHold(stateKey, observedState, scopeModel !== undefined)) return;
    } else {
        holds.set(stateKey, observedState);
    }
    logThrottle429(observedState, retryAfterHeader, now);
}

/**
 * Arm an account-scoped provisional observation while a small response body is
 * still being classified. Each returned settler owns exactly this observation:
 * an exact request-model match narrows it, while every other result confirms
 * account scope without discarding concurrent or already-verified evidence.
 * A supplied classification reservation is released by this observation's settler.
 * Legacy callers that omit it acquire a reservation internally.
 */
export function beginProvisionalUpstreamThrottle429(
    url: string,
    headers: Record<string, string>,
    retryAfterHeader: string | null,
    now: number,
    requestModel: string | undefined,
    probeToken?: symbol,
    reservation?: ThrottleClassificationReservation,
): (modelScope?: string) => void {
    if (!throttle429Enabled()) {
        reservation?.release();
        return () => undefined;
    }
    const { key, host, cred } = holdKey(url, headers);
    releaseProbeToken(probeToken, now, key);

    const classificationReservation = reservation ?? reserveUpstreamThrottleClassification(url, headers);
    if (classificationReservation === undefined) return () => undefined;
    const classificationState = classificationReservations.get(classificationReservation);
    if (classificationState === undefined || !classificationState.active || classificationState.claimed) {
        return () => undefined;
    }
    if (classificationState.accountKey !== key) {
        classificationReservation.release();
        return () => undefined;
    }
    classificationState.claimed = true;

    const previousAccount = holds.get(key);
    const state = createHoldState(
        key,
        host,
        cred,
        retryAfterHeader,
        now,
        previousAccount,
        undefined,
        true,
        requestModel,
    );
    // This observation has completed its send; it must not inherit ownership of
    // an earlier account probe merely because it was based on that backoff.
    state.probeToken = undefined;
    state.probeAt = undefined;

    const existingGroup = provisionalGroups.get(key);
    if (existingGroup === undefined && provisionalGroups.size >= MAX_CLASSIFICATION_ACCOUNTS) {
        classificationReservation.release();
        return () => undefined;
    }
    const group = existingGroup ?? {
        state: { ...state, provisionalRequestModel: undefined },
        observations: new Set<HoldState>(),
    };
    if (existingGroup === undefined) provisionalGroups.set(key, group);
    if (group.observations.size >= MAX_CLASSIFICATIONS_PER_ACCOUNT) {
        classificationReservation.release();
        return () => undefined;
    }

    group.observations.add(state);
    refreshProvisionalGroup(group);
    logThrottle429(state, retryAfterHeader, now);

    classificationState.onRelease = () => {
        if (provisionalGroups.get(key) !== group || !group.observations.delete(state)) return;
        if (group.observations.size === 0) {
            provisionalGroups.delete(key);
        } else {
            refreshProvisionalGroup(group);
        }
    };

    let settled = false;
    return (modelScope?: string): void => {
        if (settled) return;
        settled = true;
        const pendingGroup = provisionalGroups.get(key);
        if (pendingGroup !== group || !group.observations.delete(state)) {
            classificationReservation.release();
            return;
        }
        classificationState.onRelease = undefined;
        settleProvisionalObservation(key, state, requestModel, modelScope);

        if (group.observations.size === 0) {
            provisionalGroups.delete(key);
        } else {
            refreshProvisionalGroup(group);
        }
        classificationReservation.release();
    };
}

/** A resolved non-429 clears confirmed account and matching-model holds. */
export function noteUpstreamThrottleResolved(
    url: string,
    headers: Record<string, string>,
    status: number,
    now: number = Date.now(),
    requestModel?: string,
    probeToken?: symbol,
): void {
    if (!throttle429Enabled()) return;
    const { key, host } = holdKey(url, headers);

    for (const [slotKey, state] of holds) {
        if (state.accountKey !== key) continue;
        expireProbeToken(state, now);
        const ownsProbe = probeToken !== undefined && state.probeToken === probeToken;
        const inResolvedScope = state.model === undefined || state.model === requestModel;

        // A completed send releases only the slots its admission token owns.
        // Provisional observations are settled by their own body reader, not by
        // an unrelated response that happens to have the same request model.
        if (state.provisional) {
            if (ownsProbe) {
                state.probeToken = undefined;
                state.probeAt = undefined;
            }
            continue;
        }
        if (!inResolvedScope) {
            if (ownsProbe) {
                state.probeToken = undefined;
                state.probeAt = undefined;
            }
            continue;
        }
        if (state.probeToken !== undefined && !ownsProbe) continue;

        holds.delete(slotKey);
        const modelNote = state.model === undefined ? "" : ` for model "${state.model}"`;
        loggerLog("info", `[acp-proxy] [429-hold] ${host}${modelNote}: cleared after HTTP ${status} (was ${state.streak} consecutive 429s) (#4204)`);
    }
    for (const group of provisionalGroups.values()) {
        const state = group.state;
        if (state.accountKey !== key) continue;
        expireProbeToken(state, now);
        if (probeToken !== undefined && state.probeToken === probeToken) {
            state.probeToken = undefined;
            state.probeAt = undefined;
        }
    }
}

interface ActiveThrottleHold {
    host: string;
    streak: number;
    nextAttemptAt: number;
    terminal: boolean;
    model?: string;
}

export function activeThrottleHolds(): ActiveThrottleHold[] {
    const maxC = throttle429MaxConsecutive();
    const states = [
        ...holds.values(),
        ...Array.from(provisionalGroups.values(), (group) => group.state),
    ];
    return states.map((state) => ({
        host: state.host,
        streak: state.streak,
        nextAttemptAt: state.nextAttemptAt,
        terminal: state.streak >= maxC,
        ...(state.model === undefined ? {} : { model: state.model }),
    }));
}

export function _resetUpstreamThrottleForTest(): void {
    holds.clear();
    provisionalGroups.clear();
    for (const state of classificationReservations.values()) {
        state.active = false;
        state.onRelease = undefined;
    }
    classificationReservations.clear();
    activeClassificationCounts.clear();
}
