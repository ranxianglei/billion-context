import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
import { indexToRef } from "../src/refs.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

// ASCII payload: defaultCountTokens treats non-CJK remainder as chars/4, so
// token counts below are exact arithmetic, letting tests assert real values.
const pad = (n: number): string => "a".repeat(n);

interface Pair {
  callId: string;
  toolName: string;
  resultChars: number;
}

function toolHeavySession(pairs: Pair[], textChars = 200): CoreMessage[] {
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: pad(textChars) },
  ];
  for (const p of pairs) {
    messages.push({
      id: `call-${p.callId}`,
      role: "assistant",
      contentType: "tool-call",
      toolName: p.toolName,
      toolCallId: p.callId,
      text: "{}",
    });
    messages.push({
      id: `res-${p.callId}`,
      role: "user",
      contentType: "tool-result",
      toolCallId: p.callId,
      text: pad(p.resultChars),
    });
  }
  return messages;
}

function stateFor(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  messages.forEach((m, i) => {
    const ref = indexToRef(i + 1);
    state.messageRefs.byRaw[m.id] = ref;
    state.messageRefs.byRef[ref] = m.id;
  });
  return state;
}

function breakdownLine(report: string): string {
  const line = report
    .split("\n")
    .find((l) => l.includes(" tool (") && l.includes(" text ("));
  assert.ok(line, `no breakdown line in:\n${report}`);
  return line;
}

function bucketPct(line: string, label: string): number {
  const m =
    new RegExp(`\\((\\d+)%\\) \\| ${label}`).exec(line) ??
    new RegExp(`${label} \\((\\d+)%\\)`).exec(line);
  assert.ok(m, `no ${label} pct in: ${line}`);
  return Number(m[1]);
}

test("tool-result volume is attributed to the tool bucket (#386)", () => {
  // 5 tools x 10_000 chars ASCII = 5 x 2_500 = 12_500 tokens of tool
  // RESULTS. Wire adapters set toolName only on the call, never the result.
  const pairs: Pair[] = [
    { callId: "c1", toolName: "bash", resultChars: 10_000 },
    { callId: "c2", toolName: "read", resultChars: 10_000 },
    { callId: "c3", toolName: "edit", resultChars: 10_000 },
    { callId: "c4", toolName: "grep", resultChars: 10_000 },
    { callId: "c5", toolName: "bash", resultChars: 10_000 },
  ];
  const messages = toolHeavySession(pairs);
  const report = buildStatusReport(
    stateFor(messages),
    messages,
    defaultCountTokens,
  );
  const line = breakdownLine(report);
  // 12_500 tool vs 50 text + 5 calls x 1 = true ratio must be ~99%.
  assert.ok(line.includes("12.5K tool"), `tool bucket wrong: ${line}`);
  assert.ok(bucketPct(line, "tool") >= 99, `tool pct wrong: ${line}`);
});

test("tool-results resolve back to their calling tool's name (#386)", () => {
  const pairs: Pair[] = [
    { callId: "c1", toolName: "bash", resultChars: 8_000 },
    { callId: "c2", toolName: "read", resultChars: 2_000 },
  ];
  const messages = toolHeavySession(pairs);
  const state = stateFor(messages);
  const report = buildStatusReport(state, messages, defaultCountTokens);
  const top = report.split("\n").find((l) => l.startsWith("  Top tools:"));
  assert.ok(top, `no Top tools line in:\n${report}`);
  assert.ok(top.includes("bash"), `bash missing: ${top}`);
  assert.ok(top.includes("read"), `read missing: ${top}`);
  const textPct = /text \((\d+)%\)/.exec(top);
  assert.ok(
    !textPct || Number(textPct[1]) <= 5,
    `text dominates Top tools: ${top}`,
  );
  // Message drilldown by resolved name lists the result refs.
  const byName = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "messages",
    tool: "bash",
  });
  assert.ok(
    byName.includes("m00003"),
    `bash drilldown should include result ref:\n${byName}`,
  );
});

test("orphan tool-results fall into the generic tool bucket, not text (#386)", () => {
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: pad(200) },
    {
      id: "m2",
      role: "user",
      contentType: "tool-result",
      toolCallId: "missing-call",
      text: pad(8_000),
    },
  ];
  const state = stateFor(messages);
  const report = buildStatusReport(state, messages, defaultCountTokens);
  const line = breakdownLine(report);
  assert.ok(
    line.includes("2.0K tool"),
    `orphan result should stay in tool bucket: ${line}`,
  );
  assert.ok(bucketPct(line, "tool") >= 97, `tool pct wrong: ${line}`);
});

test("pct() has no artificial floor: tiny buckets show 0% and sum <= 100 (#386)", () => {
  const pairs: Pair[] = [
    { callId: "c1", toolName: "bash", resultChars: 40_000 },
  ];
  const messages = toolHeavySession(pairs, 4);
  const report = buildStatusReport(
    stateFor(messages),
    messages,
    defaultCountTokens,
  );
  const line = breakdownLine(report);
  const toolPct = bucketPct(line, "tool");
  const textPct = bucketPct(line, "text");
  const sumPct = bucketPct(line, "summaries");
  assert.equal(textPct, 0, `1 token of 10_002 must round to 0%, got: ${line}`);
  assert.ok(
    toolPct + textPct + sumPct <= 100,
    `bucket sum exceeds 100: ${line}`,
  );
});

test("ranges view attributes resolved tool names consistently with the breakdown (#386)", () => {
  const pairs: Pair[] = [
    { callId: "c1", toolName: "bash", resultChars: 8_000 },
  ];
  const messages = toolHeavySession(pairs);
  const state = stateFor(messages);
  const ranges = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  const rangeLines = ranges.split("\n").filter((l) => /^  m\d/.test(l));
  assert.ok(rangeLines.length > 0, `no range lines:\n${ranges}`);
  const resultRange = rangeLines.find((l) => l.trimEnd().endsWith("bash"));
  assert.ok(resultRange, `result range should be labeled bash:\n${ranges}`);
});
