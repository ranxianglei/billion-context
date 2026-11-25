#!/usr/bin/env node
// wire-lanes.mjs — Lane W: MID-SESSION WIRE SWITCH against the REAL model.
//
// The egress plane was built on a single-model single-wire assumption and the
// gate had ZERO coverage for a session that changes its wire lane mid-life
// (discussion #7439; symptom issues #6781 43MB unfolded resend, #7102
// permanent 422, #6957 window-fuse refusal, #4920 fold-coverage mismatch).
// This lane drives the installed candidate exactly the way a switching host
// does — a synthetic opencode-style client speaking the wire dialects
// directly (plugin mode: x-bili-plugin stamped, wire-aligned biliMsgIds,
// per-request context window) — and switches the wire MID-SESSION on the
// same conversation, over a REAL model:
//
//   t1  @ chat wire, big window : corpus with 12 GATE-MARK-Sxx markers,
//                                 must echo them (context established)
//   t2  @ chat wire, small window: fold pressure — the session must stay
//                                 servable under its own fold (no 500/422)
//   t3  SWITCH to anthropic wire (/v1/messages), small window: the marker
//                                 question is asked AGAIN — recall proves
//                                 the stored history survived the switch on
//                                 real bytes (cross-lane rendering + flow
//                                 replay), not just a fake upstream
//   t4  SWITCH to responses wire (/v1/responses): same recall contract a
//                                 second time (repeated switch = switch #2)
//
// Hard assertions on every turn: 200 (never 500/unreadable, never 422),
// the upstream recorder saw the target wire's POST (wire shape, not bili's
// log — #3401's lesson: the wire cannot be fooled), no "pin rejected" /
// "unreadable" line in bili.log, and the [lane-switch] line fired with the
// correct from->to pair.
//
// Env-blocked rule (same as the dsh wire variants / opencode2, #3461): if
// the upstream lacks the door for a target wire (404/405, or a
// mapping-400 with no completed turn), THAT switch degrades to env-blocked
// — traffic + wire shape up to the switch and the earlier assertions stay
// hard, the missing door is recorded as evidence instead of a red.
//
// The egress plane rides GATE_SNAPBASE exactly like the P/R lanes
// (rollout.features.egressPlane=true in the lane's bili.json): on = the new
// cross-lane coverage, off = the pre-switch legacy baseline (C3-C6 are all
// plane-gated no-ops on that path, so the lane doubles as a legacy-switch
// regression check).
//
// Env: TGZ, WORKDIR, MODEL1_BASE_URL, MODEL1_MODEL, MODEL1_API_KEY,
//      GATE_SKIP=w, GATE_SNAPBASE, GATE_TURN_TIMEOUT_MS (default 300000),
//      GATE_W_CORPUS_TOKENS (default 10000), GATE_W_SMALL_WINDOW (default
//      12000 — under 0.8× the corpus size so the fold fires), GATE_W_BIG_WINDOW.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const log = (...a) => process.stdout.write(a.join(" ") + "\n");
const env = (k, d) => (process.env[k]?.length ? String(process.env[k]) : d);

const WORK = env("WORKDIR", process.cwd());
const LANE_DIR = path.join(WORK, "wire-lanes");
const TGZ = env("TGZ", "");
const MODEL = env("MODEL1_MODEL", "gate-model");
const MODEL_BASE = env("MODEL1_BASE_URL", "");
const MODEL_KEY = env("MODEL1_API_KEY", "gate-local");
const TMO = Number(env("GATE_TURN_TIMEOUT_MS", "300000"));
const CORPUS_TOKENS = Number(env("GATE_W_CORPUS_TOKENS", "10000"));
const BIG_WINDOW = Number(env("GATE_W_BIG_WINDOW", "262144"));
const SMALL_WINDOW = Number(env("GATE_W_SMALL_WINDOW", "12000"));
const SESSION_ID = "gate-w-sess";

const snapOn = (() => {
  const s = env("GATE_SNAPBASE", "").toLowerCase();
  return !!s && s !== "0" && s !== "off";
})();
const rolloutCfg = snapOn ? { rollout: { features: { egressPlane: true } } } : {};
// Hermetic driver (tests/wire-lane-e2e.test.ts): GATE_WIRE_CAND_DIR points at
// an already-built candidate, skipping the npm install of a packed tarball.
const CAND_DIR = env("GATE_WIRE_CAND_DIR", "");

if (!CAND_DIR && (!TGZ || !fs.existsSync(TGZ) || !MODEL_BASE)) {
  console.error("wire-lanes: TGZ and MODEL1_BASE_URL are required (or GATE_WIRE_CAND_DIR)");
  process.exit(2);
}
if (env("GATE_SKIP", "").toLowerCase().split(",").filter(Boolean).includes("w")) {
  log("wire-lanes: SKIPPED (GATE_SKIP=w)");
  process.exit(0);
}

fs.rmSync(LANE_DIR, { recursive: true, force: true });
for (const d of ["home", "xdg/config", "xdg/state", "xdg/cache", "xdg/data", "work"]) {
  fs.mkdirSync(path.join(LANE_DIR, d), { recursive: true });
}
const xdgConfig = path.join(LANE_DIR, "xdg/config");
const xdgState = path.join(LANE_DIR, "xdg/state");
const biliLog = path.join(xdgState, "billion-context", "bili.log");
const readLog = () => { try { return fs.readFileSync(biliLog, "utf8"); } catch { return ""; } };

const results = [];
const record = (name, pass, evidence = "") => {
  results.push({ name, pass });
  log(`  ${pass ? "✅" : "❌"} [W] ${name}${evidence ? ` — ${evidence}` : ""}`);
};

function must(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 300_000, cwd: opts.cwd, env: opts.env });
  if (r.status !== 0) {
    console.error(`wire-lanes: ${cmd} ${args.join(" ")} failed (exit ${r.status})\n${(r.stderr || "").slice(-1500)}`);
    process.exit(2);
  }
  return r.stdout || "";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

function cleanEnv(extra = {}) {
  const envp = { PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "dumb", ...extra };
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(BILI|BILLION_CONTEXT|ACP_|OPENCODE|OPENAI|ANTHROPIC|NODE_TEST_CONTEXT|DSH_|PI_|CODEX|CLAUDE)/.test(k)) continue;
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(k)) continue;
    if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(k)) continue;
    envp[k] = v;
  }
  envp.NO_PROXY = "127.0.0.1,localhost";
  envp.no_proxy = "127.0.0.1,localhost";
  return envp;
}

// ---- corpus: 12 markers at ~equal spacing ------------------------------------
const MARKERS = Array.from({ length: 12 }, (_, i) => `GATE-MARK-S${String(i + 1).padStart(2, "0")}`);
function buildCorpus(tokens) {
  const charsPerToken = 4;
  const target = tokens * charsPerToken;
  const per = Math.floor(target / MARKERS.length);
  const filler = `The relay ledger keeps every turn in append-only order so a late reader can rebuild the exact state the model saw. `.repeat(Math.ceil(per / 100));
  const chunks = MARKERS.map((m, i) => {
    const body = (filler.slice(0, per)).trim();
    return `Section ${i + 1} (${m}). ${body} The marker ${m} closes this section.`;
  });
  return chunks.join("\n\n");
}

// Anti-fake gate assertion: how many of the 12 markers appear in the REQUEST
// BODY the upstream recorder captured for a given path — the body is the op
// log's render; a client re-sent prompt can fake the model's echo but not
// this line.
function bodyMarkerCount(lines, pathPart) {
  let best = 0;
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (!(e.path ?? e.url ?? "").includes(pathPart)) continue;
      const s = typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? "");
      best = Math.max(best, MARKERS.filter((m) => s.includes(m)).length);
    } catch { /* non-JSON line — skip */ }
  }
  return best;
}

// ---- wire bodies: the driver's own transcript, stable per-element ids --------
// Each transcript element is one WIRE element (not one core message) — the
// ids are wire-aligned exactly as the post-#7684 hosts stamp them.
const transcript = []; // { id, text, role: "user" | "assistant" }
let idSeq = 0;
const nid = () => `gate-w-${String(++idSeq).padStart(4, "0")}`;

function buildChat(text) {
  const newId = nid();
  const msgs = [...transcript.map((t) => ({ role: t.role, content: t.text })), { role: "user", content: text }];
  return { body: { model: MODEL, stream: false, max_tokens: 1024, messages: msgs, biliMsgIds: [...transcript.map((t) => t.id), newId] }, newId };
}
function buildAnthropic(text) {
  const newId = nid();
  // DIRECT /v1/messages wire elements ({role, content:[...]}) — the wrapped
  // {type, message} shape is the RESPONSES-API item format and makes the
  // anthropic parser throw ("blocks is not iterable"), which silently
  // degraded the lane to a raw passthrough (same vacuous-pass trap as C7).
  const msgs = [...transcript, { id: newId, text, role: "user" }].map((t) => ({
    role: t.role,
    content: [{ type: "text", text: t.text }],
  }));
  return { body: { model: MODEL, stream: false, max_tokens: 1024, messages: msgs, biliMsgIds: [...transcript.map((t) => t.id), newId] }, newId };
}
function buildResponses(text) {
  const newId = nid();
  const input = [...transcript.map((t) => ({ role: t.role, content: t.text })), { role: "user", content: text }];
  return { body: { model: MODEL, stream: false, max_output_tokens: 1024, input, biliMsgIds: [...transcript.map((t) => t.id), newId] }, newId };
}

function extractAssistant(resJson, wire) {
  try {
    const j = JSON.parse(resJson);
    if (wire === "chat") return String(j.choices?.[0]?.message?.content ?? "").trim();
    if (wire === "anthropic") return (j.content ?? []).filter((b) => b?.type === "text").map((b) => b.text ?? "").join(" ").trim();
    if (wire === "responses") {
      const parts = [];
      for (const o of j.output ?? []) for (const c of o.content ?? []) if (c?.type === "output_text") parts.push(c.text ?? "");
      return parts.join(" ").trim();
    }
  } catch {}
  return "";
}

const DOOR_MISSING = (status, body) =>
  status === 404 || status === 405 || (status === 400 && /map|unsupported|not supported|invalid model/i.test(body.slice(0, 400)));

async function main() {
  log(`-- lane W: mid-session wire switch (plane ${snapOn ? "ON" : "OFF"})`);

  // candidate install (or the hermetic prebuilt dir)
  let cand;
  if (CAND_DIR) {
    cand = CAND_DIR;
  } else {
    const prefix = path.join(LANE_DIR, "npm-prefix");
    must("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", TGZ]);
    cand = path.join(prefix, "node_modules", "billion-context");
  }
  const candPkg = JSON.parse(fs.readFileSync(path.join(cand, "package.json"), "utf8"));
  log(`  candidate ${candPkg.version}`);

  // recorder: bili → recorder → real model (wire truth)
  const recPort = await freePort();
  const recUrl = `http://127.0.0.1:${recPort}`;
  const recOut = path.join(LANE_DIR, "upstream.jsonl");
  const rec = spawn("node", [path.join(HERE, "upstream-recorder.mjs")], {
    env: { ...process.env, RECORDER_PORT: String(recPort), RECORDER_TARGET: MODEL_BASE, RECORDER_OUT: recOut },
    stdio: ["ignore", "ignore", fs.openSync(path.join(LANE_DIR, "recorder.stderr.log"), "a")],
    detached: true,
  });
  await new Promise((r) => setTimeout(r, 300));

  // bili config: window per model id + the plane switch (snapBase parity)
  const biliJson = path.join(xdgConfig, "billion-context", "billion-context.json");
  fs.mkdirSync(path.dirname(biliJson), { recursive: true });
  fs.writeFileSync(biliJson, JSON.stringify({
    providers: { [recUrl]: { models: { [MODEL]: { context: BIG_WINDOW, output: 4096 } } } },
    compress: { preserveRecentTokens: 0 },
    ...rolloutCfg,
  }, null, 2));

  // proxy (manual spawn, prefix-lane pattern)
  const proxyPort = await freePort();
  const proxy = spawn("node", [path.join(cand, "dist", "index.js"), "start", "--host", "127.0.0.1", "--port", String(proxyPort), "--no-auto-update"], {
    env: cleanEnv({
      HOME: path.join(LANE_DIR, "home"),
      XDG_CONFIG_HOME: xdgConfig,
      XDG_STATE_HOME: xdgState,
      XDG_CACHE_HOME: path.join(LANE_DIR, "xdg/cache"),
      XDG_DATA_HOME: path.join(LANE_DIR, "xdg/data"),
      GATE_UPSTREAM_KEY: MODEL_KEY,
      E2E_UPSTREAM_KEY: MODEL_KEY,
      BILI_ZONE_PORT: String(19400),
    }),
    stdio: ["ignore", "ignore", fs.openSync(path.join(LANE_DIR, "proxy.stderr.log"), "a")],
  });
  const base = `http://127.0.0.1:${proxyPort}`;
  await waitForUrl(`${base}/healthz`, 30_000);

  const turn = async (wire, buildFn, window) => {
    const built = buildFn();
    const url = `${base}${wire === "anthropic" ? "/v1/messages" : wire === "responses" ? "/v1/responses" : "/v1/chat/completions"}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bili-plugin": "opencode",
        "x-bili-plugin-conversation": SESSION_ID,
        "x-acp-session": SESSION_ID,
        "x-bili-plugin-context-window": String(window),
      },
      body: JSON.stringify(built.body),
      signal: AbortSignal.timeout(TMO),
    });
    const body = await resp.text();
    if (resp.status === 200) {
      const out = extractAssistant(body, wire);
      transcript.push({ id: built.newId, role: "assistant", text: out.slice(0, 2000) });
      return { status: resp.status, body, out };
    }
    return { status: resp.status, body, out: "" };
  };

  try {
    // Anti-vacuous guard: if a turn's wire shape was wrong, the kernel catch
    // forwards the client bytes unchanged and bili.log says so — a 200 alone
    // proves nothing then (the C7 vacuous-green trap).
    const noKernelBypass = (label, sinceLogLen) =>
    record(`${label} no kernel-transform bypass in bili.log`, !/kernel transform failed/.test(readLog().slice(sinceLogLen)), readLog().slice(sinceLogLen).match(/kernel transform failed[^\n(]*\(/)?.[0]?.slice(0, 120) ?? "");

    const corpus = buildCorpus(CORPUS_TOKENS);
    const t1q = `A long document follows. Which GATE-MARK-Sxx markers does it contain? List every marker you find, nothing else.\n\n${corpus}`;

    // ---- t1: chat wire, big window — establish the context ---------------
    const t1 = await turn("chat", (t) => buildChat(t), BIG_WINDOW);
    t1.q = t1q;
    record("t1 chat-wire turn completes", t1.status === 200, `status ${t1.status} ${t1.body.slice(0, 120)}`);
    noKernelBypass("t1", 0);
    const t1marks = MARKERS.filter((m) => t1.out.includes(m));
    record("t1 echoes >= 8 of 12 markers", t1marks.length >= 8, `saw ${t1marks.length}: ${t1marks.slice(0, 4).join(",")}${t1marks.length > 4 ? "…" : ""}`);
    if (t1.status !== 200 || t1marks.length < 8) { log("lane W aborted after t1"); finish(); return; }

    // ---- t2: chat wire, SMALL window — fold pressure ----------------------
    const t2 = await turn("chat", () => buildChat("Recap: how many markers were in the document? Answer with the count and the word DONE."), SMALL_WINDOW);
    record("t2 fold-pressure turn completes (no 500/422)", t2.status === 200, `status ${t2.status} ${t2.body.slice(0, 160)}`);
    noKernelBypass("t2", 0);
    if (t2.status !== 200) { finish(); return; }

    const logBefore3 = readLog();
    const recBefore3 = fs.existsSync(recOut) ? fs.readFileSync(recOut, "utf8").split("\n").length : 0;

    // ---- t3: SWITCH to anthropic wire, same session, small window --------
    const q3 = "Earlier in this conversation you listed the GATE-MARK markers from my document. Name at least three of them exactly as I wrote them.";
    const t3 = await turn("anthropic", () => buildAnthropic(q3), SMALL_WINDOW);
    record("t3 wire switch to /v1/messages completes (no 500/422)", t3.status === 200, `status ${t3.status} ${t3.body.slice(0, 160)}`);
    if (t3.status !== 200 && DOOR_MISSING(t3.status, t3.body)) {
      record("t3 ENV-BLOCKED: upstream has no /v1/messages door", true, `status ${t3.status} ${t3.body.slice(0, 120)}`);
      log("lane W: responses door check skipped (anthropic door already absent)");
      finish(); return;
    }
    if (t3.status !== 200) { finish(); return; }
    const rec3 = fs.existsSync(recOut) ? fs.readFileSync(recOut, "utf8").split("\n").slice(recBefore3) : [];
    const sawAnthropic = rec3.some((l) => { try { const e = JSON.parse(l); return (e.path ?? e.url ?? "").includes("/v1/messages"); } catch { return false; } });
    record("t3 upstream recorder saw the /v1/messages POST (wire truth)", sawAnthropic, `${rec3.length} new upstream line(s)`);
    // Anti-fake: a model can echo markers from a CLIENT re-sent prompt even
    // though the server history is empty. The recorded REQUEST BODY is the
    // op log's own render — the markers must be in it.
    const t3bodyMarkers = bodyMarkerCount(rec3, "/v1/messages");
    record("t3 markers present in the /v1/messages REQUEST BODY (op-log-served, not client re-sent)", t3bodyMarkers >= 3, `saw ${t3bodyMarkers} of 12 in the recorded body`);
    record("t3 markers recalled THROUGH the switch", MARKERS.filter((m) => t3.out.includes(m)).length >= 3, `"${t3.out.slice(0, 160)}"`);
    const log3 = readLog();
    record("t3 [lane-switch] line fired (openai -> anthropic)", /\[lane-switch\][^\n]*openai\s*->\s*anthropic/.test(log3.slice(logBefore3.length)), log3.slice(logBefore3.length).match(/\[lane-switch\][^\n]*/)?.[0]?.slice(0, 160) ?? "no lane-switch line");
    record("t3 no pin rejection / unreadable", !/pin rejected|unreadable/.test(log3), "");
    noKernelBypass("t3", logBefore3.length);

    // ---- t4: SWITCH to responses wire (switch #2) -------------------------
    const recBefore4 = fs.existsSync(recOut) ? fs.readFileSync(recOut, "utf8").split("\n").length : 0;
    const logBefore4 = readLog();
    const t4 = await turn("responses", () => buildResponses(q3), SMALL_WINDOW);
    record("t4 wire switch to /v1/responses completes (no 500/422)", t4.status === 200, `status ${t4.status} ${t4.body.slice(0, 160)}`);
    if (t4.status !== 200 && DOOR_MISSING(t4.status, t4.body)) {
      record("t4 ENV-BLOCKED: upstream has no /v1/responses door", true, `status ${t4.status} ${t4.body.slice(0, 120)}`);
      finish(); return;
    }
    if (t4.status !== 200) { finish(); return; }
    const rec4 = fs.existsSync(recOut) ? fs.readFileSync(recOut, "utf8").split("\n").slice(recBefore4) : [];
    const sawResponses = rec4.some((l) => { try { const e = JSON.parse(l); return (e.path ?? e.url ?? "").includes("/v1/responses"); } catch { return false; } });
    record("t4 upstream recorder saw the /v1/responses POST (wire truth)", sawResponses, `${rec4.length} new upstream line(s)`);
    const t4bodyMarkers = bodyMarkerCount(rec4, "/v1/responses");
    record("t4 markers present in the /v1/responses REQUEST BODY (op-log-served, not client re-sent)", t4bodyMarkers >= 3, `saw ${t4bodyMarkers} of 12 in the recorded body`);
    record("t4 markers recalled through the second switch", MARKERS.filter((m) => t4.out.includes(m)).length >= 3, `"${t4.out.slice(0, 160)}"`);
    const log4 = readLog();
    record("t4 [lane-switch] line fired (anthropic -> responses, switch #2)", /\[lane-switch\][^\n]*anthropic\s*->\s*responses/.test(log4.slice(logBefore4.length)), log4.slice(logBefore4.length).match(/\[lane-switch\][^\n]*/)?.[0]?.slice(0, 160) ?? "no lane-switch line");
    record("t4 no pin rejection / unreadable", !/pin rejected|unreadable/.test(log4), "");
    noKernelBypass("t4", logBefore4.length);

    finish();
  } finally {
    try { process.kill(-proxy.pid, "SIGKILL"); } catch {}
    try { process.kill(-rec.pid, "SIGKILL"); } catch {}
  }

  function finish() {
    const failed = results.filter((r) => !r.pass);
    log(`\n== lane W summary: ${results.length - failed.length}/${results.length} green (plane ${snapOn ? "ON" : "OFF"}) ==`);
    process.exit(failed.length ? 1 : 0);
  }
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`proxy never came up: ${url}`);
}

main().catch((e) => {
  console.error(`wire-lanes: fatal: ${e?.stack || e}`);
  process.exit(1);
});
