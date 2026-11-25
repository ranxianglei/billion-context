import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { dedupeViolation, _resetViolationDedupeForTest, maybeRunInvariantJudge } from "../src/invariant-judge.js";
import { setLogCapture } from "../src/logger.js";

let n = 0;
function mk(role: CoreMessage["role"], contentType: CoreMessage["contentType"], text?: string): CoreMessage {
  n++;
  return { id: `m${String(n).padStart(5, "0")}`, role, contentType, ...(text !== undefined ? { text } : {}) };
}

test("violation dedupe: first sighting logs, repeats stay quiet until a power of two", () => {
  _resetViolationDedupeForTest();
  const seen = Array.from({ length: 9 }, () => dedupeViolation("s1|1|mid-history-drop|9|x"));
  assert.deepEqual(seen.map((r) => r.log), [true, true, false, true, false, false, false, true, false]);
  assert.deepEqual(seen.filter((r) => r.log).map((r) => r.count), [1, 2, 4, 8]);
});

test("NEG: a different finding or session is a new sighting and logs", () => {
  _resetViolationDedupeForTest();
  assert.equal(dedupeViolation("s1|1|mid-history-drop|9|x").log, true);
  assert.equal(dedupeViolation("s1|1|mid-history-drop|9|y").log, true);
  assert.equal(dedupeViolation("s2|1|mid-history-drop|9|x").log, true);
});

test("dedupe table is bounded and evicts the oldest key", () => {
  _resetViolationDedupeForTest();
  for (let i = 0; i < 3000; i++) dedupeViolation(`k${i}`);
  assert.equal(dedupeViolation("k0").log, true);
});

test("defaultSink dedupes identical violations end-to-end (first + powers of two, quiet in between)", () => {
  _resetViolationDedupeForTest();
  const lines: Array<[string, string]> = [];
  setLogCapture((level, msg) => lines.push([level, msg]));
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi"), mk("user", "text", "q")];
  const body = JSON.stringify({ model: "m", messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi REWRITTEN BY DEFECT" },
    { role: "user", content: "q" },
  ] });
  try {
    for (let i = 0; i < 9; i++) {
      maybeRunInvariantJudge({ originalMessages: entry, body, protocol: "openai", sessionId: "s-dedupe" });
    }
    const judgeLines = lines.filter(([, m]) => m.includes("[invariant-judge"));
    assert.equal(judgeLines.length, 4, JSON.stringify(judgeLines));
    assert.ok(judgeLines[0]![1].includes("I1 violation:"));
    assert.ok(judgeLines[0]![1].includes("s-dedupe"));
    assert.ok(judgeLines[1]![1].includes("(seen 2x)"));
    assert.ok(judgeLines[2]![1].includes("(seen 4x)"));
    assert.ok(judgeLines[3]![1].includes("(seen 8x)"));
  } finally {
    setLogCapture(null);
  }
});
