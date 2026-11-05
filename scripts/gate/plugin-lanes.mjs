#!/usr/bin/env node
// plugin-lanes.mjs — Lane P: REAL host CLIs against the REAL model API,
// across BOTH activation lanes:
//   native (dsh / pi / opencode v1+v2): thin plugin / native extension
//          intercepts host fetch, stamps x-bili-plugin, SELF-SPAWNS the bili
//          proxy (port 0) — we never start a proxy ourselves.
//   prefix (codex / claude): host points at a bili proxy via the /bili/ URL
//          prefix (proxy mode) — we start the proxy manually.
//
// Why (#3416): the old gate only drove dsh headless through its own
// profile-managed endpoint (pluginMode=false). #3401 (DSH plugin sessions
// with tools on the wire got nudge+compress suppressed) lived entirely in
// the plugin lane and the gate was GREEN through all of it.
//
// Wire truth: an upstream recorder (upstream-recorder.mjs) sits between bili
// and the real model; we assert on what the MODEL actually received (tools
// declared, nudge prompt text) — bili's internal log can be fooled by a
// suppression bug saying nothing (#3401's log said ARMED-SUPPRESSED, which is
// at least honest), but the wire cannot be fooled at all.
//
//   t1 @ big window   : read corpus, echo S40 marker (fold must NOT fire)
//   window shrink      : per-host setWindow — rewrite the HOST's own model
//                        config (dsh cordis / pi models.json / opencode.json /
//                        codex config.toml / claude model alias), since the
//                        effective window arrives via x-bili-plugin-context-window
//                        and native proxies keep a sticky zone port per request.
//   t2 @ mid window    : S07 recall from intact context + HARD nudge-on-wire
//                        assertion (mid is self-calibrated from t1/t2 usage)
//   t3 @ small window  : "DONE" — preflight fold path must fire
//   t4                  : recall S07 again — must survive the fold
//
// dsh protocol matrix (#3475): the dsh recipe is parameterized over the four
// provider api types pi-ai supports — openai-completions (the original lane),
// openai-responses, anthropic-messages, google-generative-ai. Same headless
// driver, only the cordis provider `api` + baseURL suffix change. Each variant
// carries a WIRE_EXPECT entry: the recorder must see POSTs whose path AND body
// top-level shape match that wire (hard wire assertion, not log). When the
// upstream lacks the door (404/405/mapping-400 with no completed turn) the
// lane degrades to env-blocked (traffic + wire shape + plugin claim stay
// hard) instead of failing the gate — same rule as opencode2/#3461.
//
// Env: TGZ, REPO, MODEL1_BASE_URL, MODEL1_MODEL, MODEL1_API_KEY,
//      GATE_AGENTS (default "dsh,pi,codex,opencode,claude"; matrix + proxy
//      lanes opt in: dsh-responses,dsh-anthropic,dsh-google,dsh-proxy),
//      GATE_SKIP=p, GATE_TURN_TIMEOUT_MS (default 300000), PLUGIN_LANES_WORK,
//      GATE_DSH_VERSION (dsh lanes install @deepseek-ai/dsh@<v> per lane,
//      default "latest"), GATE_OUTPUT_TOKENS (output budget: bili.json
//      reservation + dsh cordis maxTokens, default 4096 — thinking models
//      need more or they degenerate to zero-visible-text turns),
//      GATE_DSH_SMALL_WINDOW (fixed override for the dsh lanes' phase-3
//      window; by default it derives from the live t2-end payload)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.PLUGIN_LANES_WORK || path.join(process.env.WORKDIR || process.cwd(), "plugin-lanes");
fs.mkdirSync(WORK, { recursive: true });

const TGZ = process.env.TGZ;
const REPO = process.env.REPO;
const MODEL1 = {
  base: process.env.MODEL1_BASE_URL,
  model: process.env.MODEL1_MODEL,
  key: process.env.MODEL1_API_KEY || "gate-local",
};
// comma-separated MODEL1_MODEL (host wrapper passes a pair) — register every id,
// drive with the first (matches Lane A's model rotation semantics).
const MODEL_IDS = String(MODEL1.model).split(",").map((s) => s.trim()).filter(Boolean);
const MODEL_MAIN = MODEL_IDS[0];
const AGENTS = (process.env.GATE_AGENTS || "dsh,pi,codex,opencode,claude")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
if (AGENTS.includes("opencode2"))
  console.log("[opencode2] NOTE env-blocked on some upstreams: transport websocket passes Responses-WS straight through (HTTP-only upstreams fail the WS handshake); transport http needs a real /v1/responses endpoint (some self-hosted servers have a Responses->chat mapping bug or 404). Lane asserts tools/claim/traffic; turn completion may fail against such upstreams — see #3461.");
if (AGENTS.includes("dsh-responses"))
  console.log("[dsh-responses] NOTE env-blocked when the upstream has no healthy /v1/responses door (self-hosted servers: 404, or a broken Responses->chat mapping answering 400 — same failure class as opencode2/#3461). bili forwards the responses wire as responses; the door must be real. Wire shape + traffic stay hard-asserted; turn/nudge/fold degrade to env-blocked.");
if (AGENTS.includes("dsh-anthropic"))
  console.log("[dsh-anthropic] NOTE env-blocked when the upstream has no /v1/messages door. Cross-validates the claude lane's front door from the dsh side (pi-ai Anthropic SDK).");
if (AGENTS.includes("dsh-google"))
  console.log("[dsh-google] NOTE bili does NOT translate google->chat on egress — the recorder sees the google wire (:streamGenerateContent + contents/parts) exactly as dsh sent it. The lane is env-blocked unless the upstream exposes a /v1beta/models/<id>:generateContent door; the observed egress shape is recorded as the round-trip evidence (#3475 acceptance 2).");
if (AGENTS.includes("dsh-proxy"))
  console.log("[dsh-proxy] NOTE proxy-mode contrast lane (#3475): same dsh host WITHOUT the billion-context bundle, driving the /bili/ prefix door (proxy mode, acp_summary carrier) — contrasts the native plugin lane in one script.");
const TMO = Number(process.env.GATE_TURN_TIMEOUT_MS || 300_000);
const DSH_VERSION = process.env.GATE_DSH_VERSION || "latest";
const BIG_WINDOW = Number(process.env.GATE_BIG_WINDOW || 262144);
const MID_WINDOW = Number(process.env.GATE_MID_WINDOW || 58368);
const SMALL_WINDOW = Number(process.env.GATE_SMALL_WINDOW || 24576);
const CORPUS_TOKENS = Number(process.env.GATE_CORPUS_TOKENS || 25000);
// #3475: output budget (bili.json `output` reservation + dsh cordis maxTokens).
// Thinking models can spend the whole budget on reasoning and end the turn with
// zero visible text — raise it per environment when the gate model thinks hard.
const OUTPUT_TOKENS = Number(process.env.GATE_OUTPUT_TOKENS || 4096);

if (!TGZ || !REPO || !MODEL1.base || !MODEL1.model) {
  console.error("plugin-lanes: TGZ, REPO, MODEL1_BASE_URL, MODEL1_MODEL are required");
  process.exit(2);
}

const results = [];
// #3475: lanes whose upstream lacks the protocol door — degraded verdict,
// excluded from the failure tally (see runLane's env-blocked rule).
const BLOCKED = new Map(); // lane -> { kind: "env" | "client", reason }
function record(lane, name, ok, note) {
  results.push({ lane, name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"} [${lane}] ${name}${note ? ` — ${note}` : ""}`);
}
function sh(bin, args, opts = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8", timeout: opts.timeout ?? TMO, cwd: opts.cwd, env: opts.env,
    maxBuffer: 64 * 1024 * 1024, input: opts.input,
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
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// corpus (same deterministic shape as scripts/release-gate-local.mjs —
// 40 sections, codeword canaries double as fold-recall probes)
// ---------------------------------------------------------------------------
const CODEWORDS = [
  "KOAPEL", "TRIVANE", "MURENOK", "SALDIRA", "VEKTRUM", "OLPHANE", "QUIMERA", "ZANDREL",
  "FEROVIK", "LUMETRA", "GHORVAL", "NEXAPIL", "TAVRUON", "SILMADE", "PROVANE", "WEXILOR",
  "ANDRIKE", "MOLVANE", "KESTRIUM", "ULFARON", "BRAVINEK", "TORSELI", "IMMERAL", "DAXUVEN",
  "ROPHELI", "SULMAVR", "KETRIOL", "VANDOME", "PERLUX", "MIRETHAL", "OSTRIVAN", "CALTHOR",
  "ELUVIAN", "DRAMSEK", "FLOVANE", "GRIMETOK", "HELVARIS", "IVONDEL", "JUXAMAR", "KYRATHE",
];
const S = (i) => `S${String(i + 1).padStart(2, "0")}`;
const sectionTitle = (i) => `TITLE: GATE-MARK-${S(i)}-${CODEWORDS[i]}`;
function buildCorpus(targetTokens) {
  const wordsPerSection = Math.max(150, Math.round((targetTokens * 0.72) / 40));
  const out = ["# GATE CORPUS — plugin-lanes fixture (deterministic)", ""];
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

// ---------------------------------------------------------------------------
// shared lane machinery
// ---------------------------------------------------------------------------
const NUDGE_WIRE_RE = /efficiency nudge to compress early|Context limit reached — compress now/;
// Recall must be a REAL answer: the full deterministic codeword on a TITLE line.
// A refusal that quotes the marker prefix ("I won't invent a `GATE-MARK-S07-…` word")
// must not pass — hence full codeword + TITLE anchor.
const MARK_RE = (i) => new RegExp(`TITLE:\\s*GATE-MARK-${S(i)}-${CODEWORDS[i]}\\b`);

// #3475 protocol matrix: what each pi-ai api type MUST look like at the
// bili→upstream hop (the recorder's view). pathRe selects the door requests
// (POST model calls only — GET /models discovery is ignored); bodyCheck pins
// the wire's top-level shape so a silent wire swap (e.g. google arriving as
// chat) fails loudly instead of reading green.
const WIRE_EXPECT = {
  "openai-completions": {
    door: "/v1/chat/completions",
    // SDKs append query params (?beta=true on Anthropic's messages door,
    // ?alt=sse on google) — match the path prefix, not a bare $ anchor.
    pathRe: /\/chat\/completions(\?[^#]*)?$/,
    bodyCheck: (b) => Array.isArray(b.messages),
  },
  "openai-responses": {
    door: "/v1/responses",
    pathRe: /\/responses(\?[^#]*)?$/,
    bodyCheck: (b) => b.input !== undefined,
  },
  "anthropic-messages": {
    door: "/v1/messages",
    pathRe: /\/messages(\?[^#]*)?$/,
    bodyCheck: (b) => Array.isArray(b.messages) && b.model !== undefined,
  },
  "google-generative-ai": {
    door: "/v1beta/models/<id>:streamGenerateContent",
    pathRe: /\/models\/[^/:?]+:(?:streamGenerateContent|generateContent)/,
    bodyCheck: (b) => Array.isArray(b.contents),
  },
};

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function cleanEnv(extra = {}) {
  // hermetic env — mirror tests/e2e/e2e-opencode-responses-ws.test.ts:91:
  // strip everything bili/host-ambient, then add ONLY what this lane needs.
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "dumb", ...extra };
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(BILI|BILLION_CONTEXT|ACP_|OPENCODE|OPENAI|ANTHROPIC|NODE_TEST_CONTEXT|DSH_|PI_|CODEX|CLAUDE)/.test(k)) continue;
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(k)) continue;
    // ambient HTTP(S)_PROXY (e.g. a system-wide proxy on the host) tunnels plain-fetch
    // hosts (claude-code) through ANOTHER bili → x-bili-hop → the lane proxy
    // flips into bili→bili pass-through (no sessions/nudge/fold). Kill it.
    if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(k)) continue;
    env[k] = v;
  }
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

async function runLane(agent, recipe) {
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

  // candidate install (shared per lane — hosts reference its dist/)
  console.log(`-- lane ${agent}: installing candidate`);
  const prefix = path.join(laneDir, "npm-prefix");
  must("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", TGZ], { timeout: 300_000 });
  const cand = path.join(prefix, "node_modules", "billion-context");
  const candPkg = JSON.parse(fs.readFileSync(path.join(cand, "package.json"), "utf8"));

  // bili config at the DEFAULT XDG location (self-spawned proxies read this;
  // no env needed): providers keyed by the recorder origin = wire truth.
  // NB: the config file is billion-context.json (src/paths.ts configFile()) —
  // writing "bili.json" here silently no-ops (route=none configured=none).
  const biliJson = path.join(xdgConfig, "billion-context", "billion-context.json");
  fs.mkdirSync(path.dirname(biliJson), { recursive: true });
  // Wire model aliases: hosts may send their OWN default model id (claude-code
  // sends "claude-opus-5") instead of MODEL1.model — the local sglang accepts
  // any name, but bili's window lookup is keyed by model id, so every alias
  // seen on the wire must carry the same window entry.
  const extraModels = [];
  const writeWindow = (w) =>
    fs.writeFileSync(biliJson, JSON.stringify({
      providers: {
        [recUrl]: {
          models: Object.fromEntries(
            [MODEL1.model, ...extraModels].map((m) => [m, { context: w, output: OUTPUT_TOKENS }]),
          ),
        },
      },
      compress: { preserveRecentTokens: 0 },
    }, null, 2));
  writeWindow(BIG_WINDOW);

  fs.writeFileSync(path.join(laneDir, "work", "corpus.md"), buildCorpus(CORPUS_TOKENS));

  // upstream recorder: bili → recorder → real model
  console.log(`-- lane ${agent}: recorder :${recPort} -> ${MODEL1.base}`);
  const rec = spawn("node", [path.join(HERE, "upstream-recorder.mjs")], {
    env: { ...process.env, RECORDER_PORT: String(recPort), RECORDER_TARGET: MODEL1.base, RECORDER_OUT: recOut },
    stdio: ["ignore", "ignore", "inherit"], detached: true,
  });

  const baseEnv = cleanEnv({
    HOME: path.join(laneDir, "home"),
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: path.join(laneDir, "xdg/cache"),
    XDG_DATA_HOME: path.join(laneDir, "xdg/data"),
    GATE_UPSTREAM_KEY: MODEL1.key,
    E2E_UPSTREAM_KEY: MODEL1.key,
    // #1660 zone isolation: each native lane gets its own port ladder so a
    // stale proxy on the default 18787 (a leftover from another run/lane)
    // can neither capture the lane's traffic nor force a drift mid-run.
    BILI_ZONE_PORT: String(19000 + (hashStr(agent) % 200)),
    // dsh native plugin: the boot-time model-info resolve can race the host's
    // provider-adapter registration ("no adapter registered"), which poisons
    // the failure-shaped cache for the default 30s cooldown — longer than a
    // whole short headless turn. Retry after 1s so request #2+ re-resolves.
    BILI_MODEL_INFO_RETRY_MS: "1000",
  });

  const ctx = {
    agent, laneDir, workDir: path.join(laneDir, "work"), cand, candV: candPkg.version,
    recUrl, recPort, recOut, baseEnv, writeWindow, biliLog, biliJson, TMO,
    xdgState, proxy: null, proxyPort: null, extraModels,
    readLog: () => { try { return fs.readFileSync(biliLog, "utf8"); } catch { return ""; } },
    harvestWireModels: () => {
      for (const m of (fs.existsSync(biliLog) ? fs.readFileSync(biliLog, "utf8") : "").matchAll(/\[window\] model=([^\s]+) source=/g)) {
        if (m[1] !== MODEL1.model && !extraModels.includes(m[1])) extraModels.push(m[1]);
      }
    },
    killInstances: () => {
      // native lanes: kill self-spawned bili proxies via the instances dir,
      // remove the records so the next host run respawns FRESH (new window).
      const dir = path.join(xdgState, "billion-context", "instances");
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const inst = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (inst.pid) { try { process.kill(inst.pid, "SIGTERM"); } catch {} }
        } catch {}
        fs.rmSync(path.join(dir, f), { force: true });
      }
    },
  };

  try {
    await recipe.setup(ctx);
    const sid = { v: null };
    // Dual marker: the t2/t4 S07-recall assertions presume t1 actually READ
    // the corpus middle — models sometimes elide it despite the chunk-read
    // instruction (observed in proxy mode). Verify the precondition at t1
    // instead of letting downstream recalls fail for fixture reasons.
    const t1 = await recipe.turn(ctx, `Read corpus.md in your cwd fully (~1300 lines). Your read tool may truncate or ELIDE the middle of a long file (e.g. claude-code's Read shows head+tail with "... N lines elided ...") — read in sequential chunks (offset 1, 201, 401, …, ~200 lines each, or equivalent line-range calls) until you have seen EVERY line including the middle; do not stop at a truncation or elision. Then reply with ONLY the TITLE lines of sections S40 and S07 (one per line). Do not run any other tool or command.`, sid, "t1");
    fs.writeFileSync(path.join(ctx.laneDir, `turn-t1.txt`), t1.out || "");
    record(agent, "t1 read @ big window completes", t1.ok, t1.why.slice(0, 160));
    record(agent, "S40 marker answered (t1)", MARK_RE(39).test(t1.out), `"${t1.out.trim().slice(0, 80)}"`);
    record(agent, "S07 marker answered (t1)", MARK_RE(6).test(t1.out), `"${t1.out.trim().slice(0, 80)}"`);

    // ---- phase 2: MID window — high-usage band, nudge must ride the wire --
    // At ~77% usage with ≥5k pending, the over-limit nudge tier injects and
    // the request is UNDER the hard limit, so it forwards immediately WITH
    // the nudge text — the hard wire-level #3401 assertion (a suppressed
    // lane never puts it on the wire).
    // Self-calibrating: each host carries a different per-request scaffolding
    // size (dsh ~14k, pi ~1.5k, ...) that the t1-end session count does NOT
    // include. Attempt 1 seeds mid from p1×1.6 (surface guess); after the t2
    // request the log carries the REAL payload P ("usage=X% (P/eff)"), so
    // attempt 2 recomputes mid = P/0.77 + 4096 exactly. Bounded at 2 tries.
    // p1 = largest session payload seen during the BIG phase (= t1-end state).
    // Do NOT slice at the first [window-change]: source flips (configured→
    // runtime-info, #2283) land mid-t1 and truncate the phase before the
    // payload-bearing idle lines, zeroing p1 and mis-seeding mid.
    const log1 = ctx.readLog();
    const usageMatches = [...log1.matchAll(/nudge idle: usage=\d+% \((\d+)\//g)];
    const p1idle = usageMatches.length ? Math.max(...usageMatches.map((m) => Number(m[1]))) : 0;
    // wire seed: the biggest t1 request body ≈ the real live payload
    // (scaffolding included). Idle log lines lag the final corpus read —
    // a container run seeded mid from a stale idle line (9.3k) while the
    // wire carried 38k, put t2 at 285% usage, and the EMERGENCY nudge rode
    // a fail-fast 502 that never forwarded (hard assertion correctly red).
    const p1wire = Math.ceil(readJsonl(recOut).filter((r) => r.tag === "req")
      .reduce((m, r) => Math.max(m, JSON.stringify(r.body ?? {}).length), 0) / 4);
    const p1 = Math.max(p1idle, p1wire);
    let mid = process.env.GATE_MID_WINDOW
      ? MID_WINDOW
      : (p1 > 0 ? Math.ceil((p1 * 1.6 / 0.77 + 4096) / 1024) * 1024 : MID_WINDOW);
    // A recipe whose small window can grow past the seeded mid (dsh adaptive,
    // #3475) would shrink UP in phase 3 — no fold would ever fire. Keep the
    // mid strictly above the small-window estimate.
    if (recipe.smallWindow && !process.env.GATE_MID_WINDOW) {
      const swEst = recipe.smallWindow(ctx, p1);
      if (mid <= swEst) mid = Math.ceil((swEst * 1.2) / 1024) * 1024;
    }

    let t2 = { ok: false, why: "never ran", out: "" };
    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      ctx.harvestWireModels();
      writeWindow(mid);
      if (recipe.setWindow) await recipe.setWindow(ctx, mid);
      await restartLaneProxy(ctx, recipe);
      await new Promise((r) => setTimeout(r, 1000));
      const mark = ctx.readLog().length;
      // dsh: a leading cheap tool call guarantees ≥2 LLM requests — the
      // boot-time model-info resolve races adapter registration and only
      // request #2+ carries the window header after the 1s retry (see
      // BILI_MODEL_INFO_RETRY_MS above).
      const warm = recipe.warmupPrefix || "";
      t2 = await recipe.turn(ctx, warm + `Without reading any file again, and WITHOUT calling any tool (no search_context, no file reads, no commands — tool use invalidates the measurement): reply with ONLY the TITLE line of section S07.`, sid, "t2");
      fs.writeFileSync(path.join(ctx.laneDir, `turn-t2.txt`), t2.out || "");
      const after = ctx.readLog().slice(mark);
      const um = [...after.matchAll(/usage=(\d+)% \((\d+)\//g)].pop();
      const usagePct = um ? Number(um[1]) : -1;
      const payload = um ? Number(um[2]) : 0;
      // in-band AND a real S07 answer — a wrong-marker reply (model echoes
      // S40's codeword) is worth one cheap retry; dsh tag-echo-only replies
      // (host strips the tag → empty output) need the same.
      if (usagePct >= 75 && usagePct < 95 && t2.ok && t2.out.trim() && MARK_RE(6).test(t2.out)) break;
      if (attempts >= 3 || !payload) break;
      const next = Math.ceil((payload / 0.77 + 4096) / 1024) * 1024;
      if (next === mid && t2.ok && t2.out.trim() && MARK_RE(6).test(t2.out)) break;
      mid = next;
    }
    record(agent, "mid window self-calibrated", mid >= SMALL_WINDOW && mid < BIG_WINDOW,
      `t1-end session ${p1} tok → mid base ${mid} (target usage 77%, ${attempts} attempt(s))`);
    record(agent, "t2 recall @ mid window completes", t2.ok, t2.ok ? "" : t2.why.slice(0, 160));
    record(agent, "S07 recalled (intact context, t2)", MARK_RE(6).test(t2.out), `"${t2.out.trim().slice(0, 80)}"`);

    // ---- phase 3: SMALL window — over-limit, preflight must fold ---------
    // Plugin lanes: the window rides the x-bili-plugin-context-window header
    // stamped from the HOST's own model config — bili.json alone is ignored
    // (first smoke run proved: source=plugin native=262144 regardless of
    // providers config). So the shrink = rewrite the HOST config; the
    // self-spawned proxy (sticky zone port) picks the new value per request.
    // claude-code retries forever when usage sits knife-edge (~100%) — fold
    // deeper so the turn lands WITH margin instead of riding the limit.
    // last payload seen in the log (t2's) feeds adaptive small-window recipes
    const lastUsage = [...ctx.readLog().matchAll(/usage=\d+% \((\d+)\//g)].pop();
    const lastP = lastUsage ? Number(lastUsage[1]) : 0;
    const smallWin = recipe.smallWindow ? recipe.smallWindow(ctx, lastP) : SMALL_WINDOW;
    writeWindow(smallWin);
    if (recipe.setWindow) await recipe.setWindow(ctx, smallWin);
    await restartLaneProxy(ctx, recipe);
    await new Promise((r) => setTimeout(r, 1000));

    if (recipe.turnTimeoutMs) ctx.TMO = recipe.turnTimeoutMs(ctx, "t3");
    let t3 = { ok: false, why: "never ran", out: "" };
    const warm3 = recipe.warmupPrefix || "";
    for (let i = 0; i < 2 && !(t3.ok && t3.out.trim()); i++)
      t3 = await recipe.turn(ctx, warm3 + `Reply with the single word DONE.`, sid, "t3");
    fs.writeFileSync(path.join(ctx.laneDir, `turn-t3.txt`), t3.out || "");
    record(agent, "t3 @ small window completes (preflight fold path)", t3.ok, t3.why.slice(0, 160));

    // phase 3b (#3475): hosts with a large fixed scaffolding (dsh 0.2.x ~18k)
    // leave a post-fold FLOOR that can sit AT the small-window preflight
    // target — t4 then dead-ends ("0 compressible ranges" fail-fast 502, the
    // #2847 shape) although the fold itself fired correctly in t3. Measure the
    // floor (raw wire estimate from the last preflight line) and widen just
    // enough for t4 to land with margin. Adaptive-smallWindow recipes only —
    // fixed-SMALL_WINDOW lanes keep byte-identical behavior.
    if (recipe.smallWindow && t3.ok) {
      // Direct evidence = the last preflight trigger line's raw wire estimate.
      // Without one (clean t3, no over-window request ran yet) assume the
      // WORST CASE: the fold removed nothing net, floor ≈ the t2-end payload.
      const floorM = [...ctx.readLog().matchAll(/local-est=[\d.]+ raw=(\d+)/g)].pop();
      const floor = floorM ? Number(floorM[1]) : lastP;
      const headroom = (w) => Math.min(OUTPUT_TOKENS, Math.floor(w / 4));
      if (floor > 0 && floor >= smallWin - headroom(smallWin)) {
        const want = Math.ceil((floor * 1.1) / 1024) * 1024;
        let w2 = smallWin;
        while (w2 - headroom(w2) < want && w2 < BIG_WINDOW) w2 += 1024;
        if (w2 !== smallWin && w2 <= mid) {
          console.log(`[${agent}] post-fold floor ${floor} tok at the target edge — widening small window ${smallWin} -> ${w2} so t4 lands with margin`);
          writeWindow(w2);
          if (recipe.setWindow) await recipe.setWindow(ctx, w2);
          await restartLaneProxy(ctx, recipe);
          await new Promise((r) => setTimeout(r, 1000));
        } else if (w2 > mid) {
          console.log(`[${agent}] post-fold floor ${floor} tok needs more than mid ${mid} — leaving ${smallWin}, t4 will report honestly`);
        }
      }
    }

    let t4 = { ok: false, why: "never ran", out: "" };
    const warm4 = recipe.warmupPrefix || "";
    for (let i = 0; i < 2 && !(t4.ok && t4.out.trim()); i++)
      t4 = await recipe.turn(ctx, warm4 + `Without reading any file again, and WITHOUT calling any tool (no search_context, no file reads, no commands — tool use invalidates the measurement): reply with ONLY the TITLE line of section S07.`, sid, "t4");
    fs.writeFileSync(path.join(ctx.laneDir, `turn-t4.txt`), t4.out || "");
    record(agent, "t4 completes", t4.ok, t4.why.slice(0, 160));
  } catch (e) {
    record(agent, "lane driver", false, String(e).slice(0, 400));
  }

  // ---- wire + proxy truth assertions ------------------------------------
  const allLines = readJsonl(recOut);
  const reqs = allLines.filter((r) => r.tag === "req");
  const respBySeq = new Map(allLines.filter((r) => r.tag === "resp").map((r) => [r.seq, r]));
  const errSeqs = new Set(allLines.filter((r) => r.tag === "error").map((r) => r.seq));
  const log = ctx.readLog();
  record(agent, "upstream saw traffic", reqs.length > 0, `${reqs.length} requests`);

  // #3475 protocol matrix: hard wire-shape assertion — every door POST at the
  // bili→upstream hop must carry this api type's path AND top-level body
  // shape. A silent wire swap (google arriving as chat, responses as chat…)
  // must fail here, not read green on a generic "turn completed".
  if (recipe.wireApi && WIRE_EXPECT[recipe.wireApi]) {
    const expect = WIRE_EXPECT[recipe.wireApi];
    const doorReqs = reqs.filter((r) => r.method === "POST" && expect.pathRe.test(r.path));
    const badBody = doorReqs.filter((r) => !expect.bodyCheck(r.body || {}));
    record(agent, `wire shape ${recipe.wireApi} at bili->upstream hop`, doorReqs.length > 0 && badBody.length === 0,
      doorReqs.length === 0
        ? `no POST matched ${expect.door}; paths seen: ${[...new Set(reqs.map((r) => `${r.method} ${r.path}`))].slice(0, 6).join(" | ") || "(none)"}`
        : badBody.length > 0
          ? `${badBody.length}/${doorReqs.length} off-shape body(s); first off-shape keys: [${Object.keys(badBody[0].body || {}).join(",")}]`
          : `${doorReqs.length} request(s), all on-shape (path ~${expect.door})`);
    // round-trip evidence (#3475 acceptance 2): what the model hop actually
    // received — first door request, persisted for the report.
    if (doorReqs[0]) {
      const b = doorReqs[0].body || {};
      console.log(`[${agent}] egress sample: ${doorReqs[0].path} top-level=[${Object.keys(b).join(",")}]`);
      fs.writeFileSync(path.join(ctx.laneDir, "egress-sample.json"), JSON.stringify({
        path: doorReqs[0].path, headers: doorReqs[0].headers, topLevelKeys: Object.keys(b), bodyHead: JSON.stringify(b).slice(0, 2000),
      }, null, 2));
    }
    // Blocked-lane rules — two kinds, both excluded from the gate tally:
    // (env)    the UPSTREAM door is unhealthy, so bili never ran against a
    //          live model: either EVERY door request was rejected (4xx/5xx or
    //          connection error) and no turn completed (opencode2/#3461 rule),
    //          or the door DEGRADED MID-FLOW — some requests succeeded, later
    //          ones were rejected, and the flow never finished. A self-hosted
    //          door mapping bug (responses→chat validation, #3461 sibling),
    //          not a bili wire defect. Traffic + wire-shape + tools stay the
    //          hard verdict; turn-dependent records drop out of the tally.
    // (client) the CLIENT cannot drive this protocol at its installed version:
    //          zero upstream traffic and every turn died on a config-validation
    //          error (dsh ≤0.2.1-rc.1's cordis schema lists no
    //          google-generative-ai among provider apis). Nothing ran, so the
    //          whole lane drops out of the tally; it auto-promotes when the
    //          client ships the protocol — no script change needed.
    const turnRecs = results.filter((r) => r.lane === agent && /completes/.test(r.name));
    const flowComplete = turnRecs.length >= 4 && turnRecs.every((r) => r.ok);
    const anyTurnOk = turnRecs.some((r) => r.ok);
    const doorStatusOf = (r) => errSeqs.has(r.seq) ? "conn-error" : (respBySeq.get(r.seq) ? `HTTP ${respBySeq.get(r.seq).status}` : "no-response");
    const rejected = doorReqs.filter((r) => errSeqs.has(r.seq) || !respBySeq.get(r.seq) || respBySeq.get(r.seq).status >= 400);
    const statuses = [...new Set(rejected.map(doorStatusOf))].join(", ");
    const turnStderr = fs.existsSync(path.join(ctx.laneDir, "turn-stderr.log")) ? fs.readFileSync(path.join(ctx.laneDir, "turn-stderr.log"), "utf8") : "";
    let blocked = null;
    if (rejected.length === doorReqs.length && doorReqs.length > 0 && !anyTurnOk) {
      blocked = { kind: "env", reason: `upstream ${expect.door} unhealthy (${statuses})` };
    } else if (rejected.length > 0 && doorReqs.length - rejected.length > 0 && !flowComplete) {
      blocked = { kind: "env", reason: `upstream ${expect.door} degraded mid-flow (${statuses}) after ${doorReqs.length - rejected.length} OK request(s)` };
    } else if (doorReqs.length === 0 && !anyTurnOk && /ValidationError/.test(turnStderr) && /api expected/.test(turnStderr)) {
      const m = /\$\.providers\.\w+\.api expected [^\n]+/.exec(turnStderr);
      blocked = { kind: "client", reason: `client config surface rejects api ${recipe.wireApi} (${m ? m[0] : "ValidationError"}) — zero upstream traffic` };
    }
    if (blocked) {
      BLOCKED.set(agent, blocked);
      record(agent, "BLOCKED degraded verdict", true,
        `${blocked.kind}-blocked: ${blocked.reason} — ${blocked.kind === "env" ? "turn-dependent records below are excluded from the gate tally (opencode2/#3461 rule); rerun against an endpoint exposing a real " + expect.door + " door for the full verdict" : "nothing ran (client cannot express this api yet); the whole lane is excluded from the tally and auto-promotes when the client ships the protocol"}`);
    }
  }
  const fold = /acp-compress-obs\] shrink (\d+)%/.exec(log);
  record(agent, "fold fired (preflight or model-side)", !!fold, fold ? `shrink ${fold[1]}%` : "no acp-compress-obs line");
  const t4txt = fs.existsSync(path.join(ctx.laneDir, "turn-t4.txt")) ? fs.readFileSync(path.join(ctx.laneDir, "turn-t4.txt"), "utf8") : "";
  record(agent, "S07 recalled post-fold (t4)", MARK_RE(6).test(t4txt), `"${t4txt.trim().slice(0, 80)}"`);

  const toolsNames = (r) => {
    const b = r.body || {};
    const flat = (arr) => Array.isArray(arr) ? arr.map((t) => t?.function?.name ?? t?.name).filter(Boolean) : [];
    // google wire declares tools as tools[].functionDeclarations[].name (#3475).
    const gdecls = (arr) => Array.isArray(arr)
      ? arr.flatMap((t) => (Array.isArray(t?.functionDeclarations) ? t.functionDeclarations.map((d) => d?.name) : [])).filter(Boolean)
      : [];
    return [...flat(b.tools), ...gdecls(b.tools), ...flat(b.input_tools)];
  };
  const allTools = [...new Set(reqs.flatMap(toolsNames))];
  record(agent, "ACP tools declared on wire", allTools.some((n) => n === "compress" || n === "acp_status"),
    allTools.slice(0, 10).join(",") || "no tools seen");

  if (recipe.type === "native") {
    // authoritative claim: payload.metadata.pluginAgent in the session files
    // (durable-message-guards.ts binding), corroborated by the window-source
    // log line that only exists on plugin lanes.
    let claim = null;
    const sessRoot = path.join(ctx.laneDir, "xdg/data/billion-context/sessions");
    if (fs.existsSync(sessRoot)) {
      for (const f of fs.readdirSync(sessRoot, { recursive: true })) {
        if (!String(f).endsWith(".json")) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(sessRoot, String(f)), "utf8"))?.payload?.metadata;
          if (meta?.pluginAgent) { claim = meta.pluginAgent; break; }
        } catch {}
      }
    }
    record(agent, "plugin lane claimed (x-bili-plugin)", claim === recipe.pluginAgent,
      claim ? `session metadata.pluginAgent=${claim}` : `no pluginAgent in session files; log source=plugin=${/source=plugin/.test(log)}`);
  } else {
    record(agent, "prefix lane tools via proxy+manifest", allTools.length > 0, `${allTools.length} tool names on wire`);
  }

  const wireNudge = reqs.some((r) => NUDGE_WIRE_RE.test(JSON.stringify(r.body || {})));
  const logNudge = /nudge INJECT T/.test(log);
  const logSuppressed = /nudge ARMED-SUPPRESSED/.test(log);
  record(agent, "nudge reached the model (hard)", wireNudge,
    `${wireNudge ? "wire:seen" : "wire:MISSING"} / ${logNudge ? "log:INJECT" : "log:none"}${logSuppressed ? " / log:ARMED-SUPPRESSED(#3401 shape)" : ""}${logNudge && !wireNudge && !logSuppressed ? " / INJECT-but-never-forwarded: nudge text never reached upstream (check preflight fail-fast loops)" : ""}`);

  const noise = (log.match(/unknown tool "[^"]+"/gi) || []).slice(0, 3);
  record(agent, "no unknown-tool loops", noise.length === 0, noise.join(" | "));
  const exec = /\[plugin\] tool (compress|acp_status) executed via plugin/.exec(log);
  if (exec) record(agent, "model invoked plugin tool", true, exec[0].slice(0, 120));

  ctx.killInstances();
  if (ctx.proxy) { try { process.kill(-ctx.proxy.pid, "SIGKILL"); } catch {} }
  try { process.kill(-rec.pid, "SIGKILL"); } catch {}
}

async function startManualProxy(ctx, args) {
  const entry = path.join(ctx.cand, "dist", "index.js");
  ctx.proxyPort = args.port;
  const logFd = fs.openSync(path.join(ctx.laneDir, "proxy.log"), "a");
  ctx.proxy = spawn("node", [entry, "start", "--host", "127.0.0.1", "--port", String(args.port), "--no-auto-update"], {
    env: { ...ctx.baseEnv, BILLION_CONTEXT_NO_AUTO_UPDATE: "1" },
    stdio: ["ignore", logFd, logFd], detached: true,
  });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const ok = await fetch(`http://127.0.0.1:${args.port}/__bili/health`).then((r) => r.ok).catch(() => false);
    if (ok) return;
  }
  throw new Error(`manual proxy :${args.port} did not become healthy (see ${ctx.laneDir}/proxy.log)`);
}

// Prefix lanes re-read bili.json through a fresh proxy per phase (native lanes'
// self-spawned zone proxy picks the new window up per request instead).
async function restartLaneProxy(ctx, recipe) {
  if (recipe.type !== "prefix") return;
  if (ctx.proxy) { try { process.kill(-ctx.proxy.pid, "SIGKILL"); } catch {} ctx.proxy = null; }
  await startManualProxy(ctx, ctx.proxyArgs ? ctx.proxyArgs() : { port: ctx.proxyPort });
}

// ---------------------------------------------------------------------------
// host recipes
// ---------------------------------------------------------------------------
function parseEvents(stdout) {
  // dsh --json emits event lines; other hosts print plain text.
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

// ---- dsh family: native plugin lanes (THE #3401 lane) + protocol matrix
// (#3475) + proxy-mode contrast lane (owner add-on) -----------------------
// One headless driver parameterized over the four pi-ai provider api types.
// Only the cordis provider `api` and the baseURL change per variant; profile
// layout, window rewrite and turn shape are shared. The openai-completions
// NATIVE variant emits a cordis.patch.yml byte-identical to the pre-#3475 dsh
// lane (zero behavior change for the existing lane).
// BaseURL suffixes follow each SDK's URL assembly:
//   openai-completions / openai-responses — OpenAI SDK appends /chat/completions | /responses
//   anthropic-messages                      — Anthropic SDK appends /v1/messages
//   google-generative-ai                    — genai SDK appends /models/<id>:streamGenerateContent?alt=sse
//                                             (pi-ai sets apiVersion="" so NO version segment is added):
//                                             the suffix must carry /v1beta itself.
const DSH_WARMUP_PREFIX = "First run the bash tool with command `echo warmup`. Then ";

async function dshProfileSetup(ctx, { api, baseURL, withBili }) {
  // Lane-local dsh install: the system dsh may be too old for the
  // headless --json shape, and resolveBundleDir() tries the dsh install
  // anchor BEFORE the profile dir — a stale global billion-context on the
  // machine would shadow the candidate bundle ("declares no dsh.bundle").
  // A per-lane prefix keeps the lane hermetic on any machine.
  const dshPrefix = path.join(ctx.laneDir, "dsh-prefix");
  console.log(`-- lane ${ctx.agent}: installing @deepseek-ai/dsh@${DSH_VERSION}`);
  must("npm", ["install", "-g", "--prefix", dshPrefix, "--no-audit", "--no-fund", `@deepseek-ai/dsh@${DSH_VERSION}`], { timeout: 300_000 });
  const dshHome = path.join(ctx.laneDir, "dsh-home");
  const profile = path.join(dshHome, "profiles", "headless");
  fs.mkdirSync(path.join(profile, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(ctx.laneDir, "tmp"), { recursive: true });
  const bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"];
  const deps = {};
  if (withBili) {
    // candidate as a REAL copy in the profile (e2e-native-dsh.test.ts shape;
    // bundles @deepseek-ai/dsh-base/-headless resolve from the dsh install)
    fs.cpSync(ctx.cand, path.join(profile, "node_modules", "billion-context"), { recursive: true });
    deps["billion-context"] = ctx.candV;
    bundles.push("billion-context");
  }
  const pkg = {
    name: withBili ? "dsh-profile-plugin-gate" : "dsh-profile-proxy-gate", private: true,
    dependencies: deps,
    dsh: { profile: { bundles, patchReload: "startup" } },
  };
  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  fs.writeFileSync(path.join(profile, "cordis.yml"), "[]\n");
  const cordisFor = (window) =>
    fs.writeFileSync(path.join(profile, "cordis.patch.yml"), [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      gate:",
      "        displayName: Gate Upstream",
      `        apiKeyEnv: GATE_UPSTREAM_KEY`,
      `        api: ${api}`,
      `        baseURL: ${baseURL}`,
      "        models:",
      ...MODEL_IDS.map((id) => [
        `          - id: "${id}"`,
        `            contextWindow: ${window}`,
        `            maxTokens: ${OUTPUT_TOKENS}`,
      ].join("\n")),
      "- id: agent-default-model",
      "  config:",
      "    provider: gate",
      `    model: "${MODEL_MAIN}"`,
    ].join("\n") + "\n");
  cordisFor(BIG_WINDOW);
  fs.writeFileSync(path.join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n");
  ctx.dshEnv = {
    ...ctx.baseEnv,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_MODE: "DISABLED",
    // spill-local mkdtemps into the lane (host /tmp may be read-only)
    TMPDIR: path.join(ctx.laneDir, "tmp"),
    PATH: [path.join(dshPrefix, "bin"), process.env.PATH].filter(Boolean).join(path.delimiter),
  };
}

const dshSetWindow = (ctx, w) => {
  // window truth on plugin lanes = the host's own model config (rides
  // the x-bili-plugin-context-window header); bili.json is ignored there.
  // On the proxy-mode lane the same rewrite keeps the host view consistent
  // with the bili.json window that writeWindow() writes.
  const profile = path.join(ctx.laneDir, "dsh-home", "profiles", "headless");
  const txt = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
  // /g: MODEL_IDS may name several models — every entry carries its own
  // contextWindow and all must move together (multi-model cordis).
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"), txt.replace(/contextWindow: \d+/g, `contextWindow: ${w}`));
};

const dshTurn = async (ctx, prompt, sid, tag) => {
  const args = ["--profile", "headless", "headless"];
  if (sid.v) args.push("--session-id", sid.v);
  args.push("--json", prompt);
  const r = sh("dsh", args, { cwd: ctx.workDir, env: ctx.dshEnv, timeout: ctx.TMO });
  fs.appendFileSync(path.join(ctx.laneDir, "turn-stderr.log"), `\n=== ${tag} exit=${r.status} ===\n${r.stderr}\n`);
  const { sid: s, final } = parseEvents(r.stdout);
  if (s) sid.v = s;
  return { ok: r.status === 0 && !!final, why: r.stderr.slice(-300) || `exit ${r.status}`, out: final };
};

const dshSmallWindow = (ctx, lastP) => {
  // dsh's fixed scaffolding (system prompt + tool defs, ~18k tok on 0.2.x)
  // exceeds the static SMALL_WINDOW minus the output reservation — preflight
  // fail-fasts forever at 24576. Derive from the LIVE t2-end payload instead:
  // deep enough to force a fold, wide enough that the folded session fits.
  const base = Number(process.env.GATE_DSH_SMALL_WINDOW || 0);
  if (base > 0) return base;
  const p = lastP > 0 ? lastP : 30000;
  return Math.min(BIG_WINDOW >> 1, Math.max(SMALL_WINDOW, Math.ceil((p * 0.85 + OUTPUT_TOKENS) / 1024) * 1024));
};

function dshRecipe(api) {
  const baseSuffix = api === "anthropic-messages" ? "" : api === "google-generative-ai" ? "/v1beta" : "/v1";
  return {
    type: "native", pluginAgent: "dsh", wireApi: api,
    // guarantee ≥2 LLM requests per turn so the model-info retry (see
    // BILI_MODEL_INFO_RETRY_MS) gets a second request to stamp the window on
    warmupPrefix: DSH_WARMUP_PREFIX,
    async setup(ctx) {
      await dshProfileSetup(ctx, { api, baseURL: `${ctx.recUrl}${baseSuffix}`, withBili: true });
    },
    setWindow: dshSetWindow,
    turn: dshTurn,
    smallWindow: dshSmallWindow,
  };
}

const RECIPES = {
  dsh: dshRecipe("openai-completions"),
  "dsh-responses": dshRecipe("openai-responses"),
  "dsh-anthropic": dshRecipe("anthropic-messages"),
  "dsh-google": dshRecipe("google-generative-ai"),

  // ---- dsh-proxy: PROXY-mode contrast lane (#3475 owner add-on) ----------
  // Same host, OTHER activation path: the profile does NOT load the
  // billion-context bundle (its fetch intercept would stamp x-bili-plugin and
  // flip the lane back into plugin mode) — dsh drives the chat wire straight
  // into a manually started proxy via the /bili/ URL, codex/claude style.
  // Contrasts the native dsh lane within ONE script: #3177/#3401-style
  // suppression only exists on the plugin path; here nudge/fold must ride the
  // wire in plain proxy mode (acp_summary carrier). Window truth = bili.json
  // (writeWindow), like every other prefix lane.
  "dsh-proxy": {
    type: "prefix", pluginAgent: "dsh", wireApi: "openai-completions",
    warmupPrefix: DSH_WARMUP_PREFIX,
    async setup(ctx) {
      const port = await freePort();
      await dshProfileSetup(ctx, { api: "openai-completions", baseURL: `http://127.0.0.1:${port}/bili/${ctx.recUrl}/v1`, withBili: false });
      ctx.proxyArgs = () => ({ port });
      await startManualProxy(ctx, { port });
    },
    setWindow: dshSetWindow,
    turn: dshTurn,
    smallWindow: dshSmallWindow,
  },

  // ---- pi: native lane, three wires possible — drive openai-chat ---------
  pi: {
    type: "native", pluginAgent: "pi",
    async setup(ctx) {
      const piDir = path.join(ctx.laneDir, "pi-dir");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ packages: [ctx.cand] }, null, 2));
      const modelsFor = (window) =>
        fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({
          providers: {
            gate: {
              baseUrl: `${ctx.recUrl}/v1`, api: "openai-completions", apiKey: "gate-local",
              models: MODEL_IDS.map((id) => ({ id, contextWindow: window, maxTokens: 4096 })),
            },
          },
        }, null, 2));
      modelsFor(BIG_WINDOW);
      ctx.env = { ...ctx.baseEnv, PI_CODING_AGENT_DIR: piDir };
    },
    setWindow(ctx, w) {
      const file = path.join(ctx.laneDir, "pi-dir", "models.json");
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      cfg.providers.gate.models[0].contextWindow = w;
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    },
    async turn(ctx, prompt, sid, tag) {
      const args = ["-p", "--model", `gate/${MODEL_MAIN}`];
      if (sid.v || tag !== "t1") args.push("--continue");
      args.push(prompt);
      const r = sh("pi", args, { cwd: ctx.workDir, env: ctx.env, timeout: ctx.TMO });
      return { ok: r.status === 0 && r.stdout.trim().length > 0, why: r.stderr.slice(-300) || `exit ${r.status}`, out: r.stdout };
    },
  },

  // ---- codex: prefix lane (proxy mode + /bili/ URL), responses wire -----
  codex: {
    type: "prefix", pluginAgent: "codex",
    async setup(ctx) {
      const port = await freePort();
      const codexHome = path.join(ctx.laneDir, "codex-home");
      fs.mkdirSync(codexHome, { recursive: true });
      const tomlFor = (window) =>
        fs.writeFileSync(path.join(codexHome, "config.toml"), [
          `model = "${MODEL_MAIN}"`,
          // container: unprivileged userns is blocked, codex's bwrap sandbox dies on
          // every shell call ("No permissions to create a new namespace") — the lane
          // only reads corpus.md in a disposable container, so run unsandboxed.
          'sandbox_mode = "danger-full-access"',
          'model_provider = "gate"',
          `model_context_window = ${window}`,
          "",
          "[model_providers.gate]",
          'name = "Gate"',
          `base_url = "http://127.0.0.1:${port}/bili/${ctx.recUrl}/v1"`,
          'wire_api = "responses"',
          'env_key = "GATE_UPSTREAM_KEY"',
          "",
        ].join("\n"));
      tomlFor(BIG_WINDOW);
      ctx.env = { ...ctx.baseEnv, CODEX_HOME: codexHome, RUST_LOG: "error" };
      ctx.proxyArgs = () => ({ port });
      await startManualProxy(ctx, { port });
    },
    setWindow(ctx, w) {
      const file = path.join(ctx.laneDir, "codex-home", "config.toml");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^model_context_window = \d+$/m, `model_context_window = ${w}`));
    },
    async turn(ctx, prompt, sid, tag) {
      const out = path.join(ctx.laneDir, `codex-${tag}.txt`);
      const args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--output-last-message", out];
      if (tag !== "t1") args.push("resume", "--last");
      args.push(prompt);
      const r = sh("codex", args, { cwd: ctx.workDir, env: ctx.env, timeout: ctx.TMO });
      const final = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : r.stdout;
      return { ok: r.status === 0 && final.trim().length > 0, why: r.stderr.slice(-300) || `exit ${r.status}`, out: final };
    },
  },

  // ---- opencode v1: native lane, openai-chat -----------------------------
  opencode: {
    type: "native", pluginAgent: "opencode",
    async setup(ctx) {
      const ocCfg = path.join(ctx.laneDir, "xdg/config/opencode");
      fs.mkdirSync(ocCfg, { recursive: true });
      const model = MODEL1.model.split(",")[0];
      const ocFor = (window) =>
        fs.writeFileSync(path.join(ocCfg, "opencode.json"), JSON.stringify({
          provider: {
            gate: {
              npm: "@ai-sdk/openai-compatible", name: "Gate",
              options: { baseURL: `${ctx.recUrl}/v1`, apiKey: "gate-local" },
              models: { [model]: { name: "Gate Model", limit: { context: window, output: 4096 } } },
            },
          },
          plugin: [path.join(ctx.cand, "dist/agent/opencode-native.js")],
          compaction: { auto: false },
        }, null, 2));
      ocFor(BIG_WINDOW);
      ctx.env = { ...ctx.baseEnv, BILLION_CONTEXT_NODE: process.execPath };
    },
    setWindow(ctx, w) {
      const file = path.join(ctx.laneDir, "xdg/config/opencode/opencode.json");
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      cfg.provider.gate.models[MODEL1.model.split(",")[0]].limit.context = w;
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    },
    async turn(ctx, prompt, sid, tag) {
      const model = MODEL1.model.split(",")[0];
      const args = ["run", "-m", `gate/${model}`, "--dangerously-skip-permissions"];
      if (sid.v) args.push("-s", sid.v);
      args.push(prompt);
      const r = sh((process.env.GATE_OC1_BIN || "opencode").trim(), args, { cwd: ctx.workDir, env: ctx.env, timeout: ctx.TMO });
      // v1 CLI does NOT print the session id — capture it from storage:
      // newest ses_*.json under $XDG_DATA_HOME/opencode/storage (message/ &
      // session_diff/ are both keyed by session id; the lane XDG is hermetic).
      if (!sid.v) {
        const stDir = path.join(ctx.laneDir, "xdg/data/opencode/storage");
        const files = fs.existsSync(stDir)
          ? fs.readdirSync(stDir, { recursive: true })
              .filter((f) => /^ses_[A-Za-z0-9_]+\.json$/.test(path.basename(f)))
              .map((f) => ({ f: path.basename(f), m: fs.statSync(path.join(stDir, f)).mtimeMs }))
              .sort((a, b) => b.m - a.m)
          : [];
        if (files[0]) sid.v = files[0].f.replace(/\.json$/, "");
      }
      return { ok: r.status === 0 && r.stdout.trim().length > 0, why: r.stderr.slice(-300) || `exit ${r.status}`, out: r.stdout };
    },
  },

  // ---- opencode2: V2 native lane, Responses-over-WebSocket --------------
  // Mirrors tests/e2e/e2e-opencode-responses-ws.test.ts: shim plugin DIR,
  // providers.openai.settings.transport=websocket, --standalone --auto --format json.
  // Host calibration uses `npx --yes @opencode/cli@2`; the container installs
  // it as `opencode2` (GATE_OC2_BIN="opencode2").
  opencode2: {
    type: "native", pluginAgent: "opencode",
    async setup(ctx) {
      const shim = path.join(ctx.laneDir, "native-plugin");
      fs.mkdirSync(shim, { recursive: true });
      fs.writeFileSync(path.join(shim, "index.js"),
        `export { default } from ${JSON.stringify(pathToFileURL(path.join(ctx.cand, "dist/agent/opencode-native.js")).href)};\n`);
      ctx.ocCfgFile = path.join(ctx.laneDir, "xdg/config/opencode/opencode.json");
      fs.mkdirSync(path.dirname(ctx.ocCfgFile), { recursive: true });
      // some 2.x builds read $XDG_CONFIG_HOME/opencode/opencode.json (CI e2e),
      // the local dev build only honors ./opencode.json in cwd — write BOTH.
      ctx.ocCfgCwd = path.join(ctx.workDir, "opencode.json");
      const ocFor = (w) => {
        const cfg = {
          model: `openai/${MODEL_MAIN}`,
          providers: {
            openai: {
              settings: { apiKey: "gate-local", baseURL: `${ctx.recUrl}/v1`, transport: "http" },
              models: Object.fromEntries(MODEL_IDS.map((id) => [id, { name: "Gate Model", limit: { context: w, output: 4096 } }])),
            },
          },
          plugins: [shim],
          compaction: { auto: false },
        };
        fs.writeFileSync(ctx.ocCfgFile, JSON.stringify(cfg, null, 2));
        fs.writeFileSync(ctx.ocCfgCwd, JSON.stringify(cfg, null, 2));
      };
      ocFor(BIG_WINDOW);
      ctx.env = { ...ctx.baseEnv, ACP_AUTO_UPDATE: "0", BILLION_CONTEXT_NODE: process.execPath };
    },
    setWindow(ctx, w) {
      for (const f of [ctx.ocCfgFile, ctx.ocCfgCwd]) {
        const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
        for (const id of MODEL_IDS) cfg.providers.openai.models[id].limit.context = w;
        fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
      }
    },
    async turn(ctx, prompt, sid, tag) {
      const oc2 = (process.env.GATE_OC2_BIN || "npx --yes @opencode/cli@2").trim().split(/\s+/);
      const args = [...oc2.slice(1), "run", "--standalone", "--auto", "--format", "json", "-m", `openai/${MODEL_MAIN}`];
      if (sid.v) args.push("-s", sid.v);
      args.push(prompt);
      const r = sh(oc2[0], args, { cwd: ctx.workDir, env: ctx.env, timeout: ctx.TMO });
      if (!sid.v) {
        // --format json emits event lines; capture the session id either from
        // the JSON events or the v1-style storage tree (both keyed ses_*).
        const m = /ses_[A-Za-z0-9_]+/.exec(r.stdout + r.stderr);
        if (m) sid.v = m[0];
      }
      return { ok: r.status === 0 && r.stdout.trim().length > 0, why: r.stderr.slice(-300) || `exit ${r.status}`, out: r.stdout };
    },
  },

  // ---- claude: prefix lane, anthropic wire -------------------------------
  claude: {
    type: "prefix", pluginAgent: "claude",
    async setup(ctx) {
      const port = await freePort();
      const cfgDir = path.join(ctx.laneDir, "claude-cfg");
      fs.mkdirSync(cfgDir, { recursive: true });
      // plugin install bakes ANTHROPIC_BASE_URL (zone port); we override with
      // our own managed block pointing at THIS lane's manual proxy.
      fs.writeFileSync(path.join(cfgDir, "settings.json"), JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/bili/${ctx.recUrl}`,
          ANTHROPIC_API_KEY: "gate-local",
          ANTHROPIC_AUTH_TOKEN: "gate-local",
          DISABLE_AUTO_COMPACT: "1",
        },
      }, null, 2));
      ctx.env = { ...ctx.baseEnv, CLAUDE_CONFIG_DIR: cfgDir, BILI_CLAUDE_NATIVE_PORT: String(port) };
      ctx.proxyArgs = () => ({ port });
      await startManualProxy(ctx, { port });
    },
    async turn(ctx, prompt, sid, tag) {
      const args = ["-p"];
      if (tag !== "t1") args.push("--continue");
      args.push(prompt);
      const r = sh("claude", args, { cwd: ctx.workDir, env: ctx.env, timeout: ctx.TMO });
      return { ok: r.status === 0 && r.stdout.trim().length > 0, why: r.stderr.slice(-300) || `exit ${r.status}`, out: r.stdout };
    },
    // claude-code's unfoldable floor sits near SMALL_WINDOW — a fixed 24576
    // lands knife-edge (sometimes fits after fold, sometimes 502 fail-fast,
    // the real #2847 shape). Derive the small window from the LIVE t2-end
    // payload instead: force a ~12% fold that the session can actually pay.
    smallWindow: (ctx, lastP) => {
      const p = lastP > 0 ? lastP : 28000;
      return Math.min(32768, Math.max(16384, Math.ceil((p * 0.88) / 1024) * 1024));
    },
    // Small-window preflight compression on claude runs a multi-stage
    // distillation marathon (observed 297s of local preflight work for a
    // 170KiB history — the #3452 first-sight marathon shape); the shared
    // 300s turn budget SIGTERMs the CLI mid-preflight (t3/t4 exit 143,
    // turn artifacts empty, 'summarization aborted: client disconnected').
    // 600s keeps the lane asserting the fold path itself instead of racing
    // the summarizer.
    turnTimeoutMs: () => 600_000,
  },
};

// ---------------------------------------------------------------------------
async function main() {
  if (process.env.GATE_SKIP && process.env.GATE_SKIP.split(",").map((s) => s.trim()).includes("p")) {
    console.log("plugin-lanes: skipped (GATE_SKIP=p)");
    process.exit(0);
  }
  for (const agent of AGENTS) {
    const recipe = RECIPES[agent];
    if (!recipe) { record(agent, "recipe", false, "unknown agent"); continue; }
    console.log(`\n===== plugin lane: ${agent} (${recipe.type}) =====`);
    try { await runLane(agent, recipe); } catch (e) { record(agent, "lane", false, String(e).slice(0, 400)); }
  }
  // #3475: env-blocked lanes (upstream lacks the protocol door) keep their
  // degraded verdict — FAIL records from turn-dependent assertions are honest
  // output but excluded from the gate tally, mirroring the opencode2/#3461 rule.
  // Blocked lanes drop turn-dependent records from the tally: env-blocked
  // lanes keep their observable hard assertions (traffic, wire shape, tools,
  // claim), client-blocked lanes ran nothing so the whole lane drops out.
  const isTurnDependent = (name) => /completes|marker answered|self-calibrated|recalled|nudge reached|fold fired|model invoked/.test(name);
  const counted = results.filter((r) => {
    const b = BLOCKED.get(r.lane);
    if (!b) return true;
    return b.kind === "env" ? !isTurnDependent(r.name) : false;
  });
  const failed = counted.filter((r) => !r.ok);
  for (const [lane, b] of BLOCKED) console.log(`${b.kind.toUpperCase()}-BLOCKED [${lane}] ${b.reason}`);
  console.log(`\nplugin-lanes: ${counted.length - failed.length}/${counted.length} passed${BLOCKED.size ? ` (${[...BLOCKED.keys()].map((l) => `${l}:${BLOCKED.get(l).kind}`).join(", ")})` : ""}`);
  process.exit(failed.length ? 1 : 0);
}
main();
