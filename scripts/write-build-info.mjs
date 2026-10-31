#!/usr/bin/env node
// Stamps the build's git commit into dist/build-info.json so every shipped
// artifact (npm tarball, global install, dist copy) can report exactly which
// commit it was built from. Display-only: --version banner, /acp panel host
// line, web UI, /__bili/health and /__bili/overview. Never fails the build.
// ALSO writes dist/agent/dsh-gate/package.json (#4627) — that part DOES fail
// the build when the gate bundle is missing: without the manifest the nearest
// package.json walk from the gate bundle lands on billion-context itself and
// dsh >= 0.2 boot regresses silently in every published tarball.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 }).trim();
}

function buildCommit() {
    try {
        const commit = git(["rev-parse", "--short", "HEAD"]);
        if (!/^[0-9a-f]{7,12}$/.test(commit)) return "unknown";
        try {
            const dirty = git(["status", "--porcelain"]);
            return dirty ? `${commit}-dirty` : commit;
        } catch {
            return commit; // status failed (shallow/perm edge): commit alone is still precise
        }
    } catch {
        return "unknown"; // no git / not a checkout (release tarball builds run inside a checkout, so this is the true fallback)
    }
}

const info = { commit: buildCommit() };
const distDir = resolve(root, "dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(resolve(distDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: commit=${info.commit}`);

// #4627: the compaction gate ships under its OWN package identity so dsh's
// ClientModuleRegistry.reconcilePackage (>= 0.2.0-rc.x) sees one client
// package per active Loader source. No dsh.client declaration on purpose —
// it is a loader target, not a client platform.
const gateDir = resolve(distDir, "agent", "dsh-gate");
if (!existsSync(resolve(gateDir, "index.js"))) {
    throw new Error("dist/agent/dsh-gate/index.js missing — tsup did not emit the gate bundle; refusing to ship a tarball that re-triggers #4627");
}
const biliVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
writeFileSync(
    resolve(gateDir, "package.json"),
    `${JSON.stringify({
        name: "billion-context-dsh-gate",
        version: biliVersion,
        description: "dsh compaction gate for billion-context — standalone package identity on purpose (#4627); declares no dsh.client",
        type: "module",
        main: "./index.js",
        exports: { ".": "./index.js", "./package.json": "./package.json" },
    }, null, 2)}\n`,
);
console.log(`gate manifest: billion-context-dsh-gate@${biliVersion}`);
