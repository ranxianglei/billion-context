import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findUndeliveredRuns,
  makeDelegateTool,
  scheduleRunNotification,
  setDelegateNotifyIfRead,
} from "../src/delegate-tool.js";

// #2546 busy-tier contract: while the host is mid-task, a finished delegate's
// notification must be committed at the next TURN BOUNDARY (the `turn_end`
// event — right before the agent loop drains steering for the next model call)
// as a PERSISTED steering user message: pi writes it to the session and every
// later request keeps it. It must not park until the task ends (#2320) and it
// must not ride request-locally on one outgoing message list (the old `context`
// append vanished from later requests, breaking stateful upstream sessions).
// These tests drive the host lifecycle events deterministically through the
// same mock surface as delegate-settle-notify.test.ts.

type PiLike = Parameters<typeof makeDelegateTool>[0];

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

type SentEntry = { t: string; o?: { deliverAs?: string } };

/** Mock ExtensionAPI capturing sends WITH options and able to fire lifecycle
 *  events. `sendImpl` overrides the default capture for failure-path tests. */
function mockPi(sendImpl?: (t: string, o?: { deliverAs?: string }, sent: SentEntry[]) => void) {
  const sent: SentEntry[] = [];
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const pi = {
    sendUserMessage: (t: string, o?: { deliverAs?: string }) => {
      if (sendImpl) sendImpl(t, o, sent);
      else sent.push({ t, o });
    },
    on: (event: string, handler: (...a: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as PiLike;
  const emit = (event: string) => {
    for (const h of handlers.get(event) ?? []) h({});
  };
  return { pi, sent, emit };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await sleep(5);
  }
}

// ─── busy tier: commit at the next turn boundary, mid-task ──────────────────

test("busy host: notification commits as a persisted steering message at the next turn_end (#2546)", async () => {
  setDelegateNotifyIfRead("skip");
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start"); // host is mid-task
  const run = mkRun("del_busy", "completed");
  scheduleRunNotification(pi, run);
  await sleep(30);
  assert.equal(sent.length, 0, "nothing sent before a turn boundary");

  // The current turn's tool execution finishes — the notification must go out
  // as a steering message that pi persists into the session.
  emit("turn_end");
  assert.equal(sent.length, 1, "exactly ONE message committed at the boundary");
  assert.deepEqual(sent[0]!.o, { deliverAs: "steer" }, "persisted steering delivery");
  assert.ok(sent[0]!.t.includes("`del_busy`"), "names the run");
  assert.equal(run.injected, true, "marked delivered on successful send");
  assert.equal(run.notifyQueued, false);

  // Task ends shortly after: nothing may be delivered AGAIN.
  emit("agent_settled");
  await sleep(30);
  assert.equal(sent.length, 1, "no double delivery at the settle boundary");
});

test("busy host: read-before-boundary drops the notification at commit time (#2301)", async () => {
  setDelegateNotifyIfRead("skip");
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_te_read", "completed");
  scheduleRunNotification(pi, run);
  run.readAt = run.finishedAt; // model claims the result before the boundary
  emit("turn_end");
  assert.equal(sent.length, 0, "nothing survives the re-check -> nothing sent");
  assert.equal(run.readSuppressed, true, "recorded as suppressed");
  assert.equal(run.injected, true, "suppression marks it handled so no tier can deliver it");
  emit("agent_settled");
  await sleep(30);
  assert.equal(sent.length, 0, "suppressed run never reaches the idle tier either");
});

test("busy host: failed run commits even when its output was read", async () => {
  setDelegateNotifyIfRead("skip");
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_te_fail", "failed");
  scheduleRunNotification(pi, run);
  run.readAt = run.finishedAt;
  emit("turn_end");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.t, /FAILED/, "failures stay loud");
  assert.equal(run.readSuppressed, undefined);
});

test("busy host: close-together finishes merge into ONE steering message", async () => {
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const a = mkRun("del_m1", "completed");
  const b = mkRun("del_m2", "failed");
  scheduleRunNotification(pi, a);
  scheduleRunNotification(pi, b);
  emit("turn_end");
  assert.equal(sent.length, 1, "one merged message, not two");
  assert.ok(sent[0]!.t.includes("`del_m1`") && sent[0]!.t.includes("`del_m2`"), "both runs named");
  assert.ok(sent[0]!.t.includes("2 delegates finished"), "batch header");
  assert.equal(a.injected, true);
  assert.equal(b.injected, true);
});

test("busy host: a run finishing after one boundary commits at the NEXT turn_end", async () => {
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const a = mkRun("del_seq_a", "completed");
  scheduleRunNotification(pi, a);
  emit("turn_end");
  assert.equal(sent.length, 1, "first run commits at its boundary");
  assert.ok(!sent[0]!.t.includes("`del_seq_b`"));

  const b = mkRun("del_seq_b", "completed");
  scheduleRunNotification(pi, b);
  await sleep(30);
  assert.equal(sent.length, 1, "still busy: no commit before the next boundary");
  emit("turn_end");
  assert.equal(sent.length, 2, "second run commits at the next boundary");
  assert.ok(sent[1]!.t.includes("`del_seq_b`"));
  assert.equal(b.injected, true);
});

test("busy host: waiter-owned runs are excluded from the boundary commit", async () => {
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const parked = mkRun("del_parked", "completed", { waiter: {} });
  const free = mkRun("del_free", "completed");
  scheduleRunNotification(pi, parked);
  scheduleRunNotification(pi, free);
  emit("turn_end");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.t.includes("`del_free`"));
  assert.ok(!sent[0]!.t.includes("`del_parked`"), "wait-owned result stays with the wait path");
  assert.ok(!parked.injected, "waiter run untouched — the wait path owns its delivery");
});

test("busy host: send failure keeps the batch scheduled for the next boundary", async () => {
  const { pi, sent, emit } = mockPi((t, o, s) => {
    throw new Error("host rejected the message");
  });
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_sendfail", "completed");
  scheduleRunNotification(pi, run);
  await sleep(30);
  emit("turn_end");
  assert.equal(sent.length, 0, "failed send delivers nothing");
  assert.equal(run.injected, undefined, "not marked delivered");
  assert.equal(run.notifyQueued, true, "still scheduled for retry");
  emit("agent_settled");
  await sleep(30);
  assert.equal(sent.length, 0, "the idle flush fails against the same broken sender too");
  assert.equal(run.injected, undefined, "a failed flush never marks delivered");
  assert.equal(findUndeliveredRuns([run]).length, 1, "recovery stays available via the undelivered-notice path");
});

// ─── per-host isolation: sessions never leak notifications across hosts ─────

test("two hosts: each boundary commits only its own queued runs", async () => {
  const A = mockPi();
  const B = mockPi();
  makeDelegateTool(A.pi);
  makeDelegateTool(B.pi);
  A.emit("agent_start");
  B.emit("agent_start");
  const ra = mkRun("del_hostA", "completed");
  const rb = mkRun("del_hostB", "completed");
  scheduleRunNotification(A.pi, ra);
  scheduleRunNotification(B.pi, rb);
  await sleep(30);
  assert.equal(A.sent.length, 0);
  assert.equal(B.sent.length, 0);

  A.emit("turn_end");
  assert.equal(A.sent.length, 1);
  assert.ok(A.sent[0]!.t.includes("`del_hostA`"));
  assert.ok(!A.sent[0]!.t.includes("`del_hostB`"), "host A never sees host B's run");
  assert.equal(rb.notifyQueued, true, "host B's run still pending");

  B.emit("turn_end");
  assert.equal(B.sent.length, 1);
  assert.ok(B.sent[0]!.t.includes("`del_hostB`"));
  assert.ok(!B.sent[0]!.t.includes("`del_hostA`"));
});

// ─── idle tier: ONE merged steering message starts the follow-up turn ───────

test("idle host: single finish wakes with ONE steering message (#2320)", async () => {
  const { pi, sent } = mockPi();
  makeDelegateTool(pi);
  const run = mkRun("del_idle_steer", "completed");
  scheduleRunNotification(pi, run);
  await waitFor(() => sent.length === 1, "idle wake");
  assert.ok(sent[0]!.t.includes("`del_idle_steer`"));
  assert.deepEqual(sent[0]!.o, { deliverAs: "steer" }, "steering, not follow-up");
});

test("idle host: multiple finishes coalesce into ONE steering message", async () => {
  const { pi, sent } = mockPi();
  makeDelegateTool(pi);
  const a = mkRun("del_ib1", "completed");
  const b = mkRun("del_ib2", "failed");
  scheduleRunNotification(pi, a);
  scheduleRunNotification(pi, b);
  await waitFor(() => sent.length === 1, "coalesced idle wake");
  assert.ok(sent[0]!.t.includes("`del_ib1`") && sent[0]!.t.includes("`del_ib2`"));
  assert.deepEqual(sent[0]!.o, { deliverAs: "steer" });
});
