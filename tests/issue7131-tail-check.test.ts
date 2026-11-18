// #7131 — tail-check observation: one line per judged request showing the last
// message on each side (role + 8-hex hash) and whether the last user message
// survives entry→exit. A CLEAN judge verdict says nothing about whether the
// INBOUND body carried the host's newest message (a host that builds the
// request from a stale history snapshot judges clean and the model answers the
// previous turn) — this line makes the tail readable without a body dump.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CoreMessage } from "acp-kernel";
import {
  judgeInboundOutbound,
  maybeRunInvariantJudge,
  computeTailCheck,
  _setInvariantJudgeForTest,
  _setInvariantJudgeFaultForTest,
  type JudgeVerdict,
} from "../src/invariant-judge.js";
import { setLogCapture } from "../src/logger.js";

let n = 0;
function mk(role: CoreMessage["role"], contentType: CoreMessage["contentType"], text?: string, extra: Partial<CoreMessage> = {}): CoreMessage {
  n++;
  return { id: `m${String(n).padStart(5, "0")}`, role, contentType, ...(text !== undefined ? { text } : {}), ...extra };
}
const TAG = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";
function tagged(t: string): string { return `${t}\n${TAG}`; }
function h8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

test("tail-check identity: entry == exit ending in a user message", () => {
  const a = [mk("user", "text", "hello"), mk("assistant", "text", "hi"), mk("user", "text", "new question")];
  const t = computeTailCheck(a, a);
  assert.equal(t.inRole, "user");
  assert.equal(t.outRole, "user");
  assert.equal(t.inHash, h8("new question"));
  assert.equal(t.outHash, h8("new question"));
  assert.equal(t.lastUserMatch, true);
});

test("tail-check stale-inbound (the #7131 shape): inbound already lacks the newest message, bili forwards faithfully -> verdict clean, tail shows the OLD tail", () => {
  // The host built the body from a stale snapshot: the last user message is the
  // PREVIOUS question. Bili is faithful (exit == entry), so the judge is clean —
  // the tail line is what exposes that the inbound tail is the old question.
  const entry = [mk("user", "text", "previous question"), mk("assistant", "text", "previous answer")];
  const exit = [...entry];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true);
  const t = computeTailCheck(entry, exit);
  assert.equal(t.inRole, "assistant");
  assert.equal(t.inHash, h8("previous answer"));
  assert.equal(t.outHash, h8("previous answer"));
  assert.equal(t.lastUserMatch, true); // inbound and outbound agree — the staleness is upstream of bili
  assert.notEqual(t.inHash, h8("the newest question"));
});

test("tail-check bili-drop: inbound carries the newest user message, outbound ends earlier -> last-user=no", () => {
  const entry = [mk("user", "text", "q1"), mk("assistant", "text", "a1"), mk("user", "text", "the newest question")];
  const exit = [mk("user", "text", "q1"), mk("assistant", "text", "a1")];
  const t = computeTailCheck(entry, exit);
  assert.equal(t.inRole, "user");
  assert.equal(t.outRole, "assistant");
  assert.equal(t.lastUserMatch, false);
});

test("tail-check render tags: re-stamped exit text hashes equal to plain entry", () => {
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi")];
  const exit = [mk("user", "text", "hello"), mk("assistant", "text", tagged("hi"))];
  const t = computeTailCheck(entry, exit);
  assert.equal(t.inHash, t.outHash);
  assert.equal(t.lastUserMatch, true);
});

test("tail-check host-injected tail: last message is system, last-user still compared", () => {
  const entry = [mk("user", "text", "q"), mk("assistant", "text", "a"), mk("system", "text", "per-turn prompt")];
  const exit = [...entry];
  const t = computeTailCheck(entry, exit);
  assert.equal(t.inRole, "system");
  assert.equal(t.inHash, h8("per-turn prompt"));
  assert.equal(t.lastUserMatch, true);
});

test("tail-check degenerate: empty sides and no user message", () => {
  const t0 = computeTailCheck([], []);
  assert.equal(t0.inRole, "-");
  assert.equal(t0.inHash, "-");
  assert.equal(t0.outRole, "-");
  assert.equal(t0.outHash, "-");
  assert.equal(t0.lastUserMatch, false);
  const noUser = [mk("assistant", "text", "a")];
  const t1 = computeTailCheck(noUser, noUser);
  assert.equal(t1.inRole, "assistant");
  assert.equal(t1.lastUserMatch, false);
});

test("wired: disarmed judge (BILI_INVARIANT_JUDGE=0) emits no tail-check line", () => {
  // Runs before any _setInvariantJudgeForTest call so the env path (not the
  // test override) is what is exercised.
  const lines: Array<[string, string]> = [];
  setLogCapture((level, msg) => lines.push([level, msg]));
  try {
    process.env.BILI_INVARIANT_JUDGE = "0";
    const entry = [mk("user", "text", "hello")];
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] });
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-tail-off" });
    assert.equal(lines.filter(([, m]) => m.includes("tail-check")).length, 0);
  } finally {
    delete process.env.BILI_INVARIANT_JUDGE;
    setLogCapture(null);
  }
});

test("wired: default sink logs one tail-check debug line per judged request", () => {
  const lines: Array<[string, string]> = [];
  setLogCapture((level, msg) => lines.push([level, msg]));
  _setInvariantJudgeForTest(true);
  try {
    const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi"), mk("user", "text", "new question")];
    const body = JSON.stringify({ model: "m", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "new question" },
    ] });
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-tail-log" });
    const hit = lines.find(([, m]) => m.includes("tail-check"));
    assert.ok(hit, JSON.stringify(lines));
    assert.equal(hit![0], "debug");
    assert.ok(hit![1].includes("[s-tail-log] [invariant-judge/main]"), hit![1]);
    assert.ok(hit![1].includes(`in=user h=${h8("new question")}`), hit![1]);
    assert.ok(hit![1].includes(`out=user h=${h8("new question")}`), hit![1]);
    assert.ok(hit![1].includes("last-user=yes"), hit![1]);
  } finally {
    _setInvariantJudgeForTest(false);
    setLogCapture(null);
  }
});

test("wired: maybeRunInvariantJudge attaches the tail to the sink verdict (actual outbound, pre-fault)", () => {
  const seen: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => seen.push(v));
  try {
    const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi"), mk("user", "text", "new question")];
    const body = JSON.stringify({ model: "m", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "new question" },
    ] });
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-tail" });
    assert.equal(seen.length, 1);
    const t = seen[0].tail;
    assert.ok(t, "verdict must carry the tail observation");
    assert.equal(t!.inRole, "user");
    assert.equal(t!.outRole, "user");
    assert.equal(t!.inHash, h8("new question"));
    assert.equal(t!.outHash, h8("new question"));
    assert.equal(t!.lastUserMatch, true);

    // A test fault rewrites the exit core — the tail must still reflect the
    // ACTUAL outbound bytes (exitCores0), not the fault-modified copy.
    _setInvariantJudgeFaultForTest((cores) => {
      const c = [...cores];
      c[c.length - 1] = { ...c[c.length - 1], text: "MUTATED BY FAULT" };
      return c;
    });
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-tail" });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].tail!.outHash, h8("new question"));
    _setInvariantJudgeFaultForTest(null);
  } finally {
    _setInvariantJudgeForTest(false);
    _setInvariantJudgeFaultForTest(null);
  }
});
