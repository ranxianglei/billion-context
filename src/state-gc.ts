import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { log as loggerLog } from "./logger.js";

/**
 * FIFO garbage collection for debug dump directories (`dumps/`, `raw/`, the
 * dumpSse dir). These dirs are write-only under --debug and would otherwise
 * grow without bound over a long-running proxy's life.
 *
 * Two bounds, both enforced by deleting the OLDEST files first (by mtime):
 *   - maxFiles: cap on the number of files kept (default 500)
 *   - maxBytes: cap on total bytes kept (default 512 MB)
 *
 * A per-directory throttle (default 30 s) keeps the cost off the hot path —
 * dumps are written per request, and a full readdir+stat sweep every request
 * would be wasteful. The throttle is a soft bound: a dir can exceed the caps
 * by at most ~30 s of writes between sweeps.
 */

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MIN_INTERVAL_MS = 30 * 1000;

const lastRun = new Map<string, number>();

export interface GcDebugDirOpts {
    maxFiles?: number;
    maxBytes?: number;
}

/**
 * Sweep `dir`, deleting oldest files (by mtime) until both caps hold.
 * Best-effort: a missing/unreadable dir or an ununlinkable file is not an
 * error. Returns the number of files removed (0 when throttled or nothing
 * to do). `nowMs` is injectable for tests.
 */
export function gcDebugDir(dir: string, opts: GcDebugDirOpts = {}, nowMs: number = Date.now()): number {
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const last = lastRun.get(dir);
    if (last !== undefined && nowMs - last < MIN_INTERVAL_MS) return 0;
    lastRun.set(dir, nowMs);

    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return 0;
    }
    const files: { name: string; mtime: number; size: number }[] = [];
    for (const name of names) {
        try {
            const st = statSync(path.join(dir, name));
            if (st.isFile()) files.push({ name, mtime: st.mtimeMs, size: st.size });
        } catch {
            // vanished between readdir and stat
        }
    }
    files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    let remaining = files.length;
    let remainingBytes = 0;
    for (const f of files) remainingBytes += f.size;
    if (remaining <= maxFiles && remainingBytes <= maxBytes) return 0;

    let removed = 0;
    for (const f of files) {
        if (remaining <= maxFiles && remainingBytes <= maxBytes) break;
        try {
            unlinkSync(path.join(dir, f.name));
            remaining--;
            remainingBytes -= f.size;
            removed++;
        } catch {
            // locked/gone — skip and keep trimming older files
        }
    }
    if (removed > 0) {
        loggerLog("debug", `[gc] ${dir}: removed ${removed} oldest dump file(s), ${remaining} left`);
    }
    return removed;
}
