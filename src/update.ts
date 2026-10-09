/**
 * Auto-update: periodically checks the npm registry for a newer version of
 * billion-context and installs it by downloading the tarball and extracting
 * it over the current installation.
 *
 * Why tarball (not `npm install -g`):
 *  - Users may not have installed via npm (homebrew, manual, etc.).
 *  - `npm install -g` needs global write permissions and may fail silently.
 *  - Tarball extraction works for any install location, as long as the
 *    install directory is writable.
 *
 * Concurrency safety:
 *  - An exclusive lock file prevents multiple bili processes from updating
 *    simultaneously.
 *  - Extraction goes to a temp staging directory first, then copies over
 *    the install dir only after extraction + verification succeed.
 *
 * Version detection reads package.json from disk on every check (not a startup
 * constant), so after a successful in-place update the next check sees the new
 * version and stops trying. No notified Set — failed installs retry next
 * cycle automatically.
 */
import { readFile, writeFile, mkdir, access, constants, rm, cp, unlink, lstat, stat, rename, mkdtemp, readdir } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import crypto from "node:crypto";
import * as tar from "tar";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { safeSuffix } from "./text-safe.js";
import { cacheDir } from "./paths.js";
import { log as loggerLog, type Logger } from "./logger.js";
import { refreshDshProfileBundles, isDshProfileCopy, dshProfileDirs, dshProfileDependsOnBili, dshProfileDepSpec, isRegistryDepSpec, DSH_PACKAGE, DSH_DESKTOP_PROFILE } from "./dsh-channel.js";
import { isPiNpmCopy, piNpmEntrySpec, runPiAsync, PI_NPM_SPEC } from "./pi-channel.js";
import { resolveDshHome, resolveKimiHome, resolveOmpHome, resolvePiHome } from "./client-config.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import type { FetchOptions } from "./fetch-util.js";
import { updateRegistryBase as knobUpdateRegistryBase, updateCheckIntervalMs as knobUpdateCheckIntervalMs } from "./knobs.js";

// BILI_UPDATE_REGISTRY overrides the registry base URL (full URL, e.g. a
// loopback verdaccio in the hermetic e2e suite, #1153). Unset = production
// default, behavior unchanged.
/** Normalize a configured registry base URL: absent/blank → production default; trailing slashes dropped (npm normalizes them too). */
export function normalizeRegistryBase(raw: string | undefined): string {
    const v = raw?.trim();
    if (!v) return "https://registry.npmjs.org";
    return v.replace(/\/+$/, "");
}
const REGISTRY_BASE = normalizeRegistryBase(knobUpdateRegistryBase());

/** Normalize a configured dist-tag channel: absent/blank → "latest". */
export function normalizeUpdateTag(tag: string | undefined): string {
    return (tag ?? "latest").trim() || "latest";
}

/** Registry URL for a package's dist-tag document (exported for tests). */
export function registryUrlFor(packageName: string, tag: string): string {
    return `${REGISTRY_BASE}/${packageName}/${encodeURIComponent(tag)}`;
}
// update.checkIntervalMs / BILI_UPDATE_CHECK_INTERVAL_MS override the check
// period in ms (must be > 0) so the hermetic e2e suite need not wait 3 minutes
// (#1153). Unset = default. Resolved once at import: the updater's own cadence
// is process-lifetime, and the e2e suites set it in the child process env.
export const CHECK_INTERVAL_MS = knobUpdateCheckIntervalMs();
const THROTTLE_FILE = path.join(cacheDir(), ".update-check");
// #2192: host-managed instances (dsh profile copies, pi npm dir) throttle on a
// SEPARATE marker. The machine-global .update-check is written by every bili
// copy, so sharing one marker starves whichever instance has the slower
// cadence whenever the faster one runs.
const OWNER_THROTTLE_FILE = path.join(cacheDir(), ".owner-update-check");
const LOCK_FILE = path.join(cacheDir(), ".update-lock");

// #2192: owner-managed lanes are non-critical background housekeeping — they do
// not need the global 3-min cadence, and a persistently failing lane used to
// burn a full tarball download (desktop) or a CLI spawn per cycle forever.
// Host-managed instances therefore throttle their own check at 10 min base +
// up to 5 min jitter (jitter de-syncs fleets so a registry blip does not turn
// into a synchronized retry storm). Deliberately a fixed constant, not a config
// knob: no user-facing surface for a lane nobody tunes (Configuration Surface
// Discipline); revisit only with explicit owner sign-off. Cadence set by owner
// (2026-10-07, #2305 review): 30 min held broken host copies stale for too long
// relative to the check cost (a few-KB version-doc fetch).
const OWNER_LANE_CHECK_BASE_MS = 10 * 60 * 1000;
const OWNER_LANE_CHECK_JITTER_MS = 5 * 60 * 1000;

/** Pure interval decision for the owner-lane throttle — exported for tests. */
export function ownerLaneIntervalMs(rand: () => number = Math.random): number {
    return OWNER_LANE_CHECK_BASE_MS + Math.floor(rand() * OWNER_LANE_CHECK_JITTER_MS);
}
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

/** Age after which a lock is stealable even if kill(pid,0) says the holder is
 *  "alive": a real install never takes this long, and a crashed holder whose
 *  pid was reused by an unrelated process looks alive forever. Without this
 *  cap, one such residue permanently blocks all future auto-updates. (#117) */
const LOCK_MAX_AGE_MS = 30 * 60 * 1000;

/** Upper bound on the lifetime of per-invocation update temp artifacts. A
 *  real install never takes this long (same reasoning as LOCK_MAX_AGE_MS), so
 *  anything older is an orphan of a crashed run — unique temp names mean
 *  nothing else will ever clean it up (#2106). */
const UPDATE_TMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Pure steal decision for the update lock — exported for tests.
 *  Dead holders are always stealable; live holders only past LOCK_MAX_AGE_MS. */
export function shouldStealLock(holderAlive: boolean, ageMs: number): boolean {
    return !holderAlive || ageMs >= LOCK_MAX_AGE_MS;
}

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let firstCheckDone = false;
// #806: dedupe key for the stale-install reminder (version pair).
let staleWarnKey: string | undefined;

export function _resetStaleWarnForTest(): void {
    staleWarnKey = undefined;
}

// #1481: per-process dedupe for advisory force-install refusals/failures. The
// advisory watcher retries every cycle while an entry matches, so without this
// a persistent refusal (source checkout, host-managed lane, bad target) would
// log a fresh warning every cycle forever. Keyed by advisory id + message.
const advisoryRefusalWarnKeys = new Set<string>();

export function _resetAdvisoryRefusalWarnsForTest(): void {
    advisoryRefusalWarnKeys.clear();
}

// The throttle files are resolved once at module load, so every test in a
// process shares one throttle state — non-forced checkForUpdate tests must
// reset them or they inherit the previous test's "last checked" timestamp.
export async function _resetUpdateThrottleForTest(): Promise<void> {
    firstCheckDone = false;
    await rm(THROTTLE_FILE, { force: true });
    await rm(OWNER_THROTTLE_FILE, { force: true });
}

function warnAdvisoryOnce(advisoryId: string, message: string): void {
    const key = `${advisoryId}\u0000${message}`;
    if (advisoryRefusalWarnKeys.has(key)) return;
    advisoryRefusalWarnKeys.add(key);
    loggerLog("warn", message);
}

// #1603: bounded retry for persistent install failures. Pre-fix, a failing
// install (unwritable dir, host-managed lane) re-downloaded and re-failed every
// 3-min cycle for days (124× over 12 days in the field) with no backoff or
// remediation. Keyed on (installDir, targetVersion) for the global lane and on
// owner:<lane>:<version> for the owner-managed lanes (#2192 — they used to
// bypass this machinery entirely and retry, the desktop one re-downloading the
// full tarball, every 3-min cycle forever): consecutive failures grow an
// exponential cooldown during which the attempt is skipped silently; a success
// resets its own key. Backoff (not hard self-disable) keeps the path
// self-healing if the dir becomes writable / the layout repaired later.
const BACKOFF_THRESHOLD = 3;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

interface InstallBackoff {
    count: number;
    nextRetryAt: number;
    /** When this entry was last touched — ages out stale below-threshold
     *  streaks that never armed a cooldown (nextRetryAt stays 0 for them). */
    updatedAt: number;
}
// #2192: one entry per key — the global lane and each owner lane carry
// independent failure streaks, so a single shared slot could not serve them
// (one lane's streak would mask or wipe another's).
const installBackoffs = new Map<string, InstallBackoff>();
const installBackoffRemediatedKeys = new Set<string>();

// #2192 follow-up: streaks are shared across ALL bili copies on the machine
// via a small JSON state file in the cache dir. The map alone is per-process,
// so k running instances (global + one proxy per dsh profile) each carried an
// independent 3-strike budget and multiplied the retry rate k×. The file is
// the cross-process carrier; the in-memory map is a write-through cache.
// Sharing is cooperative, not locked, and every failure mode biases toward
// RETRYING, never toward silence: unreadable/corrupt file → treated empty,
// entries whose nextRetryAt is beyond now+cap (jumped clock, bit rot) →
// dropped so the lane re-arms, stale entries → pruned. Bad state on disk can
// never permanently stop an update lane. Writers merge with what is on disk
// (they never stomp entries another process armed) and write atomically
// (tmp+rename) so a concurrent reader never sees a torn file; long-lived
// processes re-read the file when its mtime moves so a manual disarm by one
// copy is visible to the others on their next gate check.
const BACKOFF_STATE_FILE = path.join(cacheDir(), ".install-backoff.json");
// Entries untouched for a week are gone for good: every cooldown is capped at
// 6 h, so a week-old entry can only be residue of a dead version key.
const BACKOFF_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
let backoffsLoaded = false;
// -1 = never looked, 0 = confirmed absent (or unreadable at last look), >0 =
// the mtime we last incorporated into the in-memory map.
let backoffFileMtime = -1;

interface PersistedBackoff {
    count: number;
    nextRetryAt: number;
    updatedAt: number;
}

function validatePersisted(val: unknown, now: number): PersistedBackoff | undefined {
    const b = val as { count?: unknown; nextRetryAt?: unknown; updatedAt?: unknown } | null;
    if (!b || typeof b !== "object") return undefined;
    if (typeof b.count !== "number" || typeof b.nextRetryAt !== "number" || typeof b.updatedAt !== "number") return undefined;
    if (!Number.isFinite(b.count) || !Number.isFinite(b.nextRetryAt) || !Number.isFinite(b.updatedAt)) return undefined;
    if (b.count <= 0) return undefined;
    // clock-skew / corruption guard: a cooldown beyond now+cap can only come
    // from a jumped clock or a damaged file. Drop it so the lane re-arms
    // instead of going silent for weeks.
    if (b.nextRetryAt > now + BACKOFF_CAP_MS) return undefined;
    // stale: untouched for a week → residue of a dead key.
    if (b.updatedAt < now - BACKOFF_PRUNE_MS) return undefined;
    return { count: b.count, nextRetryAt: b.nextRetryAt, updatedAt: b.updatedAt };
}

async function statBackoffFile(): Promise<number> {
    try {
        return (await stat(BACKOFF_STATE_FILE)).mtimeMs;
    } catch {
        return 0; // absent
    }
}

/** Best-effort read. `undefined` = absent or unreadable/corrupt (bias:
 *  retry). A parsed file always returns, even with zero valid entries. */
async function readBackoffFile(): Promise<{ mtime: number; entries: Map<string, PersistedBackoff> } | undefined> {
    const mtime = await statBackoffFile();
    if (mtime === 0) return undefined;
    let raw: string;
    try {
        raw = await readFile(BACKOFF_STATE_FILE, "utf-8");
    } catch {
        return undefined;
    }
    try {
        const doc = JSON.parse(raw) as { v?: unknown; entries?: unknown };
        if (!doc || typeof doc !== "object" || doc.v !== 1 || !doc.entries || typeof doc.entries !== "object" || Array.isArray(doc.entries)) return undefined;
        const now = Date.now();
        const entries = new Map<string, PersistedBackoff>();
        for (const [key, val] of Object.entries(doc.entries as Record<string, unknown>)) {
            const v = validatePersisted(val, now);
            if (v) entries.set(key, v);
        }
        return { mtime, entries };
    } catch {
        return undefined; // corrupt JSON → treated empty (bias: retry)
    }
}

/** Fold a successfully-read file into the in-memory map. File entries newer
 *  than ours (or unknown to us) win — another process armed them after our
 *  last look. A memory key ABSENT from the file was cleared or pruned by
 *  someone else (the file was rewritten after we last touched the key) —
 *  drop it so a manual disarm survives contact with other processes.
 *  `skipAdopt` keeps keys we are actively clearing from being adopted back
 *  from the stale file content. */
function mergeFromFile(f: { mtime: number; entries: Map<string, PersistedBackoff> }, skipAdopt?: Set<string>): void {
    for (const [key, v] of f.entries) {
        const m = installBackoffs.get(key);
        if (m ? v.updatedAt > m.updatedAt : !skipAdopt?.has(key)) installBackoffs.set(key, v);
    }
    for (const [key, m] of [...installBackoffs]) {
        if (!f.entries.has(key) && f.mtime > m.updatedAt) installBackoffs.delete(key);
    }
    backoffFileMtime = f.mtime;
}

async function ensureBackoffsLoaded(): Promise<void> {
    if (backoffsLoaded) return;
    backoffsLoaded = true;
    const f = await readBackoffFile();
    if (!f) {
        backoffFileMtime = 0;
        return;
    }
    mergeFromFile(f);
}

/** #2206 follow-up: long-lived proxies load the file once; without this a
 *  manual `bili plugin update` disarm by ANOTHER process would stay invisible
 *  to them until restart (≤6 h self-heal). Gate checks are infrequent
 *  (minutes apart), so a stat-per-gate is cheap. Only a successfully parsed
 *  NEWER file can drop keys; unreadable/corrupt keeps memory (bias: retry).
 *  An absent file after we had seen one means someone cleared it (the empty
 *  map is rm'd by the writer) → drop everything. */
async function syncBackoffsIfFileChanged(): Promise<void> {
    const mtime = await statBackoffFile();
    if (mtime === backoffFileMtime) return;
    const f = await readBackoffFile();
    if (f) {
        mergeFromFile(f);
        return;
    }
    if (backoffFileMtime > 0 && mtime === 0) installBackoffs.clear();
    backoffFileMtime = mtime;
}

/** Write the merged state atomically (tmp+rename) so a concurrent reader
 *  never sees a torn file. Never rejects — an unwritable cache dir degrades
 *  to per-process memory (bias: retry). */
async function persistBackoffs(skipAdopt?: Set<string>): Promise<void> {
    try {
        // merge first: never stomp entries another process armed, and drop
        // keys another process cleared (bounded races here only delay a
        // manual disarm by one cycle — never silence a lane).
        const f = await readBackoffFile();
        if (f) mergeFromFile(f, skipAdopt);
        const now = Date.now();
        const entries: Record<string, PersistedBackoff> = {};
        let live = 0;
        for (const [key, b] of installBackoffs) {
            if (b.updatedAt < now - BACKOFF_PRUNE_MS) continue; // prune stale on write
            entries[key] = { count: b.count, nextRetryAt: b.nextRetryAt, updatedAt: b.updatedAt };
            live += 1;
        }
        await mkdir(path.dirname(BACKOFF_STATE_FILE), { recursive: true });
        if (live === 0) {
            await rm(BACKOFF_STATE_FILE, { force: true });
            backoffFileMtime = 0;
        } else {
            const tmp = `${BACKOFF_STATE_FILE}.${process.pid}.tmp`;
            await writeFile(tmp, JSON.stringify({ v: 1, entries }), "utf-8");
            await rename(tmp, BACKOFF_STATE_FILE); // atomic swap
            backoffFileMtime = await statBackoffFile();
        }
    } catch {
        // best-effort: an unwritable cache dir degrades to per-process memory
    }
}

export async function _resetInstallBackoffForTest(): Promise<void> {
    installBackoffs.clear();
    installBackoffRemediatedKeys.clear();
    backoffsLoaded = false;
    backoffFileMtime = -1;
    await rm(BACKOFF_STATE_FILE, { force: true });
}

/** Test-only: simulate a fresh process — forget the in-memory map and the
 *  loaded flag WITHOUT touching the state file, so the next gate re-loads
 *  from disk (cross-process sharing assertions). */
export function _reloadBackoffsForTest(): void {
    installBackoffs.clear();
    installBackoffRemediatedKeys.clear();
    backoffsLoaded = false;
    backoffFileMtime = -1;
}

/** Test-only snapshot of the live backoff entries (key → streak state). */
export function _installBackoffStateForTest(): Record<string, { count: number; nextRetryAt: number }> {
    const out: Record<string, { count: number; nextRetryAt: number }> = {};
    for (const [key, b] of installBackoffs) out[key] = { count: b.count, nextRetryAt: b.nextRetryAt };
    return out;
}

function backoffKey(installDir: string | undefined, version: string): string {
    return `${installDir ?? "<unknown-install-dir>"}\u0000${version}`;
}

/** #2192: per-lane keys for the owner-managed update lanes. Version-scoped like
 *  backoffKey, so a new release re-arms a backed-off lane automatically. */
export function ownerLaneKey(lane: "dsh-desktop" | "dsh-profile" | "pi-npm", version: string): string {
    return `owner:${lane}:${version}`;
}

async function backoffInCooldown(key: string): Promise<boolean> {
    await ensureBackoffsLoaded();
    await syncBackoffsIfFileChanged();
    const b = installBackoffs.get(key);
    return !!b && Date.now() < b.nextRetryAt;
}

/** Test-only: run a gate check for one key (load + mtime sync + check). */
export async function _backoffCooldownForTest(key: string): Promise<boolean> {
    return backoffInCooldown(key);
}

async function clearInstallBackoff(key: string): Promise<void> {
    await ensureBackoffsLoaded();
    const had = (installBackoffs.delete(key) ? 1 : 0) | (installBackoffRemediatedKeys.delete(key) ? 1 : 0);
    // skipAdopt: do not read the key we are clearing back from the file —
    // the on-disk copy is stale by exactly this clear.
    if (had) await persistBackoffs(new Set([key]));
}

/** #2192: manual repair hook — `bili plugin update`'s dsh lane calls this on
 *  a clean run so a successful manual fix immediately disarms the lane's
 *  cooldown instead of waiting out the window (up to 6 h). */
export async function clearOwnerLaneBackoff(lane: "dsh-desktop" | "dsh-profile" | "pi-npm", version: string): Promise<void> {
    await clearInstallBackoff(ownerLaneKey(lane, version));
}

export function backoffMs(count: number): number {
    const exp = Math.max(0, count - BACKOFF_THRESHOLD);
    return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exp);
}

function remediationHint(error: string): string {
    if (/not writable/i.test(error)) {
        if (process.platform === "win32") {
            return "the install dir is not writable by this user. On Windows the default npm prefix (%APPDATA%\\npm) is user-writable \u2014 repair that dir's ownership/permissions and reinstall (npm install -g billion-context), or disable auto-update (config autoUpdate:false / env ACP_AUTO_UPDATE=0)";
        }
        return "the install dir is not writable by this user. Fix its ownership/permissions, or reinstall into a user-level prefix \u2014 npm install -g billion-context --prefix=\"$HOME/.local\" (put \"$HOME/.local/bin\" on PATH; pass --prefix again on future npm reinstalls) \u2014 or disable auto-update (config autoUpdate:false / env ACP_AUTO_UPDATE=0)";
    }
    if (/git working tree/i.test(error)) {
        return "this copy runs from a source checkout. Install globally instead (npm install -g billion-context) so auto-update has a writable target";
    }
    if (/managed by/i.test(error)) {
        return "this copy is managed by its host. Update it through the host's own channel rather than in place";
    }
    return "review the error above. Auto-update keeps retrying with an increasing delay";
}

// Names the literal-vs-real mismatch when the resolved install dir is a symlink
// to somewhere else (#1603: the updater can target a path whose real location
// differs, invisible without this). Empty when they match.
function installDirNote(installDir: string | undefined): string {
    if (!installDir) return "";
    try {
        const real = realpathSync(installDir);
        return real === installDir ? "" : ` (target ${installDir} resolves via symlink to ${real})`;
    } catch {
        return "";
    }
}

/** Record one failed attempt under `key`. `hint` overrides the generic
 *  remediationHint on the escalation line — owner lanes pass their own manual
 *  fix there (#2192); the global lane passes none and keeps today's wording. */
async function recordInstallFailure(key: string, error: string, installDir: string | undefined, hint?: string): Promise<void> {
    await ensureBackoffsLoaded();
    const now = Date.now();
    const b = installBackoffs.get(key) ?? { count: 0, nextRetryAt: 0, updatedAt: now };
    b.count += 1;
    b.updatedAt = now;
    if (b.count >= BACKOFF_THRESHOLD) {
        // arm BEFORE persisting: the persist merge must see the armed
        // nextRetryAt, not the pre-assignment value (=0, unarmed).
        b.nextRetryAt = now + backoffMs(b.count);
    }
    installBackoffs.set(key, b);
    await persistBackoffs(); // write-through even below threshold: crash-looping
    // processes never reach 3 strikes in one life, so early strikes must
    // survive restarts for the machine-wide budget to arm. Awaited so the
    // state file is on disk before the caller (and a test) looks at it.
    const note = installDirNote(installDir);
    if (b.count < BACKOFF_THRESHOLD) {
        loggerLog("warn", `[update] install failed: ${error}${note}. Will retry next cycle.`);
        return;
    }
    const waitMin = Math.round(backoffMs(b.count) / 60_000);
    if (!installBackoffRemediatedKeys.has(key)) {
        installBackoffRemediatedKeys.add(key);
        loggerLog("warn", `[update] install keeps failing (${b.count}\u00d7 in a row): ${error}${note}. ${hint ?? remediationHint(error)}. Backing off \u2014 next attempt in ~${waitMin}m.`);
        return;
    }
    loggerLog("warn", `[update] install failed: ${error}${note}. Still failing \u2014 next attempt in ~${waitMin}m.`);
}

// --- Version comparison (ported from opencode-acp lib/update.ts) ---
// Proper semver including prerelease ordering: a prerelease is OLDER than its
// release (0.1.46-pr.202.1 < 0.1.46), and prerelease parts compare
// numeric-then-lexicographic. The old 3-part numeric compare mis-ordered
// prereleases and multi-digit segments.
export function isVersionNewer(latest: string, current: string): boolean {
    const next = parseSemVer(latest);
    const prev = parseSemVer(current);
    if (!next || !prev) return false;

    for (let i = 0; i < 3; i++) {
        const a = next.parts[i] ?? 0;
        const b = prev.parts[i] ?? 0;
        if (a !== b) return a > b;
    }

    if (!next.pre.length && prev.pre.length) return true;
    if (next.pre.length && !prev.pre.length) return false;

    for (let i = 0; i < Math.max(next.pre.length, prev.pre.length); i++) {
        const a = next.pre[i];
        const b = prev.pre[i];
        if (a === undefined) return false;
        if (b === undefined) return true;
        if (a === b) continue;

        const aNumber = /^\d+$/.test(a) ? Number(a) : undefined;
        const bNumber = /^\d+$/.test(b) ? Number(b) : undefined;
        if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber;
        if (aNumber !== undefined) return false;
        if (bNumber !== undefined) return true;
        return a > b;
    }

    return false;
}

function parseSemVer(version: string): { parts: number[]; pre: string[] } | undefined {
    const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/);
    if (!match) return undefined;
    return {
        parts: [Number(match[1]), Number(match[2]), Number(match[3])],
        pre: match[4]?.split(".") ?? [],
    };
}

/** Stale-install decision for the up-to-date branch of an update check —
 *  exported for tests. "restart" means the on-disk install is newer than the
 *  running process: an auto-update landed in-place but the process was never
 *  restarted, so the one-time "Restart to finish" message is long gone and
 *  every "up to date" line since has been misleading (#327). */
export function staleInstallStatus(diskVersion: string | undefined, runningVersion: string): "restart" | "current" {
    return diskVersion !== undefined && isVersionNewer(diskVersion, runningVersion) ? "restart" : "current";
}

/** Up-to-date branch of an update check — returns true when the caller must
 *  stop (nothing to install). #806: the restart reminder dedupes per version
 *  pair so it no longer re-logs on every 180s check once the pair is known. */
export function reportNotNewer(
    latest: string,
    tag: string,
    diskVersion: string | undefined,
    runningVersion: string,
    log: Logger,
): boolean {
    const currentVersion = diskVersion ?? runningVersion;
    if (isVersionNewer(latest, currentVersion)) return false;
    if (staleInstallStatus(diskVersion, runningVersion) === "restart") {
        const key = `${runningVersion}->${diskVersion}`;
        if (key !== staleWarnKey) {
            staleWarnKey = key;
            log("warn", `[update] running v${runningVersion} but v${diskVersion} is installed — restart bili to activate (auto-update replaced the on-disk install; this process is still on the old code)`);
        }
    } else {
        staleWarnKey = undefined;
        log("info", `[update] current=${currentVersion} latest=${latest} tag=${tag} (up to date)`);
    }
    return true;
}

async function readLastCheck(file: string): Promise<number> {
    try {
        const data = await readFile(file, "utf-8");
        return parseInt(data.trim(), 10) || 0;
    } catch {
        return 0;
    }
}

async function writeLastCheck(file: string, ts: number): Promise<void> {
    try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, String(ts), "utf-8");
    } catch {
        // best-effort
    }
}

/** Last completed registry-check time (epoch ms) for diagnostics (#1235); undefined when never checked. Either throttle marker counts — market-only machines write the owner one (#2192). */
export async function lastUpdateCheckTime(): Promise<number | undefined> {
    const ts = Math.max(await readLastCheck(THROTTLE_FILE), await readLastCheck(OWNER_THROTTLE_FILE));
    return ts > 0 ? ts : undefined;
}

/** #1628: pure walk-up form of the install-dir resolution. From `startDir`,
 *  the nearest self-or-ancestor whose package.json `name` matches `packageName`.
 *  Two invariants pin the resolution-error class (#580/#1628): there is NO
 *  global/npm-root fallback — walking past the filesystem root without a match
 *  yields undefined (loud failure beats silently targeting another install) —
 *  and crossing into a DIFFERENT named package before matching means the
 *  running copy's own root is missing/corrupt, so the foreign ancestor is
 *  refused instead of adopted. Exported for tests. */
export async function findPackageRoot(startDir: string, packageName: string): Promise<string | undefined> {
    let dir = startDir;
    for (;;) {
        try {
            const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8"));
            const name = typeof pkg.name === "string" ? pkg.name : undefined;
            if (name === packageName) return dir;
            if (name !== undefined) return undefined;
        } catch {
            // not a package.json — keep walking
        }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/**
 * Walk up from this module's location until we find the directory whose
 * package.json `name` matches `packageName`. This is the install directory.
 * The running module's own path is the single source of truth — the copy
 * serving traffic is the copy that gets updated, and no global-prefix
 * fallback exists by design (#1628). Exported for the pre-re-exec gate (#811).
 */
export async function findInstallDir(packageName: string): Promise<string | undefined> {
    return findPackageRoot(path.dirname(fileURLToPath(import.meta.url)), packageName);
}

/** #1628: both sides of an install failure as one log fragment so the log
 *  alone answers "which copy is this process?": the resolved update target
 *  (plus its realpath when different — a symlink hop) and the running
 *  module's real path. Returns space-joined key=value pairs like
 *  `target=X real=Y running=Z`; `target=<unresolved>` when the walk found
 *  nothing. Exported for tests. */
export function describeInstallLocation(installDir: string | undefined, runningModule: string | undefined): string {
    const parts: string[] = [];
    if (installDir) {
        parts.push(`target=${installDir}`);
        try {
            const real = realpathSync(installDir);
            if (real !== installDir) parts.push(`real=${real}`);
        } catch {
            // vanished mid-flight — the literal path is already named
        }
    } else {
        parts.push("target=<unresolved>");
    }
    if (runningModule) {
        let real = runningModule;
        try {
            real = realpathSync(runningModule);
        } catch {
            // keep the literal path
        }
        parts.push(`running=${real}`);
    }
    return parts.join(" ");
}

let installLocationLogged = false;

/** Test hook: re-arm the once-per-process install-location diagnostic. */
export function _resetInstallLocationForTest(): void {
    installLocationLogged = false;
}

/** #1628: on this process's FIRST install failure, name the resolved target
 *  and the running module's real path. A persistent failure (e.g. a zombie of
 *  a root-owned global install while the host loads a different lane) then
 *  diagnoses itself from one log line — no filesystem archaeology (#1603
 *  defect 2 took 12 days of identical lines to attribute). At most once per
 *  process; the every-cycle retry line stays unchanged. */
export function logInstallLocationOnce(installDir: string | undefined, packageName: string, log: Logger = loggerLog): void {
    if (installLocationLogged) return;
    installLocationLogged = true;
    let running: string | undefined;
    try {
        running = fileURLToPath(import.meta.url);
    } catch {
        running = undefined;
    }
    log("warn", `[update] install location: ${describeInstallLocation(installDir, running)} — this process updates only the copy it runs from; if your host loads ${packageName} from a different location, that copy is not being updated here`);
}

/** True when `dir` is a git working tree: `.git` present as a directory
 *  (normal clone) or as a file (linked worktree / submodule pointer). npm
 *  installs never contain one — `npm pack` strips VCS metadata — so its
 *  presence marks a source checkout, not an install. Exported for tests.
 *  (#580) */
export async function isGitWorkingTree(dir: string): Promise<boolean> {
    try {
        await access(path.join(dir, ".git"));
        return true;
    } catch {
        return false;
    }
}

interface HostManagedInstall {
    /** Who owns and updates this copy: "pnpm", "pi", "opencode", "dsh". */
    owner: string;
    /** User-facing instruction for updating this copy through its owner. */
    channel: string;
}

/** #991 single-writer rule: detect install directories that are OWNED by a
 *  host's package manager — a pnpm virtual store (dsh profile bundles, pnpm
 *  global) or a host agent's data tree (pi's package dir, opencode's plugin
 *  dir, dsh/kimi homes). An in-place tarball copy over such a directory
 *  corrupts the owner's bookkeeping (npm/pnpm metadata drift, #953) or, for
 *  pnpm, the hardlinked content files shared across every install in the
 *  store. Returns the owner + its update channel, or undefined when the copy
 *  is bili-owned (npm global, manual install) and may be updated in place.
 *  Exported for tests. */
// #1575 (owner decision 2026-10-01, recorded on the issue): the dsh DESKTOP
// profile copy is bili-owned IN PLACE. Every other update channel for that
// lane is closed by design upstream — the dsh CLI refuses `--profile desktop`
// outright ("managed exclusively by the Electron application") and the
// in-app plugin manager does not reliably pull newer bundled deps — so the
// global self-update / periodic check is the only working path and it must be
// allowed to overwrite in place. Residual second-writer risk with the app's
// own manager is explicitly accepted by the owner; reverting means dropping
// this check.
function isDshDesktopBiliCopy(installDir: string, real: string, env: NodeJS.ProcessEnv): boolean {
    const anchor = path.join(resolveDshHome(env), "profiles", DSH_DESKTOP_PROFILE).split(path.sep).join("/");
    return [installDir, real].some((dir) => {
        const norm = dir.split(path.sep).join("/");
        return norm.startsWith(anchor + "/") && norm.endsWith(`/node_modules/${DSH_PACKAGE}`);
    });
}

/** #1234/#2199: true when `installDir` is the OpenCode v2 plugin-manager CACHE
 *  copy of billion-context — under $XDG_CACHE_HOME/opencode (default
 *  ~/.cache/opencode) at .../node_modules/billion-context. A bare
 *  "billion-context" plugin entry is materialized into opencode's npm-cache-
 *  shaped dir (~/.cache/opencode/npm/billion-context@<spec>/<ts>/node_modules/
 *  billion-context) and updates ITSELF through its own running proxy's periodic
 *  self-update; the host reloads/restarts to activate it. Such a copy is bili-
 *  owned IN PLACE and must NOT be classified as host-managed. The data-home
 *  plugin tree ($XDG_DATA_HOME/opencode) is a different tree and stays host-
 *  managed (returned by the homes loop below). */
function isOpencodeCacheBiliCopy(installDir: string, real: string, env: NodeJS.ProcessEnv): boolean {
    const xdgCache = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim().length > 0 ? env.XDG_CACHE_HOME : path.join(os.homedir(), ".cache");
    const anchor = path.join(xdgCache, "opencode").split(path.sep).join("/");
    return [installDir, real].some((dir) => {
        const norm = dir.split(path.sep).join("/");
        return norm.startsWith(anchor + "/") && norm.endsWith(`/node_modules/${DSH_PACKAGE}`);
    });
}

export function hostManagedInstall(installDir: string, env: NodeJS.ProcessEnv = process.env): HostManagedInstall | undefined {
    let real = installDir;
    try {
        real = realpathSync(installDir);
    } catch {
        // nonexistent or unreadable — evaluate the literal path
    }
    if (isDshDesktopBiliCopy(installDir, real, env)) return undefined;
    // #1234/#2199: the opencode CACHE copy is bili-owned in place (self-updates
    // via its own proxy) — recognized EXPLICITLY so the in-place exception does
    // not depend on the cache path accidentally missing every host home below.
    // Do NOT fold the cache path into `homes`: that would classify it host-
    // managed and silently re-close the #1234 auto-update.
    if (isOpencodeCacheBiliCopy(installDir, real, env)) return undefined;
    for (const dir of [installDir, real]) {
        if (dir.split(path.sep).some((seg) => seg === ".pnpm")) {
            return {
                owner: "pnpm",
                channel: "dsh profiles refresh automatically (on the next global bili self-update, or from the profile proxy's own periodic check when no global is running, #1196); a pnpm-global install upgrades via `pnpm add -g billion-context@latest`",
            };
        }
    }
    const xdgData = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim().length > 0 ? env.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
    const homes: Array<[string, string, string]> = [
        ["pi", resolvePiHome(env), "`pi update --extension npm:billion-context` (the pi copy's own proxy drives pi's update channel every check cycle, #1196; manual: `pi update --all`)"],
        ["opencode", path.join(xdgData, "opencode"), "opencode's own plugin manager (reload/reinstall the billion-context plugin)"],
        ["dsh", resolveDshHome(env), "the dsh plugin channel (the global bili self-update refreshes profiles, and so does the profile proxy's own periodic check; or `dsh plugin add billion-context@latest`)"],
        ["kimi", resolveKimiHome(env), "`bili plugin install kimi` after updating the global bili install"],
        ["omp", resolveOmpHome(env), "the global bili install (the extensions entry points at it)"],
    ];
    for (const [owner, home, channel] of homes) {
        if (!home) continue;
        for (const dir of [installDir, real]) {
            if (dir === home || dir.startsWith(home + path.sep)) {
                return { owner, channel };
            }
        }
    }
    return undefined;
}

/** Read the version from the on-disk package.json (not the startup constant). */
export async function readDiskVersion(installDir: string): Promise<string | undefined> {
    try {
        const pkg = JSON.parse(await readFile(path.join(installDir, "package.json"), "utf-8"));
        return pkg.version;
    } catch {
        return undefined;
    }
}

/** Declared loadable entries of a package.json: `main` plus every `bin`
 *  value (string or map form), deduped. Exported for tests. */
export function declaredEntryRelPaths(pkg: { main?: unknown; bin?: unknown }): string[] {
    const entries = new Set<string>();
    if (typeof pkg.main === "string") entries.add(pkg.main);
    const bin = pkg.bin;
    if (typeof bin === "string") entries.add(bin);
    else if (bin && typeof bin === "object") {
        for (const v of Object.values(bin)) {
            if (typeof v === "string") entries.add(v);
        }
    }
    return [...entries];
}

/** Run `node --check` on a file in a child process. Never throws. */
function runNodeCheck(file: string): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            ["--check", file],
            { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (err, _stdout, stderr) => {
                resolve({ code: err ? 1 : 0, stderr: String(stderr) });
            },
        );
    });
}

/**
 * Syntax-check an ESM entry with `node --check`. The entry is copied to a
 * `.mjs` temp first: extension-based module-goal detection is the only signal
 * `--check` honors consistently across Node versions, and the entry must not
 * be *executed* (running it would start the CLI/server). The temp name is
 * unique per invocation (#2106) so concurrent checks in different processes
 * can never overwrite or delete each other's file mid-check.
 * Returns null on success or a short reason on failure.
 */
async function syntaxCheckEntry(entryAbs: string): Promise<string | null> {
    let source: string;
    try {
        source = await readFile(entryAbs, "utf-8");
    } catch (e) {
        return `entry unreadable: ${String(e)}`;
    }
    const tmpCheck = path.join(cacheDir(), `.update-syntax-check-${crypto.randomBytes(6).toString("hex")}.mjs`);
    try {
        await mkdir(cacheDir(), { recursive: true });
        await writeFile(tmpCheck, source);
        const r = await runNodeCheck(tmpCheck);
        if (r.code !== 0) {
            return `entry does not parse (${path.basename(entryAbs)}): ${r.stderr.split("\n").filter(Boolean).slice(0, 3).join(" | ").slice(0, 300)}`;
        }
        return null;
    } finally {
        try {
            await rm(tmpCheck, { force: true });
        } catch {
            // best-effort cleanup
        }
    }
}

/**
 * Verify that every entry a broken publish could forget (main, bins) exists
 * and parses. Used against the staging dir before the install dir is touched
 * and against the install dir after the copy. Returns null or the reason.
 */
async function verifyEntries(dir: string, label: string): Promise<string | null> {
    let pkg: { main?: unknown; bin?: unknown };
    try {
        pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8"));
    } catch (e) {
        return `${label}: package.json unreadable: ${String(e)}`;
    }
    const entries = declaredEntryRelPaths(pkg);
    if (entries.length === 0) {
        return `${label}: no declared entry (main/bin)`;
    }
    for (const rel of entries) {
        try {
            await access(path.join(dir, rel));
        } catch {
            return `${label}: entry missing: ${rel}`;
        }
        const reason = await syntaxCheckEntry(path.join(dir, rel));
        if (reason) return `${label}: ${reason}`;
    }
    return null;
}

/**
 * Try to acquire an exclusive cross-process lock for updating.
 * Uses a lock file containing { pid, ts }. If the lock file exists and
 * the holder is alive and recent, returns null (another process is updating).
 * If the lock is stale (holder crashed or it's too old), we steal it.
 *
 * Returns a release function if the lock was acquired, or null otherwise.
 */
async function tryAcquireLock(): Promise<{ release: () => Promise<void> } | null> {
    const pid = process.pid;
    const now = Date.now();

    async function readLock(): Promise<{ pid: number; ts: number } | null> {
        try {
            const raw = await readFile(LOCK_FILE, "utf-8");
            const data = JSON.parse(raw);
            if (typeof data.pid === "number" && typeof data.ts === "number") {
                return data;
            }
        } catch {
            // no lock or corrupt
        }
        return null;
    }

    /** Check if a process is alive. */
    function isAlive(checkPid: number): boolean {
        try {
            process.kill(checkPid, 0);
            return true;
        } catch {
            return false;
        }
    }

    const existing = await readLock();
    if (existing) {
        const holderAlive = isAlive(existing.pid);
        if (!shouldStealLock(holderAlive, now - existing.ts)) {
            // Never steal from a live, recent holder: a slow install can run
            // long, and stealing its lock would let two processes write the
            // install dir concurrently → corruption. (#117)
            loggerLog("info", `[update] lock held by live pid=${existing.pid} (age=${Math.round((now - existing.ts) / 1000)}s), skipping update`);
            return null;
        }
        // Holder is dead, or alive-but-fossilized (crashed and its pid got
        // reused by an unrelated process — kill(pid,0) can't tell the
        // difference — or wedged for hours) — steal the lock. MUST delete the
        // stale lock file first: writeFile({flag:"wx"}) below requires the path
        // to NOT exist, and the stale file is still there. Without this unlink
        // the wx write always fails → update returns null forever → a single
        // crash during update permanently blocks all future auto-updates.
        loggerLog("info", `[update] stealing lock from pid=${existing.pid} (alive=${holderAlive}, age=${Math.round((now - existing.ts) / 1000)}s)`);
        try {
            await unlink(LOCK_FILE);
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            // ENOENT is fine (someone else already cleaned it). Anything else
            // (EACCES, EBUSY on Windows) means we can't steal — bail out
            // rather than hammering wx writes that will all fail.
            if (code !== "ENOENT") {
                loggerLog("warn", `[update] could not remove stale lock: ${(e as Error).message}`);
                return null;
            }
        }
    }

    // Write our lock. Use flag "wx" to fail if file already exists.
    // The cache dir may not exist yet on a fresh install (writeLastCheck
    // normally creates it, but the lock must not depend on that side
    // effect) — create it first, keeping EACCES/ERO failures surfacing via
    // the wx write below exactly as before.
    await mkdir(path.dirname(LOCK_FILE), { recursive: true }).catch(() => {});
    try {
        await writeFile(LOCK_FILE, JSON.stringify({ pid, ts: now }), { flag: "wx" });
    } catch {
        // Lost the race — another process created the lock file first.
        const winner = await readLock();
        if (winner && winner.pid !== pid) {
            loggerLog("info", `[update] lost lock race to pid=${winner.pid}, skipping update`);
            return null;
        }
    }

    // Re-read to confirm we are the holder (handles edge cases).
    const confirmed = await readLock();
    if (!confirmed || confirmed.pid !== pid) {
        loggerLog("info", `[update] lock held by pid=${confirmed?.pid}, skipping update`);
        return null;
    }

    return {
        release: async () => {
            const current = await readLock();
            if (current?.pid === pid) {
                await rm(LOCK_FILE, { force: true }).catch(() => {});
            }
        },
    };
}

export type UpdateOptions = {
    /** Package name, e.g. "billion-context". */
    packageName: string;
    /** Fallback version (read at startup). The actual version is re-read from
     *  disk on each check so that an in-place tarball update is immediately
     *  reflected without restart. */
    currentVersion: string;
    /** Enable auto-install when a newer version is found. */
    autoUpdate: boolean;
    /** Egress proxy resolver for the registry/tarball hosts (#609) — the CLI
     *  wires in bili's upstream-proxy decision chain so updater fetches honor
     *  the same routing (incl. NO_PROXY) as model traffic. Absent = direct. */
    resolveProxy?: (url: string) => string | undefined;
    /** Dist-tag channel to follow (default "latest"), e.g. "dev", "stable".
     *  Publishing a PR (pr-N tag) never pulls a user on another channel. */
    updateTag?: string;
    /** Explicit install dir override (programmatic callers / test seam) —
     *  skips findInstallDir's walk-up. Same shape as runAdvisoryCheck's
     *  option. */
    installDir?: string;
    /** #1481: returns true while the advisory watcher holds an active
     *  critical-bug advisory. The normal loop defers to it (its target version
     *  wins over "follow latest"), otherwise the two loops would fight over
     *  the install dir every cycle. A forced manual check still proceeds. */
    advisoryActive?: () => boolean;
    /** #1588-A: returns true when a candidate version falls inside any freshly
     *  parsed advisory's affected range. Consulted right before the normal
     *  loop installs its candidate: a rollback-form advisory leaves this
     *  machine's disk clean while the registry's latest stays affected, and
     *  following latest would pull the machine back into the defect (the
     *  watcher would roll it back again — ping-pong). The blocklist wins over
     *  "follow latest" until the advisory stops covering the candidate. The
     *  predicate fails open; a forced manual check still proceeds. Absent =
     *  no-op. */
    advisoryBlocksVersion?: (version: string) => boolean;
    /** #2456: returns true while the advisory watcher is running but has not
     *  yet completed its first feed consultation this process. Consulted on the
     *  normal loop's post-restart path BEFORE it installs the registry latest:
     *  a rollback-form advisory (#1588-A) leaves this disk clean while latest
     *  stays affected, and the advisoryBlocksVersion gate below is blind until
     *  the advisory's first check lands — deferring one cycle (cheaper than
     *  installing a known-affected version and rolling it back) closes the
     *  startup race. A forced manual check still proceeds. Absent = no-op (so
     *  auto-update-only installs, where the watcher never runs, never defer). */
    advisoryAwaitingFirstCheck?: () => boolean;
    /** Fired whenever this process detects the on-disk install is newer than
     *  the running code (#811): right after a successful in-place install and
     *  on every subsequent up-to-date check while the process stays stale.
     *  The CLI wires in the opt-in self-restart handler; absent = no-op.
     *  Failures are logged, never propagated into the update loop. */
    onStaleInstall?: (info: { diskVersion: string; runningVersion: string }) => void | Promise<void>;
};

/** Fire the stale-install hook (#811) without ever letting a handler failure
 *  break the update loop. Absent hook = no-op (default behavior unchanged). */
function notifyStaleInstall(opts: UpdateOptions, diskVersion: string): void {
    const hook = opts.onStaleInstall;
    if (!hook) return;
    try {
        const result = hook({ diskVersion, runningVersion: opts.currentVersion });
        if (result instanceof Promise) {
            result.catch((e) => loggerLog("warn", `[update] stale-install handler failed: ${String(e)}`));
        }
    } catch (e) {
        loggerLog("warn", `[update] stale-install handler failed: ${String(e)}`);
    }
}

/** Fetch dispatcher for updater egress (#609). undici's global fetch ignores
 *  HTTP(S)_PROXY env vars, so without an explicit dispatcher the registry
 *  check and tarball download always went direct even when model traffic is
 *  routed through a configured proxy. undefined result = direct connection. */
export function egressDispatcher(opts: Pick<UpdateOptions, "resolveProxy">, url: string): object | undefined {
    return proxyDispatcher(opts.resolveProxy?.(url));
}

// @types/node types RequestInit.dispatcher as its internal Dispatcher
// interface, which structurally conflicts with undici's ProxyAgent; at runtime
// they're the same thing. Cast once here (no `as any`), as fetch-util does.
function fetchWithEgress(url: string, init: FetchOptions): Promise<Response> {
    return fetch(url, init as RequestInit);
}

/** Resolve the current version of `packageName` on the configured dist-tag
 *  channel. Shared by the self-updater and `bili plugin update` (dsh profile
 *  refresh). Returns undefined on any failure — callers treat "unknown" as
 *  "do nothing". (#991) */
export async function fetchRegistryVersion(opts: Pick<UpdateOptions, "resolveProxy" | "updateTag">, packageName: string): Promise<string | undefined> {
    const tag = normalizeUpdateTag(opts.updateTag);
    const url = registryUrlFor(packageName, tag);
    const dispatcher = egressDispatcher(opts, url);
    const res = await fetchWithEgress(url, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    return data.version;
}

/** #1196: when the running process itself lives inside a dsh profile bundle
 *  (dsh plugin-market install), there is no global bili to drive the lockstep
 *  refresh — the profile copy would stay frozen at its install version
 *  forever (dsh-market users often have no global install at all). Instead of
 *  a bare skip, check the registry and drive dsh's OWN plugin channel
 *  (`dsh plugin --profile <name> add billion-context@<v>`, the single-writer-
 *  safe owner) under the shared cross-process update lock. Registry-pinned
 *  profiles only — refreshDshProfileBundles leaves link:/file: pins alone, so
 *  dev lanes stay manual. Best-effort: never throws, never blocks the proxy.
 *  #2192: a failed refresh records a strike under the shared #1603 backoff
 *  (keyed owner:dsh-profile:<version>) instead of retrying every check cycle —
 *  a backed-off lane is a silent no-op until the cooldown expires or a new
 *  release re-arms it. */

/** #2192: actionable hints surfaced on the escalation line when an owner lane
 *  exhausts its strikes — each names that lane's manual fix instead of the
 *  generic global-install advice. */
const DESKTOP_LANE_HINT = "the dsh desktop profile layout is likely broken \u2014 recreate the desktop profile from dsh (or move DSH_HOME to a shorter path if pnpm virtual-store path limits are hit); retries resume automatically";
const PROFILE_LANE_HINT = "run `dsh plugin --profile <name> add billion-context@<version>` from a shell where `dsh` resolves (or point BILI_DSH_BIN at dsh's executable)";
const PI_LANE_HINT = `run \`pi update --extension ${PI_NPM_SPEC}\` from a shell where \`pi\` resolves (or point BILI_PI_BIN at pi's executable)`;

/** #2192: drive the dsh profile-bundle refresh through the shared #1603
 *  backoff keyed per lane+version. A stale-but-in-cooldown lane is a silent
 *  no-op (no dsh CLI spawn); a run with any failed profile records a strike, a
 *  clean run clears the key. Every driver site goes through here so streaks
 *  stay consistent no matter which instance triggers the refresh. */
async function runProfileBundlesRefresh(targetVersion: string, log: Logger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const key = ownerLaneKey("dsh-profile", targetVersion);
    if (await backoffInCooldown(key)) return;
    const res = await refreshDshProfileBundles(targetVersion, log, env);
    if (res.failed > 0) {
        await recordInstallFailure(key, `${res.failed} dsh profile bundle(s) failed to refresh to ${targetVersion}`, undefined, PROFILE_LANE_HINT);
    } else {
        await clearInstallBackoff(key);
    }
}

export async function refreshDshProfileCopy(
    installDir: string,
    opts: UpdateOptions,
    env: NodeJS.ProcessEnv = process.env,
    log: Logger = loggerLog,
): Promise<void> {
    if (!isDshProfileCopy(installDir, env)) return;
    let latest: string | undefined;
    try {
        latest = await fetchRegistryVersion(opts, opts.packageName);
    } catch (e) {
        log("warn", `[update] dsh profile bundle check failed: ${String(e)} \u2014 leaving profile copies alone`);
        return;
    }
    if (!latest) {
        log("warn", `[update] could not resolve the latest version for ${opts.packageName} \u2014 leaving dsh profile bundles alone`);
        return;
    }
    const diskVersion = await readDiskVersion(installDir);
    const currentVersion = diskVersion ?? opts.currentVersion;
    if (!isVersionNewer(latest, currentVersion)) {
        log("info", `[update] dsh profile bundle up to date (current=${currentVersion} latest=${latest} tag=${normalizeUpdateTag(opts.updateTag)})`);
        return;
    }
    log("info", `[update] dsh profile bundle is stale (${currentVersion} \u2192 ${latest}) \u2014 refreshing via dsh's plugin channel`);
    const lock = await tryAcquireLock();
    if (!lock) {
        log("info", `[update] another process is updating, will check next cycle`);
        return;
    }
    try {
        await runProfileBundlesRefresh(latest, log, env);
        await refreshDshDesktopCopy(latest, log, env);
    } finally {
        await lock.release();
    }
}

/** #1575 (owner decision): refresh the dsh DESKTOP profile copy IN PLACE. The
 *  CLI refuses --profile desktop outright ("managed exclusively by the Electron
 *  application") and the in-app plugin manager cannot be relied on, so bili owns
 *  that copy: a verified-registry-tarball install through the standard
 *  junction-safe installer (whose hostManagedInstall exemption recognizes this
 *  exact layout), keyed off the running user's DSH_HOME. Called alongside
 *  refreshDshProfileBundles at every driver site; all sites hold the shared
 *  update lock. Silent while the copy is missing, in step, or ahead; failures
 *  log and back off through the owner-lane InstallBackoff (#2192 — this lane
 *  re-downloads the tarball per attempt, so an unbacked retry loop burned
 *  bandwidth every check cycle); never throws. */
export async function refreshDshDesktopCopy(
    targetVersion: string,
    log: Logger = loggerLog,
    env: NodeJS.ProcessEnv = process.env,
    resolveProxy?: (url: string) => string | undefined,
): Promise<void> {
    const flat = path.join(resolveDshHome(env), "profiles", DSH_DESKTOP_PROFILE, "node_modules", DSH_PACKAGE);
    const bkey = ownerLaneKey("dsh-desktop", targetVersion);
    let diskVersion: string | undefined;
    try {
        try {
            await access(flat, constants.F_OK);
        } catch {
            return; // no desktop profile on this machine — nothing to keep in step
        }
        diskVersion = await readDiskVersion(flat);
        if (!isVersionNewer(targetVersion, diskVersion ?? "0.0.0")) return; // in step or ahead — never downgrade
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", `[update] dsh ${DSH_DESKTOP_PROFILE} in-place refresh check failed: ${msg}; leaving the copy untouched`);
        await recordInstallFailure(bkey, `dsh ${DSH_DESKTOP_PROFILE} in-place refresh check failed: ${msg}`, undefined, DESKTOP_LANE_HINT);
        return;
    }
    if (await backoffInCooldown(bkey)) return; // #2192: inside the backoff window — no registry call, no download
    try {
        const doc = await fetchVersionDoc({ resolveProxy }, DSH_PACKAGE, targetVersion);
        if (!doc?.tarball) {
            log("warn", `[update] dsh ${DSH_DESKTOP_PROFILE}: in-place refresh to ${targetVersion} failed \u2014 no dist.tarball for that version on the registry; retrying next cycle`);
            await recordInstallFailure(bkey, `dsh ${DSH_DESKTOP_PROFILE}: no dist.tarball for ${targetVersion} on the registry`, undefined, DESKTOP_LANE_HINT);
            return;
        }
        const result = await installViaTarball(targetVersion, doc.tarball, flat, doc.integrity, doc.shasum, egressDispatcher({ resolveProxy }, doc.tarball), env, { bootSmoke: true });
        if (result.ok) {
            await clearInstallBackoff(bkey);
            log("info", `[update] refreshed dsh ${DSH_DESKTOP_PROFILE} profile copy in place (${diskVersion ?? "?"} \u2192 ${targetVersion}) \u2014 restart dsh to load it (the running app keeps the old code in memory; across the handoff bili tools may fail once until dsh restarts, #2082)`);
        } else {
            log("warn", `[update] dsh ${DSH_DESKTOP_PROFILE}: in-place refresh to ${targetVersion} failed: ${result.error}; retrying next cycle`);
            await recordInstallFailure(bkey, `dsh ${DSH_DESKTOP_PROFILE} in-place refresh to ${targetVersion} failed: ${result.error}`, undefined, DESKTOP_LANE_HINT);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", `[update] dsh ${DSH_DESKTOP_PROFILE} in-place refresh check failed: ${msg}; leaving the copy untouched`);
        await recordInstallFailure(bkey, `dsh ${DSH_DESKTOP_PROFILE} in-place refresh check failed: ${msg}`, undefined, DESKTOP_LANE_HINT);
    }
}

/** #1196-class fix for the pi lane: the copy under <piHome>/npm is pi's own
 *  materialization of the settings `npm:billion-context` entry — #991 keeps
 *  the global updater out, and pi has no background package updater, so the
 *  proxy running FROM the copy drives `pi update --extension
 *  npm:billion-context` (pi's owner channel) on its periodic check when the
 *  registry has a newer version. Only the unpinned spec form self-refreshes;
 *  an explicit `@version` pin (or a missing settings entry) is left alone.
 *  Best-effort: never throws, never blocks the proxy; a failed refresh backs
 *  off through the owner-lane InstallBackoff (#2192). */
export async function refreshPiNpmCopy(
    installDir: string,
    opts: UpdateOptions,
    env: NodeJS.ProcessEnv = process.env,
    log: Logger = loggerLog,
): Promise<void> {
    if (!isPiNpmCopy(installDir, env)) return;
    const entry = piNpmEntrySpec(env);
    if (entry !== PI_NPM_SPEC) {
        log("info", `[update] pi packages entry is ${entry ?? "(missing)"} — leaving the pi copy alone (only the unpinned ${PI_NPM_SPEC} form self-refreshes)`);
        return;
    }
    let latest: string | undefined;
    try {
        latest = await fetchRegistryVersion(opts, opts.packageName);
    } catch (e) {
        log("warn", `[update] pi npm copy check failed: ${String(e)} — leaving the copy alone`);
        return;
    }
    if (!latest) {
        log("warn", `[update] could not resolve the latest version for ${opts.packageName} — leaving the pi copy alone`);
        return;
    }
    const diskVersion = await readDiskVersion(installDir);
    const currentVersion = diskVersion ?? opts.currentVersion;
    if (!isVersionNewer(latest, currentVersion)) {
        log("info", `[update] pi npm copy up to date (current=${currentVersion} latest=${latest} tag=${normalizeUpdateTag(opts.updateTag)})`);
        return;
    }
    if (await backoffInCooldown(ownerLaneKey("pi-npm", latest))) return; // #2192: inside the backoff window — no spawn
    log("info", `[update] pi npm copy is stale (${currentVersion} → ${latest}) — refreshing via pi's update channel`);
    const lock = await tryAcquireLock();
    if (!lock) {
        log("info", `[update] another process is updating, will check next cycle`);
        return;
    }
    try {
        await runPiAsync(["update", "--extension", PI_NPM_SPEC], env);
        await clearInstallBackoff(ownerLaneKey("pi-npm", latest));
        log("info", `[update] pi npm copy refreshed to ${latest} — restart pi to load it`);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log("warn", `[update] pi npm copy refresh to ${latest} failed: ${detail} — manual fix: run \`pi update --extension ${PI_NPM_SPEC}\` from a shell where \`pi\` resolves (or point BILI_PI_BIN at pi's executable); retries next check cycle`);
        await recordInstallFailure(ownerLaneKey("pi-npm", latest), `pi npm copy refresh to ${latest} failed: ${detail}`, undefined, PI_LANE_HINT);
    } finally {
        await lock.release();
    }
}

/** Drive the owner-channel refresh for whichever host-managed lane this
 *  install dir belongs to. Each helper no-ops when the classification does
 *  not match, and a dir can only sit in one host's tree. */
async function refreshOwnerManagedCopies(
    installDir: string,
    opts: UpdateOptions,
    env: NodeJS.ProcessEnv,
    log: Logger,
): Promise<void> {
    await refreshDshProfileCopy(installDir, opts, env, log);
    await refreshPiNpmCopy(installDir, opts, env, log);
}
/** Registry-pinned dsh profile copies whose installed version is older
 *  than the global one ("name@version" per entry). Dev pins (link:/file:)
 *  and declared-but-not-installed mounts are out of scope: neither
 *  participates in the mixed-copy crash. */
async function staleDshProfileCopies(globalVersion: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return []; // dsh has never run on this machine
    }
    const out: string[] = [];
    for (const dir of dirs) {
        if (!dshProfileDependsOnBili(dir)) continue;
        const spec = dshProfileDepSpec(dir);
        if (spec !== undefined && !isRegistryDepSpec(spec)) continue;
        const version = await readDiskVersion(path.join(dir, "node_modules", DSH_PACKAGE));
        if (version && isVersionNewer(globalVersion, version)) out.push(`${path.basename(dir)}@${version}`);
    }
    return out;
}

/** #1803: dsh's CLI reads the bili bundle yml from the GLOBAL install but
 *  resolves the entry module from each profile's own node_modules. A profile
 *  copy left behind the global version — manual `npm i -g`, or a post-update
 *  refresh that failed and never retried — makes the bare-name entry resolve
 *  to the old package's CLI root (a module with zero exports), so dsh
 *  hard-crashes at boot ("invalid plugin …") and the crash also blocks the
 *  profile copy's own #1196 self-heal. Drive convergence from the global
 *  install's periodic check: detect registry-pinned profile copies older
 *  than the global disk version and refresh them through dsh's own plugin
 *  channel under the shared update lock — so a failed refresh retries every
 *  cycle instead of only on the next install event. Silent and spawn-free
 *  while everything is in step. */
export async function convergeDshProfileBundles(
    installDir: string | undefined,
    globalVersion: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
    log: Logger = loggerLog,
): Promise<void> {
    if (!installDir || !globalVersion) return;
    let stale: string[];
    try {
        stale = await staleDshProfileCopies(globalVersion, env);
    } catch {
        return; // profile scanning must never break the update loop
    }
    if (stale.length === 0) return;
    log("info", `[update] dsh profile bundle(s) behind the global copy (${stale.join(", ")} < ${globalVersion}) — converging via dsh's plugin channel (#1803)`);
    const lock = await tryAcquireLock();
    if (!lock) {
        log("info", `[update] another process is updating, will check next cycle`);
        return;
    }
    try {
        await runProfileBundlesRefresh(globalVersion, log, env);
        await refreshDshDesktopCopy(globalVersion, log, env);
    } finally {
        await lock.release();
    }
}

/** Run a single check (throttled unless `force`). Safe to call frequently. */
export async function checkForUpdate(opts: UpdateOptions, force = false): Promise<void> {
    if (!opts.autoUpdate && !force) return;
    if (inFlight) return;
    inFlight = true;
    try {
        const now = Date.now();
        // #2192: resolve the install dir up front so the throttle marker and
        // cadence are picked per lane — host-managed copies run their
        // owner-channel refresh on their own slower interval (with jitter)
        // instead of the global 3-min cadence.
        const installDir = opts.installDir ?? await findInstallDir(opts.packageName);
        const managed = installDir ? hostManagedInstall(installDir) : undefined;
        const ownerLane = Boolean(managed && installDir);
        const throttleFile = ownerLane ? OWNER_THROTTLE_FILE : THROTTLE_FILE;
        const intervalMs = ownerLane ? ownerLaneIntervalMs() : CHECK_INTERVAL_MS;
        const lastCheck = await readLastCheck(throttleFile);
        const sinceLastSec = lastCheck ? ((now - lastCheck) / 1000 | 0) : -1;
        if (!force && firstCheckDone && now - lastCheck < intervalMs) {
            const retryIn = ((intervalMs - (now - lastCheck)) / 1000 | 0);
            loggerLog("info", `[update] throttled \u2014 last checked ${sinceLastSec}s ago, retry in ${retryIn}s`);
            return;
        }
        await writeLastCheck(throttleFile, now);
        firstCheckDone = true;

        if (!force && opts.advisoryActive?.()) {
            // The advisory watcher is working on this install dir: let its target
            // version win instead of racing it with "follow latest".
            if (managed && installDir) {
                loggerLog("info", `[update] deferring to the advisory loop; ${managed.owner}-managed install keeps its owner-channel refresh (#991/#1196)`);
                await refreshOwnerManagedCopies(installDir, opts, process.env, loggerLog);
                return;
            }
            loggerLog("info", "[update] deferring to the advisory loop (an active critical-bug advisory owns this install)");
            return;
        }

        // Source-checkout guard (#580): findInstallDir() walks up from the
        // running dist/ and lands on the repo root when bili runs from a git
        // clone (node dist/index.js start). An in-place tarball copy would
        // silently rewrite tracked files (the version pin, READMEs), so refuse
        // to self-update here instead of proceeding.
        if (installDir && await isGitWorkingTree(installDir)) {
            loggerLog("info", `[update] running from a source checkout (${installDir}) \u2014 skipping auto-update (use npm install -g ${opts.packageName})`);
            return;
        }

        // #991 single-writer: when this install dir belongs to a host (pnpm
        // store, pi/opencode/dsh/kimi/omp trees), the copy must only be
        // updated through its owner — never overwritten in place by the
        // global self-updater.
        if (managed && installDir) {
            loggerLog("info", `[update] install dir is managed by ${managed.owner} (${installDir}) \u2014 skipping in-place self-update; update it via ${managed.channel} (#991)`);
            // #1196: a copy inside a host's own tree (dsh profile bundle, pi
            // npm dir) cannot wait for a global self-update that may never
            // come — drive the lockstep refresh through the host's own
            // channel from here.
            await refreshOwnerManagedCopies(installDir, opts, process.env, loggerLog);
            return;
        }

        // #2456: this machine may be CLEAN (not itself affected) while the
        // registry latest sits inside a rollback-form advisory's range, and the
        // advisoryBlocksVersion gate below cannot see that range until the
        // advisory's first check has landed. Installing latest before then pulls
        // the machine back into the defect and the watcher rolls it back again
        // (the post-restart ping-pong). Defer this cycle instead — a late update
        // is cheaper than an affected-version round-trip. Non-forced path only;
        // once the advisory's first check completes the predicate goes false and
        // the normal loop resumes (or the gate above skips the affected candidate).
        if (!force && opts.advisoryAwaitingFirstCheck?.()) {
            loggerLog("info", "[update] deferring this cycle: the advisory's first check has not landed yet (#2456) \u2014 will follow latest next cycle once its state is known");
            return;
        }

        loggerLog("info", `[update] checking npm registry for ${opts.packageName}${sinceLastSec < 0 ? " (startup check)" : sinceLastSec === 0 ? "" : ` (last check ${sinceLastSec}s ago)`}\u2026`);

        // Follow the configured dist-tag channel (default "latest"): an
        // `updateTag: "dev"` install tracks `dev`, "stable" tracks "stable",
        // etc. PR previews (pr-N tags) are only followed if explicitly
        // configured, so publishing a PR never pulls a stable user forward.
        const tag = normalizeUpdateTag(opts.updateTag);
        const url = registryUrlFor(opts.packageName, tag);
        const registryDispatcher = egressDispatcher(opts, url);
        const res = await fetchWithEgress(url, {
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/json" },
            ...(registryDispatcher ? { dispatcher: registryDispatcher } : {}),
        });
        if (!res.ok) {
            loggerLog("warn", `[update] registry returned ${res.status} ${res.statusText}, skipping`);
            return;
        }
        const data = (await res.json()) as {
            version?: string;
            dist?: { tarball?: string; integrity?: string; shasum?: string };
        };
        const latest = data.version;
        if (!latest) {
            loggerLog("warn", `[update] registry response had no version, skipping`);
            return;
        }

        // Read current version from disk (not from startup constant) so that
        // a successful in-place update is detected without a restart.
        const diskVersion = installDir ? await readDiskVersion(installDir) : undefined;
        const currentVersion = diskVersion ?? opts.currentVersion;

        if (reportNotNewer(latest, tag, diskVersion, opts.currentVersion, loggerLog)) {
            // Up to date, but this process is behind the on-disk install —
            // surface it to the opt-in self-restart handler (#811).
            if (diskVersion && staleInstallStatus(diskVersion, opts.currentVersion) === "restart") {
                notifyStaleInstall(opts, diskVersion);
            }
            // #1803: converge dsh profile copies left behind this global
            // version — dsh reads the yml from here but the entry module from
            // each profile, so a stale copy hard-crashes dsh at boot.
            await convergeDshProfileBundles(installDir, diskVersion, process.env);
            return;
        }

        // #1588-A: the candidate itself may sit inside a freshly parsed
        // advisory's affected range even though no advisory is active against
        // THIS machine (rollback form: disk/target clean, latest still
        // affected). Installing it would pull the machine back into the defect
        // and the watcher would roll it back again — ping-pong every cycle.
        // Skip the candidate: the blocklist wins over "follow latest" until
        // the advisory document stops covering it.
        if (!force && opts.advisoryBlocksVersion?.(latest)) {
            loggerLog("info", `[update] skipping ${latest}: covered by a critical-bug advisory's affected range (#1588) — not pulling this install back into the defect; retrying next cycle`);
            return;
        }

        const tarballUrl = data.dist?.tarball;
        const integrity = data.dist?.integrity;
        const shasum = data.dist?.shasum;
        if (!tarballUrl) {
            loggerLog("warn", `[update] registry response for ${latest} had no tarball URL`);
            return;
        }

        const bkey = backoffKey(installDir, latest);
        if (!force && (await backoffInCooldown(bkey))) {
            return;
        }

        loggerLog("info", `[update] new version found: ${currentVersion} \u2192 ${latest}, downloading\u2026`);

        // Acquire lock to prevent concurrent updates across processes.
        const lock = await tryAcquireLock();
        if (!lock) {
            loggerLog("info", `[update] another process is updating, will check next cycle`);
            return;
        }
        try {
            const result = await installViaTarball(latest, tarballUrl, installDir, integrity, shasum, egressDispatcher(opts, tarballUrl));
            if (result.ok) {
                await clearInstallBackoff(bkey);
                loggerLog("info", `[update] installed ${currentVersion} \u2192 ${latest}. Restart to finish.`);
                // #966: dsh profile copies load their own plugin+proxy from the
                // profile's node_modules — without this they would keep running
                // the old version next to the new global one (#953). Best-effort:
                // never fails the update itself.
                await runProfileBundlesRefresh(latest, loggerLog);
                await refreshDshDesktopCopy(latest, loggerLog, process.env, opts.resolveProxy);
                notifyStaleInstall(opts, latest);
            } else {
                await recordInstallFailure(bkey, result.error ?? "unknown error", installDir);
                logInstallLocationOnce(installDir, opts.packageName, loggerLog);
            }
        } finally {
            await lock.release();
        }
    } catch (e) {
        loggerLog("warn", `[update] check failed: ${String(e)}`);
    } finally {
        inFlight = false;
    }
}

/** Verify a downloaded tarball against the npm registry's integrity field
 *  (sha512-<base64>) or legacy shasum (hex sha1). Refuses to install if the
 *  registry provided neither — npm always returns both, so their absence
 *  signals a tampered or non-standard response. Unknown hash algorithms fail
 *  closed rather than throwing. Exported for tests. */
export function verifyTarballIntegrity(buf: Buffer, integrity?: string, shasum?: string): { ok: boolean; error?: string } {
    if (integrity) {
        const dash = integrity.indexOf("-");
        if (dash <= 0) return { ok: false, error: "malformed integrity field" };
        const alg = integrity.slice(0, dash);
        const expected = integrity.slice(dash + 1);
        let actual: string;
        try {
            actual = crypto.createHash(alg).update(buf).digest("base64");
        } catch {
            return { ok: false, error: `unsupported integrity algorithm: ${alg}` };
        }
        if (actual !== expected) return { ok: false, error: `${alg} mismatch` };
        return { ok: true };
    }
    if (shasum) {
        const actual = crypto.createHash("sha1").update(buf).digest("hex");
        if (actual !== shasum) return { ok: false, error: "sha1 shasum mismatch" };
        return { ok: true };
    }
    return { ok: false, error: "no integrity or shasum from registry" };
}

/** Download the npm tarball, extract to a temp staging dir, verify, then copy
 *  over the install directory. `dispatcher` (optional) routes the download
 *  through a proxy (#609); omitted = direct connection. */

const BOOT_SMOKE_TIMEOUT_MS = 20_000;

/** #2082: run the freshly installed copy's CLI entry with --version in a
 *  clean child process. Loading the module graph and exiting 0 is the smoke;
 *  any non-zero exit, timeout, or spawn failure returns a short reason (with
 *  the last stderr lines) for the caller to log before rolling back.
 *  Env scrub: the child must not inherit the parent's BILLION_CONTEXT_* /
 *  BILI_* knobs (a preset proxy origin would make --version spin up lanes)
 *  nor NODE_OPTIONS / NODE_TEST_CONTEXT interference. */
async function bootSmoke(installDir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    let entry: string | undefined;
    try {
        const pkg = JSON.parse(await readFile(path.join(installDir, "package.json"), "utf8")) as { main?: string };
        if (typeof pkg.main === "string" && pkg.main.length > 0) entry = pkg.main;
    } catch (err) {
        return `package.json unreadable: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (entry === undefined) return "package.json declares no main entry to smoke";
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (key.startsWith("BILI_") || key.startsWith("BILLION_CONTEXT_") || key.startsWith("ACP_")) continue;
        if (key === "NODE_OPTIONS" || key === "NODE_TEST_CONTEXT" || key === "NODE_ENV") continue;
        childEnv[key] = value;
    }
    return await new Promise<string | null>((resolve) => {
        const child = spawn(process.execPath, [path.join(installDir, entry!), "--version"], {
            cwd: installDir,
            env: childEnv,
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
            if (stderr.length > 8192) stderr = safeSuffix(stderr, 8192);
        });
        const timer = setTimeout(() => {
            child.kill();
            resolve(`boot smoke timed out after ${BOOT_SMOKE_TIMEOUT_MS}ms`);
        }, BOOT_SMOKE_TIMEOUT_MS);
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve(`boot smoke could not spawn ${process.execPath}: ${err.message}`);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(null);
                return;
            }
            const lines = stderr.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("at ") && !/^Node\.js v/.test(l.trim()));
            const tail = lines.length > 0 ? `: ${safeSuffix(lines.join(" | "), 600)}` : "";
            resolve(`boot smoke exited ${code ?? signal}${tail}`);
        });
    });
}

/** Best-effort sweep of stale per-invocation update temp artifacts
 *  (`.update-wip-*` workdirs, `.update-syntax-check-*` files). Unique names
 *  (#2106) removed the old version-keyed self-cleanup, so orphans of crashed
 *  runs age out here instead. Never touches `.update-check` / `.update-lock`;
 *  never throws. */
async function sweepStaleUpdateTmp(): Promise<void> {
    try {
        const dir = cacheDir();
        const now = Date.now();
        for (const entry of await readdir(dir)) {
            if (!entry.startsWith(".update-wip-") && !entry.startsWith(".update-syntax-check-")) continue;
            try {
                const st = await lstat(path.join(dir, entry));
                if (now - st.mtimeMs >= UPDATE_TMP_MAX_AGE_MS) {
                    await rm(path.join(dir, entry), { recursive: true, force: true });
                }
            } catch {
                // vanished mid-sweep — ignore
            }
        }
    } catch {
        // cache dir may not exist yet — nothing to sweep
    }
}

export async function installViaTarball(
    version: string,
    tarballUrl: string,
    installDir: string | undefined,
    integrity?: string,
    shasum?: string,
    dispatcher?: object,
    env: NodeJS.ProcessEnv = process.env,
    opts: { bootSmoke?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
    if (!installDir) {
        return { ok: false, error: "cannot determine install directory (package.json not found walking up from running binary)" };
    }

    // Pre-flight: can we write to the install dir?
    try {
        await access(installDir, constants.W_OK);
    } catch {
        return { ok: false, error: `install dir not writable: ${installDir}` };
    }

    // Source-checkout guard (#580): a git working tree must never be merged
    // over by a published tarball — that rewrites tracked files. checkForUpdate
    // filters these out already; this keeps the refusal structural for direct
    // callers.
    if (await isGitWorkingTree(installDir)) {
        return { ok: false, error: `install dir is a git working tree (${installDir}) \u2014 refusing to overwrite a source checkout (use npm install -g)` };
    }

    // #991 single-writer: refuse to overwrite a host-managed copy (pnpm
    // store, host agent data trees) — only its owner may update it.
    // Exception: the dsh desktop-profile copy is bili-owned in place (#1575).
    const managed = hostManagedInstall(installDir, env);
    if (managed) {
        return { ok: false, error: `install dir is managed by ${managed.owner} (${installDir}) \u2014 refusing in-place overwrite (single-writer); update via ${managed.channel}` };
    }

    // Download tarball. Stream into memory with a hard size cap so a corrupt
    // or malicious tarball cannot exhaust memory.
    const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
    let tgzBuffer: Buffer;
    try {
        const tgzRes = await fetchWithEgress(tarballUrl, {
            signal: AbortSignal.timeout(60_000),
            ...(dispatcher ? { dispatcher } : {}),
        });
        if (!tgzRes.ok) {
            return { ok: false, error: `tarball download failed: HTTP ${tgzRes.status} ${tgzRes.statusText}` };
        }
        if (!tgzRes.body) {
            return { ok: false, error: "tarball download failed: empty response body" };
        }
        const reader = tgzRes.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > MAX_TARBALL_BYTES) {
                    return { ok: false, error: `tarball exceeds ${MAX_TARBALL_BYTES} byte cap` };
                }
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }
        tgzBuffer = Buffer.concat(chunks);
    } catch (e) {
        return { ok: false, error: `tarball download failed: ${String(e)}` };
    }

    const v = verifyTarballIntegrity(tgzBuffer, integrity, shasum);
    if (!v.ok) {
        return { ok: false, error: `tarball integrity verification failed: ${v.error}` };
    }

    // Sweep stale temp artifacts from crashed runs before creating our own.
    await sweepStaleUpdateTmp();

    // Per-invocation workdir: unique per process+run, so concurrent installs
    // (test suites, lock-steal edges) can never clobber each other's temps —
    // the version-keyed fixed names did exactly that (#2106). Orphans of
    // crashed runs age out via sweepStaleUpdateTmp.
    let workDir: string;
    try {
        await mkdir(cacheDir(), { recursive: true });
        workDir = await mkdtemp(path.join(cacheDir(), ".update-wip-"));
    } catch (e) {
        return { ok: false, error: `failed to create temp workdir under ${cacheDir()}: ${String(e)}` };
    }
    const tmpFile = path.join(workDir, "tarball.tgz");
    try {
        await writeFile(tmpFile, tgzBuffer);
    } catch (e) {
        return { ok: false, error: `failed to write temp file ${tmpFile}: ${String(e)}` };
    }

    // Extract to a temp staging dir (NOT directly over install dir).
    // Uses the `tar` npm package (pure JS, cross-platform) instead of
    // shelling out to the `tar` binary, which is absent or inconsistent on
    // Windows. `--strip-components=1` maps to `strip: 1` (npm tarballs wrap
    // files in a `package/` dir).
    const stagingDir = path.join(workDir, "staging");
    try {
        await mkdir(stagingDir);

        await tar.x({
            file: tmpFile,
            cwd: stagingDir,
            strip: 1,
        });

        // Verify the staging dir has a valid package.json with the right version.
        const stagingVersion = await readDiskVersion(stagingDir);
        if (stagingVersion !== version) {
            return { ok: false, error: `staging verification failed: version is ${stagingVersion ?? "missing"}, expected ${version}` };
        }

        // Broken-publish guard: a tarball can carry the right version but a
        // missing or corrupt entry file (broken publish, partial upload).
        // Catch it in staging — the install dir must never be touched by a
        // package that cannot load, because a dead install can never update
        // itself healthy again.
        const stagingEntryErr = await verifyEntries(stagingDir, "staging verification failed");
        if (stagingEntryErr) {
            return { ok: false, error: stagingEntryErr };
        }
    } catch (e) {
        return { ok: false, error: `extraction failed: ${String(e)}` };
    } finally {
        await rm(tmpFile, { force: true });
    }

    // pnpm virtual-store copy (#1575 desktop lane): the flat node_modules
    // entry is a directory symlink/junction into <profile>/.pnpm/. fs.cp would
    // FOLLOW the link and rewrite shared store content (hardlinked,
    // integrity-checked by pnpm), so displace the LINK itself and lay down the
    // verified package as a real directory at this path instead.
    let pnpmOldLink: string | null = null;
    {
        let linkStat: Awaited<ReturnType<typeof lstat>> | null = null;
        try {
            linkStat = await lstat(installDir);
        } catch {
            // vanished mid-update — treat as a plain missing/real dir below
        }
        if (linkStat?.isSymbolicLink()) {
            pnpmOldLink = `${installDir}.pnpm-${Date.now()}`;
            try {
                await rename(installDir, pnpmOldLink);
            } catch (e) {
                return { ok: false, error: `failed to move the pnpm link aside (${pnpmOldLink}): ${String(e)} (install left untouched)` };
            }
        }
    }

    // Back up the current install before overwriting. If anything fails after
    // the copy (partial copy, version drift, corrupted entry), the backup is
    // restored so the previously working version keeps running.
    const backupDir = path.join(workDir, "backup");
    if (!pnpmOldLink) {
        // The pnpm-link lane needs no file backup: the displaced artifact IS
        // the link itself (kept at pnpmOldLink) and the store contents it
        // points into were never touched.
        try {
            await cp(installDir, backupDir, { recursive: true, force: true });
        } catch (e) {
            // Fail closed: without a backup we refuse to overwrite the running
            // install — the current version keeps working.
            return { ok: false, error: `backup of current install failed (install left untouched): ${String(e)}` };
        }
    }

    const restoreFromBackup = async (): Promise<string | null> => {
        try {
            await rm(installDir, { recursive: true, force: true });
            if (pnpmOldLink) {
                await rename(pnpmOldLink, installDir);
            } else {
                await cp(backupDir, installDir, { recursive: true, force: true });
            }
            return null;
        } catch (e) {
            // Keep the backup — it is the only healthy copy left.
            return `ROLLBACK FAILED — restore ${pnpmOldLink ?? backupDir} to ${installDir} manually: ${String(e)}`;
        }
    };

    // Copy staging over install dir using Node's built-in fs.cp (Node 16.7+).
    // Cross-platform — no dependency on the `cp` binary (absent on Windows).
    // `recursive: true` + the trailing `/.` semantics: fs.cp copies the
    // *contents* of stagingDir into installDir, merging without nesting.
    let copyError: string | null = null;
    try {
        await cp(stagingDir, installDir, { recursive: true, force: true });
    } catch (e) {
        copyError = `failed to copy to install dir: ${String(e)}`;
    } finally {
        await rm(stagingDir, { recursive: true, force: true });
    }
    if (copyError !== null) {
        const rb = await restoreFromBackup();
        return { ok: false, error: rb ?? copyError };
    }

    // Final verification: version must match and every declared entry must
    // still parse on disk.
    const newVersion = await readDiskVersion(installDir);
    if (newVersion !== version) {
        const rb = await restoreFromBackup();
        return {
            ok: false,
            error: rb ?? `post-install verification failed: package.json version is ${newVersion ?? "missing"}, expected ${version}`,
        };
    }
    const postEntryErr = await verifyEntries(installDir, "post-install verification failed");
    if (postEntryErr) {
        const rb = await restoreFromBackup();
        return { ok: false, error: rb ?? postEntryErr };
    }

    // #2082: optional boot smoke. verifyEntries proves the declared entries
    // PARSE; it cannot prove the artifact BOOTS (a top-level throw, a broken
    // import graph, a runtime dependency the flattened copy no longer
    // resolves — all syntactically valid). The desktop lane swaps this copy
    // in place under a RUNNING dsh whose plugin respawns from it on the next
    // proxy death; an unbootable copy turns that respawn into an infinite
    // give-up loop and the bili tools vanish until dsh restarts. Run the new
    // copy's CLI entry with --version once — the module graph loads and exits
    // immediately. Any failure rolls the working copy back to the backup.
    if (opts.bootSmoke) {
        const smokeErr = await bootSmoke(installDir, env);
        if (smokeErr !== null) {
            const rb = await restoreFromBackup();
            return { ok: false, error: rb ?? `boot smoke failed (rolled back to the previous copy): ${smokeErr}` };
        }
    }

    // Success: the backup is no longer needed, and neither is the displaced
    // pnpm link (the store copy underneath it was left byte-identical).
    await rm(backupDir, { recursive: true, force: true });
    if (pnpmOldLink) {
        try {
            await unlink(pnpmOldLink);
        } catch {
            // inert once installDir holds the fresh real directory
        }
    }
    await rm(workDir, { recursive: true, force: true });

    return { ok: true };
}

/** Sanity-check an on-disk install with the same entry verification a fresh
 *  auto-update applies to its staging dir: package.json readable, every
 *  declared entry present and parseable. Returns null or a short reason. The
 *  pre-re-exec gate (#811) uses it so a half-written install can never take
 *  over the process. */
export async function verifyInstallLoadable(installDir: string): Promise<string | null> {
    return verifyEntries(installDir, "install verification failed");
}

/** Stale-install view for the web UI (#811): the on-disk version and whether
 *  it is newer than the running process. Source checkouts report no stale
 *  state — they never self-update. */
export async function detectStaleInstall(
    packageName: string,
    runningVersion: string,
): Promise<{ diskVersion: string | undefined; stale: boolean }> {
    const installDir = await findInstallDir(packageName);
    if (!installDir || (await isGitWorkingTree(installDir))) {
        return { diskVersion: undefined, stale: false };
    }
    const diskVersion = await readDiskVersion(installDir);
    return { diskVersion, stale: staleInstallStatus(diskVersion, runningVersion) === "restart" };
}

/** Fetch one published version's registry doc (#1481): tarball URL plus
 *  integrity/shasum for verification. Returns undefined when the version does
 *  not exist or the fetch fails — callers treat that as "do nothing". */
async function fetchVersionDoc(
    opts: Pick<UpdateOptions, "resolveProxy">,
    packageName: string,
    version: string,
): Promise<{ tarball?: string; integrity?: string; shasum?: string } | undefined> {
    const url = `${REGISTRY_BASE}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
    const dispatcher = egressDispatcher(opts, url);
    try {
        const res = await fetchWithEgress(url, {
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/json" },
            ...(dispatcher ? { dispatcher } : {}),
        });
        if (!res.ok) return undefined;
        const data = (await res.json()) as { dist?: { tarball?: string; integrity?: string; shasum?: string } };
        return data?.dist?.tarball ? data.dist : undefined;
    } catch {
        return undefined;
    }
}

/** Force-install a specific published version in place (#1481), regardless of
 *  whether it is newer — the advisory watcher uses this to push users OUT of
 *  an affected range, so the target may even be OLDER than the current
 *  version (rollback semantics). Reuses the self-updater's full safety chain:
 *  same cross-process lock, same backup/verify/rollback tarball install, same
 *  #580 source-checkout and #991 single-writer guards (those refuse with an
 *  actionable error instead of installing). Returns ok:false with a reason on
 *  any refusal/failure; never throws. */
export async function forceInstallVersion(
    targetVersion: string,
    installDir: string | undefined,
    opts: UpdateOptions,
    advisoryId: string,
): Promise<{ ok: boolean; error?: string }> {
    if (!installDir) {
        const error = "cannot locate the install directory";
        warnAdvisoryOnce(advisoryId, `[update] advisory ${advisoryId}: ${error}`);
        return { ok: false, error };
    }
    const diskNow = await readDiskVersion(installDir);
    if ((diskNow ?? opts.currentVersion) === targetVersion) {
        // The advisory marks its own target as affected — a misconfiguration.
        // Fail loudly instead of spinning on a no-op install every cycle.
        const error = `advisory ${advisoryId} targets the current version ${targetVersion} (misconfigured advisory)`;
        warnAdvisoryOnce(advisoryId, `[update] ${error} — fix the advisory document`);
        return { ok: false, error };
    }
    if (await isGitWorkingTree(installDir)) {
        warnAdvisoryOnce(advisoryId, `[update] advisory ${advisoryId}: running from a source checkout (${installDir}) — refusing self-update (#580); upgrade manually with npm install -g ${opts.packageName}@${targetVersion}`);
        return { ok: false, error: "running from a source checkout — refusing self-update (#580)" };
    }
    const managed = hostManagedInstall(installDir);
    if (managed) {
        warnAdvisoryOnce(advisoryId, `[update] advisory ${advisoryId}: install dir belongs to ${managed.owner} — no in-place overwrite (#991); update via ${managed.channel}`);
        return { ok: false, error: `install dir is managed by ${managed.owner}; update via ${managed.channel}` };
    }
    const doc = await fetchVersionDoc(opts, opts.packageName, targetVersion);
    if (!doc?.tarball) {
        const error = `cannot resolve ${targetVersion} on the registry`;
        warnAdvisoryOnce(advisoryId, `[update] advisory ${advisoryId}: ${error}`);
        return { ok: false, error };
    }
    const lock = await tryAcquireLock();
    if (!lock) {
        warnAdvisoryOnce(advisoryId, `[update] advisory ${advisoryId}: another process is updating, will retry next cycle`);
        return { ok: false, error: "another process is updating, will retry next cycle" };
    }
    try {
        // Re-check under the lock: another process may have finished the same
        // install between the pre-lock read and lock acquisition.
        const diskUnderLock = await readDiskVersion(installDir);
        if (diskUnderLock === targetVersion) return { ok: true };
        const result = await installViaTarball(targetVersion, doc.tarball, installDir, doc.integrity, doc.shasum, egressDispatcher(opts, doc.tarball));
        if (result.ok) {
            loggerLog("info", `[update] advisory ${advisoryId}: installed ${diskUnderLock ?? opts.currentVersion} → ${targetVersion}. Restart to finish.`);
            await runProfileBundlesRefresh(targetVersion, loggerLog);
            await refreshDshDesktopCopy(targetVersion, loggerLog, process.env, opts.resolveProxy);
            notifyStaleInstall(opts, targetVersion);
            return { ok: true };
        }
        warnAdvisoryOnce(advisoryId, `[update] advisory ${advisoryId}: install failed: ${result.error} (will retry next cycle)`);
        return { ok: false, error: result.error };
    } finally {
        await lock.release();
    }
}

export function startAutoUpdate(opts: UpdateOptions): void {
    // First check after a short delay (don't block startup / don't race the
    // listening socket).
    loggerLog("info", `[update] auto-update enabled (checking every ${CHECK_INTERVAL_MS / 1000 | 0}s)`);
    setTimeout(() => {
        void checkForUpdate(opts);
    }, 10_000);
    timer = setInterval(() => {
        void checkForUpdate(opts);
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
}
