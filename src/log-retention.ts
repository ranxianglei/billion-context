/**
 * Private log-file retention policy + generation enumeration.
 *
 * bili.log is PRIVATE: masked host names, session ids, upstream error bodies.
 * The previous "10 MiB + one .old" scheme guaranteed neither property that must
 * hold at once: COVERAGE ("what happened 30 hours ago?" is answered from the
 * durable file, so the default targets 48 hours) and BOUND (one segment cap
 * bounds nothing once history is retained, so retention is a total-byte budget,
 * not a segment count). The budget WINS when they conflict: an unbounded log is a
 * disk and privacy failure, a short log is an honest one. What the scheme must
 * never do is claim a 48h window it does not have — every reader gets the same
 * enumerable generation set plus `logCoverage()`, which reports the MEASURED span
 * and never asserts continuity it cannot prove.
 *
 * Generations are IMMUTABLE once sealed: only the active file is written. Each
 * rotation moves it into its OWN directory `<file>.archive/<stamp>-<pid>-<n>/`
 * (one payload `bili.log` inside) — ownership of a name is decided by a single
 * atomic `mkdir`, never by a listing plus a rename, so concurrent sealers cannot
 * overwrite each other's archive. The UTC stamp is filename-safe on POSIX and
 * Windows (`:` is illegal in NTFS) and orders history; the creation counter
 * breaks same-millisecond ties. The one legacy artifact, `<file>.old`, is
 * migrated on first ownership under a stamp taken from its own mtime, so history
 * survives the upgrade in its real position.
 *
 * PRIVACY: every file is 0600 from the first byte (`stampNewLog`'s open mode —
 * the inherited umask used to leave bili.log 0644 on a default-022 machine), and
 * pre-existing files taken over are chmod'ed: they are bili's own log, created by
 * a build that did not ask. win32 has no POSIX mode bits — the state-dir ACL
 * governs and the chmod is a silent no-op.
 *
 * Free of config/knob imports: logger.ts imports THIS module and src/config.ts
 * imports logger.ts, so a config read here would close an import cycle. The
 * resolved snapshot arrives via `configureLogRetention()` from the startup
 * boundary (src/server.ts, resolving src/knobs.ts `logRetentionPolicy()`).
 */
import {
    chmodSync,
    closeSync,
    mkdirSync,
    openSync,
    readdirSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import path from "node:path";
import { computeCoverage, formatBytes, type LogCoverage } from "./log-retention-coverage.js";

/** Re-exported so callers owning a generation list need one import. No runtime
 *  cycle: the coverage module takes its inputs structurally. */
export type { LogCoverage };

/** Segment size before the active file is sealed — unchanged from the historical
 *  cap: it bounds what one crash or truncated read can take. */
export const LOG_SEGMENT_BYTES = 10 * 1024 * 1024;
/** Default retention TARGET: wall-clock history the budget is spent to keep. */
export const LOG_RETENTION_TARGET_MS = 48 * 60 * 60 * 1000;
/** Default total-byte budget across the active file + sealed generations: 256 MiB
 *  ≈ 25 segments at the default segment size, which keeps the store finite under
 *  a log storm while still allowing a multi-day window at ordinary rates. */
export const LOG_RETENTION_BUDGET_BYTES = 256 * 1024 * 1024;
/** Owner-only rw for every FILE bili creates or takes ownership of. */
export const LOG_FILE_MODE = 0o600;
/** Owner-only rwx for every DIRECTORY bili creates: the owner must be able to
 *  traverse an archive directory, so a directory never takes the file mode. */
export const LOG_DIR_MODE = 0o700;
/** How many archive names one seal may try before giving up (collision-only). */
const SEAL_ATTEMPTS = 1000;

/** Resolved retention policy (a snapshot, not a live config read). */
interface LogRetentionPolicy {
    /** Target history window in ms; coverage is reported against it. */
    targetMs: number;
    /** Hard cap on bytes across the active file + all sealed generations. */
    budgetBytes: number;
    /** Segment size before sealing. */
    segmentBytes: number;
    /** Migrate `<file>.old` (pre-generation logger) instead of ignoring it. */
    migrateLegacyOld: boolean;
}

/** One on-disk generation. `active` is the file the logger appends to; every
 *  other generation is sealed (immutable) older history. */
interface LogGeneration {
    path: string;
    /** Sequence from a sealed name; -1 for the legacy `.old` and the active file. */
    seq: number;
    sealedAt: number;
    sizeBytes: number;
    active: boolean;
    /** Pre-generation artifact (`<file>.old`), still awaiting migration. */
    legacy: boolean;
}

export function defaultLogRetentionPolicy(): LogRetentionPolicy {
    return { targetMs: LOG_RETENTION_TARGET_MS, budgetBytes: LOG_RETENTION_BUDGET_BYTES, segmentBytes: LOG_SEGMENT_BYTES, migrateLegacyOld: true };
}

let retention: LogRetentionPolicy = defaultLogRetentionPolicy();

/** The policy in force (defaults until `configureLogRetention()` installs the
 *  resolved knobs) — the logger's own read of the current segment size. */
export function logRetention(): LogRetentionPolicy {
    return retention;
}

/** Install the startup-resolved policy. Non-finite/non-positive target or budget
 *  falls back per-field; a segment larger than the budget is capped so one full
 *  generation always fits. */
export function configureLogRetention(partial: Partial<LogRetentionPolicy>): LogRetentionPolicy {
    const base = defaultLogRetentionPolicy();
    const pick = (value: number | undefined, fallback: number): number => (Number.isFinite(value) && value! > 0 ? value! : fallback);
    const budgetBytes = pick(partial.budgetBytes, base.budgetBytes);
    retention = {
        targetMs: pick(partial.targetMs, base.targetMs),
        budgetBytes,
        segmentBytes: Math.min(pick(partial.segmentBytes, base.segmentBytes), Math.max(1, budgetBytes)),
        migrateLegacyOld: partial.migrateLegacyOld !== false,
    };
    return retention;
}

// ── Generation naming ───────────────────────────────────────────────────────

/** Compact UTC stamp, filename-safe on POSIX and Windows (`:` is illegal in NTFS
 *  names): 2026-11-01T09:03:12.345Z → `20261101T090312345`. */
export function generationStamp(ms: number): string {
    const d = new Date(ms);
    const p = (n: number, w: number): string => String(n).padStart(w, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1, 2)}${p(d.getUTCDate(), 2)}T`
        + `${p(d.getUTCHours(), 2)}${p(d.getUTCMinutes(), 2)}${p(d.getUTCSeconds(), 2)}${p(d.getUTCMilliseconds(), 3)}`;
}

/** Parse a `YYYYMMDDTHHMMSSmmm` stamp back to epoch ms; null when malformed. */
function parseGenerationStamp(stamp: string): number | null {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(stamp);
    if (!m) return null;
    const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!);
    return Number.isFinite(ms) ? ms : null;
}

/** One generation directory name → its ordering key. */
function parseGenerationName(name: string): { ms: number; seq: number } | null {
    const m = /^(\d{8}T\d{9})-\d{1,10}-(\d{1,9})$/.exec(name);
    if (!m) return null;
    const ms = parseGenerationStamp(m[1]!);
    return ms === null ? null : { ms, seq: Number(m[2]) };
}

function statOrNull(file: string): { size: number; mtimeMs: number } | null {
    try {
        const st = statSync(file);
        return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch {
        return null;
    }
}

const PAYLOAD = "bili.log";

/** The single payload file inside a generation directory. `mkdir` decided who
 *  owns the name, so the payload name itself is never contended. */
function generationPayload(dir: string): string {
    return path.join(dir, PAYLOAD);
}

/** Every generation of `logPath`, OLDEST FIRST — the order a reader appends them
 *  in; the active file is last (absent until it exists). Sealed history is
 *  ordered by its own sealed stamp (then its creation counter), so ordering never
 *  depends on a directory listing. The pre-generation `<file>.old` is placed by
 *  ITS OWN mtime against those stamps, so a migrated artifact keeps its real
 *  chronological position instead of jumping to the newest slot. Pure
 *  enumeration: never mutates, never throws. */
export function logGenerations(logPath: string): LogGeneration[] {
    return enumerateGenerations(logPath).generations;
}

/** `logGenerations` plus whether the archive directory could actually be listed.
 *  Readers that only need the files keep using `logGenerations`; coverage uses
 *  this so a failed listing is reported as unavailable history instead of an
 *  empty one. */
function enumerateGenerations(logPath: string): { generations: LogGeneration[]; enumerationFailed: boolean } {
    const out: LogGeneration[] = [];
    const legacyPath = `${logPath}.old`;
    const legacyStat = statOrNull(legacyPath);
    if (legacyStat) {
        out.push({ path: legacyPath, seq: -1, sealedAt: legacyStat.mtimeMs, sizeBytes: legacyStat.size, active: false, legacy: true });
    }
    const archive = archiveEntries(logPath);
    for (const name of archive.names) {
        const parsed = parseGenerationName(name);
        if (!parsed) continue; // a foreign artifact in our archive dir
        const payload = generationPayload(path.join(archiveDir(logPath), name));
        const st = statOrNull(payload);
        // An empty directory is a seal in flight, not yet a readable generation.
        if (!st) continue;
        out.push({ path: payload, seq: parsed.seq, sealedAt: parsed.ms, sizeBytes: st.size, active: false, legacy: false });
    }
    const active = statOrNull(logPath);
    if (active) out.push({ path: logPath, seq: -1, sealedAt: active.mtimeMs, sizeBytes: active.size, active: true, legacy: false });
    // Active is always last; sealed history is strictly chronological by its own
    // stamp, with the creation counter breaking same-millisecond ties.
    out.sort((a, b) => (Number(a.active) - Number(b.active))
        || (a.sealedAt - b.sealedAt)
        || (a.seq - b.seq));
    return { generations: out, enumerationFailed: archive.failed };
}

/** Sibling `<base>.archive` holding one exclusively-created
 *  `<stamp>-<pid>-<counter>` directory per generation. */
function archiveDir(logPath: string): string {
    return path.join(path.dirname(logPath), `${path.basename(logPath)}.archive`);
}

/** Generation directory names, chronologically sorted. `failed` separates "no
 *  archive yet" from "could not be listed": treating an I/O failure as an empty
 *  archive would report missing history as a young install. */
function archiveEntries(logPath: string): { names: string[]; failed: boolean } {
    try {
        return { names: readdirSync(archiveDir(logPath)).sort(), failed: false };
    } catch (e) {
        // ENOENT: the archive is simply not created until the first seal.
        return { names: [], failed: (e as NodeJS.ErrnoException).code !== "ENOENT" };
    }
}

/** Take exclusive ownership of a fresh archive name and move `from` into it.
 *
 *  Ownership is ONE atomic `mkdir`: a racer on the same name gets `EEXIST` and
 *  tries the next candidate, so two processes can never rename into one
 *  generation, and the destination inside a directory we just created cannot
 *  pre-exist. Never copies — the sealed artifact keeps the original bytes and
 *  mtime. Returns null when the move fails, so the caller keeps appending to
 *  `from` instead of losing lines. */
function sealAs(logPath: string, from: string, at: number): string | null {
    const archive = archiveDir(logPath);
    try {
        mkdirSync(archive, { recursive: true, mode: LOG_DIR_MODE });
    } catch {
        return null; // cannot own an archive: keep appending, never copy/truncate
    }
    chmodPrivateDir(archive);
    const stamp = generationStamp(at);
    for (let counter = 1; counter <= SEAL_ATTEMPTS; counter++) {
        const owned = path.join(archive, `${stamp}-${process.pid}-${counter}`);
        try {
            // DIRECTORY ownership: mkdir is the atomic claim on the name.
            mkdirSync(owned, { mode: LOG_DIR_MODE });
        } catch {
            continue; // EEXIST: another writer owns this name — try the next
        }
        const target = generationPayload(owned);
        try {
            renameSync(from, target);
        } catch {
            // Hand the name back so a later seal can reuse it, then report failure.
            try { rmdirSync(owned); } catch { /* leave it; an empty dir is not a generation */ }
            return null;
        }
        chmodPrivateFile(target);
        return target;
    }
    return null;
}

/** Seal the active file into the next immutable generation (rotation time). */
export function sealActiveLog(logPath: string, now: number = Date.now()): { sealed: string | null } {
    return { sealed: statOrNull(logPath) === null ? null : sealAs(logPath, logPath, now) };
}

/** Move a pre-generation `<file>.old` into the generation set, preserving content
 *  and its own timestamp — the stamp comes from the file's mtime so migrated
 *  bytes keep their real chronological position. Idempotent: once renamed the
 *  legacy name is gone. */
export function migrateLegacyOld(logPath: string): { sealed: string | null } {
    const st = statOrNull(`${logPath}.old`);
    return { sealed: st === null ? null : sealAs(logPath, `${logPath}.old`, st.mtimeMs) };
}

// ── Permissions ─────────────────────────────────────────────────────────────

/** Force owner-only permissions on a FILE. No-op on win32 (no POSIX mode bits;
 *  the state-dir ACL governs) and silent on failure — a permission fix never
 *  drops logging. */
export function chmodPrivateFile(file: string): void {
    if (process.platform === "win32") return;
    try {
        chmodSync(file, LOG_FILE_MODE);
    } catch { /* vanished or not ours; new files get the mode at open() */ }
}

/** Same for a DIRECTORY bili owns: 0700, so only the owner can traverse it. */
function chmodPrivateDir(dir: string): void {
    if (process.platform === "win32") return;
    try {
        chmodSync(dir, LOG_DIR_MODE);
    } catch { /* vanished or not ours */ }
}

// ── Budget enforcement ──────────────────────────────────────────────────────

/** `removed` lists budget deletions, oldest first. `activeOnlyExcess` means the
 *  live file alone is over budget and cannot be truncated while being written. */
interface RetentionResult {
    removed: string[];
    totalBytes: number;
    activeOnlyExcess: boolean;
    coverage: LogCoverage;
}

/** Delete one generation: unlink the payload, then the directory we created —
 *  never recursively, so an unexpected entry inside it is left alone. */
function removeGeneration(g: LogGeneration): void {
    unlinkSync(g.path);
    if (path.basename(g.path) === PAYLOAD) {
        try { rmdirSync(path.dirname(g.path)); } catch { /* another entry: leave it */ }
    }
}

/** Enforce the byte budget, OLDEST CHRONOLOGICAL HISTORY FIRST. The BUDGET WINS:
 *  when 48h do not fit the result reports the shortfall instead of keeping an
 *  unbounded file, and the active file is never deleted (live sink). */
export function applyLogRetention(
    logPath: string,
    policy: LogRetentionPolicy = retention,
    now: number = Date.now(),
): RetentionResult {
    const enumerated = enumerateGenerations(logPath);
    let gens = enumerated.generations;
    const enumerationFailed = enumerated.enumerationFailed;
    let total = gens.reduce((n, g) => n + g.sizeBytes, 0);
    const removed: string[] = [];
    let failed = enumerationFailed;
    let activeOnlyExcess = false;
    while (total > policy.budgetBytes) {
        const victim = gens.find((g) => !g.active);
        if (!victim) {
            // Only the live sink remains and it alone exceeds the budget: the
            // logger cannot shrink a file it is appending to, so the set stays
            // over budget. That is a real, reportable condition — never silence.
            activeOnlyExcess = total > policy.budgetBytes;
            break;
        }
        try {
            removeGeneration(victim);
        } catch {
            failed = true; // keep the set we still have; the caller reports the truth
            break;
        }
        removed.push(victim.path);
        total -= victim.sizeBytes;
        gens = gens.filter((g) => g.path !== victim.path);
    }
    // A part-failed trim proves nothing about what is left, so it reports the
    // unknowable cause instead of claiming the budget caused the short window.
    const cause = failed ? undefined : removed.length > 0;
    const coverage = computeCoverage(gens, policy, now, cause, enumerationFailed);
    return {
        removed,
        totalBytes: total,
        activeOnlyExcess,
        coverage: activeOnlyExcess
            ? {
                ...coverage,
                message: `${coverage.message}; the active log alone (${formatBytes(total)}) exceeds the ${formatBytes(policy.budgetBytes)} budget and cannot be truncated while it is being written`,
            }
            : coverage,
    };
}

/** What the CURRENT retention set measures, without touching the disk — the view
 *  /__bili/logs and the diagnostics blob report. A failed archive listing is
 *  passed on so the report says history is unavailable rather than merely short. */
export function logCoverage(
    logPath: string,
    policy: LogRetentionPolicy = retention,
    now: number = Date.now(),
): LogCoverage {
    const { generations, enumerationFailed } = enumerateGenerations(logPath);
    return computeCoverage(generations, policy, now, undefined, enumerationFailed);
}

/** Create `file` (0600 — umask cannot widen it) with one line, once per start, so
 *  the true start of a log's history is knowable. An existing file belongs to
 *  another writer and is left completely alone. */
export function stampNewLog(file: string, line: string): void {
    let fd: number | undefined;
    try {
        fd = openSync(file, "wx", LOG_FILE_MODE);
        writeSync(fd, line);
    } catch {
        // Already owned by our logger or another instance: never fight for it.
    } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    }
}
