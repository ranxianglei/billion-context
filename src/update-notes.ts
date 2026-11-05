/**
 * Tiered release-notes visibility (#1870, display policy #1977).
 *
 * The npm companion package `billion-context-release-notes` (published by CI
 * from this repo's release-notes/ directory, exactly like the advisories
 * companion) carries one model-written summary per release with a tier label:
 *   - routine      — default; worth having, no urgency. Never user-visible.
 *   - recommended  — worth restarting soon; RECORD-ONLY since #1977 — a
 *                    release log, not a nag. Never user-visible.
 *   - critical     — fixes a serious defect users must act on (correctness /
 *                    data / billing class) yet below the advisory bar. The
 *                    ONLY tier that surfaces (#1977: silent by default).
 * Force-upgradeable critical defects stay in the ADVISORY doc (#1481) — it
 * remains the only authoritative source for forced updates; entries here
 * never trigger the safety chain, they only make the update visible.
 *
 * Why a watcher at all: the self-updater is a silent courier — it downloads a
 * new version and writes one log line ("Restart to finish") that native-lane
 * users (pi/opencode/dsh) never see, so disk runs new while the process runs
 * old for days. This module keeps the state the visibility surfaces
 * (acp_status, the /acp panel) read: the running version, the disk version
 * (restart pending = disk newer than running), and the release notes SPAN —
 * every entry strictly newer than the running version. The disk version
 * determines which fixes a restart can deliver.
 *
 * Fail-open everywhere: an unreachable or malformed source must never degrade
 * a working proxy. No install side effects here — visibility only.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { cacheDir } from "./paths.js";
import { log as loggerLog, type Logger } from "./logger.js";
import type { FetchOptions } from "./fetch-util.js";
import { CHECK_INTERVAL_MS, egressDispatcher, findInstallDir, readDiskVersion, registryUrlFor } from "./update.js";

const RELEASE_NOTES_PACKAGE = "billion-context-release-notes";
const SUPPORTED_SCHEMA = 1;
/** Producer-side cap (release-notes/README): the doc keeps ~20 entries. */
const MAX_RELEASE_NOTES_ENTRIES = 20;

type ReleaseTier = "routine" | "recommended" | "critical";

export type ReleaseNoteEntry = {
    /** Exact released version this entry describes. */
    version: string;
    /** ISO date (YYYY-MM-DD) of the release. */
    date?: string;
    tier: ReleaseTier;
    /** Model-written, user-meaningful one-liner (what changes for you). */
    summary: string;
    /** Optional Chinese one-liner (#3719 item4): web surfaces pick it when
     *  the UI locale is zh; /acp text stays English (compat boundary). */
    summaryZh?: string;
    /** Optional targeting (#3719 item4): only RUNNING versions inside
     *  [minVersion, maxVersion] (inclusive) see this entry. Unset =
     *  everyone — historic entries keep their default reach untouched. */
    minVersion?: string;
    maxVersion?: string;
};

type ReleaseNotesState = {
    /** Newest-first as published; empty until the first successful check. */
    entries: ReleaseNoteEntry[];
    /** Disk version captured by the last watcher cycle (restart-pending
     *  signal: disk newer than the RUNNING version). */
    diskVersion?: string;
    lastCheckAt?: number;
    lastError?: string;
};

let state: ReleaseNotesState = { entries: [] };

/** Test seam: replace the live state without driving the watcher. */
export function _setReleaseNotesStateForTest(s: ReleaseNotesState): void {
    state = s;
}

/** Test seam: clear state, warn dedupe, and stop the timer. */
export function _resetReleaseNotesWatcherForTest(): void {
    state = { entries: [] };
    warnedKeys.clear();
    stopReleaseNotesWatcher();
}

/** Default source: the companion package's `latest` doc on the SAME
 *  configured registry as the updater (BILI_UPDATE_REGISTRY aware via
 *  registryUrlFor) — mirroring the advisory source. An explicit override wins
 *  verbatim. */
function resolveReleaseNotesUrl(configured: string | undefined): string {
    const v = configured?.trim();
    if (v) return v;
    return registryUrlFor(RELEASE_NOTES_PACKAGE, "latest");
}

/** Validate the raw release-notes document (the companion package's packument
 *  entry, whose custom field carries the payload). Malformed entries are
 *  skipped individually; a document with entries but zero usable ones is an
 *  error so callers can distinguish "no notes" from "broken feed". */
export function parseReleaseNotesDoc(raw: unknown): { entries: ReleaseNoteEntry[]; error?: string } {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { entries: [], error: "document is not a JSON object" };
    }
    const payload = (raw as Record<string, unknown>).billionContextReleaseNotes;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return { entries: [], error: "missing billionContextReleaseNotes object" };
    }
    const p = payload as Record<string, unknown>;
    if (p.schema !== SUPPORTED_SCHEMA) {
        return { entries: [], error: `unsupported schema ${String(p.schema)} (supported: ${SUPPORTED_SCHEMA})` };
    }
    if (!Array.isArray(p.releases)) {
        return { entries: [], error: "releases field is not an array" };
    }
    const entries: ReleaseNoteEntry[] = [];
    for (const item of p.releases) {
        if (typeof item !== "object" || item === null) continue;
        const e = item as Record<string, unknown>;
        const version = typeof e.version === "string" ? e.version.trim() : "";
        const tier = e.tier === "recommended" || e.tier === "routine" || e.tier === "critical" ? e.tier : undefined;
        const summary = typeof e.summary === "string" ? e.summary.trim() : "";
        const summaryZh = typeof e.summaryZh === "string" ? e.summaryZh.trim() : "";
        const minVersion = typeof e.minVersion === "string" ? e.minVersion.trim() : "";
        const maxVersion = typeof e.maxVersion === "string" ? e.maxVersion.trim() : "";
        if (!semver.valid(version) || tier === undefined || !summary) continue;
        if (minVersion && !semver.valid(minVersion)) continue;
        if (maxVersion && !semver.valid(maxVersion)) continue;
        if (minVersion && maxVersion && semver.gt(minVersion, maxVersion)) continue;
        entries.push({
            version,
            tier,
            summary,
            ...(summaryZh ? { summaryZh } : {}),
            ...(minVersion ? { minVersion } : {}),
            ...(maxVersion ? { maxVersion } : {}),
            ...(typeof e.date === "string" && e.date.trim() ? { date: e.date.trim() } : {}),
        });
    }
    if (p.releases.length > 0 && entries.length === 0) {
        return { entries: [], error: "no valid release-note entries in document" };
    }
    return { entries };
}

/** The notes a caller RUNNING `fromVersion` would gain — every entry strictly
 *  newer, ordered oldest→newest so the span reads chronologically ("you'll
 *  get 0.1.180, then 0.1.181"). This is the user-side diff between the
 *  current version and the newest release. Invalid `fromVersion` → empty. */
export function spanNotes(entries: ReleaseNoteEntry[], fromVersion: string): ReleaseNoteEntry[] {
    if (!semver.valid(fromVersion)) return [];
    return entries
        .filter((e) => {
            try {
                if (!semver.gt(e.version, fromVersion)) return false;
                // #3719 item4: optional targeting — the entry only reaches
                // RUNNING versions inside [minVersion, maxVersion] (inclusive).
                // Unset bounds keep the pre-targeting reach (compat).
                if (e.minVersion !== undefined && semver.lt(fromVersion, e.minVersion)) return false;
                if (e.maxVersion !== undefined && semver.gt(fromVersion, e.maxVersion)) return false;
                return true;
            } catch {
                return false;
            }
        })
        .sort((a, b) => semver.compare(a.version, b.version));
}

type UpdateVisibility = {
    runningVersion: string;
    /** Disk version if the watcher saw one (undefined = unknown). */
    diskVersion?: string;
    /** Disk holds a strictly newer version than this process — a restart
     *  loads that version; newer critical fixes may still need installation. */
    pendingRestart: boolean;
    /** Notes for everything between running and the newest known release. */
    span: ReleaseNoteEntry[];
    /** A critical-tier entry sits in the span — the only thing that surfaces
     *  (#1977): a serious-defect release tells the user even without a
     *  pending restart (e.g. auto-update disabled), and a pending restart is
     *  only announced when the pending span contains one. */
    critical: boolean;
};

/** Derived, synchronous view for the visibility surfaces (#1870): reads the
 *  watcher's cached state — no network, no fs. Clean installs, routine-only
 *  spans and recommended-only spans all yield visible=false (#1977: silent
 *  by default) and every surface stays byte-identical to the pre-#1870
 *  output. */
export function getUpdateVisibility(runningVersion: string): UpdateVisibility & { visible: boolean } {
    const diskVersion = state.diskVersion;
    const pendingRestart =
        diskVersion !== undefined &&
        semver.valid(diskVersion) === diskVersion &&
        semver.gt(diskVersion, runningVersion);
    const span = spanNotes(state.entries, runningVersion);
    const critical = span.some((e) => e.tier === "critical");
    return {
        runningVersion,
        ...(diskVersion !== undefined ? { diskVersion } : {}),
        pendingRestart,
        span,
        critical,
        visible: critical,
    };
}

/** Shared wording for the /acp panel line, acp_status and the web update
 *  banner — one line, stripper-safe slot is the caller's job. Kept compact:
 *  the panel is small, and acp_status carries the full span. Only ever
 *  rendered for critical spans (#1977); the final fallback branch exists for
 *  totality (invisible states never reach the surfaces, but the function
 *  must stay total for future callers). NEVER prescribes an install command:
 *  hosts differ (npm -g / opencode plugin / dsh / pi) and the wrong hint is
 *  worse than none — name the version, let the client's own docs say how. */
export function describeUpdateReady(v: UpdateVisibility): string {
    const action = updateBannerPayload({ ...v, visible: v.critical });
    if (action?.kind === "ready") {
        return `Critical update ready: ${action.version} — restart to finish. Critical fix since ${v.runningVersion}: ${action.summary}`;
    }
    if (action?.kind === "available") {
        return `Critical update available: ≥ ${action.version} — ${action.summary}`;
    }
    const latest = v.span.length > 0 ? v.span[v.span.length - 1].version : v.diskVersion;
    return `Update available: ${latest ?? "newer version"}.`;
}

/** Localizable wire payload for the web update banner (#1870 web surface):
 *  the SERVER must not bake an English sentence — the UI ships zh + en, so
 *  it sends kind/version/summary and lets i18n compose the sentence
 *  ("upgrade to v{version} or newer", separately translated per locale).
 *  available → version = the MINIMUM version carrying the critical fix
 *  (first critical not yet installed; anything ≥ it carries that fix).
 *  ready     → version = the on-disk version a restart delivers.
 *  null when the span is invisible (#1977: routine/recommended stay silent). */
export function updateBannerPayload(v: UpdateVisibility & { visible: boolean }): { kind: "available" | "ready"; version: string; summary: string; summaryZh?: string } | null {
    if (!v.visible) return null;
    const criticals = v.span.filter((e) => e.tier === "critical");
    const first = criticals[0];
    const newest = criticals[criticals.length - 1] ?? first;
    if (first === undefined || newest === undefined) return null; // defensive: visible implies a critical, but stay total
    if (v.pendingRestart && v.diskVersion !== undefined) {
        const diskVersion = v.diskVersion;
        const missing = criticals.find((e) => semver.gt(e.version, diskVersion));
        if (missing) return { kind: "available", version: missing.version, summary: missing.summary, ...(missing.summaryZh ? { summaryZh: missing.summaryZh } : {}) };
        return { kind: "ready", version: v.diskVersion, summary: newest.summary, ...(newest.summaryZh ? { summaryZh: newest.summaryZh } : {}) };
    }
    return { kind: "available", version: first.version, summary: first.summary, ...(first.summaryZh ? { summaryZh: first.summaryZh } : {}) };
}

function throttleFile(): string {
    return path.join(cacheDir(), ".release-notes-check");
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

type ReleaseNotesWatcherOptions = {
    packageName: string;
    /** Running process version (disk wins when readable, same rule as the
     *  updater). */
    currentVersion: string;
    /** Override for the notes document URL (config `releaseNotesUrl` / env
     *  BILI_RELEASE_NOTES_URL). Absent = companion package on the configured
     *  registry. */
    releaseNotesUrl?: string;
    resolveProxy?: (url: string) => string | undefined;
    /** Test seam: pin the install directory instead of findInstallDir(). */
    installDir?: string;
    log?: Logger;
};

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let firstCheckDone = false;
const warnedKeys = new Set<string>();

function warnOnce(log: Logger, key: string, message: string): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    log("warn", message);
}

/** Run one release-notes check (throttled unless `force`). Fetches the notes
 *  doc and re-reads the disk version — visibility only, NEVER installs. */
async function runReleaseNotesCheck(opts: ReleaseNotesWatcherOptions, force = false): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const log = opts.log ?? loggerLog;
    try {
        const now = Date.now();
        const lastCheck = await readLastCheck();
        if (!force && firstCheckDone && now - lastCheck < CHECK_INTERVAL_MS) return;
        await writeLastCheck(now);
        firstCheckDone = true;

        const url = resolveReleaseNotesUrl(opts.releaseNotesUrl);
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
            if (!res.ok) throw new Error(`release-notes source returned HTTP ${res.status}`);
            data = await res.json();
        } catch (e) {
            state.lastError = String(e);
            warnOnce(log, `fetch:${String(e)}`, `[release-notes] check failed (${String(e)}) — continuing without release notes`);
            return;
        }
        const parsed = parseReleaseNotesDoc(data);
        if (parsed.error) {
            state.lastError = parsed.error;
            warnOnce(log, `parse:${parsed.error}`, `[release-notes] ignoring malformed document: ${parsed.error}`);
            return;
        }
        state.entries = parsed.entries.slice(0, MAX_RELEASE_NOTES_ENTRIES);
        state.lastError = undefined;
        state.lastCheckAt = now;

        // Restart-pending signal: disk vs the RUNNING process version.
        const installDir = opts.installDir ?? (await findInstallDir(opts.packageName));
        state.diskVersion = installDir ? await readDiskVersion(installDir) : undefined;
    } catch (e) {
        state.lastError = String(e);
        warnOnce(log, `check:${String(e)}`, `[release-notes] check failed: ${String(e)}`);
    } finally {
        inFlight = false;
    }
}

export function startReleaseNotesWatcher(opts: ReleaseNotesWatcherOptions): void {
    if (timer) return;
    loggerLog("info", `[release-notes] watcher enabled (checking every ${CHECK_INTERVAL_MS / 1000 | 0}s, visibility only — never installs)`);
    setTimeout(() => {
        void runReleaseNotesCheck(opts);
    }, 15_000);
    timer = setInterval(() => {
        void runReleaseNotesCheck(opts);
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
}

/** Stop the periodic check loop (for tests / clean shutdown). */
function stopReleaseNotesWatcher(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}
