// #4862 — I3 egress pairing invariant: the exit body must be protocol-SOUND on
// its own (every tool-call answered, every tool-result declared), independent of
// the I1/I2 entry↔exit continuity reconciliation. Positive rows pin the
// attribution scoping (host-sent half-pairs, compress in-flight, whole-pair
// folds, id re-minting); negative controls prove a fold that eats ONE half of a
// pair goes red in every mode (legacy, render-lane, main, loop) — the exact
// shape that used to earn a clean fold verdict right before the upstream 400.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import {
  judgeInboundOutbound,
  maybeRunInvariantJudge,
  maybeJudgeContinuity,
  _setInvariantJudgeForTest,
  type JudgeVerdict,
} from "../src/invariant-judge.js";

let n = 0;
function mk(role: CoreMessage["role"], contentType: CoreMessage["contentType"], text?: string, extra: Partial<CoreMessage> = {}): CoreMessage {
  n++;
  return { id: `m${String(n).padStart(5, "0")}`, role, contentType, ...(text !== undefined ? { text } : {}), ...extra };
}
const SUMMARY = "[Compressed conversation section]";

function has(v: JudgeVerdict, kind: string): boolean {
  return v.violations.some((x) => x.kind === kind);
}

// --- NEG: a fold that eats one half of a pair ships a protocol-broken body ---

test("I3 NEG fold eats the tool-result half: exit call unpaired (legacy mode)", () => {
  const entry = [
    mk("user", "text", "run ls"),
    mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "tu_1" }),
    mk("tool", "tool-result", "fileA", { toolCallId: "tu_1" }),
    mk("user", "text", "next question"),
  ];
  const exit = [
    mk("system", "text", SUMMARY),
    mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "tu_1" }),
    mk("user", "text", "next question"),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.equal(has(v, "unpaired-tool-call"), true, JSON.stringify(v.violations));
  const hit = v.violations.find((x) => x.kind === "unpaired-tool-call")!;
  assert.match(hit.detail, /tu_1/);
});

test("I3 NEG fold eats the tool-call half: exit result unpaired (legacy mode)", () => {
  const entry = [
    mk("user", "text", "run ls"),
    mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "tu_1" }),
    mk("tool", "tool-result", "fileA", { toolCallId: "tu_1" }),
    mk("user", "text", "next question"),
  ];
  const exit = [
    mk("system", "text", SUMMARY),
    mk("tool", "tool-result", "fileA", { toolCallId: "tu_1" }),
    mk("user", "text", "next question"),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.equal(has(v, "unpaired-tool-result"), true, JSON.stringify(v.violations));
});

test("I3 NEG render-lane rendered prefix is NOT exempt from pairing (#4241 mode)", () => {
  // entry[0..1] = pair the server-rendered prefix replaces; tail entry[2..] is
  // the client tail that must survive verbatim. The rendered prefix shipped the
  // result half without its call — protocol-broken is protocol-broken, render
  // or not.
  const entry = [
    mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "tu_1" }),
    mk("tool", "tool-result", "fileA", { toolCallId: "tu_1" }),
    mk("user", "text", "tail question"),
  ];
  const exit = [
    mk("system", "text", "rendered transcript row"),
    mk("tool", "tool-result", "fileA", { toolCallId: "tu_1" }),
    mk("user", "text", "tail question"),
  ];
  const v = judgeInboundOutbound(entry, exit, { renderTailStart: 2 });
  assert.equal(v.ok, false);
  assert.equal(has(v, "unpaired-tool-result"), true, JSON.stringify(v.violations));
});

test("I3 NEG id re-mint cannot launder a broken pair (#2821 interaction)", () => {
  // The kernel re-mints tool-call ids on projection; a re-minted PAIR stays
  // internally paired, but a re-minted half-pair must still fire — the volume
  // guard attributes the excess to bili, not the host.
  const entry = [
    mk("user", "text", "run ls"),
    mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "tu_1" }),
    mk("tool", "tool-result", "fileA", { toolCallId: "tu_1" }),
  ];
  const exit = [
    mk("system", "text", SUMMARY),
    mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "tu_REMINTED" }),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(has(v, "unpaired-tool-call"), true, JSON.stringify(v.violations));
});

// --- POS: attribution scoping and kernel-parity exemptions (zero false pos) ---

test("I3 POS host-sent half-pair echoed verbatim is NOT bili's defect", () => {
  const entry = [
    mk("user", "text", "hi"),
    mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "tu_hostbroken" }),
    mk("user", "text", "bye"),
  ];
  const v = judgeInboundOutbound(entry, entry);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("I3 POS lone re-minted call over a host-sent lone call stays clean (volume guard, #2821)", () => {
  const entry = [mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "call_1" })];
  const exit = [mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "call_REMINTED" })];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("I3 POS in-flight compress re-mint does not inflate volume over a host-broken call", () => {
  // entry ships ONE host-broken non-compress call plus an in-flight compress
  // call (no result yet); exit re-mints both ids. Compress must be excluded
  // from BOTH volume counts or this reads as bili breaking a second pair.
  const entry = [
    mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "call_hostbroken" }),
    mk("assistant", "tool-call", "{}", { toolName: "compress", toolCallId: "c_1" }),
  ];
  const exit = [
    mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "call_REMINTED" }),
    mk("assistant", "tool-call", "{}", { toolName: "compress", toolCallId: "c_REMINTED" }),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("I3 POS compress call with pending result is exempt (kernel parity, bare + MCP dialect)", () => {
  for (const name of ["compress", "mcp__bili__compress"]) {
    const entry = [
      mk("user", "text", "compress it"),
      mk("assistant", "tool-call", "{}", { toolName: name, toolCallId: "c_1" }),
      mk("tool", "tool-result", "done", { toolCallId: "c_1" }),
      mk("user", "text", "next"),
    ];
    const exit = [
      mk("system", "text", SUMMARY),
      mk("assistant", "tool-call", "{}", { toolName: name, toolCallId: "c_1" }),
      mk("user", "text", "next"),
    ];
    const v = judgeInboundOutbound(entry, exit);
    assert.equal(v.ok, true, `${name}: ${JSON.stringify(v.violations)}`);
  }
});

test("I3 POS whole-pair fold (kernel adjustBoundariesForToolPairs parity) stays clean", () => {
  const entry = [
    mk("user", "text", "one"),
    mk("assistant", "tool-call", "{\"a\":1}", { toolName: "bash", toolCallId: "tu_1" }),
    mk("tool", "tool-result", "r1", { toolCallId: "tu_1" }),
    mk("user", "text", "two"),
    mk("assistant", "tool-call", "{\"a\":2}", { toolName: "bash", toolCallId: "tu_2" }),
    mk("tool", "tool-result", "r2", { toolCallId: "tu_2" }),
    mk("user", "text", "three"),
  ];
  const exit = [
    mk("system", "text", SUMMARY),
    mk("user", "text", "two"),
    mk("assistant", "tool-call", "{\"a\":2}", { toolName: "bash", toolCallId: "tu_2" }),
    mk("tool", "tool-result", "r2", { toolCallId: "tu_2" }),
    mk("user", "text", "three"),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("I3 POS same-id reuse answers by precedence, not multiplicity (Agent Teams shape)", () => {
  const msgs = [
    mk("user", "text", "go"),
    mk("assistant", "tool-call", "{}", { toolName: "team", toolCallId: "name:0" }),
    mk("assistant", "tool-call", "{}", { toolName: "team", toolCallId: "name:0" }),
    mk("tool", "tool-result", "ok", { toolCallId: "name:0" }),
    mk("user", "text", "done"),
  ];
  const v = judgeInboundOutbound(msgs, msgs);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

// --- Wired: the real body parse path (main lane) and loop continuity lane ---

function anthropicBody(withResult: boolean): string {
  return JSON.stringify({
    model: "claude-test",
    max_tokens: 32,
    messages: [
      { role: "user", content: "run ls" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } }] },
      ...(withResult ? [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "fileA" }] }] : []),
      { role: "user", content: "next question" },
    ],
  });
}

test("I3 wired main lane: real anthropic body with the result half stripped goes red", () => {
  const verdicts: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => verdicts.push(v));
  try {
    const entry = [
      mk("user", "text", "run ls"),
      mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "tu_1" }),
      mk("tool", "tool-result", "fileA", { toolCallId: "tu_1" }),
      mk("user", "text", "next question"),
    ];
    maybeRunInvariantJudge({ originalMessages: entry, body: anthropicBody(false), protocol: "anthropic", sessionId: "s-i3" });
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.ok, false);
    assert.equal(has(verdicts[0]!, "unpaired-tool-call"), true, JSON.stringify(verdicts[0]!.violations));
    assert.equal(verdicts[0]!.lane, "main");
  } finally {
    _setInvariantJudgeForTest(false);
  }
});

test("I3 wired main lane: paired body stays clean", () => {
  const verdicts: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => verdicts.push(v));
  try {
    const entry = [
      mk("user", "text", "run ls"),
      mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "tu_1" }),
      mk("tool", "tool-result", "fileA", { toolCallId: "tu_1" }),
      mk("user", "text", "next question"),
    ];
    maybeRunInvariantJudge({ originalMessages: entry, body: anthropicBody(true), protocol: "anthropic", sessionId: "s-i3" });
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.ok, true, JSON.stringify(verdicts[0]!.violations));
  } finally {
    _setInvariantJudgeForTest(false);
  }
});

test("I3 wired loop lane: continuity judge fires when round 2+ loses a half", () => {
  const verdicts: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => verdicts.push(v));
  try {
    maybeJudgeContinuity(anthropicBody(true), anthropicBody(false), "anthropic", "s-i3-loop");
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.ok, false);
    assert.equal(has(verdicts[0]!, "unpaired-tool-call"), true, JSON.stringify(verdicts[0]!.violations));
    assert.equal(verdicts[0]!.lane, "loop");
  } finally {
    _setInvariantJudgeForTest(false);
  }
});
