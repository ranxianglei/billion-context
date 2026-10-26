import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { log as loggerLog } from "./logger.js";
import { dumpGcMaxTotalBytes, dumpGcMaxAgeMs } from "./knobs.js";

/**
 * #2412: retention GC for the debug dump directories (`dumps/`, `raw/`, the
 * SSE dump dir). These dirs are write-only and grew without bound — 70 GB in
 * 26 h measured under active forensics. Opt-in via diagnostics.maxTotalBytes /
 * diagnostics.maxAgeDays (BILI_DUMP_MAX_TOTAL_BYTES / BILI_DUMP_MAX_AGE_DAYS):
 * when either bound is set, oldest files are deleted first until both bounds
 * hold. Default OFF — nothing is ever deleted unless a bound is configured.
 *
 * Design carried over from PR #277 (closed unmerged; this is its config-driven
 * successor): FIFO-by-mtime trim with a deterministic name tiebreak, a 30 s
 * per-dir throttle that keeps the sweep off the hot path, best-effort error
 * handling throughout (a missing dir or an ununlinkable file is not an error).
 * Deltas vs #277:
 *   - caps come from knobs (env > file > default-off) instead of hardcoded
 *     500 files / 512 MB — at high capture rates a fixed small cap evicts
 *     forensics evidence within minutes of writing it;
 *   - `err-*` / `summary-err-*` incident dumps (error-dump.ts, BILI_DUMP_4XX)
 *     are protected: rare, high-value post-mortem evidence written
 *     independently of the body-dump toggles;
 *   - deletions log at WARN, not debug: silent evidence eviction is exactly
 *     the failure class this issue reports.
 */

const MIN_INTERVAL_MS = 30 * 1000;
const PROTECTED_PREFIXES = ["err-", "summary-err-"];
const lastRun = new Map<string, number>();

export interface DumpGcPolicy {
    /** Total-size cap in bytes; oldest files dropped until under it. null = no byte bound. */
    maxBytes?: number | null;
    /** Age cap in ms; everything older is dropped regardless of bytes. null = no age bound. */
    maxAgeMs?: number | null;
}

/**
 * Sweep `dir`, deleting oldest files (by mtime) until both policy bounds hold.
 * Best-effort; returns the number of files removed (0 when throttled, when
 * the policy is empty, or when there is nothing to do). `nowMs` is injectable
 * for tests. Subdirectories are ignored (all dump dirs are flat-file).
 */
export function gcDebugDir(dir: string, policy: DumpGcPolicy, nowMs: number = Date.now()): number {
    const maxBytes = policy.maxBytes ?? null;
    const maxAgeMs = policy.maxAgeMs ?? null;
    if (!dir || (maxBytes == null && maxAgeMs == null)) return 0;
    const last = lastRun.get(dir);
    if (last !== undefined && nowMs - last < MIN_INTERVAL_MS) return 0;

    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        // Missing/unreadable dir — do NOT start the throttle clock, so a dir
        // created shortly after a failed probe gets swept on its next visit.
        return 0;
    }
    lastRun.set(dir, nowMs);

    const files: { name: string; mtime: number; size: number }[] = [];
    for (const name of names) {
        if (PROTECTED_PREFIXES.some((p) => name.startsWith(p))) continue;
        try {
            const st = statSync(path.join(dir, name));
            if (st.isFile()) files.push({ name, mtime: st.mtimeMs, size: st.size });
        } catch {
            // vanished between readdir and stat
        }
    }
    files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));

    let removed = 0;
    let freedBytes = 0;
    const drop = (f: { name: string; size: number }): void => {
        try {
            unlinkSync(path.join(dir, f.name));
            removed++;
            freedBytes += f.size;
        } catch {
            // locked/gone — skip and keep trimming older files
        }
    };

    // Age bound first: everything older than the cutoff goes, regardless of bytes.
    let survivors = files;
    if (maxAgeMs != null) {
        const cutoff = nowMs - maxAgeMs;
        survivors = [];
        for (const f of files) {
            if (f.mtime < cutoff) drop(f);
            else survivors.push(f);
        }
    }
    // Byte bound: oldest-first until under the cap.
    if (maxBytes != null) {
        let remainingBytes = 0;
        for (const f of survivors) remainingBytes += f.size;
        for (const f of survivors) {
            if (remainingBytes <= maxBytes) break;
            drop(f);
            remainingBytes -= f.size;
        }
    }

    if (removed > 0) {
        const bounds = [
            maxBytes != null ? `maxTotalBytes=${maxBytes}` : "",
            maxAgeMs != null ? `maxAgeDays=${maxAgeMs / 86_400_000}` : "",
        ].filter(Boolean).join(" ");
        loggerLog("warn", `[gc] ${dir}: removed ${removed} oldest dump file(s), ~${Math.round(freedBytes / (1024 * 1024))} MB freed (${bounds}), ${files.length - removed} left`);
    }
    return removed;
}

/**
 * Hot-path entry point used by every dump write site: resolves the live
 * policy from knobs (env > file > default-off) and sweeps `dir` only when a
 * bound is actually configured. Cheap no-op otherwise.
 */
export function gcDumpDirIfConfigured(dir: string): void {
    if (!dir) return;
    const maxBytes = dumpGcMaxTotalBytes();
    const maxAgeMs = dumpGcMaxAgeMs();
    if (maxBytes == null && maxAgeMs == null) return;
    gcDebugDir(dir, { maxBytes, maxAgeMs });
}
