import type { Session } from "./session.js";
import { SELF_HEAL_SUPPRESS_CAP_MS, nudgeSuppressed } from "./session-self-heal.js";

/**
 * #5058 net-progress guard: compression must actually shrink the session.
 *
 * In plugin lanes the compression ACTION is part of the conversation: the
 * model's compress tool-call (args incl. the full summary text), the receipt
 * and the turn's reasoning are persisted by the HOST and re-sent every turn,
 * so they count toward the very growth that triggered the nudge. When a
 * fold's savings do not exceed its action cost (giant summaries, oversized
 * re-sent carriers, repeated failed attempts whose args ride the history),
 * every cycle leaves the session LARGER than before the fold — yet the
 * kernel's baseline reset after each successful commit makes the next nudge
 * due another flat step later, and the action re-trips the growth gate.
 * Pure positive feedback, no convergence.
 *
 * Every standing guard misses this shape by design: the #2748/#3322
 * net-benefit gate judges ONE commit's folded-vs-summary delta in one space;
 * the #2146 breaker counts consecutive FAILURES (successful-but-net-negative
 * folds clear it); the #2155 self-heal D1 window needs reductions to STOP
 * landing (here they keep landing — nextBlockId advances every cycle); the
 * #3461 backoff rate-limits host-side emergency injections only. Nothing
 * measures the cross-round trajectory of the resent payload.
 *
 * Remedy: after each successful fold commit, remember the client-resend level
 * (recordNetProgressBaseline, src/stream.ts). On each following nudge-carrying
 * round, measure the client's raw resend (evaluateNetProgressRound,
 * src/server/handle.ts — same kernel counter over the SAME array class). Two
 * consecutive rounds
 * that fail to drop the context below pre-fold-level-minus-margin mean the
 * folds are not buying back room: latch a per-session nudge suppression
 * (same channel as the #2155 suppress-nudge remedy) until a round
 * demonstrably reduces the context below the bar, or the #3004 wall cap
 * expires. Constants by design (#2155 precedent: no new config knobs).
 *
 * Storage is PROCESS-LOCAL (WeakMap keyed by the session object), never
 * persisted: persist serializes session.metadata into the state file, and
 * this guard fires on EVERY successful fold commit, so writing it there put
 * a volatile ≤10-minute runtime latch into the persisted document of every
 * long session and drifted the byte-for-byte storage goldens deterministically
 * (#4790 precedent — same mechanism family, same fix shape). Entries die with
 * their session object; an evicted-and-reloaded session re-seeds silently —
 * harmless because the latch self-expires within SELF_HEAL_SUPPRESS_CAP_MS
 * anyway, and a fresh arm needs one more successful fold commit followed by
 * at most NET_PROGRESS_STRIKE_LIMIT non-progress rounds. The web badge
 * therefore only appears while the session object is live.
 *
 * Lane scope: PLUGIN LANES ONLY (session.metadata.pluginAgent bound). Only a
 * plugin host persists and re-sends the compression action itself, so only
 * there does the resent payload shrink when a fold works. Proxy-mode clients
 * keep their full local history and re-send it verbatim every turn — bili's
 * folds shrink the rendered view sent to the model, never the client's own
 * store — so once folded coverage exceeds the margin the raw resend
 * structurally never drops below pre-fold-minus-margin and an unscoped latch
 * would arm on every mature proxy session, silencing the flat-50K proactive
 * cadence (KDD #8) without defending any real swelling. The #5058 failure
 * domain (a host store walked past its window by its own action cost) is
 * plugin-mode only.
 */

/** Below pre-fold level by MORE than this counts as progress. Half the flat
 * 50K nudge step: a fold that buys back less than half a step cannot outpace
 * the cadence that will fire the next nudge. */
export const NET_PROGRESS_MARGIN_TOKENS = 25_000;

/** Consecutive non-progress rounds after one fold before the latch arms.
 * One high round is explainable (a big user paste between fold and measure);
 * two in a row is the trajectory. */
export const NET_PROGRESS_STRIKE_LIMIT = 2;

type NetProgressState = {
    /** client-resend tokens at the last successful fold commit */
    baseline: number;
    /** rendered post-fold estimate at commit time (diagnostic only) */
    expectedFloor: number;
    /** consecutive non-progress rounds measured since that fold */
    strikes: number;
    /** wall-clock stamp while the suppression latch holds */
    armedAt?: number;
};

const states = new WeakMap<object, NetProgressState>();

/** Live view of the session object's evidence window (in-process only).
 *  Returns the internal record itself so tests can time-travel armedAt; a
 *  record is replaced whole on each re-baseline, so never retain it across
 *  one. Object-typed so the web layer can pass its minimal SummarySource. */
export function netProgressState(key: object): NetProgressState | undefined {
    return states.get(key);
}

/** The guard measures the client's RESENT payload, which only plugin-lane
 * hosts shrink through folds (see module doc) — proxy sessions are out of
 * scope and keep the flat-50K cadence untouched. */
function netProgressGuardApplies(session: Session): boolean {
    return typeof session.metadata.pluginAgent === "string";
}

/** Called on the compress success path (src/stream.ts) with the INBOUND
 * RESEND token total (same array class as the round check's observation) and
 * the rendered post-fold estimate of the SAME request. A new fold starts a
 * fresh evidence window: prior strikes are stale. */
export function recordNetProgressBaseline(session: Session, resendTokens: number, expectedFloor: number): void {
    if (!netProgressGuardApplies(session)) return;
    if (!Number.isFinite(resendTokens) || resendTokens <= 0) return;
    states.set(session, {
        baseline: Math.round(resendTokens),
        expectedFloor: Math.max(0, Math.round(expectedFloor)),
        strikes: 0,
    });
}

/** True while this session's nudge injection is held by the net-progress
 *  latch (and within the #3004 wall cap). Gates every willInjectNudge site
 *  together with the #2155 latch via nudgeInjectionBlocked. */
export function netProgressNudgeBlocked(session: Session): boolean {
    const st = states.get(session);
    if (st === undefined || st.armedAt === undefined) return false;
    return Date.now() - st.armedAt < SELF_HEAL_SUPPRESS_CAP_MS;
}

/** The ONE suppression expression for nudge-injection sites: the #2155
 *  self-heal latch OR the #5058 net-progress latch. Both share the
 *  decide-ladder fallback punch-through, which the callers keep outside. */
export function nudgeInjectionBlocked(session: Session): boolean {
    return nudgeSuppressed(session) || netProgressNudgeBlocked(session);
}

type LogFn = (level: "info" | "warn", message: string) => void;

/** Evaluate one nudge-carrying round's resent-payload level against the last
 *  fold's baseline. Pure w.r.t. inputs; mutates only the process-local store
 *  (never persisted — see module doc). */
export function evaluateNetProgressRound(session: Session, observedTokens: number, log: LogFn): void {
    if (!netProgressGuardApplies(session)) return;
    const st = states.get(session);
    if (st === undefined) return;
    if (!Number.isFinite(observedTokens) || observedTokens <= 0) return;
    const now = Date.now();
    // #3004 precedent: the latch is self-clearing — release waits on evidence
    // (a reducing round) that may never arrive in a dead session, and the
    // suppressed channel is the only one left to prompt compression.
    if (st.armedAt !== undefined && now - st.armedAt >= SELF_HEAL_SUPPRESS_CAP_MS) {
        states.delete(session);
        log("info", `[${session.id}] [net-progress] nudge suppression expired after ${Math.round((now - st.armedAt) / 60_000)} min without a demonstrable reduction — suppression lifted; the next successful fold opens a fresh evidence window (re-arms after ${NET_PROGRESS_STRIKE_LIMIT} more non-progress rounds if compression still does not shrink) (#5058)`);
        return;
    }
    if (observedTokens < st.baseline - NET_PROGRESS_MARGIN_TOKENS) {
        if (st.strikes > 0 || st.armedAt !== undefined) {
            log("info", `[${session.id}] [net-progress] context dropped to ~${observedTokens} tokens (below pre-fold ~${st.baseline} − margin ${NET_PROGRESS_MARGIN_TOKENS}) — compression is shrinking the session again, guard reset`);
        }
        st.strikes = 0;
        delete st.armedAt;
        return;
    }
    if (st.armedAt !== undefined) return;
    st.strikes += 1;
    if (st.strikes >= NET_PROGRESS_STRIKE_LIMIT) {
        st.armedAt = now;
        log("warn", `[${session.id}] [net-progress] compression is NOT shrinking this session: ${st.strikes} consecutive rounds after the last fold left the resent context at ~${observedTokens} tokens (pre-fold level ~${st.baseline}, post-fold estimate ~${st.expectedFloor}) — each compress action costs about as much as its fold saves. Nudge suppressed for this session until a round drops the context below ~${st.baseline - NET_PROGRESS_MARGIN_TOKENS} (or ${SELF_HEAL_SUPPRESS_CAP_MS / 60_000} min elapse). If the session keeps growing, rotate to a fresh session — see CLIENTS.md, long-running sessions (#5058)`);
    }
}
