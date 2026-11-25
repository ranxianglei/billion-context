// Claude Code Remote Control long-polls /v1/environments/<env>/work/poll about
// once a second per registered session, each on a fresh MITM tunnel. Logged per
// request that was ~95% of bili.log (six lines per poll). Polls are counted and
// summarised hourly instead; warnings on these connections still log.

const HOUR_MS = 3_600_000;
const POLL_PATH = /^\/v1\/environments\/[^/?]+\/work\/poll(?:\?|$)/;

export function isQuietPollPath(url: string): boolean {
    return POLL_PATH.test(url);
}

let pollCount = 0;
let pollWindowStart: number | null = null;

export function noteQuietPoll(now: number = Date.now()): string | null {
    pollCount++;
    if (pollWindowStart === null) {
        pollWindowStart = now;
        return null;
    }
    if (now - pollWindowStart < HOUR_MS) return null;
    const line = `[quiet] ${pollCount} Remote Control work polls in the last ${Math.round((now - pollWindowStart) / 60_000)} min (per-request forward and connection lines suppressed)`;
    pollCount = 0;
    pollWindowStart = now;
    return line;
}

const tunnelSeen = new Map<string, { since: number; count: number }>();

// Keyed by the real host:port so masked private hosts do not share a slot;
// only the masked label is ever logged.
export function noteMitmTunnel(hostPort: string, label: string = hostPort, now: number = Date.now()): string | null {
    const base = `mitm ${label} tunnel established (TLS terminated locally)`;
    const seen = tunnelSeen.get(hostPort);
    if (seen === undefined) {
        tunnelSeen.set(hostPort, { since: now, count: 0 });
        return base;
    }
    seen.count++;
    if (now - seen.since < HOUR_MS) return null;
    const line = `${base}; ${seen.count} tunnels to this host in the last ${Math.round((now - seen.since) / 60_000)} min`;
    seen.since = now;
    seen.count = 0;
    return line;
}

export function _resetQuietTrafficForTest(): void {
    pollCount = 0;
    pollWindowStart = null;
    tunnelSeen.clear();
}
