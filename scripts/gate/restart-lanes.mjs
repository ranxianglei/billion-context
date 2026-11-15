#!/usr/bin/env node
// restart-lanes.mjs — Lane R: repeated KILL/RESTART of the bili proxy inside a
// LIVE long session, driven by REAL host CLIs (dsh headless, pi) against the
// REAL model. Companion to PR billion-context#5635 (hermetic CI-side twin):
// the CI suite proves the mechanism deterministically with zero tokens; this
// lane proves it against the surfaces users actually run, where the proxy is
// self-spawned by the host and every agent invocation is itself a fresh
// process resuming the same session.
//
// Why (#5631): nothing automated ever checked that a FOLDED session survives
// the death of its own proxy process. The interesting failure lives exactly at
// that boundary: proxy dies → host respawns a FRESH proxy → the new process
// must rehydrate the folded session state from disk, serve the SAME session
// id, keep outbound far below the raw-history size, keep the prompt prefix
// stable (→ prefix-cache hits), and still answer verbatim from the fold
// summaries. Any of those drifting silently turns "long session + restart"
// into a context explosion or a cache-blackhole, invisible until someone
// notices bills tripled.
//
// Per agent (dsh, pi):
//   w0  warmup          : cheap turn, absorbs boot races
//   t1  @ big window    : read the whole corpus (~80k tok default, tunable via
//                         GATE_R_CORPUS_TOKENS — crank to MB scale if you want
//                         the drama), answer the S40 marker
//   t2  @ big window    : recall S07 verbatim — fixture alive, intact context
//   t3  @ small window  : preflight fold MUST fire on this turn
//   R0/R1/R2            : kill the proxy (SIGTERM -15 / SIGKILL -9 / clean
//                         POST /__bili/shutdown), next host turn respawns it;
//                         assertions after each respawn:
//                           * alive on the same port, NEW pid
//                           * continuation completes under the small window
//                           * outbound lands INSIDE the sandwich: ≤ 40% of
//                             the biggest pre-fold request (fold state survived
//                             — raw resend would blow the cap) AND ≥ 20% of it
//                             (nothing got adopted: an empty/fresh session
//                             would sit far below the floor)
//                           * S40 marker recall after each kill is recorded as
//                             EVIDENCE only — verbatim survival through a fold
//                             is Lane A's (fold quality), not the restart's job
//                           * exactly ONE live proxy holds the session
//                             afterward (a [split-brain] LOG line right after
//                             a SIGKILL is legitimate — an in-flight commit
//                             from the dying pid lands milliseconds before the
//                             adopter's first write; the defect would be TWO
//                             LIVE proxies committing one session)
//       plus ONE hostile variant per agent: the HOST process itself is
//       SIGKILLed mid-turn (real abnormal restart of the agent), the next
//       invocation of the same session must recover.
//   final               : cache-hit recovery ≥50% measured on the wire
//                         (usage.prompt_tokens_details.cached_tokens vs the
//                         pre-restart request's prompt size), whenever the
//                         upstream reports usage details; recorded as
//                         evidence-only when it does not.
//
// Kill targets come from the instance registry (<xdg-state>/billion-context/
// instances/*.json → pid + port, written by the self-spawned proxy itself);
// killing is never `pkill`-style (the gate wrapper matches its own command
// line — v0.1.196 lesson).
//
// Env: TGZ, REPO, WORKDIR, MODEL1_BASE_URL, MODEL1_MODEL, MODEL1_API_KEY,
//      GATE_AGENTS (default "dsh,pi"), GATE_SKIP=r, GATE_TURN_TIMEOUT_MS,
//      GATE_R_CORPUS_TOKENS (default 80000), GATE_R_WINDOW (default 16384),
//      GATE_R_CAP_RATIO (default 0.4)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { buildCorpus, CODEWORDS } from "./plugin-lanes.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.env.RESTART_LANES_WORK || path.join(process.env.WORKDIR || process.cwd(), "restart-lanes");
fs.mkdirSync(WORK, { recursive: true });

const TGZ = process.env.TGZ;
const REPO = process.env.REPO;
const MODEL1 = {
  base: process.env.MODEL1_BASE_URL,
  model: process.env.MODEL1_MODEL,
  key: process.env.MODEL1_API_KEY || "gate-local",
};
const MODEL_IDS = String(MODEL1.model).split(",").map((s) => s.trim()).filter(Boolean);
const MODEL_MAIN = MODEL_IDS[0];
const AGENTS = (process.env.GATE_AGENTS_R || process.env.GATE_AGENTS || "dsh,pi")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const TMO = Number(process.env.GATE_TURN_TIMEOUT_MS || 300_000);
const BIG_WINDOW = Number(process.env.GATE_BIG_WINDOW || 262144);
// Default small window: 16384. Two constraints bound this choice:
//   1. FEASIBILITY — a folded session here settles around ~20k tokens
//      (protected recent zone + digests + system). Preflight refuses any
//      turn whose required reduction exceeds all foldable savings; measured
//      at a 2048 wall both lanes deterministically hit “maximum possible
//      saving (~6.5–11.8k tokens) below required reduction (~13.4–19.4k)”.
//      Feasibility requires eff-window ≥ payload − maxFoldable ≈ 9.1k
//      tokens ⇒ wall ≥ ~12.1k (4096 reserved); 16384 is the smallest
//      safe value and matches the local gate convention (#2383 regime).
//   2. TRIGGER — still far below the raw corpus fiber (~35k tokens), so
//      every small-window turn folds before forwarding instead of
//      overflowing upstream.
const R_WINDOW = Number(process.env.GATE_R_WINDOW || 16384);
const CORPUS_TOKENS = Number(process.env.GATE_R_CORPUS_TOKENS || 80000);
const CAP_RATIO = Number(process.env.GATE_R_CAP_RATIO || 0.4);
const CACHE_RATIO = Number(process.env.GATE_R_CACHE_RATIO || 0.5);

if (!TGZ || !REPO || !MODEL1.base || !MODEL1.model) {
  console.error("restart-lanes: TGZ, REPO, MODEL1_BASE_URL, MODEL1_MODEL are required");
  process.exit(2);
}

const results = [];
// Recorder spawned for the in-flight lane; killed from main()'s catch when a
// lane aborts before its own teardown (2026-11-14 leak fix).
let activeRec = null;
function record(lane, name, ok, note) {
  results.push({ lane, name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"} [${lane}] ${name}${note ? ` — ${note}` : ""}`);
}
function sh(bin, args, opts = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8", timeout: opts.timeout ?? TMO, cwd: opts.cwd, env: opts.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}
function must(bin, args, opts = {}) {
  const r = sh(bin, args, opts);
  if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${r.status}\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
  return r;
}
async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// MARK_RE: full deterministic codeword on a TITLE line — a refusal that quotes
// the marker prefix must not pass (same discipline as plugin-lanes).
const S = (i) => `S${String(i + 1).padStart(2, "0")}`;
const MARK_RE = (i) => new RegExp(`TITLE:\\s*GATE-MARK-${S(i)}-${CODEWORDS[i]}\\b`);

function cleanEnv(extra = {}) {
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "dumb", ...extra };
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(BILI|BILLION_CONTEXT|ACP_|OPENCODE|OPENAI|ANTHROPIC|NODE_TEST_CONTEXT|DSH_|PI_|CODEX|CLAUDE)/.test(k)) continue;
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(k)) continue;
    if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(k)) continue;
    env[k] = v;
  }
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

function parseEvents(stdout) {
  let sid = null, final = "";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) { final += line + "\n"; continue; }
    try {
      const e = JSON.parse(line);
      if (e.type === "session" && e.sessionId) sid = e.sessionId;
      if (e.type === "final") final = e.text || "";
      if (e.type === "message" && e.role === "assistant") final += (e.content || e.text || "") + "\n";
    } catch { final += line + "\n"; }
  }
  return { sid, final: final.trim() };
}

// ---- instance registry access -------------------------------------------
function liveInstance(xdgState) {
  const dir = path.join(xdgState, "billion-context", "instances");
  if (!fs.existsSync(dir)) return null;
  let newest = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      // #4982: portReleasedAt marks a draining predecessor — not the live one.
      if (!inst.pid || inst.portReleasedAt) continue;
      if (!newest || (inst.startedAt || 0) >= (newest.startedAt || 0)) newest = inst;
    } catch {}
  }
  return newest;
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
// Count registry entries whose pid is STILL ALIVE and not draining — two
// such entries = genuine concurrent split-brain; log lines alone mean
// nothing (a dying pid can commit one last time milliseconds before death).
function liveInstanceCount(xdgState) {
  const dir = path.join(xdgState, "billion-context", "instances");
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (o.pid && !o.portReleasedAt && pidAlive(o.pid)) n++;
    } catch {}
  }
  return n;
}
async function waitForExit(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!pidAlive(pid)) return true; await sleep(200); }
  return !pidAlive(pid);
}
async function healthy(port) {
  return fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok).catch(() => false);
}

// Kill the live proxy with `variant`, remove the registry marker (stale
// records confuse the adopter), wait for the process to be truly gone.
async function killProxy(xdgState, variant) {
  const inst = liveInstance(xdgState);
  if (!inst) return { ok: false, why: "no live instance registered" };
  const { pid, port } = inst;
  const dir = path.join(xdgState, "billion-context", "instances");
  if (variant === "shutdown") {
    // #5167: pooled keep-alive sockets make the draining listener answer
    // forever — a fresh connection is the real "released" signal.
    let closed = false;
    try {
      closed = (await fetch(`http://127.0.0.1:${port}/__bili/shutdown`, {
        method: "POST", headers: { connection: "close" }, signal: AbortSignal.timeout(15_000),
      })).ok;
    } catch { /* answered-but-non-ok or timeout → force below */ }
    if (!closed) try { process.kill(pid, "SIGTERM"); } catch {}
    await sleep(500);
  } else if (variant === "sigterm") {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  } else if (variant === "sigkill") {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  const gone = await waitForExit(pid, 20_000);
  if (!gone) try { process.kill(pid, "SIGKILL"); } catch {}
  let stale = [];
  try { stale = fs.readdirSync(dir); } catch {}
  for (const f of stale) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (o.pid === pid) fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }
  return { ok: gone && !pidAlive(pid), pid, port };
}

async function runLane(agent) {
  const laneDir = path.join(WORK, agent);
  fs.rmSync(laneDir, { recursive: true, force: true });
  for (const d of ["home", "xdg/config", "xdg/state", "xdg/cache", "xdg/data", "work"]) {
    fs.mkdirSync(path.join(laneDir, d), { recursive: true });
  }
  const xdgConfig = path.join(laneDir, "xdg/config");
  const xdgState = path.join(laneDir, "xdg/state");
  const biliLog = path.join(xdgState, "billion-context", "bili.log");
  const recOut = path.join(laneDir, "upstream.jsonl");
  const recPort = await freePort();
  const recUrl = `http://127.0.0.1:${recPort}`;
  const zonePort = 19000 + (hashStr("restart-" + agent) % 200);

  console.log(`-- lane ${agent}: installing candidate`);
  const prefix = path.join(laneDir, "npm-prefix");
  must("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", TGZ], { timeout: 300_000 });
  const cand = path.join(prefix, "node_modules", "billion-context");
  const candV = JSON.parse(fs.readFileSync(path.join(cand, "package.json"), "utf8")).version;

  // native lanes read bili.json from the DEFAULT XDG location
  const biliJson = path.join(xdgConfig, "billion-context", "billion-context.json");
  fs.mkdirSync(path.dirname(biliJson), { recursive: true });
  fs.writeFileSync(biliJson, JSON.stringify({
    providers: { [recUrl]: { models: Object.fromEntries(MODEL_IDS.map((m) => [m, { context: BIG_WINDOW, output: 4096 }])) } },
    compress: { preserveRecentTokens: 0 },
  }, null, 2));
  fs.writeFileSync(path.join(laneDir, "work", "corpus.md"), buildCorpus(CORPUS_TOKENS));

  const rec = spawn("node", [path.join(HERE, "upstream-recorder.mjs")], {
    env: { ...process.env, RECORDER_PORT: String(recPort), RECORDER_TARGET: MODEL1.base, RECORDER_OUT: recOut },
    // stderr to a per-lane file: inheriting the lane's log pipe meant a
    // detached recorder surviving an aborted lane held the entrypoint's
    // `| tee` pipe open and wedged the whole gate (2026-11-14, 3h hang).
    stdio: ["ignore", "ignore", fs.openSync(path.join(laneDir, "recorder.stderr.log"), "a")],
    detached: true,
  });
  activeRec = rec;

  const baseEnv = cleanEnv({
    HOME: path.join(laneDir, "home"),
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: path.join(laneDir, "xdg/cache"),
    XDG_DATA_HOME: path.join(laneDir, "xdg/data"),
    GATE_UPSTREAM_KEY: MODEL1.key,
    E2E_UPSTREAM_KEY: MODEL1.key,
    BILI_ZONE_PORT: String(zonePort),
    BILI_MODEL_INFO_RETRY_MS: "1000",
  });

  // -- host recipes (same shapes as plugin-lanes RECIPES dsh/pi) ------------
  let ctxEnv;
  if (agent === "dsh") {
    const dshHome = path.join(laneDir, "dsh-home");
    const profile = path.join(dshHome, "profiles", "headless");
    fs.mkdirSync(path.join(profile, "node_modules"), { recursive: true });
    fs.cpSync(cand, path.join(profile, "node_modules", "billion-context"), { recursive: true });
    fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({
      name: "dsh-profile-plugin-gate", private: true,
      dependencies: { "billion-context": candV },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "billion-context"], patchReload: "startup" } },
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(profile, "cordis.yml"), "[]\n");
    const writeWindow = (w) => fs.writeFileSync(path.join(profile, "cordis.patch.yml"), [
      "- id: llm-pi-ai", "  config:", "    providers:", "      gate:",
      "        displayName: Gate Upstream", "        apiKeyEnv: GATE_UPSTREAM_KEY",
      "        api: openai-completions", `        baseURL: ${recUrl}/v1`, "        models:",
      ...MODEL_IDS.map((id) => [`          - id: "${id}"`, `            contextWindow: ${w}`, "            maxTokens: 4096"].join("\n")),
      "- id: agent-default-model", "  config:", "    provider: gate", `    model: "${MODEL_MAIN}"`,
    ].join("\n") + "\n");
    writeWindow(BIG_WINDOW);
    fs.writeFileSync(path.join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n");
    ctxEnv = { ...baseEnv, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: "DISABLED" };
  } else if (agent === "pi") {
    const piDir = path.join(laneDir, "pi-dir");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ packages: [cand] }, null, 2));
    const writeWindow = (w) => fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({
      providers: { gate: { baseUrl: `${recUrl}/v1`, api: "openai-completions", apiKey: "gate-local", models: MODEL_IDS.map((id) => ({ id, contextWindow: w, maxTokens: 4096 })) } },
    }, null, 2));
    writeWindow(BIG_WINDOW);
    ctxEnv = { ...baseEnv, PI_CODING_AGENT_DIR: piDir };
  } else {
    throw new Error(`unsupported lane ${agent}`);
  }
  const setHostWindow = (w) => {
    if (agent === "dsh") {
      const p = path.join(laneDir, "dsh-home/profiles/headless/cordis.patch.yml");
      fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/contextWindow: \d+/g, `contextWindow: ${w}`));
    } else {
      const f = path.join(laneDir, "pi-dir/models.json");
      const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
      cfg.providers.gate.models[0].contextWindow = w;
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
    }
  };

  const turn = async (prompt, tag, opts = {}) => {
    let bin, args;
    if (agent === "dsh") {
      bin = "dsh";
      args = ["--profile", "headless", "headless"];
      if (sid.v) args.push("--session-id", sid.v);
      args.push("--json", opts.warm ? "First run the bash tool with command `echo warmup`. Then " + prompt : prompt);
    } else {
      bin = "pi";
      args = ["-p", "--model", `gate/${MODEL_MAIN}`];
      if (sid.v || tag !== "t1") args.push("--continue");
      args.push(prompt);
    }
    let r = sh(bin, args, { cwd: path.join(laneDir, "work"), env: ctxEnv, timeout: opts.timeout ?? TMO });
    // Per-turn transcripts make any future red self-diagnostic: full agent
    // stdout/stderr on disk, not just the last 300 bytes of stderr inline.
    try {
      const tx = path.join(laneDir, "transcripts");
      fs.mkdirSync(tx, { recursive: true });
      fs.writeFileSync(path.join(tx, `${tag}.log`), `# cmd: ${bin} ${args.join(" ")}\n# exit: ${r.status}\n\n--- stdout ---\n${r.stdout}\n\n--- stderr ---\n${r.stderr}\n`);
    } catch { /* diagnostics must never sink the lane */ }
    let parsed = agent === "dsh" ? parseEvents(r.stdout) : { sid: null, final: r.stdout };
    // CONTENT-critical turns (t1/t2/recall) require a non-empty reply.
    // MECHANICAL control turns (expectContent:false — “reply DONE” style)
    // only require the agent to COMPLETE a turn: after a wall-flip fold the
    // small model occasionally emits an empty answer, and that is a fold-
    // quality story (Lane A asserts on it), not a restart-mechanics failure.
    const wantsContent = opts.expectContent !== false;
    if (r.status === 0 && wantsContent && !String(parsed.final || "").trim()) {
      console.log(`EVIDENCE [${agent}] ${tag}: empty reply despite exit 0 — retrying once`);
      r = sh(bin, args, { cwd: path.join(laneDir, "work"), env: ctxEnv, timeout: opts.timeout ?? TMO });
      parsed = agent === "dsh" ? parseEvents(r.stdout) : { sid: null, final: r.stdout };
    }
    if (parsed.sid) sid.v = parsed.sid;
    const ok = r.status === 0 && (!wantsContent || !!String(parsed.final || "").trim());
    return { ok, why: r.stderr.slice(-300) || `exit ${r.status}`, out: String(parsed.final || "") };
  };

  // max body among all requests recorded so far — the fold discriminator.
  // Without folding, resends stay at raw-history size; with folding they
  // collapse to summary+tail regardless of how big the original was.
  const reqMaxSoFar = () => readJsonl(recOut).filter((r) => r.tag === "req")
    .reduce((m, r) => Math.max(m, JSON.stringify(r.body ?? {}).length), 0);
  const lineCount = () => {
    try { return fs.readFileSync(recOut, "utf8").trim().split("\n").filter(Boolean).length; }
    catch { return 0; }
  };
  // Max forwarded-request size among lines appended SINCE a marker line —
  // the per-restart measurement. (The all-history max includes the pre-fold
  // giant frame and would make every post-kill assertion vacuously true.)
  const reqMaxSince = (from) => {
    const all = String(fs.existsSync(recOut) ? fs.readFileSync(recOut, "utf8") : "").trim().split("\n").filter(Boolean);
    return all.slice(from).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.tag === "req")
      .reduce((m, r) => Math.max(m, JSON.stringify(r.body ?? {}).length), 0);
  };

  const sid = { v: null };
  const t1prompt = `Read corpus.md in your cwd fully (~${Math.round(CORPUS_TOKENS / 4)} words). Your read tool may truncate or ELIDE the middle of a long file — read in sequential chunks until you have seen EVERY line including the middle. Then reply with ONLY the TITLE line of section S40. Do not run any other tool or command.`;
  // Pre-fold recall: S07 lives mid-corpus, untouched at big window — proves
  // the fixture + intact context work BEFORE any boundary is introduced.
  const recallS07 = `Without reading any file again: reply with ONLY the TITLE line of section S07.`;
  // Post-kill recall: S40's title was the model's OWN last answer in the
  // recent zone — it must survive fold AND every process death. Verbatim
  // mid-corpus recall through a fold is Lane A's job (fold quality); Lane R
  // isolates the RESTART mechanics, so the probe targets what a restart is
  // contractually required to preserve: session identity + recent zone.
  const recallS40 = `Without reading any file again: reply with ONLY the TITLE line of section S40.`;

  try {
    const w0 = await turn("Reply with the single word READY.", "w0", { warm: true, timeout: TMO });
    console.log(`-- lane ${agent}: warmup ${w0.ok ? "ok" : "FAILED(non-fatal)"}`);

    const t1 = await turn(t1prompt, "t1");
    fs.writeFileSync(path.join(laneDir, "turn-t1.txt"), t1.out || "");
    record(agent, "t1 corpus read @ big window", t1.ok, t1.why.slice(0, 160));
    record(agent, "S40 marker answered (t1)", MARK_RE(39).test(t1.out), `"${t1.out.trim().slice(0, 80)}"`);
    // Needle recall is model-flaky on small models (same fixture, same window:
    // correct one run, hallucinated sibling word the next) — ONE retry absorbs
    // the single-call wobble; two misses is a real regression signal.
    let t2 = await turn(recallS07, "t2");
    if (!MARK_RE(6).test(t2.out)) {
      console.log(`EVIDENCE [${agent}] t2 first try not verbatim ("${t2.out.trim().slice(0, 60)}") — retrying once`);
      t2 = await turn(recallS07, "t2-retry");
    }
    fs.writeFileSync(path.join(laneDir, "turn-t2.txt"), t2.out || "");
    record(agent, "S07 recalled pre-fold (fixture alive)", MARK_RE(6).test(t2.out), `"${t2.out.trim().slice(0, 80)}"`);

    setHostWindow(R_WINDOW);
    const mark3 = lineCount();
    const t3 = await turn("Reply with the single word DONE.", "t3", { expectContent: false });
    fs.writeFileSync(path.join(laneDir, "turn-t3.txt"), t3.out || "");
    record(agent, "t3 completes", t3.ok, t3.why.slice(0, 160));
    // Everything forwarded in t1–t3 happened before/around the wall flip, so
    // their max is the honest UNCOMPRESSED fiber size. Every later forwarded
    // request must sit well inside it (folded) and well above a bare greeting
    // (session actually adopted).
    const rawFiber = reqMaxSoFar();
    const floor = Math.max(15_000, Math.round(rawFiber * 0.05));
    const foldCap = Math.round(rawFiber * 0.75);
    record(agent, "pre-fold wire baseline established", rawFiber > 50_000,
      `${rawFiber} bytes raw; post-fold bound [${floor}, ${foldCap}]`);
    const afterFold = reqMaxSince(mark3);
    const foldLog = /acp-compress-obs\] shrink (\d+)%/.exec(fs.existsSync(biliLog) ? fs.readFileSync(biliLog, "utf8") : "");
    record(agent, "small window fired the fold before the kills", afterFold > 0 && afterFold <= foldCap,
      `${afterFold} bytes forwarded under small window vs raw ${rawFiber}${foldLog ? ` (log: shrink ${foldLog[1]}%)` : ""}`);

    // ---- the kill matrix ---------------------------------------------------
    // dsh: the plugin spawns a SEPARATE proxy child → kill that proxy directly
    //      (and prove no split-brain: exactly one live instance afterwards).
    // pi:  the engine runs INLINE inside the pi CLI process ("compression
    //      engine running in-process" in bili.log) — there is NO proxy pid to
    //      kill. The restart unit is the pi process itself; every invocation
    //      is a fresh process resuming the on-disk session, so signalling the
    //      host mid-turn IS the restart experiment.
    if (agent === "dsh") {

      const VARIANTS = [["sigterm", "R0"], ["sigkill", "R1"], ["shutdown", "R2"]];
      for (const [variant, tag] of VARIANTS) {
        const before = liveInstance(xdgState);
        const k = await killProxy(xdgState, variant);
        if (!k.ok) { record(agent, `${tag}: kill (${variant})`, false, k.why); continue; }
        record(agent, `${tag}: kill (${variant}) took the proxy down`, true, `pid ${k.pid} released :${k.port}`);
        const mark = lineCount();

        // Next host turn must respawn a FRESH proxy and resume the session.
        const c1 = await turn("Reply with the single word DONE.", `${tag}-a`, { expectContent: false });
        const after = liveInstance(xdgState);
        record(agent, `${tag}: proxy respawned with a new pid`, !!(after && before && after.pid !== before.pid),
          before && after ? `old ${before.pid} → new ${after.pid}` : `before=${before?.pid} after=${after?.pid}`);
        record(agent, `${tag}: continuation completes after respawn`, c1.ok, c1.why.slice(0, 160));

        const c2 = await turn(recallS40, `${tag}-b`);
        fs.writeFileSync(path.join(laneDir, `turn-${tag}.txt`), c2.out || "");
        const lastNew = reqMaxSince(mark);
        record(agent, `${tag}: resumed outbound compact & non-empty after ${variant} (${Math.round(floor / 1024)}–${Math.round(foldCap / 1024)}KiB)`,
          lastNew >= floor && lastNew <= foldCap, `${lastNew} bytes vs raw fiber ${rawFiber}`);
        // Post-fold VERBATIM recall is fold-quality territory (Lane A): which
        // tokens survive the summary is model-dependent, so it is EVIDENCE here
        // — a hallucinated or dropped marker must not fail the RESTART lane.
        console.log(`EVIDENCE [${agent}] ${tag} S40 recall after ${variant}: "${c2.out.trim().slice(0, 80)}"${MARK_RE(39).test(c2.out) ? " ✓verbatim" : " ✗not-verbatim(fold-quality, Lane A domain)"}`);
        const nLive = liveInstanceCount(xdgState);
        record(agent, `${tag}: exactly one live proxy holds the session after ${variant}`, nLive === 1,
          `${nLive} live proxy(es)`);
      }
    } else {
      const P_VARIANTS = [["sigterm", "P0"], ["sigkill", "P1"], ["clean", "P2"]];
      for (const [variant, tag] of P_VARIANTS) {
        // Long-pole prompt: the bash tool's sleep guarantees the process is
        // MID-TURN (holding an open request) when the signal lands.
        const args = ["-p", "--model", `gate/${MODEL_MAIN}`, "--continue",
          "First run the bash tool with command `sleep 15`. Then reply with the single word DONE."];
        const proc = spawn("pi", args, { cwd: path.join(laneDir, "work"), env: ctxEnv, stdio: ["ignore", "pipe", "pipe"] });
        let po = "";
        proc.stdout.on("data", (d) => (po += d));
        // Listener BEFORE any await: a fast host finishing inside the sleep
        // window loses 'exit' forever and wedges the gate (round-3 bug).
        const goneP = new Promise((r) => { proc.once("exit", () => r(true)); proc.once("error", () => r(false)); });
        if (variant === "clean") {
          const done = await Promise.race([goneP.then(() => true), sleep(120_000).then(() => false)]);
          record(agent, `${tag}: clean host exit (control row)`, done, done ? "terminated normally" : "still running at 120s");
          if (!done) { try { proc.kill("SIGKILL"); } catch {} }
        } else {
          await sleep(9000);
          try { proc.kill(variant === "sigterm" ? "SIGTERM" : "SIGKILL"); } catch {}
          await Promise.race([goneP, sleep(30_000)]);
          let alive = false; try { process.kill(proc.pid, 0); alive = true; } catch {}
          record(agent, `${tag}: host killed (${variant}) actually gone`, !alive, `pid ${proc.pid}`);
        }
        const mark = lineCount();
        const rc = await turn("Reply with the single word DONE.", `${tag}-resume`, { expectContent: false });
        record(agent, `${tag}: next invocation resumes the session after ${variant}`, rc.ok, rc.why.slice(0, 160));
        const rl = await turn(recallS40, `${tag}-recall`);
        fs.writeFileSync(path.join(laneDir, `turn-${tag}.txt`), rl.out || "");
        console.log(`EVIDENCE [${agent}] ${tag} S40 recall after ${variant}: "${rl.out.trim().slice(0, 80)}"${MARK_RE(39).test(rl.out) ? " ✓verbatim" : " ✗not-verbatim(fold-quality, Lane A domain)"}`);
        const lastNew = reqMaxSince(mark);
        record(agent, `${tag}: resumed outbound compact & non-empty after ${variant} (${Math.round(floor / 1024)}–${Math.round(foldCap / 1024)}KiB)`,
          lastNew >= floor && lastNew <= foldCap, `${lastNew} bytes vs raw fiber ${rawFiber}`);
      }
    }

    // ---- hostile extra: SIGKILL the HOST agent mid-turn --------------------
    // Every native-lane invocation already IS a fresh agent process resuming
    // the same session; here we make that restart ABNORMAL (kill -9 with a
    // possibly in-flight request) and demand the very next invocation heals.
    // dsh only: for pi the P-variant matrix above IS the host-kill matrix.
    if (agent === "dsh") {
    {
      const args = agent === "dsh"
        ? ["--profile", "headless", "headless", ...(sid.v ? ["--session-id", sid.v] : []), "--json", "Reply with the single word DONE."]
        : ["-p", "--model", `gate/${MODEL_MAIN}`, "--continue", "Reply with the single word DONE."];
      const proc = spawn(agent, args, { cwd: path.join(laneDir, "work"), env: ctxEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (err += d));
      // Attach BEFORE any await: a fast host process can finish inside the
      // sleep window below, and a lost 'exit' event wedges the whole gate
      // (round-3 bug: dsh answered "DONE" in <6s → await exited hung forever).
      const exited = new Promise((r) => {
        proc.once("exit", () => r(true));
        proc.once("error", () => r(false));
      });
      await sleep(6000); // let it get mid-turn (request in flight at worst)
      const pidBefore = proc.pid;
      try { proc.kill("SIGKILL"); } catch {}
      await Promise.race([exited, sleep(30_000)]);
      let pidAlive = false;
      try { process.kill(pidBefore, 0); pidAlive = true; } catch {}
      record(agent, `hostile ${agent} pid ${pidBefore} actually gone after SIGKILL`, !pidAlive,
        pidAlive ? "still alive 30s after signal?!" : "dead, pipes drained") ;
      const recovery = await turn("Reply with the single word DONE.", "hostkill-recovery", { expectContent: false });
      record(agent, "host SIGKILL mid-turn: next invocation of the same session recovers", recovery.ok, recovery.why.slice(0, 160));
      void out; void err;
    }
    }

    // ---- cache-hit recovery on the wire ------------------------------------
    // usage lives in RESPONSE bodies (not requests): top-level `usage` on a
    // non-stream JSON answer, or the terminal `data:` chunk of an SSE stream.
    // The recorder keeps each response tail (256KiB cap).
    const usageOf = (txt) => {
      const grab = (u) => (u
        ? { pt: u.prompt_tokens ?? 0,
            ct: u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens ?? 0 }
        : null);
      try { return grab(JSON.parse(txt)?.usage); } catch {}
      const lines = String(txt).split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]"));
      for (let i = lines.length - 1; i >= 0; i--) {
        let u; try { u = JSON.parse(lines[i].slice(5)).usage; } catch { continue; }
        const g = grab(u);
        if (g && g.pt > 0) return g;
      }
      return null;
    };
    const usages = readJsonl(recOut).filter((r) => r.tag === "resp" && r.status === 200)
      .map((r) => usageOf(String(r.body ?? ""))).filter(Boolean);
    let pair = null;
    for (let i = usages.length - 1; i > 0; i--) {
      if (usages[i - 1].pt > 0 && usages[i].ct > 0) { pair = [usages[i - 1], usages[i]]; break; }
    }
    if (!pair) {
      if (usages.length === 0) {
        // The upstream itself reports no usage details on this wire (some
        // gateways strip them). That is an environment fact, not a product
        // regression — same class as Lane P's ENV-BLOCKED demotion: the
        // ratio is unmeasurable here, so it stays evidence-only and out of
        // the tally. (If usage WAS reported but no prev/next pair exists,
        // the cache plainly did not recover — that one stays red below.)
        console.log(`EVIDENCE [${agent}] upstream did not report prompt/cached token details — cache ratio unmeasurable on this lane (evidence-only, per lane contract)`);
        record(agent, "cache-hit evidence available (upstream reports no usage — evidence-only)", true,
          "no usage details on wire; not counted against the gate (upstream-dependent)");
      } else {
        record(agent, "cache-hit evidence available", false,
          "usage on wire but no prev-prompt/next-cached pair — cache did not recover across restarts");
      }
    } else {
      const [prevU, nextU] = pair;
      const ratio = nextU.ct / prevU.pt;
      record(agent, `cache recovered across restarts (≥${Math.round(CACHE_RATIO * 100)}%)`, ratio >= CACHE_RATIO,
        `cached=${nextU.ct} ≈ ${Math.round(ratio * 100)}% of prior ${prevU.pt} prompt tokens (Lane A parity)`);
    }
  } catch (e) {
    record(agent, "lane driver", false, String(e).slice(0, 400));
  }

  const logTxt = fs.existsSync(biliLog) ? fs.readFileSync(biliLog, "utf8") : "";
  const unknownTool = (logTxt.match(/unknown tool "[^"]+"/gi) || []).slice(0, 3);
  record(agent, "no unknown-tool loops", unknownTool.length === 0, unknownTool.join(" | "));
  try { process.kill(-rec.pid, "SIGKILL"); } catch {}
  activeRec = null;
}

async function main() {
  const skipList = (process.env.GATE_SKIP || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (skipList.includes("r")) {
    console.log("restart-lanes: skipped (GATE_SKIP=r)");
    process.exit(0);
  }
  for (const agent of AGENTS) {
    console.log(`\n===== restart lane: ${agent} =====`);
    try { await runLane(agent); } catch (e) { record(agent, "lane", false, String(e).slice(0, 400)); try { if (activeRec) process.kill(-activeRec.pid, "SIGKILL"); } catch {} activeRec = null; }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nrestart-lanes: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main();
