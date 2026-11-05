import type { Session } from "../session.js";

// #2701: Anthropic Threads bookkeeping. A threads-continue request carries
// ONLY the turn's delta messages — the conversation lives server-side, keyed
// by `thread.previous_message_id`. bili's compress loop consumes the client's
// continue target with its own internal round-2 fetch, so the id the client
// believes in (round 1's message_start id, forwarded verbatim) goes stale the
// moment an internal round advances the tail. Without repair, every
// post-compress turn on a threads session dies with upstream 400:
//   "The requested `previous_message_id` has already been continued. Each
//    response `id` may be continued at most once; continue from the ..."
// The proxy therefore (a) remembers the ids it has observed on the wire
// (message_start of every round) and (b) rewrites an inbound continue whose
// target bili itself already consumed to the current tail. Ids the proxy has
// never seen (client used another route, proxy state lost) are passed through
// untouched — the client knows more than we do in that case.

const THREAD_TAIL_KEY = "anthropicThreadTail";
const CONSUMED_CAP = 20;

interface ThreadTailTracking {
    /** Latest response id observed on the wire — the real thread tail. */
    tail: string;
    /** Ids already continued past (superseded by later rounds), oldest first. */
    consumed: string[];
}

export function readThreadTail(session: Session): ThreadTailTracking | undefined {
    const v = session.metadata[THREAD_TAIL_KEY];
    if (!v || typeof v !== "object") return undefined;
    const t = v as { tail?: unknown; consumed?: unknown };
    if (typeof t.tail !== "string") return undefined;
    const consumed = Array.isArray(t.consumed)
        ? t.consumed.filter((x): x is string => typeof x === "string")
        : [];
    return { tail: t.tail, consumed };
}

/**
 * Record a response id observed on the wire, in observe order. The first id
 * of a turn rolls the previous tail into the consumed set (this turn's round-1
 * request continued past it); later ids are bili's internal rounds rolling the
 * tail forward.
 */
export function recordThreadTail(session: Session, id: string): void {
    const prev = readThreadTail(session);
    if (prev && prev.tail === id) return;
    if (prev) {
        const consumed = [...prev.consumed.filter((x) => x !== prev.tail && x !== id), prev.tail];
        while (consumed.length > CONSUMED_CAP) consumed.shift();
        session.metadata[THREAD_TAIL_KEY] = { tail: id, consumed };
    } else {
        session.metadata[THREAD_TAIL_KEY] = { tail: id, consumed: [] };
    }
}

export function resetThreadTailTracking(session: Session): void {
    delete session.metadata[THREAD_TAIL_KEY];
}

/**
 * Rewrite an inbound anthropic body's `thread` in place:
 * - `create` → drop tracking (new server-side thread; old ids are moot).
 * - `continue` whose `previous_message_id` the proxy itself already consumed
 *   → retarget to the tracked tail (the loop's internal rounds advanced it).
 * Unknown targets are left untouched.
 */
export function rewriteInboundThreadContinue(
    parsed: { thread?: unknown },
    session: Session,
    log: (level: string, msg: string) => void,
    sessionId: string,
): void {
    const thread = parsed.thread;
    if (!thread || typeof thread !== "object") return;
    const t = thread as { type?: unknown; previous_message_id?: unknown };
    if (t.type === "create") {
        if (session.metadata[THREAD_TAIL_KEY] !== undefined) {
            resetThreadTailTracking(session);
            log("info", `[${sessionId}] [threads] create — tail tracking reset (#2701)`);
        }
        return;
    }
    if (t.type !== "continue" || typeof t.previous_message_id !== "string") return;
    const tracking = readThreadTail(session);
    if (!tracking || t.previous_message_id === tracking.tail) return;
    if (!tracking.consumed.includes(t.previous_message_id)) return; // never saw it — trust the client
    const from = t.previous_message_id;
    t.previous_message_id = tracking.tail;
    log("info", `[${sessionId}] [threads] inbound continue target ${from} was already consumed by an internal loop round — retargeted to current tail ${tracking.tail} (#2701)`);
}
