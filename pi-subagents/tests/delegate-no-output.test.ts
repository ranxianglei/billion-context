import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDelegateOutcome, formatSyncResult, genuineNoOutput } from "../src/delegate-tool.js";

function result(over: Partial<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }>) {
  return { code: 0, signal: null as NodeJS.Signals | null, stdout: "", stderr: "", timedOut: false, ...over };
}

test("genuineNoOutput: true only for a real exit-0 run with zero reply text", () => {
  assert.equal(genuineNoOutput(0, false, ""), true);
  assert.equal(genuineNoOutput(0, false, "   \n\t"), true);
  assert.equal(genuineNoOutput(0, false, "done"), false);
  assert.equal(genuineNoOutput(1, false, ""), false);
  assert.equal(genuineNoOutput(null, false, ""), false, "watchdog kill (code null) is owned by the existing failure path");
  assert.equal(genuineNoOutput(0, true, ""), false, "timeouts keep their own 'timed out' label");
});

test("formatSyncResult: exit 0 + empty stdout is FAILED with the no-final-output diagnostic", () => {
  const out = formatSyncResult("oracle", "del_x", "task", result({ stdout: "" }), "/out.out");
  assert.match(out, /FAILED ⚠️/);
  assert.match(out, /NO final reply text/);
  assert.doesNotMatch(out, /completed/);
});

test("formatSyncResult: normal completed run keeps the plain payload", () => {
  const out = formatSyncResult("oracle", "del_x", "task", result({ stdout: "the answer" }), "/out.out");
  assert.match(out, /completed/);
  assert.doesNotMatch(out, /FAILED/);
  assert.doesNotMatch(out, /NO final reply text/);
});

test("formatSyncResult: nonzero exit stays on the stderr failure path", () => {
  const out = formatSyncResult("oracle", "del_x", "task", result({ code: 1, stderr: "boom" }), "/out.out");
  assert.match(out, /FAILED ⚠️/);
  assert.match(out, /boom/);
  assert.doesNotMatch(out, /NO final reply text/);
});

test("formatSyncResult: watchdog timeout label is untouched by the no-output rule", () => {
  const out = formatSyncResult("oracle", "del_x", "task", result({ code: null, timedOut: true }), "/out.out");
  assert.match(out, /timed out/);
  assert.doesNotMatch(out, /NO final reply text/);
});

// #4359 regression matrix: async run status classification. The two rows the
// old code got wrong (watchdog kill + partial text / stderr → "completed") are
// marked. Sync parity: with agentSettled=false the async rule must project
// exactly onto the sync ternary (timedOut → failed).
const MATRIX: Array<{
  name: string;
  code: number | null;
  timedOut: boolean;
  agentSettled: boolean;
  output: string;
  stderr: string;
  expected: "completed" | "failed";
}> = [
  { name: "normal success (settled)", code: 0, timedOut: false, agentSettled: true, output: "the answer", stderr: "", expected: "completed" },
  { name: "normal success (no settle event, e.g. omp plain mode)", code: 0, timedOut: false, agentSettled: false, output: "the answer", stderr: "", expected: "completed" },
  { name: "exit-0 empty output (settled) stays loud failure", code: 0, timedOut: false, agentSettled: true, output: "", stderr: "", expected: "failed" },
  { name: "exit-0 empty output (non-settled) stays loud failure", code: 0, timedOut: false, agentSettled: false, output: "", stderr: "", expected: "failed" },
  { name: "REGRESSION: timeout with only partial progress text was 'completed'", code: null, timedOut: true, agentSettled: false, output: "I will inspect the files first…", stderr: "", expected: "failed" },
  { name: "REGRESSION: timeout with only stderr was 'completed'", code: null, timedOut: true, agentSettled: false, output: "", stderr: "warning: something went sideways", expected: "failed" },
  { name: "timeout with no output at all (unchanged)", code: null, timedOut: true, agentSettled: false, output: "", stderr: "", expected: "failed" },
  { name: "settled then teardown/EOF hang keeps the success exception", code: null, timedOut: false, agentSettled: true, output: "full report delivered", stderr: "", expected: "completed" },
  { name: "race: kill recorded first, late agent_settled still counts as settled", code: null, timedOut: true, agentSettled: true, output: "partial but delivered", stderr: "", expected: "completed" },
  { name: "watchdog kill, child still exits 0 gracefully — not a success", code: 0, timedOut: true, agentSettled: false, output: "partial", stderr: "", expected: "failed" },
  { name: "nonzero exit with partial output stays failed", code: 1, timedOut: false, agentSettled: false, output: "partial", stderr: "boom", expected: "failed" },
  { name: "external kill without settle evidence is not a delivery", code: null, timedOut: false, agentSettled: false, output: "partial", stderr: "", expected: "failed" },
  { name: "spawn error (code null, stderr only) stays failed", code: null, timedOut: false, agentSettled: false, output: "", stderr: "spawn ENOENT", expected: "failed" },
];

test("classifyDelegateOutcome: full terminal-state matrix (#4359)", () => {
  for (const row of MATRIX) {
    assert.equal(
      classifyDelegateOutcome(row.code, row.timedOut, row.agentSettled, row.output, row.stderr),
      row.expected,
      row.name,
    );
  }
});

test("classifyDelegateOutcome: non-settled runs match the sync ternary exactly (#4359 async/sync parity)", () => {
  for (const row of MATRIX.filter((r) => !r.agentSettled)) {
    const syncStatus = row.timedOut ? "failed" : row.code === 0 && !genuineNoOutput(row.code, row.timedOut, row.output) ? "completed" : "failed";
    assert.equal(classifyDelegateOutcome(row.code, row.timedOut, false, row.output, row.stderr), syncStatus, row.name);
  }
});
