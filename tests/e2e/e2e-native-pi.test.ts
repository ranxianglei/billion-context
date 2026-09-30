// E2E: REAL `pi` (native package lane) through bili's native extension (#1239).
// Mirrors e2e-codex-fake.test.ts: a deterministic fake chat-completions upstream
// scripts the model, so the whole native chain — proxy bootstrap, fetch
// interception, x-bili-plugin stamping, ACP tool registration, plugin-tool
// execution (acp_status / compress) and real compression — runs in-process
// with zero tokens and no network. Gated by ACP_TEST_E2E_NATIVE=1 (needs
// `npm run build` first — the pi package loads dist/agent/pi-native.js).
//
// Assertions map 1:1 to #1239's acceptance list:
//   1. traffic is intercepted + plugin-mode claimed (x-bili-plugin: pi)
//   2. ACP tools are registered and callable by the model
//   3. acp_status executes and returns the status report
//   4. compress executes and PRODUCES compression (blocks + saved tokens)
// plus the /acp slash command path (exit-clean + live status endpoint).
// The first-request stamp race (#1243) is pinned by every stamp assertion:
// a one-shot `pi -p` fires before_provider_headers exactly once, inside the
// proxy bootstrap window.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
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
const TMO = Number(process.env.E2E_TMO ?? 150_000);
const WORK_ROOT = path.join(process.cwd(), "tmp");
fs.mkdirSync(WORK_ROOT, { recursive: true });
// pi walks up from its cwd for AGENTS.md too (#815): stay outside the repo.
const CWD_ROOT = path.join(os.tmpdir(), "billion-context-e2e-native");
fs.mkdirSync(CWD_ROOT, { recursive: true });

const ACP_TOOLS = [
  "compress",
  "decompress",
  "search_context",
  "acp_status",
  "acp_cache",
] as const;

function piAvailable(): boolean {
  try {
    return spawnSync(PI_BIN, ["--version"], { timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
}
function distBuilt(): boolean {
  return fs.existsSync(PI_NATIVE_ENTRY);
}

const run = process.env.ACP_TEST_E2E_NATIVE === "1";
const skipReason = !run
  ? "set ACP_TEST_E2E_NATIVE=1 (real pi native package + local fake upstream; deterministic, zero tokens)"
  : !piAvailable()
    ? `pi binary "${PI_BIN}" not found on PATH`
    : undefined;
const suiteSkipReason =
  skipReason ??
  (!distBuilt()
    ? "dist/agent/pi-native.js missing — run `npm run build` first"
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
};

function readOracle(reqLog: string): OracleEntry[] {
  if (!fs.existsSync(reqLog)) return [];
  return fs
    .readFileSync(reqLog, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as OracleEntry);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function waitFor(url: string, ms: number, label = url): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      fetch(url)
        .then((r) => (r.ok ? resolve() : retry()))
        .catch(retry);
    };
    const retry = (): void => {
      if (Date.now() - started > ms) {
        reject(new Error(`${label} did not come up within ${ms}ms`));
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

type Ctx = {
  work: string;
  piCwd: string;
  piAgentDir: string;
  xdg: { config: string; cache: string; state: string; data: string };
  fakePort: number;
  fakePid?: number;
  reqLog: string;
};

function cleanEnv(): NodeJS.ProcessEnv {
  // This suite may run INSIDE a bili-driven shell (BILLION_CONTEXT_PROXY et
  // al. preset): the native lane must bootstrap its OWN proxy, so every bili
  // side-channel has to go. Host pi overrides leak real sessions too.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("BILI") ||
      key.startsWith("BILLION_CONTEXT") ||
      key.startsWith("ACP_")
    )
      delete env[key];
  }
  // NODE_TEST_CONTEXT: set by the node:test runner and inherited by the spawned
  // pi — pi-native.ts deliberately stands down inside node:test (unit-test
  // guard), which would silently disable the very bootstrap this suite
  // exercises. The spawned pi is a real client, not a test context.
  for (const key of [
    "NODE_EXTRA_CA_CERTS",
    "PI_SESSION_FILE",
    "PI_PROVIDER",
    "PI_MODEL",
    "NODE_OPTIONS",
    "NODE_TEST_CONTEXT",
  ])
    delete env[key];
  return env;
}

async function startCtx(): Promise<Ctx> {
  const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-native-pi-"));
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
    fakePort: await freePort(),
    reqLog: path.join(work, "fake-chat-requests.jsonl"),
  };
  for (const d of [
    ctx.piAgentDir,
    ctx.piCwd,
    ctx.xdg.config,
    ctx.xdg.cache,
    ctx.xdg.state,
    ctx.xdg.data,
  ])
    fs.mkdirSync(d, { recursive: true });

  await assertPortDead(ctx.fakePort); // #1689: prove still free right before the child binds it
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
  await waitFor(
    `http://127.0.0.1:${ctx.fakePort}/v1/models`,
    15_000,
    "fake chat upstream",
  );

  // Benign host tool with an oversized payload: gives the loop a visible
  // warm-up round (ACP tools register from the 2nd request on) and provides
  // foldable bulk. Mirrors the proven /tmp probe package shape (ESM default
  // export, "pi": { "extensions": [...] }).
  const probePkg = path.join(work, "probe-pkg");
  fs.mkdirSync(probePkg, { recursive: true });
  fs.writeFileSync(
    path.join(probePkg, "package.json"),
    JSON.stringify(
      {
        name: "probe-pkg",
        version: "1.0.0",
        pi: { extensions: ["./index.js"] },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(probePkg, "index.js"),
    [
      `const BIG = Array.from({ length: 60 }, (_, i) => \`probe payload line \${i}: 哨兵值=\${1000 + i} unique-\${i * 7} \${"p".repeat(30)}\`).join("\\n");`,
      "export default function (pi) {",
      "  pi.registerTool({",
      '    name: "probe_tool",',
      '    description: "e2e probe tool returning an oversized payload for compress tests",',
      '    parameters: { type: "object", properties: { text: { type: "string" } } },',
      '    execute: async () => ({ content: [{ type: "text", text: `probe ok\\n${BIG}` }] }),',
      "  });",
      "}",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(ctx.piAgentDir, "settings.json"),
    JSON.stringify({ packages: [REPO_ROOT, probePkg] }, null, 2),
  );
  fs.writeFileSync(
    path.join(ctx.piAgentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${ctx.fakePort}/v1`,
            api: "openai-completions",
            apiKey: "e2e-fake-key",
            models: [
              {
                id: "fake-model",
                name: "Fake",
                input: ["text"],
                contextWindow: 60000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  return ctx;
}

// Graceful-stop the hermetic native proxy (SIGTERM — the server flushes
// dirty sessions on shutdown) so persisted state is observable on disk.
async function stopProxiesGracefully(ctx: Ctx): Promise<void> {
  const instancesDir = path.join(ctx.xdg.state, "billion-context", "instances");
  try {
    for (const f of fs.readdirSync(instancesDir)) {
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(instancesDir, f), "utf8"),
        ) as { pid?: number };
        if (typeof rec.pid === "number" && rec.pid > 0) {
          try {
            process.kill(rec.pid, "SIGTERM");
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* unreadable record */
      }
    }
  } catch {
    /* no instances dir */
  }
  await new Promise((r) => setTimeout(r, 500));
}

function teardown(ctx: Ctx): void {
  if (ctx.fakePid) {
    try {
      process.kill(ctx.fakePid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // The native proxy is parent-watched and dies with its pi; kill any
  // survivor recorded in the hermetic instance dir so nothing lingers.
  const instancesDir = path.join(ctx.xdg.state, "billion-context", "instances");
  try {
    for (const f of fs.readdirSync(instancesDir)) {
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(instancesDir, f), "utf8"),
        ) as { pid?: number };
        if (typeof rec.pid === "number" && rec.pid > 0) {
          try {
            process.kill(rec.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* unreadable record */
      }
    }
  } catch {
    /* no instances dir */
  }
}

function piRun(
  ctx: Ctx,
  prompt: string,
  opts: { resume?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = ["-p", "--model", "fake/fake-model"];
  if (opts.resume) args.push("--continue");
  args.push(prompt);
  const outFile = path.join(ctx.work, `pi-${Date.now()}.out`);
  const errFile = path.join(ctx.work, `pi-${Date.now()}.err`);
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, args, {
      cwd: ctx.piCwd,
      env: {
        ...cleanEnv(),
        PI_CODING_AGENT_DIR: ctx.piAgentDir,
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
      reject(new Error(`pi -p timed out after ${TMO}ms`));
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
            parsed: JSON.parse(
              fs.readFileSync(path.join(dir, prov, f), "utf8"),
            ) as SessionFile,
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
  "preflight: pi binary + built dist + fake upstream (E2E_CHECK)",
  { skip: skipReason },
  async (t) => {
    assert.ok(piAvailable(), `pi binary "${PI_BIN}" must run --version`);
    assert.ok(
      distBuilt(),
      `dist entry ${PI_NATIVE_ENTRY} missing — run \`npm run build\``,
    );
    const ctx = await startCtx();
    t.after(() => teardown(ctx));
    const oracle = readOracle(ctx.reqLog);
    assert.equal(oracle.length, 0, "no requests before any pi run");
  },
);

if (checkOnly) {
  // E2E_CHECK=1 stops after the zero-token preflight above.
} else {
  test(
    "native pi one-shot: intercepted, plugin-stamped, ACP tools registered, acp_status executes",
    { skip: suiteSkipReason },
    async (t) => {
      const ctx = await startCtx();
      t.after(() => teardown(ctx));

      const r = await piRun(ctx, "请调用probe_tool;请调用acp_status");
      assert.equal(
        r.code,
        0,
        `pi -p failed (code=${r.code}); stderr:\n${r.stderr}`,
      );
      assert.match(
        r.stdout,
        /收到#done/,
        `pi should finish the scripted loop; stdout:\n${r.stdout}`,
      );

      const oracle = readOracle(ctx.reqLog);
      assert.ok(
        oracle.length >= 3,
        `expected >=3 upstream requests (warmup, acp_status call, final), got ${oracle.length}`,
      );
      // #1243: a one-shot pi process stamps on its FIRST (and only) header event
      // — every forwarded request must carry the plugin identity.
      for (const o of oracle) {
        assert.equal(
          o.plugin,
          "pi",
          `request must be plugin-stamped (x-bili-plugin), got ${o.plugin}`,
        );
        assert.ok(
          o.conv && o.conv.length > 0,
          "request must carry x-bili-plugin-conversation",
        );
      }
      const withAcp = oracle.filter((o) =>
        ACP_TOOLS.every((name) => o.tools.includes(name)),
      );
      assert.ok(
        withAcp.length >= 1,
        "ACP tools must be registered on follow-up requests",
      );
      const status = oracle.find((o) =>
        o.toolResults.some((tr) => tr.name === "acp_status"),
      );
      assert.ok(
        status,
        "acp_status must have been called and its result re-sent",
      );
      const statusResult = status.toolResults.find(
        (tr) => tr.name === "acp_status",
      );
      assert.ok(statusResult, "acp_status tool result entry must exist");
      assert.match(
        statusResult.content,
        /ACTIVE SURFACE[\s\S]*CONTEXT BREAKDOWN/,
        "acp_status result must be the status report",
      );
      // Plugin-mode binding on the proxy side, not just on the wire. Sessions
      // persist lazily — flush rides graceful shutdown.
      await stopProxiesGracefully(ctx);
      const sessions = sessionFiles(ctx);
      assert.ok(sessions.length >= 1, "proxy must persist the session");
      assert.ok(
        sessions.every((s) => s.parsed.payload?.metadata?.pluginAgent === "pi"),
        `sessions must bind pluginAgent=pi, got ${JSON.stringify(sessions.map((s) => s.parsed.payload?.metadata?.pluginAgent))}`,
      );
    },
  );

  test(
    "native pi compress: model-invoked compress really folds context",
    { skip: suiteSkipReason },
    async (t) => {
      const ctx = await startCtx();
      t.after(() => teardown(ctx));

      // Run one loads ~7.6KB of tagged user filler plus four probe rounds; run
      // two (--continue) re-sends the history so the filler leaves the kernel's
      // protected zone (last 5 messages / most recent user message) and becomes
      // the compress target the scripted model cites.
      const load = await piRun(
        ctx,
        `${filler(120)}\n${Array.from({ length: 4 }, () => "请调用probe_tool").join(";")}`,
      );
      assert.equal(
        load.code,
        0,
        `load run failed (code=${load.code}); stderr:\n${load.stderr}`,
      );

      const fold = await piRun(
        ctx,
        "请调用probe_tool;请调用compress;请调用acp_status",
        { resume: true },
      );
      assert.equal(
        fold.code,
        0,
        `fold run failed (code=${fold.code}); stderr:\n${fold.stderr}`,
      );

      const oracle = readOracle(ctx.reqLog);
      // #1243 discipline: every forwarded request in BOTH runs is stamped.
      for (const o of oracle) {
        assert.equal(
          o.plugin,
          "pi",
          `request must be plugin-stamped (x-bili-plugin), got ${o.plugin} (nmsg=${o.nmsg})`,
        );
        assert.ok(
          o.conv && o.conv.length > 0,
          "request must carry x-bili-plugin-conversation",
        );
      }
      const foldRows = oracle.filter((o) =>
        o.toolResults.some((tr) => tr.name === "compress"),
      );
      assert.ok(
        foldRows.length >= 1,
        "compress must have been called and its result re-sent",
      );
      const compressResult =
        foldRows[0]?.toolResults.find((tr) => tr.name === "compress")
          ?.content ?? "";
      assert.ok(
        compressResult.length > 0,
        "compress tool result entry must exist",
      );
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

      // Real compression evidence on the proxy side.
      assert.match(
        biliLog(ctx),
        /tool compress executed via plugin/,
        "proxy must log the plugin-channel compress execution",
      );
      // Blocks persist lazily — the flush rides graceful shutdown, so stop the
      // hermetic proxy first (teardown SIGKILLs survivors afterwards).
      await stopProxiesGracefully(ctx);
      const sessions = sessionFiles(ctx);
      const withBlocks = sessions.filter((s) => {
        const blocks = s.parsed.payload?.state?.blocks;
        return (
          blocks !== undefined &&
          blocks !== null &&
          Object.keys(blocks as Record<string, unknown>).length >= 1
        );
      });
      assert.ok(
        withBlocks.length >= 1,
        `at least one persisted session must carry compressed blocks (got ${sessions.length} sessions)`,
      );
    },
  );

  test(
    "/acp command: exits clean and the status endpoint it consumes is live",
    { skip: suiteSkipReason },
    async (t) => {
      const ctx = await startCtx();
      t.after(() => teardown(ctx));

      const r = await piRun(ctx, "/acp");
      assert.equal(
        r.code,
        0,
        `/acp run failed (code=${r.code}); stderr:\n${r.stderr}`,
      );
      assert.doesNotMatch(
        r.stderr,
        /bili-plugin\(|status fetch failed|no proxy/i,
        `command handler must not error; stderr:\n${r.stderr}`,
      );

      // The native bootstrap must have brought up (and recorded) a proxy the
      // command's fetchStatus consumed — probe the same endpoint shape via the
      // hermetic instance record (native mode does not write proxy-origin).
      const instancesDir = path.join(
        ctx.xdg.state,
        "billion-context",
        "instances",
      );
      const files = fs.existsSync(instancesDir)
        ? fs.readdirSync(instancesDir)
        : [];
      assert.ok(
        files.length >= 1,
        "instance record must exist after a native run",
      );
      const rec = JSON.parse(
        fs.readFileSync(path.join(instancesDir, files[0]!), "utf8"),
      ) as { origin?: string };
      assert.ok(
        typeof rec.origin === "string",
        `instance record must carry the proxy origin, got: ${JSON.stringify(rec).slice(0, 120)}`,
      );
      const res = await fetch(
        `${rec.origin}/__bili/plugin/status?conversationId=pi`,
      );
      const body = (await res.json()) as { ok?: boolean };
      assert.ok(
        typeof body.ok === "boolean",
        `status endpoint must answer JSON with an ok field (got ${res.status}: ${JSON.stringify(body).slice(0, 120)})`,
      );
    },
  );
}
