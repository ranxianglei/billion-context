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
import { readFile, writeFile, mkdir, access, constants, rm, cp, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import crypto from "node:crypto";
import * as tar from "tar";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { cacheDir } from "./paths.js";
import { log as loggerLog, type Logger } from "./logger.js";
import { refreshDshProfileBundles, isDshProfileCopy } from "./dsh-channel.js";
import { resolveDshHome, resolveKimiHome, resolveOmpHome, resolvePiHome } from "./client-config.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import type { FetchOptions } from "./fetch-util.js";

// BILI_UPDATE_REGISTRY overrides the registry base URL (full URL, e.g. a
// loopback verdaccio in the hermetic e2e suite, #1153). Unset = production
// default, behavior unchanged.
/** Normalize a configured registry base URL: absent/blank → production default; trailing slashes dropped (npm normalizes them too). */
export function normalizeRegistryBase(raw: string | undefined): string {
    const v = raw?.trim();
    if (!v) return "https://registry.npmjs.org";
    return v.replace(/\/+$/, "");
}
const REGISTRY_BASE = normalizeRegistryBase(process.env.BILI_UPDATE_REGISTRY);

/** Normalize a configured dist-tag channel: absent/blank → "latest". */
export function normalizeUpdateTag(tag: string | undefined): string {
    return (tag ?? "latest").trim() || "latest";
}

/** Registry URL for a package's dist-tag document (exported for tests). */
export function registryUrlFor(packageName: string, tag: string): string {
    return `${REGISTRY_BASE}/${packageName}/${encodeURIComponent(tag)}`;
}
const DEFAULT_CHECK_INTERVAL_MS = 3 * 60 * 1000;

// BILI_UPDATE_CHECK_INTERVAL_MS overrides the check period in ms (must be > 0)
// so the hermetic e2e suite need not wait 3 minutes (#1153). Unset = default.
function checkIntervalMs(): number {
    const raw = Number(process.env.BILI_UPDATE_CHECK_INTERVAL_MS?.trim());
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CHECK_INTERVAL_MS;
}
const CHECK_INTERVAL_MS = checkIntervalMs();
const THROTTLE_FILE = path.join(cacheDir(), ".update-check");
const LOCK_FILE = path.join(cacheDir(), ".update-lock");
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

/** Age after which a lock is stealable even if kill(pid,0) says the holder is
 *  "alive": a real install never takes this long, and a crashed holder whose
 *  pid was reused by an unrelated process looks alive forever. Without this
 *  cap, one such residue permanently blocks all future auto-updates. (#117) */
const LOCK_MAX_AGE_MS = 30 * 60 * 1000;

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

async function readLastCheck(): Promise<number> {
    try {
        const data = await readFile(THROTTLE_FILE, "utf-8");
        return parseInt(data.trim(), 10) || 0;
    } catch {
        return 0;
    }
}

async function writeLastCheck(ts: number): Promise<void> {
    try {
        await mkdir(path.dirname(THROTTLE_FILE), { recursive: true });
        await writeFile(THROTTLE_FILE, String(ts), "utf-8");
    } catch {
        // best-effort
    }
}

/** Last completed registry-check time (epoch ms) for diagnostics (#1235); undefined when never checked. */
export async function lastUpdateCheckTime(): Promise<number | undefined> {
    const ts = await readLastCheck();
    return ts > 0 ? ts : undefined;
}

/**
 * Walk up from this module's location until we find the directory whose
 * package.json `name` matches `packageName`. This is the install directory.
 * Exported for the pre-re-exec gate (#811).
 */
export async function findInstallDir(packageName: string): Promise<string | undefined> {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
        try {
            const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8"));
            if (pkg.name === packageName) return dir;
        } catch {
            // not a package.json or doesn't match — keep walking
        }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
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

export interface HostManagedInstall {
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
export function hostManagedInstall(installDir: string, env: NodeJS.ProcessEnv = process.env): HostManagedInstall | undefined {
    let real = installDir;
    try {
        real = realpathSync(installDir);
    } catch {
        // nonexistent or unreadable — evaluate the literal path
    }
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
        ["pi", resolvePiHome(env), "`pi update` (pi installs and upgrades the npm:billion-context entry itself)"],
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
async function readDiskVersion(installDir: string): Promise<string | undefined> {
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
 * be *executed* (running it would start the CLI/server).
 * Returns null on success or a short reason on failure.
 */
async function syntaxCheckEntry(entryAbs: string): Promise<string | null> {
    let source: string;
    try {
        source = await readFile(entryAbs, "utf-8");
    } catch (e) {
        return `entry unreadable: ${String(e)}`;
    }
    const tmpCheck = path.join(cacheDir(), ".update-syntax-check.mjs");
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
 *  dev lanes stay manual. Best-effort: never throws, never blocks the proxy;
 *  a failed refresh retries on the next check cycle (unlike the post-self-
 *  update trigger, which fires once per install event and never retries). */
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
        await refreshDshProfileBundles(latest, log, env);
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
        const lastCheck = await readLastCheck();
        const sinceLastSec = lastCheck ? ((now - lastCheck) / 1000 | 0) : -1;
        if (!force && firstCheckDone && now - lastCheck < CHECK_INTERVAL_MS) {
            const retryIn = ((CHECK_INTERVAL_MS - (now - lastCheck)) / 1000 | 0);
            loggerLog("info", `[update] throttled \u2014 last checked ${sinceLastSec}s ago, retry in ${retryIn}s`);
            return;
        }
        await writeLastCheck(now);
        firstCheckDone = true;

        // Source-checkout guard (#580): findInstallDir() walks up from the
        // running dist/ and lands on the repo root when bili runs from a git
        // clone (node dist/index.js start). An in-place tarball copy would
        // silently rewrite tracked files (the version pin, READMEs), so refuse
        // to self-update here instead of proceeding.
        const installDir = await findInstallDir(opts.packageName);
        if (installDir && await isGitWorkingTree(installDir)) {
            loggerLog("info", `[update] running from a source checkout (${installDir}) \u2014 skipping auto-update (use npm install -g ${opts.packageName})`);
            return;
        }

        // #991 single-writer: when this install dir belongs to a host (pnpm
        // store, pi/opencode/dsh/kimi/omp trees), the copy must only be
        // updated through its owner — never overwritten in place by the
        // global self-updater.
        const managed = installDir ? hostManagedInstall(installDir) : undefined;
        if (managed && installDir) {
            loggerLog("info", `[update] install dir is managed by ${managed.owner} (${installDir}) \u2014 skipping in-place self-update; update it via ${managed.channel} (#991)`);
            // #1196: a copy living inside a dsh profile bundle cannot wait
            // for a global self-update that may never come (dsh-market users
            // often have no global install at all) — drive the lockstep
            // refresh through dsh's own plugin channel from here.
            await refreshDshProfileCopy(installDir, opts, process.env, loggerLog);
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
            return;
        }

        const tarballUrl = data.dist?.tarball;
        const integrity = data.dist?.integrity;
        const shasum = data.dist?.shasum;
        if (!tarballUrl) {
            loggerLog("warn", `[update] registry response for ${latest} had no tarball URL`);
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
                loggerLog("info", `[update] installed ${currentVersion} \u2192 ${latest}. Restart to finish.`);
                // #966: dsh profile copies load their own plugin+proxy from the
                // profile's node_modules — without this they would keep running
                // the old version next to the new global one (#953). Best-effort:
                // never fails the update itself.
                await refreshDshProfileBundles(latest, loggerLog);
                notifyStaleInstall(opts, latest);
            } else {
                loggerLog("warn", `[update] install failed: ${result.error}. Will retry next cycle.`);
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

export async function installViaTarball(
    version: string,
    tarballUrl: string,
    installDir: string | undefined,
    integrity?: string,
    shasum?: string,
    dispatcher?: object,
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
    const managed = hostManagedInstall(installDir);
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

    // Write to temp file
    const tmpFile = path.join(cacheDir(), `.update-${version}.tgz`);
    try {
        await mkdir(cacheDir(), { recursive: true });
        await writeFile(tmpFile, tgzBuffer);
    } catch (e) {
        return { ok: false, error: `failed to write temp file ${tmpFile}: ${String(e)}` };
    }

    // Extract to a temp staging dir (NOT directly over install dir).
    // Uses the `tar` npm package (pure JS, cross-platform) instead of
    // shelling out to the `tar` binary, which is absent or inconsistent on
    // Windows. `--strip-components=1` maps to `strip: 1` (npm tarballs wrap
    // files in a `package/` dir).
    const stagingDir = path.join(cacheDir(), `.update-staging-${version}`);
    try {
        // Clean any leftover staging dir from a previous failed attempt.
        await rm(stagingDir, { recursive: true, force: true });
        await mkdir(stagingDir, { recursive: true });

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

    // Back up the current install before overwriting. If anything fails after
    // the copy (partial copy, version drift, corrupted entry), the backup is
    // restored so the previously working version keeps running.
    const backupDir = path.join(cacheDir(), `.update-backup-${version}`);
    try {
        await rm(backupDir, { recursive: true, force: true });
        await cp(installDir, backupDir, { recursive: true, force: true });
    } catch (e) {
        // Fail closed: without a backup we refuse to overwrite the running
        // install — the current version keeps working.
        return { ok: false, error: `backup of current install failed (install left untouched): ${String(e)}` };
    }

    const restoreFromBackup = async (): Promise<string | null> => {
        try {
            await rm(installDir, { recursive: true, force: true });
            await cp(backupDir, installDir, { recursive: true, force: true });
            return null;
        } catch (e) {
            // Keep the backup dir — it is the only healthy copy left.
            return `ROLLBACK FAILED — restore ${backupDir} to ${installDir} manually: ${String(e)}`;
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

    // Success: the backup is no longer needed.
    await rm(backupDir, { recursive: true, force: true });

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

/** Stop the periodic check loop (for tests / clean shutdown). */
export function stopAutoUpdate(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}
