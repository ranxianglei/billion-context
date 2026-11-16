// #5874 2×2 stage 0 (#6181): identity gate + world match for cohort
// (dual-channel DECLARED) plugin traffic. SHARED by the openai and
// responses lanes so both carry the same red gate and the same
// one-round-convergence contract.
//
// Runs BEFORE processTurn in the lane, so a thrown FoundationRejectError
// (R3) carries ZERO kernel side effects. Every other fault → the legacy
// full path (degrade, never guess — one-round convergence).
//
// Contract (brief 19544722 + review 2026-11-12):
//  - armed = pluginMode + dual-channel DECLARED (msgids present) + the
//    pluginLaneServerHistory rollout (M1: the red gate must be unreachable
//    wherever the pin is unreachable) + no R3 latch on the sid (in-memory
//    window OR the persisted latch, M3).
//  - R3: declared but incomplete → checkR3Identity is the single arbiter
//    (M2: it is CALLED here, in both lanes); an unlatched fault throws
//    FoundationRejectError → the server maps it to 400 (B1); 3 faults in a
//    10-minute window latch the sid to the legacy path and the latch
//    PERSISTS across proxy restarts (snapR3Latch).
//  - stage 0: snapStage0 → diverge / explicit re-baseline → envelope reset
//    + legacy this turn (one-round convergence); otherwise the envelope
//    canon is persisted and the lane renders its usual view (the stored
//    envelope — not a row table — is what the M2 delta-inbound evidence
//    anchors on).

import type { BiliMessage } from "acp-kernel/wire";
import { getStore } from "../persist.js";
import { featureEnabled } from "../rollout.js";
import { applyMsgIdPin, validateMsgIds } from "../msgid-pin.js";
import { checkR3Identity, FoundationRejectError, r3FaultTracker } from "./plane.js";

export interface Stage0Input {
    sessionId: string;
    /** Lane name for log prefixes only ("openai" | "responses"). */
    lane: string;
    /** The converted array for this turn (seq-stamped by the lane). */
    msgs: BiliMessage[];
    /** The raw declared biliMsgIds field value (whatever shape it had). */
    incomingMsgIds: unknown;
    /** Validated ledger seqs (null when absent/mismatched — the lane
     *  already applied them to msgs when non-null). */
    incomingSeqs: number[] | null;
    pluginMode: boolean;
    /** The openai fast-path watermark hit; the responses lane has none. */
    wpHit?: unknown;
    log: (level: string, msg: string) => void;
}

export interface Stage0Result {
    /** Pinned msg array when the pin applied — the lane adopts it
     *  (`msgs = pinned; originalMessages = msgs`). null otherwise. */
    pinned: BiliMessage[] | null;
    /** True when the cohort armed and RAN (gate passed, envelope matched
     *  or resynced) — the lane keeps its per-turn guards keyed on it. */
    cohortRan: boolean;
    /** True when stage 0 reset the envelope this turn (diverge / explicit
     *  re-baseline) — one-round convergence: the NEXT turn re-issues the
     *  envelope from the client's current array. */
    resynced: boolean;
}

export function runStage0(opts: Stage0Input): Stage0Result {
    const { sessionId, lane, msgs, incomingMsgIds, incomingSeqs, pluginMode, wpHit, log } = opts;
    const rollout = featureEnabled("pluginLaneServerHistory");
    const declared = Array.isArray(incomingMsgIds) && incomingMsgIds.length > 0;
    // M1: the arm rides the SAME rollout as the pin — under the default
    // (rollout off) the whole 2×2 path is unreachable, so R3 is not dead
    // code waiting for a rollout that never arms it.
    const armed0 = rollout && wpHit === undefined && pluginMode && declared;
    const persistedLatch = (() => {
        try {
            return getStore()?.snapR3Latched(sessionId) ?? false;
        } catch {
            return false; // a store fault must not change the arming verdict
        }
    })();
    let armed = armed0 && !r3FaultTracker.isLatched(sessionId) && !persistedLatch;
    if (armed0 && !armed) {
        log("debug", `[${sessionId}] [2x2:${lane}] sid is R3-latched — legacy path this turn`);
    }
    let pinned: BiliMessage[] | null = null;
    if (wpHit === undefined && pluginMode && incomingMsgIds !== undefined) {
        if (rollout) {
            const v = validateMsgIds(incomingMsgIds, msgs.length);
            if (v.ok) {
                pinned = applyMsgIdPin(msgs, v.ids);
            } else if (armed) {
                // #6181 M2: checkR3Identity is the single arbiter of the
                // identity fault (declared + element count mismatched) —
                // validateMsgIds' shape verdicts are its evidence, not a
                // second gate.
                if (!checkR3Identity(true, msgs.length, Array.isArray(incomingMsgIds) ? (incomingMsgIds as string[]) : null)) {
                    // R3: a cohort host that DECLARED the dual-channel but
                    // did not collect every element → hard 400 BEFORE any
                    // kernel side effect; the fault feeds the breaker
                    // (10-minute window, 3 strikes → the sid latches to the
                    // legacy path, PERSISTED across restarts (M3), instead
                    // of bricking the session on a misbehaving host).
                    const { latched } = r3FaultTracker.recordFault(sessionId);
                    if (latched) {
                        armed = false;
                        try {
                            getStore()?.snapR3Latch(sessionId);
                        } catch { /* the in-memory latch already fires; persistence is best-effort */ }
                        log("error", `[${sessionId}] [2x2:${lane}] R3 identity fault ×3 in window (${v.reason}) — sid latched to the legacy path (persisted)`);
                    } else {
                        // The pre-latch strikes are otherwise SILENT — the
                        // 400 funnel (server.ts) does not log — so surface
                        // the progress toward the latch with the identity
                        // verdict: an operator needs to see a miscounting
                        // host BEFORE its sid latches to the legacy path
                        // for good (persisted across restarts).
                        const strike = r3FaultTracker.strikes(sessionId);
                        log("warn", `[${sessionId}] [2x2:${lane}] R3 identity fault — strike ${strike}/${r3FaultTracker.strikeCap} in window (${v.reason}) — 400 sent; the sid latches to the legacy path after ${r3FaultTracker.strikeCap - strike} more`);
                        throw new FoundationRejectError(`inbound msgid envelope failed validation (${v.reason})`);
                    }
                }
            } else {
                log("warn", `[${sessionId}] [msgid] ${lane}-wire pin rejected (${v.reason}) — falling back to content-derived ids (#4491/#5825)`);
            }
        } else {
            log("info", `[${sessionId}] [msgid] ${lane}-wire biliMsgIds present but pluginLaneServerHistory rollout is off for this install — field stripped, ids not pinned (#5825)`);
        }
    }
    let resynced = false;
    if (armed) {
        try {
            const store = getStore();
            const stage0 = store?.snapStage0(sessionId, msgs.map((m) => m.id), { seqs: incomingSeqs ?? undefined });
            if (stage0 && stage0.diverge) {
                // Structural disagreement (diverge) or an explicit
                // re-baseline: clear the envelope; THIS turn runs the
                // legacy full path — the NEXT turn re-issues the envelope
                // from the client's current array (one-round convergence).
                store!.snapStage0Reset(sessionId);
                resynced = true;
                log("warn", `[${sessionId}] [2x2:${lane}] stage-0 ${stage0.decision.mode} — envelope reset, this turn legacy (one-round convergence)`);
            } else if (stage0) {
                log("info", `[${sessionId}] [2x2:${lane}] stage-0 ${stage0.decision.mode} (new=${stage0.decision.newIdPos.length}, gone=${stage0.decision.goneIds.length})`);
            }
        } catch (err) {
            if (err instanceof FoundationRejectError) throw err; // R3 outranks the fallback
            const why = err instanceof Error ? err.message : String(err);
            // A stage-0 storage fault (ledger behind / schema edge —
            // R4-shaped): clear the envelope best-effort and take the
            // legacy path this turn (one-round convergence).
            if (why.includes("[snapshot") || why.includes("SQLITE") || why.includes("no such")) {
                try {
                    getStore()?.snapStage0Reset(sessionId);
                } catch { /* the reset is best-effort — the legacy path is the floor */ }
                resynced = true;
            }
            log("warn", `[${sessionId}] [2x2:${lane}] stage-0 failed (${why}) — legacy full path`);
        }
    }
    return { pinned, cohortRan: armed, resynced };
}
