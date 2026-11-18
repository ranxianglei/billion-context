// #5874 2×2 stage 0 (#6181): identity gate + world cursor for cohort
// (dual-channel DECLARED) plugin traffic. SHARED by the openai and
// responses lanes so both carry the same red gate and the same
// one-round-convergence contract.
//
// Runs BEFORE processTurn in the lane, so a thrown FoundationRejectError
// (R3) carries ZERO kernel side effects. Every other fault → the legacy
// full path (degrade, never guess — one-round convergence).
//
// Contract (#7064 slimming, owner ruling 2026-11-17):
//  - armed = pluginMode + dual-channel DECLARED (msgids present) + the
//    pluginLaneServerHistory rollout (M1: the red gate must be unreachable
//    wherever the pin is unreachable). D3: the arm no longer excludes
//    watermark-HIT turns — the cursor refreshes on hit turns too (the hit
//    view is the same canonical id space; the tail anchor stays live).
//  - R3: declared but incomplete → checkR3Identity is the single arbiter
//    (M2: it is CALLED here, in both lanes); an unlatched fault throws
//    FoundationRejectError → the server maps it to 400 (B1); 3 faults in a
//    10-minute window latch the sid to the legacy path and the latch
//    PERSISTS across proxy restarts (snapR3Latch). D2: the fault path
//    NEVER fires for conversation-bound sids — the host conversation
//    identity IS the identity, the cursor is bookkeeping there.
//  - D1 永不判分叉: the stage-0 verdict NEVER rejects or resets — the
//    strongest move is `reanchor` (re-issue the world cursor from the
//    incoming array, one cheap UPDATE). The pre-slimming diverge/envelope
//    reset path is gone: a structural disagreement re-anchors in the same
//    turn and the NEXT same-array turn echoes (one-round convergence, now
//    a property of the cursor, not a lane reset).

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
    /** The openai fast-path watermark hit; the responses lane has none.
     *  (D3: a hit turn still refreshes the cursor — this field is now
     *  informational for logs only.) */
    wpHit?: unknown;
    log: (level: string, msg: string) => void;
}

export interface Stage0Result {
    /** Pinned msg array when the pin applied — the lane adopts it
     *  (`msgs = pinned; originalMessages = msgs`). null otherwise. */
    pinned: BiliMessage[] | null;
    /** True when the cohort armed and RAN (gate passed) — the lane keeps
     *  its per-turn guards keyed on it. */
    cohortRan: boolean;
    /** True when the world cursor MOVED this turn (extend/reanchor/
     *  shrink/issue/resync/anchor — anything but a plain echo). The lane
     *  bumps the session's revisionEpoch so the per-turn snapshot flush
     *  (snapFlush epoch proof) observes the stage-0 advance — a fork
     *  taken between the cursor write and the flush otherwise reads a
     *  STALE parent revision (plugin-fork lane regression, #6785 WIP). */
    anchorAdvanced: boolean;
}

export function runStage0(opts: Stage0Input): Stage0Result {
    const { sessionId, lane, msgs, incomingMsgIds, incomingSeqs, pluginMode, wpHit, log } = opts;
    void wpHit; // D3: the arm no longer keys on the hit state (logs only)
    const rollout = featureEnabled("pluginLaneServerHistory");
    const declared = Array.isArray(incomingMsgIds) && incomingMsgIds.length > 0;
    // M1: the arm rides the SAME rollout as the pin — under the default
    // (rollout off) the whole 2×2 path is unreachable, so R3 is not dead
    // code waiting for a rollout that never arms it. #7064 D3: the
    // wpHit === undefined exclusion is GONE — the cursor refreshes on
    // hit turns too (尾锚常活: the hit view is the same canonical id
    // space, so the tail anchor stays live across hit runs).
    const armed0 = rollout && pluginMode && declared;
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
    // #6785 owner ruling (2026-11-17): the pin runs on watermark-hit turns TOO.
    // The fork lane matches by host msgid against the ledger's rawIds — a
    // hit turn that skipped the pin wrote h_ rows the child's host ids can
    // never equal, and such parents are un-forkable by identity. The stamped
    // array is captured pre-watermark (prepare-openai:83) and aligns to the
    // FULL view length on hit exactly as on miss, so validation and the pin
    // are unchanged; only the R3 consequences stay behind the `armed` gate.
    if (pluginMode && incomingMsgIds !== undefined) {
        if (rollout) {
            const v = validateMsgIds(incomingMsgIds, msgs.length);
            if (v.ok) {
                pinned = applyMsgIdPin(msgs, v.ids);
            } else if (armed) {
                // #7064 D2: conversation-bound sids never take the R3 fault
                // path — the host conversation identity IS the identity and
                // the cursor is bookkeeping; a short/missing msgid array
                // degrades to content-derived ids (the log below) instead of
                // 400/latch.
                const convBound = (() => {
                    try {
                        return getStore()?.snapConvBound(sessionId) ?? false;
                    } catch {
                        return false; // a store fault must not OPEN the fault path
                    }
                })();
                if (convBound) {
                    log("warn", `[${sessionId}] [msgid] ${lane}-wire pin rejected (${v.reason}) — conversation-bound sid skips the R3 fault, content-derived ids this turn`);
                } else if (!checkR3Identity(true, msgs.length, Array.isArray(incomingMsgIds) ? (incomingMsgIds as string[]) : null)) {
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
                } else {
                    log("warn", `[${sessionId}] [msgid] ${lane}-wire pin rejected (${v.reason}) — falling back to content-derived ids (#4491/#5825)`);
                }
            } else {
                log("warn", `[${sessionId}] [msgid] ${lane}-wire pin rejected (${v.reason}) — falling back to content-derived ids (#4491/#5825)`);
            }
        } else {
            log("info", `[${sessionId}] [msgid] ${lane}-wire biliMsgIds present but pluginLaneServerHistory rollout is off for this install — field stripped, ids not pinned (#5825)`);
        }
    }
    let anchorAdvanced = false;
    // D3: the cursor (world anchor) refreshes whenever the host declared +
    // the pin APPLIED — hit or miss turns alike. A rejected pin leaves
    // content-derived ids on the array and must NOT touch the host-id
    // cursor. The verdict is PURE bookkeeping (D1): it can only re-issue,
    // never reject.
    if (pinned !== null) {
        try {
            const store = getStore();
            const stage0 = store?.snapStage0(sessionId, pinned.map((m) => m.id), { seqs: incomingSeqs ?? undefined });
            if (stage0) {
                anchorAdvanced = stage0.decision.mode !== "echo";
                log(anchorAdvanced ? "info" : "debug", `[${sessionId}] [2x2:${lane}] stage-0 ${stage0.decision.mode} (new=${stage0.decision.newIdPos.length}, gone=${stage0.decision.goneIds.length})${stage0.decision.witness ? ` — ${stage0.decision.witness}` : ""}`);
            }
        } catch (err) {
            if (err instanceof FoundationRejectError) {
                // An R3-class fault (l1 ledger conflict — a real mapping
                // under a different ledger sid) rejects the request on
                // EVERY wire: the conflict is a durable ledger state, not a
                // per-request glitch (the M3.2b contract).
                throw err;
            } else {
                const why = err instanceof Error ? err.message : String(err);
                // A stage-0 storage fault (corrupt cursor row / schema edge —
                // R4-shaped): clear the cursor best-effort and take the
                // legacy path this turn (one-round convergence: the next
                // turn re-issues the cursor from the client's array).
                if (why.includes("[snapshot") || why.includes("SQLITE") || why.includes("no such")) {
                    try {
                        getStore()?.snapStage0Reset(sessionId);
                    } catch { /* the reset is best-effort — the legacy path is the floor */ }
                }
                log("warn", `[${sessionId}] [2x2:${lane}] stage-0 failed (${why}) — legacy full path`);
            }
        }
    }
    return { pinned, cohortRan: armed, anchorAdvanced };
}
