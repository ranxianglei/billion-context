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

// --- #4186 G2/G3: CCR placeholder substitution + emergency-truncation twins --

const ccrPlaceholder = (ref: string, kind: string, tokens: string, title?: string): string =>
  `\u{1F4E6} [acp-stored #${ref} · ${kind} · ${tokens} tok]${title !== undefined ? ` \`${title}\`` : ""}\n   → acp_retrieve("${ref}") returns the full text`;

const truncatedTwin = (orig: string, keepPrefixChars = 40, keepSuffixChars = 40): string =>
  `${orig.slice(0, keepPrefixChars)}\n\n...[truncated for context space] — original ~999 tokens]...\n\n${orig.slice(orig.length - keepSuffixChars)}`;

test("I1 CCR-stored tool result: canonical placeholder on exit matches the client's full-text twin (#4186 G2)", () => {
  const fullText = "total 8\n" + "Fuzz 4-0: pipeline clean, suite green, regions stable, deltas recorded. ".repeat(50);
  const entry = [
    mk("user", "text", "run"),
    mk("tool", "tool-result", fullText, { toolName: "shell", toolCallId: "call_t4" }),
    mk("assistant", "text", "done"),
  ];
  const exit = [
    entry[0]!,
    mk("tool", "tool-result", ccrPlaceholder("m00010", "shell output", "4,581", "ls mod-4"), { toolName: "shell", toolCallId: "call_t4" }),
    entry[2]!,
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.exempt?.ccr, 1);
});

test("NEG CCR: prose merely MENTIONING the placeholder shape is not a sanctioned substitution (#1456 strict-parser gate)", () => {
  const ph = ccrPlaceholder("m00010", "shell output", "4,581", "ls mod-4");
  const entry = [mk("user", "text", "run"), mk("tool", "tool-result", "real shell bytes here", { toolCallId: "call_t4" }), mk("assistant", "text", "done")];
  const exit = [entry[0]!, mk("tool", "tool-result", `example: ${ph}`, { toolCallId: "call_t4" }), entry[2]!];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-rewrite"));
});

test("NEG CCR: placeholder-shaped body under a changed role/contentType is not exempt", () => {
  const ph = ccrPlaceholder("m00010", "shell output", "4,581");
  const entry = [mk("user", "text", "hello"), mk("tool", "tool-result", "real bytes", { toolCallId: "call_t4" }), mk("assistant", "text", "hi")];
  const exit = [entry[0]!, mk("user", "text", ph), entry[2]!];
  assert.equal(judgeInboundOutbound(entry, exit).ok, false);
});

test("I1 emergency-truncation twin: prefix+marker+suffix clip of the same message passes (#4186 G3)", () => {
  const orig = "Turn 1: analyze module 1. " + "pipeline clean, suite green, regions stable, deltas recorded. ".repeat(80);
  const entry = [mk("user", "text", orig), mk("assistant", "text", "reply one")];
  const exit = [mk("user", "text", truncatedTwin(orig)), mk("assistant", "text", "reply one")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.exempt?.truncate, 1);
});

test("I1 truncated twin directly before a fold carrier keeps carrier pinning green (live fuzz-1592 geometry)", () => {
  const orig = "Turn 1: analyze module 1. " + "pipeline clean, suite green, regions stable, deltas recorded. ".repeat(80);
  const entry = [mk("user", "text", orig), mk("assistant", "text", "old-1"), mk("user", "text", "new question")];
  const exit = [
    mk("user", "text", truncatedTwin(orig)),
    mk("user", "text", "[Compressed conversation section]\nfolded", { summaryOfBlockId: "b9" }),
    mk("user", "text", "new question"),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.folded, true);
});

test("NEG truncation: marker present but prefix NOT from the inbound message stays red (fabricated clip)", () => {
  const orig = "Turn 1: analyze module 1. " + "alpha beta gamma delta epsilon zeta eta theta. ".repeat(80);
  const fabricated = `Completely different opening words here\n\n...[truncated for context space] — original ~999 tokens]...\n\n${orig.slice(-40)}`;
  const entry = [mk("user", "text", orig), mk("assistant", "text", "a")];
  const exit = [mk("user", "text", fabricated), mk("assistant", "text", "a")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, false);
});

test("NEG truncation: plain shrink WITHOUT the marker stays red (no marker, no sanction)", () => {
  const orig = "long body " + "word ".repeat(300);
  const entry = [mk("user", "text", orig), mk("assistant", "text", "a")];
  const exit = [mk("user", "text", orig.slice(0, 60)), mk("assistant", "text", "a")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-rewrite" || x.kind === "mid-history-drop"));
});

test("NEG truncation: INFLATED body carrying the marker stays red (#3935 regression shape)", () => {
  const orig = "short original";
  const inflated = `${orig}\n\n...[truncated for context space] — original ~999 tokens]...\n\n${orig}`;
  const entry = [mk("user", "text", orig), mk("assistant", "text", "a")];
  const exit = [mk("user", "text", inflated), mk("assistant", "text", "a")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, false);
});

// #4241 — snapshot-render lane tail-fidelity. On a turn where prepare's snapshot
// render served the outbound prefix, the raw inbound prefix was INTENTIONALLY
// replaced by server rows + summary anchors; only the client tail (>= renderTailStart)
// is promised byte-intact. The judge validates exactly that suffix; the rendered
// prefix is exempt from the frozen-prefix rule while I2 stays armed on the tail.
const renderCarrier = () => mk("system", "text", "[Compressed conversation section] b5", { summaryOfBlockId: "b5" });

test("#4241 POS bug-repro: covered region replaced by server view + intact tail ⇒ green (was false-positive red)", () => {
  const entry = [mk("user", "text", "old-a"), mk("assistant", "text", "old-b"), mk("user", "text", "old-c"), mk("user", "text", "new question")];
  const exit = [mk("user", "text", "canon-x"), mk("assistant", "text", "canon-y"), renderCarrier(), mk("user", "text", "new question")];
  // Without render-lane awareness this turn reads as a mid-history rewrite — the reported false positive:
  const legacy = judgeInboundOutbound(entry, exit);
  assert.equal(legacy.ok, false);
  assert.ok(legacy.violations.some((x) => x.kind === "mid-history-rewrite"));
  // With renderTailStart=3 (first client index of the live tail) only the tail is validated:
  const v = judgeInboundOutbound(entry, exit, { renderTailStart: 3 });
  assert.equal(v.ok, true);
  assert.equal(v.renderLane, true);
  assert.equal(v.matched, 1);
  assert.equal(v.total, 1);
  assert.equal(v.folded, true);
});

test("#4241 NEG control: a corrupted tail message still goes red on the render lane (teeth remain)", () => {
  const entry = [mk("user", "text", "old"), mk("user", "text", "original words")];
  const exit = [mk("user", "text", "canon"), renderCarrier(), mk("user", "text", "rewritten words")];
  const v = judgeInboundOutbound(entry, exit, { renderTailStart: 1 });
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-rewrite"));
});

test("#4241 NEG control: a dropped tail message still goes red on the render lane", () => {
  const entry = [mk("user", "text", "old"), mk("user", "text", "keep me"), mk("assistant", "text", "and me")];
  const exit = [mk("user", "text", "canon"), renderCarrier(), mk("user", "text", "keep me")];
  const v = judgeInboundOutbound(entry, exit, { renderTailStart: 1 });
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-drop"));
});

test("#4241 POS: multiple intact tail messages all match in order across the server prefix", () => {
  const entry = [mk("user", "text", "c0"), mk("assistant", "text", "c1"), mk("user", "text", "q"), mk("assistant", "text", "a"), mk("user", "text", "q2")];
  const exit = [mk("user", "text", "canon"), renderCarrier(), mk("user", "text", "q"), mk("assistant", "text", "a"), mk("user", "text", "q2")];
  const v = judgeInboundOutbound(entry, exit, { renderTailStart: 2 });
  assert.equal(v.ok, true);
  assert.equal(v.matched, 3);
  assert.equal(v.total, 3);
  assert.equal(v.renderLane, true);
});

test("#4241 POS edge: fully-covered turn (empty tail) is green with nothing to validate", () => {
  const entry = [mk("user", "text", "covered-0"), mk("assistant", "text", "covered-1")];
  const exit = [mk("user", "text", "canon-0"), renderCarrier()];
  const v = judgeInboundOutbound(entry, exit, { renderTailStart: 2 });
  assert.equal(v.ok, true);
  assert.equal(v.matched, 0);
  assert.equal(v.total, 0);
  assert.equal(v.renderLane, true);
});

test("#4241 wiring: maybeRunInvariantJudge honors renderTailStart (green on rendered shape, red without)", () => {
  const seen: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => seen.push(v));
  try {
    const body = JSON.stringify({ model: "m", messages: [
      { role: "user", content: "canon" },
      { role: "user", content: "new question" },
    ] });
    const entry = [mk("user", "text", "old"), mk("user", "text", "new question")];
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-r" });
    assert.equal(seen.at(-1)?.ok, false);
    assert.equal(seen.at(-1)?.renderLane, undefined);
    assert.ok(seen.at(-1)!.violations.some((x) => x.kind === "mid-history-rewrite"));
    seen.length = 0;
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-r", renderTailStart: 1 });
    assert.equal(seen.at(-1)?.ok, true);
    assert.equal(seen.at(-1)?.renderLane, true);
  } finally {
    _setInvariantJudgeForTest(false);
  }
});

// --- #4408: fold-coverage awareness -----------------------------------------
// The judge must know WHICH inbound cells are legitimately absent from the
// outbound because a live fold covers them — absence is the fold working
// (content rides in the summary block), not a drop. Carrier shapes:
//   A) plugin lane, carrier-less: the rendered pair does not ride THIS wire
//      (server-rendered/suppressed view) — no acp_summary, no pair ⇒ the
//      coverage disjunction alone keeps `folded` true (I2 label, walk
//      geometry stays full). Pre-#4408 every covered cell walked+failed ⇒
//      hundreds of I1 findings per request (#4401: 1104/day, "matched 2/340");
//   A2) plugin lane, pair rendered: bili renders the pair itself (synthetic
//      plugin_<ts> call id, #1567) — the pair IS the recognized fold point;
//   B) proxy lane: acp_summary carrier present but an unconsumable element sits
//      between the matched prefix and the carrier, so the first covered
//      boundary cell gets walked once before the frozen-prefix break fires ⇒
//      one spurious finding per request at the fold edge (v0.1.209 claude
//      lane: 50× "mid-history-drop @4, matched 4/5").
// The client's OWN pair bytes (host-stamped id, original args) are exempted as
// pair cells in a folded session — their wire representation belongs to bili.
// Negative controls keep the teeth: uncovered drops stay red whether or not a
// fold is live; a dropped compress call in an UNFOLDED session still fires.

test("#4408 POS shape-A: carrier-less plugin fold — covered originals AND the client pair absent, no carrier on the wire ⇒ green, folded via coverage disjunction", () => {
  const sys = mk("system", "text", "system prompt");
  const c1 = mk("user", "text", "q1");
  const c2 = mk("assistant", "text", "a1");
  const c3 = mk("user", "text", "q2");
  const c4 = mk("assistant", "text", "a2");
  const call = mk("assistant", "tool-call", JSON.stringify({ startId: "x", endId: "y" }), { toolName: "compress", toolCallId: "call_c1" });
  const result = mk("tool", "tool-result", "[Compressed m00002–m00005 → 1 block(s), ~500 tokens saved.]", { toolName: "compress", toolCallId: "call_c1" });
  const tail = mk("user", "text", "new question");
  const entry = [sys, c1, c2, c3, c4, call, result, tail];
  // Originals folded away and the pair not rendered on this wire at all —
  // the strictest zero-carrier variant:
  const exit = [sys, tail];
  const v = judgeInboundOutbound(entry, exit, { coveredIds: new Set([c1.id, c2.id, c3.id, c4.id]) });
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.folded, true);
  // sys + tail matched; c1..c4 exempted by coverage; the client pair exempted
  // as pair cells (folded session) — none of them may produce a finding:
  assert.equal(v.matched, 2);
});

test("#4408 NEG control: the carrier-less plugin shape WITHOUT the coverage signal stays red (exemption is keyed on ground truth, not wire shape)", () => {
  const sys = mk("system", "text", "system prompt");
  const c1 = mk("user", "text", "q1");
  const c2 = mk("assistant", "text", "a1");
  const c3 = mk("user", "text", "q2");
  const c4 = mk("assistant", "text", "a2");
  const call = mk("assistant", "tool-call", JSON.stringify({ startId: "x", endId: "y" }), { toolName: "compress", toolCallId: "call_c1" });
  const result = mk("tool", "tool-result", "[Compressed m00002–m00005 → 1 block(s), ~500 tokens saved.]", { toolName: "compress", toolCallId: "call_c1" });
  const tail = mk("user", "text", "new question");
  const entry = [sys, c1, c2, c3, c4, call, result, tail];
  const exit = [sys, tail];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.equal(v.folded, false);
  assert.ok(v.violations.length >= 4, JSON.stringify(v.violations));
});

test("#4408 POS shape-A2: bili-rendered pair (synthetic plugin_<ts> id) anchors the fold point ⇒ green", () => {
  const t0 = mk("user", "text", "first turn");
  const c1 = mk("user", "text", "q1");
  const c2 = mk("assistant", "text", "a1");
  const callClient = mk("assistant", "tool-call", JSON.stringify({ startId: "x", endId: "y" }), { toolName: "compress", toolCallId: "host_c1" });
  const receipt = "[Compressed m00002–m00003 → 1 block(s), ~300 tokens saved.]";
  const resultClient = mk("tool", "tool-result", receipt, { toolName: "compress", toolCallId: "host_c1" });
  const tail = mk("user", "text", "new question");
  const entry = [t0, c1, c2, callClient, resultClient, tail];
  // Bili's own rendering: synthetic call id, normalized args — the client's
  // pair bytes do NOT ride the wire verbatim:
  const callSynth = mk("assistant", "tool-call", JSON.stringify({ topic: "fold", content: [] }), { toolName: "compress", toolCallId: "plugin_1759000000000" });
  const resultSynth = mk("tool", "tool-result", receipt, { toolName: "compress", toolCallId: "plugin_1759000000000" });
  const exit = [t0, callSynth, resultSynth, tail];
  const v = judgeInboundOutbound(entry, exit, { coveredIds: new Set([c1.id, c2.id]) });
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.folded, true);
  // The synthetic pair IS the summary carrier: the frozen prefix is [t0] and
  // the walk breaks into the fold region immediately after it:
  assert.equal(v.matched, 1);
});

test("#4408 POS: client pair cells walked inside the frozen prefix are exempted (their wire copy belongs to bili)", () => {
  // Rendering where the recognized carrier sits BEHIND the live turns, so the
  // walk reaches the client's pair cells before the fold break fires — they
  // must be exempted as pair cells, not flagged:
  const t0 = mk("user", "text", "first turn");
  const c1 = mk("user", "text", "q1");
  const c2 = mk("assistant", "text", "a1");
  const call = mk("assistant", "tool-call", JSON.stringify({ startId: "x", endId: "y" }), { toolName: "compress", toolCallId: "h1" });
  const receipt = mk("tool", "tool-result", "[Compressed m00002–m00003 → 1 block(s), ~100 tokens saved.]", { toolName: "compress", toolCallId: "h1" });
  const u1 = mk("user", "text", "live one");
  const u2 = mk("assistant", "text", "live two");
  const tailA = mk("user", "text", "tail question");
  const entry = [t0, c1, c2, call, receipt, u1, u2, tailA];
  const anchor = mk("user", "text", "[Compressed conversation section]\nfolded middle", { summaryOfBlockId: "bX" });
  const exit = [t0, u1, u2, anchor, tailA];
  const v = judgeInboundOutbound(entry, exit, { coveredIds: new Set([c1.id, c2.id]) });
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.folded, true);
  // t0 + u1 + u2 matched; c1/c2 coverage-exempt; call/receipt pair-exempt;
  // the walk breaks into the free zone at tailA:
  assert.equal(v.matched, 3);
});

test("#4408 NEG scoping: a dropped compress call in an UNFOLDED session still fires (pair exemption is fold-gated)", () => {
  const a = mk("user", "text", "hello");
  const call = mk("assistant", "tool-call", "{}", { toolName: "compress", toolCallId: "h2" });
  const r = mk("tool", "tool-result", "plain result text", { toolName: "compress", toolCallId: "h2" });
  const b = mk("user", "text", "world");
  const v = judgeInboundOutbound([a, call, r, b], [a, b]);
  assert.equal(v.ok, false);
  assert.equal(v.folded, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-drop" && x.index === 1), JSON.stringify(v.violations));
});

test("#4408 POS shape-B: proxy-lane fold edge — covered boundary cells sit before the break fires (v0.1.209 claude-lane residue) ⇒ green", () => {
  const env = mk("system", "text", "# Environment\nYou have been invoked in the following environment");
  const e1 = mk("user", "text", "q1");
  const e2 = mk("assistant", "text", "a1");
  const e3 = mk("user", "text", "q2");
  const covA = mk("system", "text", "# Environment\nYou have been invoked in the following environment");
  const covB = mk("assistant", "text", "a3");
  const tail = mk("user", "text", "new question");
  const entry = [env, e1, e2, e3, covA, covB, tail];
  const spacer = mk("assistant", "reasoning", "thinking blob");
  const carrier = mk("user", "text", "[Compressed conversation section]\nfolded middle", { summaryOfBlockId: "b7" });
  const exit = [env, e1, e2, e3, spacer, carrier, tail];
  // Without coverage this is the reported bug verbatim: one spurious drop at
  // the first covered cell (walked once before j reaches freezeEnd), 4/5:
  const legacy = judgeInboundOutbound(entry, exit);
  assert.equal(legacy.ok, false);
  assert.ok(legacy.violations.some((x) => x.kind === "mid-history-drop" && x.index === 4), JSON.stringify(legacy.violations));
  const v = judgeInboundOutbound(entry, exit, { coveredIds: new Set([covA.id, covB.id]) });
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.folded, true);
  // env..e3 matched; covA/covB exempted; the tail is walked (counted) and its
  // confirmation twin sits past the carrier, so the walk breaks into the free
  // zone there (standard I2) without matching it:
  assert.equal(v.matched, 4);
  assert.equal(v.total, 7);
});

test("#4408 NEG teeth: a dropped UNCOVERED message in a folded session still goes red (coverage exempts covered cells only)", () => {
  const env = mk("system", "text", "# Environment");
  const e1 = mk("user", "text", "q1");
  const covA = mk("user", "text", "old-a");
  const covB = mk("assistant", "text", "old-b");
  const keep = mk("user", "text", "KEEP ME");
  const tail = mk("assistant", "text", "reply");
  const entry = [env, e1, covA, covB, keep, tail];
  const spacer = mk("assistant", "reasoning", "thinking blob");
  const carrier = mk("user", "text", "[Compressed conversation section]", { summaryOfBlockId: "b2" });
  const exit = [env, e1, spacer, carrier, tail]; // keep DROPPED; covA/covB legitimately folded
  const v = judgeInboundOutbound(entry, exit, { coveredIds: new Set([covA.id, covB.id]) });
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.index === 4), JSON.stringify(v.violations));
});

test("#4408 NEG teeth: zero-carrier folded session — a dropped UNCOVERED message still goes red", () => {
  const sys = mk("system", "text", "system prompt");
  const c1 = mk("user", "text", "q1");
  const c2 = mk("assistant", "text", "a1");
  const call = mk("assistant", "tool-call", "{}", { toolName: "compress", toolCallId: "call_c1" });
  // Non-receipt text on purpose: this pin must stay carrier-less (a
  // "[Compressed m…" receipt would itself be a recognized fold point).
  const result = mk("tool", "tool-result", "Compression finished: 1 block, ~200 tokens saved.", { toolName: "compress", toolCallId: "call_c1" });
  const keep = mk("user", "text", "KEEP ME");
  const tail = mk("user", "text", "new question");
  const entry = [sys, c1, c2, call, result, keep, tail];
  const exit = [sys, call, result, tail]; // keep DROPPED; c1/c2 legitimately folded
  const v = judgeInboundOutbound(entry, exit, { coveredIds: new Set([c1.id, c2.id]) });
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.index === 5), JSON.stringify(v.violations));
});

test("#4408 nearTwin: different toolName is a drop, not a rewrite (label precision)", () => {
  const bash = mk("assistant", "tool-call", "{\"command\":\"ls\"}", { toolName: "bash", toolCallId: "t1" });
  const next = mk("user", "text", "next");
  const web = mk("assistant", "tool-call", "{\"url\":\"x\"}", { toolName: "web_search", toolCallId: "t2" });
  const v = judgeInboundOutbound([bash, next], [web, next]);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-drop"), JSON.stringify(v.violations));
  assert.ok(!v.violations.some((x) => x.kind === "mid-history-rewrite"));
});

test("#4408 nearTwin: same toolName with different args stays a rewrite", () => {
  // Same toolCallId on purpose: the twin predicate already requires id
  // compatibility (KDD#11 re-mint churn) — this pins the toolName clause only.
  const bashA = mk("assistant", "tool-call", "{\"command\":\"ls\"}", { toolName: "bash", toolCallId: "t1" });
  const next = mk("user", "text", "next");
  const bashB = mk("assistant", "tool-call", "{\"command\":\"rm -rf /\"}", { toolName: "bash", toolCallId: "t1" });
  const v = judgeInboundOutbound([bashA, next], [bashB, next]);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-rewrite"), JSON.stringify(v.violations));
});

test("#4408 wiring: maybeRunInvariantJudge threads coveredIds (green with coverage, red without)", () => {
  const seen: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => seen.push(v));
  try {
    // No system message: openaiToCore does not project one into the core
    // (the wire codec drops it), so it cannot take part in the comparison.
    const receipt = "[Compressed m00002–m00003 → 1 block(s), ~200 tokens saved.]";
    const body = JSON.stringify({ model: "m", messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_c1", type: "function", function: { name: "compress", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_c1", content: receipt },
      { role: "user", content: "new question" },
    ] });
    const q1 = mk("user", "text", "q1");
    const a1 = mk("assistant", "text", "a1");
    const entry = [q1, a1,
      mk("assistant", "tool-call", "{}", { toolName: "compress", toolCallId: "call_c1" }),
      mk("tool", "tool-result", receipt, { toolName: "compress", toolCallId: "call_c1" }),
      mk("user", "text", "new question")];
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-cov" });
    assert.equal(seen.at(-1)?.ok, false, JSON.stringify(seen.at(-1)?.violations));
    seen.length = 0;
    maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-cov", coveredIds: new Set([q1.id, a1.id]) });
    assert.equal(seen.at(-1)?.ok, true, JSON.stringify(seen.at(-1)?.violations));
    assert.equal(seen.at(-1)?.folded, true);
  } finally {
    _setInvariantJudgeForTest(false);
  }
});
