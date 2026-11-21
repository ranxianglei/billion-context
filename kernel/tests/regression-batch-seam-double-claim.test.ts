// Regression: two adjacent ranges in ONE compress batch both claimed the
// seam messages (a tool-call/tool-result pair sitting on the boundary
// between them).
//
// Live incident: pi session 01a1f6ff (2026-11-20) — one compress call with
// two ranges, "m04508–m04512 (question + partial answer)" and
// "m04513–m04515 (the fold itself, meta)". The fold's own carrier pair
// (compress tool-call + tool-result) sat exactly at the seam; both sibling
// blocks b100 and b101 recorded the same two directMessageIds, their seq
// intervals overlapped (4694–4698 / 4697–4698), and a later fold then
// consumed b101 positionally although b101's ref range (m04513–m04515) lay
// OUTSIDE the newer block's range (m04469–m04511).
//
// Root cause: the coverage snapshot (collectCoverage) was frozen once before
// the batch; the per-range projection (unit-projection.ts) filters a range's
// direct claims against that frozen set, so a later sibling could not see
// what an earlier sibling had just claimed. The no-overlapping-active-
// siblings invariant (compress.ts header contract) was bypassed on exactly
// this path.
//
// Fix: refresh the snapshot inside the batch loop (first-come-first-served
// ownership of seam messages); a range left with nothing new becomes the
// #4521 idempotent no-op (warning, no error, batch survives).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

const LIMIT = 872_000;

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.75,
      minContextLimitPct: 0.05,
      frequency: 1,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.06,
      growthFloor: 50_000,
      growthCap: 50_000,
      minGrowthFloor: 22_500,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 1 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: LIMIT,
    ...overrides,
  };
}

function text(id: string, role: CoreMessage["role"], len = 3000): CoreMessage {
  return { id, role, contentType: "text", text: "x".repeat(len) };
}

function toolCall(id: string, callId: string, toolName = "bash"): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName, toolCallId: callId, text: `args-${callId}` };
}

function toolResult(id: string, callId: string, toolName = "bash", len = 3000): CoreMessage {
  return { id, role: "tool", contentType: "tool-result", toolName, toolCallId: callId, text: "x".repeat(len) };
}

function seed(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  return state;
}

/** Invariant under test: no two ACTIVE sibling blocks directly claim the
 *  same message. */
function assertDisjointDirectClaims(state: ReturnType<typeof createInitialState>, label: string): void {
  const claims = new Map<string, string>();
  for (const b of state.blocks) {
    if (!b.active) continue;
    for (const id of b.directMessageIds) {
      const other = claims.get(id);
      assert.equal(
        other,
        undefined,
        `${label}: message ${id} is directly claimed by BOTH block ${other} and block ${b.blockId}`,
      );
      claims.set(id, b.blockId);
    }
  }
}

test("adjacent ranges in one batch must not double-claim the seam tool pair", () => {
  const core = createCore();
  // m00001 u0 / m00002 a1 / m00003 a2 / m00004 call / m00005 result /
  // m00006 a3 / m00007 u1 — the tool pair sits on the boundary between the
  // two requested ranges, exactly like the fold's carrier pair in the
  // live incident.
  const messages = [
    text("u0", "user"),
    text("a1", "assistant"),
    text("a2", "assistant"),
    toolCall("c1", "call-1"),
    toolResult("r1", "call-1"),
    text("a3", "assistant"),
    text("u1", "user"),
  ];
  const state = seed(messages);

  const r = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00004", summary: "part one: lead-up and the call" },
      { startRef: "m00005", endRef: "m00007", summary: "part two: the result and the tail" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(r.result.errors.length, 0, r.result.errors.join("; "));
  const created = r.state.blocks.length;
  assert.ok(created >= 1, `expected at least one block, got ${created}`);
  assertDisjointDirectClaims(r.state, "seam pair");
});

test("seam range left with nothing new is an idempotent no-op, not a batch rejection", () => {
  const core = createCore();
  // Same shape as the first test, but the second range's ONLY compressible
  // content is the seam pair itself (kept small so nothing else is left):
  // m00001 a1 / m00002 a2 / m00003 call / m00004 result.
  const messages = [
    text("a1", "assistant"),
    text("a2", "assistant"),
    toolCall("c1", "call-1"),
    toolResult("r1", "call-1"),
  ];
  const state = seed(messages);

  const r = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00003", summary: "lead-up and the call" },
      { startRef: "m00004", endRef: "m00004", summary: "the result alone" },
    ],
    messages,
    state,
    config: config(),
  });

  // The batch must survive: no errors, the second range reports the
  // #4521 no-op class (folded nothing, do not resend).
  assert.equal(r.result.errors.length, 0, r.result.errors.join("; "));
  assert.ok(
    r.result.warnings.some((w) => /folded nothing/.test(w) && /do not resend this range/.test(w)),
    `expected a no-op warning for the emptied seam range, got: ${JSON.stringify(r.result.warnings)}`,
  );
  assertDisjointDirectClaims(r.state, "result alone");
});

test("pre-existing covering block (no same-batch block) gets the covered wording, never a same-batch claim", () => {
  const core = createCore();
  // The covering block is created in an EARLIER turn; the retried range is a
  // sub-range of it whose anchor lies outside the requested span, so the
  // covering block is not nested in the range and the no-op lands on the
  // allCovered branch with no block created in this batch.
  const messages = [
    text("a1", "assistant"),
    text("a2", "assistant"),
    text("a3", "assistant"),
    text("a4", "assistant"),
    text("u1", "user"),
  ];
  const state = seed(messages);

  const r1 = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: "early material" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(r1.result.errors.length, 0, r1.result.errors.join("; "));
  assert.equal(r1.state.blocks.length, 1, "expected exactly one pre-existing block");

  const r2 = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00004", summary: "retry sub-range" }],
    messages,
    state: r1.state,
    config: config(),
  });
  assert.equal(r2.result.errors.length, 0, r2.result.errors.join("; "));
  const warning = r2.result.warnings.find((w) => /folded nothing/.test(w));
  assert.ok(warning, `expected a no-op warning, got: ${JSON.stringify(r2.result.warnings)}`);
  // The covered wording — not the protected/filtered one — and no claim of
  // same-batch involvement (no block was created in this batch).
  assert.match(warning, /already covered by active block/);
  assert.doesNotMatch(warning, /same batch/);
  assertDisjointDirectClaims(r2.state, "pre-existing cover");
});
