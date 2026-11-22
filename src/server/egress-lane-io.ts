// #7398 all-lanes (ruling 7439-4): the egress plane's record/serve seam for
// the non-OpenAI lanes. The OpenAI lane carries the full mechanism inline in
// prepare-openai.ts (authority seam + serve + record); these helpers give the
// other wires the same lane-neutral core round-trip.
//
// ORDER MATTERS — record FIRST, serve from the view THAT CALL just wrote:
// the served core must contain THIS turn's new message. Serving before
// recording hands back last turn's view (this turn's user input vanishes
// from the outbound) and then records a diff against that same replaced
// view — zero ops, flow frozen forever. review 7439-deviations P1-1.
//
// The system row lives INSIDE the recorded view (type "system") but is
// excluded from the served core — each lane builds its own system block live
// (prefix-cache anchor), exactly like the OpenAI lane. Callers pass the
// lane's OUTBOUND system text (post-injection), so system drift is visible
// as a +U op on that row.
//
// Authority (ruling 7439-5): the server flow is the sole content authority
// for egress-on sessions. `authorityLaneTurn` implements the full swap +
// hard-fail semantics: the kernel input is the flow replay result (not
// client bytes), and an unreadable flow hard-fails the turn (never degrades
// to client bytes). The first turn (empty flow) is a one-time bootstrap
// where client bytes are recorded once.
//
// Rollout gate (egressPlane, default 0) is owned by the caller.

import { recoverEgressBase, recordEgressTurn, EgressAuthorityRejectError, type EgressOpLogStore } from "../storage/egress-record.js";
import { rebuildCoreFromLog } from "../storage/egress-serve.js";
import type { BiliMessage } from "acp-kernel/wire";

type LaneLog = (level: string, msg: string) => void;

/** Append this turn's outbound core view as sparse ops. A corrupt log point
 * skips this turn (warn); the next turn re-derives from the stored view. */
export function recordLaneTurn(st: EgressOpLogStore, sessionId: string, conversation: BiliMessage[], systemText: string, log: LaneLog): void {
    try {
        recordEgressTurn({ store: st, sessionId, prev: undefined, conversation, systemText, nowMs: Date.now() });
    } catch (err) {
        log("warn", `[${sessionId}] egress op-log recording skipped this turn (corrupt log point — self-heals next turn): ${String(err)}`);
    }
}

/** Rebuild the session's recorded core view from the flow tables (current
 * healthy point, or a bounded walk-back + truncate past a structurally
 * corrupt point). Null when nothing is servable — the lane keeps its
 * legacy core for this turn. */
export function rebuildLaneCore(st: EgressOpLogStore, sessionId: string, log: LaneLog): BiliMessage[] | null {
    try {
        const base = recoverEgressBase(st, sessionId);
        if (base === null || base.view.length === 0) return null;
        const core = rebuildCoreFromLog(base.view);
        if (core === null || core.length === 0) return null;
        log("info", `[${sessionId}] egress-serve: served ${base.view.length} rows from op-log${base.degraded ? ` (degraded healthy point, log_seq=${base.seq})` : ""}`);
        return core;
    } catch (err) {
        log("error", `[${sessionId}] egress-serve: log point corrupt or unrebuildable — legacy this turn (session-recovery marker): ${String(err)}`);
        return null;
    }
}

/** Record THIS turn's core view, then serve the view that call just wrote
 * (see the ORDER MATTERS note above). Returns null when the just-recorded
 * view is not servable — the lane keeps its legacy core. */
export function serveLaneTurn(args: {
    st: EgressOpLogStore;
    sessionId: string;
    conversation: BiliMessage[];
    systemText: string;
    log: LaneLog;
}): BiliMessage[] | null {
    recordLaneTurn(args.st, args.sessionId, args.conversation, args.systemText, args.log);
    return rebuildLaneCore(args.st, args.sessionId, args.log);
}

/** Ruling 7439-5 full authority: the flow is the sole content source.
 *
 * Turn 1 (empty flow): bootstrap — record client bytes once, return them
 * unchanged (the one-time content source).
 * Turn 2+: existing messages are served from the flow (client resends are
 * identity verification only); new messages (not yet in the flow) come from
 * the client. The SWAPPED conversation (flow bytes + new client bytes) is
 * what gets recorded. Unreadable flow → EgressAuthorityRejectError (hard
 * fail, never client bytes).
 *
 * Returns the core to use as kernel input + outbound. Throws on unreadable
 * flow (the lane must propagate the error). */
export function authorityLaneTurn(args: {
    st: EgressOpLogStore;
    sessionId: string;
    conversation: BiliMessage[];
    systemText: string;
    log: LaneLog;
}): BiliMessage[] {
    const { st, sessionId, conversation, systemText, log } = args;
    const base = recoverEgressBase(st, sessionId);
    if (base === null) {
        log("error", `[${sessionId}] egress-authority: no healthy flow point (ruling 7439-5) — hard-failing instead of trusting client bytes`);
        throw new EgressAuthorityRejectError(`egress-authority: session ${sessionId} has no healthy op-log point (ruling 7439-5) — failing the turn instead of trusting client bytes`);
    }
    if (base.view.length === 0) {
        // Turn-1 bootstrap: client bytes are the content source exactly once.
        recordLaneTurn(st, sessionId, conversation, systemText, log);
        log("info", `[${sessionId}] egress-authority: bootstrap — empty flow, client bytes recorded once (turn 1)`);
        return conversation;
    }
    // Turn 2+: swap existing messages with flow bytes, keep new client
    // messages, record the swapped conversation, return it.
    const flowCore = rebuildCoreFromLog(base.view);
    if (flowCore === null || flowCore.length === 0) {
        log("error", `[${sessionId}] egress-authority: flow unreadable (ruling 7439-5) — hard-failing`);
        throw new EgressAuthorityRejectError(`egress-authority: session ${sessionId} flow unreadable (ruling 7439-5) — failing the turn`);
    }
    const flowById = new Map(flowCore.map((m) => [m.id, m] as const));
    const swapped = conversation.map((c) => flowById.get(c.id) ?? c);
    recordLaneTurn(st, sessionId, swapped, systemText, log);
    log("info", `[${sessionId}] egress-authority: ${flowCore.length} rows from op-log, ${Math.max(0, conversation.length - flowCore.length)} fresh from client${base.degraded ? ` (degraded, log_seq=${base.seq})` : ""}`);
    return swapped;
}
