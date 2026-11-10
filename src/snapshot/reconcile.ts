/**
 * #5874 — snapshot-table compression foundation: reconcile (stages 2–3).
 *
 * The heart of the foundation: it reconciles the CURRENT row ledger against
 * the rewrite layer's output (the model view + the active kernel blocks) and
 * produces the single-transaction commit (events + upsert rows + CAS pre
 * forms + optional checkpoint).
 *
 * ADDRESSING RULE (baseline, §4.2): rows are addressed ONLY by
 * kernel-pipeline evidence — the block coverage (core ids) and the parsed
 * per-element core ids, mapped to the APPEND-ONLY pos via the world's
 * msgid→pos map. NO fuzzy similarity. Any element whose fate cannot be
 * explained by evidence (a core vanished without a block) breaks the join
 * chain → `joinOk = false` (red gate R2): the caller commits NOTHING and
 * runs the whole turn legacy.
 *
 * THE MODEL (per turn, mode A = full parse — the correctness baseline):
 *   - a pos covered by an ACTIVE block → the block ABSORBS the range: every
 *     covered row goes active=0 with coverRef = blockId (its post form is
 *     the PRE form, kept for decompress — invariant iv, ruling B). The
 *     summary content is NOT a row of its own: it rides the host's own
 *     element (the compress tool-result, or the standalone summary message
 *     on carrier-absent lanes), which is a normal new envelope element with
 *     its own msgid → a plain tail row.
 *   - a pos NOT covered (the tail) → a plain row whose post form is that
 *     element's model-view cores (the tail is not folded, so it keeps its
 *     parsed core ids — carrier revoicing preserves ids).
 *
 * COVERED-POS RESOLUTION: after a fold the covered elements are GONE from
 * the client's envelope, so their pos cannot come from this turn's
 * envelope. It comes from the STORED ROWS' coreIds (the pinned host msgids
 * are exactly the kernel ids the block coverage carries). Coverage ids that
 * resolve to neither (nudge cores, rendered summary cores, re-folded block
 * cores) are kernel-internal and are ignored — they are never persisted.
 *
 * APPEND-ONLY pos: a middle insertion issues a fresh pos and never shifts a
 * stored row, so the prefix (and the prefix cache) stays put.
 *
 * BYTE STABILITY (T4): a row's postJson is sourced from the MODEL VIEW by id
 * match, so the stored bytes are exactly what the model saw. The next turn's
 * egress re-reads these bytes (not the client's churned re-send), which is
 * what keeps the prefix cache alive.
 */
import { canonicalJson, sha256hex, s4Aggregate, stateChecksum } from "./checksums.ts";
import type { CheckpointMeta, ReconcileInput, ReconcileOutput, SnapEvent } from "./types.ts";

/** Reconcile the current row ledger against the rewrite output. Pure —
 *  returns the commit to apply (or `joinOk:false` to commit nothing). */
export function reconcile(input: ReconcileInput): ReconcileOutput {
    const { currentRows, envelope, posMap, parsedCores, blockCoverage, modelView, now, turnCount, ckptEveryNTurns } = input;
    void now; // the commit primitive stamps updated_at from its own `now`

    // core id → pos, two sources:
    //   1. THIS TURN's envelope: element i's cores live at posMap[envelope[i]]
    //      (fresh tail, or elements that survived a fold).
    //   2. THE STORED ROWS: after a fold the covered elements are gone from
    //      the envelope, but the rows still carry their coreIds — the pinned
    //      host msgids — so a block's coverage resolves against them.
    const idToPos = new Map<string, number>();
    for (let i = 0; i < envelope.length; i++) {
        const pos = posMap[envelope[i]];
        if (pos === undefined) continue; // an id the world did not map (should not happen)
        for (const c of parsedCores[i] ?? []) idToPos.set(c.id, pos);
    }
    const rowPosByCore = new Map<string, number>();
    for (const [pos, row] of currentRows) {
        for (const id of row.coreIds) rowPosByCore.set(id, pos);
    }

    // Which pos each ACTIVE block covers (via its core ids). Coverage ids
    // that resolve to NEITHER source are kernel-internal (nudge cores,
    // rendered summary cores, re-folded block cores) → ignored: they are
    // never persisted, so they carry no join evidence for the ledger.
    const blockPos = blockCoverage.map((b) => {
        const pos = new Set<number>();
        for (const id of b.coreIds) {
            const p = idToPos.get(id) ?? rowPosByCore.get(id);
            if (p !== undefined) pos.add(p);
        }
        return { blockId: b.blockId, pos: [...pos].sort((a, b2) => a - b2) };
    });

    // A pos is covered if it falls inside some active block's coverage.
    const coveredBy = new Map<number, string>(); // pos → covering blockId
    for (const b of blockPos) {
        for (const p of b.pos) {
            // If two blocks claim the same pos the evidence is contradictory
            // (a core cannot be in two live folds) → R2.
            if (coveredBy.has(p) && coveredBy.get(p) !== b.blockId) return noJoin();
            coveredBy.set(p, b.blockId);
        }
    }

    // Call ids that an ACTIVE block attributes to its fold (the hidden-
    // carrier evidence): a client envelope element whose parse core carries
    // one of these toolCallIds is the fold's OWN tool-call/tool-result pair,
    // which the kernel drops from the model view (the summary rides it). It
    // is not an unexplained disappearance → it gets a row that contributes
    // NO egress cores (post form "[]"), keeping the table view byte-equal to
    // the legacy model view (T4).
    const carrierCallIds = new Set<string>();
    for (const b of blockCoverage) {
        if (typeof b.compressCallId === "string" && b.compressCallId !== "") carrierCallIds.add(b.compressCallId);
    }
    const isCarrierElement = (cores: readonly { id: string; toolName?: string; toolCallId?: string }[]): boolean =>
        cores.some((c) => typeof c.toolCallId === "string" && c.toolCallId !== "" && carrierCallIds.has(c.toolCallId));

    // Build the DESIRED row state (pos → desired form).
    type Desired = {
        postJson: string;
        coreIds: string[];
        tokensEst: number;
        active: boolean;
        coverRef: string | null;
    };
    const desired = new Map<number, Desired>();

    // 0. FOLD-ONLY commit (scopeFull === false): the caller has no envelope,
    //    so the tail is carried forward UNCHANGED — no authority, no sweep.
    //    Carrying the rows into `desired` also keeps them inside the ckpt's
    //    S4 aggregate (the fold commit is a ckpt boundary; an S4 that skips
    //    the live tail rows would red-flag the next hydrate).
    const scopeFull = input.scopeFull !== false;
    if (!scopeFull) {
        for (const [pos, cur] of currentRows) {
            desired.set(pos, {
                postJson: cur.postJson,
                coreIds: cur.coreIds,
                tokensEst: cur.tokensEst,
                active: cur.active,
                coverRef: cur.coverRef,
            });
        }
    }

    // 1. Covered ranges → deactivate every covered row with the covering
    //    block as its lifecycle anchor (ruling B: the row physically dies
    //    only when the block dies, via sweepSnapRowsByDeadCovers). The pre
    //    form is the row's own postJson (kept).
    //    EXCEPTION — the PINNED HEAD (kernel rebuildMessages never hides the
    //    first user core run, even when a fold covers it): that row stays
    //    ACTIVE so the egress still renders it (byte parity with the legacy
    //    view, T4); it carries the covering block as its lifecycle anchor.
    const pinnedSet = new Set<string>(input.pinnedHeadIds ?? []);
    for (const b of blockPos) {
        for (const p of b.pos) {
            const cur = currentRows.get(p);
            const pinned = cur !== undefined && cur.coreIds.some((id) => pinnedSet.has(id));
            desired.set(p, {
                postJson: cur?.postJson ?? "[]",
                coreIds: cur?.coreIds ?? [],
                tokensEst: cur?.tokensEst ?? 0,
                active: pinned,
                coverRef: b.blockId,
            });
        }
    }

    // 2. Tail elements (not covered) → plain rows sourced from the model view
    //    by id (mode A: every element is parsed, so the ids resolve).
    for (let i = 0; i < envelope.length; i++) {
        const pos = posMap[envelope[i]];
        if (pos === undefined) continue;
        if (coveredBy.has(pos)) continue;
        const ids = parsedCores[i]?.map((c) => c.id) ?? [];
        if (ids.length === 0) {
            // A known element the span parse did not re-parse (mode B) →
            // carry the stored form forward (an echo-hit turn: the known
            // element is unchanged, same msgid).
            const cur = currentRows.get(pos);
            if (cur !== undefined) {
                desired.set(pos, {
                    postJson: cur.postJson,
                    coreIds: cur.coreIds,
                    tokensEst: cur.tokensEst,
                    active: cur.active,
                    coverRef: cur.coverRef,
                });
                continue;
            }
            // No parse, no stored row, not covered → unexplained → R2.
            return noJoin();
        }
        const idSet = new Set(ids);
        const cores = modelView.filter((c) => idSet.has(c.id));
        if (cores.length === 0) {
            // A 0-core element is legal ONLY as a hidden fold carrier (the
            // kernel dropped the pair from the model view) → a row that
            // contributes no egress cores. Anything else is an unexplained
            // disappearance → R2.
            if (isCarrierElement(parsedCores[i] ?? [])) {
                desired.set(pos, {
                    postJson: "[]",
                    coreIds: ids,
                    tokensEst: 0,
                    active: true,
                    coverRef: null,
                });
                continue;
            }
            return noJoin();
        }
        desired.set(pos, {
            postJson: JSON.stringify(cores),
            coreIds: cores.map((c) => c.id),
            tokensEst: cores.reduce((s, c) => s + estTokens(c.id), 0),
            active: true,
            coverRef: null,
        });
    }

    // 3. Diff desired vs current → events + upserts.
    const events: SnapEvent[] = [];
    const rows: ReconcileOutput["rows"] = [];
    const preContents: ReconcileOutput["preContents"] = [];
    const isCast = currentRows.size === 0;

    for (const [pos, d] of [...desired.entries()].sort((a, b) => a[0] - b[0])) {
        const cur = currentRows.get(pos);
        if (cur === undefined) {
            // NEW row (a freshly issued pos).
            events.push({
                kind: isCast ? "cast" : "append",
                pos,
                coreIds: d.coreIds,
                evidence: isCast ? "first-load" : `new@${pos}`,
            });
            rows.push({
                pos,
                coreIds: d.coreIds,
                postJson: d.postJson,
                preJson: null,
                tokensEst: d.tokensEst,
                active: d.active,
                coverRef: d.coverRef,
            });
            continue;
        }
        // EXISTING row.
        if (d.coverRef !== null && cur.coverRef !== d.coverRef) {
            // (Re-)anchored by a block: compact. `cur.active` = first fold;
            // an already-inactive row here is a RE-FOLD (a newer block
            // absorbs the range again) → re-anchor, same event kind.
            // `d.active` honors the pinned-head exception (a pinned covered
            // row is anchored but stays in the egress).
            events.push({
                kind: "compact",
                pos,
                coreIds: d.coreIds,
                evidence: `block:${d.coverRef}`,
                blockId: d.coverRef,
            });
            rows.push({
                pos,
                coreIds: d.coreIds,
                postJson: d.postJson,
                preJson: null, // pre form is this row's own postJson (kept)
                tokensEst: d.tokensEst,
                active: d.active,
                coverRef: d.coverRef,
            });
            continue;
        }
        if (!cur.active && d.active) {
            // Re-pin: a row the earlier commit deactivated returns to the
            // egress (the model turn's pinned-head evidence now covers it —
            // the fold commit had no envelope to know it would). Same block
            // anchor, same form — only liveness flips.
            events.push({ kind: "update", pos, coreIds: d.coreIds, evidence: `repinned@${pos}` });
            rows.push({
                pos,
                coreIds: d.coreIds,
                postJson: d.postJson,
                preJson: null,
                tokensEst: d.tokensEst,
                active: true,
                coverRef: d.coverRef,
            });
            continue;
        }
        if (cur.active && !d.active && d.coverRef === null) {
            // Active → deactivated with NO block (client dropped the element):
            // delete. The pre form is the row's own postJson (kept until the
            // ckpt boundary cleans the unanchored inactive row).
            events.push({ kind: "delete", pos, coreIds: cur.coreIds, evidence: `dropped@${pos}` });
            rows.push({
                pos,
                coreIds: cur.coreIds,
                postJson: cur.postJson, // keep the pre form
                preJson: null,
                tokensEst: cur.tokensEst,
                active: false,
                coverRef: null,
            });
            continue;
        }
        // Same liveness: check whether the form changed (update) or not (no-op).
        const changed = canonicalJson(cur.postJson) !== canonicalJson(d.postJson) || cur.coverRef !== d.coverRef;
        if (changed) {
            const preHash = sha256hex(cur.postJson);
            events.push({ kind: "update", pos, coreIds: d.coreIds, evidence: `changed@${pos}`, preHash });
            preContents.push({ hash: preHash, content: cur.postJson });
            rows.push({
                pos,
                coreIds: d.coreIds,
                postJson: d.postJson,
                preJson: preHash, // CAS ref to the pre form (ruling A)
                tokensEst: d.tokensEst,
                active: d.active,
                coverRef: d.coverRef,
            });
        }
        // else: identical form → no event, no upsert (a no-op turn is free).
    }

    // Rows that are CURRENTLY active but ABSENT from the desired state (the
    // client dropped the element; not covered by any block) → delete.
    // FULL-SCOPE commits only: a fold-only commit carries the tail forward
    // (step 0), so this sweep is unreachable there — and must NOT fire, or
    // it would "delete" rows the fold has no authority over.
    if (scopeFull) {
        for (const [pos, cur] of currentRows) {
            if (!desired.has(pos) && cur.active) {
                events.push({ kind: "delete", pos, coreIds: cur.coreIds, evidence: `dropped@${pos}` });
                rows.push({
                    pos,
                    coreIds: cur.coreIds,
                    postJson: cur.postJson,
                    preJson: null,
                    tokensEst: cur.tokensEst,
                    active: false,
                    coverRef: null,
                });
            }
        }
    }

    // 4. Checkpoint: on a fold, or at the cadence.
    let ckpt: ReconcileOutput["ckpt"];
    const foldNow = input.foldedThisTurn || (turnCount > 0 && turnCount % ckptEveryNTurns === 0);
    if (foldNow) {
        const activeRows = [...desired.entries()]
            .filter(([, d]) => d.active)
            .map(([pos, d]) => ({ pos, postJson: d.postJson }));
        const s4 = s4Aggregate(activeRows);
        const coverage: CheckpointMeta["coverage"] = {};
        for (const b of blockPos) {
            if (b.pos.length === 0) continue;
            coverage[String(b.pos[0])] = { lo: b.pos[0]!, hi: b.pos[b.pos.length - 1]!, blockId: b.blockId };
        }
        const meta: CheckpointMeta = {
            v: 1,
            kernelState: input.kernelState,
            stateChecksum: stateChecksum(input.kernelState),
            coverage,
            s4,
        };
        ckpt = { meta, s4 };
    }

    return { events, rows, preContents, ckpt, joinOk: true };
}

function noJoin(): ReconcileOutput {
    return { events: [], rows: [], preContents: [], joinOk: false };
}

/** A cheap, deterministic token estimate for a core (diagnostic + the
 *  tokens_est column, ruling L). The exact host tokenizer is a metering
 *  concern; the column only needs a stable growth signal, so we charge the
 *  id length (a lower bound that never moves with client churn). */
function estTokens(id: string): number {
    return Math.max(1, Math.ceil(id.length / 4));
}

// Re-exported for the audit/observability stream (grep-able sentinels).
export { sha256hex, canonicalJson, s4Aggregate };
