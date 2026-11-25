/**
 * #5221 (Phase 2, owner ruling 2026-10-31): persistent local-resolver WEDGE
 * detector + alarm surface. Detection only — the process NEVER restarts or
 * retries differently on its own; the ruling was "if it heals, it heals
 * without a restart; a restart at most earns an ALARM".
 *
 * Mechanism (#5221 evidence): a long-lived process can hold stale OS-resolver
 * state after a WSL/VPN/MagicDNS change — glibc caches resolv.conf and libuv
 * getaddrinfo ages out — so every tunnel admission's name lookup times out
 * while a freshly spawned process on the same machine resolves fine. The
 * wedge is per-PROCESS: it is proven by "this process resolved these hosts
 * successfully before and has now failed every attempt for minutes straight".
 *
 * Evidence gates (all required, no config surface by design):
 *   1. only THROWING resolutions count as failures — an empty answer is an
 *      authoritative NO-DATA response, i.e. the resolver IS reachable; a dead
 *      name must never look like resolver corruption (#1686 boundary);
 *   2. a host qualifies on a sustained failure streak ALONE — whether or not
 *      this process ever resolved it green. #7747: a process BORN wedged (DNS
 *      takeover before first launch, or a machine where direct egress is
 *      structurally impossible) never records a green, so the old "must have
 *      resolved OK before" gate kept the alarm silent in exactly the case it
 *      exists for. The never-green hosts are LABELLED (coldStartHosts) so the
 *      advice never promises a restart that cannot help; the two-host floor
 *      (gate 4) still keeps a single mistyped upstream from alarming.
 *   3. the failure streak must run continuously for >= WEDGE_SUSTAIN_MS;
 *   4. at least WEDGE_MIN_HOSTS distinct hosts must be wedged at once — one
 *      poisoned destination is configuration noise; two hosts failing every
 *      lookup in lockstep (green-before or born-wedged) is the wedge signature.
 *
 * Recovery is derived, not latched: any successful resolution clears that
 * host's streak; when fewer than two hosts remain wedged the alarm drops on
 * its own (status field back to null, web banner hides).
 *
 * Bound: tunnel destinations are user-supplied (/bili/<url>), so the tracker
 * is FIFO-capped at MAX_TRACKED_HOSTS in first-seen order (activity-time
 * ordering misbehaves when a record carries a backdated clock).
 */
import { log as loggerLog } from "./logger.js";

const WEDGE_MIN_HOSTS = 2;
const WEDGE_SUSTAIN_MS = 5 * 60_000;
const LOG_DEDUP_MS = 10 * 60_000;
const MAX_TRACKED_HOSTS = 256;

type ResolverWedgeWire = {
    tripped: true;
    /** Wall-clock ms when the earliest qualifying failure streak started. */
    sinceMs: number;
    elapsedMs: number;
    /** Sorted hostnames currently wedged (full list, no truncation — the status reader owns display). */
    hosts: string[];
    /**
     * Wedged hosts this process NEVER resolved green — a cold-start wedge
     * (#7747). A restart is unlikely to help for these (a fresh process would
     * hit the same resolver), so the advice must route egress through a proxy
     * instead of promising a restart.
     */
    coldStartHosts: string[];
};

type HostRecord = { lastGoodAt: number | null; failSince: number | null };

let hosts = new Map<string, HostRecord>();
let nowFn: () => number = () => Date.now();
let episodeLoggedAt = 0;

function evictFirstSeen(): void {
    if (hosts.size <= MAX_TRACKED_HOSTS) return;
    const first = hosts.keys().next().value;
    if (first !== undefined) hosts.delete(first);
}

function evalAndLog(now: number): ResolverWedgeWire | null {
    const wedged: Array<[string, number, number | null]> = [];
    for (const [host, r] of hosts) {
        if (r.failSince !== null && now - r.failSince >= WEDGE_SUSTAIN_MS) {
            wedged.push([host, r.failSince, r.lastGoodAt]);
        }
    }
    if (wedged.length < WEDGE_MIN_HOSTS) return null;
    wedged.sort((a, b) => a[0].localeCompare(b[0]));
    const sinceMs = Math.min(...wedged.map(([, since]) => since));
    const coldStartHosts = wedged.filter(([, , lastGoodAt]) => lastGoodAt === null).map(([h]) => h);
    if (now - episodeLoggedAt >= LOG_DEDUP_MS) {
        episodeLoggedAt = now;
        const remedy = coldStartHosts.length > 0
            ? `egress routes through an upstream proxy (-F/--forward-proxy) — ${coldStartHosts.length} of these were never resolved by this process, so restarting the proxy is unlikely to help (a fresh process would hit the same resolver)`
            : `the proxy process restarts or egress routes through an upstream proxy (-F/--forward-proxy) — this process resolved these hosts before the wedge`;
        loggerLog(
            "warn",
            `[resolver-wedge] suspected local-resolver wedge: ${wedged.length} host(s) fail every lookup for >=${WEDGE_SUSTAIN_MS / 60000} min (${wedged.slice(0, 5).map(([h]) => h).join(", ")}${wedged.length > 5 ? ", …" : ""}) — model requests 502 until ${remedy}; see #5221`,
        );
    }
    return { tripped: true, sinceMs, elapsedMs: now - sinceMs, hosts: wedged.map(([h]) => h), coldStartHosts };
}

/** Record ONE hostname-path resolution outcome from checkTunnelDestination.
 *  resolvedOk=true means "the resolver ANSWERED" (even with an empty set);
 *  false means every attempt THREW (ETIMEDOUT/EAI_AGAIN/…). IP literals and
 *  egress-proxied destinations never call this. */
export function resolverWedgeRecord(host: string, resolvedOk: boolean, nowMs?: number): void {
    evictFirstSeen();
    const key = host.toLowerCase();
    const rec = hosts.get(key) ?? { lastGoodAt: null, failSince: null };
    if (resolvedOk) {
        rec.lastGoodAt = nowMs ?? nowFn();
        rec.failSince = null;
    } else if (rec.failSince === null) {
        rec.failSince = nowMs ?? nowFn();
    }
    hosts.set(key, rec);
}

/** Current wedge verdict + its alarm log line. Cheap to call on every
 *  unresolvable admission AND from the 5s status poll — pure derived state. */
export function getResolverWedgeState(nowMs?: number): ResolverWedgeWire | null {
    return evalAndLog(nowMs ?? nowFn());
}

/** Whether this process ever resolved this host green. Used by the per-request
 *  unresolvable message: a never-green host means a restart is unlikely to
 *  help, so the advice must not promise one (#7747). No record → treat as
 *  possibly-green and keep the historical restart advice. */
export function resolverWedgeHostEverResolved(host: string): boolean {
    const rec = hosts.get(host.toLowerCase());
    return rec ? rec.lastGoodAt !== null : true;
}

/** Test seams only. */
export function _resolverWedgeTest(): { reset(): void; setNow(f: () => number): void } {
    return {
        reset() { hosts = new Map(); episodeLoggedAt = 0; },
        setNow(f) { nowFn = f; },
    };
}
