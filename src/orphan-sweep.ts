// #5308 (D2) — sweep provably-foreign collapsed blocks out of upgraded legacy
// sessions.
//
// A collapsed block committed under a SHARED conversation id during the
// <=v0.1.208 era can reappear forever in the parent session after an upgrade:
// its covered substrate was never part of the parent's durable record, so the
// #2695 e-gate exemption ("never-present substrate never accrues a death
// streak") gives it permanent shelter, while the render side (kernel sync.ts
// stillPresent) keeps it active whenever ANY covered id happens to collide with
// a message the parent actually read. No existing wire-side path reaps it
// (orphan-gc only looks at the CURRENT wire, where those collisions land).
//
// The discriminator here is STORE presence, which is independent of wire
// presence: a block whose covered ids have ZERO overlap with the session's
// unified-store transcript rows could never have been folded out of THIS
// session, so it is provably foreign. Legit folds always retain their covered
// rows (active OR retired — rewind/prune retire, never delete), so they are
// never swept. This is the safe half of option A from #5308; option B (blocks
// carry creation-time conversation-key lineage) is a separate kernel-side item.
//
// Dry-run by default; --fix archives via a metadata-backed exclusion list that
// buildSession honors on load (reversible, no kstate rewrite).

import { baseIdOf } from "acp-kernel";
import type { SessionStore } from "./persist.js";
import type { Session } from "./session.js";
import { log as loggerLog } from "./logger.js";

export interface OrphanBlockFinding {
    sessionId: string;
    blockId: string;
    coveredCount: number;
    /** First few covered base ids, for reporting. */
    coveredSample: string[];
}

export interface OrphanSweepPlan {
    storageMode: "full" | "shadow" | "legacy";
    /** True only when --fix can durably apply (full unified storage). */
    performable: boolean;
    /** Sessions that had >=1 unified transcript row and were scanned. */
    scannedSessions: number;
    /** Sessions skipped because they have no unified transcript (criterion vacuous). */
    skippedNoTranscript: number;
    findings: OrphanBlockFinding[];
}

export interface OrphanSweepResult {
    plan: OrphanSweepPlan;
    dryRun: boolean;
    sweptBlocks: number;
    touchedSessions: number;
    errors: string[];
    lines: string[];
}

async function scan(store: SessionStore, loaded: Map<string, Session>): Promise<OrphanSweepPlan> {
    const full = store.unifiedReads();
    const replicas = store.replicasAvailable();
    const storageMode: OrphanSweepPlan["storageMode"] = full ? "full" : replicas ? "shadow" : "legacy";
    if (!replicas) {
        return { storageMode, performable: false, scannedSessions: 0, skippedNoTranscript: 0, findings: [] };
    }
    const findings: OrphanBlockFinding[] = [];
    let scanned = 0;
    let skipped = 0;
    for (const [id, session] of loaded) {
        const msgIds = store.unifiedSessionTranscriptMsgIds(id);
        // No unified transcript -> the zero-overlap criterion is vacuous (every
        // block would look orphan). Skip rather than false-positive.
        if (!msgIds || msgIds.length === 0) {
            skipped++;
            continue;
        }
        scanned++;
        const transcriptBases = new Set<string>();
        for (const mid of msgIds) transcriptBases.add(baseIdOf(mid));
        const blocks = session.state?.blocks;
        if (!blocks || blocks.length === 0) continue;
        for (const block of blocks) {
            const covered = block.effectiveMessageIds;
            if (!covered || covered.length === 0) continue;
            if (!block.active) continue;
            let intersect = 0;
            for (const cid of covered) {
                if (transcriptBases.has(baseIdOf(cid))) intersect++;
            }
            if (intersect > 0) continue;
            findings.push({
                sessionId: id,
                blockId: block.blockId,
                coveredCount: covered.length,
                coveredSample: covered.slice(0, 6).map((x) => baseIdOf(x)),
            });
        }
    }
    return { storageMode, performable: full, scannedSessions: scanned, skippedNoTranscript: skipped, findings };
}

/** Read-only detection: every active block whose covered ids have zero overlap
 *  with its own session's unified-store transcript. Never mutates. */
export async function detectOrphanBlocks(store: SessionStore): Promise<OrphanSweepPlan> {
    const loaded = await store.loadAll();
    return scan(store, loaded);
}

/** Detect, then (unless dryRun) durably archive the orphans via the metadata
 *  exclusion list. dryRun defaults to true — mutation requires an explicit
 * `dryRun: false` AND full-mode storage. Optionally scoped to one session. */
export async function applyOrphanSweep(
    store: SessionStore,
    opts: { dryRun?: boolean; sessionId?: string },
): Promise<OrphanSweepResult> {
    const dryRun = opts.dryRun !== false;
    const loaded = await store.loadAll();
    let plan = await scan(store, loaded);
    if (opts.sessionId) {
        plan = { ...plan, findings: plan.findings.filter((f) => f.sessionId === opts.sessionId) };
    }
    const lines: string[] = [];
    const errors: string[] = [];

    if (plan.findings.length === 0) {
        lines.push(
            `scanned ${plan.scannedSessions} session(s) with a unified transcript (${plan.storageMode}); ` +
                `${plan.skippedNoTranscript} skipped (no unified transcript); no provably-orphan blocks found`,
        );
        return { plan, dryRun, sweptBlocks: 0, touchedSessions: 0, errors, lines };
    }

    if (dryRun) {
        for (const f of plan.findings) {
            lines.push(`[dry-run] ${f.sessionId} :: ${f.blockId} covers ${f.coveredCount} id(s), zero overlap with this session's transcript [${f.coveredSample.join(", ")}]`);
        }
        lines.push(`dry run only - nothing changed. Re-run with --fix to archive ${plan.findings.length} orphan block(s).`);
        return { plan, dryRun: true, sweptBlocks: 0, touchedSessions: 0, errors, lines };
    }

    if (!plan.performable) {
        for (const f of plan.findings) lines.push(`[blocked] ${f.sessionId} :: ${f.blockId} (covers ${f.coveredCount})`);
        lines.push('storage is not in "full" mode - cannot durably archive here. Enable full unified storage (storage.unified=full / BILI_STORAGE_UNIFIED=full) and re-run --fix.');
        return { plan, dryRun: false, sweptBlocks: 0, touchedSessions: 0, errors: ["not performable: storage not in full mode"], lines };
    }

    const bySession = new Map<string, OrphanBlockFinding[]>();
    for (const f of plan.findings) {
        const arr = bySession.get(f.sessionId) ?? [];
        arr.push(f);
        bySession.set(f.sessionId, arr);
    }
    let swept = 0;
    const touched = new Set<string>();
    const now = Date.now();
    for (const [sid, fs] of bySession) {
        const session = loaded.get(sid);
        if (!session) {
            errors.push(`${sid}: session vanished between scan and apply`);
            continue;
        }
        try {
            const curMeta: Record<string, unknown> =
                session.metadata && typeof session.metadata === "object" ? { ...(session.metadata as Record<string, unknown>) } : {};
            const prevRaw = curMeta.orphanExcludedBlocks;
            const prev: Record<string, unknown> =
                prevRaw && typeof prevRaw === "object" && !Array.isArray(prevRaw) ? { ...(prevRaw as Record<string, unknown>) } : {};
            for (const f of fs) {
                prev[f.blockId] = { at: now, reason: `#5308 orphan sweep: ${f.coveredCount} covered id(s), zero transcript overlap` };
            }
            curMeta.orphanExcludedBlocks = prev;
            store.setUnifiedSessionMetadataJson(sid, JSON.stringify(curMeta));
            touched.add(sid);
            swept += fs.length;
            for (const f of fs) lines.push(`[archived] ${sid} :: ${f.blockId} (covers ${f.coveredCount} id(s), zero transcript overlap)`);
            loggerLog("info", `[orphan-sweep] ${sid}: archived ${fs.length} orphan block(s): ${fs.map((f) => f.blockId).join(", ")}`);
        } catch (err) {
            const detail = /SQLITE_BUSY|database is locked/i.test(String(err))
                ? "database busy (another bili instance holds index.db)"
                : String(err);
            errors.push(`${sid}: ${detail}`);
            lines.push(`[error] ${sid}: could not persist exclusion - ${detail}`);
        }
    }
    lines.push(`applied: archived ${swept} orphan block(s) across ${touched.size} session(s); takes effect on next load/restart of each affected client.`);
    return { plan, dryRun: false, sweptBlocks: swept, touchedSessions: touched.size, errors, lines };
}
