import type { SessionStore } from "./persist.js";

/**
 * #5312 D2 — host-side sweep for "foreign" fold blocks that linger forever in
 * a parent session after the ≤v0.1.208 shared-parent-id era ended.
 *
 * A fold block created under another session but persisted under THIS session
 * id keeps re-rendering into this session's outbound wire every turn once any
 * covered message id collides with the transcript (content-hash ids make shared
 * file reads collide) — see kernel/src/sync.ts stillPresent. Two existing
 * mechanisms miss it: the zombie-reap e-gate never accrues for a block whose
 * covered ids were never on the wire, and orphan-gc only reaps FULL wire-orphans
 * (a single collision resets its streak).
 *
 * This sweep judges membership against the PERSISTED TRANSCRIPT (every message
 * row ever ingested, live AND retired — retire-don't-delete #4390 guarantees a
 * legitimate fold's covered rows always survive here), not the current wire.
 * A block whose covered ids have ZERO intersection with the transcript is
 * provably foreign and safe to archive; one with ANY intersection has a real
 * tie (or an undecidable collision) and is left alone for option B (kernel
 * lineage field). Policy lives here, out of the storage engine.
 */

interface ForeignBlockFinding {
    sessionId: string;
    blockId: string;
    tier: number;
    active: boolean;
    coveredCount: number;
    overlap: number;
    status: "archivable" | "collision" | "no-covered";
}

export interface ForeignBlockPlan {
    scannedSessions: number;
    skippedEmptyTranscript: number;
    archivable: ForeignBlockFinding[];
    collision: ForeignBlockFinding[];
    noCovered: ForeignBlockFinding[];
}

interface ForeignBlockApplyResult {
    archived: ForeignBlockFinding[];
    failed: { finding: ForeignBlockFinding; reason?: string }[];
}

/** base id = everything before the first '#' (mirrors kernel/src/prune.ts).
 *  A covered id may be re-encoded across model switches (#4834); matching on
 *  the base keeps membership judgment stable while staying conservative. */
const baseId = (id: string): string => {
    const h = id.indexOf("#");
    return h > 0 ? id.substring(0, h) : id;
};

/** Enumerate every persisted session's fold blocks and classify each by how
 *  many of its covered ids ever belonged to that session's transcript. Null
 *  when the unified store is unavailable. Read-only: mutates nothing. */
export function scanForeignBlocks(store: SessionStore): ForeignBlockPlan | null {
    const ids = store.unifiedListSessionIds();
    if (!ids) return null;
    const plan: ForeignBlockPlan = { scannedSessions: 0, skippedEmptyTranscript: 0, archivable: [], collision: [], noCovered: [] };
    for (const sid of ids) {
        const histIds = store.unifiedAllMessageIds(sid);
        if (!histIds) continue; // per-session availability gap: skip, don't guess
        if (histIds.length === 0) {
            // No transcript rows at all — an empty/ambiguous lane. We CANNOT
            // distinguish "genuinely foreign" from "transcript simply absent",
            // so we refuse to act: mass-archiving on an empty set would be a
            // catastrophic false-positive. Count and move on.
            plan.skippedEmptyTranscript += 1;
            continue;
        }
        const blocks = store.unifiedGetBlocks(sid);
        if (!blocks) continue;
        plan.scannedSessions += 1;
        const histSet = new Set(histIds);
        const histBaseSet = new Set(histIds.map(baseId));
        for (const b of blocks) {
            let eff: unknown;
            try { eff = JSON.parse(b.payloadJson)?.effectiveMessageIds; } catch { eff = undefined; }
            if (!Array.isArray(eff)) {
                plan.noCovered.push({ sessionId: sid, blockId: b.blockId, tier: b.tier, active: b.active, coveredCount: 0, overlap: 0, status: "no-covered" });
                continue;
            }
            const covered = eff.filter((x): x is string => typeof x === "string");
            if (covered.length === 0) {
                // Empty coverage cannot prove membership either way — never
                // archive on absence-of-evidence.
                plan.noCovered.push({ sessionId: sid, blockId: b.blockId, tier: b.tier, active: b.active, coveredCount: 0, overlap: 0, status: "no-covered" });
                continue;
            }
            const overlap = covered.filter((id) => histSet.has(id) || histBaseSet.has(baseId(id))).length;
            const finding: ForeignBlockFinding = {
                sessionId: sid,
                blockId: b.blockId,
                tier: b.tier,
                active: b.active,
                coveredCount: covered.length,
                overlap,
                status: overlap === 0 ? "archivable" : "collision",
            };
            (overlap === 0 ? plan.archivable : plan.collision).push(finding);
        }
    }
    return plan;
}

/** Reversibly archive every 'archivable' finding (zero-overlap foreign block).
 *  Collision / no-covered findings are deliberately untouched — they need the
 *  kernel lineage field (option B), not host-side guessing. Null when the
 *  store is unavailable. */
export function applyForeignBlockSweep(store: SessionStore, plan: ForeignBlockPlan, archiveDir?: string): ForeignBlockApplyResult | null {
    const result: ForeignBlockApplyResult = { archived: [], failed: [] };
    for (const f of plan.archivable) {
        const r = store.unifiedArchiveBlock(f.sessionId, f.blockId, archiveDir);
        if (r && r.ok) result.archived.push(f);
        else result.failed.push({ finding: f, reason: r?.reason });
    }
    return result;
}
