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
// Authority scoping (ruling 7439-5): these lanes serve the RECORDED view as
// an optimization surface; the client remains the input authority (its
// resends are what get recorded). A corrupt/unreadable log point therefore
// degrades the ONE turn to the lane's legacy core (re-attempts next turn) —
// never a crash, never a partial rebuild. The hard-fail semantics of the
// ruling (whole-flow unreadable ⇒ the request fails, never client
// bytes-as-authority) apply to the PINNED plugin lane, which is the OpenAI
// authority seam in prepare-openai.ts — there a divergent client would be
// served stale server content, so failing loud beats guessing.
//
// Rollout gate (egressPlane, default 0) is owned by the caller.

import { recoverEgressBase, recordEgressTurn, type EgressOpLogStore } from "../storage/egress-record.js";
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
