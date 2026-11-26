// #3301: stored-decomposition source for fold-anchor backfill.
//
// Anchors persisted before turn keys existed (pre-#2644) carry no p/x, and the
// wire-side backfill can only fire while the old id is still on the wire — a
// wire-shape flip (host metadata refresh re-serializing every past thinking
// turn) puts it off the wire forever — and the flip pass is the LAST pass in
// which those ids sit in the order backbone (claims only iterate backbone ids).
// This module pulls those ids' original message decompositions out of the
// unified index (full mode only) so reconcileFoldCoverage can rebuild p/x
// BEFORE its plan runs and the flip pass itself claims. Ids absent from the index are
// marked tried once (absence is stable for folded-out history); an UNAVAILABLE
// index is not marked tried (it may appear later).

import type { CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";
import { getStore } from "./persist.js";
import { log as loggerLog } from "./logger.js";
import { METADATA_ANCHORS, type FoldAnchor } from "./fold-reconcile.js";

export interface StoredRow {
    seq: number;
    msgId: string;
    content: string;
}

interface DecompositionSource {
    /** null = no index available (legacy/shadow/degraded); [] = index has none of them. */
    rows(sessionId: string, msgIds: readonly string[]): StoredRow[] | null;
}

const MAX_LOOKUP_PER_PASS = 256;
const TRIED_METADATA_KEY = "foldStoredTried";
const MAX_TRIED = 8192;

function defaultSource(): DecompositionSource {
    return {
        rows(sessionId, msgIds) {
            try {
                return getStore().unifiedMessageRows(sessionId, msgIds);
            } catch (err) {
                loggerLog("warn", `[fold-reconcile] stored decomposition lookup failed: ${String(err)}`);
                return null;
            }
        },
    };
}

/** Wire-site convenience: build the wire-id set and run the lookup in one
 *  call (used by all four prepare-* lanes). */
export function storedMessagesFor(session: Session, sessionId: string, msgs: readonly CoreMessage[]): CoreMessage[] | undefined {
    const wireIds = new Set<string>();
    for (const m of msgs) if (m.id !== undefined) wireIds.add(m.id);
    return resolveStoredDecompositions(session, sessionId, wireIds);
}

/** #5142: raw-row source for the expected-rebase backfill — fold-reconcile
 *  needs the ORIGINAL bytes of missing covered ids (carrier classification,
 *  inline-image evidence), not a pre-filtered decomposition, so it gets the
 *  uninterpreted StoredRow stream back. Same null/[] contract as
 *  DecompositionSource.rows. Callback shape keeps fold-reconcile storage-free
 *  for unit fakes; tests inject their own source. */
export function storedRowLookupFor(
    sessionId: string,
    source: DecompositionSource = defaultSource(),
): (msgIds: readonly string[]) => StoredRow[] | null {
    return (msgIds) => source.rows(sessionId, msgIds);
}

export function resolveStoredDecompositions(
    session: Session,
    sessionId: string,
    wireIds: ReadonlySet<string>,
    source: DecompositionSource = defaultSource(),
): CoreMessage[] | undefined {
    const metadata = session.metadata;
    if (metadata === undefined) return undefined;
    const anchors = (metadata[METADATA_ANCHORS] as Record<string, FoldAnchor> | undefined) ?? {};
    const anchorIds = Object.keys(anchors);
    if (anchorIds.length === 0) return undefined;
    const tried = (metadata[TRIED_METADATA_KEY] as Record<string, number> | undefined) ?? {};
    const needed: string[] = [];
    for (const id of anchorIds) {
        const a = anchors[id];
        if (a.p !== undefined || a.r !== "assistant" || a.t !== undefined) continue;
        if (wireIds.has(id)) continue;
        if (tried[id] !== undefined) continue;
        needed.push(id);
        if (needed.length >= MAX_LOOKUP_PER_PASS) break;
    }
    if (needed.length === 0) return undefined;
    const rows = source.rows(sessionId, needed);
    if (rows === null) return undefined; // index unavailable: retry next pass
    for (const id of needed) tried[id] = 1;
    const pruned: Record<string, number> = {};
    let n = 0;
    for (const [id, v] of Object.entries(tried)) {
        if (!anchors[id]) continue;
        pruned[id] = v;
        if (++n >= MAX_TRIED) break;
    }
    metadata[TRIED_METADATA_KEY] = pruned;
    // Latest seq per id wins (edits append rows); neighbors stay in so rc
    // pairs keep adjacency for turn-key derivation. Unparseable rows are
    // auxiliary-evidence misses, not errors — count them, don't throw.
    let skipped = 0;
    const latestSeq = new Map<string, number>();
    const ordered: { seq: number; m: CoreMessage }[] = [];
    for (const row of rows) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.content);
        } catch {
            skipped++;
            continue;
        }
        if (typeof parsed !== "object" || parsed === null) {
            skipped++;
            continue;
        }
        const m = parsed as CoreMessage;
        if (typeof m.id !== "string" || typeof m.role !== "string") {
            skipped++;
            continue;
        }
        const prev = latestSeq.get(row.msgId);
        if (prev !== undefined && prev >= row.seq) continue;
        latestSeq.set(row.msgId, row.seq);
        // Replace any earlier decomposition of the same msg id in place. The
        // old index-bookkeeping (splice + cached indices) went stale the
        // moment one splice shifted later entries — a second duplicate then
        // removed the WRONG element (or none) and left both copies in.
        for (let i = ordered.length - 1; i >= 0; i--) {
            if (ordered[i]!.m.id === m.id) {
                ordered.splice(i, 1);
                break;
            }
        }
        ordered.push({ seq: row.seq, m });
    }
    if (skipped > 0) loggerLog("debug", `[fold-reconcile] stored decomposition: ${skipped} unparseable row(s) skipped`);
    if (ordered.length === 0) return undefined;
    ordered.sort((a, b) => a.seq - b.seq);
    return ordered.map((o) => o.m);
}
