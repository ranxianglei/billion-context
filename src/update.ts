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

const REGISTRY_BASE = "https://registry.npmjs.org";
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const THROTTLE_FILE = path.join(cacheDir(), ".update-check");
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

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
        if (!force && now - (await readLastCheck()) < CHECK_INTERVAL_MS) return;
        await writeLastCheck(now);

        const url = `${REGISTRY_BASE}/${opts.packageName}/latest`;
        const res = await fetch(url, {
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/json" },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { version?: string };
        const latest = data.version;
        if (!latest || !isNewer(latest, opts.currentVersion)) return;

        const installed = await installLatest(opts.packageName, latest);
        if (installed) {
            // Green ✔ — the only notification channel for a headless server.
            // eslint-disable-next-line no-console
            console.error(
                `\x1b[32m\u2714 ${opts.packageName} auto-updated ${opts.currentVersion} \u2192 ${latest}. Restart bili to finish.\x1b[0m`,
            );
        } else {
            // eslint-disable-next-line no-console
            console.error(
                `\x1b[33m${opts.packageName} ${latest} is available (you have ${opts.currentVersion}). Update with: npm install -g ${opts.packageName}@latest\x1b[0m`,
            );
        }
    } catch {
        // network/registry error — silent, will retry next interval
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

/** Start the periodic check loop. Checks once shortly after start, then every 6h. */
export function startAutoUpdate(opts: UpdateOptions): void {
    // First check after a short delay (don't block startup / don't race the
    // listening socket).
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
