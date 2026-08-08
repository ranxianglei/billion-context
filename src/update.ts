/**
 * Auto-update: periodically checks the npm registry for a newer version of
 * billion-context and installs it globally when one is found.
 *
 * Design notes (differs from the billion-context-pi extension updater):
 *  - The proxy is a long-running server, so we check on startup and then every
 *    few hours (not per-LLM-call like the extension).
 *  - The package is installed globally (`npm install -g`), not into a host
 *    extension dir.
 *  - There is no TUI to show a notification in, so results are logged to the
 *    console (the terminal where `bili` runs, or /tmp/bili-proxy.log for
 *    background test runs). After a successful install the *running* process
 *    is still old code; we log a clear "restart to finish" message.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";

const REGISTRY_BASE = "https://registry.npmjs.org";
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const THROTTLE_FILE = path.join(cacheDir(), ".update-check");
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
/** Versions we've already installed + notified about this process. Prevents
 *  repeated reinstall/notify loops every check cycle until the user restarts
 *  (the running process keeps the old currentVersion until restart). */
const notified = new Set<string>();

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

export type UpdateOptions = {
    /** Package name, e.g. "billion-context". */
    packageName: string;
    /** Currently running version. */
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
        if (!force && now - lastCheck < CHECK_INTERVAL_MS) {
            // Be explicit about BOTH directions so the count can't look wrong:
            // "last checked Ns ago" (monotonic) + "retry in Ms" (countdown).
            const retryIn = ((CHECK_INTERVAL_MS - (now - lastCheck)) / 1000 | 0);
            loggerLog("info", `[update] throttled — last checked ${sinceLastSec}s ago, retry in ${retryIn}s`);
            return;
        }
        await writeLastCheck(now);
        loggerLog("info", `[update] checking npm registry for ${opts.packageName} (last check ${sinceLastSec < 0 ? "never" : sinceLastSec + "s ago"})…`);

        const url = `${REGISTRY_BASE}/${opts.packageName}/latest`;
        const res = await fetch(url, {
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/json" },
        });
        if (!res.ok) {
            loggerLog("warn", `[update] registry returned ${res.status} ${res.statusText}, skipping`);
            return;
        }
        const data = (await res.json()) as { version?: string };
        const latest = data.version;
        if (!latest) {
            loggerLog("warn", `[update] registry response had no version, skipping`);
            return;
        }
        if (!isNewer(latest, opts.currentVersion)) {
            loggerLog("info", `[update] current=${opts.currentVersion} latest=${latest} (up to date)`);
            return;
        }
        // Already installed and notified about this version — don't loop.
        if (notified.has(latest)) {
            loggerLog("info", `[update] latest=${latest} already installed this run, awaiting restart`);
            return;
        }
        loggerLog("info", `[update] new version found: ${opts.currentVersion} → ${latest}, installing…`);

        const installed = await installLatest(opts.packageName, latest);
        notified.add(latest);
        if (installed) {
            loggerLog("info", `[update] installed ${opts.packageName} ${opts.currentVersion} → ${latest}. Restart to finish.`);
        } else {
            loggerLog("warn", `[update] install failed; run manually: npm install -g ${opts.packageName}@${latest}`);
        }
    } catch (e) {
        loggerLog("warn", `[update] check failed: ${String(e)}`);
    } finally {
        inFlight = false;
    }
}

async function installLatest(packageName: string, latest: string): Promise<boolean> {
    // Reject anything that isn't a strict semver before handing it to npm.
    if (!SEMVER_RE.test(latest)) return false;
    try {
        const code = await new Promise<number>((resolve) => {
            execFile(
                "npm",
                ["install", "-g", `${packageName}@${latest}`, "--silent", "--no-audit", "--no-fund"],
                { timeout: 120_000, shell: process.platform === "win32" },
                (err) => resolve(err ? 1 : 0),
            );
        });
        return code === 0;
    } catch {
        return false;
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

/** Stop the periodic check loop (for tests / clean shutdown). */
export function stopAutoUpdate(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}
