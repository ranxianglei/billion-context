// #5874 2×2 stage 0 (#6181): world match + kernel-input assembly for
// cohort (dual-channel DECLARED) plugin traffic. SHARED by the openai and
// responses lanes so both carry the same red gate and the same
// one-round-convergence contract — the HTTP responses lane previously had
// NO assembly layer at all, which is how a chained (delta) turn's collapsed
// kernel view reached the plane and destroyed it (#6181 B0: the plane
// invariant is "the resent array IS the world", and only a cohort turn
// proves that — a non-cohort chained turn cannot be addressed against the
// plane at all).
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
//  - stage 0: snapStage0 → resync (diverge / explicit re-baseline) → plane
//    reset + legacy this turn + the lane clears session.responsesDelta
//    (M6: a stale frontier against re-issued pos is a dead loop);
//    otherwise assemble the kernel input from the plane rows (old cores —
//    the kernel's own tagged output, invariant v) + the NEW spans (P5) +
//    anchor rows at their covered-run boundary.

import type { BiliMessage } from "acp-kernel/wire";
import { getStore } from "../persist.js";
import { featureEnabled } from "../rollout.js";
import { applyMsgIdPin, validateMsgIds } from "../msgid-pin.js";
import { ANCHOR_ID_PREFIX } from "../storage/snap.js";
import { assembleKernelInput, shouldResync } from "./assemble.js";
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
    /** Assembled kernel input (stage 0 hit). undefined → the lane renders
     *  its usual view (anchored / D lane). */
    kernelInput: BiliMessage[] | undefined;
    /** True when the cohort armed and RAN (assembled, resynced, or
     *  degraded) — the lane gates the chained-non-assembled plane bypass
     *  on its NEGATION: a non-cohort chained turn's kernel view is a
     *  delta, not the world, and must touch neither the plane write nor
     *  the plane egress for this turn (B0 defensive). */
    cohortRan: boolean;
    /** True when stage 0 reset the plane this turn (diverge / explicit
     *  re-baseline) — the lane must clear session.responsesDelta (M6). */
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
    let kernelInput: BiliMessage[] | undefined;
    let resynced = false;
    if (armed) {
        try {
            const store = getStore();
            const stage0 = store?.snapStage0(sessionId, msgs.map((m) => m.id), { seqs: incomingSeqs ?? undefined });
            const cores = stage0 ? (store?.snapStage0Cores(sessionId) ?? null) : null;
            if (stage0 && cores) {
                if (shouldResync(stage0.decision, cores.rows.length)) {
                    // Structural disagreement (diverge) or an explicit
                    // re-baseline: reset the plane; THIS turn runs the
                    // legacy full path and re-seeds it through the
                    // in-request flush — the NEXT turn re-issues the
                    // envelope from the client's current array.
                    store!.snapStage0Reset(sessionId);
                    resynced = true;
                    log("warn", `[${sessionId}] [2x2:${lane}] stage-0 ${stage0.decision.mode} — plane reset, this turn legacy (one-round convergence)`);
                } else {
                    // newCores = the converted spans of the NEW ids, in
                    // envelope order. The front stage already converted the
                    // whole array (front-stage invariance), so the new
                    // spans carry their full-parse bytes — T5 holds by
                    // construction.
                    const newIdSet = new Set(stage0.decision.newIdPos.map((n) => n.id));
                    const newCores: BiliMessage[] = [];
                    const taken = new Set<string>();
                    for (const e of stage0.decision.envelope) {
                        if (!newIdSet.has(e.id) || taken.has(e.id)) continue;
                        taken.add(e.id);
                        const m = msgs.find((x) => x.id === e.id);
                        if (m === undefined) throw new Error(`new span ${e.id} absent from the converted array`);
                        newCores.push(m);
                    }
                    // The plane's ANCHOR rows (active acp_summary_<blockId>)
                    // ride the kernel input at their covered-run boundary —
                    // the D-view placement parity. snapStage0Cores returns
                    // both the rows and the coverMax map.
                    const anchors = cores.rows
                        .filter((r) => r.ids.some((id) => id.startsWith(ANCHOR_ID_PREFIX)))
                        .map((r) => {
                            const id = r.ids.find((x) => x.startsWith(ANCHOR_ID_PREFIX))!;
                            return {
                                msg: JSON.parse(r.postJson) as BiliMessage,
                                blockId: id.slice(ANCHOR_ID_PREFIX.length),
                            };
                        });
                    const asm = assembleKernelInput({
                        decision: stage0.decision,
                        rows: cores.rows
                            .filter((r) => !r.ids.some((id) => id.startsWith(ANCHOR_ID_PREFIX)))
                            .map((r) => ({ pos: r.pos, ids: r.ids, msg: JSON.parse(r.postJson) as BiliMessage })),
                        newCores,
                        skipIds: stage0.explainedGone,
                        anchors,
                        coverMax: cores.coverMax,
                    });
                    kernelInput = asm.kernelInput;
                    log("info", `[${sessionId}] [2x2:${lane}] stage-0 ${stage0.decision.mode} — kernel input from plane (old=${asm.oldCount}, new=${newCores.length}, anchors=${anchors.length})`);
                }
            }
        } catch (err) {
            if (err instanceof FoundationRejectError) throw err; // R3 outranks the fallback
            const why = err instanceof Error ? err.message : String(err);
            if (why.startsWith("[snapshot 2×2]")) {
                // The assembly could not address the envelope against the
                // plane (table behind — R4-shaped): reset and take the
                // legacy path this turn (one-round convergence). M6: the
                // lane clears session.responsesDelta for a resynced sid.
                try {
                    getStore()?.snapStage0Reset(sessionId);
                } catch { /* the reset is best-effort — the legacy path is the floor */ }
                resynced = true;
            }
            log("warn", `[${sessionId}] [2x2:${lane}] stage-0 failed (${why}) — legacy full path`);
        }
    }
    return { pinned, kernelInput, cohortRan: armed, resynced };
}
