// E2E: #1702 sub-agent session sidecar on the REAL opencode v2 lane. Sibling
// of e2e-native-opencode.test.ts (#1267/#1239), same hermetic design (per-
// context XDG + HOME + cwd outside the repo, deterministic fake upstream,
// zero tokens/network) but driving the full #1702 lifecycle end-to-end:
//
//   1. a scripted `task` dispatch — opencode's REAL sub-agent tool — spawns a
//      child session whose id rides the machine-written tool-result envelope
//      `<task id="ses_..." state="completed">` back into the parent history;
//   2. after the dispatch pair leaves the protected zone, a scripted compress
//      folds the range covering it — the fold commit captures the child id
//      into the metadata sidecar (src/subagent-sessions.ts) from that
//      envelope;
//   3. the compress receipt names the id ([acp-subagent-sessions bN: ses_..])
//      and rides the plugin-mode carrier (the tool call + result pair) in the
//      agent's re-sent history;
//   4. the persisted session carries sidecar entries; the stored block
//      summary stays byte-clean.
//
// V2 lane only (user request): the plugin entry is always the wrapper
// directory 2.x requires. Binary selection via E2E_OC_BIN; source-run
// checkouts report "opencode vlocal" (unparseable), so this suite gates on
// the env pair, not the version string. Gated by ACP_TEST_E2E_OC_NATIVE=1
// (needs `npm run build` first — the plugin loads dist/agent/opencode-native.js).
//
// Choreography note: refs are only citable where the proxy tagged them, and
// the compress range must stay outside the protected zone (last 5 messages
// after preserveRecentTokens=0). Three push-back runs after the dispatch put
// the run-three user message — the first tagged ref AFTER the dispatch pair —
// safely outside the zone, so [run-one filler .. run-three user] spans the
// whole dispatch pair deterministically.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertPortDead } from "../port-race.js";

const OC_BIN = process.env.E2E_OC_BIN ?? "opencode";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OC_NATIVE_ENTRY = path.join(REPO_ROOT, "dist/agent/opencode-native.js");
const FAKE_UPSTREAM = path.join(import.meta.dirname, "fake-upstream-chat.mjs");
const TMO = Number(process.env.E2E_TMO ?? 240_000);

const WORK_ROOT = path.join(process.cwd(), "tmp");
fs.mkdirSync(WORK_ROOT, { recursive: true });
function pickCwdRoot(): string {
  try {
    const sibling = path.join(path.dirname(REPO_ROOT), "billion-context-e2e-native-oc");
    fs.mkdirSync(sibling, { recursive: true });
    return sibling;
  } catch {
    return os.tmpdir();
  }
}
const CWD_ROOT = pickCwdRoot();

const run = process.env.ACP_TEST_E2E_OC_NATIVE === "1" && typeof process.env.E2E_OC_BIN === "string" && process.env.E2E_OC_BIN.length > 0;
const skipReason = !run
  ? "set ACP_TEST_E2E_OC_NATIVE=1 and E2E_OC_BIN=<opencode v2 binary> (real opencode + local fake upstream; deterministic, zero tokens)"
  : !fs.existsSync(OC_NATIVE_ENTRY)
    ? "dist/agent/opencode-native.js missing — run `npm run build` first"
    : undefined;
const suiteSkipReason =
  skipReason ??
  (() => {
    try {
      fs.accessSync(OC_BIN, fs.constants.X_OK);
      return undefined;
    } catch {
      return `opencode binary "${OC_BIN}" missing or not executable`;
    }
  })();

/** Deterministic filler: bulky, unique per line, carried verbatim in the prompt. */
function filler(lines: number): string {
  const out: string[] = [];
  for (let n = 0; n < lines; n += 1) {
    out.push(`filler line ${n}: 哨兵值=${n} words ${n * 7} ${"x".repeat(30)}`);
  }
  return out.join("\n");
}

type OracleEntry = {
  t: number;
  stream: boolean;
  plugin: string | null;
  conv: string | null;
  tools: string[];
  nmsg: number;
  roles: string;
  acpRefs: string[];
  acpToolRefs: string[];
  acpTagCount: number;
  toolResults: { name: string; content: string }[];
  queueIdx: number;
  toolName: string | null;
  lastUser: string;
  lastUserHead?: string;
  lastUserRef: string | null;
  title?: boolean;
};

function readOracle(reqLog: string): OracleEntry[] {
  if (!fs.existsSync(reqLog)) return [];
  return fs
    .readFileSync(reqLog, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as OracleEntry);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port")),
      );
    });
  });
}

async function waitFor(url: string, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${label} did not come up within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type Ctx = {
  work: string;
  ocCwd: string;
  homeDir: string;
  tmdir: string;
  xdg: { config: string; cache: string; state: string; data: string };
  svcPort: number;
  fakePort: number;
  fakePid?: number;
  reqLog: string;
};

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("BILI") ||
      key.startsWith("BILLION_CONTEXT") ||
      key.startsWith("ACP_") ||
      key.startsWith("OPENCODE")
    )
      delete env[key];
  }
  for (const key of [
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_TEST_CONTEXT",
    "NO_COLOR",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[key];
  return env;
}

async function startCtx(): Promise<Ctx> {
  const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-subagent-sessions-"));
  const ctx: Ctx = {
    work,
    ocCwd: fs.mkdtempSync(path.join(CWD_ROOT, "cwd-")),
    homeDir: path.join(work, "home"),
    tmdir: path.join(work, "tmdir"),
    xdg: {
      config: path.join(work, "xdg-config"),
      cache: path.join(work, "xdg-cache"),
      state: path.join(work, "xdg-state"),
      data: path.join(work, "xdg-data"),
    },
    svcPort: await freePort(),
    fakePort: await freePort(),
    reqLog: path.join(work, "fake-chat-requests.jsonl"),
  };
  for (const d of [
    ctx.ocCwd,
    ctx.homeDir,
    ctx.tmdir,
    ctx.xdg.config,
    ctx.xdg.cache,
    ctx.xdg.state,
    ctx.xdg.data,
    path.join(ctx.xdg.config, "opencode"),
    path.join(ctx.xdg.config, "billion-context"),
  ])
    fs.mkdirSync(d, { recursive: true });

  // Managed-service port pin, per channel filename (packages/cli/src/services/
  // service-config.ts: filename()): source-run checkouts report channel=local
  // → "service-local.json"; npm releases ride latest/dev/beta/next →
  // "service.json". Without a pin every context fights over the fixed
  // channel port (local=0xc0df=49375) and a stale service — whose broken
  // plugin state persists for its whole life — swallows every run.
  fs.writeFileSync(
    path.join(ctx.xdg.config, "opencode", "service-local.json"),
    JSON.stringify({ port: ctx.svcPort }),
  );
  fs.writeFileSync(
    path.join(ctx.xdg.config, "opencode", "service.json"),
    JSON.stringify({ port: ctx.svcPort }),
  );

  // 2.x plugin shape: 2.x requires a wrapper DIRECTORY whose index.js
  // re-exports the entry (bare file paths are rejected, #754). The 2.0.x
  // source contract is stricter still: Host.resolve (packages/plugin/src/
  // host.ts) probes <dir>/server, <dir>/tui and <dir>/rpc, and under bun a
  // missing module throws ResolveMessage WITHOUT a `code` — entry()'s
  // catch only tolerates coded ENOENT/MODULE_NOT_FOUND — so any absent
  // entrypoint aborts the WHOLE plugin reload, including the built-in
  // opencode.agent plugin that registers the default "build" agent →
  // `Agent not found: "build"`. Stub tui/rpc so resolution never throws.
  const wrapper = path.join(ctx.work, "oc-plugin");
  fs.mkdirSync(wrapper, { recursive: true });
  const reexport = `export { default } from ${JSON.stringify(OC_NATIVE_ENTRY)};\n`;
  fs.writeFileSync(path.join(wrapper, "index.js"), reexport);
  fs.writeFileSync(path.join(wrapper, "server.js"), reexport);
  fs.writeFileSync(path.join(wrapper, "tui.js"), "export {}\n");
  fs.writeFileSync(path.join(wrapper, "rpc.js"), "export {}\n");

  fs.writeFileSync(
    path.join(ctx.xdg.config, "opencode", "opencode.json"),
    JSON.stringify(
      {
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "FakeE2E",
            options: {
              baseURL: `http://127.0.0.1:${ctx.fakePort}/v1`,
              apiKey: "e2e-fake-key",
            },
            models: {
              "fake-model": {
                name: "Fake Model",
                limit: { context: 60000, output: 4096 },
              },
            },
          },
        },
        plugin: [wrapper],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(ctx.xdg.config, "billion-context", "billion-context.json"),
    JSON.stringify({ compress: { preserveRecentTokens: 0 } }, null, 2),
  );

  await assertPortDead(ctx.fakePort);
  const fake = spawn(process.execPath, [FAKE_UPSTREAM], {
    env: {
      ...process.env,
      FAKE_PORT: String(ctx.fakePort),
      FAKE_HOST: "127.0.0.1",
      FAKE_REQLOG: ctx.reqLog,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  ctx.fakePid = fake.pid;
  await waitFor(`http://127.0.0.1:${ctx.fakePort}/v1/models`, 15_000, "fake chat upstream");
  return ctx;
}

type InstanceRecord = { pid?: number; startedAt?: number; origin?: string };

function instanceRecords(ctx: Ctx): InstanceRecord[] {
  const dir = path.join(ctx.xdg.state, "billion-context", "instances");
  const out: InstanceRecord[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as InstanceRecord);
      } catch {
        /* unreadable record */
      }
    }
  } catch {
    /* no instances dir */
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProxiesGracefully(ctx: Ctx): Promise<void> {
  for (const rec of instanceRecords(ctx)) {
    if (typeof rec.pid === "number" && rec.pid > 0) {
      try {
        process.kill(rec.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}

async function awaitProxyExit(ctx: Ctx, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const live = instanceRecords(ctx).filter(
      (rec) => typeof rec.pid === "number" && rec.pid > 0 && pidAlive(rec.pid),
    );
    if (live.length === 0 || Date.now() - started > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function teardown(ctx: Ctx): void {
  if (ctx.fakePid) {
    try {
      process.kill(ctx.fakePid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Managed service: kill by the pid in the channel-suffixed registration
  // record(s) (service*.json in XDG state) — a leaked service holds its
  // plugin state forever and poisons every later run against its port.
  for (const name of ["service.json", "service-local.json"]) {
    try {
      const svc = JSON.parse(
        fs.readFileSync(path.join(ctx.xdg.state, "opencode", name), "utf8"),
      ) as { pid?: number };
      if (typeof svc.pid === "number" && svc.pid > 0) {
        try {
          process.kill(svc.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* no service record */
    }
  }
  for (const rec of instanceRecords(ctx)) {
    if (typeof rec.pid === "number" && rec.pid > 0) {
      try {
        process.kill(rec.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

async function ocRun(
  ctx: Ctx,
  prompt: string,
  opts: { session?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = ["run", "-m", "fake/fake-model", "--dangerously-skip-permissions"];
  if (opts.session) args.push("-s", opts.session);
  // Prompt goes via STDIN, not argv: opencode 2.x `run` shell-quotes any
  // argv message that contains a space (packages/cli/src/run/run.ts
  // formatMessage: `"${part.replace(/"/g, '\\"')}"`), so a scripted JSON
  // directive would reach the upstream as `\"请调用subagent {\"agent\":…}"`
  // and the fake's brace scanner chokes on the escaped quotes. mergeInput
  // (run.ts:76) returns the piped stdin RAW, no re-quoting.
  const outFile = path.join(ctx.work, `oc-${Date.now()}.out`);
  const errFile = path.join(ctx.work, `oc-${Date.now()}.err`);
  return new Promise((resolve, reject) => {
    const child = spawn(OC_BIN, args, {
      cwd: ctx.ocCwd,
      env: {
        ...cleanEnv(),
        HOME: ctx.homeDir,
        TMPDIR: ctx.tmdir,
        XDG_CONFIG_HOME: ctx.xdg.config,
        XDG_CACHE_HOME: ctx.xdg.cache,
        XDG_STATE_HOME: ctx.xdg.state,
        XDG_DATA_HOME: ctx.xdg.data,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => { /* EPIPE if the CLI exits early */ });
    child.stdin.end(prompt);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      err += c;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      reject(new Error(`opencode run timed out after ${TMO}ms`));
    }, TMO);
    child.on("exit", (code) => {
      clearTimeout(timer);
      fs.writeFileSync(outFile, out);
      fs.writeFileSync(errFile, err);
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
  });
}

function biliLog(ctx: Ctx): string {
  try {
    return fs.readFileSync(
      path.join(ctx.xdg.state, "billion-context", "bili.log"),
      "utf8",
    );
  } catch {
    return "";
  }
}

type Block = { blockId: string; active?: boolean; summary?: string };

type SessionFile = {
  payload?: {
    metadata?: { pluginAgent?: string; subagentSessions?: Record<string, string[]> };
    state?: { blocks?: Block[] };
  };
};

function sessionFiles(ctx: Ctx): { file: string; parsed: SessionFile }[] {
  const dir = path.join(ctx.xdg.data, "billion-context", "sessions");
  const out: { file: string; parsed: SessionFile }[] = [];
  try {
    for (const prov of fs.readdirSync(dir)) {
      const provDir = path.join(dir, prov);
      let entries: string[];
      try {
        entries = fs.readdirSync(provDir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".json")) continue;
        try {
          out.push({
            file: path.join(dir, prov, f),
            parsed: JSON.parse(fs.readFileSync(path.join(dir, prov, f), "utf8")) as SessionFile,
          });
        } catch {
          /* unreadable session */
        }
      }
    }
  } catch {
    /* no sessions dir */
  }
  return out;
}

test(
  "opencode v2 e2e: task dispatch id survives compression via the sidecar (#1702)",
  { skip: suiteSkipReason },
  async (t) => {
    const ctx = await startCtx();
    t.after(() => teardown(ctx));

    // — run one: load ~7.6KB of tagged user filler, establish the session.
    const load = await ocRun(ctx, filler(120));
    assert.equal(load.code, 0, `load run failed (code=${load.code}); stderr:\n${load.stderr}`);
    assert.match(load.stdout, /收到#done/, `load run should finish; stdout:\n${load.stdout}`);
    const rows1 = readOracle(ctx.reqLog);
    // #1699: v2 title side-channel re-sends the same filler text verbatim
    // (no ref tags, no tools) and races the main turn in reqLog — filter it out.
    const fillerRow = rows1.find((o) => o.lastUser.includes("filler line 0") && !o.title);
    assert.ok(fillerRow, "filler prompt must reach the upstream (oracle)");
    const conv = fillerRow.conv;
    assert.ok(conv !== null && /^ses_/.test(conv), "run one must establish a parent session");
    const fillerRef = fillerRow.lastUserRef;
    assert.ok(fillerRef !== null && /^m\d{5}$/.test(fillerRef), `filler must carry its ref, got ${fillerRef}`);

    // — run two: the REAL subagent tool fires (2.x name; 1.x called it
    // task — see packages/core/src/tool/plugin/subagent.ts:16 and the v1
    // migration packages/core/src/v1/config/migrate.ts:119); its sub-agent
    // makes its OWN upstream request (own conversation id) and the result
    // envelope `<subagent sessionID="ses_..." state="completed">` lands in
    // the parent history.
    await awaitProxyExit(ctx);
    const taskPrompt =
      "请调用subagent " +
      JSON.stringify({ agent: "general", description: "research", prompt: "Inspect the workspace and report one line of findings." });
    const dispatch = await ocRun(ctx, taskPrompt, { session: conv });
    assert.equal(dispatch.code, 0, `dispatch run failed (code=${dispatch.code}); stderr:\n${dispatch.stderr}`);
    const rows2 = readOracle(ctx.reqLog).slice(rows1.length);
    const childRows = rows2.filter((o) => o.conv !== null && o.conv !== conv);
    assert.ok(childRows.length >= 1, `the sub-agent must reach the upstream as its own conversation, got convs=${JSON.stringify(rows2.map((o) => o.conv))}`);
    for (const o of childRows) {
      assert.equal(o.plugin, "opencode", "sub-agent request must be plugin-stamped too");
    }
    const taskRow = rows2.find((o) => o.toolResults.some((tr) => tr.name === "subagent" || tr.name === "task"));
    assert.ok(taskRow, "the follow-up parent request must re-send the subagent tool result");
    const taskResult = taskRow.toolResults.find((tr) => tr.name === "subagent" || tr.name === "task")!.content;
    const childSes =
      taskResult.match(/^<subagent sessionID="(ses_[A-Za-z0-9]+)" state="[^"]*">/)?.[1] ??
      taskResult.match(/^<task id="(ses_[A-Za-z0-9]+)" state="[^"]*">/)?.[1];
    assert.ok(childSes !== undefined, `subagent result must open with the envelope carrying the child id, got: ${taskResult.slice(0, 120)}`);
    assert.ok(!taskResult.startsWith("{\"error\""), `subagent dispatch must succeed, got: ${taskResult.slice(0, 160)}`);

    // — runs three..five: push the dispatch pair out of the protected zone
    // (last 5 messages) before folding.
    await awaitProxyExit(ctx);
    const runThree = await ocRun(ctx, "followup e2e round three", { session: conv });
    assert.equal(runThree.code, 0, `run three failed; stderr:\n${runThree.stderr}`);
    const rows3 = readOracle(ctx.reqLog).slice(rows1.length + rows2.length);
    const roundThreeRow = rows3.find((o) => (o.lastUserHead ?? o.lastUser).includes("followup e2e round three"));
    assert.ok(roundThreeRow, "run three must reach the upstream");
    const endRef = roundThreeRow.lastUserRef;
    assert.ok(endRef !== null && /^m\d{5}$/.test(endRef), `run-three user message must carry its ref, got ${endRef}`);
    for (const label of ["followup e2e round four", "followup e2e round five"]) {
      const push = await ocRun(ctx, label, { session: conv });
      assert.equal(push.code, 0, `${label} failed; stderr:\n${push.stderr}`);
    }

    // — run six: fold [filler .. run-three user] — the span covers the whole
    // dispatch pair; the capture must read the child id out of the envelope.
    await awaitProxyExit(ctx);
    const foldPrompt =
      "请调用compress " +
      JSON.stringify({
        content: [
          { startId: fillerRef, endId: endRef, summary: "e2e #1702 fold: the filler payload plus the subagent dispatch pair" },
        ],
      });
    const beforeFold = readOracle(ctx.reqLog).length;
    const fold = await ocRun(ctx, foldPrompt, { session: conv });
    assert.equal(fold.code, 0, `fold run failed (code=${fold.code}); stderr:\n${fold.stderr}`);
    const foldRows = readOracle(ctx.reqLog).slice(beforeFold);
    assert.ok(foldRows.length >= 2, `fold run must reach the upstream, got ${foldRows.length} rows`);
    for (const o of foldRows) {
      assert.equal(o.plugin, "opencode", "fold-run request must stay plugin-stamped");
      assert.equal(o.conv, conv, "fold run must continue the SAME parent session");
    }

    // The compress result — re-sent on the plugin-mode carrier — must report
    // the fold AND name the captured child session id.
    const compressRow = readOracle(ctx.reqLog).find((o) =>
      o.toolResults.some((tr) => tr.name === "compress" && /\[Compressed/.test(tr.content)),
    );
    assert.ok(compressRow, "compress must have been called and its result re-sent");
    const compressResult = compressRow.toolResults.find((tr) => tr.name === "compress")!.content;
    assert.doesNotMatch(compressResult, /FAILED|Validation failed/, `compress must succeed, got: ${compressResult.slice(0, 200)}`);
    assert.match(compressResult, /\[Compressed m\d+[–-]m\d+ → \d+ block\(s\), ~\d+ tokens saved\.\]/, `compress result must report the fold, got: ${compressResult.slice(0, 200)}`);
    const noteMatch = compressResult.match(/\[acp-subagent-sessions (b\d+): ([^\]]+)\]/);
    assert.ok(
      noteMatch !== null && noteMatch[2].split(", ").includes(childSes),
      `compress receipt must name the captured child session id ${childSes}, got: ${compressResult}`,
    );

    assert.match(biliLog(ctx), /tool compress executed via plugin/, "proxy must log the plugin-channel compress execution");

    // — persisted state: sidecar entry per block, byte-clean summary.
    await stopProxiesGracefully(ctx);
    const sessions = sessionFiles(ctx);
    assert.ok(sessions.length >= 1, "proxy must persist the session");
    assert.ok(
      sessions.every((s) => s.parsed.payload?.metadata?.pluginAgent === "opencode"),
      "sessions must bind pluginAgent=opencode",
    );
    const sidecars = Object.fromEntries(
      sessions.flatMap((s) => Object.entries(s.parsed.payload?.metadata?.subagentSessions ?? {})),
    );
    assert.ok(
      Object.values(sidecars).some((ids) => ids.includes(childSes)),
      `persisted sidecar must map a block to the child id ${childSes}, got ${JSON.stringify(sidecars)}`,
    );
    const blocks = sessions.flatMap((s) => s.parsed.payload?.state?.blocks ?? []);
    const folded = blocks.filter((b) => b.blockId === noteMatch![1]);
    assert.ok(folded.length >= 1, "the receipt's block must exist in persisted state");
    for (const b of folded) {
      assert.ok(
        !(b.summary ?? "").includes(childSes),
        `stored summary must stay byte-clean (no child id), got: ${(b.summary ?? "").slice(0, 120)}`,
      );
    }
  },
);
