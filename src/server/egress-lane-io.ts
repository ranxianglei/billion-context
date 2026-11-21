// #7398 all-lanes (ruling 7439-4): the egress plane's record/serve seam for
// the non-OpenAI lanes. The OpenAI lane carries the full mechanism inline in
// prepare-openai.ts (authority seam + serve + record); these helpers give the
// other wires the same lane-neutral core round-trip:
//   serve  — rebuild the session's recorded core view from the flow tables
//            (recoverEgressBase: current healthy point, or a bounded walk-back
//            + truncate past a structurally corrupt point) and hand the core
//            to the lane's own conversion chain;
//   record — append this turn's outbound core view as sparse ops (a corrupt
//            log point skips this turn; the next turn re-derives).
// The system row lives INSIDE the recorded view (type "system") but is
// excluded from the served core — each lane builds its own system block live
// (prefix-cache anchor), exactly like the OpenAI lane.
// Rollout gates (egressPlane, default 0) are owned by the
// caller. Any corrupt/unreadable log point degrades that one turn to the
// lane's legacy core — never a crash, never partial, never client-as-authority.

import { recoverEgressBase, recordEgressTurn, type EgressOpLogStore } from "../storage/egress-record.js";
import { rebuildCoreFromLog } from "../storage/egress-serve.js";
import type { BiliMessage } from "acp-kernel/wire";

type LaneLog = (level: string, msg: string) => void;

export function serveLaneCore(st: EgressOpLogStore, sessionId: string, log: LaneLog): BiliMessage[] | null {
    try {
        const base = recoverEgressBase(st, sessionId);
        if (base === null || base.view.length === 0) return null;
        const core = rebuildCoreFromLog(base.view);
        if (core === null || core.length === 0) return null;
        log("info", `[${sessionId}] egress-serve: served ${base.view.length} rows from op-log${base.degraded ? " (degraded healthy point)" : ""}`);
        return core;
    } catch (err) {
        log("error", `[${sessionId}] egress-serve: log point corrupt or unrebuildable — legacy this turn (session-recovery marker): ${String(err)}`);
        return null;
    }
}

export function recordLaneTurn(st: EgressOpLogStore, sessionId: string, conversation: BiliMessage[], systemText: string, log: LaneLog): void {
    try {
        recordEgressTurn({ store: st, sessionId, prev: undefined, conversation, systemText, nowMs: Date.now() });
    } catch (err) {
        log("warn", `[${sessionId}] egress op-log recording skipped this turn (corrupt log point — self-heals next turn): ${String(err)}`);
    }
}
