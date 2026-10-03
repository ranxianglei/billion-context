import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";

process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? "1";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInitialState } from "acp-kernel";
import { createAcpExtension, inProcessDisabled } from "../src/agent/pi-inprocess/index.js";
import { PROXY_STAND_DOWN_MESSAGE, nativeStandDownMessage } from "../src/agent/pi-inprocess/proxy-detect.js";
import { SessionStateStore } from "../src/agent/pi-inprocess/state.js";
import { BLOCK_V1_SCHEMA, SIDECAR_SCHEMA_VERSION, sidecarProducer } from "../src/agent/pi-inprocess/contract-entry.js";

const ENV_KEYS = [
  "BILLION_CONTEXT_NATIVE",
  "BILLION_CONTEXT_PROXY",
  "BILI_PI_INPROC",
  "BILI_PROVIDER_REWRITES",
  "HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_HOME",
];

function withCleanEnv(mut: (env: NodeJS.ProcessEnv) => void): () => void {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  for (const k of ENV_KEYS) delete process.env[k];
  mut(process.env);
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function captureApi() {
  const handlers = new Map<string, Handler[]>();
  const tools: string[] = [];
  const commands = new Set<string>();
  const api = {
    on(name: string, fn: Handler) {
      const arr = handlers.get(name) ?? [];
      arr.push(fn);
      handlers.set(name, arr);
    },
    registerTool(t: { name?: string }) {
      if (t?.name) tools.push(t.name);
    },
    registerCommand(name: string) {
      commands.add(name);
    },
  };
  return { api: api as unknown as ExtensionAPI, handlers, tools, commands };
}

function makeCtx(over: Record<string, unknown> = {}) {
  const notes: Array<{ msg: string; kind?: string }> = [];
  const cwd = process.cwd();
  return {
    notes,
    hasUI: true,
    ui: { notify: (msg: string, kind?: string) => notes.push({ msg, kind }) },
    sessionManager: { getSessionId: () => "sid-wiring", buildContextEntries: () => [] },
    model: { baseUrl: "https://api.openai.com/v1", id: "gpt-test", contextWindow: 200000 },
    cwd,
    ...over,
  };
}

async function startSession(api: ReturnType<typeof captureApi>, ctx: Parameters<Handler>[1]): Promise<void> {
  const h = api.handlers.get("session_start");
  assert.ok(h && h.length > 0, "session_start handler registered");
  await h[0]!({}, ctx);
}

test("inProcessDisabled parses kill-switch values", () => {
  const restore = withCleanEnv(() => {});
  try {
    assert.equal(inProcessDisabled(), false, "unset → enabled");
    for (const v of ["1", "true", "on", "yes", "TRUE"]) {
      process.env.BILI_PI_INPROC = v;
      assert.equal(inProcessDisabled(), false, `${v} → enabled`);
    }
    for (const v of ["0", "false", "off", "no", " OFF ", "No"]) {
      process.env.BILI_PI_INPROC = v;
      assert.equal(inProcessDisabled(), true, `${v} → disabled`);
    }
  } finally {
    restore();
  }
});

test("default mode: in-process runs, stamps own marker, registers compress tool, no fetch patch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-inproc-wiring-"));
  const restore = withCleanEnv((env) => {
    env.HOME = dir;
    env.XDG_DATA_HOME = path.join(dir, ".local", "share");
    env.XDG_STATE_HOME = path.join(dir, ".local", "state");
  });
  const cap = captureApi();
  const fetchBefore = globalThis.fetch;
  try {
    createAcpExtension({ autoUpdate: false })(cap.api);
    const ctx = makeCtx({ cwd: dir });
    await startSession(cap, ctx);
    assert.equal(process.env.BILLION_CONTEXT_NATIVE, "pi-inprocess", "own marker stamped");
    assert.ok(cap.tools.includes("compress"), `compress tool registered (got ${cap.tools.join(",")})`);
    assert.ok(!ctx.notes.some((n) => n.msg === PROXY_STAND_DOWN_MESSAGE), "no stand-down notice");
    assert.equal(globalThis.fetch, fetchBefore, "globalThis.fetch untouched");
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("kill-switch BILI_PI_INPROC=0 delegates to server-based native (marker 'pi', no in-process tools)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-inproc-wiring-"));
  // Healthy attach target: the pi-native health probe is GET /__bili/plugin/manifest.
  const server = createServer((req, res) => {
    if (req.url === "/__bili/plugin/manifest") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "0.0.0-test" }));
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const restore = withCleanEnv((env) => {
    env.HOME = dir;
    env.XDG_DATA_HOME = path.join(dir, ".local", "share");
    env.XDG_STATE_HOME = path.join(dir, ".local", "state");
    env.BILI_PI_INPROC = "0";
    env.BILLION_CONTEXT_PROXY = `http://127.0.0.1:${port}`;
  });
  let spawnStubbed = false;
  const cap = captureApi();
  try {
    // Dynamic (not top-level) import: startPiNative() runs once per module instance
    // and must evaluate in ATTACH mode — a clean-env first evaluation would mark it
    // started-off and the factory's later dynamic import would never bootstrap.
    const nativeMod = await import("../src/agent/pi-native.js");
    nativeMod._setSpawnForTest(async () => undefined);
    spawnStubbed = true;
    createAcpExtension({ autoUpdate: false })(cap.api);
    const deadline = Date.now() + 5000;
    while (process.env.BILLION_CONTEXT_NATIVE !== "pi" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(process.env.BILLION_CONTEXT_NATIVE, "pi", "server-based native stamped its marker");
    assert.ok(!cap.tools.includes("compress"), "in-process compress tool NOT registered");
  } finally {
    if (spawnStubbed) {
      const nativeMod = await import("../src/agent/pi-native.js");
      nativeMod._setSpawnForTest(undefined);
    }
    restore();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("stand-down symmetry: foreign marker and proxy signals refuse, own marker does not", async () => {
  // BILLION_CONTEXT_PROXY set at factory time is a FACTORY-level refusal
  // (silent early return, nothing wired); the other signals can only appear
  // after load (async bootstrap #461, manual wiring #296) and are checked
  // lazily per event with a UI warning.
  const cases: Array<{
    name: string;
    env: Record<string, string>;
    ctxOver?: Record<string, unknown>;
    expectMsg?: string;
    factoryRefusal?: boolean;
  }> = [
    { name: "foreign native marker", env: { BILLION_CONTEXT_NATIVE: "pi" }, expectMsg: nativeStandDownMessage("pi") },
    { name: "proxy env var", env: { BILLION_CONTEXT_PROXY: "http://127.0.0.1:9999" }, factoryRefusal: true },
    {
      name: "/bili/ baseUrl",
      env: {},
      ctxOver: { model: { baseUrl: "http://127.0.0.1:8787/bili/https://api.openai.com/v1", id: "m", contextWindow: 1000 } },
      expectMsg: PROXY_STAND_DOWN_MESSAGE,
    },
    { name: "provider rewrites owned elsewhere", env: { BILI_PROVIDER_REWRITES: "1" }, expectMsg: PROXY_STAND_DOWN_MESSAGE },
  ];
  for (const c of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-inproc-wiring-"));
    const before = process.env.BILLION_CONTEXT_NATIVE;
    const restore = withCleanEnv((env) => {
      env.HOME = dir;
      env.XDG_DATA_HOME = path.join(dir, ".local", "share");
      env.XDG_STATE_HOME = path.join(dir, ".local", "state");
      Object.assign(env, c.env);
    });
    const cap = captureApi();
    try {
      createAcpExtension({ autoUpdate: false })(cap.api);
      const ctx = makeCtx(c.ctxOver ?? {});
      if (c.factoryRefusal) {
        assert.ok(!cap.handlers.get("session_start")?.length, `${c.name}: nothing wired at factory time`);
      } else {
        await startSession(cap, ctx);
        assert.equal(ctx.notes.length, 1, `${c.name}: exactly one stand-down notice`);
        assert.equal(ctx.notes[0]!.msg, c.expectMsg!, c.name);
        assert.equal(ctx.notes[0]!.kind, "warning");
      }
      const after = process.env.BILLION_CONTEXT_NATIVE;
      if (c.factoryRefusal) {
        assert.equal(after, undefined, `${c.name}: factory-level refusal stamps nothing`);
      } else if (c.env.BILLION_CONTEXT_NATIVE) {
        assert.equal(after, c.env.BILLION_CONTEXT_NATIVE, `${c.name}: foreign marker not clobbered`);
      } else {
        // Event-time refusals happen AFTER the factory stamp (ctx.model only
        // exists on events): the stamp stays, which is the safe outcome — the
        // co-resident bcp is disarmed while the proxy owns the traffic.
        assert.equal(after, "pi-inprocess", `${c.name}: stamp precedes event-time refusal`);
      }
    } finally {
      restore();
      assert.equal(process.env.BILLION_CONTEXT_NATIVE, before === undefined ? undefined : before, "marker restored");
      await rm(dir, { recursive: true, force: true });
    }
  }
  // Own pre-existing marker must NOT stand us down (e.g. our own earlier stamp in this process).
  const dir = await mkdtemp(path.join(tmpdir(), "pi-inproc-wiring-"));
  const restore = withCleanEnv((env) => {
    env.HOME = dir;
    env.XDG_DATA_HOME = path.join(dir, ".local", "share");
    env.XDG_STATE_HOME = path.join(dir, ".local", "state");
    env.BILLION_CONTEXT_NATIVE = "pi-inprocess";
  });
  const cap = captureApi();
  try {
    createAcpExtension({ autoUpdate: false })(cap.api);
    const ctx = makeCtx({ cwd: dir });
    await startSession(cap, ctx);
    assert.equal(ctx.notes.length, 0, "own marker ignored — we are active");
    assert.ok(cap.tools.includes("compress"), "tools registered under own marker");
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy billion-context-pi sidecar loads and re-saves with carried extras", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-inproc-wiring-"));
  const file = path.join(dir, "session.json");
  const base = createInitialState();
  base.blocks.push({
    blockId: "b0",
    runId: "r0",
    tier: 1,
    generation: "young",
    active: true,
    summary: "alpha",
    directMessageIds: ["a"],
    effectiveMessageIds: ["a"],
    directBlockIds: [],
    compressedTokens: 0,
    survivedCount: 1,
    createdAt: 100,
  });
  base.nextBlockId = 1;
  base.messageRefs.byRaw.a = "m00000";
  base.messageRefs.byRef.m00000 = "a";
  const legacyPayload = {
    ...base,
    liveRefOrigins: [],
    derivedFrom: { parentSessionId: "par-1", derivedAt: 123 },
    activePack: "default",
    schemaVersion: 1,
    producer: "billion-context-pi@0.1.83",
  };
  await writeFile(`${file}.acp.json`, JSON.stringify(legacyPayload, null, 2));

  const store = new SessionStateStore();
  const loaded = await store.load(file, "sid-legacy");
  assert.equal(loaded.blocks.length, 1, "blocks survive legacy read");
  assert.equal(loaded.blocks[0]!.blockId, "b0");
  assert.equal(loaded.messageRefs.byRef.m00000, "a");

  // Re-save to the SAME session file: extras are keyed per (sessionFile, sid)
  // slot (bcp's design — pi session files are stable across turns), so an
  // in-place save is what actually happens after the switch.
  await store.save(loaded, file, "sid-legacy");
  const rawOut = JSON.parse(await readFile(`${file}.acp.json`, "utf8")) as Record<string, unknown>;
  assert.deepEqual(rawOut.derivedFrom, { parentSessionId: "par-1", derivedAt: 123 }, "derivedFrom carried across the switch");
  assert.equal(rawOut.activePack, "default", "activePack carried across the switch");
  assert.match(String(rawOut.producer), /^billion-context@/, "producer re-stamped by the new entry");
  await rm(dir, { recursive: true, force: true });
});

test("contract entry exposes the sidecar data contract", async () => {
  assert.equal(SIDECAR_SCHEMA_VERSION, 1);
  assert.match(BLOCK_V1_SCHEMA.$id, /billion-context/);
  assert.match(sidecarProducer(), /^billion-context@\d+\.\d+\.\d+/);
});
