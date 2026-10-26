/**
 * Web 更新/Updates tab — wiring point for self-update ACTIONS (#3719).
 *
 * src/update.ts stays load-bearing and human-gated: this module never edits
 * the updater, it only holds THIS process's UpdateOptions (registered once by
 * the CLI alongside startAutoUpdate — the SAME object the background loop
 * runs on) and exposes guarded actions on top of its existing exports:
 *   - a forced registry check   → checkForUpdate(opts, true)
 *   - a pinned-version install  → forceInstallVersion(v, dir, opts, "web-panel")
 *     (upgrade to a newer release OR rollback to an older one)
 * Each action carries one in-process dedupe flag so the panel cannot stack
 * concurrent runs — a second concurrent caller gets {ok:true, already:true}
 * instead of a duplicate registry/install storm. An unregistered process
 * (autoUpdate off, embedded use, tests) degrades to plain error strings;
 * nothing here throws into the HTTP handlers.
 */
import { checkForUpdate, findInstallDir, forceInstallVersion, lastUpdateCheckTime, readDiskVersion, staleInstallStatus, type UpdateOptions } from "../update.js";
import { getUpdateVisibility } from "../update-notes.js";
import { log as loggerLog } from "../logger.js";

/** One pushed release note mapped for the wire (span entries are oldest→newest). */
interface UpdateNotice {
    version: string;
    tier: "routine" | "recommended" | "critical";
    summary: string;
    date?: string;
}

interface UpdateStateSnapshotData {
    /** This process's version (package.json at startup). */
    running: string;
    /** On-disk version if resolvable (undefined = unknown → UI shows "—"). */
    disk?: string;
    /** Disk strictly newer than running — a host restart finishes the update. */
    pendingRestart: boolean;
    /** A critical-tier entry sits in the pushed span (#1977 surfaces). */
    critical: boolean;
    /** Pushed notices between running and the newest known release (oldest→newest). */
    notices: UpdateNotice[];
    /** Epoch ms of the last completed registry check; undefined = never. */
    lastCheckAt?: number;
    /** True while a manual check is in flight in this process. */
    checking: boolean;
    /** True while a pinned install is in flight in this process. */
    installing: boolean;
}

let registeredOpts: UpdateOptions | undefined;
let checking = false;
let installing = false;

/** CLI seam: store THIS process's live UpdateOptions (the same object passed
 *  to startAutoUpdate) so the web panel can drive the updater in-process. */
export function registerUpdateActions(opts: UpdateOptions): void {
    registeredOpts = opts;
}

/** False when the CLI never registered options (autoUpdate off / embedded / tests). */
export function updateActionsAvailable(): boolean {
    return registeredOpts !== undefined;
}

/** Loose semver shape check for panel input — optional v prefix, prerelease/
 *  build suffixes tolerated. Anything else (spaces, shell metachars, …) is
 *  rejected before it ever reaches the updater. */
function looksLikeSemver(v: string): boolean {
    return /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v);
}

/** Force ONE registry check through the shared update options — same lock,
 *  throttle and proxy gates as the background loop (force=true skips the
 *  throttle window and advisory deferrals by design). A concurrent second
 *  call reports {ok:true, already:true}; network failures come back as
 *  {ok:false, error} — never a throw. */
export async function triggerManualCheck(): Promise<{ ok: boolean; error?: string; already?: boolean }> {
    const opts = registeredOpts;
    if (opts === undefined) return { ok: false, error: "self-update not wired in this process" };
    if (checking) return { ok: true, already: true };
    checking = true;
    try {
        await checkForUpdate(opts, true);
        return { ok: true };
    } catch (e) {
        loggerLog("warn", `[update] manual web check failed: ${String(e)}`);
        return { ok: false, error: String(e) };
    } finally {
        checking = false;
    }
}

/** Pin ONE specific version onto this install (upgrade OR rollback to an
 *  older release). One install at a time — a concurrent second call gets
 *  {ok:true, already:true} while the first finishes. Never throws. */
export async function installVersionAction(v: string): Promise<{ ok: boolean; error?: string; already?: boolean }> {
    const opts = registeredOpts;
    if (opts === undefined) return { ok: false, error: "self-update not wired in this process" };
    if (installing) return { ok: true, already: true };
    if (!looksLikeSemver(v)) return { ok: false, error: `version shape rejected: ${v}` };
    installing = true;
    loggerLog("info", `[update] web panel install attempt: ${v}`);
    try {
        // Same resolution the background loop uses: explicit override wins
        // (test seam), otherwise walk up from the running module (#1628).
        const dir = opts.installDir ?? (await findInstallDir(opts.packageName));
        const result = await forceInstallVersion(v, dir, opts, "web-panel");
        loggerLog(result.ok ? "info" : "warn", `[update] web panel install ${v}: ${result.ok ? "installed — restart the host to finish" : `failed (${result.error})`}`);
        return result;
    } catch (e) {
        loggerLog("warn", `[update] web panel install ${v} threw: ${String(e)}`);
        return { ok: false, error: String(e) };
    } finally {
        installing = false;
    }
}

/** Panel state read — no network by construction (the registry is only ever
 *  touched behind an explicit check/install action). Async only because the
 *  last-check timestamp and the fresh on-disk version read touch the
 *  filesystem. Falls back to the release-notes watcher's cached disk view
 *  when the install dir cannot be resolved. */
export async function updateStateSnapshot(runningVersion: string): Promise<UpdateStateSnapshotData> {
    const vis = getUpdateVisibility(runningVersion);
    let disk = vis.diskVersion;
    const opts = registeredOpts;
    if (opts !== undefined) {
        try {
            const dir = opts.installDir ?? (await findInstallDir(opts.packageName));
            if (dir !== undefined) disk = (await readDiskVersion(dir)) ?? disk;
        } catch {
            // keep the watcher's cached view
        }
    }
    const lastCheckAt = await lastUpdateCheckTime();
    return {
        running: runningVersion,
        ...(disk !== undefined ? { disk } : {}),
        pendingRestart: disk !== undefined ? staleInstallStatus(disk, runningVersion) === "restart" : vis.pendingRestart,
        critical: vis.critical,
        notices: vis.span.map((e) => ({ version: e.version, tier: e.tier, summary: e.summary, ...(e.summaryZh ? { summaryZh: e.summaryZh } : {}), ...(e.date !== undefined ? { date: e.date } : {}) })),
        ...(lastCheckAt !== undefined ? { lastCheckAt } : {}),
        checking,
        installing,
    };
}

/** Test seam: clear the registered options and both in-flight flags. */
export function _resetUpdateActionsForTest(): void {
    registeredOpts = undefined;
    checking = false;
    installing = false;
}
