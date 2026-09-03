import { readdirSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { log as loggerLog } from "./logger.js";

/**
 * Startup garbage collection for the on-disk session registry (#407).
 *
 * WHY: the kernel StateStore deliberately never deletes records (cleanup is a
 * downstream policy decision), so the sessions dir grew without bound —
 * ~55 files / ~60MB per day on a single host — and every boot synchronously
 * read + JSON.parsed every file. The saved state is derived data (the
 * conversation itself lives on the client), so an age cap plus a total-size
 * budget keeps both the directory and the startup parse bounded.
 *
 * MECHANISM: stat-only pre-pass (readdir + stat + rm; never reads or parses a
 * file body). A session's last save time ≈ its file mtime because writes are
 * atomic temp+rename. A canonical <base>.json and its spill sibling
 * <base>.fb.json form one unit (age = newest mtime, size = sum) so a record
 * and its spill are never separated. .tmp-* in-flight files are left alone.
 *
 * PASS 1 (retention): delete units not written within retentionMs.
 * PASS 2 (budget): while the surviving total exceeds maxBytes, delete the
 * oldest unit first. Each pass is independently disabled with 0.
 */

export interface GcOptions {
    /** Delete units whose newest mtime is older than this many ms. 0 disables. */
    retentionMs: number;
    /** Keep surviving units under this many bytes by dropping oldest first. 0 disables. */
    maxBytes: number;
    nowMs?: number;
}

export interface GcResult {
    scannedFiles: number;
    scannedBytes: number;
    deletedUnits: number;
    deletedFiles: number;
    bytesFreed: number;
    remainingBytes: number;
}

interface Unit {
    files: string[];
    size: number;
    mtimeMs: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB

export function gcOptionsFromEnv(): GcOptions {
    const days = intEnv("BILI_SESSION_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
    const maxBytes = intEnv("BILI_SESSION_MAX_BYTES", DEFAULT_MAX_BYTES);
    return { retentionMs: Math.max(0, days) * DAY_MS, maxBytes: Math.max(0, maxBytes) };
}

function intEnv(name: string, fallback: number): number {
    const v = process.env[name];
    if (!v) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

function collectUnits(dir: string): Unit[] {
    const units = new Map<string, Unit>();
    const walk = (d: string): void => {
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (!e.isFile()) {
                if (e.isDirectory()) walk(path.join(d, e.name));
                continue;
            }
            if (!e.name.endsWith(".json") || e.name.startsWith(".tmp-")) continue;
            const abs = path.join(d, e.name);
            let st;
            try {
                st = statSync(abs);
            } catch {
                continue;
            }
            const rel = path.relative(dir, abs);
            const key = e.name.endsWith(".fb.json") ? `${rel.slice(0, -".fb.json".length)}.json` : rel;
            const u = units.get(key);
            if (u) {
                u.files.push(abs);
                u.size += st.size;
                u.mtimeMs = Math.max(u.mtimeMs, st.mtimeMs);
            } else {
                units.set(key, { files: [abs], size: st.size, mtimeMs: st.mtimeMs });
            }
        }
    };
    walk(dir);
    return [...units.values()];
}

/** Run the GC pre-pass over the sessions dir. Returns null when there is
 *  nothing to scan (missing/empty dir) or stats could not be gathered. */
export function gcSessionFiles(dir: string, opts: GcOptions): GcResult | null {
    let units: Unit[];
    try {
        units = collectUnits(dir);
    } catch {
        return null;
    }
    if (units.length === 0) return null;
    const result: GcResult = { scannedFiles: 0, scannedBytes: 0, deletedUnits: 0, deletedFiles: 0, bytesFreed: 0, remainingBytes: 0 };
    for (const u of units) {
        result.scannedFiles += u.files.length;
        result.scannedBytes += u.size;
    }
    const deleted = new Set<Unit>();
    const deleteUnit = (u: Unit): void => {
        for (const f of u.files) rmSync(f, { force: true });
        deleted.add(u);
        result.deletedUnits++;
        result.deletedFiles += u.files.length;
        result.bytesFreed += u.size;
    };
    if (opts.retentionMs > 0) {
        const cutoff = (opts.nowMs ?? Date.now()) - opts.retentionMs;
        for (const u of units) if (u.mtimeMs < cutoff) deleteUnit(u);
    }
    if (opts.maxBytes > 0) {
        let total = 0;
        for (const u of units) if (!deleted.has(u)) total += u.size;
        if (total > opts.maxBytes) {
            const sorted = units.filter((u) => !deleted.has(u)).sort((a, b) => a.mtimeMs - b.mtimeMs);
            for (const u of sorted) {
                if (total <= opts.maxBytes) break;
                deleteUnit(u);
                total -= u.size;
            }
        }
    }
    result.remainingBytes = result.scannedBytes - result.bytesFreed;
    if (result.deletedFiles > 0) {
        loggerLog("info", `[gc] sessions dir: removed ${result.deletedUnits} old session record(s), freed ${fmtBytes(result.bytesFreed)}, ${fmtBytes(result.remainingBytes)} remaining`);
    }
    return result;
}

function fmtBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${n}B`;
}
