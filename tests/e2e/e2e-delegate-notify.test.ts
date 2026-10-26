// E2E: acp_delegate completion-notification DELIVERY TIMING (#2320) through the
// REAL pi RPC lane and bili's embedded pi-subagents wiring (vendored in-repo,
// #2384). Deterministic fake chat upstream scripts the model; zero tokens.
//
// What this discriminates, from the per-request oracle (FAKE_REQLOG JSONL):
//   FIXED    => the notification user message appears as the FRESH last user
//               message of a request whose directive queue still had work left
//               (queueIdx < N) — consumed mid-task at the next safe boundary —
//               and the run continues afterwards with further tool rounds.
//   BUGGY    => the notification only ever appears after the queue is exhausted
//               (queueIdx == N): parked in the host follow-up queue until the
//               whole main task ends (the #2320 defect).
// Under the boundary-commit design (busy tier sends ONE steering message at
// the next `turn_end`, right before the loop drains it into the next LLM call;
// idle tier sends ONE steering message when settled) the notification is always
// a PERSISTED user message (#2546): it parks in the host steering queue only
// transiently (commit -> drain, one macrotask apart) and then lives in the
// session forever. The sampler therefore asserts pendingMessageCount never
// stacks above 1 while busy (stacking = double-queued notifications), and the
// oracle asserts the notification PERSISTS: once delivered, every later
// request of the conversation still carries it (notifCount >= 1) — the old
// request-local `context` append vanished after exactly one request, which is
// what dropped stateful upstream sessions off their cache.
// Scenario B proves the no-further-input property: after the scripted prompt is
// fully consumed, a late completion must still reach the model — either by
// committing at the initial run's final turn_end or by steer auto-starting a
// new turn from idle.
//
// Gated by ACP_TEST_E2E_NATIVE=1 (same gate as e2e-native-pi.test.ts; needs
// `npm run build` first — the pi package loads dist/agent/pi-native.js, which
// inlines the vendored pi-subagents source). Skips when the pi CLI is absent.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertPortDead } from "../port-race.js";

const PI_BIN = process.env.E2E_PI_BIN ?? "pi";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const PI_NATIVE_ENTRY = path.join(REPO_ROOT, "dist/agent/pi-native.js");
const FAKE_UPSTREAM = path.join(import.meta.dirname, "fake-upstream-chat.mjs");
const TMO_MS = Number(process.env.E2E_TMO ?? 180_000);
const QUIET_MS = 12_000; // sustained quiescence before declaring the scenario done
const SAMPLE_MS = 400;
const WORK_ROOT = path.join(process.cwd(), "tmp");
fs.mkdirSync(WORK_ROOT, { recursive: true });
// pi walks up from its cwd for AGENTS.md too (#815): stay outside the repo.
const CWD_ROOT = path.join(os.tmpdir(), "billion-context-e2e-delegate");
fs.mkdirSync(CWD_ROOT, { recursive: true });

function piAvailable(): boolean {
  try {
    return spawnSync(PI_BIN, ["--version"], { timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
}

/** Resolve the pi CLI entry for delegate CHILD processes. The global install
 *  ships under an aliased package dir (pi-stable), so the in-package global
 *  probes can miss it; derive the entry from the binary itself (symlinks
 *  resolve to dist/cli.js) and hand it over via PI_CLI_PATH, which the
 *  resolver honors first. Returns undefined when undeterminable — the package
 *  then falls back to its own probing. */
function findPiCliEntry(bin: string): string | undefined {
  const candidates: string[] = [];
  try {
    const w = spawnSync("sh", ["-c", `command -v ${JSON.stringify(bin)}`], { timeout: 5_000 });
    const abs = w.stdout.toString().trim();
    if (w.status === 0 && abs) candidates.push(abs);
  } catch {}
  candidates.push(bin);
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c);
      if (/[/\\]dist[/\\]cli\.js$/.test(real)) return real;
    } catch {}
  }
  return undefined;
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("BILI") || key.startsWith("BILLION_CONTEXT") || key.startsWith("ACP_")) delete env[key];
  }
  for (const key of ["NODE_EXTRA_CA_CERTS", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "NODE_OPTIONS", "NODE_TEST_CONTEXT"]) delete env[key];
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr !== "string") srv.close(() => resolve(addr.port));
      else reject(new Error("freePort: no address"));
    });
    srv.on("error", reject);
  });
}

function waitForHttp(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`waitForHttp timeout: ${url}`));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Ctx {
  work: string;
  piCwd: string;
  piAgentDir: string;
  xdg: { config: string; cache: string; state: string; data: string };
  reqLog: string;
}

function makeCtx(work: string): Ctx {
  const ctx: Ctx = {
    work,
    piCwd: fs.mkdtempSync(path.join(CWD_ROOT, "cwd-")),
    piAgentDir: path.join(work, "pi-agent"),
    xdg: {
      config: path.join(work, "xdg-config"),
      cache: path.join(work, "xdg-cache"),
      state: path.join(work, "xdg-state"),
      data: path.join(work, "xdg-data"),
    },
    reqLog: path.join(work, "fake-chat-requests.jsonl"),
  };
  for (const d of [ctx.piAgentDir, ctx.piCwd, ctx.xdg.config, ctx.xdg.cache, ctx.xdg.state, ctx.xdg.data]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return ctx;
}

function writeHostConfig(ctx: Ctx, fakePort: number): void {
  fs.writeFileSync(path.join(ctx.piAgentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }, null, 2));
  fs.writeFileSync(path.join(ctx.piAgentDir, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${fakePort}/v1`,
        api: "openai-completions",
        apiKey: "e2e-fake-key",
        models: [{ id: "fake-model", name: "Fake", input: ["text"], contextWindow: 60000, maxTokens: 4096 }],
      },
    },
  }, null, 2));
}

class RpcClient {
  proc: ReturnType<typeof spawn>;
  buf = "";
  responses = new Map<string, any>();
  events: any[] = [];
  states: Array<{ t: number; isStreaming?: boolean; pendingMessageCount?: number }> = [];
  _idn = 0;
  stderr = "";

  constructor(cwd: string, env: NodeJS.ProcessEnv) {
    this.proc = spawn(PI_BIN, ["--mode", "rpc", "--model", "fake/fake-model"], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"],
    });
    if (!this.proc.stdout || !this.proc.stderr) throw new Error("rpc stdio unavailable");
    this.proc.stdout.on("data", (c: Buffer) => {
      this.buf += c.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { this.events.push({ raw: line.slice(0, 300) }); continue; }
        if (obj.type === "response" && obj.id != null && !this.responses.has(obj.id)) {
          this.responses.set(obj.id, obj);
          if (obj.command === "get_state" && obj.success) {
            this.states.push({ t: Date.now(), ...obj.data });
          }
        } else {
          this.events.push(obj);
        }
      }
    });
    this.proc.stderr.on("data", (c: Buffer) => { this.stderr += c.toString(); });
  }

  send(cmd: Record<string, unknown>): string {
    const id = `cmd_${++this._idn}`;
    if (!this.proc.stdin) throw new Error("rpc stdin unavailable");
    this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
    return id;
  }

  async waitResponse(id: string, ms: number): Promise<any> {
    const deadline = Date.now() + ms;
    while (!this.responses.has(id)) {
      if (Date.now() > deadline) throw new Error(`rpc response timeout: ${id}`);
      await sleep(50);
    }
    return this.responses.get(id);
  }

  kill(): void {
    try { this.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch {} }, 2000).unref?.();
  }
}

// Oracle heads carry ACP tag spans; strip them before content matching.
const stripAcps = (str: unknown) => String(str ?? "").replace(/\x3cacp\b[^>]*\x3e[\s\S]*?\x3c\/acp\x3e/g, "").trimStart();

function readOracle(file: string): any[] {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function killBiliInstances(ctx: Ctx): void {
  const instancesDir = path.join(ctx.xdg.state, "billion-context", "instances");
  try {
    for (const f of fs.readdirSync(instancesDir)) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(instancesDir, f), "utf8"));
        if (typeof rec.pid === "number") { try { process.kill(rec.pid, "SIGKILL"); } catch {} }
      } catch {}
    }
  } catch {}
}

async function runScenario(name: string, prompt: string, totalDirectives: number): Promise<void> {
  const work = fs.mkdtempSync(path.join(WORK_ROOT, `e2e-delegate-notify-${name}-`));
  const ctx = makeCtx(work);
  const fakePort = await freePort();
  const fake = spawn(process.execPath, [FAKE_UPSTREAM], {
    env: { ...process.env, FAKE_PORT: String(fakePort), FAKE_HOST: "127.0.0.1", FAKE_REQLOG: ctx.reqLog },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail?: unknown): void => {
    if (!ok) failures.push(`${label}${detail != null ? ` — ${String(detail).slice(0, 400)}` : ""}`);
  };
  let pi: RpcClient | null = null;
  try {
    await waitForHttp(`http://127.0.0.1:${fakePort}/v1/models`, 15_000);
    writeHostConfig(ctx, fakePort);
    const cliEntry = findPiCliEntry(PI_BIN);
    const env = cleanEnv({
      PI_CODING_AGENT_DIR: ctx.piAgentDir,
      XDG_CONFIG_HOME: ctx.xdg.config,
      XDG_CACHE_HOME: ctx.xdg.cache,
      XDG_STATE_HOME: ctx.xdg.state,
      XDG_DATA_HOME: ctx.xdg.data,
      ...(cliEntry ? { PI_CLI_PATH: cliEntry } : {}),
    });
    pi = new RpcClient(ctx.piCwd, env);
    const pid = pi.send({ type: "prompt", message: prompt });
    let samplerAlive = true;
    const sampler = setInterval(() => {
      if (!samplerAlive) return;
      try { pi!.send({ type: "get_state" }); } catch {}
    }, SAMPLE_MS);
    // Quiescence: isStreaming false && pendingMessageCount 0 sustained QUIET_MS.
    let lastActiveT = Date.now();
    const deadline = Date.now() + TMO_MS;
    let sawTimeout = false;
    while (Date.now() < deadline) {
      await sleep(SAMPLE_MS);
      const st = pi.states.at(-1);
      if (st?.isStreaming) lastActiveT = Date.now();
      if (st && (st.pendingMessageCount ?? 0) > 0) lastActiveT = Date.now();
      if (pi.states.length > 3 && Date.now() - lastActiveT >= QUIET_MS) break;
      if (pi.proc.exitCode !== null) break;
    }
    if (Date.now() >= deadline) sawTimeout = true;
    samplerAlive = false;
    clearInterval(sampler);
    await pi.waitResponse(pid, 5_000).catch(() => null);
    const promptResp = pi.responses.get(pid);
    check("prompt command accepted", promptResp?.success === true, JSON.stringify(promptResp ?? {}).slice(0, 200));
    check("no hard timeout", !sawTimeout, `elapsed=${Math.round((Date.now() - (lastActiveT - QUIET_MS)) / 1000)}s`);
    pi.kill();
    await sleep(800);
    try { fake.kill("SIGKILL"); } catch {}
    await sleep(200);

    fs.writeFileSync(path.join(work, "events.jsonl"), pi.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.writeFileSync(path.join(work, "states.jsonl"), pi.states.map((s) => JSON.stringify(s)).join("\n") + "\n");
    fs.writeFileSync(path.join(work, "pi.stderr.txt"), pi.stderr);
    try {
      fs.copyFileSync(path.join(ctx.xdg.state, "billion-context", "bili.log"), path.join(work, "bili.log"));
    } catch {}

    const rows = readOracle(ctx.reqLog);
    const delegateRow = rows.find((r) => r.toolName === "acp_delegate");
    check("parent dispatched acp_delegate (scripted)", !!delegateRow, delegateRow ? `conv=${delegateRow.conv}` : "no acp_delegate tool row");
    if (delegateRow) {
      const parentConv = delegateRow.conv;
      const prows = rows.filter((r) => r.conv === parentConv);
      const notifFresh = prows.filter((r) => stripAcps(r.lastUserHead).startsWith("[acp_delegate") && String(r.roles ?? "").endsWith("user"));
      check("exactly one fresh notification delivery", notifFresh.length === 1, `freshDeliveries=${notifFresh.length}, heads=${prows.map((r) => stripAcps(r.lastUserHead).slice(0, 40)).join(" | ")}`);
      const R = notifFresh[0];
      if (R) {
        if (name === "midtask") {
          check(`notification consumed with work remaining (queueIdx < ${totalDirectives})`, R.queueIdx < totalDirectives, `queueIdx=${R.queueIdx}/${totalDirectives}, toolName=${R.toolName}`);
          const laterTool = prows.some((r) => r.t > R.t && r.toolName === "bash");
          const needsLater = R.queueIdx < totalDirectives - 1;
          check("run continued AFTER notification (later bash round)", needsLater ? laterTool : true, needsLater ? `laterBash=${laterTool}` : "notification landed on final directive — continuation n/a");
          const nearStreaming = pi.states.some((s) => s.isStreaming && Math.abs(s.t - R.t) <= 2500);
          check("main task streaming around consumption", nearStreaming, `samplesNear=${JSON.stringify(pi.states.filter((s) => Math.abs(s.t - R.t) <= 2500).map((s) => ({ isStreaming: s.isStreaming, pending: s.pendingMessageCount })))}`);
          // The busy tier commits at turn_end and the loop drains the steering
          // queue into the next LLM call moments later: the notification parks
          // in the queue TRANSIENTLY (that is the mechanism, #2546), so pending
          // may briefly be 1 — but never stack above it (stacking = a second,
          // double-queued notification). Quiescence below requires it back to 0.
          const maxPending = Math.max(0, ...pi.states.map((s) => s.pendingMessageCount ?? 0));
          check("no stacked parking during the task (maxPending <= 1)", maxPending <= 1, `maxPending=${maxPending}`);
        } else {
          // Two valid delivery shapes, both proving "no further user input was
          // needed": (a) IDLE tier — host already settled, steer auto-starts a
          // new turn (nothing streaming before arrival); (b) BUSY tier — child
          // finished before the initial run's final response, committed into
          // that run's last model call (streaming still active around arrival).
          const preArrival = pi.states.filter((s) => s.t >= R.t - 2500 && s.t <= R.t - 400);
          const idleAround = preArrival.length > 0 && preArrival.every((s) => !s.isStreaming);
          const busyCommit = preArrival.some((s) => s.isStreaming);
          check("delivered with no further input (idle auto-start or in-run commit)", idleAround || busyCommit, `preArrivalSamples=${JSON.stringify(preArrival.map((s) => ({ isStreaming: s.isStreaming, pending: s.pendingMessageCount })))}`);
        }
        // #2546: the notification is a PERSISTED session message — every later
        // request of this conversation must still carry it (the buggy
        // request-local append disappeared after exactly one request, which is
        // what dropped stateful upstream sessions off their cache).
        const laterRows = prows.filter((r) => r.t > R.t && !r.title);
        const missing = laterRows.filter((r) => !(typeof r.notifCount === "number" && r.notifCount >= 1));
        check("notification persists in every later request (#2546)", missing.length === 0, `later=${laterRows.length}, missing=${missing.map((r) => `q${r.queueIdx}:${r.toolName ?? "txt"}(notif=${r.notifCount ?? "n/a"})`).join(",")}`);
        if (name === "midtask") {
          check("persistence window observed (requests followed the delivery)", laterRows.length > 0, `later=${laterRows.length}`);
        }
      }
      if (name === "idle") {
        check("notification arrived after initial run ended (no re-prompting)", R ? prows.indexOf(R) >= totalDirectives : false, `rowOrder=${prows.map((r) => `q${r.queueIdx}:${r.toolName ?? "txt"}${stripAcps(r.lastUserHead).startsWith("[acp_delegate") ? ":NOTIF" : ""}`).join(",")}`);
      }
    }
    await assertPortDead(fakePort);
  } catch (e) {
    failures.push(`scenario threw: ${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    try { killBiliInstances(ctx); } catch {}
    try { fake.kill("SIGKILL"); } catch {}
    pi?.kill();
  }
  if (failures.length > 0) {
    throw new Error(`scenario "${name}" failed:\n  ${failures.join("\n  ")}\nartifacts: ${work}`);
  }
}

const SLEEP = '请调用bash {"command":"sleep 2"}';
const DELEGATE = '请调用acp_delegate {"agent":"worker","task":"quick probe","async":true}';

// warmup bash + async delegate + 8 x sleep-2 rounds: the completion notice must
// land DURING the sleep rounds (queue not yet exhausted) and the run keeps going.
const PROMPT_MIDTASK = `任务:先热身,然后派发一个异步子任务并继续工作。
${SLEEP};${DELEGATE};${SLEEP};${SLEEP};${SLEEP};${SLEEP};${SLEEP};${SLEEP};${SLEEP};${SLEEP};完成。`;
const TOTAL_MIDTASK = 10;

// warmup bash + async delegate only: the main run ends, the agent goes idle; the
// late completion must still reach the model without any further input.
const PROMPT_IDLE = `任务:热身后派发一个异步子任务,然后结束本轮。
${SLEEP};${DELEGATE};完成。`;
const TOTAL_IDLE = 2;

function scenarioSkip(): string | false {
  if (process.env.ACP_TEST_E2E_NATIVE !== "1") {
    return "set ACP_TEST_E2E_NATIVE=1 (real pi RPC lane + local fake upstream; deterministic, zero tokens)";
  }
  if (!fs.existsSync(PI_NATIVE_ENTRY)) return "dist/agent/pi-native.js missing — run `npm run build` first";
  if (!piAvailable()) return `${PI_BIN} CLI not available`;
  return false;
}

test("delegate completion reaches the model mid-task at the next safe boundary (#2320)", { skip: scenarioSkip(), timeout: TMO_MS + 60_000 }, async () => {
  await runScenario("midtask", PROMPT_MIDTASK, TOTAL_MIDTASK);
});

test("late delegate completion reaches an idle model without further input (#2320)", { skip: scenarioSkip(), timeout: TMO_MS + 60_000 }, async () => {
  await runScenario("idle", PROMPT_IDLE, TOTAL_IDLE);
});
