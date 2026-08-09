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
import * as tar from "tar";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";

const REGISTRY_BASE = "https://registry.npmjs.org";
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const THROTTLE_FILE = path.join(cacheDir(), ".update-check");
const LOCK_FILE = path.join(cacheDir(), ".update-lock");
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;
/** Lock staleness threshold: if a lock file is older than this, it's considered
 *  abandoned (crashed process) and can be stolen. */
const LOCK_STALE_MS = 2 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let firstCheckDone = false;

function parseVersion(v: string): number[] {
    return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
    const l = parseVersion(latest);
    const c = parseVersion(current);
    for (let i = 0; i < 3; i++) {
        const lv = l[i] ?? 0;
        const cv = c[i] ?? 0;
        if (lv > cv) return true;
        if (lv < cv) return false;
    }
    return false;
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

/**
 * Walk up from this module's location until we find the directory whose
 * package.json `name` matches `packageName`. This is the install directory.
 */
async function findInstallDir(packageName: string): Promise<string | undefined> {
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

/** Read the version from the on-disk package.json (not the startup constant). */
async function readDiskVersion(installDir: string): Promise<string | undefined> {
    try {
        const pkg = JSON.parse(await readFile(path.join(installDir, "package.json"), "utf-8"));
        return pkg.version;
    } catch {
        return undefined;
    }
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
        const age = now - existing.ts;
        const holderAlive = isAlive(existing.pid);
        if (holderAlive && age < LOCK_STALE_MS) {
            // Another process is actively updating — back off.
            return null;
        }
        // Lock is stale (holder dead or timeout) — steal it. MUST delete the
        // stale lock file first: writeFile({flag:"wx"}) below requires the path
        // to NOT exist, and the stale file is still there. Without this unlink
        // the wx write always fails → update returns null forever → a single
        // crash during update permanently blocks all future auto-updates.
        loggerLog("info", `[update] stealing stale lock (pid=${existing.pid}, age=${Math.round(age / 1000)}s, alive=${holderAlive})`);
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
};

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
        loggerLog("info", `[update] checking npm registry for ${opts.packageName}${sinceLastSec < 0 ? " (startup check)" : sinceLastSec === 0 ? "" : ` (last check ${sinceLastSec}s ago)`}\u2026`);

        const url = `${REGISTRY_BASE}/${opts.packageName}/latest`;
        const res = await fetch(url, {
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/json" },
        });
        if (!res.ok) {
            loggerLog("warn", `[update] registry returned ${res.status} ${res.statusText}, skipping`);
            return;
        }
        const data = (await res.json()) as {
            version?: string;
            dist?: { tarball?: string };
        };
        const latest = data.version;
        if (!latest) {
            loggerLog("warn", `[update] registry response had no version, skipping`);
            return;
        }

        // Read current version from disk (not from startup constant) so that
        // a successful in-place update is detected without a restart.
        const installDir = await findInstallDir(opts.packageName);
        const diskVersion = installDir ? await readDiskVersion(installDir) : undefined;
        const currentVersion = diskVersion ?? opts.currentVersion;

        if (!isNewer(latest, currentVersion)) {
            loggerLog("info", `[update] current=${currentVersion} latest=${latest} (up to date)`);
            return;
        }

        const tarballUrl = data.dist?.tarball;
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
            const result = await installViaTarball(latest, tarballUrl, installDir);
            if (result.ok) {
                loggerLog("info", `[update] installed ${currentVersion} \u2192 ${latest}. Restart to finish.`);
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

/**
 * Download the npm tarball, extract to a temp staging dir, verify, then copy
 * over the install directory.
 */
async function installViaTarball(
    version: string,
    tarballUrl: string,
    installDir: string | undefined,
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

    // Download tarball
    let tgzBuffer: Buffer;
    try {
        const tgzRes = await fetch(tarballUrl, { signal: AbortSignal.timeout(60_000) });
        if (!tgzRes.ok) {
            return { ok: false, error: `tarball download failed: HTTP ${tgzRes.status} ${tgzRes.statusText}` };
        }
        tgzBuffer = Buffer.from(await tgzRes.arrayBuffer());
    } catch (e) {
        return { ok: false, error: `tarball download failed: ${String(e)}` };
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
    } catch (e) {
        return { ok: false, error: `extraction failed: ${String(e)}` };
    } finally {
        await rm(tmpFile, { force: true });
    }

    // Copy staging over install dir using Node's built-in fs.cp (Node 16.7+).
    // Cross-platform — no dependency on the `cp` binary (absent on Windows).
    // `recursive: true` + the trailing `/.` semantics: fs.cp copies the
    // *contents* of stagingDir into installDir, merging without nesting.
    try {
        await cp(stagingDir, installDir, { recursive: true, force: true });
    } catch (e) {
        return { ok: false, error: `failed to copy to install dir: ${String(e)}` };
    } finally {
        await rm(stagingDir, { recursive: true, force: true });
    }

    // Final verification
    const newVersion = await readDiskVersion(installDir);
    if (newVersion !== version) {
        return { ok: false, error: `post-install verification failed: package.json version is ${newVersion ?? "missing"}, expected ${version}` };
    }

    return { ok: true };
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
