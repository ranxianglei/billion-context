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
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { formatPinUntil, parsePinDuration, readPin, writePin } from "./update-pin.js";
import type { PinRecord } from "./update-pin.js";

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
    /** Record every argv (tests assert --install-links etc). */
    argvLog?: string[];
}

function run(cmd: string, args: string[], opts: RunOpts): Promise<string> {
    return new Promise((resolve, reject) => {
        opts.argvLog?.push(cmd + " " + args.join(" "));
        execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
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
 *  a spread of process.env — ambient credentials must not reach git/npm. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER"]) {
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
    /** Version reported by the NEW install's package.json. */
    version: string;
    /** Exact commit installed (FETCH_HEAD at install time). */
    sha: string;
    spec: InstallRefSpec;
    /** Epoch ms the auto-pin expires; absent = indefinite ("forever"). */
    pinUntil?: number;
    /** One-line pin expiry for display (reuses the #6804 formatter). */
    pinDescription: string;
    /** The global package dir the new build landed in. */
    installDir: string;
}

interface InstallOptions {
    /** #6804 duration vocabulary ("7d", "30d", "forever"); default 30d. */
    pinDurationText?: string;
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
 *  to the newest BACKUP_KEEP. No-op when nothing is installed yet. */
async function backupCurrentInstall(globalRoot: string, log?: (line: string) => void): Promise<void> {
    const cur = path.join(globalRoot, PKG_DIR_NAME);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
        st = await stat(cur);
    } catch {
        return; // first install — nothing to back up
    }
    if (!st.isDirectory()) throw new Error(`unexpected ${PKG_DIR_NAME} entry (not a directory) at ${cur}`);
    const ver = (await readDirVersion(cur)) ?? "unknown";
    const backup = path.join(globalRoot, `${PKG_DIR_NAME}.bak-${ver}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await rename(cur, backup);
    log?.(`backed up ${PKG_DIR_NAME} ${ver} → ${path.basename(backup)}`);
    // Prune: keep the newest BACKUP_KEEP backups (name sort = time sort).
    const entries = await readdir(globalRoot);
    const backups = entries
        .filter((e) => e.startsWith(`${PKG_DIR_NAME}.bak-`))
        .sort()
        .reverse();
    for (const stale of backups.slice(BACKUP_KEEP)) {
        await rm(path.join(globalRoot, stale), { recursive: true, force: true });
    }
}

/** Install from a git ref end-to-end: fetch → build → backup → install -g
 *  --install-links → verify → auto-pin. Throws on any step; on failure the
 *  PREVIOUS global install is untouched (the backup happens only after the
 *  build succeeds, immediately before the swap). */
export async function installFromRef(input: string, opts: InstallOptions = {}): Promise<InstallResult> {
    const spec = resolveInstallRef(input);
    const log = opts.log;
    const env = opts.env ?? childEnv();
    const argvLog: string[] = [];
    const now = opts.now ?? Date.now();

    const srcDir = installSrcDir();
    await mkdir(srcDir, { recursive: true });

    // 1) Fetch the ref into the persistent shallow clone.
    const gitOpts: RunOpts = { cwd: srcDir, env, timeoutMs: FETCH_TIMEOUT_MS, argvLog };
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
    await run("git", ["checkout", "-q", "--detach", sha], gitOpts);

    // 2) Build in the working tree (root npm install covers workspaces; the
    //    package's build script chains kernel → pi-subagents → tsup).
    log?.("installing dependencies + building (this can take a few minutes) …");
    await run("npm", ["install", "--no-audit", "--no-fund"], { ...gitOpts, timeoutMs: INSTALL_TIMEOUT_MS });
    await run("npm", ["run", "build"], { ...gitOpts, timeoutMs: INSTALL_TIMEOUT_MS });

    // 3) Swap: back up the current install, then install the new tree.
    const globalRoot = await npmGlobalRoot(env);
    await backupCurrentInstall(globalRoot, log);
    log?.("installing globally …");
    // --install-links: install a REAL COPY of the source dir, never a
    // symlink (#1225: a symlinked global install silently runs whatever
    // the dev tree later becomes).
    await run("npm", ["install", "-g", srcDir, "--install-links"], { ...gitOpts, timeoutMs: INSTALL_TIMEOUT_MS });

    // 4) Verify the swap — disk reads + the new tree's own package.json,
    //    never a require() (self-replacement safety, see module header).
    const installDir = path.join(globalRoot, PKG_DIR_NAME);
    const lst = await lstat(installDir);
    if (lst.isSymbolicLink()) throw new Error(`install at ${installDir} is a SYMLINK — refusing to finish (expected a real copy; #1225)`);
    await stat(path.join(installDir, "dist", "index.js")); // throws if missing
    const version = await readDirVersion(installDir);
    if (!version) throw new Error(`installed ${installDir} has no readable package.json version`);

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
        installDir,
    };
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
