import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type { Config, CoreMessage } from "../src/types.js";

// billion-context #6168 (supplementing #6167): acp_status' uncompressed range
// view emitted submittable-looking rows whose endpoints were the BLOCKED
// sentinel (e.g. "BLOCKED–m02518"), flagged "refs unresolvable". The core
// fix (range rows built from resolvable entries only, pinned mass in its own
// labeled section) now lives in report.ts alongside the #7536/#6936 work;
// these tests pin that contract AND the one piece unique to this PR —
// cleanProjectionError: a GENUINE (non-BLOCKED) projection failure shows its
// real reason instead of the flat "refs unresolvable" misdiagnosis that
// read known protection as ledger corruption (#5667 family).

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

test("no BLOCKED sentinel endpoint in candidate rows (#6168)", () => {
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
  // No candidate row may carry a BLOCKED endpoint (either direction).
  assert.ok(!report.includes("BLOCKED–") && !report.includes("–BLOCKED"), report);
  assert.ok(!/^  BLOCKED/m.test(report), report);
  // The two normal members form one candidate span.
  assert.match(report, /m00010–m00011\s+\(2 msgs/, report);
  // The pinned mass is accounted in its own labeled section, never a row.
  assert.match(report, /UNREFED MESSAGES — 2 msg\(s\)/, report);
  // Header keeps the total and names the unrefed count.
  assert.match(report, /UNCOMPRESSED .* \| 2 visible messages \+ 2 unrefed/, report);
});

test("all-BLOCKED view emits no candidate range, only the unrefed section (#6168)", () => {
  const messages = [msg("A", "a".repeat(50)), msg("B", "b".repeat(50)), msg("C", "c".repeat(50))];
  const state = assignRaw(messages, { A: "BLOCKED", B: "BLOCKED", C: "BLOCKED" });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.ok(!/(m\d{1,7})/.test(report), `no ref rows at all:\n${report}`);
  assert.match(report, /UNREFED MESSAGES — 3 msg\(s\)/, report);
  assert.match(report, /\(no raw uncompressed messages\)/, report);
});

test("genuine projection failure shows its real reason, not 'refs unresolvable' (#6168/#5667)", () => {
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
  assert.match(report, /⚠ not foldable: .+not found in visible context/, report);
  assert.ok(!report.includes("refs unresolvable"), "flat misdiagnosis gone");
});

test("normal-only session renders unchanged: no unrefed section (#6168)", () => {
  const messages = [msg("A", "a".repeat(50)), msg("B", "b".repeat(50)), msg("C", "c".repeat(50))];
  const state = assignRaw(messages, { A: "m00010", B: "m00011", C: "m00012" });

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.ok(!report.includes("unrefed"), report);
  assert.ok(!report.includes("UNREFED"), report);
  assert.match(report, /m00010–m00012\s+\(3 msgs/, report);
});
