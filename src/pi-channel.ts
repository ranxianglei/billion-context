// #1196-class fix for the pi lane: `bili plugin install pi` declares the
// npm:billion-context entry in ~/.pi/agent/settings.json and pi materializes
// the copy under <piHome>/npm/node_modules itself — the copy is host-managed
// (#991 single-writer), so the global self-updater refuses to touch it and
// pi itself has no background updater (`pi update` only upgrades pi; packages
// need an explicit `pi update --all` / `pi update --extension npm:<spec>`).
// Left alone, the copy froze at its install version forever.
//
// Mirroring the dsh channel: the proxy running FROM the pi copy drives pi's
// OWN update channel (`pi update --extension npm:billion-context`) on its
// periodic check when the registry has a newer version. Verified semantics
// (pi 0.83.8): the unpinned `npm:billion-context` spec tracks latest; an
// explicitly pinned `npm:billion-context@x.y.z` entry is honored by pi and
// is deliberately left alone here too.
//
// Kept dependency-light (node builtins + client-config + the generic spawn
// plan from dsh-channel) so update.ts can import it without pulling in the
// rest of the installer graph.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvePiHome } from "./client-config.js";
import { planDshSpawn, decodeChildOutput } from "./dsh-channel.js";

const PI_PACKAGE = "billion-context";

/** The unpinned spec form `bili plugin install pi` writes (plugin-install's
 *  PI_NPM_ENTRY). Only this form self-refreshes — a pinned variant is user
 *  intent and stays put. */
export const PI_NPM_SPEC = "npm:billion-context";

const PI_EXEC_TIMEOUT_MS = 5 * 60 * 1000; // cold npm install + slow network

export interface PiPlan {
    command: string;
    args: string[];
    windowsVerbatimArguments?: boolean;
}

type PiRunner = (plan: PiPlan) => { stdout: string; stderr: string } | Promise<{ stdout: string; stderr: string }>;

/** Test seam — mirrors dsh-channel's _setDshRunnersForTest. */
let testRunners: { async?: PiRunner } | undefined;
export function _setPiRunnersForTest(runners: { async?: PiRunner } | undefined): void {
    testRunners = runners;
}

/** Resolve the pi executable: BILI_PI_BIN override, then PATH plus the usual
 *  install roots (node dir, /usr/local/bin, homebrew, ~/.local/bin — pi's
 *  documented npm -g home). Mirrors resolveDshBinary. */
export function resolvePiBinary(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    existsImpl: (p: string) => boolean = fs.existsSync,
    execPath: string = process.execPath,
): string {
    const override = env.BILI_PI_BIN?.trim();
    if (override && override.length > 0) return override;
    // Probe both binary names: `pi` is the canonical UX name (what users and
    // distros link), but a stock `npm install -g pi-stable` only lays down
    // `pi-stable`(.cmd) — the npm package's declared bin name. Probing just
    // `pi` misses every stock npm install.
    const probeNames = ["pi", "pi-stable"];
    const sep = platform === "win32" ? ";" : ":";
    const extensions = platform === "win32"
        ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0)
        : [""];
    const nodeDir = path.dirname(execPath);
    const home = platform === "win32" ? env.USERPROFILE ?? "" : env.HOME ?? "";
    const extraDirs = platform === "win32"
        ? [nodeDir, env.APPDATA ? env.APPDATA + "/npm" : ""]
        : [nodeDir, "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", home ? home + "/.local/bin" : ""];
    for (const dir of [...(env.PATH ?? "").split(sep), ...extraDirs]) {
        if (!dir) continue;
        for (const name of probeNames) {
            for (const ext of extensions) {
                const fileName = ext === "" ? name : `${name}${ext}`;
                const candidate = dir.endsWith("/") || dir.endsWith("\\") ? dir + fileName : dir + "/" + fileName;
                if (existsImpl(candidate)) return candidate;
            }
        }
    }
    return "pi";
}

function formatPiError(err: unknown, args: readonly string[]): Error {
    const e = err as { code?: string | number; status?: number; stderr?: string | Buffer; message?: string };
    if (e.code === "ENOENT") {
        return new Error("pi CLI not found (not on PATH, not in the known install locations probed) — set BILI_PI_BIN to its executable path, then retry");
    }
    const stderr =
        typeof e.stderr === "string"
            ? e.stderr.trim()
            : e.stderr instanceof Buffer
              ? decodeChildOutput(e.stderr).trim()
              : "";
    const detail = stderr || (typeof e.message === "string" && e.message.length > 0 ? e.message : `exit ${e.status ?? "?"}`);
    return new Error(`pi ${args.join(" ")} failed: ${detail}`);
}

const pExecFile = promisify(execFile);

async function defaultAsyncRun(plan: PiPlan): Promise<{ stdout: string; stderr: string }> {
    // encoding:"buffer" (#1732 discipline): decode centrally, never lossily.
    const { stdout, stderr } = (await pExecFile(plan.command, plan.args, {
        timeout: PI_EXEC_TIMEOUT_MS,
        encoding: "buffer",
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        windowsHide: true,
    })) as { stdout: Buffer | string; stderr: Buffer | string };
    return { stdout: decodeChildOutput(stdout), stderr: decodeChildOutput(stderr) };
}

/** Run `pi <args…>` asynchronously (auto-update path — must never block the
 *  proxy event loop). planDshSpawn is the generic cmd.exe shim planner
 *  shared from dsh-channel (npm .cmd shims need the same wrap). */
export async function runPiAsync(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const plan = planDshSpawn(resolvePiBinary(env), args, env) as PiPlan;
    const run = testRunners?.async ?? defaultAsyncRun;
    try {
        await run(plan);
    } catch (err) {
        throw formatPiError(err, args);
    }
}

/** On-disk root of the pi-managed npm copy of billion-context — exactly where
 *  pi materializes the settings entry. resolvePiHome() ALREADY includes the
 *  host's agent segment (~/.pi/agent by default, or PI_CODING_AGENT_DIR /
 *  PI_HOME), so callers must never append another "agent" (#2850). Single
 *  source of truth shared by isPiNpmCopy() and the doctor/plugin-list lane
 *  presence probe. */
export function piNpmCopyRoot(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(resolvePiHome(env), "npm", "node_modules", PI_PACKAGE);
}

/** True when `installDir` is the pi-managed npm copy of billion-context
 *  (<piHome>/npm/node_modules/billion-context, as pi materializes the
 *  settings entry), literal or after symlink resolution. Such a copy has no
 *  global bili driving its refresh — the proxy running FROM it is the only
 *  candidate to drive pi's own channel. */
export function isPiNpmCopy(installDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const root = piNpmCopyRoot(env);
    let real = installDir;
    try {
        real = fs.realpathSync(installDir);
    } catch {
        // nonexistent or unreadable — evaluate the literal path
    }
    let realRoot = root;
    try {
        realRoot = fs.realpathSync(root);
    } catch {
        // pi never installed the copy — literal comparison still works for
        // the dir pi itself created (plain dirs, no symlink tricks)
    }
    for (const dir of [installDir, real]) {
        if (dir === root || dir === realRoot || dir.startsWith(realRoot + path.sep)) return true;
    }
    return false;
}

/** The declared packages entry for billion-context in <piHome>/settings.json
 *  (exact string, e.g. "npm:billion-context" or a pinned
 *  "npm:billion-context@0.1.150"), or undefined when settings.json carries
 *  no such entry. Refresh only acts on the unpinned form — pins are user
 *  intent (and pi's own updater honors them too). */
export function piNpmEntrySpec(env: NodeJS.ProcessEnv = process.env): string | undefined {
    let parsed: { packages?: unknown };
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(resolvePiHome(env), "settings.json"), "utf-8")) as { packages?: unknown };
    } catch {
        return undefined;
    }
    if (!Array.isArray(parsed.packages)) return undefined;
    const re = new RegExp(`^npm:${PI_PACKAGE}(@.*)?$`);
    return parsed.packages.find((p): p is string => typeof p === "string" && re.test(p));
}
