/**
 * `bili sessions …` / `bili storage gc` — CLI plumbing over the existing
 * persistence + #3911 store maintenance APIs. No new store semantics: every
 * mutation here is the same call the HTTP surface makes (admin.ts), so the
 * two lanes stay structurally identical.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "./persist.js";
import type { GcPlan } from "./storage/store.js";
import { fileStorageArchiveAfterDays, resolveArchiveAfterDays } from "./knobs.js";
import { scanForeignBlocks, applyForeignBlockSweep, type ForeignBlockPlan } from "./foreign-block-sweep.js";

interface StorageCommandResult {
    code: number;
    text: string;
}

interface LsRow {
    id: string;
    label: string;
    sizeBytes: number;
    lastUpdated: number;
    status: string;
}

const UNIFIED_REQUIRED = "requires the unified store — start this instance with BILI_STORAGE_UNIFIED=shadow|full (or storage.unified in the config file)";

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KiB", "MiB", "GiB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(1)} ${units[i]}`;
}

function fmtDate(ts: number): string {
    return `${new Date(ts).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function renderTable(headers: string[], rows: string[][]): string {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function indexDbSize(dir: string): number | undefined {
    const p = join(dir, "index.db");
    if (!existsSync(p)) return undefined;
    try {
        return statSync(p).size;
    } catch {
        return undefined;
    }
}

// Decoded-bytes idiom (#2803): codec-decoded length of the session's files,
// not raw stat size — framed (encrypted/zstd) files would otherwise report
// framing overhead instead of content.
async function sessionSizeBytes(store: SessionStore, id: string, meta: { protocol?: string; upstreamOrigin?: string }): Promise<number> {
    let total = 0;
    for (const rel of await store.findSessionFiles(id, meta)) {
        const abs = join(store.dir, rel);
        const b = await store.decodedBytesOf(abs);
        if (b !== null) total += b;
        if (rel.endsWith(".json") && !rel.endsWith(".fb.json")) {
            const paired = join(store.dir, `${rel.slice(0, -".json".length)}.content-store.json`);
            if (existsSync(paired)) {
                const pb = await store.decodedBytesOf(paired);
                if (pb !== null) total += pb;
            }
        }
    }
    return total;
}

function fail(text: string, json?: boolean, data?: Record<string, unknown>): StorageCommandResult {
    if (json) return { code: 1, text: `${JSON.stringify(data ?? {}, null, 2)}\n` };
    return { code: 1, text: `${text}\n` };
}

async function runLs(store: SessionStore, json: boolean): Promise<StorageCommandResult> {
    const loaded = await store.loadAll();
    const dbRows = new Map<string, { status: string; updatedAt: number; label?: string }>();
    for (const r of store.unifiedWebSummaries() ?? []) {
        dbRows.set(r.sessionId, { status: r.status, updatedAt: r.updatedAt, label: r.label });
    }
    const rows: LsRow[] = [];
    for (const [id, s] of loaded) {
        const d = dbRows.get(id);
        let size = await sessionSizeBytes(store, id, s.meta);
        if (size === 0 && store.replicasAvailable()) {
            // File-less row (deleted JSON, index-only survivor, #2960 R2.1):
            // report the honest DB footprint instead of a misleading 0.
            const st = store.unifiedSessionStorageStats(id);
            if (st) size = st.inlineBytes + st.casExclusiveBytes;
        }
        rows.push({
            id,
            label: s.meta.label ?? d?.label ?? "",
            sizeBytes: size,
            lastUpdated: Math.max(s.lastSeen, d?.updatedAt ?? 0),
            status: d?.status ?? "active",
        });
    }
    rows.sort((a, b) => b.lastUpdated - a.lastUpdated || a.id.localeCompare(b.id));
    if (json) return { code: 0, text: `${JSON.stringify(rows, null, 2)}\n` };
    if (rows.length === 0) return { code: 0, text: "no sessions found\n" };
    return {
        code: 0,
        text: `${renderTable(["ID", "LABEL", "SIZE", "LAST-UPDATED", "STATUS"], rows.map((r) => [r.id, r.label, formatBytes(r.sizeBytes), fmtDate(r.lastUpdated), r.status]))}\n`,
    };
}

async function runRm(store: SessionStore, target: string | undefined, json: boolean, noVacuum: boolean): Promise<StorageCommandResult> {
    if (!target) return fail("usage: bili sessions rm <id>", json);
    const unified = store.replicasAvailable();
    const stats = unified ? store.unifiedSessionStorageStats(target) : null;
    const files = (await store.findSessionFiles(target)).length;
    const dbBefore = indexDbSize(store.dir);
    const res = await store.removeSession(target);
    if (!res.envelopeFound && !res.unifiedHadRows) {
        return fail(`no session found: ${target}`, json, { id: target, found: false });
    }
    let vacuumed = false;
    let vacuumNote: string | undefined;
    if (!noVacuum && unified) {
        try {
            store.unifiedVacuum("full");
            vacuumed = true;
        } catch (err) {
            // VACUUM lost the SQLITE_BUSY race (another bili instance holds
            // the db): the deletion itself is committed — say so, don't lose it.
            const detail = /SQLITE_BUSY|database is locked/i.test(String(err)) ? "database busy" : String(err);
            vacuumNote = `shrink skipped (${detail}) — deletion committed; freed pages return on the next gc/vacuum`;
        }
    }
    const dbAfter = indexDbSize(store.dir);
    const dbRowsReleased = stats ? Object.values(stats.rows).reduce((a, b) => a + b, 0) : null;
    const dbBytesReleased = stats ? stats.inlineBytes + stats.casExclusiveBytes : null;
    const data = { id: target, filesRemoved: files, dbRowsReleased, dbBytesReleased, indexDbBefore: dbBefore, indexDbAfter: dbAfter, vacuumed, vacuumNote };
    if (json) return { code: 0, text: `${JSON.stringify(data, null, 2)}\n` };
    const lines = [`removed session ${target}`, `  files on disk:      ${files}`];
    if (stats) lines.push(`  index.db released:  ${dbRowsReleased} rows, ${formatBytes(dbBytesReleased!)}`);
    if (dbBefore !== undefined && dbAfter !== undefined) lines.push(`  index.db size:      ${formatBytes(dbBefore)} -> ${formatBytes(dbAfter)}`);
    if (vacuumNote) lines.push(`  warning:              ${vacuumNote}`);
    else if (vacuumed) lines.push("  vacuum:             done");
    return { code: 0, text: `${lines.join("\n")}\n` };
}

async function runArchive(store: SessionStore, target: string | undefined, json: boolean): Promise<StorageCommandResult> {
    if (!target) return fail("usage: bili sessions archive <id>", json);
    if (!store.replicasAvailable()) return fail(`sessions archive ${UNIFIED_REQUIRED}`, json, { id: target, ok: false });
    const res = store.unifiedArchiveSession(target);
    if (!res || !res.ok) return fail(`archive failed for ${target}: ${res?.reason ?? "unknown"}`, json, { id: target, ok: false, reason: res?.reason });
    const data = { id: target, ok: true, exportPath: res.exportPath, contentRowsDeleted: res.contentRowsDeleted };
    if (json) return { code: 0, text: `${JSON.stringify(data, null, 2)}\n` };
    return {
        code: 0,
        text: [`archived ${target}`, `  archive log entry:  ${res.exportPath}`, `  content rows released: ${res.contentRowsDeleted ?? "?"}`].join("\n") + "\n",
    };
}

async function runRestore(store: SessionStore, target: string | undefined, json: boolean): Promise<StorageCommandResult> {
    if (!target) return fail("usage: bili sessions restore <id>", json);
    if (!store.replicasAvailable()) return fail(`sessions restore ${UNIFIED_REQUIRED}`, json, { id: target, ok: false });
    const res = store.unifiedRestoreArchived(target);
    if (!res || !res.ok) return fail(`restore failed for ${target}: ${res?.reason ?? "not found"}`, json, { id: target, ok: false, reason: res?.reason });
    if (json) return { code: 0, text: `${JSON.stringify({ id: target, ok: true }, null, 2)}\n` };
    return { code: 0, text: `restored ${target}\n` };
}

function renderPlan(plan: GcPlan, days: number, vacuum: "full" | "incremental"): string {
    const lines = [`storage gc sweep plan (archiveAfterDays=${days}, vacuum=${vacuum})`];
    lines.push(`  age cutoff:       ${plan.cutoff === null ? "off (no age sweep)" : fmtDate(plan.cutoff)}`);
    if (plan.candidates.length === 0) {
        lines.push("  sessions to archive: none past the cutoff");
    } else {
        lines.push(`  sessions to archive: ${plan.candidates.length}`);
        for (const c of plan.candidates) {
            lines.push(`    ${c.sessionId}${c.label ? `  (${c.label})` : ""}  updated ${fmtDate(c.updatedAt)}`);
        }
    }
    lines.push(`  zero-ref content: ${plan.zeroRefRows} rows, ${formatBytes(plan.zeroRefBytes)}`);
    lines.push(`  est. pages reclaimable: ~${Math.ceil(plan.zeroRefBytes / plan.pageSize)} (page_size=${plan.pageSize})`);
    return lines.join("\n");
}

async function runGc(store: SessionStore, days: number | undefined, vacuum: "full" | "incremental" | undefined, dryRun: boolean, json: boolean): Promise<StorageCommandResult> {
    if (!store.replicasAvailable()) return fail(`storage gc ${UNIFIED_REQUIRED}`, json);
    const effectiveDays = days ?? resolveArchiveAfterDays(undefined, fileStorageArchiveAfterDays());
    const plan = store.unifiedGcPlan(effectiveDays);
    if (!plan) return fail("storage gc failed: cannot read the sweep plan (see log)", json);
    const vacuumMode = vacuum ?? "full";
    const data: Record<string, unknown> = {
        dryRun,
        archiveAfterDays: effectiveDays,
        vacuum: vacuumMode,
        plan: {
            cutoff: plan.cutoff,
            candidates: plan.candidates,
            zeroRefRows: plan.zeroRefRows,
            zeroRefBytes: plan.zeroRefBytes,
            pageSize: plan.pageSize,
        },
    };
    let text = renderPlan(plan, effectiveDays, vacuumMode);
    if (dryRun) {
        if (json) return { code: 0, text: `${JSON.stringify(data, null, 2)}\n` };
        return { code: 0, text: `${text}\ndry-run: nothing executed\n` };
    }
    // #4612: full VACUUM is an O(db-size) atomic rewrite under the exclusive
    // write lock with no intermediate progress — running it while another live
    // process (e.g. a running proxy) writes the same db starves that process
    // until its storage layer degrades. Refuse with an actionable message;
    // incremental / no-vacuum sweeps are short transactions and stay allowed.
    if (vacuumMode === "full") {
        const writer = store.unifiedActiveWriter();
        if (writer !== null) {
            data.refused = true;
            data.writerPid = writer;
            const reason = `refused: another process (pid ${writer}) is actively writing index.db — 'storage gc --vacuum full' rewrites the whole database under an exclusive write lock (minutes on large dbs, no intermediate progress) and would starve the other instance's writes until its storage layer degrades. Stop the other process (or wait for it to exit) and retry, or use --vacuum incremental for an online-safe shrink.`;
            if (json) return { code: 1, text: `${JSON.stringify(data, null, 2)}\n` };
            return fail(`${text}\n${reason}`, json, data);
        }
    }
    const dbBefore = indexDbSize(store.dir);
    // Same facade call the HTTP endpoint makes (admin.ts POST /__bili/storage/gc)
    // — results are therefore comparable lane-for-lane.
    const result = store.unifiedGc({ archiveAfterDays: effectiveDays, vacuum: vacuumMode });
    if (!result) return fail("storage gc failed mid-run (see log)", json, data);
    const dbAfter = indexDbSize(store.dir);
    data.result = result;
    data.indexDbBefore = dbBefore;
    data.indexDbAfter = dbAfter;
    if (json) return { code: 0, text: `${JSON.stringify(data, null, 2)}\n` };
    text += `\nexecuted:\n  archived sessions:    ${result.archived}\n  content rows deleted: ${result.contentRowsDeleted}`;
    if (dbBefore !== undefined && dbAfter !== undefined) text += `\n  index.db size:        ${formatBytes(dbBefore)} -> ${formatBytes(dbAfter)}`;
    return { code: 0, text: `${text}\n` };
}

function renderForeignPlan(plan: ForeignBlockPlan): string {
    const lines = [`foreign fold-block sweep (judged against each session's full persisted transcript)`];
    lines.push(`  sessions scanned:          ${plan.scannedSessions}${plan.skippedEmptyTranscript > 0 ? ` (+${plan.skippedEmptyTranscript} skipped: empty transcript)` : ""}`);
    lines.push(`  archivable (zero overlap): ${plan.archivable.length}`);
    lines.push(`  collision (needs option B):${plan.collision.length}`);
    lines.push(`  no-covered (undecidable):  ${plan.noCovered.length}`);
    if (plan.archivable.length > 0) {
        lines.push("");
        lines.push(renderTable(["SESSION", "BLOCK", "TIER", "ACTIVE", "COVERED"], plan.archivable.map((f) => [f.sessionId, f.blockId, String(f.tier), f.active ? "yes" : "no", String(f.coveredCount)])));
    }
    if (plan.collision.length > 0) {
        lines.push("");
        lines.push("collision blocks (NOT archived — covered ids intersect the transcript; needs the kernel lineage field, option B):");
        for (const f of plan.collision.slice(0, 50)) lines.push(`    ${f.sessionId} / ${f.blockId}  overlap=${f.overlap}/${f.coveredCount}`);
        if (plan.collision.length > 50) lines.push(`    … and ${plan.collision.length - 50} more`);
    }
    return lines.join("\n");
}

async function runForeignBlocks(store: SessionStore, json: boolean, apply: boolean, restoreTarget?: string): Promise<StorageCommandResult> {
    if (!store.replicasAvailable()) return fail(`sessions foreign-blocks ${UNIFIED_REQUIRED}`, json);
    if (restoreTarget) {
        // Split on the LAST colon so a session id that itself contains ":" still parses;
        // block ids are plain (bNN) and never carry a colon.
        const sep = restoreTarget.lastIndexOf(":");
        if (sep <= 0) return fail("usage: bili sessions foreign-blocks --restore <sessionId>:<blockId>", json);
        const sid = restoreTarget.slice(0, sep);
        const bid = restoreTarget.slice(sep + 1);
        const res = store.unifiedRestoreBlock(sid, bid);
        if (!res || !res.ok) return fail(`block restore failed for ${sid}:${bid}: ${res?.reason ?? "not found"}`, json, { sessionId: sid, blockId: bid, ok: false, reason: res?.reason });
        if (json) return { code: 0, text: `${JSON.stringify({ sessionId: sid, blockId: bid, ok: true }, null, 2)}\n` };
        return { code: 0, text: `restored block ${bid} into session ${sid}\n` };
    }
    const plan = scanForeignBlocks(store);
    if (!plan) return fail("foreign-block sweep failed: unified store unavailable", json);
    const data: Record<string, unknown> = { dryRun: !apply, ...plan };
    let text = renderForeignPlan(plan);
    if (!apply) {
        if (json) return { code: 0, text: `${JSON.stringify(data, null, 2)}\n` };
        return { code: 0, text: `${text}\ndry-run: nothing executed (re-run with --apply to archive)\n` };
    }
    const result = applyForeignBlockSweep(store, plan);
    if (!result) return fail("foreign-block sweep failed mid-run (see log)", json, data);
    data.result = result;
    if (json) return { code: 0, text: `${JSON.stringify(data, null, 2)}\n` };
    text += `\nexecuted:\n  archived blocks:      ${result.archived.length}`;
    for (const f of result.archived) text += `\n    ${f.sessionId} / ${f.blockId} (tier ${f.tier}, covered ${f.coveredCount})`;
    if (result.failed.length > 0) {
        text += `\n  failed:               ${result.failed.length}`;
        for (const f of result.failed) text += `\n    ${f.finding.sessionId} / ${f.finding.blockId}: ${f.reason ?? "unknown"}`;
    }
    text += "\nnote: takes effect on next session load/restart — a running host keeps its in-memory copy until reload";
    return { code: 0, text: `${text}\n` };
}

export async function runSessionsCommand(opts: {
    sub: "ls" | "rm" | "archive" | "restore" | "foreign-blocks";
    target?: string;
    json?: boolean;
    noVacuum?: boolean;
    apply?: boolean;
    restoreTarget?: string;
    dir?: string;
}): Promise<StorageCommandResult> {
    const store = new SessionStore({ dir: opts.dir, enabled: true });
    try {
        switch (opts.sub) {
            case "ls":
                return await runLs(store, !!opts.json);
            case "rm":
                return await runRm(store, opts.target, !!opts.json, !!opts.noVacuum);
            case "archive":
                return await runArchive(store, opts.target, !!opts.json);
            case "restore":
                return await runRestore(store, opts.target, !!opts.json);
            case "foreign-blocks":
                return await runForeignBlocks(store, !!opts.json, !!opts.apply, opts.restoreTarget);
        }
    } finally {
        store.closeQuietly();
    }
}

export async function runStorageGcCommand(opts: {
    days?: number;
    vacuum?: "full" | "incremental";
    dryRun?: boolean;
    json?: boolean;
    dir?: string;
}): Promise<StorageCommandResult> {
    let store: SessionStore;
    try {
        store = new SessionStore({ dir: opts.dir, enabled: true });
    } catch (err) {
        // #4612: a live foreign writer does NOT make the unified open refuse
        // anymore (owner decision 2026-10-31: second-writer conditions are
        // informational, never blocking) — the full-VACUUM starvation guard
        // lives in runGc itself (store.unifiedActiveWriter()), so no special
        // branch is needed here.
        throw err;
    }
    try {
        return await runGc(store, opts.days, opts.vacuum, !!opts.dryRun, !!opts.json);
    } finally {
        store.closeQuietly();
    }
}
