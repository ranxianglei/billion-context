/**
 * `bili install <ref>` (#7806): install billion-context from an arbitrary git
 * ref — branch, tag, PR number, or PR URL — built from source.
 *
 * Complements #6804's registry lane: `bili update [version]` installs a
 * PUBLISHED version (release or master temp build) from the npm registry;
 * this lane installs code that was NEVER published (a PR head, a side
 * branch). The two share the pin state machine (#6804): a source install
 * is AUTO-PINNED on success (default 30 days) because a PR-head build's
 * version string is often identical to a released version (no `-pr`
 * suffix), so the tag-channel rule cannot tell "dev build" from "release"
 * by semver — only the pin guarantees auto-upgrade stays check-only.
 *
 * Self-replacement safety: while this runs, the bili process is executing
 * from the very `dist/` it is about to replace. That is safe on Linux (the
 * running process keeps its inode; npm replaces directory entries, not
 * inodes), but every post-install verification must therefore go through
 * disk reads or CHILD processes — never a require() into the new tree.
 *
 * Hermetic child-process discipline: git/npm are spawned with a minimal
 * env allowlist (PATH/HOME/locale + npm quieting); tests inject their own
 * PATH with fake git/npm so the whole flow runs offline.
 */

import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { log as loggerLog } from "./logger.js";
import { cacheDir } from "./paths.js";
import { formatPinUntil, parsePinDuration, readPin, writePin } from "./update-pin.js";
import type { PinRecord } from "./update-pin.js";
import { tryAcquireLock } from "./update.js";

/** The repo this installer knows how to build. Fixed by design — this is a
 *  self-installer, not a generic git tool (scope creep = supply-surface). */
const INSTALL_REPO_URL = "https://github.com/ranxianglei/billion-context.git";

const PKG_DIR_NAME = "billion-context";
const SRC_DIR_NAME = "install-src";
const BACKUP_KEEP = 2;
const FETCH_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** #7806: a source install is held for this long unless the user passes an
 *  explicit duration — long enough that a forgotten pin does not quietly
 *  roll a dev build back to the release channel mid-experiment. */
export const DEFAULT_INSTALL_PIN_DAYS = 30;
export const DEFAULT_INSTALL_PIN_DURATION = `${DEFAULT_INSTALL_PIN_DAYS}d`;

interface InstallRefSpec {
    /** The ref git will fetch: `pull/N/head` for PRs, else the raw name. */
    ref: string;
    kind: "pr" | "ref";
}

/** Map user input to a fetchable ref. Bare PR numbers and PR URLs become
 *  `pull/N/head` (the PR's RAW head — what the PR CI tested, as-is).
 *  Anything else passes through as a branch/tag name; git validates it. */
export function resolveInstallRef(input: string): InstallRefSpec {
    const t = input.trim();
    if (/^\d+$/.test(t)) return { ref: `pull/${t}/head`, kind: "pr" };
    const m = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/.exec(t);
    if (m) return { ref: `pull/${m[1]}/head`, kind: "pr" };
    if (!t) throw new Error("empty ref");
    return { ref: t, kind: "ref" };
}

interface RunOpts {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
}

function run(cmd: string, args: string[], opts: RunOpts): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                const tail = String(stderr).trim().split("\n").slice(-3).join(" | ");
                reject(new Error(`${cmd} ${args.join(" ")} failed${tail ? `: ${tail}` : ""}`));
                return;
            }
            resolve(String(stdout));
        });
    });
}

/** Minimal child env: PATH/HOME/locale plus npm quieting. Deliberately NOT
 *  a spread of process.env — ambient CREDENTIALS must not reach git/npm.
 *  Standard proxy variables are routing, not credentials: users whose only
 *  route to GitHub/the registry is an HTTP proxy (corporate networks, VPNs)
 *  must not break just because this lane exists, so those pass through
 *  (#7806 review). File-based configuration (~/.gitconfig, ~/.npmrc) keeps
 *  working because HOME itself is passed. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of [
        "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER",
        // Windows: npm.cmd runs under cmd.exe and git-for-windows both need these.
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
        "SystemRoot", "windir", "COMSPEC", "PATHEXT",
        // Proxy routing (explicitly NOT credentials).
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
        "npm_config_proxy", "npm_config_https_proxy", "npm_config_noproxy",
    ]) {
        if (typeof base[k] === "string") env[k] = base[k]!;
    }
    if (!env.LANG) env.LANG = "C.UTF-8";
    env.npm_config_fund = "false";
    env.npm_config_audit = "false";
    env.npm_config_update_notifier = "false";
    return env;
}

interface InstallResult {
    ok: true;
    /** True when the ref was already installed (same source + sha) and the
     *  rebuild was skipped — pass `force` to rebuild anyway. */
    skipped?: boolean;
    /** Version reported by the NEW install's package.json (skipped: the current one). */
    version: string;
    /** Exact commit installed (FETCH_HEAD at install time). */
    sha: string;
    spec: InstallRefSpec;
    /** Epoch ms the auto-pin expires; absent = indefinite ("forever"). */
    pinUntil?: number;
    /** One-line pin expiry for display (reuses the #6804 formatter); absent on skip. */
    pinDescription?: string;
    /** The global package dir the new build landed in. */
    installDir: string;
}

interface InstallOptions {
    /** #6804 duration vocabulary ("7d", "30d", "forever"); default 30d. */
    pinDurationText?: string;
    /** Rebuild even when this ref@sha is already the installed, pinned build. */
    force?: boolean;
    /** Child-process env (tests inject PATH shims). Default: childEnv(). */
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    now?: number;
}

/** The persistent shallow-clone working tree (reused across installs so
 *  re-fetching a ref is one fetch, not a fresh clone). */
export function installSrcDir(): string {
    return path.join(cacheDir(), SRC_DIR_NAME);
}

async function npmGlobalRoot(env: NodeJS.ProcessEnv): Promise<string> {
    const out = await run("npm", ["root", "-g"], { env, timeoutMs: 60_000 });
    const root = out.trim().split("\n").pop()?.trim();
    if (!root) throw new Error("npm root -g returned no path");
    return root;
}

async function readDirVersion(dir: string): Promise<string | undefined> {
    try {
        const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}

/** Backup the current global install (rename to .bak-<ver>-<ts>) and prune
 *  to the newest BACKUP_KEEP (by mtime — the NAME sort would order by version
 *  prefix, not time, and could prune the newest rollback point). Returns the
 *  backup path so the caller can restore it if the swap fails; undefined when
 *  nothing was installed yet. */
async function backupCurrentInstall(globalRoot: string, log?: (line: string) => void): Promise<string | undefined> {
    const cur = path.join(globalRoot, PKG_DIR_NAME);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
        st = await stat(cur);
    } catch {
        return undefined; // first install — nothing to back up
    }
    if (!st.isDirectory()) throw new Error(`unexpected ${PKG_DIR_NAME} entry (not a directory) at ${cur}`);
    const ver = (await readDirVersion(cur)) ?? "unknown";
    const backup = path.join(globalRoot, `${PKG_DIR_NAME}.bak-${ver}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await rename(cur, backup);
    log?.(`backed up ${PKG_DIR_NAME} ${ver} → ${path.basename(backup)}`);
    // Prune: keep the newest BACKUP_KEEP backups by mtime (touch the fresh
    // one first so clock skew between stat resolutions can't demote it).
    await utimes(backup, new Date(), new Date());
    const entries = await readdir(globalRoot);
    const backups: Array<{ name: string; mtimeMs: number }> = [];
    for (const e of entries) {
        if (!e.startsWith(`${PKG_DIR_NAME}.bak-`)) continue;
        const est = await stat(path.join(globalRoot, e)).catch(() => undefined);
        if (est) backups.push({ name: e, mtimeMs: est.mtimeMs });
    }
    backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of backups.slice(BACKUP_KEEP)) {
        await rm(path.join(globalRoot, stale.name), { recursive: true, force: true });
    }
    return backup;
}

/** Install from a git ref end-to-end: fetch → build → backup → install -g
 *  --install-links → verify → auto-pin. Throws on any step.
 *
 *  Failure semantics: failures BEFORE the swap leave the previous install
 *  untouched. A failure DURING/AFTER the swap (the global dir is renamed
 *  away, the new install not yet complete) is auto-healed: the backup is
 *  renamed back and the error names it for a manual `mv` in the rare case
 *  the auto-restore itself cannot run (e.g. the process was killed).
 *
 *  The whole flow holds the cross-process update lock (#117 / #3619 family):
 *  a concurrent `bili install` in another terminal and the background
 *  auto-update must never run two npm writers into one global root, and the
 *  success-path `clearPin` of a concurrent registry install must not delete
 *  the source pin written at the end of this flow. */
export async function installFromRef(input: string, opts: InstallOptions = {}): Promise<InstallResult> {
    const spec = resolveInstallRef(input);
    const log = opts.log;
    const env = opts.env ?? childEnv();
    const now = opts.now ?? Date.now();

    // Serialized against every other npm writer on this machine's global root.
    const lock = await tryAcquireLock();
    if (!lock) {
        throw new Error("another bili update/install is already in progress — retry in a minute");
    }
    try {
    return await installFromRefLocked(input, spec, opts, log, env, now);
    } finally {
        await lock.release();
    }
}

async function installFromRefLocked(input: string, spec: InstallRefSpec, opts: InstallOptions, log: ((line: string) => void) | undefined, env: NodeJS.ProcessEnv, now: number): Promise<InstallResult> {
    const srcDir = installSrcDir();
    await mkdir(srcDir, { recursive: true });

    // 1) Fetch the ref into the persistent shallow clone.
    const gitOpts: RunOpts = { cwd: srcDir, env, timeoutMs: FETCH_TIMEOUT_MS };
    const hasGit = await stat(path.join(srcDir, ".git")).then(() => true, () => false);
    if (!hasGit) {
        await run("git", ["init", "-q"], gitOpts);
        await run("git", ["remote", "remove", "origin"], { ...gitOpts, timeoutMs: 30_000 }).catch(() => {});
        await run("git", ["remote", "add", "origin", INSTALL_REPO_URL], gitOpts);
    } else {
        await run("git", ["remote", "set-url", "origin", INSTALL_REPO_URL], gitOpts);
    }
    log?.(`fetching ${spec.ref} …`);
    await run("git", ["fetch", "-q", "--depth", "1", "origin", spec.ref], gitOpts);
    const sha = (await run("git", ["rev-parse", "FETCH_HEAD"], gitOpts)).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`unexpected FETCH_HEAD: ${sha}`);
    // Already on this exact build? The pin's git provenance (source.ref +
    // source.sha) records what the on-disk install was built from — if it
    // matches, the rebuild + backup + pin churn is pointless. `--force`
    // overrides (repairing a half-broken install is the point of that).
    if (!opts.force) {
        const globalRootNow = await npmGlobalRoot(env);
        const diskVersion = await readDirVersion(path.join(globalRootNow, PKG_DIR_NAME));
        const pin = (await readPin()) ?? undefined;
        if (diskVersion && pin?.version === diskVersion && pin.source?.kind === "git" && pin.source.ref === spec.ref && pin.source.sha === sha) {
            log?.(`${spec.ref} @ ${sha.slice(0, 8)} is already installed (${diskVersion}) — skipping; use --force to rebuild`);
            return { ok: true, skipped: true, version: diskVersion, sha, spec, installDir: path.join(globalRootNow, PKG_DIR_NAME) };
        }
    }
    await run("git", ["checkout", "-q", "--detach", sha], gitOpts);

    // 2) Build in the working tree (root npm install covers workspaces; the
    //    package's build script chains kernel → pi-subagents → tsup).
    log?.("installing dependencies + building (this can take a few minutes) …");
    await run("npm", ["install", "--no-audit", "--no-fund"], { ...gitOpts, timeoutMs: INSTALL_TIMEOUT_MS });
    await run("npm", ["run", "build"], { ...gitOpts, timeoutMs: INSTALL_TIMEOUT_MS });

    // 3) Swap: back up the current install, then install the new tree. The
    //    backup rename is the point of no return — from here on a failure
    //    must restore the backup, because the global root has no working
    //    install and the `bili` bin is dangling (no CLI left to self-heal).
    const globalRoot = await npmGlobalRoot(env);
    const backupPath = await backupCurrentInstall(globalRoot, log);
    const cur = path.join(globalRoot, PKG_DIR_NAME);
    let swapFailed: string | undefined;
    try {
        log?.("installing globally …");
        // --install-links: install a REAL COPY of the source dir, never a
        // symlink (#1225: a symlinked global install silently runs whatever
        // the dev tree later becomes). This step still fetches the package's
        // runtime deps from the registry — the most likely place for a
        // long-running install to be killed.
        await run("npm", ["install", "-g", srcDir, "--install-links"], { ...gitOpts, timeoutMs: INSTALL_TIMEOUT_MS });

        // 4) Verify the swap — disk reads + the new tree's own package.json,
        //    never a require() (self-replacement safety, see module header).
        const lst = await lstat(cur);
        if (lst.isSymbolicLink()) throw new Error(`install at ${cur} is a SYMLINK — refusing to finish (expected a real copy; #1225)`);
        await stat(path.join(cur, "dist", "index.js")); // throws if missing
        const version = await readDirVersion(cur);
        if (!version) throw new Error(`installed ${cur} has no readable package.json version`);

        // 5) Auto-pin (#7806): a source build's version string is often
        //    identical to a release's, so the tag-channel rule cannot protect
        //    it — the pin is what keeps auto-upgrade check-only.
        const dur = parsePinDuration(opts.pinDurationText ?? DEFAULT_INSTALL_PIN_DURATION);
        if ("error" in dur) throw new Error(dur.error);
        const pin: PinRecord = { v: 1, version, setAt: now, source: { kind: "git", ref: spec.ref, sha } };
        if (dur.ms !== undefined) pin.until = now + dur.ms;
        await writePin(pin);

        return {
            ok: true,
            version,
            sha,
            spec,
            pinUntil: pin.until,
            pinDescription: formatPinUntil(pin),
            installDir: cur,
        };
    } catch (e) {
        swapFailed = String(e instanceof Error ? e.message : e);
    }
    // Auto-restore: put the backup back so the machine is exactly as it was
    // before this install started.
    let restored = false;
    if (backupPath) {
        try {
            await rm(cur, { recursive: true, force: true }); // partial install, if any
            await rename(backupPath, cur);
            restored = true;
            loggerLog("warn", `[install] swap failed — restored previous install from ${backupPath}`);
            log?.(`restored previous install from ${path.basename(backupPath)}`);
        } catch (restoreErr) {
            loggerLog("error", `[install] swap failed AND auto-restore failed: ${String(restoreErr)}`);
        }
    }
    // The hint must match what is actually on disk: after a successful
    // auto-restore the backup path is GONE (renamed back), so pointing the
    // user at it for a manual `mv` would be a dead path (#6805 review).
    const restoreHint = !backupPath
        ? ""
        : restored
            ? " — previous install auto-restored"
            : ` — previous install kept at ${backupPath} (restore manually: mv ${backupPath} ${cur})`;
    throw new Error(`${input} @ ${sha.slice(0, 8)}: install step failed: ${swapFailed}${restoreHint}`);
}

interface InstallStatus {
    /** The version of the global install on disk (absent = not installed). */
    version?: string;
    /** True while a pin holds this machine's version. */
    pinned: boolean;
    /** The pin's provenance — present only for `bili install` pins. */
    source?: PinRecord["source"];
    pinUntil?: number;
    /** Rendered line for `bili install status`. */
    line: string;
}

/** What is installed and where it came from (disk version + pin state). */
export async function installStatus(env: NodeJS.ProcessEnv = childEnv()): Promise<InstallStatus> {
    let version: string | undefined;
    try {
        const globalRoot = await npmGlobalRoot(env);
        version = await readDirVersion(path.join(globalRoot, PKG_DIR_NAME));
    } catch {
        version = undefined;
    }
    const pin = await readPin();
    if (!pin || !version) {
        return {
            version,
            pinned: false,
            line: version
                ? `installed: ${version} (no pin — auto-upgrade active)`
                : "no global billion-context found",
        };
    }
    const expired = pin.until !== undefined && Date.now() >= pin.until;
    const line = [
        `installed: ${version}`,
        pin.source
            ? `source:    git ${pin.source.ref} @ ${pin.source.sha.slice(0, 8)}`
            : `pinned:    manually (not a bili install)`,
        `pin:       ${formatPinUntil(pin)}${expired ? " (EXPIRED — auto-upgrade resumes on next check)" : ""}`,
    ].join("\n");
    return { version, pinned: !expired, source: pin.source, pinUntil: pin.until, line };
}
