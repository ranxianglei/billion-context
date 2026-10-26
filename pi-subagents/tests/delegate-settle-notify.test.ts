import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeDelegateTool,
  scheduleRunNotification,
  flushDelegateNotifications,
  setDelegateNotifyIfRead,
} from "../src/delegate-tool.js";

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
    result: { code: 1, file: `/tmp/${runId}.out`, body: "boom" },
    ...over,
  };
}

/** Mock ExtensionAPI: captures sends and can emit host lifecycle events so the
 *  settle-gated commit path can be driven deterministically. */
function mockPi() {
  const sent: string[] = [];
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const pi = {
    sendUserMessage: (t: string) => void sent.push(t),
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
// Poll until a condition holds (matches the deadline-loop convention used in
// delegate-read-suppress.test.ts) rather than assuming a single macrotask
// boundary — the commit is deferred via setTimeout(0) and must not race the
// assertion.
async function waitFor(cond: () => boolean, what: string, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await sleep(5);
  }
}

// ─── #2301: the read must be honored at COMMIT time, not a fixed timer ──────

test("read-before-settle drops the notification (the #2301 stale-follow-up)", async () => {
  setDelegateNotifyIfRead("skip");
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi); // registers the agent_start/agent_settled handlers
  emit("agent_start"); // host is actively working
  const run = mkRun("del_read_a", "completed");
  scheduleRunNotification(pi, run);
  run.readAt = run.finishedAt; // model reads the result while still working
  await sleep(30);
  assert.equal(sent.length, 0, "nothing committed while the host is busy");
  emit("agent_settled"); // host goes idle -> read-checked commit boundary
  await sleep(30);
  assert.equal(sent.length, 0, "already-read result is NOT injected");
  assert.equal(run.readSuppressed, true, "recorded as suppressed, not delivered");
});

test("unread completed run is delivered at the settle boundary", async () => {
  setDelegateNotifyIfRead("skip");
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_unread", "completed");
  scheduleRunNotification(pi, run);
  await sleep(30);
  assert.equal(sent.length, 0, "held while the host is busy");
  emit("agent_settled");
  await waitFor(() => sent.length === 1, "delivery at settle");
  assert.ok(sent[0]!.includes("`del_unread`"), "names the run");
  assert.equal(run.injected, true);
});

// ─── proactivity preserved: an idle host is still woken promptly ────────────

test("finish while the host is idle delivers without waiting for a settle", async () => {
  const { pi, sent } = mockPi();
  makeDelegateTool(pi);
  const run = mkRun("del_idle", "completed");
  scheduleRunNotification(pi, run); // activeRuns === 0 -> immediate deferred flush
  await waitFor(() => sent.length === 1, "idle wake");
  assert.ok(sent[0]!.includes("`del_idle`"));
});

// ─── coalescing (#157) survives the settle gate ─────────────────────────────

test("multiple busy finishes coalesce into one message at settle", async () => {
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const a = mkRun("del_c1", "completed");
  const b = mkRun("del_c2", "failed");
  scheduleRunNotification(pi, a);
  scheduleRunNotification(pi, b);
  await sleep(30);
  assert.equal(sent.length, 0, "held while the host is busy");
  emit("agent_settled");
  await waitFor(() => sent.length === 1, "coalesced delivery");
  assert.ok(sent[0]!.includes("`del_c1`") && sent[0]!.includes("`del_c2`"), "both runs named");
});

// ─── failures stay loud regardless of reads ─────────────────────────────────

test("a failed run read before settle is STILL notified", async () => {
  setDelegateNotifyIfRead("skip");
  const { pi, sent, emit } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_fail", "failed");
  scheduleRunNotification(pi, run);
  run.readAt = run.finishedAt; // a read of a failure cannot prove the outcome
  emit("agent_settled");
  await waitFor(() => sent.length === 1, "FAILED delivery");
  assert.match(sent[0]!, /FAILED/);
  assert.equal(run.readSuppressed, undefined, "failure was not read-suppressed");
});

test("always mode delivers even when the result was read", async () => {
  setDelegateNotifyIfRead("always");
  try {
    const { pi, sent, emit } = mockPi();
    makeDelegateTool(pi);
    emit("agent_start");
    const run = mkRun("del_always", "completed");
    scheduleRunNotification(pi, run);
    run.readAt = run.finishedAt;
    emit("agent_settled");
    await waitFor(() => sent.length === 1, "always-mode delivery");
  } finally {
    setDelegateNotifyIfRead("skip");
  }
});

// ─── direct-flush parity & robustness ────────────────────────────────────────

test("direct flush honors the same read-check (no reliance on events)", () => {
  setDelegateNotifyIfRead("skip");
  const { pi, sent } = mockPi();
  const read = mkRun("del_direct_read", "completed", { readAt: 1000 });
  const fresh = mkRun("del_direct_fresh", "completed");
  scheduleRunNotification(pi, read);
  scheduleRunNotification(pi, fresh);
  flushDelegateNotifications();
  assert.equal(sent.length, 1, "only the unread run is committed");
  assert.ok(sent[0]!.includes("`del_direct_fresh`"));
  assert.ok(!sent[0]!.includes("`del_direct_read`"));
});

test("makeDelegateTool tolerates a partial extension surface (no .on)", () => {
  // A stub lacking lifecycle-event support must not break tool registration;
  // delivery degrades to the idle-at-finish path.
  const bare = { sendUserMessage: () => {} } as unknown as PiLike;
  assert.doesNotThrow(() => makeDelegateTool(bare));
});
