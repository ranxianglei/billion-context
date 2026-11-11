/**
 * #5874 / 2×2 — Part B: incremental outbound (seed / delta selection).
 *
 * The 出站协议改写 stage reads the SAME snapshot plane for every mode
 * (brief 19544722): 出站 snapshot (M1/2) sends ALL active rows (the existing
 * #5901 direct-authority egress — prefix bytes stable by construction);
 * 出站增量 (M3/4) sends only what the provider has NOT seen yet:
 *
 *   - the SEED round (the first outbound for the session, and the first
 *     after a resync / re-arm) must send the FULL view — the provider
 *     (Responses-style retention) has nothing to chain from.
 *   - a DELTA round sends only the new elements: active rows with
 *     pos > frontier (never sent) + anchor rows whose summary id was never
 *     sent.
 *
 *  WHY THE PROVIDER'S CONTEXT GROWS MONOTONICALLY: a Responses-style
 *  provider retains every element it was ever sent (the chain is
 *  append-only — there is no delete API). Rows that later get fold-covered
 *  stay at the provider; the provider's effective conversation is therefore
 *  a SUPERSET of the current egress view. That is the documented trade-off
 *  of 出站增量 (the brief's acceptance #3: the CUMULATIVE rows sent —
 *  including the seed round — are byte-identical to the active-row set the
 *  snapshot mode sends). When the provider's window overflows, the next
 *  outbound RE-SEEDS (full view) and converges in one round.
 *
 *  LCP-based delta selection (diff the assembled views) is REJECTED: a fold
 *  deletes covered rows from the view's prefix, so the new and old views no
 *  longer share a prefix and the "delta" would re-send the tail (duplicating
 *  it at the provider). The row-level frontier (append-only pos) is the
 *  only correct basis.
 */

/** One element of the assembled egress view, with the bookkeeping the
 *  selector needs (buildSnapEgressView returns plain messages; the lane
 *  provides this side channel in the same order). */
export interface EgressElement {
    /** The wire message (anchor = the rendered summary message, data row =
     *  the transformed plane row). */
    msg: unknown;
    /** The plane row pos (append-only). Anchor elements carry their
     *  NEGATIVE anchor pos. */
    pos: number;
    /** true for rendered summary anchors (id = acp_summary_<blockId>). */
    isAnchor: boolean;
    /** The anchor's summary id (isAnchor only). */
    anchorId?: string;
}

export interface DeltaState {
    /** The highest row pos sent to the provider so far (-1 = nothing). */
    frontierPos: number;
    /** The anchor summary ids already sent (acp_summary_*). */
    servedAnchors: string[];
}

export interface DeltaSelection {
    /** true = the provider has nothing (or we re-armed) → send the FULL
     *  view (seed). false = send `delta`. */
    reseed: boolean;
    /** The elements to send, in view order (anchors at their pair-safe
     *  positions, rows pos-ordered). Empty when reseed. */
    delta: readonly EgressElement[];
    /** The new state to persist after this outbound (no-op when reseed
     *  failed upstream — the lane keeps the old state on error). */
    nextState: DeltaState;
}

const ANCHOR_ID_PREFIX = "acp_summary_";

/** The frontier state after the WHOLE view has been sent (seed / re-seed). */
function stateFromElements(elements: readonly EgressElement[]): DeltaState {
    let maxPos = -1;
    const served: string[] = [];
    for (const el of elements) {
        if (el.isAnchor) {
            const id = el.anchorId ?? anchorIdOf(el.msg);
            if (id !== null && !served.includes(id)) served.push(id);
        } else if (el.pos > maxPos) {
            maxPos = el.pos;
        }
    }
    return { frontierPos: maxPos, servedAnchors: served };
}

/** Select the outbound elements for one round.
 *
 *  `state` is the persisted delta state (session.metadata); pass null for a
 *  fresh session → reseed. `elements` is the full egress view (snapshot
 *  mode's output), element side-channel included, in send order.
 *
 *  The selector is PURE (no storage, no clock) — the lane persists
 *  `nextState` only AFTER the outbound succeeds (a failed round keeps the
 *  old frontier and re-sends the same delta next round: at-least-once, the
 *  provider dedupes by the chain).
 */
export function selectOutbound(elements: readonly EgressElement[], state: DeltaState | null): DeltaSelection {
    if (state === null || elements.length === 0) {
        // Reseed: the provider has nothing to chain from — send the FULL view
        // and record everything as served (the frontier moves to the max pos;
        // a later delta sends only what lands above it).
        return { reseed: true, delta: [], nextState: stateFromElements(elements) };
    }
    const served = new Set(state.servedAnchors);
    const delta: EgressElement[] = [];
    let maxPos = state.frontierPos;
    const newAnchors: string[] = [];
    for (const el of elements) {
        if (el.isAnchor) {
            const id = el.anchorId ?? anchorIdOf(el.msg);
            if (id !== null && !served.has(id)) {
                delta.push(el);
                newAnchors.push(id);
            }
            continue;
        }
        if (el.pos > state.frontierPos) {
            delta.push(el);
            if (el.pos > maxPos) maxPos = el.pos;
        }
    }
    return {
        reseed: false,
        delta,
        nextState: { frontierPos: maxPos, servedAnchors: [...state.servedAnchors, ...newAnchors] },
    };
}

/** A delta that grew to the whole view (everything unsent) is a re-seed in
 *  disguise — the provider's chain is empty, so send it as a full seed. */
export function isFullResend(sel: DeltaSelection, elements: readonly EgressElement[]): boolean {
    return !sel.reseed && sel.delta.length >= elements.length;
}

function anchorIdOf(msg: unknown): string | null {
    const m = msg as { id?: unknown };
    return typeof m?.id === "string" && m.id.startsWith(ANCHOR_ID_PREFIX) ? m.id : null;
}
