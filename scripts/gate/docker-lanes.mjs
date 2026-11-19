#!/usr/bin/env node
// docker-lanes.mjs — container-only gate lanes that complement
// scripts/release-gate-local.mjs:
//
//   Lane I  "install"   : npm i -g the candidate tarball (real copy, not a
//                         symlink — billion-context#1225 lesson) and verify
//                         the CLI reports the candidate version.
//   Lane X  "auto-update": publish a fake-newer build of the SAME commit to the
//                         in-container verdaccio, then `bili update` must pick
//                         it up through update.registry and land on the new
//                         version (the v0.1.195→196 auto-update path, generic).
//
// Env: TGZ, VERDACCIO, VERDACCIO_NPMRC, WORKDIR (default /work), REPO
// (default /gate/repo), GATE_SKIP (comma list, same semantics as the gate).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const log = (...a) => process.stdout.write(a.join(" ") + "\n");
const env = (k, d) => (process.env[k]?.length ? process.env[k] : d);

const tgz = env("TGZ", "");
const verdaccio = env("VERDACCIO", "http://127.0.0.1:4873");
const npmrc = env("VERDACCIO_NPMRC", "");
const workdir = env("WORKDIR", "/work");
const repo = env("REPO", "/gate/repo");
const skip = (env("GATE_SKIP", "").toLowerCase() || "").split(",").filter(Boolean);

if (!tgz || !fs.existsSync(tgz)) {
  console.error(`docker-lanes: TGZ missing: ${tgz}`);
  process.exit(2);
}
const V = /billion-context-(.+)\.tgz$/.exec(path.basename(tgz))?.[1] ?? "?";
const NEXT = (() => {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(V);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-gate.0`;
})();

const results = [];
const record = (lane, name, pass, evidence) => {
  results.push({ lane, name, pass });
  log(`  ${pass ? "✅" : "❌"} [${lane}] ${name}${evidence ? ` — ${evidence}` : ""}`);
};
function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 600_000,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
  });
}
const run = (cmd, args, opts) => {
  const r = sh(cmd, args, opts);
  if (opts?.log !== false) log(`    $ ${cmd} ${args.join(" ")} → exit ${r.status}`);
  return r;
};

// ---- Lane I: install --------------------------------------------------------
if (skip.includes("i")) {
  log("\n-- Lane I: SKIPPED (GATE_SKIP)");
} else {
  log(`\n-- Lane I: global install of the candidate (${V})`);
  const r = run("npm", ["install", "-g", tgz, "--install-links", "--no-audit", "--no-fund"]);
  if (r.status !== 0) {
    record("I", "npm i -g <tarball> --install-links", false, (r.stderr || "").slice(-200));
  } else {
    record("I", "npm i -g <tarball> --install-links", true, "");
    const ver = run("bili", ["--version"]).stdout?.trim() || "";
    record("I", `bili --version reports ${V}`, ver.includes(V), `got "${ver}"`);
    // #1225 lesson: a symlinked global install leaks a dev tree into the CLI.
    const root = (run("npm", ["root", "-g"]).stdout || "").trim();
    const rl = run("readlink", [path.join(root, "billion-context")], { log: false }).stdout?.trim();
    record("I", "global install is a true copy (readlink empty)", rl === "", `readlink="${rl}"`);
  }
}

// ---- Lane X: auto-update bump ------------------------------------------------
if (skip.includes("x")) {
  log("\n-- Lane X: SKIPPED (GATE_SKIP)");
} else if (!NEXT) {
  record("X", "version parse for fake-newer build", false, `unparsable ${V}`);
} else {
  log(`\n-- Lane X: auto-update ${V} → ${NEXT} via in-container registry`);
  const pj = path.join(repo, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
  pkg.version = NEXT;
  fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n");
  const pk = run("npm", ["pack", "--pack-destination", workdir], { cwd: repo, log: false });
  const nextTgz = path.join(workdir, `billion-context-${NEXT}.tgz`);
  if (pk.status !== 0 || !fs.existsSync(nextTgz)) {
    record("X", `repack as ${NEXT}`, false, (pk.stderr || "").slice(-200));
  } else {
    record("X", `repack as ${NEXT}`, true, "");
    const pub = run("npm", [
      "publish", nextTgz, "--userconfig", npmrc, "--registry", verdaccio,
    ], { log: false });
    record("X", `publish ${NEXT} to registry`, pub.status === 0, (pub.stderr || "").slice(-200));

    const updCfg = path.join(workdir, "update-config.json");
    fs.writeFileSync(updCfg, JSON.stringify({ update: { registry: verdaccio } }, null, 2));
    const upd = run("bili", ["update"], { env: { BILI_CONFIG_FILE: updCfg } });
    const out = `${upd.stdout || ""}${upd.stderr || ""}`;
    fs.writeFileSync(path.join(workdir, "lane-x-update.log"), out);
    record(
      "X",
      `bili update installs ${NEXT}`,
      new RegExp(`installed[^\\n]*${NEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(out),
      /installed[^\n]*/.exec(out)?.[0]?.slice(0, 120) || `no "installed" line (exit ${upd.status})`,
    );
    const ver2 = run("bili", ["--version"]).stdout?.trim() || "";
    record("X", `bili --version now reports ${NEXT}`, ver2.includes(NEXT), `got "${ver2}"`);
  }
}

log("\n== docker-lanes summary ==");
for (const lane of ["I", "X"]) {
  const rs = results.filter((r) => r.lane === lane);
  if (rs.length) log(`${lane}: ${rs.filter((r) => r.pass).length}/${rs.length} green`);
}
process.exitCode = results.some((r) => !r.pass) ? 1 : 0;
