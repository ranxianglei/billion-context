// Cross-platform helpers for the hermetic e2e suites (registry, advisory
// rollback, release canary). Windows compatibility notes learned on a real
// win10 VM (#1872 follow-up audit):
//  - `execFile("npm")` / `spawnSync("npm")` cannot spawn npm.cmd without a
//    shell (ENOENT) — run npm as `node <npm-cli.js>` resolved next to the
//    running node so no shell is involved and argv stays literal.
//  - A fully stripped env breaks node children on Windows (SystemRoot is
//    required); npm additionally keys its userconfig off USERPROFILE, not
//    HOME. Mirror the isolated HOME onto the Windows profile vars.
//  - Fake client bins: plain `#!/bin/sh` scripts cannot execute on Windows —
//    emit a .cmd shim instead (the product's client probe already routes
//    .cmd/.bat through the shell with quoting, see detectOpencodeMajor).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const IS_WIN = process.platform === "win32";

/** npm's cli.js next to the running node — the standard layout on every
 *  platform and CI runner (nodejs dir / hostedtoolcache / nvm symlinks). */
export function npmCliPath(): string | undefined {
    const exeDir = path.dirname(process.execPath);
    const candidates = IS_WIN
        ? [path.join(exeDir, "node_modules", "npm", "bin", "npm-cli.js")]
        : [
              path.join(exeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
              path.join(exeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
          ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return undefined;
}

/** System vars node/npm need even in an isolated env on Windows. */
export function windowsSystemEnv(): Record<string, string> {
    if (!IS_WIN) return {};
    const keep: Record<string, string> = {};
    for (const key of ["SystemRoot", "SystemDrive", "ComSpec", "TEMP", "TMP", "PATHEXT", "ProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
        const v = process.env[key];
        if (v) keep[key] = v;
    }
    return keep;
}

/** Env pointing HOME (and its Windows mirrors) at an isolated `homeDir`. */
export function npmHomeEnv(homeDir: string): Record<string, string> {
    if (!IS_WIN) return { HOME: homeDir };
    return {
        HOME: homeDir,
        USERPROFILE: homeDir,
        APPDATA: path.join(homeDir, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
    };
}

/** Isolated HOME/XDG_* (+ Windows mirrors) under `work`, same shape the
 *  suites used to build inline (POSIX-only before this helper). */
export function isolatedEnv(work: string): Record<string, string> {
    const env: Record<string, string> = {};
    const pairs: Array<[string, string]> = [
        ["HOME", "home"],
        ["XDG_CONFIG_HOME", "config"],
        ["XDG_CACHE_HOME", "cache"],
        ["XDG_STATE_HOME", "state"],
        ["XDG_DATA_HOME", "data"],
    ];
    if (IS_WIN) {
        pairs.push(
            ["USERPROFILE", "home"],
            ["APPDATA", path.join("home", "AppData", "Roaming")],
            ["LOCALAPPDATA", path.join("home", "AppData", "Local")],
        );
    }
    for (const [key, dir] of pairs) {
        const p = path.join(work, dir);
        fs.mkdirSync(p, { recursive: true });
        env[key] = p;
    }
    return env;
}

/** Env for spawning the bili CLI: PATH + isolation + required system vars. */
export function biliSpawnEnv(iso: Record<string, string>): Record<string, string> {
    return { PATH: process.env.PATH ?? "", ...iso, ...windowsSystemEnv() };
}

/** Run npm synchronously without a shell: `node npm-cli.js args...`. Only
 *  falls back to the npm shim through a shell when cli.js cannot be located. */
export function npmRunSync(args: string[], opts: { cwd: string; env: Record<string, string> }): string {
    const env: Record<string, string> = { ...opts.env, ...windowsSystemEnv() };
    if (opts.env.NPM_ALLOW_DANGEROUS) env.NPM_ALLOW_DANGEROUS = opts.env.NPM_ALLOW_DANGEROUS;
    const cli = npmCliPath();
    if (cli) {
        return execFileSync(process.execPath, [cli, ...args], { cwd: opts.cwd, encoding: "utf8", timeout: 180_000, env, windowsHide: true });
    }
    const line = ["npm", ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ");
    return execFileSync(line, { cwd: opts.cwd, encoding: "utf8", timeout: 180_000, shell: true, env, windowsHide: true });
}

/** Cross-platform fake client bin that prints `version` for `<bin>
 *  --version` probes (detectOpencodeMajor & friends). Returns a path the
 *  product can spawn as-is: shebang script on POSIX, .cmd shim on Windows. */
export function fakeVersionBin(work: string, name: string, version: string): string {
    const dir = path.join(work, "bin");
    fs.mkdirSync(dir, { recursive: true });
    if (!IS_WIN) {
        const shim = path.join(dir, name);
        fs.writeFileSync(shim, `#!/bin/sh\necho ${version}\n`);
        fs.chmodSync(shim, 0o755);
        return shim;
    }
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, `@echo ${version}\r\n`);
    return cmd;
}
