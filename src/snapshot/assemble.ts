// 2×2 stage 0 — kernel-input assembly (brief 19544722, Part A core).
//
// The stage-0 verdict (identity.ts) tells us WHICH envelope elements are new
// and where every element sits (append-only pos). This module assembles the
// kernel input for the turn:
//
//   kernelInput = the envelope in CLIENT ORDER, where each element resolves to
//     (a) a FRESH core — the parsed NEW span, converted, in this same turn
//         (the only parse of this turn: P5 — non-new rounds never re-parse), or
//     (b) an OLD core — the plane row's stored kernel byte (post_json),
//         hydrated, verbatim. The kernel re-renders its own tag idempotently
//         (render-refs.ts:124-131) and the token count is a first-render
//         snapshot, so a table-old core rides byte-stable (prefix cache).
//
// The kernel input order is the ENVELOPE (client) order, NOT the plane pos
// order: a scattered NEW span (a mid-history edit) lands at its conversation
// position, not at the tail. That is exactly the kernel input the full-parse
// path (M1) would have produced for the same client array — the byte
// identity M1 vs M2 (acceptance #2) falls out by construction.
//
// R4 (table gap): an envelope element that is neither new nor plane-resolvable
// is a stage-0 verdict we cannot honor — the table is behind the client.
// The lane catches the throw, resets the plane (snapStage0Reset) and serves
// the round from the legacy full path: one-round convergence, never a half
// conversation.

import type { BiliMessage } from "acp-kernel/wire";
import type { WorldDecision } from "./types.ts";

/** A plane row's kernel-input contribution: the stored tagged core, hydrated. */
interface PlaneRowCore {
    pos: number;
    /** The row's bound element ids (core_ids, alias-chain included). */
    ids: string[];
    /** post_json hydrated (media CAS resolved) — the kernel byte. */
    msg: BiliMessage;
}

interface AssembleInput {
    /** The stage-0 verdict (identity.ts). */
    decision: WorldDecision;
    /** The plane's ACTIVE rows, pos-ordered (the old cores). Inactive
     *  (fold-covered) rows are NOT part of the kernel input — the kernel
     *  folds them; their summary anchor is carried by the kernel state. */
    rows: readonly PlaneRowCore[];
    /** The NEW spans, parsed: the kernel-input form of each new element, in
     *  envelope order. Length must equal decision.newIdPos.length. */
    newCores: readonly BiliMessage[];
    /** Envelope ids that may legally have NO plane row and are NOT new:
     *  the fold-explained gone set (a fold absorbed the row — the kernel
     *  state carries the block, the anchor row carries the summary). These
     *  envelope entries are SKIPPED in the walk (the R4 table-gap throw is
     *  suppressed for them and only). */
    skipIds?: ReadonlySet<string>;
    /** The plane's ANCHOR rows (id = acp_summary_<blockId>, active), in
     *  kernel-input form. Inserted after the walk at the covered-run
     *  boundary (coverMax). */
    anchors?: readonly EgressAnchor[];
    /** blockId → highest covered row pos (store.snapStage0Cores). The
     *  anchor renders before the first served element whose pos exceeds
     *  the covered run (the D-view placement parity). */
    coverMax?: Record<string, number>;
}

/** A plane anchor row in kernel-input form (the rendered summary message).
 *  `blockId` is the suffix of the anchor id (acp_summary_<blockId>). */
interface EgressAnchor {
    msg: BiliMessage;
    blockId: string;
}

interface AssembleResult {
    /** The assembled kernel input: envelope-ordered elements (old cores and
     *  fresh cores interleaved at their conversation positions) with the
     *  anchor rows inserted at their covered-run boundary. Feed this to
     *  processTurn. */
    kernelInput: BiliMessage[];
    /** The number of OLD element cores taken from the plane (anchor rows
     *  excluded — they are not ledger elements). */
    oldCount: number;
}

/**
 * Assemble the kernel input for a stage-0-armed turn.
 *
 * @throws when the plane cannot satisfy the verdict (R4-shaped): the caller
 *         resets the plane and serves the round from the legacy full path.
 */
export function assembleKernelInput(input: AssembleInput): AssembleResult {
    const { decision, rows, newCores, skipIds, anchors, coverMax } = input;
    if (newCores.length !== decision.newIdPos.length) {
        throw new Error(
            `[snapshot 2×2] assembleKernelInput: newCores length ${newCores.length} != decision.newIdPos length ${decision.newIdPos.length} (P5: parse exactly the NEW spans)`,
        );
    }
    // Anchor rows are plane rows in their own right — their ids must not be
    // mistaken for element cores (an anchor id can never match an envelope
    // element; excluding them keeps rowById element-only).
    const anchorIds = new Set<string>();
    for (const a of anchors ?? []) anchorIds.add(`acp_summary_${a.blockId}`);
    const newRowById = new Map<string, BiliMessage>();
    decision.newIdPos.forEach(({ id }, i) => {
        if (!newRowById.has(id)) newRowById.set(id, newCores[i]!);
    });
    // Element id → active plane row core (first row in pos order whose core
    // ids contain the element id — alias-safe: a row bound to several ids
    // serves whichever the client echoes first).
    const rowById = new Map<string, BiliMessage>();
    for (const row of rows) {
        if (row.ids.some((id) => anchorIds.has(id))) continue; // anchor row
        for (const id of row.ids) if (!rowById.has(id)) rowById.set(id, row.msg);
    }

    // The walk in CLIENT (envelope) order, recording each element's plane
    // pos so the anchors can be placed against the surviving sequence.
    const kernelInput: BiliMessage[] = [];
    const elementPos: number[] = []; // parallel to kernelInput
    let oldCount = 0;
    for (const e of decision.envelope) {
        const fresh = newRowById.get(e.id);
        if (fresh !== undefined) {
            kernelInput.push(fresh);
            elementPos.push(e.pos);
            continue;
        }
        const old = rowById.get(e.id);
        if (old !== undefined) {
            kernelInput.push(old);
            elementPos.push(e.pos);
            oldCount++;
            continue;
        }
        if (skipIds?.has(e.id)) {
            // Fold-covered and fold-explained: the kernel state carries the
            // block, the anchor row (inserted below) carries the summary.
            continue;
        }
        // An envelope element that is neither new nor plane-resolvable:
        // the stage-0 verdict says it is incoming, so this is a plane/table
        // gap (R4-shaped) — refuse to assemble half a conversation.
        throw new Error(
            `[snapshot 2×2] assembleKernelInput: envelope element ${e.id} (pos ${e.pos}) is neither a new span nor a plane row (table behind the client — resync required)`,
        );
    }

    // Anchor insertion (D-view placement parity): an anchor renders before
    // the first served element whose pos exceeds its block's covered run
    // (coverMax). No coverMax evidence (the covered rows were GC'd) → the
    // view start (the kernel's "earliest covered message" fallback). The pin
    // run (first user) is served verbatim by the kernel on top of this input,
    // so the anchor never needs a pin clamp here.
    const placed: Array<{ at: number, anchor: EgressAnchor }> = [];
    for (const anchor of anchors ?? []) {
        const coverHi = coverMax?.[anchor.blockId] ?? -1;
        let at = 0; // default: view start
        for (let i = 0; i < kernelInput.length; i++) {
            if ((elementPos[i] ?? -1) > coverHi) {
                at = i;
                break;
            }
        }
        placed.push({ at, anchor });
    }
    if (placed.length > 0) {
        placed.sort((a, b) => a.at - b.at);
        const out: BiliMessage[] = [];
        let ki = 0;
        for (const p of placed) {
            while (ki < p.at) out.push(kernelInput[ki++]!);
            out.push(p.anchor.msg);
        }
        while (ki < kernelInput.length) out.push(kernelInput[ki++]!);
        return { kernelInput: out, oldCount };
    }
    return { kernelInput, oldCount };
}

/**
 * The resync predicate (brief: the resync safety net).
 *
 *   - `diverge` — the client's array structurally disagrees with the stored
 *     canon (head moved / order broken): the table cannot be trusted for
 *     THIS round → reset + re-issue from the client's current array.
 *   - `resync` — an explicit mode switch (the lane requested it).
 *
 * A plain `issue` with an EMPTY plane is the NORMAL seed (first turn of a
 * fresh session) — NOT a resync: resetting there would wipe the just-issued
 * canon and re-issue forever. R4 (table gap) surfaces through
 * assembleKernelInput's throw instead — it is per-round, not structural.
 */
export function shouldResync(decision: WorldDecision, _planeRowCount: number): boolean {
    return decision.mode === "diverge" || decision.mode === "resync";
}
