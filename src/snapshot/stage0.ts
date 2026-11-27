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
import { applyMsgIdPin, applyWireMsgIdPin, SIBMARK, renderCoreId, validateMsgIds, validateWireMsgIds, wireElementIds, wirePinGroups } from "../msgid-pin.js";
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
    /** Identity consolidation (discussions/7591): the lane's IN-MEMORY
     *  conversation-bound verdict for an egress-on session
     *  (metadata.pluginAgent set → bound). When provided it REPLACES the
     *  store's conversations-row lookup — egress-on sessions never grow a
     *  conversations row and the metadata field is the row's source of
     *  truth anyway. Legacy sessions pass nothing: the store lookup keeps
     *  running (its sticky-namespace semantics, #1426, can legitimately
     *  differ from the in-memory value). */
    convBound?: boolean;
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
    // Identity consolidation (discussions/7591): the lane-supplied
    // conversation-bound verdict (egress-on sessions — no conversations row
    // exists or will ever exist for them) wins; otherwise the legacy store
    // lookup runs (a store fault must not OPEN the fault path).
    const convBound: () => boolean = () => {
        if (opts.convBound !== undefined) return opts.convBound;
        try {
            return getStore()?.snapConvBound(sessionId) ?? false;
        } catch {
            return false;
        }
    };
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
    // #7439 follow-up (cross-lane switching): WIRE-granularity form — the
    // host stamps one id per wire ELEMENT even when the kernel splits an
    // element into N cores (agentic text+tool_calls). The dual-mode is
    // unambiguous by construction: every host that CAN'T prove the split
    // only ever emits the per-core length, so a declared length that
    // matches the group count (not the core count) IS the wire form.
    const wireG = (() => {
        const g = wirePinGroups(msgs);
        return g !== null && g.split ? g : null;
    })();
    const fullForm = declaredIds !== null && (declaredIds.length === msgs.length || (wireG !== null && declaredIds.length === wireG.size));
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
            // Wire form when the declared length is the GROUP count (a split
            // group guarantees group count < core count, so the two modes
            // never overlap); per-core form byte-identical to before.
            const wireHit = wireG !== null && declaredIds.length !== msgs.length;
            const v = wireHit
                ? validateWireMsgIds(declaredIds, wireG!)
                : validateMsgIds(declaredIds, msgs.length);
            if (v.ok) {
                pinned = wireHit
                    ? applyWireMsgIdPin(msgs, wireG!, v.ids)
                    : applyMsgIdPin(msgs, v.ids);
            } else if (armed) {
                // #7064 D2: conversation-bound sids never take the R3 fault
                // path — the host conversation identity IS the identity and
                // the cursor is bookkeeping; a short/missing msgid array
                // degrades to content-derived ids (the log below) instead of
                // 400/latch.
                if (convBound()) {
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
                let liveIds: string[] = [];
                try {
                    liveIds = getStore()?.snapPinLiveIds(sessionId) ?? [];
                } catch {
                    liveIds = [];
                }
                // EXCEPTION: a BROKEN short array on an EMPTY ledger is a
                // collection fault (B1/D2 semantics: 400 for a non-bound sid).
                // #7574: a WELL-FORMED short array on an empty ledger is not.
                // With the incremental form on by default it is what an
                // incremental client sends on its first turn after the
                // server lost the ledger (restored or recreated database,
                // session removed while the host kept its conversation) —
                // and it used to cost that client a failed turn (400, three
                // of them latched the session to the unpinned path for
                // good). There is nothing to anchor against, so the turn
                // runs without the pin (content-derived ids) and the
                // response asks for the full list, which rebuilds the ledger
                // on the next turn exactly like a new session. Only entries
                // that are broken themselves (empty, too long, reserved
                // prefix, whitespace/control characters, duplicates) stay a
                // fault — a real client's tail never contains those.
                if (liveIds.length === 0 && bodyTail !== null) {
                    const v = validateMsgIds(bodyTail, bodyTail.length);
                    if (v.ok) {
                        log("warn", `[${sessionId}] [msgid] ${lane}-wire tail form on an empty ledger — nothing to anchor against: the turn runs without the pin, the response asks for the full list (#7574)`);
                    } else if (armed) {
                        if (convBound()) {
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
                    const inc = incrementalOn && bodyTail !== null ? tryIncrementalPin(sessionId, lane, msgs, bodyTail, log, liveIds) : null;
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
            const inc = tryIncrementalPin(sessionId, lane, msgs, incomingTailIds, log);
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

// #7064 §8 (2026-11-19 owner ruling, the ed71f127 deadlock fix): the
// INCREMENTAL pin — the list is a CONTIGUOUS TAIL of the current view,
// [T-L .. T-1]; the overlap with the ledger's live rows ([T-L .. C-1])
// must equal the ledger ROW BY ROW, the cores past the overlap are pinned
// from the list (a "?" slot keeps its content-derived id). Returns null —
// the full signal — on ANY structural disagreement: empty ledger
// (bootstrap), a list too SHORT to reach into the ledger (nothing to
// verify), a non-tail-aligned list (longer than the view), or any overlap
// row drifting from the ledger. The steady-state form (anchor + new cores,
// L = N+1) is the 1-row-overlap special case of the same rule. Over-ceiling
// sessions (> the client's 2048 retention window) send their TRUNCATED
// body list on carrier-off turns: the overlap then spans hundreds–2047
// rows and the pin PROVES MORE, not less — so a degraded "full" turn can
// still pin and re-upgrade the client; the full list is never a
// requirement any client must be able to produce. Exported: the anthropic
// lane's inline pin reuses it (two-form rule).
export function tryIncrementalPin(
    sessionId: string,
    lane: string,
    msgs: BiliMessage[],
    tailIds: string[],
    log: (level: string, msg: string) => void,
    preReadLiveIds?: string[],
): BiliMessage[] | null {
    let liveIds: string[];
    if (preReadLiveIds !== undefined) {
        liveIds = preReadLiveIds;
    } else {
        try {
            liveIds = getStore()?.snapPinLiveIds(sessionId) ?? [];
        } catch {
            return null; // a store fault degrades — never a 500 on the pin path
        }
    }
    // #7439 follow-up (Part 2): the ledger is CORE-granular (a multi-core
    // wire element carries derived `#pN` ids on its siblings) while the host
    // tail list is WIRE-ELEMENT-granular — the old per-core math drifted on
    // every split turn and the pin degraded to the full signal. Both sides
    // in element units now: the ledger filters to its element leaders, the
    // client view counts its wire groups. A 1:1 session filters nothing and
    // counts identically — the old math is recovered exactly.
    const ledgerEl = wireElementIds(liveIds);
    const C = ledgerEl.length;
    const T = wirePinGroups(msgs)?.size ?? msgs.length;
    const L = tailIds.length;
    if (C === 0) {
        log("debug", `[${sessionId}] [2x2:${lane}] incremental form on an empty ledger — full signal (bootstrap)`);
        return null;
    }
    const n = T - C; // new cores since the ledger caught up (0 on a pure resend)
    if (L < n + 1) {
        // A list that does not reach into the ledger has NO overlap to
        // verify — it cannot prove the prefix, so it cannot pin. (A host
        // that shrank/rewrote sends the FULL form instead — that path
        // re-anchors by design.)
        log("info", `[${sessionId}] [2x2:${lane}] incremental list too short to overlap the ledger (list=${L}, new cores=${n}, view=${T}, ledger=${C}) — full signal (reanchor next turn)`);
        return null;
    }
    if (L > T) {
        log("info", `[${sessionId}] [2x2:${lane}] incremental list longer than the view (list=${L}, view=${T}) — full signal (reanchor next turn)`);
        return null;
    }
    // TAIL ALIGNMENT: the list covers [T-L .. T-1]; the overlap with the
    // ledger is [T-L .. C-1] = tailIds[0 .. L-n-1]. The steady-state form
    // (anchor + new cores) is exactly the 1-row overlap (tailIds[0] must be
    // the ledger frontier); an over-ceiling truncated list (ed71f127:
    // >2048 sessions can only ever send their retained tail) carries up to
    // the client's window of overlap rows and proves MORE. ANY drift row
    // degrades to the full signal — D1: never a reject.
    const overlapEnd = L - n; // first slot that is a NEW core (>= C)
    for (let j = 0; j < overlapEnd; j++) {
        if (tailIds[j] !== ledgerEl[T - L + j]) {
            log("info", `[${sessionId}] [2x2:${lane}] incremental tail drift at overlap row ${T - L + j} (got=${tailIds[j]}, ledger=${ledgerEl[T - L + j]}) — full signal (reanchor next turn)`);
            return null;
        }
    }
    // Entry screening on the NEW cores (same rules as msgid-pin
    // validateMsgIds — a bad id must never reach the ledger's unique index).
    // The seen-set is SEEDED WITH THE LEDGER PREFIX: a new core reusing an
    // existing id (same id, different content) is the identity-anomaly
    // validateMsgIds rejects on the full form — a legit host mints fresh ids
    // for fresh positions, it never reuses one.
    const seen = new Set<string>(liveIds);
    for (let j = overlapEnd; j < L; j++) {
        const id = tailIds[j];
        if (id === "?") continue;
        if (typeof id !== "string" || id.length === 0 || id.length > 512 || id.startsWith("acp_summary_") || id.startsWith(SIBMARK) || /[\s\p{C}]/u.test(id) || seen.has(id)) {
            log("info", `[${sessionId}] [2x2:${lane}] incremental tail carried an invalid id at slot ${j} — full signal (reanchor next turn)`);
            return null;
        }
        seen.add(id);
    }
    // Overlap proven: the ledger's live row order IS the view order (ingest
    // sweeps the ledger to the authoritative set, #3285/#4390 — the overlap
    // check above is what keeps the two in step; a fold-edge transient
    // degrades one turn and re-converges with the full list).
    // CORE-UNIT APPLICATION: the ledger's live cores (RAW — `#pN` siblings
    // included) restamp the first C0 view cores positionally (the host
    // resends its history in parse order — the pin's invariant); the NEW
    // cores are element-granular — each new element's leader takes its tail
    // id, its siblings the derived `#pN` (same scheme as applyWireMsgIdPin,
    // so next turn's ledger filters back to elements cleanly).
    const C0 = liveIds.length;
    if (C0 > msgs.length) {
        log("info", `[${sessionId}] [2x2:${lane}] incremental view shorter than the ledger cores (view cores=${msgs.length}, ledger cores=${C0}) — full signal (reanchor next turn)`);
        return null;
    }
    // The split path needs the prefix to re-split into the ledger's element
    // shape (same wire structure, same split) — otherwise the positional
    // restamp would cross element boundaries.
    if (C0 > C) {
        const prefix = wirePinGroups(msgs.slice(0, C0));
        if (prefix === null || prefix.size !== C) {
            log("info", `[${sessionId}] [2x2:${lane}] incremental prefix does not re-split into the ledger's element shape (ledger elements=${C}) — full signal (reanchor next turn)`);
            return null;
        }
    }
    const out: BiliMessage[] = new Array(msgs.length);
    for (let i = 0; i < C0; i++) out[i]! = { ...msgs[i]!, id: liveIds[i]! };
    let slot = 0;
    let sibling = 0;
    let leaderId = "";
    let prevWire: number | undefined;
    let havePrev = false;
    for (let i = C0; i < msgs.length; i++) {
        const m = msgs[i]!;
        const w = m.wireIndex;
        if (havePrev && w !== undefined && w === prevWire) {
            sibling += 1;
            out[i]! = { ...m, id: renderCoreId(leaderId, sibling) };
        } else {
            havePrev = true;
            prevWire = w;
            sibling = 0;
            if (slot >= n) {
                log("info", `[${sessionId}] [2x2:${lane}] incremental tail carried more new elements (${slot}) than the view/ledger math allows (${n}) — full signal (reanchor next turn)`);
                return null;
            }
            const t = tailIds[overlapEnd + slot]!;
            slot += 1;
            leaderId = t === "?" ? m.id : renderCoreId(t, 0);
            out[i]! = t === "?" ? { ...m } : { ...m, id: leaderId };
        }
    }
    return out;
}
