// #7398 all-lanes (ruling 7439-4) + 7439-5: the egress plane's authority
// seam — ONE implementation shared by all four lanes. This replaced two
// tracks: the OpenAI lane carried the full mechanism inline in
// prepare-openai.ts while the other wires got a reduced
// `authorityLaneTurn` (no probe, no latch). Both are gone; every lane now
// calls resolveEgressAuthority + recordAuthorityTurn below.
//
// Ruling 7439-5: for egress-on sessions the server flow is the SOLE
// content authority. The client's resend is — after turn 1 — an
// identity/order channel (the probe) and the byte source for NEW
// messages only.
//
// Two phases (matching where each lane sits in the pipeline):
//   1. resolveEgressAuthority — at the lane's seam position (OpenAI:
//      pre-kernel, so the swap becomes kernel input; Anthropic/
//      Responses/Google: post-kernel, so the swap becomes the outbound
//      core + the recorded bytes). Sets the `egressAuthority` latch
//      (KDD#23 benefit chain), hard-fails (EgressAuthorityRejectError +
//      `egressFlowUnreadable` latch) when there is NO healthy flow point,
//      and classifies the turn:
//        bootstrapping — empty flow (turn-1 cold start): client bytes are
//                        the content source EXACTLY ONCE;
//        swapped       — existing rows carry flow bytes, fresh rows stay
//                        client bytes;
//        legacy        — probe failed (client did not echo the server
//                        conversation) or the view did not rebuild: the
//                        flow is NOT advanced this turn, client bytes
//                        ride outbound, re-attempt next turn.
//   2. recordAuthorityTurn — records per the outcome (ORDER MATTERS:
//      record BEFORE any serve-from-log — the served view must contain
//      THIS turn's row; serving before recording hands back last turn's
//      view and the flow freezes on a zero-op diff, review
//      7439-deviations P1-1). legacy skips the record entirely (never
//      advance the flow with untrusted bytes). Returns the core the lane
//      serves (swapped / client-on-bootstrap), or null = keep the legacy
//      client core.
//
// The system row lives INSIDE the recorded view (type "system") but is
// excluded from the served core — each lane builds its own system block
// live (prefix-cache anchor), exactly like the OpenAI lane. Callers pass
// the lane's OUTBOUND system text (post-injection), so system drift is
// visible as a +U op on that row.
//
// Rollout gate (egressPlane, default 0) and each lane's arming condition
// are owned by the caller.

import { recoverEgressBase, recordEgressTurn, EgressAuthorityRejectError, type EgressOpLogStore } from "../storage/egress-record.js";
import { rebuildCoreFromLog } from "../storage/egress-serve.js";
import type { EgressViewRow } from "../storage/egress-state.js";
import type { BiliMessage } from "acp-kernel/wire";
import type { Session } from "../session.js";

type LaneLog = (level: string, msg: string) => void;

/** Ruling 7439-5 identity/order channel + divergence sampler.
 *
 * Part 1 ORDER: every client id that exists in the server view must appear
 * in server-view order (append-only + client-side folding contract; a
 * reorder means the client is not echoing the server's conversation → the
 * turn degrades to legacy). Part 2 DIVERGENCE: up to 8 sampled rows compare
 * contentType + text length + (short, ≤32KB) exact text. A mismatch does NOT
 * fail the probe — the seam keeps server bytes regardless of what the client
 * sent; sampling only LOGS the divergence event (ruling: 记日志 + 警告,
 * 内容跟服务端, 出站自然收敛). */
export function egressAuthorityProbe(
    base: readonly BiliMessage[],
    client: readonly BiliMessage[],
    sessionId: string,
    log: (level: string, msg: string) => void,
): boolean {
    const baseIndex = new Map<string, number>();
    base.forEach((m, i) => {
        if (!baseIndex.has(m.id)) baseIndex.set(m.id, i);
    });
    let cursor = -1;
    for (const c of client) {
        const i = baseIndex.get(c.id);
        if (i === undefined) continue;
        if (i <= cursor) return false;
        cursor = i;
    }
    let diverged = 0;
    const step = Math.max(1, Math.floor(client.length / 8));
    for (let i = 0; i < client.length; i += step) {
        const c = client[i];
        const bi = baseIndex.get(c.id);
        if (bi === undefined) continue;
        const b = base[bi];
        const ct = typeof c.text === "string" ? c.text : "";
        const bt = typeof b.text === "string" ? b.text : "";
        if (c.contentType !== b.contentType || ct.length !== bt.length || (ct.length <= 32768 && ct !== bt)) diverged++;
        if (diverged >= 4) break;
    }
    if (diverged > 0) {
        log("warn", `[${sessionId}] egress-authority divergence: ${diverged} sampled row(s) differ client-vs-server — server bytes win (client edits do not stick until the egress update API exists; discussions/7439 ruling 5)`);
    }
    return true;
}

interface EgressAuthorityOutcome {
    /** This turn's flow point (possibly empty = bootstrap) — passed to
     * recordAuthorityTurn as the diff `prev`. */
    base: EgressViewRow[];
    /** Empty flow (turn-1 cold start): client bytes are the content source
     * exactly once. */
    bootstrapping: boolean;
    /** Flow-swapped core, or null = the lane keeps its client core and the
     * flow is NOT advanced this turn. */
    swappedCore: BiliMessage[] | null;
}

/** The single authority decision (ruling 7439-5): latch, recover,
 * hard-fail, classify (bootstrap / swapped / legacy). Lane-neutral —
 * OpenAI feeds the result as kernel input, the post-kernel lanes as the
 * outbound core. Throws EgressAuthorityRejectError when no healthy flow
 * point exists (never degrade to client bytes); latches
 * metadata.egressFlowUnreadable so operator recovery is required and
 * retries hit the same error. */
export function resolveEgressAuthority(args: {
    session: Session;
    st: EgressOpLogStore;
    sessionId: string;
    core: BiliMessage[];
    log: LaneLog;
}): EgressAuthorityOutcome {
    const { session, st, sessionId, core, log } = args;
    // Ruling 7439: from this turn the op log is the content source of
    // truth for the session, so the unified-storage verifier must not
    // compare client-resend bytes against the canonical rows (that
    // compare diverges BY DESIGN once the server serves canonical
    // bytes the client never saw verbatim). The marker persists in
    // session metadata (meta_json) so it survives restarts and covers
    // every later turn, not just this one.
    session.metadata["egressAuthority"] = true;
    const base0 = recoverEgressBase(st, sessionId);
    if (base0 === null) {
        log("error", `[${sessionId}] egress-authority: no healthy flow point — refusing to run on client bytes (ruling 7439-5); latching egressFlowUnreadable, session-level recovery required`);
        session.metadata["egressFlowUnreadable"] = true;
        throw new EgressAuthorityRejectError(`egress-authority: session ${sessionId} has no healthy op-log point (ruling 7439-5) — failing the turn instead of trusting client bytes`);
    }
    if (base0.view.length === 0) {
        // Turn-1 cold start (ruling 7439-5): the client bytes are the
        // content source EXACTLY ONCE — recordAuthorityTurn puts them in
        // the flow; from turn 2 this branch never runs again for a
        // healthy session.
        log("info", `[${sessionId}] egress-authority: bootstrap — empty flow, client bytes recorded once (turn 1 of the op-log)`);
        return { base: base0.view, bootstrapping: true, swappedCore: null };
    }
    const base = rebuildCoreFromLog(base0.view) ?? [];
    if (base.length === 0 || !egressAuthorityProbe(base, core, sessionId, log)) {
        if (base.length > 0) {
            log("warn", `[${sessionId}] egress-authority: probe failed — flow NOT advanced this turn; legacy bytes served (re-attempts next turn)`);
        }
        return { base: base0.view, bootstrapping: false, swappedCore: null };
    }
    const baseById = new Map(base.map((m) => [m.id, m] as const));
    const swapped = core.map((c) => baseById.get(c.id) ?? c);
    log("info", `[${sessionId}] egress-authority: ${base.length} existing row(s) served from the op-log, ${Math.max(0, core.length - base.length)} fresh from the client${base0.degraded ? ` (recovered to log_seq=${base0.seq}, truncated ${base0.truncated} row(s))` : ""}`);
    return { base: base0.view, bootstrapping: false, swappedCore: swapped };
}

/** Record THIS turn per the outcome (see the ORDER MATTERS note above):
 * swapped → the swapped core (flow bytes + new client rows),
 * bootstrapping → the client core exactly once, legacy → skip (the flow
 * must not advance with untrusted bytes). A corrupt log point skips this
 * turn (warn); the next turn re-derives from the stored view. Returns the
 * core the lane should serve (swapped / client-on-bootstrap), or null =
 * keep the legacy client core. */
export function recordAuthorityTurn(
    st: EgressOpLogStore,
    sessionId: string,
    outcome: EgressAuthorityOutcome,
    clientCore: BiliMessage[],
    systemText: string,
    log: LaneLog,
): BiliMessage[] | null {
    if (outcome.swappedCore === null && !outcome.bootstrapping) return null;
    const conversation = outcome.swappedCore ?? clientCore;
    try {
        recordEgressTurn({
            store: st,
            sessionId,
            prev: outcome.base.length > 0 ? outcome.base : undefined,
            conversation,
            systemText,
            nowMs: Date.now(),
        });
    } catch (err) {
        log("warn", `[${sessionId}] egress op-log recording skipped this turn (corrupt log point — self-heals next turn): ${String(err)}`);
    }
    return conversation;
}
