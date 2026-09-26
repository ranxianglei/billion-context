// E2E: REAL `opencode` (native plugin lane) through bili's native extension
// (#1267, split from #1239). Sibling of e2e-native-pi.test.ts (#1246): a
// deterministic fake chat-completions upstream scripts the model, so the whole
// native chain — proxy bootstrap, URL interception, x-bili-plugin stamping,
// ACP tool registration, plugin-tool execution (acp_status / compress) and
// REAL compression — runs in-process with zero tokens and no network. Gated by
// ACP_TEST_E2E_OC_NATIVE=1 (needs `npm run build` first — the plugin loads
// dist/agent/opencode-native.js). E2E_OC_BIN selects the binary: opencode 1.x
// exercises the V1 `.server()` tool lane (zod interop), 2.x the V2 `setup`
// tool-transform lane; both register the same tool set, so one suite drives
// either.
//
// Assertions map 1:1 to #1239's acceptance list:
//   1. traffic is intercepted + plugin-mode claimed (x-bili-plugin: opencode + ses_ id)
//   2. session binding + status reachable (live /__bili/plugin/status endpoint —
//      the /acp slash command itself is TUI-only; `run` dispatches no commands)
//   3. acp_status executes and returns the kernel status report
//   4. compress executes and PRODUCES compression (blocks + saved tokens), with
//      the plugin-mode carrier (tool call + result pair) visible in follow-up history
//
// opencode-specific mechanics vs the pi lane:
// - Config lives at $XDG_CONFIG_HOME/opencode/opencode.json; the plugin entry is
//   a bare dist path on 1.x but MUST be a wrapper directory (index.js re-export)
//   on 2.x.
// - v2 `run` rides a managed `serve --service` process on a channel-derived
//   FIXED port; the suite pins service.json to a unique free port per context so
//   runs can never collide with external services or each other, and teardown
//   kills the recorded service pid.
// - Both versions fire a side-channel title-generation request that shares our
//   queue key; the fake recognizes it and answers inertly (see
//   fake-upstream-chat.mjs).
// - cwd stays OUTSIDE the repo tree (#815): opencode walks up for AGENTS.md and
//   project config, and this repo's AGENTS.md carries literal <acp> examples.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const OC_BIN = process.env.E2E_OC_BIN ?? "opencode";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OC_NATIVE_ENTRY = path.join(REPO_ROOT, "dist/agent/opencode-native.js");
const FAKE_UPSTREAM = path.join(import.meta.dirname, "fake-upstream-chat.mjs");
const TMO = Number(process.env.E2E_TMO ?? 180_000);

const WORK_ROOT = path.join(process.cwd(), "tmp");
fs.mkdirSync(WORK_ROOT, { recursive: true });
// Sibling of the checkout works locally and on CI runners; os.tmpdir() is only
// a fallback because some hosts point it INSIDE the workspace tree (#815 trap).
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

const ACP_TOOLS = [
  "compress",
  "decompress",
  "search_context",
  "acp_status",
  "acp_cache",
] as const;

function ocVersion(bin: string): { major: number | null; raw: string } {
  try {
    const raw = spawnSync(bin, ["--version"], { timeout: 15_000 })
      .stdout.toString()
      .trim();
    const m = raw.match(/(\d+)\./);
    return { major: m ? Number(m[1]) : null, raw };
  } catch {
    return { major: null, raw: "" };
  }
}

const run = process.env.ACP_TEST_E2E_OC_NATIVE === "1";
const info = run ? ocVersion(OC_BIN) : { major: null as number | null, raw: "" };
const skipReason = !run
  ? "set ACP_TEST_E2E_OC_NATIVE=1 (real opencode + local fake upstream; deterministic, zero tokens)"
  : info.major === null
    ? `opencode binary "${OC_BIN}" missing or unparseable version (${info.raw})`
    : undefined;
const suiteSkipReason =
  skipReason ??
  (!fs.existsSync(OC_NATIVE_ENTRY)
    ? "dist/agent/opencode-native.js missing — run `npm run build` first"
    : undefined);
const checkOnly = process.env.E2E_CHECK === "1";

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
  toolResults: { name: string; content: string }[];
  queueIdx: number;
  toolName: string | null;
  lastUser: string;
  lastUserRef: string | null;
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
  // This suite may run INSIDE a bili-driven shell (BILLION_CONTEXT_PROXY et
  // al. preset): the native lane must bootstrap its OWN proxy, so every bili
  // side-channel has to go. Host opencode overrides leak real sessions too.
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
  // NODE_TEST_CONTEXT: set by the node:test runner and inherited by the spawned
  // client — the native entry deliberately stands down inside node:test (unit-
  // test guard), which would silently disable the bootstrap this suite
  // exercises. The spawned opencode is a real client, not a test context.
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
  const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-native-opencode-"));
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

  // v2 managed-service pin: `run` otherwise rides a shared `serve --service`
  // on a fixed channel-derived port — a unique port per context keeps this
  // hermetic (v1 ignores service.json).
  fs.writeFileSync(
    path.join(ctx.xdg.config, "opencode", "service.json"),
    JSON.stringify({ port: ctx.svcPort }),
  );

  // Plugin injection shape differs by major: 1.x accepts the bare dist file,
  // 2.x requires a directory whose index.js re-exports the plugin.
  let pluginEntry: string;
  if ((info.major ?? 0) >= 2) {
    const wrapper = path.join(ctx.work, "oc-plugin");
    fs.mkdirSync(wrapper, { recursive: true });
    fs.writeFileSync(
      path.join(wrapper, "index.js"),
      `export { default } from ${JSON.stringify(OC_NATIVE_ENTRY)};\n`,
    );
    pluginEntry = wrapper;
  } else {
    pluginEntry = OC_NATIVE_ENTRY;
  }

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
        plugin: [pluginEntry],
      },
      null,
      2,
    ),
  );

  // Deterministic fold zone: the kernel's protected zone is the union of the
  // last N messages (default 5) AND a backward token walk up to
  // preserveRecentTokens (default 5000) — in a small e2e session that walk
  // swallows the whole history, so even an old filler stays "entirely within
  // the protected zone". Zeroing it leaves only the message-count rule, which
  // the two push-back runs clear deterministically.
  fs.writeFileSync(
    path.join(ctx.xdg.config, "billion-context", "billion-context.json"),
    JSON.stringify({ compress: { preserveRecentTokens: 0 } }, null, 2),
  );

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

type InstanceRecord = { pid?: number; origin?: string; startedAt?: number; lane?: string };

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

/** Graceful stop so persisted state is observable on disk. */
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

/** Wait (bounded) for the parent-watched proxy to exit so the next run starts
 *  clean instead of racing a mid-shutdown attach. */
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
  // v2 managed service outlives the CLI — kill the recorded pid.
  try {
    const svc = JSON.parse(
      fs.readFileSync(path.join(ctx.xdg.state, "opencode", "service.json"), "utf8"),
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
  // The native proxy is parent-watched and dies with its client; kill any
  // survivor recorded in the hermetic instance dir so nothing lingers.
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

function ocRun(
  ctx: Ctx,
  prompt: string,
  opts: { session?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = ["run", "-m", "fake/fake-model", "--dangerously-skip-permissions"];
  if (opts.session) args.push("-s", opts.session);
  args.push(prompt);
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
      stdio: ["ignore", "pipe", "pipe"],
    });
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

type SessionFile = {
  requests?: number;
  payload?: {
    metadata?: { pluginAgent?: string };
    stats?: { requests?: number };
    state?: { blocks?: unknown };
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
        continue; // not a directory (e.g. .bili-migration markers)
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
  "preflight: opencode binary + built dist + fake upstream (E2E_CHECK)",
  { skip: skipReason },
  async (t) => {
    assert.ok(info.major !== null, `opencode binary "${OC_BIN}" must report a version`);
    assert.ok(
      fs.existsSync(OC_NATIVE_ENTRY),
      `dist entry ${OC_NATIVE_ENTRY} missing — run \`npm run build\``,
    );
    const ctx = await startCtx();
    t.after(() => teardown(ctx));
    const oracle = readOracle(ctx.reqLog);
    assert.equal(oracle.length, 0, "no requests before any opencode run");
  },
);

if (checkOnly) {
  // E2E_CHECK=1 stops after the zero-token preflight above.
} else {
  test(
    "native opencode one-shot: intercepted, plugin-stamped, ACP tools registered, acp_status executes",
    { skip: suiteSkipReason },
    async (t) => {
      const ctx = await startCtx();
      t.after(() => teardown(ctx));

      const r = await ocRun(ctx, "请调用acp_status");
      assert.equal(
        r.code,
        0,
        `opencode run failed (code=${r.code}); stderr:\n${r.stderr}`,
      );
      assert.match(
        r.stdout,
        /收到#done/,
        `run should finish the scripted loop; stdout:\n${r.stdout}`,
      );

      const oracle = readOracle(ctx.reqLog);
      assert.ok(
        oracle.length >= 2,
        `expected >=2 upstream requests (tool call + result), got ${oracle.length}`,
      );
      // Interception + claim: EVERY forwarded request carries the plugin
      // identity — including the title side-channel row.
      for (const o of oracle) {
        assert.equal(
          o.plugin,
          "opencode",
          `request must be plugin-stamped (x-bili-plugin), got ${o.plugin}`,
        );
        assert.ok(
          o.conv !== null && /^ses_/.test(o.conv),
          `request must carry an opencode session id, got ${o.conv}`,
        );
      }
      assert.equal(
        new Set(oracle.map((o) => o.conv)).size,
        1,
        "one session across the run",
      );
      const withAcp = oracle.filter((o) => ACP_TOOLS.every((name) => o.tools.includes(name)));
      assert.ok(
        withAcp.length >= 1,
        `ACP tools must be registered on model requests, got rows: ${JSON.stringify(oracle.map((o) => o.tools)).slice(0, 400)}`,
      );
      const statusRow = oracle.find((o) => o.toolResults.some((tr) => tr.name === "acp_status"));
      const statusResult = statusRow
        ? statusRow.toolResults.find((tr) => tr.name === "acp_status")
        : undefined;
      assert.ok(statusResult, "acp_status must have been called and its result re-sent");
      // The report surface differs by lane: 1.x re-sends the plain
      // "ACTIVE SURFACE … CONTEXT BREAKDOWN" text; 2.x re-sends the boxed
      // "ACP Context Analysis" panel (truncated to 160 chars by the oracle).
      const shown = statusResult.content.slice(0, 160);
      assert.match(
        statusResult.content,
        /ACP Context Analysis|ACTIVE SURFACE/,
        `acp_status result must be the kernel status report, got: ${shown}`,
      );
      assert.match(
        statusResult.content,
        /billion-context[ @]/,
        `acp_status result must carry the bili version stamp, got: ${shown}`,
      );

      await stopProxiesGracefully(ctx);
      const sessions = sessionFiles(ctx);
      assert.ok(sessions.length >= 1, "proxy must persist the session");
      assert.ok(
        sessions.every((s) => s.parsed.payload?.metadata?.pluginAgent === "opencode"),
        `sessions must bind pluginAgent=opencode, got ${JSON.stringify(sessions.map((s) => s.parsed.payload?.metadata?.pluginAgent))}`,
      );
    },
  );

  test(
    "native opencode compress: model-invoked compress really folds context",
    { skip: suiteSkipReason },
    async (t) => {
      const ctx = await startCtx();
      t.after(() => teardown(ctx));

      // Run one loads ~7.6KB of tagged user filler. The kernel protects the
      // last 5 messages + the most recent user message, so two plain
      // intermediate runs (-s <session>) push the filler outside that zone
      // before the final run scripts the model to fold it.
      const load = await ocRun(ctx, filler(120));
      assert.equal(
        load.code,
        0,
        `load run failed (code=${load.code}); stderr:\n${load.stderr}`,
      );
      assert.match(
        load.stdout,
        /收到#done/,
        `load run should finish; stdout:\n${load.stdout}`,
      );

      const rows1 = readOracle(ctx.reqLog);
      const conv = rows1.find((o) => o.conv)?.conv ?? null;
      assert.ok(conv !== null && /^ses_/.test(conv), "run one must establish a session");
      const fillerRow = rows1.find((o) => o.lastUser.includes("filler line 0"));
      assert.ok(fillerRow, "filler prompt must reach the upstream (oracle)");
      const targetRef = fillerRow.lastUserRef;
      assert.ok(
        targetRef !== null && /^m\d{5}$/.test(targetRef),
        `filler message must carry its ACP ref tag, got ${targetRef} (row: ${JSON.stringify(fillerRow).slice(0, 200)})`,
      );

      await awaitProxyExit(ctx);

      for (const [round, label] of [[2, "followup e2e round two"], [3, "followup e2e round three"]] as const) {
        const push = await ocRun(ctx, label, { session: conv });
        assert.equal(
          push.code,
          0,
          `push-back run ${round} failed (code=${push.code}); stderr:\n${push.stderr}`,
        );
        assert.match(
          push.stdout,
          /收到#done/,
          `push-back run ${round} should finish; stdout:\n${push.stdout}`,
        );
      }

      const foldPrompt =
        "请调用compress " +
        JSON.stringify({
          content: [{ startId: targetRef, endId: targetRef, summary: "e2e fold: run-one filler" }],
        });
      const fold = await ocRun(ctx, foldPrompt, { session: conv });
      assert.equal(
        fold.code,
        0,
        `fold run failed (code=${fold.code}); stderr:\n${fold.stderr}`,
      );
      assert.match(
        fold.stdout,
        /收到#done/,
        `fold run should finish the scripted loop; stdout:\n${fold.stdout}`,
      );

      const oracle = readOracle(ctx.reqLog);
      const rows2 = oracle.slice(rows1.length);
      assert.ok(
        rows2.length >= 2,
        `fold run must reach the upstream, got ${rows2.length} rows`,
      );
      for (const o of rows2) {
        assert.equal(o.plugin, "opencode", "fold-run request must stay plugin-stamped");
        assert.equal(o.conv, conv, "fold run must continue the SAME session");
      }
      const foldRows = oracle.filter((o) => o.toolResults.some((tr) => tr.name === "compress"));
      const compressResult = foldRows[0]?.toolResults.find((tr) => tr.name === "compress")?.content;
      assert.ok(compressResult !== undefined, "compress must have been called and its result re-sent");
      assert.doesNotMatch(
        compressResult,
        /FAILED|Validation failed/,
        `compress must succeed, got: ${compressResult.slice(0, 200)}`,
      );
      assert.match(
        compressResult,
        /\[Compressed m\d+[–-]m\d+ → \d+ block\(s\), ~\d+ tokens saved\.\]/,
        `compress result must report the fold, got: ${compressResult.slice(0, 200)}`,
      );
      // Plugin-mode carrier: the tool call AND its result ride in follow-up
      // history — the agent owns compression, nothing is injected.
      const carrierRow = foldRows[0];
      assert.ok(
        carrierRow !== undefined && carrierRow.roles.includes("tool"),
        `follow-up request must carry the tool-result role, got roles=${carrierRow?.roles}`,
      );

      assert.match(
        biliLog(ctx),
        /tool compress executed via plugin/,
        "proxy must log the plugin-channel compress execution",
      );

      await stopProxiesGracefully(ctx);
      const sessions = sessionFiles(ctx);
      const withBlocks = sessions.filter((s) => {
        const blocks = s.parsed.payload?.state?.blocks;
        return blocks !== undefined && blocks !== null && Object.keys(blocks as Record<string, unknown>).length >= 1;
      });
      assert.ok(
        withBlocks.length >= 1,
        `at least one persisted session must carry compressed blocks (got ${sessions.length} sessions)`,
      );
    },
  );

  test(
    "status endpoint: live proxy answers ok for the bound conversation (/acp analog)",
    { skip: suiteSkipReason },
    async (t) => {
      const ctx = await startCtx();
      t.after(() => teardown(ctx));

      const r = await ocRun(ctx, "hello e2e");
      assert.equal(
        r.code,
        0,
        `run failed (code=${r.code}); stderr:\n${r.stderr}`,
      );
      const conv = readOracle(ctx.reqLog).find((o) => o.conv)?.conv ?? null;
      assert.ok(conv !== null, "run must carry the session id upstream");

      // The /acp slash command is TUI-only (`run` dispatches no commands), so
      // the binding proof goes through the endpoint /acp consumes: probe it via
      // the hermetic instance record right while the proxy is still alive.
      const recs = instanceRecords(ctx);
      assert.ok(recs.length >= 1, "instance record must exist after a native run");
      const rec = [...recs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
      assert.ok(
        typeof rec.origin === "string" && rec.origin.length > 0,
        `instance record must carry the proxy origin, got: ${JSON.stringify(rec).slice(0, 120)}`,
      );
      const res = await fetch(
        `${rec.origin}/__bili/plugin/status?conversationId=${encodeURIComponent(conv)}`,
      );
      const body = (await res.json()) as { ok?: boolean; error?: string };
      assert.ok(
        res.ok,
        `status endpoint must answer 2xx (got ${res.status}: ${JSON.stringify(body).slice(0, 120)})`,
      );
      assert.equal(
        body.ok,
        true,
        `status must resolve the bound conversation (got ${JSON.stringify(body).slice(0, 120)})`,
      );
    },
  );
}
