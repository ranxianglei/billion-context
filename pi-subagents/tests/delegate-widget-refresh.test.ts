import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDelegateTool, runningRunsSnapshot, setDelegatePolicy } from "../src/delegate-tool.js";
import { delegateStatusWidget } from "../src/fleet-widget.js";
import { DEFAULT_DELEGATE_POLICY } from "../src/config.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// #2737 regression: the fleet widget must refresh when a run transitions
// queued→running. Before the fix, the only pokes were at run registration
// (status "queued" — excluded from the running snapshot, so refresh() saw an
// empty list and stopped the timer) and at terminal states. On an idle TUI the
// first async run therefore never rendered.

const WIDGET_KEY = "billion-context-pi-delegates";

// Track live interval handles (the widget's 500ms refresh timer) so tests can
// assert deterministically on timer liveness instead of sleeping.
const origSetInterval = globalThis.setInterval;
const origClearInterval = globalThis.clearInterval;
const liveTimers = new Set<unknown>();

before(() => {
  globalThis.setInterval = ((callback: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    const handle = origSetInterval(callback, timeout, ...args);
    liveTimers.add(handle);
    return handle;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle?: unknown) => {
    if (handle !== undefined) liveTimers.delete(handle);
    return origClearInterval(handle as Parameters<typeof clearInterval>[0]);
  }) as unknown as typeof clearInterval;
});

after(() => {
  globalThis.setInterval = origSetInterval;
  globalThis.clearInterval = origClearInterval;
});

interface FakeRun {
  runId: string;
  agent: string;
  task: string;
  startedAt: number;
  status: string;
}

function makeMockUi() {
  const calls: Array<{ key: string; lines: string[] | undefined }> = [];
  const statuses: string[] = [];
  return {
    calls,
    statuses,
    ui: {
      setWidget(key: string, lines: string[] | undefined): void {
        calls.push({ key, lines });
      },
      setStatus(key: string, text: string): void {
        statuses.push(text);
      },
    },
  };
}

function tuiCtx(ui: unknown, cwd: string): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    ui,
    model: { provider: "test", id: "test-model" },
    sessionManager: { buildContextEntries: () => [] },
  } as unknown as ExtensionContext;
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let fixtureDir: string;
let gatedCli: string;
let slowCli: string;

before(async () => {
  fixtureDir = join(tmpdir(), "acp-delegate-widget-test");
  await mkdir(fixtureDir, { recursive: true });
  // Gated fake CLI: stays alive while the sentinel file is absent and exits on
  // the first poll tick that sees it. Lets a test hold a concurrency slot
  // deterministically instead of racing a fixed delay against wall clock.
  const gated = [
    "process.stdin.resume();",
    'const fs = require("fs");',
    "const gate = process.env.PI_TEST_GATE_FILE;",
    "const iv = setInterval(() => {",
    "  let seen = false;",
    "  try { seen = fs.existsSync(gate); } catch { /* unresolvable path: keep waiting */ }",
    "  if (seen) process.exit(0);",
    "}, 20);",
    "setTimeout(() => process.exit(0), 8000);",
    "",
  ].join("\n");
  gatedCli = join(fixtureDir, "fake-pi-gated.cjs");
  slowCli = join(fixtureDir, "fake-pi-slow.js");
  await writeFile(gatedCli, gated, "utf8");
  await writeFile(slowCli, "process.stdin.resume();\nsetTimeout(() => process.exit(0), 900);\n", "utf8");
});

test("widget state machine: queued→running transition needs the launch poke (#2737)", () => {
  const { ui, calls } = makeMockUi();
  const runs: FakeRun[] = [];
  delegateStatusWidget.setContext(tuiCtx(ui, process.cwd()), () => runs.filter((r) => r.status === "running"), "");
  const baseline = liveTimers.size;
  assert.equal(liveTimers.size, baseline, "idle widget holds no timer");
  assert.ok(calls.every((c) => c.lines === undefined), "no widget rendered while empty");

  runs.push({ runId: "r1", agent: "researcher", task: "t", startedAt: Date.now(), status: "queued" });
  delegateStatusWidget.poke();
  assert.equal(liveTimers.size, baseline, "queued-only snapshot keeps the timer stopped");
  assert.ok(calls.every((c) => c.lines === undefined), "queued run alone renders nothing");

  // What launch() does: flip to running, then poke (the #2737 fix).
  runs[0]!.status = "running";
  delegateStatusWidget.poke();
  assert.equal(liveTimers.size, baseline + 1, "launch poke restarts the refresh timer");
  const last = calls[calls.length - 1];
  assert.equal(last?.key, WIDGET_KEY);
  assert.ok(last?.lines?.[0]?.includes("1 running"), `header shows running count: ${JSON.stringify(last)}`);
  assert.ok(last?.lines?.some((l) => l.includes("researcher")), "row names the agent");

  runs.length = 0;
  delegateStatusWidget.dispose();
  assert.equal(liveTimers.size, baseline, "dispose stops the timer");
});

test("idle TUI: first async run renders immediately and clears on finish (#2737)", async () => {
  const { ui, calls } = makeMockUi();
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) } as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const cwd = fixtureDir;
  delegateStatusWidget.setContext(tuiCtx(ui, cwd), runningRunsSnapshot, "");
  const baseline = liveTimers.size;

  process.env.PI_CLI_PATH = slowCli;
  try {
    const res = await tool.execute(
      "tc-widget-idle",
      { agent: "researcher", task: "widget idle repro", async: true },
      undefined,
      undefined,
      tuiCtx(ui, cwd),
    );
    const launch = (res.content[0] as { text?: string }).text ?? "";
    const runId = /`(del_[a-z0-9_]+)`/.exec(launch)?.[1];
    assert.ok(runId, `runId in launch message: ${launch}`);

    const rendered = calls.find((c) => c.lines !== undefined);
    assert.ok(rendered, "widget rendered synchronously after launch (pre-fix: never rendered)");
    assert.equal(rendered!.key, WIDGET_KEY);
    assert.ok(rendered!.lines![0]!.includes("1 running"), `header: ${JSON.stringify(rendered!.lines)}`);
    assert.ok(rendered!.lines!.some((l) => l.includes("researcher")), "row names the agent");
    assert.equal(liveTimers.size, baseline + 1, "refresh timer kept alive");

    await waitFor(() => sent.length >= 1, "completion notification", 10000);
    await waitFor(
      () => calls.slice(calls.findIndex((c) => c.lines !== undefined)).some((c) => c.key === WIDGET_KEY && c.lines === undefined),
      "widget clear after finish",
    );
    assert.equal(liveTimers.size, baseline, "timer stopped once no runs remain");
  } finally {
    delete process.env.PI_CLI_PATH;
  }
});

test("queued run renders once it enters running under maxConcurrent=1 (#2737)", async () => {
  const { ui, calls } = makeMockUi();
  const sent: string[] = [];
  const pi = { sendUserMessage: (t: string) => sent.push(t) } as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const cwd = fixtureDir;
  delegateStatusWidget.setContext(tuiCtx(ui, cwd), runningRunsSnapshot, "");
  const baseline = liveTimers.size;

  // A's child must hold its slot until we say so: the gated CLI exits only
  // when the sentinel file appears, so B can never observe a free slot early
  // (a fixed-delay fake raced wall clock on loaded Windows runners).
  const gateFile = join(fixtureDir, "gate-widget-q");
  await unlink(gateFile).catch(() => {});
  setDelegatePolicy({ ...DEFAULT_DELEGATE_POLICY, maxConcurrent: 1 });
  process.env.PI_CLI_PATH = gatedCli;
  process.env.PI_TEST_GATE_FILE = gateFile;
  try {
    const resA = await tool.execute(
      "tc-widget-q-a",
      { agent: "researcher", task: "first slot holder", async: true },
      undefined,
      undefined,
      tuiCtx(ui, cwd),
    );
    const launchA = (resA.content[0] as { text?: string }).text ?? "";
    assert.ok(!launchA.includes("QUEUED"), "first run starts immediately");

    const resB = await tool.execute(
      "tc-widget-q-b",
      { agent: "worker", task: "queued runner", async: true },
      undefined,
      undefined,
      tuiCtx(ui, cwd),
    );
    const launchB = (resB.content[0] as { text?: string }).text ?? "";
    assert.ok(launchB.includes("QUEUED"), "second run is queued under maxConcurrent=1");

    const early = calls.filter((c) => c.lines !== undefined);
    assert.ok(early.some((c) => c.lines!.some((l) => l.includes("researcher"))), "A rendered while running");
    assert.ok(!calls.some((c) => c.lines !== undefined && c.lines!.some((l) => l.includes("worker"))), "B not rendered while queued");

    // Release A: its child exits on the next poll tick, the FIFO queue drains
    // event-driven and spawns B (whose child sees the sentinel already present
    // and exits promptly). No sleep anywhere on this path.
    await writeFile(gateFile, "", "utf8");
    await waitFor(
      () => calls.some((c) => c.lines !== undefined && c.lines!.some((l) => l.includes("worker"))),
      "B rendered after entering running",
      10000,
    );
    await waitFor(() => sent.length >= 2, "both completions", 15000);
    await waitFor(
      () => [...calls].reverse().find((c) => c.key === WIDGET_KEY)?.lines === undefined,
      "widget cleared after all runs finished",
    );
    assert.equal(liveTimers.size, baseline, "timer stopped once no runs remain");
  } finally {
    setDelegatePolicy(DEFAULT_DELEGATE_POLICY);
    delete process.env.PI_CLI_PATH;
    delete process.env.PI_TEST_GATE_FILE;
    await unlink(gateFile).catch(() => {});
  }
});
