// E2E: REAL `dsh` (native profile lane, headless one-shot) through bili's
// native extension (#1268, split from #1239). Mirrors e2e-native-pi.test.ts:
// a deterministic fake chat-completions upstream scripts the model, so the
// whole native chain — proxy bootstrap, fetch interception, x-bili-plugin
// stamping, ACP tool registration, plugin-tool execution (acp_status /
// compress) and real compression — runs in-process with zero tokens and no
// network. Gated by ACP_TEST_E2E_DSH_NATIVE=1 (needs `npm i -g
// @deepseek-ai/dsh` + `npm run build`; the profile loads dist/agent/dsh-native.js).
//
// dsh-specific shape vs the pi lane:
// - headless mode (`dsh --profile headless <task>`) is ONE process per
//   session and has no --resume, so ALL acceptance rounds ride a single agent
//   loop: the task prompt carries bulky filler plus scripted directive
//   markers (fake-upstream-chat.mjs consumes one per round).
// - The first-request stamp race found while building this lane (#1268): dsh
//   fires request 1 as soon as the proxy origin is ready, while ACP manifest
//   registration lands milliseconds later. The toolsReady gate in
//   src/agent/native-intercept.ts holds R1 until registration finishes, so
//   EVERY hop — starting with R1 — must arrive stamped. A regression back to
//   an un-stamped (wire-mode) R1 fails the every-stamp assertions below.
// - L1 evictor coexistence (#1158/#1187): dsh boot unconditionally installs
//   an undici global dispatcher from proxy env (@deepseek-ai/dsh-http-proxy,
//   installProxyFromEnvironment). This suite exports dead loopback proxy URLs
//   so the non-direct policy path is active while LOOPBACK_NO_PROXY keeps
//   fixture traffic direct; every hop staying stamped proves bili's fetch
//   patch chain survives the third-party dispatcher layer (not just hop 1).
//   The guarded-accessor re-arm itself is unit-pinned in
//   tests/native-intercept-selfheal.test.ts.
//
// Assertions map 1:1 to #1239's acceptance list:
//   1. traffic is intercepted + plugin-mode claimed (x-bili-plugin: dsh,
//      native session-<uuid> conversation id, every hop incl. R1)
//   2. /acp session binding + status reachable (live GET
//      /__bili/plugin/status?conversationId=... answers ok:true mid-run)
//   3. acp_status executes client-side and its result is re-sent in history
//   4. compress really folds (persisted block + pluginAgent=dsh binding)
//
// The bili config zeroes compress.preserveRecentTokens: after the big filler
// message only a few hundred tokens follow in a one-shot run, so the kernel's
// default token window (5000) would pin the filler inside the protected zone
// and no scripted compress could ever fold it. Preflight already relaxes
// exactly these knobs under overflow (src/preflight.ts), so zeroing them here
// is established product behavior, not a test hack.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const DSH_BIN = process.env.E2E_DSH_BIN ?? "dsh";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DSH_NATIVE_ENTRY = path.join(REPO_ROOT, "dist/agent/dsh-native.js");
const FAKE_UPSTREAM = path.join(import.meta.dirname, "fake-upstream-chat.mjs");
const TMO = Number(process.env.E2E_TMO ?? 150_000);
const WORK_ROOT = path.join(process.cwd(), "tmp");
// dsh walks up from cwd looking for workspace markers — keep the client cwd
// OUTSIDE the repo so this project's own tree never leaks into the run.
const CWD_ROOT = path.join(os.tmpdir(), "billion-context-e2e-dsh-native");
const ACP_TOOLS = [
  "compress",
  "decompress",
  "search_context",
  "acp_status",
  "acp_cache",
] as const;

function dshAvailable(): boolean {
  try {
    return spawnSync(DSH_BIN, ["--version"], { timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
}
function distBuilt(): boolean {
  return fs.existsSync(DSH_NATIVE_ENTRY);
}

const run = process.env.ACP_TEST_E2E_DSH_NATIVE === "1";
const skipReason = !run
  ? "set ACP_TEST_E2E_DSH_NATIVE=1 (real dsh headless profile + local fake upstream; deterministic, zero tokens)"
  : !dshAvailable()
    ? `dsh binary "${DSH_BIN}" not found on PATH (npm i -g @deepseek-ai/dsh)`
    : undefined;
const suiteSkipReason =
  skipReason ??
  (!distBuilt()
    ? "dist/agent/dsh-native.js missing — run `npm run build` first"
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

// One headless process = one session: the whole acceptance sequence rides a
// single agent loop. The fake consumes one 请调用<tool> marker per round from
// the FIRST user message (dsh appends its host context AFTER the task, so the
// last-user-message scan finds no markers there — see fake-upstream-chat.mjs).
const TASK = [
  filler(400),
  "资料读完,先请调用acp_status查看上下文状态。",
  "然后再请调用acp_status确认一次。",
  "第三次请调用acp_status。",
  "然后请调用compress折叠最旧的消息。",
  "最后只回复:收到#done",
].join("\n");

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
  dshCwd: string;
  homeDir: string;
  tmpDir: string;
  dshHome: string;
  xdg: { config: string; cache: string; state: string; data: string };
  fakePort: number;
  fakePid?: number;
  reqLog: string;
};

// dsh boot turns these into an undici global dispatcher
// (@deepseek-ai/dsh-http-proxy): never inherit host values into the run.
const PROXY_ENV_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "no_proxy",
  "NO_PROXY",
  "all_proxy",
  "ALL_PROXY",
];

function cleanEnv(): NodeJS.ProcessEnv {
  // This suite may run INSIDE a bili-driven shell (BILLION_CONTEXT_PROXY et
  // al. preset): the native lane must bootstrap its OWN proxy, so every bili
  // side-channel has to go. Host proxy env leaks a real dispatcher policy.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("BILI") ||
      key.startsWith("BILLION_CONTEXT") ||
      key.startsWith("ACP_")
    )
      delete env[key];
  }
  // NODE_TEST_CONTEXT: set by the node:test runner and inherited by the
  // spawned dsh — dsh-native.ts deliberately stands down inside node:test
  // (unit-test guard), which would silently disable the very bootstrap this
  // suite exercises. The spawned dsh is a real client, not a test context.
  for (const key of [
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_TEST_CONTEXT",
    ...PROXY_ENV_KEYS,
  ])
    delete env[key];
  return env;
}

async function startCtx(): Promise<Ctx> {
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-native-dsh-"));
  fs.mkdirSync(CWD_ROOT, { recursive: true });
  const ctx: Ctx = {
    work,
    dshCwd: fs.mkdtempSync(path.join(CWD_ROOT, "cwd-")),
    homeDir: path.join(work, "home"),
    tmpDir: path.join(work, "tmp"),
    dshHome: path.join(work, "dsh-home"),
    xdg: {
      config: path.join(work, "xdg-config"),
      cache: path.join(work, "xdg-cache"),
      state: path.join(work, "xdg-state"),
      data: path.join(work, "xdg-data"),
    },
    fakePort: await freePort(),
    reqLog: path.join(work, "reqlog.jsonl"),
  };
  for (const d of [
    ctx.homeDir,
    ctx.tmpDir,
    ctx.dshHome,
    ctx.xdg.config,
    ctx.xdg.cache,
    ctx.xdg.state,
    ctx.xdg.data,
  ])
    fs.mkdirSync(d, { recursive: true });

  const fake = spawn(process.execPath, [FAKE_UPSTREAM], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: ctx.homeDir,
      TMPDIR: ctx.tmpDir,
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

  wireProfile(ctx);
  writeBiliConfig(ctx);
  return ctx;
}

// Headless profile wiring — the production lane shape
// (`bili plugin install dsh` territory, #949/#966) without a package manager:
// the profile's node_modules carries the built local package exactly as a
// registry install would (published files: dist + dsh.bundle.patch.yml).
function wireProfile(ctx: Ctx): void {
  const profileDir = path.join(ctx.dshHome, "profiles", "headless");
  const pkgDir = path.join(profileDir, "node_modules", "billion-context");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(pkgDir, "package.json"));
  fs.cpSync(path.join(REPO_ROOT, "dist"), path.join(pkgDir, "dist"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "dsh.bundle.patch.yml"),
    path.join(pkgDir, "dsh.bundle.patch.yml"),
  );

  const biliVersion = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ).version as string;
  fs.writeFileSync(
    path.join(profileDir, "package.json"),
    JSON.stringify(
      {
        name: "e2e-dsh-profile-headless",
        private: true,
        dependencies: { "billion-context": biliVersion },
        dsh: {
          profile: {
            bundles: [
              "@deepseek-ai/dsh-base",
              "@deepseek-ai/dsh-headless",
              "billion-context",
            ],
            patchReload: "startup",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(path.join(profileDir, "cordis.yml"), "[]\n");
  fs.writeFileSync(
    path.join(profileDir, "cordis.patch.yml"),
    [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      fake:",
      "        displayName: Fake Upstream",
      "        apiKeyEnv: E2E_FAKE_KEY",
      "        api: openai-completions",
      `        baseURL: http://127.0.0.1:${ctx.fakePort}/v1`,
      "        models:",
      "          - id: fake-model",
      "            name: Fake Model",
      "            contextWindow: 60000",
      "            maxTokens: 4096",
      "- id: agent-default-model",
      "  config:",
      "    provider: fake",
      "    model: fake-model",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(profileDir, "pnpm-workspace.yaml"),
    "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n",
  );
}

function writeBiliConfig(ctx: Ctx): void {
  const dir = path.join(ctx.xdg.config, "billion-context");
  fs.mkdirSync(dir, { recursive: true });
  // preserveRecentTokens: 0 — see the file header for why a one-shot run
  // cannot fold under the kernel's default protected-zone token window.
  fs.writeFileSync(
    path.join(dir, "billion-context.json"),
    JSON.stringify({ providers: {}, compress: { preserveRecentTokens: 0 } }, null, 2) + "\n",
  );
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
  // The native proxy is parent-watched and dies with its dsh; kill any
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

type RunResult = { code: number; stdout: string; stderr: string };

// `onFirstStamped` fires once, MID-RUN, at the moment the first plugin-stamped
// request lands on the fake upstream — the window where the hermetic proxy is
// guaranteed alive, used to probe the /acp status endpoint (acceptance #2).
function dshRun(
  ctx: Ctx,
  task: string,
  onFirstStamped?: (conv: string) => Promise<void>,
): Promise<RunResult> {
  const child = spawn(DSH_BIN, ["--profile", "headless", task], {
    cwd: ctx.dshCwd,
    env: {
      ...cleanEnv(),
      HOME: ctx.homeDir,
      TMPDIR: ctx.tmpDir,
      DSH_HOME: ctx.dshHome,
      XDG_CONFIG_HOME: ctx.xdg.config,
      XDG_CACHE_HOME: ctx.xdg.cache,
      XDG_STATE_HOME: ctx.xdg.state,
      XDG_DATA_HOME: ctx.xdg.data,
      E2E_FAKE_KEY: "e2e-fake-key",
      DSH_TELEMETRY_MODE: "DISABLED",
      LANG: "C.UTF-8",
      // #1158/#1187 coexistence: activate the non-direct dispatcher policy
      // path with dead loopback targets (LOOPBACK_NO_PROXY keeps fixture
      // traffic direct — see file header).
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
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
  }, TMO);
  let hookDone: Promise<void> | undefined;
  let notified = false;
  const poll = setInterval(() => {
    if (notified || !fs.existsSync(ctx.reqLog)) return;
    try {
      for (const o of readOracle(ctx.reqLog)) {
        if (o.plugin === "dsh" && o.conv) {
          notified = true;
          clearInterval(poll);
          if (onFirstStamped) hookDone = onFirstStamped(o.conv);
          return;
        }
      }
    } catch {
      /* partial line */
    }
  }, 250);
  return new Promise((resolve, reject) => {
    child.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(e);
    });
    child.on("exit", async (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      if (hookDone) {
        try {
          await hookDone;
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
      }
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

// Acceptance #2: the /acp command's backend endpoint, probed WHILE the run is
// live (the parent-watched proxy dies with dsh, so post-exit probing races
// shutdown). The instance record appears when the native bootstrap spawns the
// proxy — before the first request can land.
async function probePluginStatus(ctx: Ctx, conv: string): Promise<void> {
  const instancesDir = path.join(ctx.xdg.state, "billion-context", "instances");
  let origin: string | undefined;
  const deadline = Date.now() + 30_000;
  while (!origin && Date.now() < deadline) {
    try {
      for (const f of fs.readdirSync(instancesDir)) {
        const rec = JSON.parse(
          fs.readFileSync(path.join(instancesDir, f), "utf8"),
        ) as { origin?: string };
        if (typeof rec.origin === "string") {
          origin = rec.origin;
          break;
        }
      }
    } catch {
      /* not written yet */
    }
    if (!origin) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(origin, "instance record with proxy origin must exist mid-run");
  const res = await fetch(
    `${origin}/__bili/plugin/status?conversationId=${encodeURIComponent(conv)}`,
  );
  assert.equal(res.status, 200, `/__bili/plugin/status must answer 200 (got ${res.status})`);
  const body = (await res.json()) as { ok?: boolean; conversationId?: string };
  assert.equal(
    body.ok,
    true,
    `status endpoint must report the bound conversation ok:true (got ${JSON.stringify(body).slice(0, 160)})`,
  );
}

test(
  "preflight: dsh binary + built dist + wired headless profile + fake upstream (E2E_CHECK)",
  { skip: skipReason },
  async (t) => {
    assert.ok(dshAvailable(), `dsh binary "${DSH_BIN}" must run --version`);
    assert.ok(distBuilt(), `dist entry ${DSH_NATIVE_ENTRY} missing — run \`npm run build\``);
    const ctx = await startCtx();
    t.after(() => teardown(ctx));
    const profilePkg = JSON.parse(
      fs.readFileSync(
        path.join(ctx.dshHome, "profiles", "headless", "package.json"),
        "utf8",
      ),
    ) as { dsh?: { profile?: { bundles?: string[] } } };
    assert.ok(
      profilePkg.dsh?.profile?.bundles?.includes("billion-context"),
      "headless profile must bundle billion-context",
    );
    assert.ok(
      fs.existsSync(path.join(ctx.dshHome, "profiles", "headless", "node_modules", "billion-context", "dist", "agent", "dsh-native.js")),
      "profile node_modules must carry the built dsh-native entry",
    );
    const oracle = readOracle(ctx.reqLog);
    assert.equal(oracle.length, 0, "no requests before any dsh run");
  },
);

if (checkOnly) {
  // E2E_CHECK=1 stops after the zero-token preflight above.
} else {
  test(
    "native dsh headless one-shot: intercepted + claimed on EVERY hop, /acp status live, acp_status + compress really execute",
    { skip: suiteSkipReason },
    async (t) => {
      const ctx = await startCtx();
      t.after(() => teardown(ctx));

      const r = await dshRun(ctx, TASK, (conv) => probePluginStatus(ctx, conv));
      assert.equal(
        r.code,
        0,
        `dsh headless failed (code=${r.code}); stderr:\n${r.stderr}`,
      );
      assert.match(
        r.stdout,
        /收到#done/,
        `dsh should finish the scripted loop; stdout:\n${r.stdout}`,
      );
      // Plugin mode means the CLIENT owns tool execution: the proxy never
      // injects its wire-mode visibility marker into the response stream.
      assert.doesNotMatch(
        r.stdout,
        /\[ACP\][^\n]*result:/,
        `stdout must not carry the wire-mode ACP visibility marker (plugin mode), got:\n${r.stdout.slice(0, 400)}`,
      );

      const oracle = readOracle(ctx.reqLog);
      assert.ok(
        oracle.length >= 5,
        `expected >=5 upstream requests (R1, 3x acp_status rounds, final), got ${oracle.length}`,
      );
      // Acceptance #1 + #1268 stamp-race discipline: EVERY forwarded request —
      // starting with R1 — carries the plugin identity and ONE shared native
      // conversation id (also the L1 patch-chain survival assertion under the
      // active third-party dispatcher policy).
      const convs = new Set<string>();
      for (const o of oracle) {
        assert.equal(
          o.plugin,
          "dsh",
          `request must be plugin-stamped (x-bili-plugin), got ${o.plugin} (nmsg=${o.nmsg})`,
        );
        assert.ok(
          o.conv && o.conv.length > 0,
          "request must carry x-bili-plugin-conversation",
        );
        assert.match(
          o.conv!,
          /^session-/,
          `conversation id must be dsh's native session id, got ${o.conv}`,
        );
        convs.add(o.conv!);
      }
      assert.equal(
        convs.size,
        1,
        `every hop must share one conversation, got ${[...convs].join(", ")}`,
      );
      const withAcp = oracle.filter((o) =>
        ACP_TOOLS.every((name) => o.tools.includes(name)),
      );
      assert.ok(
        withAcp.length >= 1,
        "ACP tools must be registered on follow-up requests",
      );

      // Acceptance #3: acp_status executed client-side, result re-sent.
      const status = oracle.find((o) =>
        o.toolResults.some((tr) => tr.name === "acp_status"),
      );
      assert.ok(status, "acp_status must have been called and its result re-sent");
      const statusResult = status.toolResults.find((tr) => tr.name === "acp_status");
      assert.ok(statusResult, "acp_status tool result entry must exist");
      assert.match(
        statusResult.content,
        /ACTIVE SURFACE[\s\S]*CONTEXT BREAKDOWN/,
        "acp_status result must be the status report",
      );

      // Acceptance #4: compress really folded.
      const foldRows = oracle.filter((o) =>
        o.toolResults.some((tr) => tr.name === "compress"),
      );
      assert.ok(foldRows.length >= 1, "compress must have been called and its result re-sent");
      const compressResult =
        foldRows[0]?.toolResults.find((tr) => tr.name === "compress")?.content ?? "";
      assert.ok(compressResult.length > 0, "compress tool result entry must exist");
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
      assert.match(
        biliLog(ctx),
        /tool compress executed via plugin/,
        "proxy must log the plugin-channel compress execution",
      );

      // Plugin-mode binding on the proxy side, not just on the wire. Sessions
      // persist lazily — flush rides graceful shutdown.
      await stopProxiesGracefully(ctx);
      const sessions = sessionFiles(ctx);
      assert.ok(sessions.length >= 1, "proxy must persist the session");
      assert.ok(
        sessions.every((s) => s.parsed.payload?.metadata?.pluginAgent === "dsh"),
        `sessions must bind pluginAgent=dsh, got ${JSON.stringify(sessions.map((s) => s.parsed.payload?.metadata?.pluginAgent))}`,
      );
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
}
