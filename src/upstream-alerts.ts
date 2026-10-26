/** Upstream connection alert table (#1682).
 *
 *  A transport failure on the model-request path was previously observable
 *  only in log lines (the #1666 dead-end: user had to find and decode
 *  UND_ERR_CONNECT_TIMEOUT themselves). This module keeps a bounded,
 *  in-memory table of ACTIVE "cannot reach host" alerts, derived purely from
 *  request outcomes — no persistence, no config surface, no wire impact:
 *  process restart drops it, which is correct because it is a snapshot of
 *  NOW, not history.
 *
 *  The web UI renders whatever is here as a global banner via the existing
 *  /__bili/overview poll; nothing else consumes this table. */

import { log as loggerLog } from "./logger.js";
import { classifyUpstreamFailure, hintWithSkippedProxy, redactedSkippedProxy, type SkippedProxyInfo, type UpstreamFailureKind } from "./upstream-fail.js";
import { maskHostPortForLog } from "./log-mask.js";

export interface UpstreamAlert {
    kind: UpstreamFailureKind;
    /** Host[:port] the failing requests targeted — raw, because the overview
     *  endpoint that exposes this table is loopback-gated. */
    host: string;
    hint: string;
    firstSeen: number;
    lastSeen: number;
    count: number;
    /** #2809: set when the failing path ran default-direct while a proxy was
     *  available. The banner renders a LOCALIZED note from these structured
     *  fields (the client's i18n catalog owns the wording; `hint` above is
     *  the full English string for JSON consumers). Redacted. */
    skippedProxy?: string;
    skippedSource?: string;
}

/** v1 scope (#1682): only "fundamentally cannot connect" transport failures.
 *  - client-abort: the downstream client went away — not a bili-side problem;
 *  - upstream-timeout: fired AFTER connect (headers/body idle budget) — the
 *    request may have reached the upstream, so "cannot reach" would be a lie;
 *  - unknown: unclassified — better silent than a misleading red banner. */
const ALERT_KINDS: ReadonlySet<UpstreamFailureKind> = new Set([
    "connect-timeout",
    "connect-refused",
    "proxy-reset",
    "upstream-reset",
    "dns",
    "tls",
]);

const MAX_ALERTS = 32;

let alerts = new Map<string, UpstreamAlert>();

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

function keyFor(kind: UpstreamFailureKind, host: string): string {
    return kind + "\u0000" + host;
}

/** Record one failed model request. Dedup key (kind, host): repeats refresh
 *  lastSeen/count only. Non-alert kinds are ignored entirely. `skipped` (#2809)
 *  rides along so the banner can name the proxy default-direct mode skipped. */
export function recordUpstreamAlert(url: string, error: unknown, viaProxy: boolean, skipped?: SkippedProxyInfo): void {
    const kind = classifyUpstreamFailure(error, { viaProxy });
    if (!ALERT_KINDS.has(kind)) return;
    const host = hostOf(url);
    const now = Date.now();
    const key = keyFor(kind, host);
    const skippedFields = skipped ? { skippedProxy: redactedSkippedProxy(skipped), skippedSource: skipped.source } : {};
    const hint = hintWithSkippedProxy(kind, skipped);
    const existing = alerts.get(key);
    if (existing) {
        existing.lastSeen = now;
        existing.count += 1;
        existing.hint = hint;
        Object.assign(existing, skippedFields);
        return;
    }
    if (alerts.size >= MAX_ALERTS) {
        let oldestKey: string | undefined;
        let oldestAt = Infinity;
        for (const [k, a] of alerts) {
            if (a.lastSeen < oldestAt) {
                oldestAt = a.lastSeen;
                oldestKey = k;
            }
        }
        if (oldestKey !== undefined) alerts.delete(oldestKey);
    }
    alerts.set(key, { kind, host, hint, firstSeen: now, lastSeen: now, count: 1, ...skippedFields });
}

/** Any resolved response to this host proves the path works again — clear ALL
 *  of its active alerts, every kind (one success disproves "unreachable"). */
export function clearUpstreamAlertsForHost(url: string): void {
    const host = hostOf(url);
    for (const [key, a] of alerts) {
        if (a.host === host) alerts.delete(key);
    }
}

/** Active alerts, most recently seen first. Always a fresh array. */
export function getUpstreamAlerts(): UpstreamAlert[] {
    return [...alerts.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export function _resetUpstreamAlertsForTest(): void {
    alerts = new Map();
}

// ── Upstream failure circuit breaker (#3148) ──────────────────────────────
//
// The alert table above tells the WEB UI "host unreachable"; the breaker stops
// bili from AMPLIFYING the outage itself. A host-driven retry loop (dsh
// re-enters the turn after every 502) used to burn one full cold send plus the
// whole in-request retry ladder per round against a dead endpoint (observed:
// 19 rounds × 260KiB at ~12s cadence after the user's local gateway went
// down). After CIRCUIT_OPEN_AFTER consecutive FINAL pre-response failures for
// a host, further requests fail fast — zero bytes sent — with an actionable
// error naming the last failure and the next probe time. One half-open probe
// runs every CIRCUIT_PROBE_COOLDOWN_MS and closes the circuit on success
// (any resolved response, mirroring clearUpstreamAlertsForHost).
//
// Symmetric to the compress-loop breaker (stream.ts: 3 strikes, decay-based
// disarm) — deliberately NO config surface yet; knobs are owner-gated (#3148).

interface UpstreamCircuitFailure {
    kind: string;
    detail: string;
    at: number;
}

interface UpstreamCircuit {
    host: string;
    /** Consecutive FINAL pre-response failures (resets on any resolved response). */
    consecutiveFailures: number;
    openedAt: number | null;
    nextProbeAt: number | null;
    lastFailure: UpstreamCircuitFailure | null;
}

const CIRCUIT_OPEN_AFTER = 3;
let circuitProbeCooldownMs = 60_000;
const MAX_CIRCUITS = 32;

interface CircuitEntry {
    state: UpstreamCircuit;
    /** True while the single half-open probe is in flight — concurrent
     *  requests fail fast instead of stacking parallel probes. */
    probeInFlight: boolean;
    /** #4254: timestamp of the last emitted per-request fail-fast [warn], used by
     *  noteCircuitFailFastLog to bound the OPEN-state log storm to one line/window. */
    lastFailFastLogAt: number;
}

let circuits = new Map<string, CircuitEntry>();

function blockReasonText(c: UpstreamCircuit, now: number): string {
    const lf = c.lastFailure
        ? ` · last failure ${c.lastFailure.kind}${c.lastFailure.detail ? ` (${c.lastFailure.detail})` : ""} @ ${new Date(c.lastFailure.at).toISOString()}`
        : "";
    const waitS = Math.max(0, Math.ceil(((c.nextProbeAt ?? now) - now) / 1000));
    // #4254: the host follows the SAME masking rule as the embedded last-failure
    // detail (both non-public → <private-host>), so one free-text message never
    // mixes a raw "127.0.0.1:7864" next to a masked <private-host>. The actionable
    // endpoint still reaches clients via the structured upstreamFailure.host field.
    return `${maskHostPortForLog(c.host)}: ${c.consecutiveFailures} consecutive pre-response failures since ${new Date(c.openedAt ?? now).toISOString()}${lf}; next probe ${new Date(c.nextProbeAt ?? now).toISOString()} (~${waitS}s) — endpoint unreachable, stop resending full context`;
}

/** Consult before sending to `url`. Returns undefined when the request may
 *  proceed (possibly AS the single half-open probe), or a human-readable
 *  reason when it must fail fast without contacting the endpoint. */
export function upstreamCircuitBlockReason(url: string, now: number = Date.now()): string | undefined {
    const entry = circuits.get(hostOf(url));
    if (!entry || entry.state.openedAt === null) return undefined;
    const c = entry.state;
    if (now < (c.nextProbeAt ?? 0)) return blockReasonText(c, now);
    if (entry.probeInFlight) return blockReasonText(c, now);
    entry.probeInFlight = true;
    return undefined;
}

/** #3776 sub-defect 3: the kind of the last failure that opened a host's
 *  circuit, so the egress can surface WHY requests are failing fast (the same
 *  kind the user must fix). undefined when no open circuit / no recorded failure. */
export function upstreamCircuitLastFailureKind(url: string): string | undefined {
    const entry = circuits.get(hostOf(url));
    if (!entry || entry.state.openedAt === null) return undefined;
    return entry.state.lastFailure?.kind;
}

// #4254: while a circuit stays OPEN, every blocked request would otherwise re-log
// the full errno/url/hint pair. Cap the per-request fail-fast [warn] at one line
// per window per host; state flips (OPEN/CLOSED/probe, logged at their own sites)
// stay visible, so the outage signal survives without re-amplifying the storm.
const FAIL_FAST_LOG_INTERVAL_MS = 60_000;

/** Returns true when the caller should emit the per-request fail-fast [warn] for
 *  `url` now (at most once per window per open host), false when it was already
 *  logged recently and this request's copy can stay silent. */
export function noteCircuitFailFastLog(url: string, now: number = Date.now()): boolean {
    const entry = circuits.get(hostOf(url));
    if (!entry || entry.state.openedAt === null) return true;
    if (now - entry.lastFailFastLogAt >= FAIL_FAST_LOG_INTERVAL_MS) {
        entry.lastFailFastLogAt = now;
        return true;
    }
    return false;
}

/** #4254: seconds until the next half-open probe for an OPEN circuit (undefined
 *  when closed / no scheduled probe) — feeds the egress Retry-After header so
 *  compliant hosts back off instead of resending full context. */
export function upstreamCircuitRetryAfterSeconds(url: string, now: number = Date.now()): number | undefined {
    const entry = circuits.get(hostOf(url));
    if (!entry || entry.state.openedAt === null) return undefined;
    const np = entry.state.nextProbeAt;
    if (np === null) return undefined;
    return Math.max(0, Math.ceil((np - now) / 1000));
}

/** #4254: truncate to `max` chars WITHOUT cutting inside a token — back off to the
 *  last whitespace before the cap so a pasted diagnostic never ends mid-word
 *  ("hint=TCP re…"). Falls back to a hard cut when there is no boundary in range. */
function truncateAtBoundary(s: string | undefined, max: number): string {
    if (!s) return "";
    if (s.length <= max) return s;
    const head = s.slice(0, max);
    const lastSpace = head.lastIndexOf(" ");
    return `${lastSpace > 0 ? head.slice(0, lastSpace) : head}…`;
}

/** Record one FINAL pre-response transport failure (the error escaped the
 *  in-request retry ladder). Same discipline as ALERT_KINDS: client aborts,
 *  post-connect timeouts and HTTP verdicts never COUNT toward opening — only
 *  "cannot reach" failures open the circuit. `detail` (already formatted by
 *  the caller) rides along so fail-fast errors stay actionable. While the
 *  circuit is OPEN this call is the half-open probe finishing without a
 *  response: the single-flight slot is released for ANY kind — an uncounted
 *  result (timeout/abort/unknown) proves neither liveness nor death, but
 *  holding the slot would pin the circuit open until process restart. */
export function recordUpstreamCircuitFailure(url: string, error: unknown, viaProxy: boolean, detail?: string): void {
    const kind = classifyUpstreamFailure(error, { viaProxy });
    const host = hostOf(url);
    const now = Date.now();
    let entry = circuits.get(host);
    if (!entry) {
        if (!ALERT_KINDS.has(kind)) return;
        if (circuits.size >= MAX_CIRCUITS) {
            let oldestKey: string | undefined;
            let oldestAt = Infinity;
            for (const [k, e] of circuits) {
                const t = e.state.lastFailure?.at ?? e.state.openedAt ?? Infinity;
                if (t < oldestAt) {
                    oldestAt = t;
                    oldestKey = k;
                }
            }
            if (oldestKey !== undefined) circuits.delete(oldestKey);
        }
        entry = { state: { host, consecutiveFailures: 0, openedAt: null, nextProbeAt: null, lastFailure: null }, probeInFlight: false, lastFailFastLogAt: 0 };
        circuits.set(host, entry);
    }
    const c = entry.state;
    const shortDetail = truncateAtBoundary(detail, 240);
    if (c.openedAt !== null) {
        // Open: the half-open probe just finished without a response — release
        // the slot and re-arm the cooldown regardless of kind (see above).
        c.lastFailure = { kind, detail: shortDetail, at: now };
        entry.probeInFlight = false;
        c.nextProbeAt = now + circuitProbeCooldownMs;
        loggerLog("warn", `[acp-proxy] upstream circuit probe FAILED for ${host} (${kind}) — re-armed until ${new Date(c.nextProbeAt).toISOString()} (#3148)`);
        return;
    }
    if (!ALERT_KINDS.has(kind)) return;
    c.lastFailure = { kind, detail: shortDetail, at: now };
    c.consecutiveFailures += 1;
    if (c.consecutiveFailures >= CIRCUIT_OPEN_AFTER) {
        c.openedAt = now;
        c.nextProbeAt = now + circuitProbeCooldownMs;
        loggerLog("warn", `[acp-proxy] upstream circuit OPEN for ${host} after ${c.consecutiveFailures} consecutive pre-response failures (last: ${kind}) — requests to this host fail fast until a probe succeeds (next probe ${new Date(c.nextProbeAt).toISOString()}) (#3148)`);
    }
}

/** Any resolved response proves the path works again — close the circuit. */
export function recordUpstreamCircuitSuccess(url: string): void {
    const entry = circuits.get(hostOf(url));
    if (!entry) return;
    if (entry.state.openedAt !== null) {
        loggerLog("info", `[acp-proxy] upstream circuit CLOSED for ${entry.state.host} — a response arrived from the endpoint; normal retry ladder resumes (#3148)`);
    }
    circuits.delete(entry.state.host);
}

/** Open circuits for status surfaces (acp_status / web UI), newest first.
 *  Closed hosts keep no entry. Fresh copies. */
export function getOpenUpstreamCircuits(): UpstreamCircuit[] {
    return [...circuits.values()]
        .filter((e) => e.state.openedAt !== null)
        .map((e) => ({ ...e.state }))
        .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
}

export function _resetUpstreamCircuitsForTest(): void {
    circuits = new Map();
    circuitProbeCooldownMs = 60_000;
}

export function _setCircuitCooldownForTest(ms: number): void {
    circuitProbeCooldownMs = ms;
}
