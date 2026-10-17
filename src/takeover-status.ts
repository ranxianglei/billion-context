// #3582: live "is the native host taking over (compressing) right now", pushed
// by the host and surfaced on BOTH /__bili/status and /__bili/overview (#2152
// parity) so the panel can tell "no active session" apart from "compression
// silently stopped, paying full price direct". Refusal state previously lived
// only in host memory as deduped/GUI-invisible [dsh-client] logs — the reason
// #3578 stayed invisible. The proxy is DISPLAY-ONLY: it stores the latest
// report per agent and derives `unknown` purely from staleness (a dead/stalled
// host stops heartbeating); it never infers health itself. Additive wire field:
// absent until a host reports, so older clients ignore it — no schema change.

export type TakeoverReportState = "ok" | "none" | "threw";
export type TakeoverState = TakeoverReportState | "unknown";

/** What the host pushes via the runtime-info endpoint's optional `takeover`
 *  field. All times are host-clock epoch ms EXCEPT reportedAtMs, which the
 *  PROXY stamps at ingest (same clock as its own staleness comparison — host
 *  clocks skew, so we never compare across clocks). */
export interface TakeoverReport {
    state: TakeoverReportState;
    /** total refusals since the current headline state began */
    refusals: number;
    /** per-endpoint top-N (desc by count) for debugging who's being refused */
    byEndpoint: { endpoint: string; count: number }[];
    /** host-clock epoch ms when the current headline state began */
    sinceMs: number;
    /** host-clock epoch ms of process start — distinguishes "recovered" from
     *  "counters reset because the host restarted" */
    hostStartedAtMs: number;
}

/** Derived wire shape exposed on status/overview. null (absent) when no host
 *  has reported yet; otherwise always present with a derived state. */
export interface TakeoverStatusWire {
    agent: string;
    /** derived: the reported state, or "unknown" once the report goes stale */
    state: TakeoverState;
    /** the raw last-reported state (omitted while unknown) */
    reportedState?: TakeoverReportState;
    stale: boolean;
    refusals: number;
    byEndpoint: { endpoint: string; count: number }[];
    sinceMs: number;
    /** proxy ingest time of the last report (epoch ms) */
    reportedAtMs: number;
    hostStartedAtMs: number;
}

const ENTRY_CAP = 8; // bounded like every other per-agent registry in this repo
export const TAKEOVER_STALE_MS = 3 * 60_000; // ~3× the 60s host heartbeat
export const TAKEOVER_TOP_ENDPOINTS = 5; // top-N surfaced for debugging

interface Entry {
    agent: string;
    report: TakeoverReport;
    receivedAtMs: number;
}

// Append-ordered so the tail is the freshest report overall.
const entries: Entry[] = [];

function num(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/** Defensive parse of the host's `takeover` field. Returns undefined when
 *  absent or malformed (the caller then treats the report as model-only). */
export function parseTakeoverReport(raw: unknown): TakeoverReport | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const o = raw as Record<string, unknown>;
    const state = o.state;
    if (state !== "ok" && state !== "none" && state !== "threw") return undefined;
    const refusals = num(o.refusals);
    const sinceMs = num(o.sinceMs);
    const hostStartedAtMs = num(o.hostStartedAtMs);
    if (refusals === undefined || sinceMs === undefined || hostStartedAtMs === undefined) return undefined;
    const byEndpoint: { endpoint: string; count: number }[] = [];
    if (Array.isArray(o.byEndpoint)) {
        for (const item of o.byEndpoint.slice(0, TAKEOVER_TOP_ENDPOINTS)) {
            if (typeof item !== "object" || item === null) continue;
            const e = item as Record<string, unknown>;
            const endpoint = typeof e.endpoint === "string" && e.endpoint.length > 0 && e.endpoint.length <= 512 ? e.endpoint : undefined;
            const count = num(e.count);
            if (endpoint === undefined || count === undefined) continue;
            byEndpoint.push({ endpoint, count });
        }
        byEndpoint.sort((a, b) => b.count - a.count);
    }
    return { state, refusals, byEndpoint, sinceMs, hostStartedAtMs };
}

function replaceAndPush(agent: string, report: TakeoverReport, receivedAtMs: number): void {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.agent === agent) entries.splice(i, 1);
    }
    entries.push({ agent, report, receivedAtMs });
    while (entries.length > ENTRY_CAP) entries.shift();
}

/** Record a fresh report; the proxy stamps ingest time here. */
export function recordTakeoverStatus(agent: string, report: TakeoverReport): void {
    replaceAndPush(agent, report, Date.now());
}

function pickEntry(agent?: string): Entry | undefined {
    if (agent !== undefined) return entries.find((e) => e.agent === agent);
    return entries.length > 0 ? entries[entries.length - 1] : undefined;
}

/** Derive the wire shape. `nowMs` is injectable for tests (staleness without
 *  real waits). Returns null when no report exists (for the requested agent,
 *  or at all). */
export function takeoverStatusWire(agent?: string, nowMs?: number): TakeoverStatusWire | null {
    const entry = pickEntry(agent);
    if (entry === undefined) return null;
    const now = nowMs ?? Date.now();
    const stale = now - entry.receivedAtMs > TAKEOVER_STALE_MS;
    const wire: TakeoverStatusWire = {
        agent: entry.agent,
        state: stale ? "unknown" : entry.report.state,
        stale,
        refusals: entry.report.refusals,
        byEndpoint: entry.report.byEndpoint,
        sinceMs: entry.report.sinceMs,
        reportedAtMs: entry.receivedAtMs,
        hostStartedAtMs: entry.report.hostStartedAtMs,
    };
    if (!stale) wire.reportedState = entry.report.state;
    return wire;
}

/** Test helper: clear all recorded reports. */
export function _resetTakeoverStatusForTest(): void {
    entries.length = 0;
}

/** Test helper: record with an explicit ingest timestamp (backdate for
 *  staleness assertions without waiting). */
export function _recordTakeoverStatusAt(agent: string, report: TakeoverReport, receivedAtMs: number): void {
    replaceAndPush(agent, report, receivedAtMs);
}
