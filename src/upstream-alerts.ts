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

import { classifyUpstreamFailure, UPSTREAM_FAIL_HINTS, type UpstreamFailureKind } from "./upstream-fail.js";

export interface UpstreamAlert {
    kind: UpstreamFailureKind;
    /** Host[:port] the failing requests targeted — raw, because the overview
     *  endpoint that exposes this table is loopback-gated. */
    host: string;
    hint: string;
    firstSeen: number;
    lastSeen: number;
    count: number;
}

/** v1 scope (#1682): only "fundamentally cannot connect" transport failures.
 *  - client-abort: the downstream client went away — not a bili-side problem;
 *  - upstream-timeout: fired AFTER connect (headers/body idle budget) — the
 *    request may have reached the upstream, so "cannot reach" would be a lie;
 *  - unknown: unclassified — better silent than a misleading red banner. */
export const ALERT_KINDS: ReadonlySet<UpstreamFailureKind> = new Set([
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
 *  lastSeen/count only. Non-alert kinds are ignored entirely. */
export function recordUpstreamAlert(url: string, error: unknown, viaProxy: boolean): void {
    const kind = classifyUpstreamFailure(error, { viaProxy });
    if (!ALERT_KINDS.has(kind)) return;
    const host = hostOf(url);
    const now = Date.now();
    const key = keyFor(kind, host);
    const existing = alerts.get(key);
    if (existing) {
        existing.lastSeen = now;
        existing.count += 1;
        existing.hint = UPSTREAM_FAIL_HINTS[kind];
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
    alerts.set(key, { kind, host, hint: UPSTREAM_FAIL_HINTS[kind], firstSeen: now, lastSeen: now, count: 1 });
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
