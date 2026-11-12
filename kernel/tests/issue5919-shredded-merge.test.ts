/**
 * billion-context#5919 — regression: a mid-turn "shredded turn" (reasoning in a
 * surviving tier-2 block, burst+call in a tier-1 block, result still visible or
 * protected) dead-locked tier distillation on v0.1.213:
 *
 *   - the #5789 exclusion ladder had no rung for the two residual shapes —
 *     it either re-failed with a hard error promising the partners would
 *     "age into coverage" (a false promise: a protected partner can NEVER
 *     enter coverage) or no-opped with a generic "folded nothing" warning
 *     that never named the blocked merge;
 *   - the model retried the doomed merge forever (the reported "any range
 *     covering them fails" loop, session-ad47cd30).
 *
 * Pinned behaviors (post-fix):
 *   1. Foldable stranded partner OUTSIDE the merge span → the merge extends
 *      the fold to that partner (rung 2), creates the merged block, deactivates
 *      the consumed block, and warns exactly what it extended.
 *   2. Protected (BLOCKED-ref) stranded partner → the merge is skipped as an
 *      idempotent NO-OP SUCCESS: no errors, no block, the consumed block stays
 *      ACTIVE, and the warning names the protected refs, says the merge cannot
 *      be closed now, and tells the model NOT to retry.
 *   3. Foldable stranded partner INSIDE the span (the pre-fix working case) →
 *      unchanged: clean merge.
 *   4. The #5789 pinned suite (issue5789-tier2-merge-ladder.test.ts) stays
 *      green — neutral inheritance and poison-block exclusion are untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";

const LONG = "Synthetic historical content, safe for public reproduction. ".repeat(
  120,
);
const SUMMARY = "Synthetic summary for this compression test. ".repeat(4);

const config = defaultConfig(
  255000,
  {
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    isToolProtected: (t: string) =>
      t === "mcp__bili__acp_rule" || t === "mcp__bili__compress",
    isCompressTool: (t: string) =>
      t === "mcp__bili__compress" || t === "compress",
  } as never,
);

/**
 * Layout (8 messages, refs m00001..m00008):
 *   u0 a0 | r | t k | l | far | newuser
 *   m1 m2  m3  m4 m5 m6  m7   m8
 * Blocks: b1=[u0,a0] (real, tier 1), b2=[r] tier 2 (surviving, covers the
 * turn's reasoning), b3=[t,k] tier 1 (the merge target; covers the burst text
 * and the tool call while its result l sits OUTSIDE the block).
 * The turn group is {r, t, k, l} — exactly the shape that strands.
 */
function build(lRef: string, lToolName: string) {
  const core = createCore();
  const mk = (id: string): any => {
    if (id === "u0") return { id, role: "user", contentType: "text", text: LONG };
    if (id === "a0")
      return { id, role: "assistant", contentType: "text", text: "Previous work finished." };
    if (id === "r")
      return { id, role: "assistant", contentType: "reasoning", text: LONG };
    if (id === "t")
      return { id, role: "assistant", contentType: "text", text: LONG };
    if (id === "k")
      return {
        id,
        role: "assistant",
        contentType: "tool-call",
        toolName: "Read",
        toolCallId: "c1",
        text: '{"path":"/tmp/a.txt"}',
      };
    if (id === "l")
      return {
        id,
        role: "tool",
        contentType: "tool-result",
        toolName: lToolName,
        toolCallId: "c1",
        text: LONG,
      };
    if (id === "far")
      return { id, role: "assistant", contentType: "text", text: "Far tail." };
    if (id === "newuser")
      return { id, role: "user", contentType: "text", text: "Continue." };
    throw new Error(`unknown id ${id}`);
  };
  const messages: any[] = [
    mk("u0"),
    mk("a0"),
    mk("r"),
    mk("t"),
    mk("k"),
    mk("l"),
    mk("far"),
    mk("newuser"),
  ];
  const state = createInitialState();
  let n = 1;
  for (const m of messages) {
    const ref =
      lRef === "BLOCKED" && m.id === "l"
        ? "BLOCKED"
        : `m${String(n++).padStart(5, "0")}`;
    state.messageRefs.byRaw[m.id] = ref;
    if (ref !== "BLOCKED") state.messageRefs.byRef[ref] = m.id;
  }
  const seeded = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: SUMMARY }],
  });
  const base = seeded.state.blocks[0]!;
  const push = (
    blockId: string,
    runId: string,
    ids: string[],
    tier = 1,
  ) =>
    seeded.state.blocks.push({
      ...base,
      blockId,
      runId,
      tier,
      directMessageIds: [...ids],
      effectiveMessageIds: [...ids],
      compressedTokens: ids.length * 100,
      startRef: seeded.state.messageRefs.byRaw[ids[0]!]!,
      endRef: seeded.state.messageRefs.byRaw[ids[ids.length - 1]!]!,
    });
  push("b2", "r2", ["r"], 2);
  push("b3", "r3", ["t", "k"]);
  seeded.state.nextBlockId = 4;
  seeded.state.nextRunId = 4;
  seeded.state.stats.compressionCount = 3;
  return { core, messages, state: seeded.state };
}

test("5919-1: foldable stranded partner outside the span → merge extends and recovers", () => {
  const { core, messages, state } = build("m00006", "Read");
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b2", endRef: "b3", summary: SUMMARY }],
  });
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 1);
  const merged = res.state.blocks.find((b) => b.blockId === "b4");
  assert.ok(merged, "the merged block b4 must be created");
  // the extension pulls the stranded result into coverage — the turn closes
  assert.ok(
    merged!.effectiveMessageIds.includes("l"),
    "b4 coverage must include the stranded result l",
  );
  assert.ok(merged!.effectiveMessageIds.includes("t"));
  assert.ok(merged!.effectiveMessageIds.includes("k"));
  // the consumed block deactivates; the surviving tier-2 block stays
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, false);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b2")!.active, true);
  assert.ok(
    res.result.warnings.some((w) =>
      w.startsWith("Extended this merge to fold stranded partner(s)"),
    ),
    `expected the extension warning, got: ${res.result.warnings.join(" | ")}`,
  );
});

test("5919-2: protected (BLOCKED) stranded partner → no-op success, not a retryable error", () => {
  const { core, messages, state } = build("BLOCKED", "Read");
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b2", endRef: "b3", summary: SUMMARY }],
  });
  // idempotent no-op success (#4521): zero errors, zero blocks
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 0);
  // b3 stays ACTIVE — nothing was consumed
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, true);
  const skip = res.result.warnings.find((w) =>
    w.startsWith("Merge of b3 skipped"),
  );
  assert.ok(
    skip,
    `expected the skip warning naming the blocked merge, got: ${res.result.warnings.join(" | ")}`,
  );
  assert.ok(skip!.includes("cannot be closed now"));
  assert.ok(skip!.includes("Do not retry this merge"));
  assert.ok(skip!.includes("BLOCKED"));
  // the old false promise must be gone
  assert.ok(
    !res.result.warnings.some((w) => w.includes("age into coverage")),
    "the 'age into coverage' promise must not appear anywhere",
  );
});

test("5919-3: protected TOOL stranded partner (pinned latest pair) → same no-op skip", () => {
  const { core, messages, state } = build("m00006", "mcp__bili__acp_rule");
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b2", endRef: "b3", summary: SUMMARY }],
  });
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 0);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, true);
  assert.ok(
    res.result.warnings.some((w) =>
      w.startsWith("Merge of b3 skipped") && w.includes("Do not retry"),
    ),
    `expected the skip warning, got: ${res.result.warnings.join(" | ")}`,
  );
});

test("5919-4: foldable partner INSIDE the span (pre-fix working case) → clean fold, unchanged", () => {
  const { core, messages, state } = build("m00006", "Read");
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "m00005", endRef: "m00006", summary: SUMMARY }],
  });
  // pristine behavior: a MESSAGE span folds the visible partner l into a new
  // block without touching the active block(s) (block merging needs b-refs)
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 1);
  const merged = res.state.blocks.find((b) => b.blockId === "b4");
  assert.ok(merged);
  assert.ok(merged!.effectiveMessageIds.includes("l"));
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, true);
});
