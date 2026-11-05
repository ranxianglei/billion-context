#!/usr/bin/env node
// #4360 lever 1: content-hash cache for the pretest dist builds.
//
// Every CI test leg used to fully rebuild kernel/ and pi-subagents/ dist
// (~5-6.5 min on Windows each leg) inside `npm run pretest` before a single
// test ran — yet those dists are a PURE FUNCTION of the source tree, the
// build config (tsup/tsc), the manifests that carry the build script chains
// (+ CURRENT_VERSION, inlined by pi-subagents' tsup), and the lockfiles that
// pin the toolchain (tsup/esbuild/typescript). This script makes that
// function explicit: after a REAL build it stamps each dist with a marker
// holding the sha256 of its inputs; on later runs the marker is verified
// BYTE-EXACTLY against the live source hash and the rebuild is skipped only
// on a match.
//
// Correctness rule (#4360): NEVER trust the cache. The marker is the only
// freshness oracle and it gates on the LIVE tree, not on what a cache
// restore happened to bring in — so a dirty or stale restore at worst wastes
// ONE rebuild (marker mismatch → real rebuild), it can never run wrong
// artifacts. Symmetrically, an absent marker (fresh checkout, dist wiped,
// build interrupted mid-way) is a MISS, never a guess. Exits non-zero only
// on a real failure: a build command that failed, or an input tree so broken
// the hash itself cannot be computed (which means the build would fail too).
//
// The workflow side (actions/cache keyed on hashFiles over the SAME inputs,
// per runner.os) only accelerates the MISS path across legs; the marker
// check stands on its own, so local `npm test` warm runs benefit too. One
// side effect it must undo: a restore hands the dist back with SAVE-TIME
// mtimes, older than the just-checked-out sources. tests/golden-storage-drive.ts'
// #3325 staleness guard is a pure MTIME oracle (newest kernel/src vs
// node_modules/acp-kernel/dist/index.js), so the HIT path restamps the
// verified dist tree's mtimes to now — content untouched, the two oracles
// agree again (#4599 sentinel: without this, every cache-hit leg reds the
// storage-render golden chat wire ~4ms into the drive).
//
// Parity note: pretest previously ran `npm --prefix kernel run build && npm
// --prefix pi-subagents run build`; this script runs exactly those commands
// on a miss (same resolution, same clean semantics — kernel's build wipes
// dist, so the marker is written only after a fully successful build).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Marker file written inside each dist; gitignored together with dist/. */
export const MARKER_NAME = ".pretest-cache-marker";

/** Seed: bump when the hash recipe itself changes so old markers invalidate. */
const HASH_SEED_PREFIX = "bili-pretest-cache-v1";

/**
 * Shared inputs hashed relative to the repo root for BOTH components: the
 * root lockfile pins the toolchain versions (tsup/esbuild/typescript) that
 * the `file:` devDependencies resolve through, so a toolchain bump
 * invalidates both caches even though no component source changed.
 */
const ROOT_INPUTS = ["package-lock.json"];

/**
 * The two pretest components and the exact input set that determines their
 * dist bytes. `inputs` are relative to the component dir; each entry is a
 * file (hashed by content) or a directory (walked recursively, hashed by
 * relative path + content). Keep this table in sync with the hashFiles()
 * patterns in .github/workflows/ci.yml — the workflow README-comment there
 * points back here.
 */
export const COMPONENTS = [
    {
        name: "kernel",
        dir: "kernel",
        inputs: ["src", "tsup.config.ts", "tsconfig.json", "package.json", "package-lock.json"],
    },
    {
        name: "pi-subagents",
        dir: "pi-subagents",
        // package.json is a BUILD INPUT here, not just metadata: tsup.config.ts
        // inlines CURRENT_VERSION from it into the bundle.
        inputs: ["src", "tsup.config.ts", "tsconfig.json", "package.json"],
    },
];

/** Never hashed inside a walk — build outputs and deps are not inputs. */
const SKIP_NAMES = new Set(["node_modules", "dist", "tmp", ".tmp", ".git"]);

function hashFile(h, abs, rel) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(abs));
    h.update("\0");
}

function hashDir(h, absDir, relDir) {
    const entries = readdirSync(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
        if (SKIP_NAMES.has(e.name)) continue;
        const rel = `${relDir}/${e.name}`;
        if (e.isDirectory()) hashDir(h, join(absDir, e.name), rel);
        else if (e.isFile()) hashFile(h, join(absDir, e.name), rel);
        // symlinks/other node types are skipped — deterministic and inert
    }
}

/**
 * The content hash for one component: sha256 over the platform plus every
 * input's normalized relative path and bytes. Platform rides the hash
 * because a cache restore crossing OSes (possible with a future key typo)
 * must never satisfy the marker check — same never-trust rule as everything
 * else here. Pure: no writes, no builds.
 */
export function hashComponent(root, comp, platform = process.platform) {
    const h = createHash("sha256");
    h.update(`${HASH_SEED_PREFIX} platform=${platform}\0`);
    const rels = [...ROOT_INPUTS, ...comp.inputs.map((i) => `${comp.dir}/${i}`)].sort();
    for (const rel of rels) {
        const abs = join(root, rel);
        if (!existsSync(abs)) {
            throw new Error(`input "${rel}" not found under ${root} — cannot establish dist freshness`);
        }
        if (statSync(abs).isDirectory()) hashDir(h, abs, rel);
        else hashFile(h, abs, rel);
    }
    return h.digest("hex");
}

/** Marker freshness: byte-exact hash comparison. Absent/corrupt marker = MISS. */
export function markerIsFresh(distDir, hash) {
    try {
        return readFileSync(join(distDir, MARKER_NAME), "utf-8").trim() === hash;
    } catch {
        return false;
    }
}

/**
 * Mtime reconciliation after a VERIFIED hit (#4360×#3325): the marker proved
 * the bytes are current, but a cache restore left save-time mtimes behind
 * the checked-out sources. Restamp every file's mtime to now so any
 * mtime-based freshness oracle over the dist agrees with the content oracle.
 * Content is never touched.
 */
function restampMtimes(distDir) {
    const now = new Date();
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) utimesSync(p, now, now);
        }
    };
    walk(distDir);
}

/**
 * The pretest loop. For each component: hash → fresh marker? HIT, skip :
 * MISS → run the real build → stamp the marker. `build`/`log` are test seams
 * (the CLI passes defaults); build failures propagate so the CLI exits 1 —
 * non-zero exit means a REAL build failure, never a cache decision.
 */
export function runPretestCache(opts = {}) {
    const root = opts.root ?? ROOT;
    const components = opts.components ?? COMPONENTS;
    const log = opts.log ?? ((line) => console.log(line));
    const build = opts.build ?? defaultBuild;
    const results = [];
    for (const comp of components) {
        const hash = hashComponent(root, comp);
        const distDir = join(root, comp.dir, "dist");
        if (markerIsFresh(distDir, hash)) {
            restampMtimes(distDir);
            log(`pretest-cache: HIT (${comp.name}) — dist fresh for hash ${hash.slice(0, 12)}`);
            results.push({ name: comp.name, hit: true, ms: 0 });
            continue;
        }
        log(`pretest-cache: MISS (${comp.name}) → rebuilding`);
        const t0 = Date.now();
        build(comp, root);
        mkdirSync(distDir, { recursive: true });
        writeFileSync(join(distDir, MARKER_NAME), `${hash}\n`);
        const ms = Date.now() - t0;
        log(`pretest-cache: built (${comp.name}) in ${(ms / 1000).toFixed(1)}s — marker stamped (${hash.slice(0, 12)})`);
        results.push({ name: comp.name, hit: false, ms });
    }
    return results;
}

function defaultBuild(comp, root) {
    // Same invocation pretest used verbatim (`npm --prefix <dir> run build`).
    // On Windows npm is a .cmd batch file CreateProcess cannot exec directly
    // (EINVAL) — same shell:true dance as scripts/run-ci-tests.mjs; args are
    // fixed literals, so there is no quoting surface.
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npmCmd, ["--prefix", comp.dir, "run", "build"], {
        cwd: root,
        stdio: "inherit",
        shell: process.platform === "win32",
    });
}

function main() {
    try {
        runPretestCache();
        return 0;
    } catch (e) {
        console.error(`pretest-cache: FAILED — ${e?.message ?? e}`);
        return 1;
    }
}

// Run only when invoked directly (not when imported by the regression test).
const INVOKED_DIRECTLY = (() => {
    if (!process.argv[1]) return false;
    try {
        return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
})();
if (INVOKED_DIRECTLY) {
    process.exit(main());
}
