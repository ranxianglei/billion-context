import { markDirty, type Session } from "./session.js";
import { log as loggerLog } from "./logger.js";

/**
 * #498: weak overflow signals. A 400 with a parseable window is a STRONG
 * overflow signal (server.ts learns from it directly). But an upstream that
 * dies mid-stream instead — truncation, timeout — fails NON-400, and on
 * sglang-style backends an oversized input manifests exactly this way: the
 * prompt is accepted, then the stream cuts with no completion event. Those
 * failures carry no window number, so they can never teach the proxy
 * anything on their own. What we CAN observe: the request was at high usage
 * AND it kept failing. A single truncation is indistinguishable from network
 * noise (that is why the loop retries it once, #413); three high-usage
 * truncations inside a quarter hour are a pattern.
 *
 * When the pattern fires we learn the failing input size as a conservative
 * window (shrink-only, mirroring the 400-without-window path: the payload
 * was above the real window, so its size is an upper bound) and arm the
 * emergency shrink so the next turn compresses below it. This unblocks the
 * #351/#499 failure family: oversized requests never succeed, never cache,
 * and never self-heal — without this, the session loops on truncated
 * streams until the client gives up.
 */

const MIN_USAGE = 0.9;
const WINDOW_MS = 15 * 60 * 1000;
const MIN_EVENTS = 3;
const MAX_TRACKED_SESSIONS = 512;

interface WeakOverflowState {
    events: number[];
}

const states = new Map<string, WeakOverflowState>();

function resolvedWindow(session: Session): number {
    const md = (session.metadata ?? {}) as Record<string, unknown>;
    const learned = md.learnedContextLimit as number | undefined;
    const effective = md.effectiveContextLimit as number | undefined;
    const candidates = [learned, effective].filter((v): v is number => typeof v === "number" && v > 0);
    if (candidates.length === 0) return 0;
    return Math.min(...candidates);
}

/**
 * Record a non-400 stream failure (truncation / timeout) for this session.
 * Only counts when usage was already high; arms the emergency shrink after
 * MIN_EVENTS repeats inside WINDOW_MS. `inputTokens` is the failing request's
 * input size when known (usage already sniffed), else the last known input.
 */
export function noteWeakOverflow(
    session: Session,
    opts: { inputTokens?: number; model?: string; reason: string },
): void {
    const window = resolvedWindow(session);
    if (window <= 0) return;
    const input = opts.inputTokens && opts.inputTokens > 0 ? opts.inputTokens : session.stats?.lastInputTokens ?? 0;
    if (input <= 0) return;
    if (input / window < MIN_USAGE) return;

    if (states.size > MAX_TRACKED_SESSIONS) {
        const oldest = states.keys().next().value;
        if (oldest !== undefined) states.delete(oldest);
    }
    const state = states.get(session.id) ?? { events: [] };
    const now = Date.now();
    state.events = state.events.filter((t) => now - t < WINDOW_MS);
    state.events.push(now);
    states.set(session.id, state);
    if (state.events.length < MIN_EVENTS) {
        loggerLog("warn", `[${session.id}] weak overflow signal ${state.events.length}/${MIN_EVENTS} (usage ${Math.round((input / window) * 100)}%, ${opts.reason})`);
        return;
    }
    states.delete(session.id);

    const md = ((session.metadata ?? {}) as Record<string, unknown>);
    if (md.learnedContextLimits === undefined) md.learnedContextLimits = {};
    const learnedMap = md.learnedContextLimits as Record<string, number>;
    const reqModel = opts.model;
    const prev = (reqModel ? learnedMap[reqModel] : undefined) ?? (md.learnedContextLimit as number | undefined);
    // Shrink-only: a previously learned (smaller) value is the tighter bound.
    if (prev === undefined || input < prev) {
        if (reqModel) learnedMap[reqModel] = input;
        else md.learnedContextLimit = input;
        session.metadata = md;
        loggerLog("warn", `[${session.id}] weak overflow confirmed (${MIN_EVENTS}× high-usage failures, ${opts.reason}) — learned conservative window ${input} for ${reqModel ?? "(unknown model)"} (was ${prev ?? "unset"}); arming emergency shrink`);
    } else {
        loggerLog("warn", `[${session.id}] weak overflow confirmed (${MIN_EVENTS}× high-usage failures, ${opts.reason}) — conservative window ${input} not below learned ${prev}; arming emergency shrink only`);
    }
    if (!session.stats) session.stats = { lastInputTokens: input } as Session["stats"];
    else session.stats.lastInputTokens = Math.max(session.stats.lastInputTokens, input);
    markDirty(session);
}

export function resetWeakOverflow(sessionId: string): void {
    states.delete(sessionId);
}
