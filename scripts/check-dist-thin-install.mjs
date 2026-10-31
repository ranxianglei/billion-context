// Thin-install smoke (#3617-C, generalizes the #3511 zod class): pack the
// current tree, install ONLY the tarball into a scratch dir with no repo
// node_modules, then prove the artifact actually runs:
//   1. `node dist/index.js --version` exits 0 (the CLI entry loads);
//   2. every Node-consumed dist/agent/*.js entry IMPORTS in its own process
//      without throwing — an undeclared runtime dependency fails here at
//      import time, exactly where it would fail in a real consumer's process
//      (the static gate scripts/check-dist-external.mjs pins the allowlist;
//      this smoke proves the installed artifact actually RUNS end to end).
// Run after `npm run build` in CI (static-gates). Deliberately NOT part of
// the local build chain or the prepare gate: it needs registry access for
// the package's declared deps and must never slow a consumer install.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// NOTE: spawning npm.cmd on Windows requires shell:true (Node >= 18.20/22
// hardening, CVE-2024-27980) — EINVAL otherwise. Same pattern as
// scripts/run-ci-tests.mjs:141.
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function fail(msg) {
    console.error(`dist-thin-install: FAIL — ${msg}`);
    process.exit(1);
}

if (!existsSync(path.join(root, "dist", "index.js"))) {
    fail("dist/index.js missing — run `npm run build` first");
}
const repoVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

const scratch = mkdtempSync(path.join(os.tmpdir(), "bili-thin-install-"));
try {
    // 1. Pack + install the tarball alone (declared deps come from the
    // registry; nothing from this checkout).
    execFileSync(npmCmd, ["pack", "--pack-destination", scratch, "--loglevel=error"], { cwd: root, stdio: "pipe", shell: process.platform === "win32" });
    const tarball = readdirSync(scratch).find((f) => f.startsWith("billion-context-") && f.endsWith(".tgz"));
    if (!tarball) fail("npm pack produced no tarball");
    const installDir = path.join(scratch, "install");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "bili-thin-smoke", version: "0.0.0", private: true }, null, 2));
    execFileSync(npmCmd, ["install", path.join(scratch, tarball), "--no-audit", "--no-fund", "--loglevel=error"], { cwd: installDir, stdio: "pipe", shell: process.platform === "win32" });
    const pkgDir = path.join(installDir, "node_modules", "billion-context");
    if (!existsSync(path.join(pkgDir, "dist", "index.js"))) fail("installed tarball has no dist/index.js");
    const installedVersion = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
    if (installedVersion !== repoVersion) fail(`installed version ${installedVersion} != repo version ${repoVersion}`);

    // 2. CLI entry runs and reports its version.
    const cli = spawnSync(process.execPath, [path.join(pkgDir, "dist", "index.js"), "--version"], { encoding: "utf8" });
    if (cli.status !== 0 || !/\d+\.\d+\.\d+/.test(cli.stdout ?? "")) {
        fail(`dist/index.js --version exited ${cli.status}: ${(cli.stderr ?? "").slice(0, 400)}`);
    }

    // 3. Every agent entry imports standalone (own process each: a real host
    // loads exactly one bundle, so cross-bundle interference is not a signal).
    const agentDir = path.join(pkgDir, "dist", "agent");
    const entries = readdirSync(agentDir).filter((f) => f.endsWith(".js") && !f.endsWith(".map")).sort();
    if (entries.length === 0) fail("no dist/agent/*.js entries found in the tarball");
    // #4627: the compaction gate moved into its own nested package identity
    // (dist/agent/dsh-gate/) — import it here too, or a broken gate bundle
    // ships untested. Its absence in a post-fix tarball IS a build regression,
    // so fail loudly rather than skip.
    if (!existsSync(path.join(agentDir, "dsh-gate", "index.js"))) fail("dist/agent/dsh-gate/index.js missing from the tarball (#4627)");
    entries.push("dsh-gate/index.js");
    const imported = [];
    const parsed = [];
    for (const name of entries) {
        const file = path.join(agentDir, name);
        if (name === "dsh-native-client.js") {
            // Browser bundle by design (tsup platform:"browser", cjs,
            // window.__ModuleLoader__ format, react external): it cannot be
            // imported in Node. Parse-check it instead — a broken build still
            // fails here, and it has no Node-visible externals to miss.
            const chk = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
            if (chk.status !== 0) fail(`parse check failed for ${name}: ${(chk.stderr ?? "").slice(0, 400)}`);
            parsed.push(name);
            continue;
        }
        const probe = `await import(${JSON.stringify(pathToFileURL(file).href)});`;
        const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
        if (r.status !== 0) fail(`import failed for ${name}: ${(r.stderr ?? "").slice(0, 400)}`);
        imported.push(name);
    }
    console.log(`dist-thin-install: OK — cli ${installedVersion}; imported ${imported.length} agent bundle(s) [${imported.join(", ")}]; parse-checked browser bundle(s) [${parsed.join(", ")}]`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
