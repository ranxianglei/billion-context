/**
 * `bili storage backup` / `bili storage repair` — operator tools for the
 * unified store's single most important file (index.db).
 *
 * Born from the 2026-11-20 production incident (#7156): a 3.2 GB index.db
 * proved corrupt, the process (dual-write posture) degraded to JSON
 * envelopes and served a near-empty view, and the operator's recovery
 * path was a hand-rolled `.recover`-equivalent script plus manual file
 * surgery. Those two manual moves are now first-class, verified commands:
 *
 *   bili storage backup [--keep N]
 *       Online-safe consistent snapshot of index.db via `VACUUM INTO`
 *       (unlike a full VACUUM it never rewrites the source and takes no
 *       exclusive lock — #4612 does NOT apply). The snapshot is verified
 *       with PRAGMA quick_check before it counts; older snapshots in
 *       <sessions>/backups/ are pruned to --keep (default 3).
 *
 *   bili storage repair [--from <backup.db>]
 *       With --from: the backup is verified (quick_check + sessions table),
 *       the broken index.db is quarantined IN PLACE (index.db.corrupt-<ts>,
 *       alongside its -wal/-shm and .chk verdict cache — evidence kept,
 *       nothing deleted) and the backup is COPIED in (the backup itself
 *       stays untouched).
 *       Without --from (no backup): salvage — row-by-row extraction from
 *       the corrupt file into a freshly-migrated schema, bisecting broken
 *       page ranges down to single rows and re-reading row columns
 *       individually (a corrupt overflow cell kills only its own column,
 *       the rest of the row survives). WITHOUT ROWID tables have no rowid
 *       to walk, so they are copied whole — the read on the read-only src
 *       handle throws if the table's pages are corrupt, and the write is
 *       one transaction on the fresh db (all rows land or none do). Any
 *       table the salvager cannot read is reported as skipped and counts
 *       as loss (exit 1). Same quarantine+swap+verify choreography.
 *       Read-only opens only; the corrupt file is never written to.
 *
 * Both refuse to run the swap while another live process holds
 * index.db.lock (#4175 pid discipline) — the quarantined file would be
 * stolen out from under a writer. `backup` is online by design and never
 * refuses on a live writer. Both also refuse to touch a HEALTHY index.db:
 * swapping a passing index for a possibly-older backup (or a re-salvaged
 * copy of itself) would silently discard newer sessions — the honest
 * rollback move stays a deliberate manual rename.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { sessionsDir } from "./paths.js";
import { openSqliteDatabase } from "./storage/driver.js";
import { migrateSchema, STORAGE_SCHEMA_VERSION } from "./storage/schema.js";
import { integrityCachePath } from "./storage/integrity-check.js";

interface CmdResult {
    code: number;
    text: string;
}

function fail(text: string): CmdResult {
    return { code: 1, text: `${text}\n` };
}

function fmtBytes(n: number): string {
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

function utcStamp(): string {
    // 20261121-110530 (UTC) — sortable, filesystem-safe.
    return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

// --- read-only opens (same idiom as the integrity-check worker) -----------
// Specifiers through constants: this file is bundled VERBATIM into dist,
// where scripts/check-dist-external.mjs text-scans for quoted-require forms
// (node:sqlite is not in module.builtinModules). Variable indirection is the
// sanctioned invisible path — driver.ts and integrity-check.ts do the same.
// createRequire: the dist bundle is ESM, where the global `require` does not
// exist (driver.ts:81-83 uses the identical idiom).
const require = createRequire(import.meta.url);
const SQLITE_SPEC = "node:sqlite";
const BUN_SQLITE_SPEC = "bun:sqlite";

interface RoDb {
    prepare(sql: string): {
        get(...args: unknown[]): Record<string, unknown>;
        all(...args: unknown[]): unknown[];
    };
    close(): void;
}

function openReadOnly(path: string): RoDb {
    const isBun = typeof process !== "undefined" && process.versions != null && process.versions.bun != null;
    if (isBun) {
        return new (require(BUN_SQLITE_SPEC).Database)(path, { readonly: true }) as RoDb;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return new (require(SQLITE_SPEC).DatabaseSync)(path, { readOnly: true }) as RoDb;
}

/** quick_check as a verdict: empty result = ok. A corruption-shaped THROW
 *  is a FAIL verdict (same classification as the integrity worker). */
export function quickCheckVerdict(path: string): { ok: boolean; detail: string; corrupt: boolean } {
    let db: RoDb;
    try {
        db = openReadOnly(path);
    } catch (err) {
        const m = String((err as Error)?.message ?? err);
        const c = String((err as { code?: unknown })?.code ?? "").toUpperCase();
        const corrupt = c === "SQLITE_CORRUPT" || c === "SQLITE_NOTADB" || m.includes("database disk image is malformed") || m.includes("file is not a database");
        return { ok: false, detail: m, corrupt };
    }
    try {
        const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
        const detail = rows.map((r) => String(r.quick_check ?? "")).join(" ").trim();
        // A healthy db returns the single row `ok`; a corrupt one returns
        // one error row per broken structure (never `ok`).
        return { ok: detail === "" || detail === "ok", detail, corrupt: false };
    } catch (err) {
        const m = String((err as Error)?.message ?? err);
        const c = String((err as { code?: unknown })?.code ?? "").toUpperCase();
        const corrupt = c === "SQLITE_CORRUPT" || c === "SQLITE_NOTADB" || m.includes("database disk image is malformed") || m.includes("file is not a database");
        return { ok: false, detail: m, corrupt };
    } finally {
        try {
            db.close();
        } catch {
            /* already gone */
        }
    }
}

/** #4175 pid discipline: the live foreign pid holding <db>.lock, if any.
 *  A dead pid (stale lock) or unreadable file = no live writer. */
export function liveWriterPid(dbPath: string): number | null {
    const lockPath = `${dbPath}.lock`;
    if (!existsSync(lockPath)) return null;
    try {
        const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
        if (typeof parsed.pid !== "number") return null;
        try {
            process.kill(parsed.pid, 0);
            return parsed.pid;
        } catch {
            return null; // ESRCH: stale lock
        }
    } catch {
        return null;
    }
}

function indexDbPath(dir: string): string {
    return join(dir, "index.db");
}

// --- backup -----------------------------------------------------------------

export async function runStorageBackupCommand(opts: { keep?: number; dir?: string; json?: boolean }): Promise<CmdResult> {
    const dir = opts.dir ?? sessionsDir();
    const dbPath = indexDbPath(dir);
    if (!existsSync(dbPath)) return fail(`no index.db at ${dbPath} — nothing to back up`);
    const keep = opts.keep ?? 3;
    const outDir = join(dir, "backups");
    mkdirSync(outDir, { recursive: true });
    const stamp = utcStamp();
    let outPath = join(outDir, `index-${stamp}.db`);
    for (let i = 2; existsSync(outPath); i++) outPath = join(outDir, `index-${stamp}-${i}.db`);

    const startedAt = Date.now();
    try {
        // VACUUM INTO: consistent snapshot, source untouched, no exclusive
        // lock — safe while a proxy serves the same dir (unlike `storage gc
        // --vacuum full`, which #4612 correctly keeps offline-only).
        const { db } = openSqliteDatabase(dbPath);
        try {
            db.prepare("VACUUM INTO ?").run(outPath);
        } finally {
            db.close();
        }
    } catch (err) {
        return fail(`backup failed while snapshotting ${dbPath}: ${String((err as Error)?.message ?? err)}`);
    }
    const verdict = quickCheckVerdict(outPath);
    if (!verdict.ok) {
        try {
            unlinkSync(outPath);
        } catch {
            /* report-only */
        }
        return fail(`backup ${outPath} FAILED its own quick_check (${verdict.detail}) — it was deleted; the source db was not touched`);
    }
    const size = statSync(outPath).size;

    // Retention: newest `keep` snapshots survive, oldest pruned.
    const pruned: string[] = [];
    const snapshots = readdirSync(outDir)
        .filter((f) => /^index-.*\.db$/.test(f))
        .map((f) => join(outDir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const p of snapshots.slice(keep)) {
        try {
            unlinkSync(p);
            pruned.push(p);
        } catch {
            /* report-only */
        }
    }
    const data = {
        ok: true,
        source: dbPath,
        backup: outPath,
        sizeBytes: size,
        durationMs: Date.now() - startedAt,
        quickCheck: "ok",
        keep,
        pruned,
    };
    if (opts.json) return { code: 0, text: `${JSON.stringify(data, null, 2)}\n` };
    const lines = [
        `backed up ${dbPath}`,
        `  snapshot:         ${outPath} (${fmtBytes(size)})`,
        `  duration:         ${Math.round(Date.now() - startedAt)} ms`,
        `  quick_check:      ok (verified before it counts)`,
        `  retention:        keep newest ${keep} in ${outDir}`,
    ];
    if (pruned.length > 0) lines.push(`  pruned:           ${pruned.length} older snapshot(s)`);
    return { code: 0, text: `${lines.join("\n")}\n` };
}

// --- quarantine / swap -------------------------------------------------------

function quarantine(dbPath: string, ts: string): string[] {
    const base = `${dbPath}.corrupt-${ts}`;
    const moved: string[] = [];
    const pairs: Array<[string, string]> = [
        [dbPath, base],
        [`${dbPath}-wal`, `${base}-wal`],
        [`${dbPath}-shm`, `${base}-shm`],
        [integrityCachePath(dbPath), `${base}.chk`],
    ];
    for (const [from, to] of pairs) {
        if (existsSync(from)) {
            renameSync(from, to);
            moved.push(to);
        }
    }
    return moved;
}

// --- repair ------------------------------------------------------------------

function renderTable(headers: string[], rows: string[][]): string {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function repairWithBackup(dir: string, dbPath: string, from: string, json: boolean, ts: string): CmdResult {
    if (!existsSync(from)) return fail(`no such backup file: ${from}`);
    const v = quickCheckVerdict(from);
    if (!v.ok) return fail(`refused: the backup itself failed quick_check${v.corrupt ? " (proven corrupt)" : ""} — ${v.detail}; try a different backup`);
    let sessionCount: number | null = null;
    {
        const ro = openReadOnly(from);
        try {
            const row = ro.prepare("SELECT count(*) AS n FROM sessions").get() as { n?: number };
            sessionCount = typeof row?.n === "number" ? row.n : null;
        } catch {
            sessionCount = null;
        } finally {
            ro.close();
        }
    }
    if (sessionCount === null || sessionCount === 0) return fail(`refused: the backup has no readable sessions table (${sessionCount ?? "unreadable"}) — a valid index.db always has one; try a different backup`);
    const moved = quarantine(dbPath, ts);
    copyFileSync(from, dbPath); // copy, never move — the backup stays intact
    const after = quickCheckVerdict(dbPath);
    if (!after.ok) {
        // A verified source that fails after a plain copy is a filesystem
        // problem, not a data problem — surface it loudly, leave the state.
        return fail(`the restored index.db FAILED quick_check after the copy (${after.detail}) while the backup verified clean — the backup at ${from} is still intact; investigate the filesystem, then re-run`);
    }
    const data = { ok: true, mode: "from-backup", source: from, sessionsRestored: sessionCount, quarantined: moved, note: "restart bili to pick up the restored index" };
    if (json) return { code: 0, text: `${JSON.stringify(data, null, 2)}\n` };
    const lines = [
        `restored ${dbPath} from backup ${from}`,
        `  sessions in backup: ${sessionCount}`,
        `  quick_check:        ok`,
        `  quarantined:        ${moved.join(", ")}`,
        `  backup untouched:   yes (copied, not moved)`,
        "",
        "restart bili (stop the proxy first) to pick up the restored index.",
    ];
    return { code: 0, text: `${lines.join("\n")}\n` };
}

// --- salvage (no backup) ------------------------------------------------------

interface SalvageTableReport {
    table: string;
    rowsTotal: number | null;
    rowsSalvaged: number;
    rowsLost: number;
    nulls: number;
    note?: string;
}

const SALVAGE_CHUNK = 2000;

function quoteId(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

function tableDependencyOrder(src: RoDb, tables: string[]): string[] {
    const deps = new Map<string, Set<string>>();
    for (const t of tables) {
        const parents = new Set<string>();
        try {
            for (const row of src.prepare(`PRAGMA foreign_key_list(${quoteId(t)})`).all() as Array<Record<string, unknown>>) {
                const p = row.table;
                if (typeof p === "string" && p !== t && tables.includes(p)) parents.add(p);
            }
        } catch {
            /* corrupt parent-table header: assume no deps (order is only an optimization) */
        }
        deps.set(t, parents);
    }
    const order: string[] = [];
    const done = new Set<string>();
    let progress = true;
    while (done.size < tables.length && progress) {
        progress = false;
        for (const t of tables) {
            if (done.has(t)) continue;
            const pending = [...(deps.get(t) ?? [])].some((p) => !done.has(p));
            if (!pending) {
                order.push(t);
                done.add(t);
                progress = true;
            }
        }
    }
    for (const t of tables) if (!done.has(t)) order.push(t); // cycle fallback: original order
    return order;
}

function readColumns(db: RoDb, table: string): string[] | null {
    try {
        return (db.prepare(`PRAGMA table_info(${quoteId(table)})`).all() as Array<Record<string, unknown>>)
            .map((c) => String(c.name ?? ""))
            .filter(Boolean);
    } catch {
        return null;
    }
}

/** WITHOUT ROWID tables have no rowid column to walk — `SELECT max(rowid)`
 *  throws `no such column: rowid` on them, which is a STRUCTURAL property,
 *  not corruption. Detected from the DDL in sqlite_master (the same source
 *  the table list comes from), not from error-text matching. */
function isWithoutRowid(src: RoDb, table: string): boolean {
    try {
        const r = src.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
        return typeof r?.sql === "string" && /WITHOUT ROWID/i.test(r.sql);
    } catch {
        return false;
    }
}

function insertRows(fresh: ReturnType<typeof openSqliteDatabase>["db"], table: string, cols: string[], rows: Array<Record<string, unknown>>): void {
    if (rows.length === 0) return;
    const colList = cols.map(quoteId).join(", ");
    const ph = cols.map(() => "?").join(", ");
    const stmt = fresh.prepare(`INSERT INTO ${quoteId(table)} (rowid, ${colList}) VALUES (?, ${ph})`);
    fresh.transaction(() => {
        for (const r of rows) stmt.run(r.__rid, ...cols.map((c) => r[c]));
    });
}

/** One row: every column re-read individually; a corrupt overflow cell
 *  NULLs its own column instead of killing the whole row. One retry per
 *  column — corrupt-page faults can be cache-position dependent. */
function salvageOneRow(src: RoDb, table: string, cols: string[], rid: number): Record<string, unknown> | null {
    const row: Record<string, unknown> = { __rid: rid };
    let anyRead = false;
    for (const c of cols) {
        let value: unknown;
        try {
            value = src.prepare(`SELECT ${quoteId(c)} FROM ${quoteId(table)} WHERE rowid = ?`).get(rid)[c];
            anyRead = true;
        } catch {
            try {
                value = src.prepare(`SELECT ${quoteId(c)} FROM ${quoteId(table)} WHERE rowid = ?`).get(rid)[c];
                anyRead = true;
            } catch {
                row[c] = null;
            }
        }
        if (row[c] === undefined) row[c] = value;
    }
    if (!anyRead && cols.every((c) => row[c] === null)) return null;
    return row;
}

function salvageTable(src: RoDb, fresh: ReturnType<typeof openSqliteDatabase>["db"], table: string): SalvageTableReport {
    const report: SalvageTableReport = { table, rowsTotal: null, rowsSalvaged: 0, rowsLost: 0, nulls: 0 };
    const cols = readColumns(src, table);
    if (cols === null) {
        report.note = "column list unreadable (table header corrupt) — skipped";
        return report;
    }
    try {
        const r = src.prepare(`SELECT max(rowid) AS m FROM ${quoteId(table)}`).get() as { m?: number | null };
        if (typeof r?.m === "number") report.rowsTotal = r.m;
    } catch {
        report.rowsTotal = null;
    }
    const max = report.rowsTotal;
    if (max === null) {
        if (isWithoutRowid(src, table)) {
            // No rowid to bisect over: copy the whole table. The read runs
            // on the read-only src handle (a corrupt page throws mid-scan)
            // and the write is one transaction on the fresh db — a fault
            // rolls back with zero partial rows, so either every row lands
            // or none do. (A cross-connection INSERT...SELECT is not an
            // option: without ATTACH the SELECT side resolves to the fresh
            // db's own empty table and "succeeds" with 0 rows.)
            try {
                const colList = cols.map(quoteId).join(", ");
                const ph = cols.map(() => "?").join(", ");
                const rows = src.prepare(`SELECT ${colList} FROM ${quoteId(table)}`).all() as Array<Record<string, unknown>>;
                const stmt = fresh.prepare(`INSERT INTO ${quoteId(table)} (${colList}) VALUES (${ph})`);
                fresh.transaction(() => {
                    for (const row of rows) stmt.run(...cols.map((c) => row[c]));
                });
                report.rowsTotal = rows.length;
                report.rowsSalvaged = rows.length;
            } catch {
                report.note = "WITHOUT ROWID table unreadable (corrupt) — skipped";
            }
            return report;
        }
        report.note = "max(rowid) unreadable — table skipped";
        return report;
    }
    const stack: Array<[number, number]> = [[0, Math.min(max, SALVAGE_CHUNK)]];
    while (stack.length > 0) {
        const [lo, hi] = stack.pop()!;
        let rows: Array<Record<string, unknown>>;
        try {
            rows = src.prepare(`SELECT rowid AS __rid, ${cols.map(quoteId).join(", ")} FROM ${quoteId(table)} WHERE rowid > ? AND rowid <= ?`).all(lo, hi) as Array<Record<string, unknown>>;
        } catch {
            if (hi - lo > 1) {
                const mid = lo + Math.floor((hi - lo) / 2);
                stack.push([mid, hi]);
                stack.push([lo, mid]);
                continue;
            }
            // Single rowid: try per-column salvage.
            const row = salvageOneRow(src, table, cols, hi);
            if (row === null) {
                report.rowsLost++;
            } else {
                for (const c of cols) if (row[c] === null) report.nulls++;
                try {
                    insertRows(fresh, table, cols, [row]);
                    report.rowsSalvaged++;
                } catch {
                    report.rowsLost++;
                }
            }
            continue;
        }
        // Rows came back as a batch: every value in them is known-good.
        // Rowids are dense per insert but deletions leave gaps; the walk
        // uses (lo, hi] BOUNDS, not counts, so gaps are skipped for free.
        insertRows(fresh, table, cols, rows);
        report.rowsSalvaged += rows.length;
        if (hi >= max) break;
        stack.push([hi, Math.min(max, hi + SALVAGE_CHUNK)]);
    }
    return report;
}

function salvageNoBackup(dir: string, dbPath: string, json: boolean, ts: string): CmdResult {
    let src: RoDb;
    try {
        src = openReadOnly(dbPath);
    } catch (err) {
        const backupsDir = join(dir, "backups");
        const hint = existsSync(backupsDir) ? ` — backups exist in ${backupsDir}; use 'bili storage repair --from <file>' for a lossless restore` : "";
        return fail(`the corrupt index.db cannot even be opened read-only (${String((err as Error)?.message ?? err)}) — no salvage possible${hint}`);
    }
    // Table list straight from the corrupt file; sqlite_master itself is
    // what survived in the #7156 field case (only 3 of ~15 btrees were hit).
    let tables: string[];
    try {
        tables = (src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<Record<string, unknown>>)
            .map((r) => String(r.name ?? ""))
            .filter(Boolean);
    } catch {
        try {
            src.close();
        } catch {
            /* ignore */
        }
        return fail("cannot enumerate the corrupt database's tables (sqlite_master unreadable) — no salvage possible; restore from a backup if one exists");
    }
    const ordered = tableDependencyOrder(src, tables);
    const tmpPath = `${dbPath}.salvage-${ts}`;
    const { db: fresh } = openSqliteDatabase(tmpPath);
    let reports: SalvageTableReport[] | null = null;
    try {
        migrateSchema(fresh);
        reports = ordered.map((t) => salvageTable(src, fresh, t));
        fresh.close();
    } catch (err) {
        fresh.close();
        try {
            src.close();
        } catch {
            /* ignore */
        }
        try {
            unlinkSync(tmpPath);
        } catch {
            /* ignore */
        }
        return fail(`salvage aborted mid-run: ${String((err as Error)?.message ?? err)} — the corrupt file is untouched, no swap happened`);
    }
    src.close();
    const verdict = quickCheckVerdict(tmpPath);
    if (!verdict.ok) {
        try {
            unlinkSync(tmpPath);
        } catch {
            /* ignore */
        }
        return fail(`the salvaged database FAILED its own quick_check (${verdict.detail}) — swap aborted, the corrupt file is untouched`);
    }
    const lost = reports.reduce((a, r) => a + r.rowsLost, 0);
    const nulls = reports.reduce((a, r) => a + r.nulls, 0);
    // A table the salvager could not read at all (note set) is loss too:
    // its rows are absent from the result, and the contract is "exit 1 and
    // report per table when anything is lost" — a silently-emptied table
    // is the worst kind of loss.
    const skipped = reports.filter((r) => r.note !== undefined);
    const complete = lost === 0 && skipped.length === 0;
    const moved = quarantine(dbPath, ts);
    renameSync(tmpPath, dbPath);
    const data = {
        ok: complete,
        mode: "salvage",
        tables: reports.map((r) => ({ table: r.table, total: r.rowsTotal, salvaged: r.rowsSalvaged, lost: r.rowsLost, nulls: r.nulls, note: r.note })),
        rowsLost: lost,
        skippedTables: skipped.map((r) => r.table),
        columnsNullified: nulls,
        schemaVersion: STORAGE_SCHEMA_VERSION,
        quarantined: moved,
        note: complete ? "restart bili to pick up the salvaged index" : "partial salvage — lost rows and skipped tables are unrecoverable from this file; restart bili, then verify the sessions you care about",
    };
    if (json) return { code: complete ? 0 : 1, text: `${JSON.stringify(data, null, 2)}\n` };
    const lines = [`salvaged ${dbPath} from the corrupt file (no backup used)`];
    lines.push("");
    lines.push(renderTable(
        ["TABLE", "TOTAL", "SALVAGED", "LOST", "NULLED COLS"],
        reports.map((r) => [r.table, String(r.rowsTotal ?? "?"), String(r.rowsSalvaged), String(r.rowsLost), String(r.nulls)]),
    ));
    for (const r of reports) if (r.note) lines.push(`  ${r.table}: ${r.note}`);
    lines.push("");
    lines.push(`  rows lost:          ${lost}${nulls > 0 ? ` (plus ${nulls} column(s) nullified on surviving rows)` : ""}`);
    if (skipped.length > 0) lines.push(`  skipped tables:     ${skipped.map((r) => r.table).join(", ")}`);
    lines.push(`  quick_check:        ok (verified before the swap)`);
    lines.push(`  quarantined:        ${moved.join(", ")}`);
    lines.push("");
    lines.push(complete ? "restart bili (stop the proxy first) to pick up the salvaged index." : "partial salvage — restart bili, then verify the sessions you care about still load.");
    return { code: complete ? 0 : 1, text: `${lines.join("\n")}\n` };
}

export async function runStorageRepairCommand(opts: { from?: string; dir?: string; json?: boolean }): Promise<CmdResult> {
    const dir = opts.dir ?? sessionsDir();
    const dbPath = indexDbPath(dir);
    if (!existsSync(dbPath)) return fail(`no index.db at ${dbPath} — nothing to repair`);
    const writer = liveWriterPid(dbPath);
    if (writer !== null) {
        const backupsDir = join(dir, "backups");
        const hint = existsSync(backupsDir) ? ` (backups live in ${backupsDir})` : "";
        return fail(`refused: another live process (pid ${writer}) holds ${dbPath}.lock — stop it (e.g. kill the bili proxy, and any 'bili pi' children) before repairing; the quarantined file would be stolen out from under an active writer${hint}`);
    }
    const ts = utcStamp();
    // Safety: a HEALTHY index must never be swapped for a possibly-older
    // backup (that would silently discard newer sessions). The operator's
    // honest "I still want to roll back" move is a manual rename — the
    // command refuses to guess.
    const current = quickCheckVerdict(dbPath);
    if (current.ok) {
        return fail(`the current index.db PASSES quick_check — nothing to repair; refusing to replace a healthy index with a backup that may be older. To roll back to a backup deliberately: stop bili, rename index.db{,-wal,-shm} aside by hand, then put the backup in place`);
    }
    if (opts.from) return repairWithBackup(dir, dbPath, opts.from, !!opts.json, ts);
    return salvageNoBackup(dir, dbPath, !!opts.json, ts);
}
