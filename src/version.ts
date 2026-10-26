import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

// The proxy's own identity, read from package.json at runtime — works in both
// dev (tsx: src/version.ts → ../package.json) and bundled (tsup: dist/*.js →
// ../package.json). Single source for the CLI banner, the /acp panel header,
// and the acp_status surface-meta host line.
function readPkgField(field: string, fallback: string): string {
    const here = fileURLToPath(import.meta.url);
    // Flat dist entries sit at dist/<entry>.js (one level up = package root);
    // subdirectory bundles (dist/agent/*.js) need one more level — the flat
    // assumption made every subdirectory entry report VERSION="dev".
    for (const rel of ["..", "../.."]) {
        try {
            return (JSON.parse(readFileSync(path.join(path.dirname(here), rel, "package.json"), "utf8"))[field] as string) ?? fallback;
        } catch {
            // try the next candidate, then the fallback
        }
    }
    return fallback;
}

export const VERSION = readPkgField("version", "dev");
export const PACKAGE_NAME = readPkgField("name", "billion-context");

// Which git commit this running code was built from. Display-only (never used
// for update decisions — the updater compares package.json semver).
// Resolution order:
//   1. bundled (dist/*.js): dist/build-info.json, stamped by
//      scripts/write-build-info.mjs at build time and shipped in the tarball —
//      identifies the BUILD, which is exactly what "which code is running"
//      means for a published/global install;
//   2. dev (src/version.ts under tsx): ask git directly — identifies the
//      CHECKOUT, which is what a dev session wants;
//   3. "unknown" when neither exists.
/** #2441: exec options for the git build-commit fallback below (dev checkouts
 *  / dist without build-info.json). A host that owns no console (dsh desktop /
 *  Electron) makes Windows allocate a NEW console window for any unhidden
 *  console child — same failure domain as #2439/#2440. windowsHide is a
 *  documented no-op off Windows. #2834: explicit stdio — an npm install lives
 *  outside any git checkout, so the probe fails there by design; without an
 *  explicit stdio Node forwards the failed child's locale-localized "fatal:"
 *  stderr onto the host terminal at every module load. stdout stays piped
 *  (it carries the commit hash), stderr is ignored (the catch already degrades
 *  to "unknown" — the message adds nothing). Exported pure so tests can pin it
 *  without touching git. */
export function gitFallbackExecOptions(): { encoding: BufferEncoding; timeout: number; windowsHide: boolean; stdio: ["ignore", "pipe", "ignore"] } {
    return { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] };
}

let cachedCommit: string | undefined;
function resolveBuildCommit(): string {
    if (cachedCommit !== undefined) return cachedCommit;
    const here = fileURLToPath(import.meta.url);
    const fromSrc = path.basename(path.dirname(here)) === "src";
    if (!fromSrc) {
        // The stamp lives at dist/build-info.json; subdirectory bundles
        // (dist/agent/*.js) sit one level below it — check both levels.
        for (const dir of [path.dirname(here), path.dirname(path.dirname(here))]) {
            try {
                const commit = (JSON.parse(readFileSync(path.join(dir, "build-info.json"), "utf8")) as { commit?: unknown }).commit;
                if (typeof commit === "string" && commit) return (cachedCommit = commit);
            } catch {
                // next candidate, then fall through to git, then unknown
            }
        }
    }
    try {
        const root = path.dirname(path.dirname(here));
        const run = (args: string[]): string =>
            execFileSync("git", args, { ...gitFallbackExecOptions(), cwd: root }).trim();
        const commit = run(["rev-parse", "--short", "HEAD"]);
        if (/^[0-9a-f]{7,12}$/.test(commit)) {
            try {
                const dirty = run(["status", "--porcelain"]);
                return (cachedCommit = dirty ? `${commit}-dirty` : commit);
            } catch {
                return (cachedCommit = commit);
            }
        }
    } catch {
        // no git / not a checkout
    }
    return (cachedCommit = "unknown");
}

export const BUILD_COMMIT = resolveBuildCommit();

/** "0.1.187 (8f9faf9e)" — the human-facing form for banners and panels. */
export function versionWithCommit(): string {
    return `${VERSION} (${BUILD_COMMIT})`;
}
