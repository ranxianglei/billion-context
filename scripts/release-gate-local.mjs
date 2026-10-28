#!/usr/bin/env node
// Local real-model release gate — the "last mile" regression that GitHub CI
// cannot run: real models through real dsh, on the operator's machine.
//
// What it pins down (all of this was verified BY HAND during the v0.1.196
// review, PR #2962 — this script freezes that manual pass into one command):
//   Lane A  compression    — small-window route forces a real fold mid-turn
//                            (nudge INJECT -> preflight -> acp-compress-obs),
//                            and the SAME session keeps answering afterwards
//                            (post-fold continuity + cache hit recovery).
//   Lane B  model switch   — same dsh session resumed on a DIFFERENT model /
//                            upstream (no session fork, folded state kept,
//                            cross-upstream usage baseline demoted to
//                            untrusted, cache cold -> hot).
//   Lane U  update probe   — (opt-in, needs a local registry) the
//                            profile-managed proxy detects it is dsh-managed,
//                            skips in-place self-update, and reads `latest`
//                            from the configured update registry.
//
// Everything is HERMETIC: own DSH_HOME, own BILI_CONFIG_FILE, own sessions /
// XDG dirs, own ports. It never touches the operator's ~/.dsh, ~/.config or
// running proxies. The proxy is killed by stored PID only — never pkill
// patterns (they match the gate's own wrapper; lesson from the v0.1.196
// manual pass).
//
// Usage:
//   node scripts/release-gate-local.mjs [--tarball <path>] [--keep]
//        [--skip a|b|u[,…]] [--with-update] [--base-dir <dir>]
//
//   --tarball      built package tarball (default: `npm pack` on the current
//                  tree — run `npm run build` first, as the release
//                  pre-flight already does).
//   --with-update  also run Lane U (needs verdaccio + GATE_VERDACCIO_NPMRC).
//   --keep         keep the scratch dir (default: remove on success, keep on
//                  failure for post-mortem).
//
// Env knobs (all optional; defaults fit the dev host):
//   GATE_DSH_BIN          default "dsh"            (dsh >= 0.2.0-rc.2 surface)
//   GATE_PNPM_BIN         default "pnpm"
//   GATE_SGLANG_URL       default http://127.0.0.1:8199
//   GATE_SGLANG_MODEL     default "qwen3.8-27b,qwen3.6-27b"
//   GATE_RELAY_URL        default http://127.0.0.1:18081 (any second local
//                         model upstream works — Lane B needs a DIFFERENT
//                         model/upstream than GATE_SGLANG_URL)
//   GATE_RELAY_MODEL      default "glm-5.2"
//   GATE_RELAY_KEY        default "gate-relay"   (set to whatever the relay
//                         expects; only forwarded via apiKeyEnv)
//   GATE_TURN_TIMEOUT_MS  default 300000
//   GATE_VERDACCIO        default http://127.0.0.1:4873
//   GATE_VERDACCIO_NPMRC  path to an .npmrc with a publish token (Lane U)
//   GATE_SMALL_WINDOW     bili-side route window the session is shrunk to
//                         mid-run, default 16384 (corpus is read at
//                         GATE_BIG_WINDOW first — see Lane A comment in main())
//   GATE_BIG_WINDOW       real route window for the corpus-read turn, default 262144
//   GATE_CORPUS_TOKENS    corpus size in tokens, default 9000 (calibrated:
//                         big enough that corpus+system overshoots the ~12.3k
//                         effective window, small enough that ONE fold of the
//                         corpus mass leaves the turn viable)
//
// Exit code 0 = every ran lane green. Non-zero = at least one red assertion.
// Evidence (proxy.log, per-turn ndjson, config, corpus) stays in the scratch
// dir on failure.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- helpers ---

const log = (...a) => process.stdout.write(a.join(" ") + "\n");
const warn = (...a) => process.stderr.write("  ⚠ " + a.join(" ") + "\n");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const env = (k, d) => (process.env[k] && process.env[k].length ? process.env[k] : d);

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 120_000,
    cwd: opts.cwd,
    env: opts.env,
  });
  if (opts.check !== false && r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${r.status}\nstdout:${(r.stdout || "").slice(-800)}\nstderr:${(r.stderr || "").slice(-800)}`,
    );
  }
  return r;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function httpOk(url, ms = 5000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());

// 40 unique marker codewords, one per corpus section. The model must echo
// them back from memory — they double as fold-continuity canaries.
const CODEWORDS = [
  "KOAPEL", "TRIVANE", "MURENOK", "SALDIRA", "VEKTRUM", "OLPHANE", "QUIMERA", "ZANDREL",
  "FEROVIK", "LUMETRA", "GHORVAL", "NEXAPIL", "TAVRUON", "SILMADE", "PROVANE", "WEXILOR",
  "ANDRIKE", "MOLVANE", "KESTRIUM", "ULFARON", "BRAVINEK", "TORSELI", "IMMERAL", "DAXUVEN",
  "ROPHELI", "SULMAVR", "KETRIOL", "VANDOME", "PERLUX", "MIRETHAL", "OSTRIVAN", "CALTHOR",
  "ELUVIAN", "DRAMSEK", "FLOVANE", "GRIMETOK", "HELVARIS", "IVONDEL", "JUXAMAR", "KYRATHE",
];
const S = (i) => `S${String(i + 1).padStart(2, "0")}`;
const sectionTitle = (i) => `TITLE: GATE-MARK-${S(i)}-${CODEWORDS[i]}`;

/** Deterministic corpus: 40 sections of ambient-but-distinct filler prose. */
function buildCorpus(targetTokens) {
  const wordsPerSection = Math.max(150, Math.round((targetTokens * 0.72) / 40));
  const out = ["# GATE CORPUS — release-gate-local fixture (deterministic)", ""];
  for (let s = 0; s < 40; s++) {
    out.push(`## Section ${S(s)}`, "", sectionTitle(s), "");
    for (let l = 0; l < 6; l++) {
      const bits = [];
      for (let w = 0; w < Math.round(wordsPerSection / 6); w++) {
        const n = (s * 613 + l * 97 + w * 31) % 37;
        bits.push(`metric${n}`, `signal-${(n * 7) % 23}`, `lane${(n * 5) % 19}`, `holder${(w + s) % 13}`);
      }
      out.push(
        `Study row ${l + 1} records ${bits.slice(0, 8).join(", ")} and settles that the ` +
          `${S(s)} ledger keeps its rank under drift. The marked title above stays the canonical ` +
          `handle for this section; downstream notes must quote it verbatim. ` +
          `${bits.slice(8, 14).join(", ")} confirm the pattern without changing the order.`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ knobs ---

const G = {
  dshBin: env("GATE_DSH_BIN", "dsh"),
  pnpmBin: env("GATE_PNPM_BIN", "pnpm"),
  sglangUrl: env("GATE_SGLANG_URL", "http://127.0.0.1:8199"),
  sglangModel: env("GATE_SGLANG_MODEL", "qwen3.8-27b,qwen3.6-27b"),
  relayUrl: env("GATE_RELAY_URL", "http://127.0.0.1:18081"),
  relayModel: env("GATE_RELAY_MODEL", "glm-5.2"),
  relayKey: env("GATE_RELAY_KEY", "gate-relay"),
  verdaccio: env("GATE_VERDACCIO", "http://127.0.0.1:4873"),
  verdaccioNpmrc: env("GATE_VERDACCIO_NPMRC", ""),
  turnTimeout: Number(env("GATE_TURN_TIMEOUT_MS", 300000)),
  smallWindow: Number(env("GATE_SMALL_WINDOW", 16384)),
  bigWindow: Number(env("GATE_BIG_WINDOW", 262144)),
  corpusTokens: Number(env("GATE_CORPUS_TOKENS", 9000)),
  keep: !!arg("keep"),
  skip: String(arg("skip", "")).split(",").filter(Boolean),
  withUpdate: !!arg("with-update"),
};

const results = [];
let proxyChild = null;

function record(lane, name, pass, evidence) {
  results.push({ lane, name, pass });
  log(`  ${pass ? "✅" : "❌"} [${lane}] ${name}${evidence ? ` — ${evidence}"` : ""}`);
}

async function killProxy() {
  if (!proxyChild) return;
  const pid = proxyChild.pid;
  proxyChild = null;
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  await sleep(1500);
  try { process.kill(-pid, "SIGKILL"); } catch {}
}

async function startProxy(ctx) {
  const out = fs.openSync(ctx.proxyLog, "a");
  const child = spawn(
    process.execPath,
    [ctx.profileEntry, "start", "--host", "127.0.0.1", "--port", String(ctx.port)],
    { detached: true, stdio: ["ignore", out, out], env: ctx.childEnv },
  );
  fs.closeSync(out);
  child.unref();
  proxyChild = child;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) return false;
    if (await httpOk(`http://127.0.0.1:${ctx.port}/__bili/status`, 2000)) return true;
    await sleep(1000);
  }
  return false;
}

// ------------------------------------------------------------------- main ---

async function main() {
  const t0 = Date.now();
  const baseDir = path.resolve(String(arg("base-dir", "")) || path.join(os.tmpdir(), `bili-release-gate-${Date.now()}`));
  fs.mkdirSync(baseDir, { recursive: true });

  log("== local real-model release gate ==");
  log(`scratch: ${baseDir}`);

  // ---- 0. prerequisites ----------------------------------------------------
  let tarballPath = String(arg("tarball", "") || "");
  if (!tarballPath) {
    log("no --tarball: running `npm pack` on the current tree…");
    const r = sh("npm", ["pack", "--pack-destination", baseDir], { check: false, timeout: 300_000 });
    const m = /billion-context-[\d.]+\.tgz/.exec((r.stdout || "") + (r.stderr || ""));
    if (!m) throw new Error("npm pack produced no tarball — run `npm run build` first, or pass --tarball");
    tarballPath = path.join(baseDir, m[0]);
  }
  tarballPath = path.resolve(tarballPath);
  if (!fs.existsSync(tarballPath)) throw new Error(`tarball not found: ${tarballPath}`);
  const version = /billion-context-(.+)\.tgz$/.exec(path.basename(tarballPath))?.[1] ?? "?";
  log(`candidate: billion-context@${version} (${path.basename(tarballPath)})`);

  const dshOk = sh(G.dshBin, ["--help"], { check: false }).status === 0;
  const sglangOk = await httpOk(`${G.sglangUrl}/v1/models`, 4000);
  const relayOk = await httpOk(`${G.relayUrl}/`, 3000);
  const verdaccioOk = await httpOk(`${G.verdaccio}/-/ping`, 3000);
  log(`lanes available: dsh=${dshOk} sglang=${sglangOk} relay=${relayOk} verdaccio=${verdaccioOk}`);
  if (!dshOk || !sglangOk) throw new Error("Lane A prerequisites missing (dsh CLI / sglang). Fix GATE_* env or start the services.");
  if (!relayOk) warn(`relay ${G.relayUrl} not ok — Lane B (model switch) will be SKIPPED`);

  // ---- 1. hermetic environment --------------------------------------------
  for (const d of ["dsh-home/profiles", "work", "sessions", "xdg/state", "xdg/cache", "xdg/data"]) {
    fs.mkdirSync(path.join(baseDir, d), { recursive: true });
  }
  const port = await freePort();
  const profileDir = path.join(baseDir, "dsh-home", "profiles", "gate");
  const proxyLog = path.join(baseDir, "proxy.log");
  const biliConfig = path.join(baseDir, "bili.json");

  const childEnv = {
    ...process.env,
    DSH_HOME: path.join(baseDir, "dsh-home"),
    BILI_CONFIG_FILE: biliConfig,
    BILI_SESSIONS_DIR: path.join(baseDir, "sessions"),
    XDG_STATE_HOME: path.join(baseDir, "xdg/state"),
    XDG_CACHE_HOME: path.join(baseDir, "xdg/cache"),
    XDG_DATA_HOME: path.join(baseDir, "xdg/data"),
    // npm metadata cache must be per-run: a shared ~/.npm/_cacache lets the
    // dsh copy's dist-tags read serve a STALE latest from a previous round
    // (observed: latest=<old candidate> for >60s after this round's publish,
    // long enough to fail Lane U's up-to-date assertion inside the 240s poll).
    NPM_CONFIG_CACHE: path.join(baseDir, "npm-cache"),
    BILI_PROVIDER_REWRITES: "",
    PI_PROVIDER: "",
    BILI_GATE_KEY: "gate-local",
    ZHIPUAI_GATE_KEY: G.relayKey,
  };

  const biliConfigFor = (window) =>
    fs.writeFileSync(
      biliConfig,
      JSON.stringify(
        {
          providers: {
            // Lane A reads the corpus at the REAL window first: a fresh read
            // tool-result sits inside the protected recent zone, so an
            // oversized turn whose mass is all-recent is a #2847 fail-fast,
            // not a fold case. The gate then shrinks the route window
            // mid-session (the field-report "switched to a smaller-window
            // model" lane) so the NEXT turn must fold the now-older corpus
            // mass to survive.
            [G.sglangUrl]: { models: { [G.sglangModel]: { context: window, output: window === G.bigWindow ? 32768 : 4096 } } },
            ...(relayOk ? { [G.relayUrl]: { models: { [G.relayModel]: { context: 32768, output: 8192 } } } } : {}),
          },
          // Lane U reads `latest` from here (a dsh-managed proxy must NOT self-update in place).
          ...(verdaccioOk ? { update: { registry: G.verdaccio } } : {}),
        },
        null,
        2,
      ),
    );
  biliConfigFor(G.bigWindow);

  // ---- 2. dsh profile + candidate install ---------------------------------
  // A dsh profile is just a directory under DSH_HOME/profiles/<name>: the
  // dsh.profile.bundles manifest (resolved from the dsh installation itself),
  // the cordis entry list (empty; everything is a patch), cordis.patch.yml,
  // and node_modules materialized by pnpm. Bootstrapping it by hand avoids
  // `dsh <name> --from-default-profile` (which wants a live task argument).
  log(`materializing dsh profile "gate" …`);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "package.json"),
    JSON.stringify(
      {
        name: "dsh-profile-gate",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(path.join(profileDir, "cordis.yml"), "[]\n");
  fs.writeFileSync(
    path.join(profileDir, "pnpm-workspace.yaml"),
    ["packages:", "  - .", "nodeLinker: hoisted", "autoInstallPeers: false", ""].join("\n"),
  );
  sh(G.pnpmBin, ["add", `billion-context@file:${tarballPath}`, "--save-exact"], {
    cwd: profileDir, env: childEnv, timeout: 300_000,
  });
  const profileEntry = path.join(profileDir, "node_modules", "billion-context", "dist", "index.js");
  if (!fs.existsSync(profileEntry)) throw new Error(`profile install incomplete: ${profileEntry} missing`);
  const installedV = JSON.parse(
    fs.readFileSync(path.join(profileDir, "node_modules", "billion-context", "package.json"), "utf8"),
  ).version;
  log(`profile gate: billion-context@${installedV}`);
  if (installedV !== version) warn(`tarball says ${version} but profile installed ${installedV} — continuing`);

  const cordisFor = (defaultProvider, defaultModel) =>
    [
      "- id: agent-default-model",
      "  config:",
      `    provider: ${defaultProvider}`,
      `    model: ${defaultModel.includes(",") ? `"${defaultModel}"` : defaultModel}`,
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      bili-qwen27b:",
      "        apiKeyEnv: BILI_GATE_KEY",
      `        baseURL: http://127.0.0.1:${port}/bili/${G.sglangUrl}/v1`,
      "        api: openai-completions",
      "        models:",
      `          - id: "${G.sglangModel}"`,
      "            contextWindow: 262144",
      ...(relayOk
        ? [
            "      zhipuai:",
            "        apiKeyEnv: ZHIPUAI_GATE_KEY",
            `        baseURL: http://127.0.0.1:${port}/bili/${G.relayUrl}`,
            "        api: openai-completions",
            "        models:",
            `          - id: ${G.relayModel}`,
            "            contextWindow: 200000",
          ]
        : []),
    ].join("\n") + "\n";
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), cordisFor("bili-qwen27b", G.sglangModel));

  // Corpus sized to overshoot the small effective window exactly once:
  // ~12k corpus tokens + system overhead ≈ 16k input vs ~12.3k effective —
  // one preflight fold leaves the turn viable (calibrated on the manual pass).
  fs.writeFileSync(path.join(baseDir, "work", "corpus.md"), buildCorpus(G.corpusTokens));

  const ctx = { workDir: path.join(baseDir, "work"), childEnv, proxyLog, port, profileEntry, sessionId: null };
  const mark = () => fs.statSync(proxyLog).size;
  const slice = (from, to) => fs.readFileSync(proxyLog, "utf8").slice(from, to ?? undefined);

  async function turn(prompt, label) {
    const r = spawnSync(
      G.dshBin,
      ["--profile", "gate", "headless", "--json", ...(ctx.sessionId ? ["--session-id", ctx.sessionId] : []), prompt],
      { encoding: "utf8", timeout: G.turnTimeout, cwd: ctx.workDir, env: ctx.childEnv },
    );
    fs.writeFileSync(path.join(baseDir, `dsh-${label}.jsonl`), r.stdout || "");
    if (r.stderr) fs.writeFileSync(path.join(baseDir, `dsh-${label}.err`), r.stderr);
    if (r.status !== 0 && !r.stdout)
      return { ok: false, why: `dsh exited ${r.status}: ${(r.stderr || "").slice(-300)}`, final: "", sessionId: null };
    let sessionId = null, final = "", errText = "";
    for (const line of String(r.stdout).split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "session" && e.sessionId) sessionId = e.sessionId;
        if (e.type === "final") final = e.text || "";
        if (e.type === "status" && e.phase === "turn_end" && e.reason?.kind === "error")
          errText = e.reason.error?.message || "turn error";
      } catch {}
    }
    return { ok: !errText, why: errText, final, sessionId };
  }

  // ---- 3. proxy up ----------------------------------------------------------
  log(`starting profile proxy on 127.0.0.1:${port} …`);
  if (!(await startProxy(ctx))) throw new Error(`proxy did not come up — see ${proxyLog}`);

  try {
    // ================= Lane A: compression =================================
    if (!G.skip.includes("a")) {
      log(`\n-- Lane A: fold + post-fold continuity (${G.sglangModel}; window shrunk ${G.bigWindow} → ${G.smallWindow} mid-session)`);
      // T1 at the real window: read + answer, no fold expected (all fresh).
      // dsh's read elides the MIDDLE of any result over ~8KB (head+tail kept):
      // a single 90KB/441-line corpus read loses lines ~41–400 — S07 (line ~71)
      // was never delivered and the t2 payload stayed under the fold threshold
      // (#4288 then rightly skips folding). Force chunked reads so the whole
      // corpus actually enters history (35 lines ≈ 7KB < the elision budget).
      const m1 = mark();
      const t1 = await turn(`Read corpus.md in your cwd fully. The read tool elides the middle of any large result — the file is 441 lines / ~90KB, so read it in EXACTLY these 13 chunks, one read call each, in order: offsets 1, 36, 71, 106, 141, 176, 211, 246, 281, 316, 351, 386, 421 with limit 35 each. After all 13 reads are done, reply with ONLY the TITLE line of section S40.`, "t1");
      ctx.sessionId = ctx.sessionId || t1.sessionId;
      record("A", "turn 1 (read @ real window) completes", t1.ok, t1.ok ? "" : t1.why.slice(0, 160));
      const s1 = slice(m1);
      record("A", "no fold while corpus is fresh (protected)", !/acp-compress-obs\] shrink/.test(s1), "");
      record("A", "S40 marker answered from corpus", has(t1.final, CODEWORDS[39]), `final="${t1.final.trim().slice(0, 80)}"`);

      // Shrink the route window mid-session + restart (also proves session
      // persistence across a proxy restart). Next turn's input overshoots
      // the ~12.3k effective window with corpus now old enough to fold.
      biliConfigFor(G.smallWindow);
      await killProxy();
      if (!(await startProxy(ctx))) throw new Error(`proxy restart failed — see ${proxyLog}`);

      const m2 = mark();
      const t2 = await turn("Without reading any file again, and WITHOUT calling any tool (no search_context, no file reads, no commands — tool use invalidates the measurement): reply with ONLY the TITLE line of section S07.", "t2");
      // T2b gives the cache a second stable-prefix request so the warm-up
      // after the fold is observable (first post-fold round often has no
      // upstream cache report at all).
      const t2b = await turn("Reply with the single word DONE.", "t2b");
      const s2 = slice(m2);
      const fold = /acp-compress-obs\] shrink (\d+)%/.exec(s2);
      record("A", "turn 2 completes after window shrink", t2.ok, t2.ok ? "" : t2.why.slice(0, 160));
      record("A", "fold fired mid-session", !!fold, fold ? `shrink ${fold[1]}%` : "no acp-compress-obs line");
      // #3416: two INDEPENDENT assertions — the old OR form let a preflight
      // line alone green this check while the nudge path was silently dead
      // (exactly the #3401 blind spot: suppression-class bugs passed gate).
      const nudgeHit = /nudge INJECT/.test(s2);
      const preflightHit = /preflight compressing/.test(s2);
      record("A", "nudge injected (hard)", nudgeHit, nudgeHit ? "nudge INJECT" : "no nudge INJECT line — preflight must not substitute");
      record("A", "preflight engaged", preflightHit, preflightHit ? "preflight compressing" : "no preflight compressing line");
      record("A", "S07 marker recalled from FOLDED context", has(t2.final, CODEWORDS[6]), `final="${t2.final.trim().slice(0, 80)}"`);
      const hitsA = [...s2.matchAll(/cache hit (\d+)%/g)].map((m) => Number(m[1]));
      record("A", "cache recovered after fold", hitsA.length > 0 && Math.max(...hitsA) >= 50, hitsA.length ? `hits=${hitsA.join(",")}%` : "no cache report at all");
    }

    // ================= Lane B: model switch =================================
    if (relayOk && !G.skip.includes("b")) {
      log(`\n-- Lane B: same-session switch ${G.sglangModel} -> ${G.relayModel} (different upstream)`);
      const pfaBefore = /\[sess=(pfa-[0-9a-f]+)\]/.exec(slice(0))?.[1];
      // The pfa the session lives on RIGHT BEFORE the switch (after Lane A's
      // fold — folds legitimately change the pfa).
      const mPre = mark();
      const pfaPre = /\[sess=(pfa-[0-9a-f]+)\]/.exec(slice(0, mPre))?.[1] || pfaBefore;

      // Switch the default model to the relay lane and RESTART the proxy —
      // also proves folded state survives a proxy restart.
      fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), cordisFor("zhipuai", G.relayModel));
      await killProxy();
      if (!(await startProxy(ctx))) throw new Error(`proxy restart failed — see ${proxyLog}`);

      const m3 = mark();
      const t3 = await turn("Without reading any file again, and WITHOUT calling any tool (no search_context, no file reads, no commands — tool use invalidates the measurement): reply with the TITLE lines of section S07 and section S40, one per line, then the word DONE.", "t3");
      const s3 = slice(m3);
      const pfa3 = /\[sess=(pfa-[0-9a-f]+)\]/.exec(s3)?.[1];
      const forked = pfa3 && pfa3 !== pfaPre && s3.includes(`lineage=forked of ${pfaPre}`);
      // Either the fork adopts the parent's blocks, or it takes the designed
      // fresh-start path: "no fully-present blocks to adopt … starting fresh;
      // lineage linked …" (#629/#3925) — the lineage link alone preserves the
      // folded context via the startup sweep.
      const adopted = /\[fork-adoption\] fork of [^:]+: (?:parent has \d+ adoptable block|no fully-present blocks to adopt .*starting fresh; lineage linked)/.test(s3);
      record("B", "switch turn completes", t3.ok, t3.ok ? "" : t3.why.slice(0, 160));
      // Same lineage across the switch: either the session continues on the
      // same pfa, or dsh's resume-replay forks it and the fork machinery
      // adopts the parent's folded blocks (#2832/#2936 path) — both preserve
      // the compressed context. A pfa change with NO lineage link is a fork bug.
      record("B", "same lineage across switch + proxy restart", (!!pfaPre && pfa3 === pfaPre) || (forked && adopted), forked ? `${pfaPre} -> ${pfa3} (forked + adopted)` : `${pfaPre} -> ${pfa3}`);
      // If a usage-baseline measured on the OLD upstream gets cited while
      // routing to the NEW one, it must be demoted to untrusted (#2283/#2867).
      // (A forked lineage may have no baseline at all — that's fine, and a
      // fork legitimately prints "usage-baseline=none"; the old
      // !/usage-baseline/ pattern matched THAT line and red-flagged a healthy
      // fork. Only a cited NUMERIC baseline needs the demotion check.)
      const noBaseline = !/usage-baseline=\d/.test(s3);
      record("B", "cross-upstream baseline demoted when cited", noBaseline || /demoting to untrusted/.test(s3), noBaseline ? "no baseline cited this run" : "demoting to untrusted");
      record("B", "both markers recalled after switch", has(t3.final, CODEWORDS[6]) && has(t3.final, CODEWORDS[39]), `final="${t3.final.trim().slice(0, 90)}"`);
      record("B", `request routed to ${G.relayModel}`, s3.includes(G.relayUrl) || s3.includes(G.relayModel), "");

      const m4 = mark();
      const t4 = await turn("Reply with exactly: OK", "t4");
      const s4 = slice(m4);
      const hitsB = [...s4.matchAll(/cache hit (\d+)%/g)].map((m) => Number(m[1]));
      record("B", "new-upstream cache warms up", t4.ok && hitsB.length > 0 && Math.max(...hitsB) >= 75, hitsB.length ? `hits=${hitsB.join(",")}%` : "no usage report");
    } else if (!relayOk && !G.skip.includes("b")) {
      log("\n-- Lane B: SKIPPED (relay unavailable)");
    }

    // ================= Lane U: update-lane probe ============================
    if (G.withUpdate && !G.skip.includes("u")) {
      if (!verdaccioOk) {
        warn(`verdaccio ${G.verdaccio} not ok — Lane U SKIPPED`);
      } else {
        log(`\n-- Lane U: dsh-managed lane + registry read (${G.verdaccio})`);
        if (G.verdaccioNpmrc && fs.existsSync(G.verdaccioNpmrc)) {
          // Prerelease version strings (e.g. 0.1.203-master-review.1) are
          // REFUSED an implicit `latest` by npm ("You must specify a tag when
          // publishing a prerelease version") — without an explicit --tag the
          // publish fails and Lane U reads a stale latest off the registry.
          const pub = sh("npm", ["publish", tarballPath, "--tag", "latest", "--userconfig", G.verdaccioNpmrc, "--registry", G.verdaccio], { check: false, timeout: 300_000 });
          if (pub.status !== 0) {
            const out = `${pub.stdout || ""}${pub.stderr || ""}`;
            // Re-publishing an already-published candidate (re-runs) is fine;
            // anything else must fail LOUD — check:false used to swallow it.
            // Wording differs by registry: npmjs says EPUBLISHCONFLICT,
            // verdaccio says "409 Conflict … already present".
            if (/EPUBLISHCONFLICT|409 conflict|already present|cannot publish over|version already exists/i.test(out)) {
              log("  (publish: version already on the registry — keeping it)");
            } else {
              record("U", "candidate publish to verdaccio", false, out.trim().split("\n").slice(-3).join(" | ").slice(0, 200));
            }
          }
        } else {
          warn("GATE_VERDACCIO_NPMRC missing — skipping publish (assuming the version is already on the registry)");
        }
        const managedRe = /managed by dsh.*skipping in-place self-update/;
        const vEsc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const upToDateRe = new RegExp(`dsh profile bundle up to date \\(current=${vEsc} latest=${vEsc}`);
        // The proxy's first update cycle lands ~10s after boot and logs the
        // managed-by-dsh + up-to-date lines back-to-back (same cycle). A young
        // log (U-only runs) or a #2456 deferral window can push that minutes
        // out (throttle ~3min) — poll for BOTH, bounded; full A+B runs already
        // have them and return on the first iteration.
        let fullNow = slice(0);
        let upToDateAt = 0;
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline) {
          if (managedRe.test(fullNow) && upToDateRe.test(fullNow)) break;
          if (!upToDateAt && upToDateRe.test(fullNow)) upToDateAt = Date.now();
          if (upToDateAt && Date.now() - upToDateAt > 15_000) break; // partner lines log in one cycle; give a short grace then judge what we have
          await sleep(5_000);
          fullNow = slice(0);
        }
        record("U", "proxy recognizes dsh-managed install", managedRe.test(fullNow), "");
        const observed = fullNow.match(/dsh profile bundle up to date \(current=[^\s)]+ latest=[^\s)]+/)?.[0] || "";
        record("U", `registry latest read = ${version}`, upToDateRe.test(fullNow), observed);
      }
    }
  } finally {
    await killProxy();
  }

  // ---- report ----------------------------------------------------------------
  log("\n== gate summary ==");
  for (const lane of ["A", "B", "U"]) {
    const rs = results.filter((r) => r.lane === lane);
    if (rs.length) log(`${lane}: ${rs.filter((r) => r.pass).length}/${rs.length} green`);
  }
  log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (results.some((r) => !r.pass)) {
    log(`SCRATCH KEPT for post-mortem: ${baseDir}`);
    process.exitCode = 1;
  } else {
    log(G.keep ? `scratch kept (--keep): ${baseDir}` : `cleaning scratch ${baseDir}`);
    if (!G.keep) fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

main().catch(async (e) => {
  console.error(e.stack || e);
  await killProxy();
  process.exitCode = 1;
});
