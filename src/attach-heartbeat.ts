/**
 * #5408: post-attach observation heartbeat.
 *
 * A session that was HOT at attach time (recently saved) and then goes silent
 * is the incident signature behind #5408: after a host restart + proxy
 * rotation the cold load served the session's state 43 times, yet ZERO model
 * requests were ever observed for it — the host's fetch chain had detached
 * (#1158/#1662 family) — so no folding, no usage attribution, no warning ran,
 * until the host itself died with CONTEXT_WINDOW_EXCEEDED ~8h later.
 *
 * This module arms a short silence timer on such loads; if no request for the
 * session reaches the proxy before it fires, it logs ONE error naming the
 * likely causes. It observes only — it never changes routing or folding.
 * Constants are hardcoded on purpose: this is observability, not a behavior
 * knob (no config surface per the env-var discipline).
 */
import { log as loggerLog } from "./logger.js";

/** A cold load whose savedAt is within this window means the session was
 *  actively saving moments ago — silence afterwards is abnormal. */
export const HOT_ATTACH_WINDOW_MS = 10 * 60_000;
/** How long a hot-at-attach session may stay silent before we alarm. */
const ATTACH_SILENCE_MS = 5 * 60_000;

let attachSilenceMs = ATTACH_SILENCE_MS;

interface Armed {
    id: string;
    source: string;
    savedAt: number;
    timer: NodeJS.Timeout;
    fired: boolean;
}

const armed = new Map<string, Armed>();

function disarm(id: string): void {
    const entry = armed.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    armed.delete(id);
}

/** Arm (or re-arm) the silence timer for a freshly cold-loaded session.
 *  No-op when the saved view is already stale — a long-idle session staying
 *  idle after attach is normal, not a failure. */
export function noteColdLoad(id: string, source: string, savedAt?: number): void {
    if (savedAt === undefined) return;
    if (Date.now() - savedAt > HOT_ATTACH_WINDOW_MS) {
        disarm(id);
        return;
    }
    disarm(id);
    const entry: Armed = { id, source, savedAt, timer: setTimeout(() => fire(entry), attachSilenceMs), fired: false };
    entry.timer.unref?.();
    armed.set(id, entry);
}

/** A model request reached the proxy for `id` — observation resumed. Cheap
 *  enough to call on every request (one Map lookup in the common case). */
export function noteRequest(id: string): void {
    disarm(id);
}

function fire(entry: Armed): void {
    if (entry.fired) return;
    entry.fired = true;
    armed.delete(entry.id);
    loggerLog(
        "error",
        `[attach] ${entry.id}: cold-loaded from ${entry.source} while still hot (savedAt ${new Date(entry.savedAt).toISOString()}) but NO model request was observed within ${attachSilenceMs / 60_000} min — the host's traffic may be bypassing this proxy entirely (fetch chain detached, #1158/#1662) or the host died; compression is NOT running for this session (#5408)`,
    );
}

/** Test seam: clear all timers and optionally shorten the silence window so
 *  tests do not wait minutes. */
export function _resetAttachHeartbeatForTest(silenceMsOverride?: number): void {
    for (const entry of [...armed.values()]) {
        clearTimeout(entry.timer);
    }
    armed.clear();
    attachSilenceMs = silenceMsOverride ?? ATTACH_SILENCE_MS;
}
