/**
 * Critical-defect advisory watcher (#1481).
 *
 * The npm companion package `billion-context-advisories` carries a machine-
 * readable list of versions with known critical defects. This watcher polls
 * that document on the self-updater's cadence — INDEPENDENTLY of autoUpdate:
 * its whole point is to reach installs whose auto-update is off. When the
 * local version falls inside an entry's `affected` semver range, the watcher
 * force-installs the entry's `target` version through the updater's full
 * safety chain (update.ts#forceInstallVersion) and surfaces the entry's
 * `reason` as a warning: prominent log line (deduped per process per id),
 * web UI banner, and /__bili/status field.
 *
 * Fail-open everywhere: an unreachable or malformed advisory source must
 * never degrade a working proxy — model traffic is never blocked by this
 * mechanism. Trust domain: the document comes from the same registry bili
 * already auto-installs tarballs from; no new trust boundary.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { cacheDir } from "./paths.js";
import { log as loggerLog, type Logger } from "./logger.js";
import type { FetchOptions } from "./fetch-util.js";
import {
    CHECK_INTERVAL_MS,
    egressDispatcher,
    findInstallDir,
    forceInstallVersion,
    readDiskVersion,
    registryUrlFor,
    type UpdateOptions,
} from "./update.js";

const ADVISORY_PACKAGE = "billion-context-advisories";
const SUPPORTED_SCHEMA = 1;

export type AdvisoryEntry = {
    /** Stable id, e.g. "bc-2026-001" — dedupes warnings per process. */
    id: string;
    /** Semver range of affected versions, e.g. ">=0.1.155 <0.1.158". */
    affected: string;
    /** Exact version to force-install (may be OLDER than the current one —
     *  rollback semantics). */
    target: string;
    /** User-facing explanation of the defect and why upgrading matters. */
    reason: string;
    publishedAt?: string;
};

export type AdvisoryState = {
    /** Set while an entry matches the local version (whether or not the
     *  forced install has succeeded yet). */
    active?: AdvisoryEntry & { currentVersion: string };
    lastCheckAt?: number;
    /** Last failure reason (source fetch / parse / install); cleared on a
     *  clean check. */
    lastError?: string;
};

let state: AdvisoryState = {};
const warnedKeys = new Set<string>();

export function getAdvisoryState(): AdvisoryState {
    return state;
}

/** True while the advisory target cannot be resolved on the registry — the
 *  forced-install escape hatch is uninstallable (owner typo, unpublished
 *  fix). In that state the advisory must NOT defer the normal self-update
 *  loop (#1196 wedge class, review F2): the web banner falls back to
 *  @latest and the normal loop keeps the install alive. */
export function advisoryDeferring(): boolean {
    return state.active !== undefined && !cannotResolveTarget(state.lastError);
}

export function cannotResolveTarget(err: string | undefined): boolean {
    return typeof err === "string" && err.includes("cannot resolve");
}

/** Test seam: clear state, warn dedupe, and stop the timer. */
export function _resetAdvisoryWatcherForTest(): void {
    state = {};
    warnedKeys.clear();
    firstCheckDone = false;
    stopAdvisoryWatcher();
}

/** Default source: the npm companion package's `latest` doc on the SAME
 *  configured registry as the updater (BILI_UPDATE_REGISTRY aware via
 *  registryUrlFor) — GFW/proxy users reach it through the exact egress path
 *  the tarball download already uses. An explicit override wins verbatim. */
export function resolveAdvisoryUrl(configured: string | undefined): string {
    const v = configured?.trim();
    if (v) return v;
    return registryUrlFor(ADVISORY_PACKAGE, "latest");
}

/** Validate the raw advisory document (the companion package's packument
 *  entry, whose custom field carries the payload). Malformed entries are
 *  skipped individually; a document with zero usable entries is an error so
 *  callers can distinguish "no advisories" from "broken feed". */
export function parseAdvisoryDoc(raw: unknown): { entries: AdvisoryEntry[]; error?: string } {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { entries: [], error: "document is not a JSON object" };
    }
    const payload = (raw as Record<string, unknown>).billionContextAdvisories;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return { entries: [], error: "missing billionContextAdvisories object" };
    }
    const p = payload as Record<string, unknown>;
    if (p.schema !== SUPPORTED_SCHEMA) {
        return { entries: [], error: `unsupported schema ${String(p.schema)} (supported: ${SUPPORTED_SCHEMA})` };
    }
    if (!Array.isArray(p.advisories)) {
        return { entries: [], error: "advisories field is not an array" };
    }
    const entries: AdvisoryEntry[] = [];
    for (const item of p.advisories) {
        if (typeof item !== "object" || item === null) continue;
        const e = item as Record<string, unknown>;
        const id = typeof e.id === "string" ? e.id.trim() : "";
        const affected = typeof e.affected === "string" ? e.affected.trim() : "";
        const target = typeof e.target === "string" ? e.target.trim() : "";
        const reason = typeof e.reason === "string" ? e.reason.trim() : "";
        if (!id || !affected || !semver.valid(target) || !reason) continue;
        entries.push({
            id,
            affected,
            target,
            reason,
            ...(typeof e.publishedAt === "string" && e.publishedAt.trim() ? { publishedAt: e.publishedAt.trim() } : {}),
        });
    }
    if (p.advisories.length > 0 && entries.length === 0) {
        return { entries: [], error: "no valid advisories in document" };
    }
    return { entries };
}

/** Which entries cover `version`. Prerelease versions match the ranges
 *  covering their release base (a -dev build carries the same defect as its
 *  release). Invalid ranges fail open (no match). */
export function matchAdvisories(entries: AdvisoryEntry[], version: string): AdvisoryEntry[] {
    if (!semver.valid(version)) return [];
    return entries.filter((e) => {
        try {
            return semver.satisfies(version, e.affected, { includePrerelease: true });
        } catch {
            return false;
        }
    });
}

function throttleFile(): string {
    return path.join(cacheDir(), ".advisory-check");
}

async function readLastCheck(): Promise<number> {
    try {
        const data = await readFile(throttleFile(), "utf-8");
        return parseInt(data.trim(), 10) || 0;
    } catch {
        return 0;
    }
}

async function writeLastCheck(ts: number): Promise<void> {
    try {
        await mkdir(path.dirname(throttleFile()), { recursive: true });
        await writeFile(throttleFile(), String(ts), "utf-8");
    } catch {
        // best-effort
    }
}

export type AdvisoryWatcherOptions = {
    packageName: string;
    /** Fallback version (running process); the disk version wins when
     *  readable — same rule as the self-updater. */
    currentVersion: string;
    /** Override for the advisory document URL (config `advisoryUrl` / env
     *  BILI_ADVISORY_URL). Absent = npm companion package on the configured
     *  registry. */
    advisoryUrl?: string;
    resolveProxy?: (url: string) => string | undefined;
    onStaleInstall?: UpdateOptions["onStaleInstall"];
    /** Test seam: pin the install directory instead of findInstallDir(). */
    installDir?: string;
    log?: Logger;
};

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let firstCheckDone = false;

function warnOnce(log: Logger, key: string, message: string): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    log("warn", message);
}

/** Run one advisory check (throttled unless `force`). Safe to call
 *  frequently. Never throws. */
export async function runAdvisoryCheck(opts: AdvisoryWatcherOptions, force = false): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const log = opts.log ?? loggerLog;
    try {
        const now = Date.now();
        const lastCheck = await readLastCheck();
        if (!force && firstCheckDone && now - lastCheck < CHECK_INTERVAL_MS) return;
        await writeLastCheck(now);
        firstCheckDone = true;

        const url = resolveAdvisoryUrl(opts.advisoryUrl);
        let data: unknown;
        try {
            const dispatcher = egressDispatcher({ resolveProxy: opts.resolveProxy }, url);
            const init: FetchOptions = {
                method: "GET",
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(5000),
                ...(dispatcher ? { dispatcher } : {}),
            };
            const res = await fetch(url, init as RequestInit);
            if (!res.ok) throw new Error(`advisory source returned HTTP ${res.status}`);
            data = await res.json();
        } catch (e) {
            state.lastError = String(e);
            warnOnce(log, `fetch:${String(e)}`, `[advisory] check failed (${String(e)}) — continuing without advisories`);
            return;
        }
        const parsed = parseAdvisoryDoc(data);
        if (parsed.error) {
            state.lastError = parsed.error;
            warnOnce(log, `parse:${parsed.error}`, `[advisory] ignoring malformed advisory document: ${parsed.error}`);
            return;
        }
        state.lastError = undefined;

        const installDir = opts.installDir ?? (await findInstallDir(opts.packageName));
        const diskVersion = installDir ? await readDiskVersion(installDir) : undefined;
        const currentVersion = diskVersion ?? opts.currentVersion;
        const matched = matchAdvisories(parsed.entries, currentVersion);
        state.lastCheckAt = now;
        if (matched.length === 0) {
            state.active = undefined;
            return;
        }
        const adv = matched[0];
        state.active = { ...adv, currentVersion };
        warnOnce(log, adv.id, `[advisory] ⚠️ ${adv.id}: version ${currentVersion} is affected (${adv.reason}) — forcing update to ${adv.target}`);
        const result = await forceInstallVersion(
            adv.target,
            installDir,
            {
                packageName: opts.packageName,
                currentVersion: opts.currentVersion,
                autoUpdate: true,
                resolveProxy: opts.resolveProxy,
                onStaleInstall: opts.onStaleInstall,
            },
            adv.id,
        );
        if (!result.ok) {
            state.lastError = result.error;
            return;
        }
        // Install landed: re-evaluate against the new disk version so the
        // banner clears in this same cycle when the target is clean.
        const diskAfter = installDir ? await readDiskVersion(installDir) : undefined;
        const still = matchAdvisories(parsed.entries, diskAfter ?? opts.currentVersion);
        if (still.length === 0) state.active = undefined;
    } catch (e) {
        state.lastError = String(e);
        warnOnce(log, `check:${String(e)}`, `[advisory] check failed: ${String(e)}`);
    } finally {
        inFlight = false;
    }
}

export function startAdvisoryWatcher(opts: AdvisoryWatcherOptions): void {
    if (timer) return;
    loggerLog("info", `[advisory] watcher enabled (checking every ${CHECK_INTERVAL_MS / 1000 | 0}s, independent of auto-update)`);
    setTimeout(() => {
        void runAdvisoryCheck(opts);
    }, 10_000);
    timer = setInterval(() => {
        void runAdvisoryCheck(opts);
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
}

/** Stop the periodic check loop (for tests / clean shutdown). */
export function stopAdvisoryWatcher(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}
