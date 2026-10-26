#!/usr/bin/env node
// Stamps the build's git commit into dist/build-info.json so every shipped
// artifact (npm tarball, global install, dist copy) can report exactly which
// commit it was built from. Display-only: --version banner, /acp panel host
// line, web UI, /__bili/health and /__bili/overview. Never fails the build.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
