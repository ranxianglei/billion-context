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
//  - R3: a FULL-LENGTH declared array that fails entry validation
//    (bad-entry / reserved / control / duplicate) → checkR3Identity is the single arbiter
//    (M2: it is CALLED here, in both lanes); an unlatched fault throws
//    FoundationRejectError → the server maps it to 400 (B1); 3 faults in a
//    10-minute window latch the sid to the legacy path and the latch
//    PERSISTS across proxy restarts (snapR3Latch). D2: the fault path
//    NEVER fires for conversation-bound sids — the host conversation
//    identity IS the identity, the cursor is bookkeeping there.
//    #7064 §8 phase 2 (owner ruling 2026-11-18): a SHORT declared array
//    is now a LEGAL tail form (steady-state incremental — the channel
//    carries anchor + new cores), so "declared but short" is a drift class
//    that degrades to the full signal and NEVER 400s; a genuinely broken
//    host re-converges (full form) and is caught there if its full list
//    is also wrong (D1: never reject drift).
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
import { serializeForStore } from "../storage/ingest.js";
import { splitMediaContent } from "../storage/identity.js";
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
    /** #7064 §8: the decoded x-bili-pf-tail-ids value — three-state, exactly
     *  like the fastpath's parsedTailIds (undefined = header absent, null =
     *  malformed, array = valid, possibly containing "?" slots). The lane
     *  parses it; this path only pins from it when the FULL form is absent.
     *  Positioning contract: element 0 ⇔ the turn's LAST prefix core (the
     *  anchor), the rest are the NEW cores — the same shape the client's
     *  tail-ids arithmetic produces (core-aligned id list sliced at the
     *  last measured T, openai wire). */
    incomingTailIds?: string[] | null;
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
    /** #7064 §8: what the client may send NEXT turn (stamped on the
     *  response as x-bili-msgid-mode, only when the flag is on): "full"
     *  — send the full id list (bootstrap / reanchor / this turn degraded
     *  / the flag is off and only the full pin runs); "incremental" — the
     *  ledger pins the prefix, ride only x-bili-pf-tail-ids. null = neither
     *  form was attempted (no field, no valid tail-ids) — no signal. */
    pinMode: "full" | "incremental" | null;
}

export function runStage0(opts: Stage0Input): Stage0Result {
    const { sessionId, lane, msgs, incomingMsgIds, incomingSeqs, incomingTailIds, pluginMode, wpHit, log } = opts;
    void wpHit; // D3: the arm no longer keys on the hit state (logs only)
    const rollout = featureEnabled("pluginLaneServerHistory");
    const declared = Array.isArray(incomingMsgIds) && incomingMsgIds.length > 0;
    // #7064 §8 phase 2 (owner 2026-11-18): TWO-FORM rule on the declared
    // channel — the SAME field carries either shape and the length
    // discriminates: len === view = FULL list (bootstrap / reanchor),
    // len !== view = TAIL form (anchor + new cores, steady state). No
    // per-lane splitting: the handle.ts funnel puts body, header and
    // harvest sources into this one field on every wire, so responses /
    // anthropic clients go incremental with NO new server channel — they
    // just stop sending the full list in steady state (the client derives
    // the tail from its own previous full list, pfIdTailForm).
    const declaredIds = Array.isArray(incomingMsgIds) ? (incomingMsgIds as string[]) : null;
    const fullForm = declaredIds !== null && declaredIds.length === msgs.length;
    const bodyTail = declaredIds !== null && !fullForm && declaredIds.length > 0 ? declaredIds : null;
    // #7064 §8: the incremental pin is its OWN rollout on top of the lane's
    // (the full-list pin below is untouched). Off = byte-identical to
    // pre-§8 behavior.
    const incrementalOn = rollout && pluginMode && featureEnabled("pluginMsgIdIncremental");
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
    // #7064 §8: the pin-mode signal (see Stage0Result.pinMode). Set wherever
    // EITHER declared form arrives; the full form ALWAYS wins when present
    // (bootstrap / reanchor must be able to run regardless of mode).
    let pinMode: Stage0Result["pinMode"] = null;
    // #6785 owner ruling (2026-11-17): the pin runs on watermark-hit turns TOO.
    // The fork lane matches by host msgid against the ledger's rawIds — a
    // hit turn that skipped the pin wrote h_ rows the child's host ids can
    // never equal, and such parents are un-forkable by identity. The stamped
    // array is captured pre-watermark (prepare-openai:83) and aligns to the
    // FULL view length on hit exactly as on miss, so validation and the pin
    // are unchanged; only the R3 consequences stay behind the `armed` gate.
    if (pluginMode && declaredIds !== null) {
        if (rollout) {
            if (fullForm) {
            const v = validateMsgIds(declaredIds, msgs.length);
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
                // TAIL form on the declared channel (responses / anthropic
                // steady state, or the openai body field carrying the tail):
                // anchor + new cores, the ledger pins the prefix. Same
                // drift-class contract as the pf-tail-ids branch — ANY
                // mismatch degrades to the full signal, never rejects.
                // Read the ledger ONCE here: it decides the gate below AND
                // feeds the pin (single source of truth for C); a store
                // fault reads empty (conservative: takes the FAULT side).
                // #6785 review: the same read carries the content hashes —
                // the incremental pin's prefix-verification material.
                let liveIds: string[] = [];
                let liveHashes: string[] | undefined;
                try {
                    const rows = getStore()?.snapMsgIdLiveIdHashes?.(sessionId) ?? [];
                    liveIds = rows.map((r) => r.id);
                    liveHashes = rows.map((r) => r.hash);
                } catch {
                    liveIds = [];
                    liveHashes = undefined;
                }
                // EXCEPTION: a short array on an EMPTY ledger is not drift —
                // there is no frontier to anchor against, so it is a failed
                // collection on an unknown session: the legacy R3 fault
                // applies (B1/D2 semantics: 400 for a non-bound sid).
                if (liveIds.length === 0 && bodyTail !== null) {
                    const v = validateMsgIds(bodyTail, msgs.length);
                    if (!v.ok && armed) {
                        const convBound = (() => {
                            try {
                                return getStore()?.snapConvBound(sessionId) ?? false;
                            } catch {
                                return false;
                            }
                        })();
                        if (convBound) {
                            log("warn", `[${sessionId}] [msgid] ${lane}-wire pin rejected (${v.reason}) — conversation-bound sid skips the R3 fault, content-derived ids this turn`);
                        } else if (!checkR3Identity(true, msgs.length, bodyTail)) {
                            const { latched } = r3FaultTracker.recordFault(sessionId);
                            if (latched) {
                                armed = false;
                                try {
                                    getStore()?.snapR3Latch(sessionId);
                                } catch { /* best-effort */ }
                                log("error", `[${sessionId}] [2x2:${lane}] R3 identity fault ×3 in window (${v.reason}) — sid latched to the legacy path (persisted)`);
                            } else {
                                const strike = r3FaultTracker.strikes(sessionId);
                                log("warn", `[${sessionId}] [2x2:${lane}] R3 identity fault — strike ${strike}/${r3FaultTracker.strikeCap} in window (${v.reason}) — 400 sent; the sid latches to the legacy path after ${r3FaultTracker.strikeCap - strike} more`);
                                throw new FoundationRejectError(`inbound msgid envelope failed validation (${v.reason})`);
                            }
                        } else {
                            log("warn", `[${sessionId}] [msgid] ${lane}-wire pin rejected (${v.reason}) — falling back to content-derived ids (#4491/#5825)`);
                        }
                    }
                } else {
                    const inc = incrementalOn && bodyTail !== null ? tryIncrementalPin(sessionId, lane, msgs, bodyTail, log, liveIds, liveHashes) : null;
                    if (inc !== null) pinned = inc;
                }
            }
        } else {
            log("info", `[${sessionId}] [msgid] ${lane}-wire biliMsgIds present but pluginLaneServerHistory rollout is off for this install — field stripped, ids not pinned (#5825)`);
        }
        // #7064 §8: the signal is what the client may send NEXT turn — a
        // SUCCESSFUL pin (bootstrap / reanchor included) means the ledger
        // holds the prefix, so the next turn may go incremental. This is
        // what upgrades the client out of full-list mode: a hard "full"
        // here would deadlock the ladder (the full form always wins while
        // it is sent, so the incremental branch would never be reached).
        pinMode = pinned !== null ? "incremental" : "full";
    } else if (pluginMode && Array.isArray(incomingTailIds) && incomingTailIds.length > 0) {
        // #7064 §8 steady state: no full list, only the bounded tail (anchor
        // + new cores). The prefix is pinned from the LEDGER's live rows,
        // the new cores from the tail. ANY mismatch degrades to the full
        // signal — D1: this path NEVER rejects (it is a drift class, not an
        // R3 identity fault) — and the next turn re-converges with a full
        // list (one-round convergence by construction).
        if (incrementalOn) {
            // #6785 review: the tail-ids form also VERIFIES the prefix content
            // against the ledger (same contract as the body-tail branch) — an
            // unreadable ledger degrades the turn, never trusts it blind.
            let liveHashes: string[] | null | undefined;
            try {
                liveHashes = (getStore()?.snapMsgIdLiveIdHashes?.(sessionId) ?? []).map((r) => r.hash);
            } catch {
                liveHashes = null;
            }
            const inc = tryIncrementalPin(sessionId, lane, msgs, incomingTailIds, log, undefined, liveHashes);
            if (inc !== null) {
                pinned = inc;
                pinMode = "incremental";
            } else {
                pinMode = "full";
            }
        } else {
            // Flag off (or the lane rollout off): only the full-list pin
            // runs server-side — tell the client to go back to the full
            // form so a rollback self-heals instead of leaving the session
            // pin-less until a 4xx relearns the mode.
            pinMode = "full";
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
    return { pinned, cohortRan: armed, anchorAdvanced, pinMode };
}

// #7064 §8: the incremental pin — prefix cores re-stamped from the ledger's
// live rows (ingest is INSERT OR IGNORE on (session_id, seq): a position's
// msg_id is written once, so the kernel's ref space only stays stable when
// every presented id matches the ledger), new cores pinned from the tail
// (a "?" slot keeps its content-derived id). Returns null — the full
// signal — on ANY structural disagreement: empty ledger (bootstrap), width
// mismatch (the host compacted/rewrote: C + N !== view length), or an
// anchor that is not the ledger frontier (stale window / id space moved).
// Exported: the anthropic lane's inline pin reuses it (two-form rule).
export function tryIncrementalPin(
    sessionId: string,
    lane: string,
    msgs: BiliMessage[],
    tailIds: string[],
    log: (level: string, msg: string) => void,
    preReadLiveIds?: string[],
    preReadLiveHashes?: string[] | null,
): BiliMessage[] | null {
    let liveIds: string[];
    if (preReadLiveIds !== undefined) {
        liveIds = preReadLiveIds;
    } else {
        try {
            liveIds = getStore()?.snapMsgIdLiveIds(sessionId) ?? [];
        } catch {
            return null; // a store fault degrades — never a 500 on the pin path
        }
    }
    const C = liveIds.length;
    const N = tailIds.length - 1;
    if (C === 0) {
        log("debug", `[${sessionId}] [2x2:${lane}] incremental form on an empty ledger — full signal (bootstrap)`);
        return null;
    }
    if (C + N !== msgs.length) {
        log("info", `[${sessionId}] [2x2:${lane}] incremental width mismatch (ledger=${C}, new=${N}, view=${msgs.length}) — full signal (reanchor next turn)`);
        return null;
    }
    if (tailIds[0] === "?" || tailIds[0] !== liveIds[C - 1]) {
        log("info", `[${sessionId}] [2x2:${lane}] incremental anchor mismatch (tail[0]=${tailIds[0]}, ledger frontier=${liveIds[C - 1]}) — full signal (reanchor next turn)`);
        return null;
    }
    // Entry screening on the NEW cores (same rules as msgid-pin
    // validateMsgIds — a bad id must never reach the ledger's unique index).
    // The seen-set is SEEDED WITH THE LEDGER PREFIX: a new core reusing an
    // existing id (same id, different content) is the identity-anomaly
    // validateMsgIds rejects on the full form — a legit host mints fresh ids
    // for fresh positions, it never reuses one.
    const seen = new Set<string>(liveIds);
    for (let i = 1; i < tailIds.length; i++) { // slot 0 is the anchor (checked above); the NEW cores are slots 1..
        const id = tailIds[i];
        if (id === "?") continue;
        if (typeof id !== "string" || id.length === 0 || id.length > 512 || id.startsWith("acp_summary_") || /[\s\p{C}]/u.test(id) || seen.has(id)) {
            log("info", `[${sessionId}] [2x2:${lane}] incremental tail carried an invalid id at slot ${i} — full signal (reanchor next turn)`);
            return null;
        }
        seen.add(id);
    }
    // Anchor proven: the ledger's live row order IS the view order (ingest
    // sweeps the ledger to the authoritative set, #3285/#4390 — the width
    // check above is what keeps the two in step; a fold-edge transient
    // degrades one turn and re-converges with the full list).
    const stamped = msgs.map((m, i) => {
        if (i < C) return { ...m, id: liveIds[i] };
        const id = tailIds[i - C + 1];
        return id === "?" ? m : { ...m, id };
    });
    // #6785 review (owner: "msgid 是整个系统工作的根基"): the tail form stops
    // sending ids for the prefix — the pin now TRUSTS the prefix content is
    // unchanged too. Verify that trust against the ledger's content hashes
    // before re-stamping: a net-zero mid-history rewrite (same element
    // count, different bytes at some prefix position) passes every check
    // above and would re-stamp the ledger's ids onto new content, desyncing
    // the id↔content contract (the full form rejects id-reuse for changed
    // content — this closes that gap for the tail form). The hash input is
    // the EXACT stored chain (serializeForStore → splitMediaContent) on the
    // STAMPED message — the content bytes include the id (identity is
    // stored-bytes minus id, content_hash is not), and this turn's ingest
    // serializes these same objects, so the comparison is by construction.
    // preReadLiveHashes: undefined = not supplied (no verification —
    // stub-seam callers, behavior unchanged); null/length-mismatch =
    // unverifiable ⇒ full signal. A mismatch is a contract violation,
    // still drift-class here: degrade to the full signal, one-round
    // re-anchor, never a reject (D1). Cost: C × (stringify + sha256) on
    // in-memory strings — ms-scale, zero wire bytes.
    if (preReadLiveHashes !== undefined) {
        if (preReadLiveHashes === null || preReadLiveHashes.length !== C) {
            log("info", `[${sessionId}] [2x2:${lane}] incremental prefix unverifiable (hash rows ${preReadLiveHashes === null ? "unreadable" : preReadLiveHashes.length} ≠ ledger ${C}) — full signal (reanchor next turn)`);
            return null;
        }
        for (let i = 0; i < C; i++) {
            if (splitMediaContent(serializeForStore(stamped[i])).hash !== preReadLiveHashes[i]) {
                log("info", `[${sessionId}] [2x2:${lane}] incremental prefix content diverged at position ${i} of ${C} (ledger id ${liveIds[i]}) — full signal (reanchor next turn)`);
                return null;
            }
        }
    }
    return stamped;
}
