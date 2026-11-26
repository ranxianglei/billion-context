/**
 * `bili install <ref>` (#7806): install billion-context from an arbitrary git
 * ref (PR number / PR URL / branch / tag / master) and auto-pin the result so
 * the auto-updater can't silently swap the dev build back to a release.
 *
 * Flow (matches the owner's private `~/.local/bin/bili-install` script):
 *   1. resolve the ref to a concrete git ref
 *   2. persistent shallow clone into the cache dir (one clone per ref)
 *   3. build (npm install devDeps + npm run build)
 *   4. back up the current global install (keep the last 2)
 *   5. `npm install -g <clonedir> --install-links` — a REAL copy, never a
 *      symlink (#1225: on npm ≥ 9 a local-dir install without --install-links
 *      symlinks the dev tree and leaks edits)
 *   6. verify (not a symlink + dist/index.js present + version readable)
 *   7. write the pin with `source: {kind:"git", ref, sha}` (#6804 state
 *      machine) so auto-upgrade holds the dev build
 *
 * Self-replacement safety: `bili install` runs while THIS process stands on
 * the dist/ being replaced (Linux inode pinning keeps it alive). ALL
 * post-install verification goes through subprocess / disk read — we never
 * `require()` the new tree in-process.
 *
 * Subprocesses (git/npm) run under a hermetic env whitelist (ENV_WHITELIST);
 * tests put PATH shims (fake git/npm) on PATH so the whole flow is offline.
 *
 * No new config keys: the pin is machine-level state in the cache dir
 * (Configuration Surface Discipline, same stance as #6804).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { safePrefix } from "./text-safe.js";
import { parsePinDuration, readPin, writePin, type PinRecord } from "./update-pin.js";

/** The repo every ref is resolved against (this package's own source). */
export const INSTALL_REPO_URL = "https://github.com/ranxianglei/billion-context.git";
const PACKAGE_NAME = "billion-context";
const GIT_TIMEOUT_MS = 120_000;
const NPM_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 600_000;
/** How many previous global installs to keep as backups (issue: 保留最近 2 份). */
const KEEP_BACKUPS = 2;
/** Default auto-upgrade hold for a dev install (#7806 item 2: 默认 30 天). A
 *  PR-head build often carries the SAME version as a release, so the tag
 *  channel can't tell it apart — the pin is what keeps auto-upgrade from
 *  swapping it back. `bili install <ref> <duration>` overrides it. */
const DEFAULT_INSTALL_PIN = "30d";

/** Hermetic env whitelist for the git/npm subprocesses. Only these vars are
 *  passed through: enough for git/npm/node to function (PATH, home, temp,
 *  XDG dirs, locale) plus the proxy + npm registry/CA vars the install needs
 *  to reach GitHub and fetch the package's own deps. Everything else —
 *  GIT_DIR/GIT_WORK_TREE, arbitrary npm_config_* overrides, NODE_OPTIONS — is
 *  dropped so the parent environment can't steer the install. Tests rely on
 *  PATH carrying a shim dir with fake git/npm (fully offline). */
const ENV_WHITELIST = [
    "PATH",
    "HOME", "USERPROFILE",
    "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC",
    "TMPDIR", "TEMP", "TMP",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
    "LANG", "LC_ALL", "TERM",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy",
    "npm_config_registry", "npm_config_cafile",
] as const;

/** Build the hermetic env for a subprocess from the current process env. */
export function hermeticEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ENV_WHITELIST) {
        const v = process.env[k];
        if (v !== undefined) env[k] = v;
    }
    return env;
}

/** Resolve the npm executable the same way pack-install does (Windows ships
 *  npm as a .cmd shim that fails silently without a shell — use the
 *  node_modules/npm/bin/npm-cli.js next to the running node binary instead). */
function resolveNpmExec(): { file: string; argsPrefix: string[] } {
    if (process.platform === "win32") {
        const cliJs = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
        if (existsSync(cliJs)) return { file: process.execPath, argsPrefix: [cliJs] };
    }
    return { file: process.platform === "win32" ? "npm.cmd" : "npm", argsPrefix: [] };
}

/** A ref the user passed to `bili install`. */
interface ResolvedRef {
    /** The git ref to fetch (branch name / tag / `pull/<n>/head`). */
    gitRef: string;
    /** True when the ref is a PR head. */
    isPr: boolean;
}

/** Resolve a user-supplied ref (#7806 item 1): a bare PR number (`7738`) or a
 *  GitHub PR URL becomes `pull/<n>/head` (the raw PR head); anything else is
 *  used verbatim as a branch or tag name. Never throws on shape — a bad ref
 *  surfaces as a git fetch error with the ref named. */
export function resolveRef(input: string): ResolvedRef {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("ref is required (a PR number, PR URL, branch, tag, or master)");
    const prUrl = trimmed.match(/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    if (prUrl) return { gitRef: `pull/${prUrl[1]}/head`, isPr: true };
    if (/^\d+$/.test(trimmed)) return { gitRef: `pull/${trimmed}/head`, isPr: true };
    return { gitRef: trimmed, isPr: false };
}

/** Persistent clone dir for a ref (cache dir, one per ref, reused across
 *  installs so re-installing the same ref re-fetches instead of re-cloning). */
export function cloneDirFor(gitRef: string): string {
    const hash = createHash("sha256").update(gitRef).digest("hex").slice(0, 12);
    return path.join(cacheDir(), "git-install", hash);
}

interface RunResult {
    stdout: string;
}

function run(file: string, args: string[], opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }): RunResult {
    try {
        const stdout = execFileSync(file, args, { cwd: opts.cwd, timeout: opts.timeout, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
        return { stdout: stdout.toString("utf-8") };
    } catch (error) {
        const err = error as { message?: string; stderr?: unknown };
        const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
        const tailLines = stderr.split("\n");
        // text-safe family gate: no raw negative slice literals; head-keep,
        // surrogate-safe via safePrefix (#816/#1615 discipline).
        const tail = safePrefix((tailLines.length > 3 ? tailLines.slice(tailLines.length - 3) : tailLines).join(" "), 300);
        if (/ENOENT/.test(String(err.message))) throw new Error(`${path.basename(file)} was not found on PATH`);
        throw new Error(`${path.basename(file)} ${args.slice(0, 3).join(" ")} failed${tail ? `: ${tail}` : `: ${String(err.message)}`}`);
    }
}

/** Ensure the clone for a ref exists and is at the ref's current head.
 *  Returns the clone dir + the exact sha it's checked out at. */
function ensureClone(resolved: ResolvedRef, env: NodeJS.ProcessEnv): { dir: string; sha: string } {
    const dir = cloneDirFor(resolved.gitRef);
    // Create the clone dir ITSELF (not just its parent) — `git init` runs with
    // cwd=dir and the spawn fails ENOENT on a missing cwd.
    mkdirSync(dir, { recursive: true });
    const git = (args: string[], timeout: number = GIT_TIMEOUT_MS) => run("git", args, { cwd: dir, timeout, env });
    if (!existsSync(path.join(dir, ".git"))) {
        git(["init", "--quiet"]);
        git(["remote", "add", "origin", INSTALL_REPO_URL]);
    }
    // Shallow-fetch the specific ref into a local ref and check it out
    // detached. Works uniformly for branches, tags and PR heads
    // (`pull/<n>/head` resolves to refs/pull/<n>/head on GitHub).
    git(["fetch", "--depth", "1", "--quiet", "origin", `${resolved.gitRef}:refs/bili/head`]);
    git(["checkout", "--quiet", "--detach", "refs/bili/head"]);
    const sha = git(["rev-parse", "HEAD"]).stdout.trim();
    return { dir, sha };
}

/** Build the clone: install its (dev) deps, then run its build script. */
function buildClone(dir: string, env: NodeJS.ProcessEnv): void {
    const npmExec = resolveNpmExec();
    const npm = (args: string[], timeout: number) => run(npmExec.file, [...npmExec.argsPrefix, ...args], { cwd: dir, timeout, env });
    npm(["install", "--no-audit", "--no-fund"], NPM_TIMEOUT_MS);
    npm(["run", "build"], BUILD_TIMEOUT_MS);
}

/** The global node_modules root (`npm root -g`) — where a global install
 *  lands. Resolved in the hermetic env so it matches where `npm install -g`
 *  writes. */
function globalRoot(env: NodeJS.ProcessEnv): string {
    const npmExec = resolveNpmExec();
    return run(npmExec.file, [...npmExec.argsPrefix, "root", "-g"], { cwd: process.cwd(), timeout: NPM_TIMEOUT_MS, env }).stdout.trim();
}

/** Back up the current global install by renaming it aside (cheap + atomic),
 *  pruning to the last KEEP_BACKUPS. Returns the backup dir, or undefined
 *  when there was nothing to back up. */
function backupCurrentInstall(installDir: string): string | undefined {
    if (!existsSync(installDir)) return undefined;
    const parent = path.dirname(installDir);
    const base = path.basename(installDir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(parent, `${base}.backup-${ts}`);
    renameSync(installDir, backupDir);
    const backups = readdirSync(parent).filter((n) => n.startsWith(`${base}.backup-`)).sort();
    while (backups.length > KEEP_BACKUPS) {
        const oldest = backups.shift();
        if (oldest) rmSync(path.join(parent, oldest), { recursive: true, force: true });
    }
    return backupDir;
}

/** Read the installed version straight off disk (never require the new tree). */
function readInstalledVersion(installDir: string): string | undefined {
    try {
        const manifest = JSON.parse(readFileSync(path.join(installDir, "package.json"), "utf-8")) as { version?: unknown };
        return typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : undefined;
    } catch {
        return undefined;
    }
}

/** Post-install verification, all via disk read / lstat (self-replacement
 *  safe — the running process still stands on the old dist/). Throws with a
 *  specific reason when the install is not sound. */
function verifyInstall(installDir: string): string {
    const st = lstatSync(installDir);
    if (st.isSymbolicLink()) {
        throw new Error(`install at ${installDir} is a SYMLINK — #1225 regression (npm installed a link instead of a copy); remove it and re-run with --install-links`);
    }
    if (!existsSync(path.join(installDir, "dist", "index.js"))) {
        throw new Error(`install at ${installDir} has no dist/index.js — the build did not produce the entry point`);
    }
    const version = readInstalledVersion(installDir);
    if (!version) throw new Error(`install at ${installDir} has no readable version in package.json`);
    return version;
}

interface InstallResult {
    ok: true;
    /** The version now on disk (from the cloned package.json). */
    version: string;
    /** The exact commit the tree was built from. */
    sha: string;
    /** The user-facing ref that was installed. */
    ref: string;
    /** The global install dir that now holds the new build. */
    installDir: string;
    /** Where the previous install was backed up (undefined = none existed). */
    backupDir?: string;
    /** Epoch ms the auto-upgrade pin expires (undefined = indefinite). */
    pinUntil?: number;
}

interface InstallError {
    ok: false;
    error: string;
}

/** The full `bili install <ref> [duration]` flow. Returns a structured result
 *  (ok:true) or a structured error (ok:false) — the CLI prints it. Never
 *  leaves the previous install gone: a failed global install restores the
 *  backup before reporting. */
export async function installFromGitRef(refInput: string, durationText?: string): Promise<InstallResult | InstallError> {
    try {
        const resolved = resolveRef(refInput);
        // No duration given → the default 30-day hold (#7806 item 2). An
        // explicit duration (7d / forever / …) overrides it.
        const duration = parsePinDuration(durationText === undefined ? DEFAULT_INSTALL_PIN : durationText);
        if ("error" in duration) return { ok: false, error: duration.error };
        const env = hermeticEnv();

        const { dir: cloneDir, sha } = ensureClone(resolved, env);
        buildClone(cloneDir, env);

        const installDir = path.join(globalRoot(env), PACKAGE_NAME);
        const backupDir = backupCurrentInstall(installDir);

        const npmExec = resolveNpmExec();
        try {
            run(npmExec.file, [...npmExec.argsPrefix, "install", "-g", cloneDir, "--install-links", "--no-audit", "--no-fund"], { cwd: process.cwd(), timeout: NPM_TIMEOUT_MS, env });
        } catch (error) {
            // The previous install is renamed aside — put it back so a failed
            // install never leaves the machine without a working bili.
            if (backupDir && existsSync(backupDir)) {
                try { renameSync(backupDir, installDir); } catch { /* leave the backup in place; report below */ }
            }
            return { ok: false, error: `global install failed: ${String(error)}` };
        }

        const version = verifyInstall(installDir);

        const now = Date.now();
        const pin: PinRecord = {
            v: 1,
            version,
            setAt: now,
            ...(duration.ms !== undefined ? { until: now + duration.ms } : {}),
            source: { kind: "git", ref: resolved.gitRef, sha },
        };
        await writePin(pin);

        return {
            ok: true,
            version,
            sha,
            ref: resolved.gitRef,
            installDir,
            ...(backupDir ? { backupDir } : {}),
            ...(pin.until !== undefined ? { pinUntil: pin.until } : {}),
        };
    } catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error) };
    }
}

interface InstallStatus {
    /** True when the on-disk pin records a git-source (dev) install. */
    hasDevInstall: boolean;
    /** The on-disk version the pin holds (undefined = pin absent/foreign). */
    version?: string;
    /** The git ref the dev install came from. */
    ref?: string;
    /** The exact commit sha. */
    sha?: string;
    /** Epoch ms the pin was set. */
    setAt?: number;
    /** Epoch ms the pin expires (undefined = indefinite). */
    until?: number;
    /** True when the pin is currently active (not expired/stale). */
    active: boolean;
}

/** `bili install status`: report the on-disk version + which git ref/sha it
 *  came from (reads the pin's source field). Pure read — never throws. */
export async function installStatus(): Promise<InstallStatus> {
    const pin = await readPin();
    if (!pin || pin.source === undefined) return { hasDevInstall: false, active: false };
    const now = Date.now();
    const active = pin.version !== undefined && (pin.until === undefined || now < pin.until);
    return {
        hasDevInstall: true,
        version: pin.version,
        ref: pin.source.ref,
        sha: pin.source.sha,
        setAt: pin.setAt,
        ...(pin.until !== undefined ? { until: pin.until } : {}),
        active,
    };
}
