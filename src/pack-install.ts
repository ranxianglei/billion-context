// `bili pack install|remove <…> | list`: manage compress prompt packs on
// disk without opening an editor (#5319 item ④ — standard pack format +
// npm-distributable packs).
//
// Convention for npm packages: one file `bili-pack.json` in the package
// root, holding the SAME object shape as a hand-written
// `<configDir>/packs/<name>.json`. Installation shells out to the LOCAL
// `npm` (`npm install --prefix <tmp> <spec>`), so registry auth, version
// ranges, scoped names, git URLs and `.tgz` paths all behave exactly like
// a normal npm install; we only read one file out of the result. No tar
// parsing, no new dependency.
//
// Writes follow the repo rules: names re-validated with the kernel's
// isValidPackName, surfaces sanitized exactly like dir-pack loading
// (sanitizePackSurface), an empty-after-sanitize pack is refused, and an
// existing target file is never overwritten without --force (no silent
// overwrite of user config). Writes go through the temp-file+rename
// pattern shared with every other writer here.

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isValidPackName, sanitizePackSurface, type PromptPackFile } from "acp-kernel";
import { configDir } from "./paths.js";
import { packSurfaceHasContent } from "./web/api.js";

/** The file an npm package must ship to be installable as a pack. */
export const PACK_ENTRY_FILE = "bili-pack.json";

const NPM_TIMEOUT_MS = 120_000;

interface PackInstallOptions {
    /** Target `./.billion-context/packs/` instead of the user-dir default. */
    project?: boolean;
    /** Replace an existing pack file (refused otherwise). */
    force?: boolean;
}

/** Directory a pack lands in, by target. */
export function packDirFor(project: boolean): string {
    return project ? path.join(process.cwd(), ".billion-context", "packs") : path.join(configDir(), "packs");
}

interface InstalledPack {
    /** Resolved pack name (entry's `name`, falling back to the npm package name). */
    name: string;
    version?: string;
    file: string;
}

function atomicWriteFile(file: string, content: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tempPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = openSync(tempPath, "wx", 0o644);
        writeFileSync(descriptor, content, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(tempPath, file);
    } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        try { unlinkSync(tempPath); } catch { }
        throw error;
    }
}

/** Find the package directory npm just installed under prefix/node_modules. */
function findInstalledPkg(prefix: string): { dir: string; manifest: Record<string, unknown> } | undefined {
    const nmRoot = path.join(prefix, "node_modules");
    if (!existsSync(nmRoot)) return undefined;
    const candidates: string[] = [];
    const push = (dir: string) => candidates.push(dir);
    for (const entry of readdirSync(nmRoot)) {
        if (entry.startsWith(".")) continue;
        const full = path.join(nmRoot, entry);
        if (!statSync(full).isDirectory()) continue;
        if (entry.startsWith("@")) {
            for (const sub of readdirSync(full)) {
                push(path.join(full, sub));
            }
        } else {
            push(full);
        }
    }
    let best: { dir: string; mtimeMs: number; manifest: Record<string, unknown> } | undefined;
    for (const dir of candidates) {
        const manifestPath = path.join(dir, "package.json");
        if (!existsSync(manifestPath)) continue;
        let manifest: Record<string, unknown>;
        try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>; } catch { continue; }
        const mtimeMs = statSync(dir).mtimeMs;
        if (!best || mtimeMs > best.mtimeMs) best = { dir, mtimeMs, manifest };
    }
    return best ? { dir: best.dir, manifest: best.manifest } : undefined;
}

export function installPackFromNpm(spec: string, options: PackInstallOptions = {}): InstalledPack {
    const trimmed = spec.trim();
    if (!trimmed) throw new Error("spec is required (an npm package name, name@version, git URL, or .tgz path)");
    const destDir = packDirFor(options.project ?? false);

    const tmp = mkdtempSync(path.join(os.tmpdir(), "bili-pack-"));
    try {
        let stderr = "";
        try {
            execFileSync("npm", [
                "install", "--prefix", tmp, "--no-save", "--no-audit", "--no-fund", trimmed,
            ], { timeout: NPM_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
            const err = error as { stderr?: unknown; message?: string };
            stderr = typeof err.stderr === "string" ? err.stderr : "";
            if (/ENOENT/.test(String(err.message))) throw new Error("npm was not found on PATH");
            const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
            throw new Error(`npm install ${trimmed} failed${tail ? `: ${tail}` : ""}`);
        }

        const installed = findInstalledPkg(tmp);
        if (!installed) throw new Error(`npm reported success but no package appeared in the sandbox — cannot locate its ${PACK_ENTRY_FILE}`);
        const pkgName = typeof installed.manifest.name === "string" ? installed.manifest.name : path.basename(installed.dir);

        const entryPath = path.join(installed.dir, PACK_ENTRY_FILE);
        if (!existsSync(entryPath)) {
            throw new Error(`${trimmed} is not a billion-context pack: it has no \`${PACK_ENTRY_FILE}\` in the package root (that file holds the pack JSON — see CONFIGURATION.md “Pack file format”)`);
        }
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(entryPath, "utf8")); }
        catch (error) { throw new Error(`${PACK_ENTRY_FILE} in ${trimmed} is not valid JSON: ${String(error)}`); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`${PACK_ENTRY_FILE} top level must be a JSON object`);
        }
        const packJson = parsed as PromptPackFile & Record<string, unknown>;
        if (!packSurfaceHasContent(sanitizePackSurface(packJson))) {
            throw new Error(`${PACK_ENTRY_FILE} has no recognized pack fields (promptSections / prompts / nudgeSections / toolPrompts / adapters)`);
        }
        const name = typeof packJson.name === "string" && packJson.name ? packJson.name : pkgName;
        if (!isValidPackName(name)) {
            throw new Error(`pack name "${name}" is invalid — letters/digits/._- only, must not start with one, and no ".." (set "name" in ${PACK_ENTRY_FILE})`);
        }
        const file = path.join(destDir, `${name}.json`);
        if (!options.force && existsSync(file)) {
            throw new Error(`a pack named "${name}" already exists at ${file} — pass --force to replace it`);
        }
        atomicWriteFile(file, JSON.stringify(packJson, null, 2) + "\n");
        return { name, version: typeof packJson.version === "string" ? packJson.version : undefined, file };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/** Delete a pack file by name (user dir by default, project dir with `project`). */
export function removePackFile(name: string, project: boolean = false): string {
    if (!isValidPackName(name)) throw new Error(`invalid pack name: ${name}`);
    const file = path.join(packDirFor(project), `${name}.json`);
    if (!existsSync(file)) throw new Error(`no pack named "${name}" in ${path.dirname(file)} (check the other location too)`);
    unlinkSync(file);
    return file;
}
