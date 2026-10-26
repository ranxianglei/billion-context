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

export async function runSessionsCommand(opts: {
    sub: "ls" | "rm" | "archive" | "restore";
    target?: string;
    json?: boolean;
    noVacuum?: boolean;
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
    const store = new SessionStore({ dir: opts.dir, enabled: true });
    try {
        return await runGc(store, opts.days, opts.vacuum, !!opts.dryRun, !!opts.json);
    } finally {
        store.closeQuietly();
    }
}
