// #966: the dsh-side plugin channel — the single install lane for dsh.
//
// `bili plugin install|remove dsh` drives dsh's own pnpm forwarder
// (`dsh plugin --profile <name> add|remove <spec>`, #950) instead of writing
// managed blocks into every profile's cordis.patch.yml, and the auto-updater
// re-runs the channel after a global self-update so each profile's copy stays
// in lockstep with the global version (closes the #953 drift-crash window).
//
// Kept dependency-light (node builtins + client-config) so update.ts can
// import it without pulling in the rest of the installer graph.

import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { resolveDshHome } from "./client-config.js";

export const DSH_PACKAGE = "billion-context";
// The profile owned by dsh's own desktop app. Its billion-context copy is
// updated in place by bili itself (#1575 owner decision — the CLI refuses this
// profile by design), so every channel-side refresh path must skip it.
export const DSH_DESKTOP_PROFILE = "desktop";

// #1575 (owner decision 2026-10-01): the profile named `desktop` belongs to
// the deepseek-harness Desktop app (Electron), and the dsh CLI refuses to
// manage it — `--profile desktop` is rejected outright ("managed exclusively
// by the Electron application"), so no channel-driven operation can ever
// succeed against it. bili instead owns that copy IN PLACE: the proxy running
// from it updates itself during its periodic check (junction-safe swap,
// #1872). Every channel-driven path therefore SKIPS this profile — driving
// the CLI against it would only log a doomed failure every cycle.
export const DSH_DESKTOP_PROFILE = "desktop";

export function isDshDesktopProfile(name: string): boolean {
    return name === DSH_DESKTOP_PROFILE;
}

const DSH_EXEC_TIMEOUT_MS = 5 * 60 * 1000; // cold pnpm store + slow network

/** Every profile dir under $DSH_HOME/profiles/*. dsh creates a profile dir
 *  per `--profile` on first boot; a missing profiles root means dsh has never
 *  run. Returns the dirs that exist (the patch file itself may still be
 *  absent — dsh materializes it lazily). */
export function dshProfileDirs(env: NodeJS.ProcessEnv = process.env): string[] {
    const profiles = path.join(resolveDshHome(env), "profiles");
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(profiles, { withFileTypes: true });
    } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
            throw new Error(`no dsh profiles found under ${profiles} — run dsh once (any profile) so the profile dirs exist, then retry`);
        }
        throw err;
    }
    return entries.filter((e) => e.isDirectory() && e.name !== "node_modules").map((e) => path.join(profiles, e.name));
}

// — legacy managed-block migration (#966) ————————————————————————————————————

// Pre-unification installs wrote this block into every profile's
// cordis.patch.yml. Strings are STABLE — existing user files carry them.
export const DSH_PATCH_BEGIN = "# bili begin (managed by billion-context — `bili plugin install dsh`)";
export const DSH_PATCH_END = "# bili end";

const DSH_PATCH_HEADER = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n";

/** Remove the managed block between the markers, preserving everything else
 *  (user entries, comments, order). No-op when the file carries no block. */
export function stripDshManagedPatch(text: string): string {
    const begin = text.indexOf(DSH_PATCH_BEGIN);
    if (begin === -1) return text;
    const end = text.indexOf(DSH_PATCH_END, begin);
    if (end === -1) return text;
    const before = text.slice(0, begin).replace(/\n+$/, "\n");
    const after = text.slice(end + DSH_PATCH_END.length);
    return before + after.replace(/^\n+/, "");
}

function restoreDshPatchPlaceholder(text: string): string {
    const meaningful = text.split("\n").some((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));
    if (meaningful) return text.endsWith("\n") ? text : text + "\n";
    const comments = text.split("\n").filter((l) => l.trimStart().startsWith("#")).join("\n");
    const header = comments.length > 0 ? `${comments}\n` : DSH_PATCH_HEADER;
    return `${header}[]\n`;
}

/** True when this profile's cordis.patch.yml still carries a pre-unification
 *  managed block. */
export function dshHasLegacyManagedBlock(profileDir: string): boolean {
    try {
        return fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8").includes(DSH_PATCH_BEGIN);
    } catch {
        return false;
    }
}

/** Strip the legacy managed block from this profile's cordis.patch.yml
 *  (restoring the placeholder shape when nothing meaningful remains).
 *  Returns true when the file was rewritten. Coexistence of a legacy block
 *  and the bundle layer duplicates the `bili-native` loader id and
 *  hard-fails dsh boot (#950 mutual exclusion), so install/remove migrate
 *  old lanes through this before touching the channel. */
export function stripLegacyManagedBlock(profileDir: string): boolean {
    const file = path.join(profileDir, "cordis.patch.yml");
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return false;
    }
    if (!text.includes(DSH_PATCH_BEGIN)) return false;
    fs.writeFileSync(file, restoreDshPatchPlaceholder(stripDshManagedPatch(text)));
    return true;
}

// — profile manifest state ————————————————————————————————————————————————

function readManifestDependencies(profileDir: string): Record<string, unknown> {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> };
    return manifest.dependencies ?? {};
}

/** True iff the profile manifest lists billion-context as a bundle (the
 *  state `dsh plugin add` leaves behind — dsh reconciles
 *  `dsh.profile.bundles` from deps whose resolved manifest declares
 *  `dsh.bundle.patch`). */
export function dshBundleInstalled(profileDir: string): boolean {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8")) as { dsh?: { profile?: { bundles?: unknown } } };
        const bundles = manifest.dsh?.profile?.bundles;
        return Array.isArray(bundles) && bundles.includes(DSH_PACKAGE);
    } catch {
        return false;
    }
}

/** The declared dependency spec for billion-context in this profile
 *  (registry form like "^0.1.120", or a local pin like "link:/x" /
 *  "file:/x.tgz"), or undefined when the profile does not depend on it. */
export function dshProfileDepSpec(profileDir: string): string | undefined {
    try {
        const v = readManifestDependencies(profileDir)[DSH_PACKAGE];
        return typeof v === "string" ? v : undefined;
    } catch {
        return undefined;
    }
}

export function dshProfileDependsOnBili(profileDir: string): boolean {
    return dshProfileDepSpec(profileDir) !== undefined;
}

/** The version of the profile's installed billion-context copy, or undefined
 *  when there is no readable copy yet (declared but never installed). #1803:
 *  refresh skips profiles already sitting at the target version so a stale
 *  sibling cannot cause in-step copies to re-spawn dsh every check cycle;
 *  declared-but-missing mounts still refresh (install what the manifest
 *  declares — #1196 live-update-path contract). */
function installedProfileVersion(profileDir: string): string | undefined {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, "node_modules", DSH_PACKAGE, "package.json"), "utf-8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}

/** Registry-form dep specs (^1.2.3, 1.2.3, >=1.0.0, dist-tags) carry no
 *  scheme; local pins (link:, file:, workspace:, git+, github:, https:) do.
 *  Refresh must never clobber a deliberate local pin. */
export function isRegistryDepSpec(spec: string): boolean {
    return !/^[a-z][a-z0-9+.-]*:/i.test(spec);
}

function underDir(dir: string, root: string): boolean {
    return dir === root || dir.startsWith(root + path.sep);
}

/** True when `installDir` is a copy of billion-context living inside a dsh
 *  profile bundle (<dshHome>/profiles/<name>/…), as written or after symlink
 *  resolution (pnpm store links, dev link: pins). #1196: such a copy has no
 *  global bili driving its refresh — the process running FROM it is the only
 *  candidate to trigger the channel refresh. */
export function isDshProfileCopy(installDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const profiles = path.join(resolveDshHome(env), "profiles");
    const roots = new Set<string>([profiles]);
    try {
        roots.add(fs.realpathSync(profiles));
    } catch {
        // profiles root absent — the literal path is the only form
    }
    const dirs = [installDir];
    try {
        dirs.push(fs.realpathSync(installDir));
    } catch {
        // nonexistent or unreadable — evaluate the literal path
    }
    return dirs.some((dir) => [...roots].some((root) => underDir(dir, root)));
}

// — driving `dsh plugin …` ————————————————————————————————————————————————

export type DshPlan = { command: string; args: string[]; windowsVerbatimArguments?: boolean };
export type DshSyncRun = (plan: DshPlan) => { stdout: string; stderr: string };
export type DshAsyncRun = (plan: DshPlan) => Promise<{ stdout: string; stderr: string }>;

let testRunners: { sync?: DshSyncRun; async?: DshAsyncRun } | undefined;

/** Test seam: replace the real spawn runners (record calls / simulate
 *  failures) without touching PATH. Pass undefined to restore. */
export function _setDshRunnersForTest(r: { sync?: DshSyncRun; async?: DshAsyncRun } | undefined): void {
    testRunners = r;
}

/** #1732: resolve the dsh executable to spawn, in priority order:
 *  1. BILI_DSH_BIN override — explicit user choice, used as-is;
 *  2. PATH lookup (win32 honors PATHEXT ordering);
 *  3. known install locations a GUI-launched process's minimal PATH omits —
 *     same #1429 pattern as launcher.resolveNodeRuntime: a dsh profile
 *     bundle's bili proxy runs inside the dsh desktop app's process tree,
 *     whose PATH does not carry the npm/pnpm global bin dirs, so bare "dsh"
 *     fails with "'dsh' is not recognized" and the #1196 owner-channel
 *     refresh stayed dead on Windows;
 *  4. bare "dsh" fallback — keeps today's behavior when nothing is found, so
 *     the error path still fires with actionable context. */
export function resolveDshBinary(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    existsImpl: (p: string) => boolean = fs.existsSync,
    execPath: string = process.execPath,
): string {
    const override = env.BILI_DSH_BIN?.trim();
    if (override && override.length > 0) return override;
    const sep = platform === "win32" ? ";" : ":";
    const extensions = platform === "win32"
        ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0)
        : [""];
    // join with "/" like resolveNodeRuntime — Windows accepts both separators
    const nodeDir = path.dirname(execPath);
    const home = platform === "win32" ? env.USERPROFILE ?? "" : env.HOME ?? "";
    const extraDirs = platform === "win32"
        ? [nodeDir, env.APPDATA ? env.APPDATA + "/npm" : "", env.LOCALAPPDATA ? env.LOCALAPPDATA + "/pnpm" : ""]
        : [nodeDir, "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", home ? home + "/.local/bin" : ""];
    for (const dir of [...(env.PATH ?? "").split(sep), ...extraDirs]) {
        if (!dir) continue;
        for (const ext of extensions) {
            const name = ext === "" ? "dsh" : `dsh${ext}`;
            const candidate = dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + "/" + name;
            if (existsImpl(candidate)) return candidate;
        }
    }
    return "dsh";
}

/** #679: quote one token for cmd.exe's line parser (same rules as the
 *  launcher's quoteWinToken — mirrored here to keep this module free of a
 *  launcher.ts import, which would cycle through plugin-install). */
function quoteWinToken(token: string): string {
    if (!/\s/.test(token) || token.includes('"')) return token;
    return `"${token}"`;
}

/** #679: which spawn form `dsh` needs. On Windows only .cmd/.bat shims and
 *  unresolved bare names need cmd.exe (CreateProcess cannot execute a batch
 *  file; a bare name needs PATHEXT resolution); anything else spawns direct.
 *  Mirrors the launcher's planClientSpawn for the same reason shell:true was
 *  retired there (DEP0190 + spaced-path truncation). */
export function planDshSpawn(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): DshPlan {
    if (platform !== "win32") return { command, args: [...args] };
    const lower = command.toLowerCase();
    const base = command.slice(Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\")) + 1);
    const needsCmd = lower.endsWith(".cmd") || lower.endsWith(".bat") || !path.extname(base);
    if (!needsCmd) return { command, args: [...args] };
    const comspec = env.COMSPEC?.trim() || "cmd.exe";
    const line = `"${[command, ...args].map(quoteWinToken).join(" ")}"`;
    return { command: comspec, args: ["/d", "/s", "/c", line], windowsVerbatimArguments: true };
}

function formatDshError(err: unknown, args: readonly string[]): Error {
    const e = err as { code?: string | number; status?: number; stderr?: string | Buffer; message?: string };
    if (e.code === "ENOENT") {
        return new Error("dsh CLI not found (not on PATH, not in the known install locations probed) — install deepseek-harness, or set BILI_DSH_BIN to its executable path, then retry");
    }
    const stderr =
        typeof e.stderr === "string"
            ? e.stderr.trim()
            : e.stderr instanceof Buffer // #1732: raw bytes from encoding:"buffer" runners must go through decodeChildOutput, not a lossy utf8 stringify
              ? decodeChildOutput(e.stderr).trim()
              : "";
    const detail = stderr || (typeof e.message === "string" && e.message.length > 0 ? e.message : `exit ${e.status ?? "?"}`);
    return new Error(`dsh ${args.join(" ")} failed: ${detail}`);
}

/** #1732: decode subprocess output bytes. Windows console output from
 *  cmd.exe/pnpm arrives in the system codepage (GBK/CP936 on Chinese
 *  Windows) — strict UTF-8 rejects those bytes, so fall back to GBK before
 *  accepting a lossy UTF-8 interpretation (the old `encoding: "utf8"` mode
 *  turned the classic "'dsh' 不是内部或外部命令" failure into mojibake in the
 *  log file). Pure ASCII and valid UTF-8 output decodes identically either way. */
// #1732: GBK bytes whose lead is 0xC2–0xDF with trail 0x80–0xBF are ALSO
// valid UTF-8, decoding "successfully" into Greek/Coptic/Cyrillic — strict
// UTF-8 alone cannot tell them apart (GBK 系统 → "ϵς"). cmd.exe/pnpm output
// never uses those scripts on purpose, so a run of them plus a GBK re-read
// that yields CJK means we misread GBK as UTF-8. (Real Greek text whose GBK
// re-read happens to produce CJK would flip this — vanishingly rare here.)
const UTF8_GBK_TRAP = /[\u0370-\u052F]{2}/;
const HAS_CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;

export function decodeChildOutput(buf: Buffer | string | null | undefined): string {
    if (buf == null) return "";
    const raw = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
    if (raw.length === 0) return "";
    try {
        const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        if (UTF8_GBK_TRAP.test(utf8)) {
            try {
                const gbk = new TextDecoder("gbk").decode(raw);
                if (HAS_CJK.test(gbk)) return gbk;
            } catch {
                /* not GBK either — keep the UTF-8 reading */
            }
        }
        return utf8;
    } catch {
        try {
            return new TextDecoder("gbk").decode(raw);
        } catch {
            return raw.toString("utf8");
        }
    }
}

// spawnSync (not execFileSync): its options accept windowsVerbatimArguments,
// which execFileSync's do not — and the #679 cmd.exe wrap needs it verbatim.
// No encoding option: capture raw buffers and decode via decodeChildOutput
// (#1732 — codepage-aware), so GBK stderr survives instead of mojibake.
function defaultSyncRun(plan: DshPlan): { stdout: string; stderr: string } {
    const res = spawnSync(plan.command, plan.args, {
        timeout: DSH_EXEC_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        windowsHide: true,
    });
    if (res.error) throw res.error;
    if (res.status !== 0 && res.status !== null) {
        const err = new Error(`exit ${res.status}`);
        Object.assign(err, { status: res.status, stderr: decodeChildOutput(res.stderr) });
        throw err;
    }
    return { stdout: decodeChildOutput(res.stdout), stderr: decodeChildOutput(res.stderr) };
}

const pExecFile = promisify(execFile);

async function defaultAsyncRun(plan: DshPlan): Promise<{ stdout: string; stderr: string }> {
    // encoding:"buffer" (#1732): execFile's default utf8 mode lossily
    // stringifies GBK bytes BEFORE decodeChildOutput ever sees them — the
    // "ϵς" mojibake observed on the async/auto-update refresh path. Capture
    // raw buffers (thrown errors carry Buffer stderr too) and decode centrally.
    const { stdout, stderr } = (await pExecFile(plan.command, plan.args, {
        timeout: DSH_EXEC_TIMEOUT_MS,
        encoding: "buffer",
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        windowsHide: true,
    })) as { stdout: Buffer | string; stderr: Buffer | string };
    return { stdout: decodeChildOutput(stdout), stderr: decodeChildOutput(stderr) };
}

/** Run `dsh <args…>` synchronously (CLI context — blocking is fine).
 *  Throws with actionable context when the dsh CLI is missing or exits
 *  non-zero (dsh forwards pnpm's stderr, e.g. "pnpm not found on PATH"). */
export function runDshPlugin(args: string[], env: NodeJS.ProcessEnv = process.env): void {
    const plan = planDshSpawn(resolveDshBinary(env), args);
    const run = testRunners?.sync ?? defaultSyncRun;
    try {
        run(plan);
    } catch (err) {
        throw formatDshError(err, args);
    }
}

/** Async variant for the auto-update path: must never block the proxy event
 *  loop (pnpm resolution can take seconds — a synchronous spawn here would
 *  freeze active SSE streams mid-update). */
export async function runDshPluginAsync(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const plan = planDshSpawn(resolveDshBinary(env), args);
    const run = testRunners?.async ?? defaultAsyncRun;
    try {
        await run(plan);
    } catch (err) {
        throw formatDshError(err, args);
    }
}

// — post-self-update lockstep refresh (#966 closes #953) ————————————————

/** After a global self-update, bring every registry-pinned profile copy of
 *  billion-context back to the new global version so the loaded plugin and
 *  the proxy never drift apart again (#953). Best-effort by contract: never
 *  throws — a failed refresh degrades to the pre-fix behavior (stale profile
 *  copy until the next manual update), never to a broken update loop.
 *  Profiles pinned to a local source (link:/file:/git specs) are left alone.
 *  Returns the number of profiles actually refreshed (#1803: copies already
 *  at the target version are skipped, so callers must not assume every
 *  dependent profile re-ran). The `desktop` profile is skipped entirely
 *  (#1575): the dsh CLI channel is closed for it upstream, and its copy
 *  updates itself in place instead (#1872). */
export async function refreshDshProfileBundles(
    targetVersion: string,
    log: (level: "info" | "warn", msg: string) => void,
    env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return 0; // dsh has never run on this machine — nothing to keep in step
    }
    const targets = dirs.filter((dir) => !isDshDesktopProfile(path.basename(dir)) && dshProfileDependsOnBili(dir));
    const desktopDir = dirs.find((dir) => isDshDesktopProfile(path.basename(dir)));
    if (desktopDir !== undefined && dshProfileDependsOnBili(desktopDir)) {
        log("info", `[update] dsh profile ${DSH_DESKTOP_PROFILE}: not driven through the dsh channel — the CLI refuses --profile ${DSH_DESKTOP_PROFILE} upstream; the copy updates itself in place via its own periodic self-update check (#1575)`);
    }
    if (targets.length === 0) return 0;
    let refreshed = 0;
    for (const dir of targets) {
        const name = path.basename(dir);
        const spec = dshProfileDepSpec(dir);
        if (spec !== undefined && !isRegistryDepSpec(spec)) {
            log("info", `[update] dsh profile ${name}: billion-context pinned to ${spec} (local source) — leaving it alone`);
            continue;
        }
        if (name === DSH_DESKTOP_PROFILE) {
            // #1575 owner decision: the CLI refuses --profile desktop by design, and the
            // in-app plugin manager cannot be relied on — bili owns that copy in place,
            // driven by update.ts refreshDshDesktopCopy alongside every call site of
            // this function. Spawning the CLI here would just log a guaranteed failure.
            continue;
        }
        if (installedProfileVersion(dir) === targetVersion) continue; // #1803: already in step
        try {
            await runDshPluginAsync(["plugin", "--profile", name, "add", `${DSH_PACKAGE}@${targetVersion}`], env);
            refreshed += 1;
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            log("warn", `[update] dsh profile ${name}: bundle refresh to ${targetVersion} failed: ${detail} — manual fix: run \`dsh plugin --profile ${name} add billion-context@${targetVersion}\` from a shell where \`dsh\` resolves (or point BILI_DSH_BIN at dsh's executable)`);
        }
    }
    if (refreshed > 0) {
        log("info", `[update] refreshed ${refreshed} dsh profile bundle(s) to ${targetVersion} — restart dsh to load it`);
    }
    return refreshed;
}
