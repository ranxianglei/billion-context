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
 *
 * #1588 — rollback-form advisories (target OLDER than the registry's latest,
 * whose affected range also covers latest) need two refinements:
 *  - the normal self-update loop must refuse to install a candidate covered
 *    by a freshly parsed affected range (advisoryBlocksVersion), so a clean
 *    disk is never pulled back into the defect and rolled out again
 *    (target↔latest ping-pong);
 *  - once the forced install lands, the banner/status stays up until the
 *    RUNNING version leaves the affected range — i.e. until a restart —
 *    because a rollback leaves disk < running and the stale-install machinery
 *    (#806/#811) is silent for that direction.
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

type AdvisoryState = {
    /** Set while an entry matches the local version (whether or not the
     *  forced install has succeeded yet). After a successful install it
     *  persists until the RUNNING version leaves the affected range — i.e.
     *  until a restart completes (#1588-B): a rollback install leaves disk <
     *  running, so the stale-install machinery is silent and this banner is
     *  the only persistent "restart bili" prompt. */
    active?: AdvisoryEntry & { currentVersion: string; pendingRestart?: boolean; installedVersion?: string };
    lastCheckAt?: number;
    lastError?: string;
    /** Entries from the most recent cleanly parsed document — consumed by
     *  advisoryBlocksVersion() so the normal self-update loop can refuse to
     *  install a candidate that falls inside an active affected range even
     *  when no advisory is active against THIS machine (#1588-A). Cleared on
     *  every unhealthy feed state (fetch/parse failure) and when the matched
     *  target cannot be installed (F2), so the block always fails open. */
    entries?: AdvisoryEntry[];
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

/** #1588-A: true when `version` falls inside any freshly parsed advisory's
 *  affected range. The normal self-update loop consults this BEFORE installing
 *  its candidate: a rollback-form advisory ({affected covers the registry's
 *  latest, target older}) leaves this machine's disk clean while latest stays
 *  affected — blindly following latest would pull the machine back into the
 *  defect and the watcher would roll it back again, ping-ponging every cycle.
 *  Fails open like everything else here: no fresh parse (feed unreachable or
 *  malformed) or an uninstallable target (F2) means no block. */
export function advisoryBlocksVersion(version: string): boolean {
    const entries = state.entries;
    if (!entries || entries.length === 0) return false;
    if (cannotResolveTarget(state.lastError)) return false;
    return matchAdvisories(entries, version).length > 0;
}

export function cannotResolveTarget(err: string | undefined): boolean {
    return typeof err === "string" && err.includes("cannot resolve");
}

/** Canonical one-sentence description of an active advisory (#1577), shared by
 *  every visibility surface (acp_status, /acp panel, bili doctor) so they
 *  cannot drift apart. When the pinned target is unresolvable on the registry
 *  (`lastError` says so) it falls back to @latest — mirroring the web banner's
 *  escape hatch — and notes that. */
export function describeAdvisory(active: AdvisoryEntry & { currentVersion: string }, lastError: string | undefined): string {
    const failed = cannotResolveTarget(lastError);
    const target = failed ? "latest" : active.target;
    const fallback = failed ? " (pinned target unresolvable — use latest)" : "";
    return `[${active.id}] version ${active.currentVersion} is affected (${active.reason}) — upgrade to ${target}: npm install -g billion-context@${target}${fallback}`;
}

/** Test seam: clear state, warn dedupe, and stop the timer. */
export function _resetAdvisoryWatcherForTest(): void {
    state = {};
    warnedKeys.clear();
    firstCheckDone = false;
    watcherStarted = false;
    feedConsulted = false;
    stopAdvisoryWatcher();
}

/** Test seam: replace the live advisory state (surfaces read it via
 *  getAdvisoryState()) without driving the watcher. */
export function _setAdvisoryStateForTest(s: AdvisoryState): void {
    state = s;
}

/** Test seam: set the watcher-started flag without scheduling the real timer,
 *  so advisoryAwaitingFirstCheck()'s startup window can be driven
 *  deterministically (#2456). */
export function _setAdvisoryWatcherStartedForTest(v: boolean): void {
    watcherStarted = v;
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

type AdvisoryWatcherOptions = {
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
// #2456: startup-window tracking for the normal self-update loop's fail-safe
// deferral. `watcherStarted` arms when startAdvisoryWatcher schedules the
// loop; `feedConsulted` latches true once runAdvisoryCheck has finished its
// FIRST feed consultation this process (success OR fail-open failure — either
// way state.entries / lastError now reflect a real fetch, so
// advisoryBlocksVersion is meaningful). advisoryAwaitingFirstCheck() is true
// only in the window between the two.
let watcherStarted = false;
let feedConsulted = false;

/** #2456: true while the advisory watcher is running but has not yet
 *  completed its first feed consultation this process. The normal self-update
 *  loop consults this (via an injected predicate) to defer installing the
 *  registry latest until the advisory candidate gate (#1588-A) can actually
 *  see a freshly parsed affected range: after a restart onto a clean version a
 *  rollback-form advisory covers the registry latest while leaving this disk
 *  clean, and the gate is blind until the advisory's first check lands —
 *  installing before then pulls the machine back into the defect and the
 *  watcher rolls it back again (ping-pong). False when the watcher is not
 *  running (advisoryCheck off), so auto-update-only installs never defer
 *  forever; false once the first check has consulted the feed (success or
 *  fail-open). */
export function advisoryAwaitingFirstCheck(): boolean {
    return watcherStarted && !feedConsulted;
}

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
            // Fail-open the candidate block too (#1588-A): an unreachable feed must
            // never keep gating the normal self-update loop on stale data.
            state.entries = undefined;
            warnOnce(log, `fetch:${String(e)}`, `[advisory] check failed (${String(e)}) — continuing without advisories`);
            return;
        }

        const parsed = parseAdvisoryDoc(data);
        if (parsed.error) {
            state.lastError = parsed.error;
            state.entries = undefined;
            warnOnce(log, `parse:${parsed.error}`, `[advisory] ignoring malformed advisory document: ${parsed.error}`);
            return;
        }
        state.lastError = undefined;
        state.entries = parsed.entries;

        const installDir = opts.installDir ?? (await findInstallDir(opts.packageName));
        const diskVersion = installDir ? await readDiskVersion(installDir) : undefined;
        const currentVersion = diskVersion ?? opts.currentVersion;
        const matched = matchAdvisories(parsed.entries, currentVersion);
        state.lastCheckAt = Date.now();
        if (matched.length === 0) {
            // #1588-B: the disk copy left the affected range (forced install
            // landed) but the RUNNING process may still execute an affected
            // version — and with a rollback install (disk < running) the
            // stale-install machinery is silent. Keep the banner alive until
            // a restart completes instead of clearing it silently.
            const runningMatched = matchAdvisories(parsed.entries, opts.currentVersion);
            if (runningMatched.length === 0) {
                state.active = undefined;
                return;
            }
            const adv = runningMatched[0];
            state.active = { ...(state.active ?? { ...adv, currentVersion: opts.currentVersion }), pendingRestart: true, installedVersion: diskVersion };
            // Distinct warnOnce key from the "forcing update" line: both use
            // adv.id as the user-facing id, but a rollback-form advisory emits
            // them in sequence in ONE process (force the target, then keep the
            // restart hint alive) — sharing the key would dedupe the restart
            // hint away and leave the rollback silent in the log (#1588-B).
            warnOnce(log, `${adv.id}:restart`, `[advisory] ⚠️ ${adv.id}: running version ${opts.currentVersion} is affected (${adv.reason}) while the on-disk version ${diskVersion ?? "?"} is outside the range — restart bili to finish`);
            return;
        }
        const adv = matched[0];
        const active = { ...adv, currentVersion };
        state.active = active;
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
            // F2: an uninstallable target must not leave this entry's ranges
            // gating the normal loop either — release the candidate block the
            // same way advisoryDeferring() releases the deferral.
            if (cannotResolveTarget(result.error)) state.entries = undefined;
            return;
        }
        // Install landed: re-evaluate against the RUNNING version, not the
        // disk — the process keeps executing the old code until a restart,
        // and a rollback leaves disk < running so the stale-install machinery
        // is silent (#1588-B). Clears on the first check after the restart.
        const diskAfter = installDir ? await readDiskVersion(installDir) : undefined;
        if (matchAdvisories(parsed.entries, opts.currentVersion).length === 0) {
            state.active = undefined;
        } else {
            state.active = { ...active, pendingRestart: true, installedVersion: diskAfter ?? adv.target };
        }
    } catch (e) {
        state.lastError = String(e);
        warnOnce(log, `check:${String(e)}`, `[advisory] check failed: ${String(e)}`);
    } finally {
        inFlight = false;
        // #2456: reaching here means a check has reached (and attempted) the
        // feed — success or fail-open either way leaves state.entries
        // meaningful, so release the update loop's first-cycle deferral. The
        // throttle-return path can only fire on a LATER check (firstCheckDone
        // already true), by which point an earlier check consulted the feed;
        // the very first check always proceeds past the gate to fetch.
        feedConsulted = true;
    }
}

export function startAdvisoryWatcher(opts: AdvisoryWatcherOptions): void {
    if (timer) return;
    watcherStarted = true; // #2456: open the "awaiting first check" window for the update loop's fail-safe deferral
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
function stopAdvisoryWatcher(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}

export type AdvisoryEvaluation = {
    /** Set when `version` falls inside an entry's affected range. */
    active?: AdvisoryEntry & { currentVersion: string };
    /** Set when the source fetch or parse failed — callers report "unknown". */
    error?: string;
};

/** Read-only advisory evaluation (#1577): fetch + validate + match against
 *  `version`, with NO install side effects and NO in-process state mutation.
 *  Used by `bili doctor`, which runs in its own process where the watcher's
 *  module state is empty. Fail-open like runAdvisoryCheck — an unreachable or
 *  malformed source yields `{ error }`, never a throw. */
export async function evaluateAdvisories(opts: {
    version: string;
    advisoryUrl?: string;
    resolveProxy?: (url: string) => string | undefined;
}): Promise<AdvisoryEvaluation> {
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
        if (!res.ok) return { error: `advisory source returned HTTP ${res.status}` };
        data = await res.json();
    } catch (e) {
        return { error: String(e) };
    }
    const parsed = parseAdvisoryDoc(data);
    if (parsed.error) return { error: parsed.error };
    const matched = matchAdvisories(parsed.entries, opts.version);
    if (matched.length === 0) return {};
    return { active: { ...matched[0], currentVersion: opts.version } };
}
