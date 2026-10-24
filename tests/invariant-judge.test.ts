// #3842 — I1/I2 outbound-invariant judge: unit-level proof of the decision logic.
// Positive fixtures pin the exemption list at zero false positives; negative
// controls prove the judge goes red on the within-request rewrite/drop/reorder/
// insert shapes (#3676/#3769 family) and on fold-boundary drift (I2).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { judgeInboundOutbound, maybeRunInvariantJudge, maybeJudgeContinuity, _setInvariantJudgeForTest, type JudgeVerdict } from "../src/invariant-judge.js";
import { setLogCapture } from "../src/logger.js";

let n = 0;
function mk(role: CoreMessage["role"], contentType: CoreMessage["contentType"], text?: string, extra: Partial<CoreMessage> = {}): CoreMessage {
  n++;
  return { id: `m${String(n).padStart(5, "0")}`, role, contentType, ...(text !== undefined ? { text } : {}), ...extra };
}
const TAG = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";
function tagged(t: string): string { return `${t}\n${TAG}`; }

test("I1 identity: entry == exit passes", () => {
  const a = [mk("user", "text", "hello"), mk("assistant", "text", "hi there")];
  const v = judgeInboundOutbound(a, a);
  assert.equal(v.ok, true);
  assert.equal(v.matched, 2);
});

test("I1 render tags added on exit are normalized away (no false positive)", () => {
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi there")];
  const exit = [mk("user", "text", "hello"), mk("assistant", "text", tagged("hi there"))];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 tail append (this turn's new message) is allowed", () => {
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi")];
  const exit = [...entry, mk("user", "text", "follow-up question")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 trailing chain-checkpoint carrier is exempt", () => {
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi")];
  const exit = [...entry, mk("user", "text", "\x3cbili-chain \"abc\"/>\x3c/bili-chain>")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 policy reasoning drop is exempt", () => {
  const entry = [mk("user", "text", "q"), mk("assistant", "reasoning", "thinking..."), mk("assistant", "text", "a")];
  const exit = [mk("user", "text", "q"), mk("assistant", "text", "a")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 deterministic crush transform of a tool-result is exempt", () => {
  const entry = [mk("user", "text", "run"), mk("tool", "tool-result", "[{\"a\":1},{\"a\":2},{\"a\":3}]"), mk("assistant", "text", "done")];
  const crushed = JSON.stringify({ __acp_crush: "rows", rows: 3, const: { a: 1 }, items: [] });
  const exit = [mk("user", "text", "run"), mk("tool", "tool-result", crushed), mk("assistant", "text", "done")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 tool-call id re-mint with identical content does not false-positive (#2821)", () => {
  const entry = [mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "call_1" })];
  const exit = [mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "call_REMINTED" })];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("NEG mid-history rewrite (stable assistant text altered) -> red", () => {
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "the answer is 42"), mk("user", "text", "thanks")];
  const exit = [mk("user", "text", "hello"), mk("assistant", "text", "the answer is 43"), mk("user", "text", "thanks")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-rewrite"));
});

test("NEG mid-history drop (stable message vanished, no fold) -> red", () => {
  const entry = [mk("user", "text", "one"), mk("assistant", "text", "two"), mk("user", "text", "three")];
  const exit = [mk("user", "text", "one"), mk("user", "text", "three")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-drop" || x.kind === "mid-history-rewrite"));
});

test("NEG reorder (stable messages out of order) -> red", () => {
  const entry = [mk("user", "text", "A"), mk("assistant", "text", "B"), mk("user", "text", "C")];
  const exit = [mk("user", "text", "A"), mk("user", "text", "C"), mk("assistant", "text", "B")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, false);
});

test("NEG mid-insertion (non-carrier element lands before a stable match) -> red", () => {
  const entry = [mk("user", "text", "A"), mk("assistant", "text", "B")];
  const exit = [mk("user", "text", "A"), mk("system", "text", "INJECTED MIDDLE"), mk("assistant", "text", "B")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-insertion"));
});

test("I2 fold: frozen prefix intact, folded region replaced by summary carrier -> green", () => {
  const entry = [
    mk("user", "text", "preamble"),
    mk("assistant", "text", "old-1"),
    mk("user", "text", "old-2"),
    mk("assistant", "text", "old-3"),
  ];
  const exit = [
    mk("user", "text", "preamble"),
    mk("user", "text", "[Compressed conversation section]\nold stuff summarized", { summaryOfBlockId: "b5" }),
    mk("user", "text", "new question"),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true);
  assert.equal(v.folded, true);
  assert.equal(v.foldStart, 1);
});

test("I2 fold boundary drift: frozen-prefix element altered before the summary -> red", () => {
  const entry = [
    mk("user", "text", "preamble"),
    mk("assistant", "text", "old-1"),
    mk("user", "text", "old-2"),
  ];
  const exit = [
    mk("user", "text", "PREAMBLE MUTATED"),
    mk("user", "text", "[Compressed conversation section]", { summaryOfBlockId: "b5" }),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.equal(v.folded, true);
});

test("I1 stateful-host echo: inbound acp_summary carrier matches its twin (entry==exit) -> green", () => {
  const a = [
    mk("user", "text", "hello"),
    mk("user", "text", "[Compressed conversation section]\nold stuff", { summaryOfBlockId: "b3" }),
    mk("assistant", "text", "still here"),
  ];
  const v = judgeInboundOutbound(a, a);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("I1 stateful-host echo: inbound chain-checkpoint carrier matches its twin -> green", () => {
  const a = [
    mk("user", "text", "hello"),
    mk("user", "text", "\x3cbili-chain \"abc\"/>\x3c/bili-chain>"),
    mk("assistant", "text", "hi"),
  ];
  const v = judgeInboundOutbound(a, a);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("I1 five consecutive injected carriers before the next stable match stay exempt (gap counts non-carriers)", () => {
  const ck = (t: string) => mk("user", "text", t);
  const entry = [mk("user", "text", "A"), mk("assistant", "text", "B")];
  const exit = [
    entry[0]!,
    ck("\x3cbili-chain \"c1\"/>\x3c/bili-chain>"),
    ck("\x3cbili-chain \"c2\"/>\x3c/bili-chain>"),
    ck("\x3cbili-chain \"c3\"/>\x3c/bili-chain>"),
    ck("\x3cbili-chain \"c4\"/>\x3c/bili-chain>"),
    ck("\x3cbili-chain \"c5\"/>\x3c/bili-chain>"),
    entry[1]!,
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("carrier text drift in place stays green: inbound elements at/after the fold point live in bili's owned render region (host edits to persisted summaries are normalized by the canonical re-render, so they are not attributable to the host)", () => {
  const entry = [
    mk("user", "text", "hello"),
    mk("user", "text", "[Compressed conversation section]\nold stuff", { summaryOfBlockId: "b3" }),
  ];
  const exit = [
    mk("user", "text", "hello"),
    mk("user", "text", "[Compressed conversation section]\nDIFFERENT CONTENT", { summaryOfBlockId: "b3" }),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.folded, true);
  assert.equal(v.matched, 1);
});

// --- #3938 (PR-A): exemption ledger, default-arm wiring, loop continuity ----

test("exemption ledger rides every verdict (carrier/reasoning/crush volumes)", () => {
  const entry = [mk("user", "text", "q"), mk("assistant", "reasoning", "thinking..."), mk("assistant", "text", "a")];
  const exit = [entry[0]!, entry[2]!, mk("user", "text", "\x3cbili-chain \"x\"/\x3e/bili-chain\x3e")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true);
  assert.equal(v.exempt?.carrier, 1);
  assert.equal(v.exempt?.reasoning, 0);
  assert.equal(v.exempt?.crush, 0);
});

test("exemption-overflow: exempt volume beyond the cap is itself a violation (#3842 count-bounded list)", () => {
  const carriers = Array.from({ length: 130 }, () => mk("user", "text", "\x3cbili-chain \"x\"/\x3e/bili-chain\x3e"));
  const v = judgeInboundOutbound([], carriers);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "exemption-overflow"));
  assert.equal(v.exempt?.carrier, 130);
  const raised = judgeInboundOutbound([], carriers, { maxExempt: 200 });
  assert.equal(raised.ok, true);
});

test("steady folded traffic stays far under the default cap (128)", () => {
  const history = Array.from({ length: 30 }, (_, i) => mk(i % 2 === 0 ? "user" : "assistant", "text", `turn ${i}`));
  const exit = [mk("user", "text", "[Compressed conversation section] folded"), ...history.slice(-4)];
  const v = judgeInboundOutbound(history, exit);
  assert.ok(v.folded);
  assert.ok((v.exempt?.carrier ?? 0) <= 2, JSON.stringify(v.exempt));
});

test("default-armed wiring: violations log at warn via the tee logger; BILI_INVARIANT_JUDGE=0 disarms", () => {
  const lines: Array<[string, string]> = [];
  setLogCapture((level, msg) => lines.push([level, msg]));
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi"), mk("user", "text", "q")];
  const body = JSON.stringify({ model: "m", messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi REWRITTEN BY DEFECT" },
    { role: "user", content: "q" },
  ] });
  try {
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-judge" });
    const hit = lines.find(([, m]) => m.includes("[invariant-judge"));
    assert.ok(hit, JSON.stringify(lines.slice(0, 3)));
    assert.equal(hit![0], "warn");
    assert.ok(hit![1].includes("s-judge"));
    assert.ok(hit![1].includes("mid-history-rewrite"));
    lines.length = 0;
    process.env.BILI_INVARIANT_JUDGE = "0";
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-judge" });
    assert.equal(lines.length, 0);
  } finally {
    delete process.env.BILI_INVARIANT_JUDGE;
    setLogCapture(null);
  }
});

test("loop continuity judge: prev-outbound -> next-outbound append is green, mid edit is red", () => {
  const seen: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => seen.push(v));
  try {
    const prev = JSON.stringify({ model: "m", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] });
    const grow = JSON.stringify({ model: "m", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "tool result + follow-up" },
    ] });
    maybeJudgeContinuity(prev, grow, "openai", "s-loop");
    assert.equal(seen.at(-1)?.ok, true);
    assert.equal(seen.at(-1)?.lane, "loop");
    const corrupt = JSON.stringify({ model: "m", messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi MUTATED MID-LOOP" },
      { role: "user", content: "tool result + follow-up" },
    ] });
    maybeJudgeContinuity(prev, corrupt, "openai", "s-loop");
    assert.equal(seen.at(-1)?.ok, false);
    assert.ok(seen.at(-1)!.violations.some((x) => x.kind === "mid-history-rewrite"));
  } finally {
    _setInvariantJudgeForTest(false);
  }
});

test("loop continuity judge: absent prev (clipped/oversized forensics) silently skips", () => {
  const seen: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => seen.push(v));
  try {
    maybeJudgeContinuity(null, JSON.stringify({ messages: [] }), "openai", "s-loop");
    maybeJudgeContinuity(undefined, JSON.stringify({ messages: [] }), "openai", "s-loop");
    assert.equal(seen.length, 0);
  } finally {
    _setInvariantJudgeForTest(false);
  }
});

// #3938 PR-D closure (拍板①): the judge's normalization must cover the SAME
// echo-artifact shapes the outbound stream filters strip. Each family below
// appears in the ENTRY text only (the shape a client resent that the pipeline
// legitimately removed on the way out) — none of them may read as a rewrite.
test("PR-D closure: echo family shapes in entry vs filtered exit never flag", () => {
  const prose = "analysis of the cache seam";
  // exit models the REAL filter output per shape (stripAcpTags semantics);
  // e.g. a mangled open drops its tags but leaves the ref behind as residue,
  // and an isolated dead ref-close with no other echo evidence is kept
  // verbatim (#1760) — the judge must agree with the filter either way.
  const echoShapes: Array<[string, string, string]> = [
    ["case-drift (#1731)", `${prose}\n\x3cACP tokens="2" type="text"\x3em00420\x3c/ACP\x3e`, prose],
    ["typo-drift (#673)", `${prose}\n\x3cacip tokens="1"\x3em00420\x3c/acip\x3e`, prose],
    ["bare no-attrs (#1881)", `${prose}\n\x3cacp\x3em00420\x3c/acp\x3e`, prose],
    ["degenerate close (#2190)", `${prose}\n\x3cacp tokens="2"\x3em00420\x3c/ap\x3e`, prose],
    ["self-closing (#2348)", `${prose}\n\x3cacp tokens="2"/\x3e`, prose],
    ["mangled open (#2066)", `${prose}\n\x3cacp=1\x3em00420\x3c/acp\x3e`, `${prose}\nm00420`],
    ["forged marker line (#717)", `\u{1F52E} [ACP] compressed 3 messages (saved 1200 tokens)\n${prose}`, prose],
    ["chain carrier artifact (#1634)", `${prose}\n\x3cbili-chain "x"/>\x3c/bili-chain\x3e`, `${prose}\n\x3cbili-chain "x"/>\x3c/bili-chain\x3e`],
    ["dead ref-close (#2862)", `${prose} m00420\x3c/acp`, `${prose} m00420\x3c/acp`],
  ];
  for (const [family, entryText, exitText] of echoShapes) {
    const entry = [mk("user", "text", "hello"), mk("assistant", "text", entryText)];
    const exit = [mk("user", "text", "hello"), mk("assistant", "text", exitText)];
    const v = judgeInboundOutbound(entry, exit);
    assert.equal(v.ok, true, `${family} must not read as a rewrite`);
  }
});

test("PR-D closure: prose payload survives the normalization on BOTH sides (paired prose-wearing tags keep content)", () => {
  // A prose-wearing pair keeps its payload when stripped — entry and exit
  // carrying the SAME prose (with/without the tag bytes) must still match.
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "\x3cACP tokens='2'\x3ereal content\x3c/ACP\x3e")];
  const exit = [mk("user", "text", "hello"), mk("assistant", "text", "real content")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("PR-D closure: a REAL mid-history rewrite still flags through the echo normalizer", () => {
  // The closure must not blind the judge: arbitrary prose change in the
  // middle of history is still a mid-history-rewrite violation.
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "original words"), mk("user", "text", "and then?")];
  const exit = [mk("user", "text", "hello"), mk("assistant", "text", "rewritten words \x3cACP tokens='1'\x3em00420\x3c/ACP\x3e"), mk("user", "text", "and then?")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-rewrite"));
});

// --- #4388: Responses turn separators (#564/#2627) ride the exemption ledger ---

const TURN_SEP = "[The exchange between these two assistant turns was compressed.]";

test("#4388 I1: a Responses turn separator between stable messages is exempt (outbound-only #564 injection)", () => {
  const entry = [mk("user", "text", "A"), mk("assistant", "text", "B")];
  const exit = [entry[0]!, mk("user", "text", TURN_SEP), entry[1]!];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.exempt?.carrier, 1);
});

test("#4388 I1: a separator stack beyond the carrier gap budget stays exempt (gap counts non-carriers only)", () => {
  const entry = [mk("user", "text", "A"), mk("assistant", "text", "B")];
  const seps = Array.from({ length: 6 }, () => mk("user", "text", TURN_SEP));
  const exit = [entry[0]!, ...seps, entry[1]!];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("#4388 NEG: a near-miss user message that resembles the separator still flags mid-insertion", () => {
  const entry = [mk("user", "text", "A"), mk("assistant", "text", "B")];
  const exit = [entry[0]!, mk("user", "text", `${TURN_SEP} extra words`), entry[1]!];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-insertion"));
});

test("#4388 I2: a separator stacked directly before the fold carrier does not mask or fake the fold point", () => {
  const entry = [
    mk("user", "text", "preamble"),
    mk("assistant", "text", "old-1"),
    mk("user", "text", "old-2"),
    mk("user", "text", "new question"),
  ];
  const exit = [
    mk("user", "text", "preamble"),
    mk("user", "text", TURN_SEP),
    mk("user", "text", "[Compressed conversation section]\nold stuff summarized", { summaryOfBlockId: "b5" }),
    mk("user", "text", "new question"),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.folded, true);
  assert.equal(v.foldStart, 1);
});

test("#4388 NEG: an unfolded frozen prefix with a missing stable message still flags (no silent fold-out)", () => {
  const entry = [mk("user", "text", "one"), mk("assistant", "text", "two"), mk("user", "text", "three")];
  const exit = [mk("user", "text", "one"), mk("user", "text", "three")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-drop" || x.kind === "mid-history-rewrite"));
});

test("#4388 NEG: a missing stable message beside a FOREIGN unexplained element before the fold carrier still flags via carrier pinning (close-out safety backstop)", () => {
  const entry = [mk("user", "text", "one"), mk("assistant", "text", "two"), mk("user", "text", "three")];
  const exit = [
    mk("user", "text", "one"),
    mk("user", "text", "foreign element"),
    mk("user", "text", "[Compressed conversation section]\nold stuff summarized", { summaryOfBlockId: "b1" }),
    mk("user", "text", "three"),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false, JSON.stringify(v.violations));
  assert.ok(v.violations.some((x) => x.kind === "carrier-drift"));
});
