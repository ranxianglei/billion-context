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
//   Lane Xp "pin policy"  (#6804, run as part of Lane X): pin the installed
//                         version → a live `bili start` auto-updater must
//                         REPORT a newer registry version but never install;
//                         an explicit `bili update` breaks through and clears
//                         the pin; after `bili unpin` the auto-updater resumes
//                         on its own.
//
// Env: TGZ, VERDACCIO, VERDACCIO_NPMRC, WORKDIR (default /work), REPO
// (default /gate/repo), GATE_SKIP (comma list, same semantics as the gate).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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
const Vm = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(V);
// gateVersion(n) bumps the candidate's patch by n and marks it as a gate build
const gateVersion = (bumpN) => (Vm ? `${Vm[1]}.${Vm[2]}.${Number(Vm[3]) + bumpN}-gate.0` : null);
const NEXT = gateVersion(1);

// repack the SAME tree as <nextV> (returns the tarball path + pack status)
function republishAs(nextV) {
  const pj = path.join(repo, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
  pkg.version = nextV;
  fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n");
  const pk = run("npm", ["pack", "--pack-destination", workdir], { cwd: repo, log: false });
  const t = path.join(workdir, `billion-context-${nextV}.tgz`);
  return { t, ok: pk.status === 0 && fs.existsSync(t), err: (pk.stderr || "").slice(-200) };
}
function publishTo(nextV, t) {
  const pub = run("npm", ["publish", t, "--userconfig", npmrc, "--registry", verdaccio], { log: false });
  return { ok: pub.status === 0, err: (pub.stderr || "").slice(-200) };
}

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
  const rep = republishAs(NEXT);
  if (!rep.ok) {
    record("X", `repack as ${NEXT}`, false, rep.err);
  } else {
    record("X", `repack as ${NEXT}`, true, "");
    const pub = publishTo(NEXT, rep.t);
    record("X", `publish ${NEXT} to registry`, pub.ok, pub.err);

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

// ---- Lane X (cont): version-pin policy (#6804) ----------------------------
// The pin is machine state in the cache dir (~/.cache/billion-context/.pin.json),
// separate from the web/CLI `update` lane above. Phases:
//   1. pin 1h → a live `bili start` (fast check interval, zero stagger) must
//      HOLD the pinned version while the registry serves a newer one;
//   2. an explicit `bili update` breaks through, installs, and CLEARS the pin;
//   3. re-pin → holds again → `bili unpin` → the auto-updater RESUMES on its own.
// host-network container: the port space is SHARED with the host — a
// concurrent gate's plugin lanes roam the 18xxx range, so probe for a free
// port instead of trusting a constant (18787 was held by a neighbor run and
// the server came up alive-but-unreachable; #6804 gate run, 2026-11-16).
let PIN_PORT = 0;
const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once("error", () => resolve(false));
  srv.listen({ port, host: "127.0.0.1" }, () => srv.close(() => resolve(true)));
});
const pickPinPort = async () => {
  for (const p of [18787, 18788, 18789, 18790, 18791, 18792, 18793, 18794, 18795, 18796]) {
    if (await portFree(p)) return p;
  }
  throw new Error("no free pin-server port in 18787-18796 — rerun the gate without a concurrent run");
};
const PIN_SERVER_ENV = () => ({
  BILI_UPDATE_CHECK_INTERVAL_MS: "5000",
  BILI_UPDATE_STAGGER_MIN_MS: "0",
  BILI_UPDATE_STAGGER_MAX_MS: "0",
});
if (!skip.includes("x") && NEXT) {
  log(`\n-- Lane Xp: pin policy (#6804) — hold / explicit break-through / unpin resume`);
  PIN_PORT = await pickPinPort();
  log(`[Xp] pin server port: ${PIN_PORT}`);
  const cacheHome = process.env.XDG_CACHE_HOME?.length ? process.env.XDG_CACHE_HOME : path.join(os.homedir(), ".cache");
  const pinFile = path.join(cacheHome, "billion-context", ".pin.json");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const versionNow = () => run("bili", ["--version"], { log: false }).stdout?.trim() || "";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const updCfg = path.join(workdir, "pin-update-config.json");
  fs.writeFileSync(updCfg, JSON.stringify({ update: { registry: verdaccio } }, null, 2));
  const startPinServer = (logFile) => {
    const fd = fs.openSync(logFile, "a");
    const srv = spawn("bili", ["start", "--port", String(PIN_PORT)], {
      env: { ...process.env, BILI_CONFIG_FILE: updCfg, ...PIN_SERVER_ENV() },
      stdio: ["ignore", fd, fd],
    });
    fs.closeSync(fd); // the child holds its own dup
    let exited = null;
    srv.on("exit", (code, sig) => { exited = { code, sig }; });
    srv._exited = () => exited; // a zombie (unreaped exit) must not count as alive
    return srv;
  };
  const stopPinServer = async (srv) => {
    try { srv.kill("SIGTERM"); } catch { /* already gone */ }
    await sleep(2000);
    try { srv.kill("SIGKILL"); } catch { /* already gone */ }
  };
  // Probe /__bili/status and keep BOTH the code and the body: "no response"
  // turned out to hide a real answer (the body says why the endpoint refuses).
  // Probe the web shell (static — no fs/registry work), not /__bili/status:
  // status runs detectStaleInstall which can round-trip the npm registry
  // (NPM_CONFIG_REGISTRY points at a busy foreign verdaccio in this container)
  // and stall past the curl timeout while the server itself is perfectly up.
  const probeStatus = (port) => {
    const r = run("curl", ["-s", "-m", "8", "-w", "\nCODE:%{http_code}", `http://127.0.0.1:${port}/__bili/`], { log: false });
    const out = r.stdout || "";
    const m = out.match(/\nCODE:(\d+)$/);
    return { code: m ? m[1] : "000", body: m ? out.slice(0, m.index) : out };
  };
  const alive = (srv) => {
    if (srv._exited && srv._exited()) return false;
    try { process.kill(srv.pid, 0); return true; } catch { return false; }
  };
  // The server's [update] lines go to the session log, not its stdout
  // (verified: stdout carries only the storage bootstrap).
  const sessionLogPath = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "billion-context", "bili.log");
  // Wait for the pin server to answer 200; if it dies during start, restart
  // it once (the gate container runs sibling lanes at the same time).
  const startPinServerHealthy = async (logFile, tag) => {
    let srv = startPinServer(logFile);
    let last = { code: "000", body: "" };
    const waitUp = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (!alive(srv)) break;
        last = probeStatus(PIN_PORT);
        if (last.code === "200") return true;
        await sleep(2000);
      }
      return alive(srv) && (last = probeStatus(PIN_PORT)).code === "200";
    };
    let up = await waitUp(30000);
    if (!up) {
      const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").slice(-12).join("\n") : "";
      const ex = srv._exited ? srv._exited() : null;
      log(`[Xp] ${tag} pin server not healthy after 30s (alive=${alive(srv)}${ex ? `, exited code=${ex.code} sig=${ex.sig}` : ""}, last status=${last.code} body=${JSON.stringify(last.body.slice(0, 300))})`);
      fs.writeFileSync(path.join(workdir, `lane-x-pin-status-${tag}.txt`), `code=${last.code}\n${last.body}`);
      if (tail) log(tail);
      log(`[Xp] ${tag} restarting once`);
      await stopPinServer(srv);
      await sleep(1500);
      srv = startPinServer(logFile);
      up = await waitUp(30000);
      if (!up) {
        fs.writeFileSync(path.join(workdir, `lane-x-pin-status-${tag}-retry.txt`), `code=${last.code}\n${last.body}`);
      }
    }
    return { srv, up, last };
  };

  // -- Phase 1: pin → live auto-updater holds; explicit update breaks through --
  const p1 = run("bili", ["pin", "1h"]);
  record("Xp", "bili pin 1h records the pin", /Pinned /.test(p1.stdout || ""), (p1.stdout || "").trim().slice(0, 120));
  record("Xp", "pin file created", fs.existsSync(pinFile), pinFile);
  const rep2 = republishAs(gateVersion(2));
  record("Xp", `repack as ${gateVersion(2)}`, rep2.ok, rep2.err);
  const pub2 = publishTo(gateVersion(2), rep2.t);
  record("Xp", `publish ${gateVersion(2)} to registry`, pub2.ok, pub2.err);

  const holdLog = path.join(workdir, "lane-x-pin-hold.log");
  const p1s = await startPinServerHealthy(holdLog, "hold");
  let srv = p1s.srv;
  const st1 = p1s.last.code;
  record("Xp", "pin server is healthy", p1s.up && st1 === "200", `status=${st1 || "no-response"}`);
  await sleep(25000); // let a few 5s-interval checks land
  const vHold = versionNow();
  record("Xp", `pinned ${NEXT} HOLDS while registry serves ${gateVersion(2)}`, vHold.includes(NEXT) && !vHold.includes(gateVersion(2)), `version="${vHold}"`);
  const sessLog = sessionLogPath();
  if (fs.existsSync(sessLog)) fs.copyFileSync(sessLog, path.join(workdir, "lane-x-pin-session.log"));
  const holdTxt = [fs.existsSync(holdLog) ? fs.readFileSync(holdLog, "utf8") : "", fs.existsSync(sessLog) ? fs.readFileSync(sessLog, "utf8") : ""].join("\n");
  const holdEvidence = (/\[update\] holding[^\n]*/.exec(holdTxt) || [""])[0];
  record("Xp", "auto-updater logged the pin hold (report, no install)", /\[update\] holding .*pinned/.test(holdTxt), holdEvidence.slice(0, 160));
  await stopPinServer(srv);

  const up = run("bili", ["update"], { env: { BILI_CONFIG_FILE: updCfg } });
  const upOut = `${up.stdout || ""}${up.stderr || ""}`;
  fs.writeFileSync(path.join(workdir, "lane-x-pin-explicit.log"), upOut);
  record("Xp", `explicit bili update breaks through the pin → ${gateVersion(2)}`, new RegExp(`installed[^\\n]*${esc(gateVersion(2))}`).test(upOut), /installed[^\n]*/.exec(upOut)?.[0]?.slice(0, 120) || `no "installed" line (exit ${up.status})`);
  record("Xp", "pin cleared after the explicit install", !fs.existsSync(pinFile), pinFile);

  // -- Phase 2: re-pin → holds again → unpin → auto-upgrade resumes ----------
  run("bili", ["pin", "1h"]);
  record("Xp", "re-pin after the explicit install", fs.existsSync(pinFile), "");
  const rep3 = republishAs(gateVersion(3));
  record("Xp", `repack as ${gateVersion(3)}`, rep3.ok, rep3.err);
  const pub3 = publishTo(gateVersion(3), rep3.t);
  record("Xp", `publish ${gateVersion(3)} to registry`, pub3.ok, pub3.err);

  const resumeLog = path.join(workdir, "lane-x-pin-resume.log");
  const p2s = await startPinServerHealthy(resumeLog, "resume");
  srv = p2s.srv;
  const st2 = p2s.last.code;
  record("Xp", "resume server is healthy", p2s.up && st2 === "200", `status=${st2 || "no-response"}`);
  await sleep(25000);
  const vHold2 = versionNow();
  record("Xp", `re-pinned ${gateVersion(2)} HOLDS again vs ${gateVersion(3)}`, vHold2.includes(gateVersion(2)) && !vHold2.includes(gateVersion(3)), `version="${vHold2}"`);
  const unpin = run("bili", ["unpin"]);
  record("Xp", "bili unpin releases the pin", /released/.test(unpin.stdout || ""), (unpin.stdout || "").trim().slice(0, 120));
  const t0 = Date.now();
  let resumed = false;
  while (Date.now() - t0 < 90000) {
    if (versionNow().includes(gateVersion(3))) { resumed = true; break; }
    await sleep(3000);
  }
  record("Xp", `auto-upgrade RESUMES after unpin → ${gateVersion(3)}`, resumed, `version="${versionNow()}"`);
  await stopPinServer(srv);
}

log("\n== docker-lanes summary ==");
for (const lane of ["I", "X", "Xp"]) {
  const rs = results.filter((r) => r.lane === lane);
  if (rs.length) log(`${lane}: ${rs.filter((r) => r.pass).length}/${rs.length} green`);
}
process.exitCode = results.some((r) => !r.pass) ? 1 : 0;
