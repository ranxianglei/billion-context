import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDelegateUsage,
  emitInlineUsageNote,
  injectResult,
  makeDelegateTool,
  resetDelegateUsage,
  scheduleRunNotification,
  setDelegatePolicy,
} from "../src/delegate-tool.js";
import { DEFAULT_DELEGATE_POLICY } from "../src/config.js";

// #5750 structured-notification envelope. When delegate.notifyStructured is ON and
// the host exposes ExtensionAPI.sendMessage, each delegate notice is delivered as a
// typed custom message whose `details` carry stable run identity + launch provenance,
// while `content` stays byte-identical to the legacy plain steering message (the model
// sees the same text either way; pi's convertToLlm drops `details`). Default OFF keeps
// the plain path untouched; a host without sendMessage falls back to it. These tests
// drive the same host lifecycle surface as delegate-turn-end-notify.test.ts.

type PiLike = Parameters<typeof makeDelegateTool>[0];

const CUSTOM_TYPE = "billion-context:delegate-notification";

function mkRun(runId: string, status: "completed" | "failed", over: Record<string, unknown> = {}): any {
  return {
    runId,
    agent: "reviewer",
    task: "review X",
    cwd: "/tmp",
    startedAt: 0,
    finishedAt: 1000,
    status,
    result: { code: status === "completed" ? 0 : 1, file: `/tmp/${runId}.out`, body: "boom" },
    ...over,
  };
}

type UserEntry = { t: string; o?: { deliverAs?: string } };
type CustomEntry = {
  m: { customType: string; content: string; display: boolean; details: unknown };
  o?: { deliverAs?: string; triggerTurn?: boolean };
};

/** Mock ExtensionAPI exposing BOTH send channels so a test can assert which fired.
 *  Pass `withSendMessage:false` to model a host lacking the structured channel. */
function mockPi(withSendMessage = true) {
  const user: UserEntry[] = [];
  const custom: CustomEntry[] = [];
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const pi: Record<string, unknown> = {
    sendUserMessage: (t: string, o?: { deliverAs?: string }) => user.push({ t, o }),
    on: (event: string, handler: (...a: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  if (withSendMessage) {
    pi.sendMessage = (m: CustomEntry["m"], o?: { deliverAs?: string; triggerTurn?: boolean }) => custom.push({ m, o });
  }
  const emit = (event: string) => {
    for (const h of handlers.get(event) ?? []) h({});
  };
  return { pi: pi as unknown as PiLike, user, custom, emit };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await sleep(5);
  }
}

const structuredOn = () => setDelegatePolicy({ ...DEFAULT_DELEGATE_POLICY, notifyStructured: true });
const structuredOff = () => setDelegatePolicy(DEFAULT_DELEGATE_POLICY);

type Details = { version: number; kind: string; runs: Array<Record<string, unknown>> };

// ─── default OFF: legacy plain path, byte-for-byte ────────────────────────────

test("default off: notice stays a plain steering user message; sendMessage never touched", async () => {
  structuredOff();
  const { pi, user, custom, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_off", "completed");
  scheduleRunNotification(pi, run);
  await sleep(30);
  emit("turn_end");
  assert.equal(custom.length, 0, "no typed message while the switch is off");
  assert.equal(user.length, 1, "plain user message delivered");
  assert.deepEqual(user[0]!.o, { deliverAs: "steer" }, "steering delivery unchanged");
  assert.ok(user[0]!.t.includes("`del_off`"), "names the run");
  assert.equal(run.injected, true);
});

// ─── ON + host supports sendMessage: typed envelope, content byte-identical ───

test("on + sendMessage present: typed envelope, content byte-identical to the legacy message", async () => {
  // Baseline: exactly what the legacy plain path sends for this run shape.
  structuredOff();
  const base = mockPi();
  makeDelegateTool(base.pi);
  base.emit("agent_start");
  scheduleRunNotification(base.pi, mkRun("del_par", "completed"));
  await sleep(30);
  base.emit("turn_end");
  assert.equal(base.user.length, 1);
  const plainText = base.user[0]!.t;

  // Structured path for the same run shape.
  structuredOn();
  const { pi, user, custom, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_par", "completed");
  scheduleRunNotification(pi, run);
  await sleep(30);
  emit("turn_end");
  assert.equal(user.length, 0, "plain path unused when the host supports sendMessage");
  assert.equal(custom.length, 1, "typed message delivered once");
  const entry = custom[0]!;
  assert.equal(entry.m.customType, CUSTOM_TYPE);
  assert.equal(entry.m.display, true);
  assert.deepEqual(entry.o, { deliverAs: "steer", triggerTurn: true }, "steering delivery + idle-host wake parity");
  assert.equal(entry.m.content, plainText, "model-visible text byte-identical to the legacy message");
  const d = entry.m.details as Details;
  assert.equal(d.version, 1);
  assert.equal(d.kind, "terminal");
  assert.equal(d.runs.length, 1);
  assert.equal(d.runs[0]!.runId, "del_par");
  assert.equal(d.runs[0]!.status, "completed");
  assert.equal(run.injected, true, "marked delivered on successful send");
});

// ─── ON + host lacks sendMessage: capability gate falls back to plain ─────────

test("on + no sendMessage: capability gate falls back to the plain user message", async () => {
  structuredOn();
  const { pi, user, custom, emit } = mockPi(false);
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_fb", "completed");
  scheduleRunNotification(pi, run);
  await sleep(30);
  emit("turn_end");
  assert.equal(custom.length, 0, "nothing typed — host has no sendMessage");
  assert.equal(user.length, 1, "plain fallback delivered");
  assert.deepEqual(user[0]!.o, { deliverAs: "steer" });
  assert.ok(user[0]!.t.includes("`del_fb`"));
  assert.equal(run.injected, true, "fallback still marks delivered");
});

// ─── batch lists every run explicitly + provenance carried / cleanly absent ───

test("batch envelope lists every run; launch provenance carried when set, absent when not", async () => {
  structuredOn();
  const { pi, custom, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  scheduleRunNotification(pi, mkRun("del_prov", "completed", { originToolCallId: "call_abc", sourceSessionId: "sess_1" }));
  scheduleRunNotification(pi, mkRun("del_noprov", "failed"));
  emit("turn_end");
  assert.equal(custom.length, 1, "close finishes merge into ONE message");
  const d = custom[0]!.m.details as Details;
  assert.equal(d.kind, "terminal");
  assert.equal(d.runs.length, 2, "every run in the batch is listed explicitly");
  const byId: Record<string, Record<string, unknown>> = {};
  for (const r of d.runs) byId[String(r.runId)] = r;
  assert.equal(byId["del_prov"]?.originToolCallId, "call_abc", "launching tool-call anchor preserved");
  assert.equal(byId["del_prov"]?.sourceSessionId, "sess_1", "source session preserved");
  assert.equal(byId["del_noprov"]?.originToolCallId, undefined, "absent provenance stays absent, never fabricated");
  assert.equal(byId["del_noprov"]?.sourceSessionId, undefined);
});

// ─── idle tier also routes through the structured envelope ─────────────────────

test("idle wake: single finish delivers the typed envelope immediately", async () => {
  structuredOn();
  const { pi, user, custom } = mockPi();
  makeDelegateTool(pi);
  scheduleRunNotification(pi, mkRun("del_idle", "completed"));
  await waitFor(() => custom.length === 1 || user.length === 1, "idle wake");
  assert.equal(user.length, 0);
  assert.equal(custom.length, 1);
  assert.equal(custom[0]!.m.customType, CUSTOM_TYPE);
  assert.deepEqual(custom[0]!.o, { deliverAs: "steer", triggerTurn: true });
  assert.equal((custom[0]!.m.details as Details).kind, "terminal");
});

// ─── injectResult (wait/cancel direct path) dispatches through the envelope ───

test("on: injectResult delivers the typed envelope and reports success", () => {
  structuredOn();
  const { pi, user, custom } = mockPi();
  const ok = injectResult(pi, "reviewer", "del_inj", "review X", "completed", 0, "/tmp/del_inj.out");
  assert.equal(ok, true, "structured send reported as delivered");
  assert.equal(user.length, 0);
  assert.equal(custom.length, 1);
  assert.equal(custom[0]!.m.customType, CUSTOM_TYPE);
  assert.deepEqual(custom[0]!.o, { deliverAs: "steer", triggerTurn: true });
  assert.ok(custom[0]!.m.content.includes("`del_inj`"), "same notification text");
});

test("off: injectResult keeps the plain path", () => {
  structuredOff();
  const { pi, user, custom } = mockPi();
  const ok = injectResult(pi, "reviewer", "del_inj2", "review X", "failed", 1, "/tmp/del_inj2.out");
  assert.equal(ok, true);
  assert.equal(custom.length, 0);
  assert.equal(user.length, 1);
  assert.deepEqual(user[0]!.o, { deliverAs: "steer" });
});

// ─── usage summaries are kind:"usage" (dedup-friendly vs terminal notices) ────

const USAGE_FIXTURE = { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { input: 0.0015, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0023 } };

test("on: inline usage note is a typed envelope with kind usage", () => {
  structuredOn();
  resetDelegateUsage();
  addDelegateUsage(USAGE_FIXTURE);
  const { pi, user, custom } = mockPi();
  const run = mkRun("del_usage", "completed");
  emitInlineUsageNote(pi, run, "separate");
  assert.equal(user.length, 0);
  assert.equal(custom.length, 1, "typed usage note delivered once");
  const entry = custom[0]!;
  assert.equal(entry.m.customType, CUSTOM_TYPE);
  assert.ok(entry.m.content.includes("usage summary"), "same usage-summary text as before");
  assert.ok(entry.m.content.includes("`del_usage`"), "names the run");
  const d = entry.m.details as Details;
  assert.equal(d.kind, "usage", "distinguishable from terminal notices (dedup-friendly)");
  assert.equal(d.runs.length, 1);
  assert.equal(d.runs[0]!.runId, "del_usage");
  assert.equal(run.usageNoted, true, "marked noted only after successful send");
});

test("off: inline usage note stays a plain user message", () => {
  structuredOff();
  resetDelegateUsage();
  addDelegateUsage(USAGE_FIXTURE);
  const { pi, user, custom } = mockPi();
  emitInlineUsageNote(pi, mkRun("del_usage_off", "completed"), "separate");
  assert.equal(custom.length, 0);
  assert.equal(user.length, 1);
  assert.deepEqual(user[0]!.o, { deliverAs: "steer" });
});
