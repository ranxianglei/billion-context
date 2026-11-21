import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { resolveBoundaries } from "../src/boundaries.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type { CompressionBlock, Config, CoreMessage } from "../src/types.js";

// billion-context #6168 (supplementing #6167): acp_status' uncompressed range
// view emitted submittable-looking rows whose endpoints were the BLOCKED
// sentinel (e.g. "BLOCKED–m02518"), flagged "refs unresolvable". Root cause:
// collectVisible includes BLOCKED-ref (policy-protected) messages in `visible`
// — correct for totals — but renderUncompressedRanges then used the group's
// first/last entry verbatim as candidate endpoints, while recommend.ts screens
// BLOCKED out at base-set level. These tests pin the repaired contract:
//   - no rendered candidate may carry a BLOCKED endpoint;
//   - every BLOCKED entry lands exactly once: either in a candidate row's
//     count/tokens (it never does — they go to the aggregate) or in the
//     protected stats line; totals never shrink or double;
//   - eligibility of the surviving candidates is still judged by projectUnit;
//   - genuine (non-BLOCKED) resolution failures show their real reason.

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "assistant",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

const cfg: Config = {
  tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
  nudge: {
    maxContextLimitPct: 0.55,
    minContextLimitPct: 0.45,
    frequency: 5,
    iterationThreshold: 15,
    force: "soft",
    growthRatio: 0.05,
  },
  promotionThreshold: 5,
  truncate: { threshold: 1 },
  merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
  compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
  protectedTools: [],
  preserveRecentMessages: 0,
  preserveRecentTokens: 0,
  modelContextLimit: 100000,
};

function assignRaw(messages: CoreMessage[], rawToRef: Record<string, string>) {
  const state = createInitialState();
  const byRaw: Record<string, string> = {};
  const byRef: Record<string, string> = {};
  for (const m of messages) {
    const ref = rawToRef[m.id];
    byRaw[m.id] = ref;
    if (ref !== "BLOCKED") byRef[ref] = m.id;
  }
  state.messageRefs = { byRaw, byRef };
  return state;
}

/** Candidate rows look like "  m00010–m00011  (2 msgs, ...)"; sum their
 *  message counts. */
function candidateMsgsTotal(report: string): number {
  let total = 0;
  for (const line of report.split("\n")) {
    const m = line.match(/^\s+(?:m\d{1,7}(?:–m\d{1,7})?)\s+\((\d+) msgs/);
    if (m) total += Number(m[1]);
  }
  return total;
}

function protectedMsgsOf(report: string): number | null {
  const m = report.match(/protected: (\d+) msgs/);
  return m ? Number(m[1]) : null;
}

test("leading BLOCKED run trims to a valid candidate + protected stats line (#6168)", () => {
  const A = msg("A", "a".repeat(100));
  const B = msg("B", "b".repeat(100));
  const C = msg("C", "c".repeat(100));
  const D = msg("D", "d".repeat(100));
  const messages = [A, B, C, D];
  const state = assignRaw(messages, {
    A: "BLOCKED",
    B: "BLOCKED",
    C: "m00010",
    D: "m00011",
  });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.match(report, /UNCOMPRESSED .* \| 4 visible messages/, "totals keep every message");
  assert.ok(!report.includes("BLOCKED–") && !/^  BLOCKED/m.test(report),
    `no BLOCKED-endpoint row:\n${report}`);
  assert.equal(protectedMsgsOf(report), 2, "both blocked entries aggregated");
  assert.match(report, /m00010–m00011\s+\(2 msgs/, "candidate spans the normal members");
  // Each visible message lands exactly once across the view.
  assert.equal(candidateMsgsTotal(report) + protectedMsgsOf(report)!, 4);

  // Screening ON: the trimmed candidate must pass the real projection
  // (two fresh, unprotected messages) — no flag at all.
  const screened = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    config: cfg,
    originalMessages: messages,
  });
  assert.ok(!screened.includes("⚠"), `candidate judged foldable, got:\n${screened}`);
  assert.ok(!screened.includes("refs unresolvable"));
});

test("all-BLOCKED group emits no candidate range (#6168)", () => {
  const messages = [msg("A", "a".repeat(50)), msg("B", "b".repeat(50)), msg("C", "c".repeat(50))];
  const state = assignRaw(messages, { A: "BLOCKED", B: "BLOCKED", C: "BLOCKED" });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.match(report, /UNCOMPRESSED .* \| 3 visible messages/);
  assert.equal(protectedMsgsOf(report), 3);
  assert.match(report, /no candidate ranges/);
  assert.ok(!/(m\d{1,7})/.test(report.split("Sorted by").pop()!), "no ref rows at all");
});

test("trailing BLOCKED run stays out of the candidate (#6168)", () => {
  const messages = [msg("A", "a".repeat(80)), msg("B", "b".repeat(80)), msg("C", "c".repeat(80))];
  const state = assignRaw(messages, { A: "m00010", B: "m00011", C: "BLOCKED" });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.ok(!report.includes("–BLOCKED") && !/BLOCKED$/.test(report), report);
  assert.equal(protectedMsgsOf(report), 1);
  assert.match(report, /m00010–m00011\s+\(2 msgs/);
  assert.equal(candidateMsgsTotal(report) + protectedMsgsOf(report)!, 3);
});

test("mid-group BLOCKED leaves the candidate count but not the span (#6168)", () => {
  const messages = [msg("A", "a".repeat(60)), msg("B", "b".repeat(60)), msg("C", "c".repeat(60))];
  const state = assignRaw(messages, { A: "m00010", B: "BLOCKED", C: "m00011" });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.equal(protectedMsgsOf(report), 1, "the interleaved entry is aggregated too");
  assert.match(report, /m00010–m00011\s+\(2 msgs/, "count holds normal members only");
  assert.equal(candidateMsgsTotal(report) + protectedMsgsOf(report)!, 3, "no missing/double counts");
});

test("non-monotonic refs keep array adjacency and ascending display (#6168/#1001/#2168)", () => {
  const messages = [msg("A", "a".repeat(40)), msg("B", "b".repeat(40)), msg("C", "c".repeat(40))];
  const state = assignRaw(messages, { A: "m00030", B: "m00010", C: "m00011" });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  // Endpoints are the FIRST and LAST array entries (m00030, m00011), rendered
  // in canonical ascending order; the middle entry m00010 is inside the span.
  assert.match(report, /m00011–m00030\s+\(3 msgs/, "one positional span, canonical labels");
  const resolved = resolveBoundaries({
    startRef: "m00011",
    endRef: "m00030",
    messages,
    state,
  });
  assert.deepEqual(resolved.messageIds, ["A", "B", "C"], "span covers array adjacency, not ref arithmetic");

  // Same shape with a leading BLOCKED: trimmed candidate keeps the span.
  const state2 = assignRaw(messages, { A: "BLOCKED", B: "m00030", C: "m00010" });
  const report2 = buildStatusReport(state2, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.match(report2, /m00010–m00030\s+\(2 msgs/);
  assert.equal(protectedMsgsOf(report2), 1);
});

test("genuine resolution failure shows its real reason, not 'refs unresolvable' (#6168/#5667)", () => {
  // B is visible in the report view but absent from the exact apply-view class
  // screening judges on — a true boundary failure, distinct from protection.
  const A = msg("A", "a".repeat(70));
  const B = msg("B", "b".repeat(70));
  const messages = [A, B];
  const state = assignRaw(messages, { A: "m00010", B: "m00011" });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    config: cfg,
    originalMessages: [A],
  });
  assert.match(report, /⚠ not foldable: .+not found in visible context/);
  assert.ok(!report.includes("refs unresolvable"), "flat misdiagnosis gone");
});

test("sort=time and limit keep the protected stats line intact (#6168)", () => {
  const A = msg("A", "a".repeat(300));
  const B = msg("B", "b".repeat(300));
  const E = msg("E", "e".repeat(300));
  const C = msg("C", "c".repeat(300));
  const D = msg("D", "d".repeat(300));
  const messages = [A, B, E, C, D];
  const state = assignRaw(messages, {
    A: "m00010",
    B: "m00011",
    E: "m00012",
    C: "BLOCKED",
    D: "m00020",
  });
  // E is covered by an active block → it consumes a slot and opens the gap
  // between the two groups.
  const block: CompressionBlock = {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "s",
    directMessageIds: ["E"],
    effectiveMessageIds: ["E"],
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
  };
  state.blocks = [block];

  const timed = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    sort: "time",
  });
  const rows = timed.split("\n").filter((l) => /^\s+m\d{1,7}/.test(l));
  assert.deepEqual(rows.map((l) => l.trim().split(/\s+/)[0]), [
    "m00010–m00011",
    "m00020",
  ], "positional order under sort=time");
  assert.equal(protectedMsgsOf(timed), 1);
  assert.equal(candidateMsgsTotal(timed) + protectedMsgsOf(timed)!, 4, "E is covered, not visible");

  const limited = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    sort: "time",
    limit: 1,
  });
  assert.match(limited, /and 1 more ranges/);
  assert.equal(protectedMsgsOf(limited), 1, "stats survive truncation");
});

test("per-message drilldown still lists BLOCKED entries (#6168)", () => {
  const messages = [msg("A", "a".repeat(50)), msg("B", "b".repeat(50))];
  const state = assignRaw(messages, { A: "BLOCKED", B: "m00010" });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "messages",
  });
  assert.match(report, /^\s+BLOCKED \(/m, "blocked content stays individually visible");
  assert.match(report, /^\s+m00010 \(/m);
});

test("normal-only session renders unchanged: no protected line (#6168)", () => {
  const messages = [msg("A", "a".repeat(50)), msg("B", "b".repeat(50)), msg("C", "c".repeat(50))];
  const state = assignRaw(messages, { A: "m00010", B: "m00011", C: "m00012" });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.ok(!report.includes("protected:"), report);
  assert.match(report, /m00010–m00012\s+\(3 msgs/);
  assert.equal(candidateMsgsTotal(report), 3);
});
