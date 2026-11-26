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
// Rollout gate (egressPlane, default 0 — opt-in per owner ruling 2026-11-24) and each lane's arming condition
// are owned by the caller.

import { recoverEgressBase, recordEgressTurn, EgressAuthorityRejectError, EGRESS_SYSTEM_MSGID, type EgressOpLogStore, type EgressRefMap } from "../storage/egress-record.js";
import type { EgressBlockLedgerInput } from "../storage/egress-block.js";
import { EgressConcurrentWriteError } from "../storage/egress-state.js";
import { featureEnabled } from "../rollout.js";
import { outputBudgetField, readOutputBudget } from "./budget.js";
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
    /** op_seq the base was read at. recordEgressTurn refuses to append when
     * the log has moved past it since (two requests on one session). */
    baseSeq: number;
    /** Empty flow (turn-1 cold start): client bytes are the content source
     * exactly once. */
    bootstrapping: boolean;
    /** Flow-swapped core the lane must serve, or null = the lane keeps its
     * own core. */
    swappedCore: BiliMessage[] | null;
    /** The core recordAuthorityTurn writes this turn, or null = the flow is
     * NOT advanced (legacy turn, or a record-only turn whose log is
     * unreadable). */
    recordCore: BiliMessage[] | null;
}

/** #7574: the ONE arming rule of the authority seam. The server log may
 * replace the conversation only when (a) the plane is on for this install,
 * (b) the request is a plugin-lane turn, (c) that lane's msgid pin
 * succeeded (ids are stable, so "same id = same row" holds) and (d) the
 * request is not a side request (title generation and the other small
 * utility calls share the session's history but are not the conversation).
 * The OpenAI lane always used this rule; the anthropic / responses /
 * google lanes armed on (a) alone, so an unpinned turn or a plain-proxy
 * session could have its conversation replaced by the log. A turn that is
 * not armed is still recorded (the log doubles as the pin ledger). */
export function egressAuthorityArmed(input: { pluginMode: boolean; pinned: boolean; sideRequest: boolean }): boolean {
    return featureEnabled("egressPlane") && input.pluginMode && input.pinned && !input.sideRequest;
}

/** The side-request signal the seam understands on every wire: an output
 * budget of at most 200 tokens (the same line isSideRequest and the OpenAI
 * lane's isTitleGen use). */
export function egressTinyBudget(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const field = outputBudgetField(parsed);
    if (field === null) return false;
    const value = readOutputBudget(parsed as Record<string, unknown>, field);
    return typeof value === "number" && value > 0 && value <= 200;
}

/** #7664 (PR-A): the in-memory kernel block set for the egress block ledger —
 *  present only for egress-on sessions (the latch set by
 *  resolveEgressAuthority). The lane passes it to recordAuthorityTurn / the
 *  inline recordEgressTurn call so the block tables get their per-turn diff
 *  (the unified-leg recorder never runs for these sessions). */
export function egressBlockLedgerFor(session: Session): EgressBlockLedgerInput | undefined {
    return session.metadata?.["egressAuthority"] === true
        ? { state: session.state, blockContents: session.blockContents }
        : undefined;
}

/** The single authority decision (ruling 7439-5): latch, recover,
 * hard-fail, classify (bootstrap / swapped / legacy). Lane-neutral —
 * OpenAI feeds the result as kernel input, the post-kernel lanes as the
 * outbound core. Throws EgressAuthorityRejectError when an ARMED turn has
 * no healthy flow point (never degrade to client bytes); latches
 * metadata.egressFlowUnreadable so operator recovery is required and
 * retries hit the same error. A turn that only records never fails: its
 * log is not the session's content authority, so an unreadable log just
 * means "not recorded" until an operator resets it.
 *
 * Operator recovery (#7574): `GET /__bili/egress/latches` lists the latched
 * sessions, `POST /__bili/egress/reset { sessionId }` drops the damaged
 * log — the next turn bootstraps a fresh one from the client. */
export function resolveEgressAuthority(args: {
    session: Session;
    st: EgressOpLogStore;
    sessionId: string;
    core: BiliMessage[];
    log: LaneLog;
    armed: boolean;
}): EgressAuthorityOutcome {
    const { session, st, sessionId, core, log, armed } = args;
    // #7574: a session latched as unreadable stays failed until an operator
    // resets its log (admin route). Retrying the 17 replay scans on every
    // request would add seconds to each attempt and still end here.
    if (session.metadata["egressFlowUnreadable"] === true) {
        // The operator's reset (POST /__bili/egress/reset) deletes the rows of
        // the log. A latched session always HAS rows, so "latched + no rows"
        // means "was reset": the latch goes and this turn rebuilds the log
        // from what the client sends. (The latch is saved with the session, so
        // this also covers a session that was reset while it was not loaded.)
        const wasReset = st.egressStateMaxSeq(sessionId) === 0;
        if (wasReset) {
            delete session.metadata["egressFlowUnreadable"];
            log("info", `[${sessionId}] egress: the op log was reset — latch cleared, the log is rebuilt from this turn`);
        } else if (armed) {
            log("error", `[${sessionId}] egress-authority: session is latched egressFlowUnreadable — refusing to run on client bytes (ruling 7439-5); reset the log to recover`);
            throw new EgressAuthorityRejectError(`egress-authority: session ${sessionId} has no healthy op-log point (ruling 7439-5) — failing the turn instead of trusting client bytes`);
        } else {
            log("warn", `[${sessionId}] egress: session is latched egressFlowUnreadable — turn not recorded (the log is not this session's authority); reset the log to record again`);
        }
        if (!wasReset) return { base: [], baseSeq: 0, bootstrapping: false, swappedCore: null, recordCore: null };
        // wasReset: fall through — the (now empty) log bootstraps from this turn.
    }
    // The walk-back (and the truncation it performs) is for authority
    // sessions only — a mirror log is never repaired by deleting rows.
    const base0 = recoverEgressBase(st, sessionId, { walk: armed });
    if (base0 === null) {
        if (!armed) {
            log("error", `[${sessionId}] egress: the op log is damaged — turn not recorded (the log is not this session's authority; POST /__bili/egress/reset { sessionId } drops it)`);
            return { base: [], baseSeq: 0, bootstrapping: false, swappedCore: null, recordCore: null };
        }
        log("error", `[${sessionId}] egress-authority: no healthy flow point — refusing to run on client bytes (ruling 7439-5); latching egressFlowUnreadable, session-level recovery required`);
        session.metadata["egressFlowUnreadable"] = true;
        throw new EgressAuthorityRejectError(`egress-authority: session ${sessionId} has no healthy op-log point (ruling 7439-5) — failing the turn instead of trusting client bytes`);
    }
    if (!armed) {
        // Record-only turn: the lane's own core is written as-is and served
        // as-is.
        return { base: base0.view, baseSeq: base0.seq, bootstrapping: false, swappedCore: null, recordCore: core };
    }
    // Ruling 7439: from this turn the op log is the content source of
    // truth for the session, so the unified-storage verifier must not
    // compare client-resend bytes against the canonical rows (that
    // compare diverges BY DESIGN once the server serves canonical
    // bytes the client never saw verbatim). The marker persists in
    // session metadata (meta_json) so it survives restarts and covers
    // every later turn, not just this one.
    session.metadata["egressAuthority"] = true;
    if (base0.view.length === 0) {
        // Turn-1 cold start (ruling 7439-5): the client bytes are the
        // content source EXACTLY ONCE — recordAuthorityTurn puts them in
        // the flow; from turn 2 this branch never runs again for a
        // healthy session.
        log("info", `[${sessionId}] egress-authority: bootstrap — empty flow, client bytes recorded once (turn 1 of the op-log)`);
        return { base: base0.view, baseSeq: base0.seq, bootstrapping: true, swappedCore: null, recordCore: core };
    }
    const base = rebuildCoreFromLog(base0.view) ?? [];
    if (base.length === 0 || !egressAuthorityProbe(base, core, sessionId, log)) {
        if (base.length > 0) {
            log("warn", `[${sessionId}] egress-authority: probe failed — flow NOT advanced this turn; legacy bytes served (re-attempts next turn)`);
        }
        return { base: base0.view, baseSeq: base0.seq, bootstrapping: false, swappedCore: null, recordCore: null };
    }
    const baseById = new Map(base.map((m) => [m.id, m] as const));
    const swapped = core.map((c) => baseById.get(c.id) ?? c);
    log("info", `[${sessionId}] egress-authority: ${base.length} existing row(s) served from the op-log, ${Math.max(0, core.length - base.length)} fresh from the client${base0.degraded ? ` (recovered to op_seq=${base0.seq}, truncated ${base0.truncated} row(s))` : ""}`);
    return { base: base0.view, baseSeq: base0.seq, bootstrapping: false, swappedCore: swapped, recordCore: swapped };
}

/** Record THIS turn per the outcome (see the ORDER MATTERS note above):
 * swapped → the swapped core (flow bytes + new client rows),
 * bootstrapping → the client core exactly once, legacy / unreadable
 * record-only turn → skip (the flow must not advance with untrusted or
 * unverifiable bytes). A corrupt log point or a concurrent writer skips
 * this turn (warn); the next turn re-derives from the stored view. Returns
 * the core the lane should serve (the swapped core, or the client core on a
 * bootstrap turn), or null = keep the lane's own core. */
export function recordAuthorityTurn(
    st: EgressOpLogStore,
    sessionId: string,
    outcome: EgressAuthorityOutcome,
    systemText: string,
    log: LaneLog,
    blockLedger?: EgressBlockLedgerInput,
    refMap?: EgressRefMap,
): BiliMessage[] | null {
    if (outcome.recordCore === null) return null;
    try {
        recordEgressTurn({
            store: st,
            sessionId,
            prev: outcome.base.length > 0 ? outcome.base : undefined,
            baseSeq: outcome.baseSeq,
            conversation: outcome.recordCore,
            systemText,
            nowMs: Date.now(),
            blockLedger,
            refMap,
        });
    } catch (err) {
        if (err instanceof EgressConcurrentWriteError) {
            log("warn", `[${sessionId}] egress op-log recording skipped this turn (another request on this session recorded first): ${String(err)}`);
        } else {
            log("warn", `[${sessionId}] egress op-log recording skipped this turn (corrupt log point — self-heals next turn): ${String(err)}`);
        }
    }
    if (outcome.bootstrapping) return outcome.recordCore;
    return outcome.swappedCore;
}

/**
 * #7439 follow-up (C6): egress-on sequence authority. For a session the
 * op log records, the FLOW is the transcript: each core carries its
 * canonical message number (egress_flow.log_seq — the renumbered citation
 * space: the system row is 0, the first real message 1) as `ledgerSeq`, the
 * same display space the kernel's refs/prune/sync/compress consume (CoreMessage
 * .ledgerSeq, refs #4316 L3). Block coordinates resolved from the same flow
 * (ingestSession) live in the identical space, so seq coverage, block
 * pruning and the ref ledger all line up without any conversion.
 *
 * A core not yet in the flow (fresh this turn) is left un-stamped — its
 * number exists only after recordEgressTurn assigns it, and the id path
 * stays authoritative for it until then. Never fails: an absent store, the
 * flag off, an empty/corrupt view returns the input untouched (the id path
 * keeps working — a sequence stamp is an optimization, not an authority).
 */
export function stampEgressSeqs(
    st: EgressOpLogStore | null | undefined,
    sessionId: string,
    msgs: readonly BiliMessage[],
): BiliMessage[] {
    if (st === null || st === undefined || !featureEnabled("egressPlane")) return msgs as BiliMessage[];
    let view: EgressViewRow[];
    try {
        view = st.egressStateView(sessionId);
    } catch {
        return msgs as BiliMessage[];
    }
    if (view.length === 0) return msgs as BiliMessage[];
    const byId = new Map<string, number>();
    for (const row of view) {
        if (row.msgid !== EGRESS_SYSTEM_MSGID && row.num > 0) byId.set(row.msgid, row.num);
    }
    if (byId.size === 0) return msgs as BiliMessage[];
    let touched = false;
    const out = msgs.map((m) => {
        const n = byId.get(m.id);
        if (n === undefined || m.ledgerSeq === n) return m;
        touched = true;
        return { ...m, ledgerSeq: n };
    });
    // The SAME reference is returned whenever nothing was stamped, so the
    // lanes' reference-inequality discriminators (snapshot-view replacement)
    // keep their exact meaning; a stamped view is a genuine replacement.
    return touched ? out : (msgs as BiliMessage[]);
}
