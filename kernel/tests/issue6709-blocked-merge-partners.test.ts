/**
 * billion-context#6709 — regression: a BLOCKED stranded partner must not veto
 * a block merge forever.
 *
 * #5919 turned the retryable "cannot satisfy turn integrity" fatal into an
 * idempotent no-op when a merge's stranded partner can never fold (BLOCKED /
 * protected tool / unrecoverable media). For BLOCKED that no-op is a permanent
 * deadlock, not a pause: the partner's body was removed by native compression,
 * so it can never age into foldability — its seq is frozen, its text is gone —
 * and every merge covering its turn re-hits the same skip. The reporter's
 * session (session-ad47cd30, 0.1.214) carries 6,115 BLOCKED messages (13.7%
 * of 44,623); merges of old blocks (b312..b315, b312..b313) all skip, and the
 * context stays stuck at 533K/792K.
 *
 * Pinned behaviors (post-fix):
 *   1. BLOCKED stranded partner → the merge PROCEEDS: the ladder extends the
 *      fold to the BLOCKED partner (rung 2, same as a foldable partner), the
 *      turn closes under the merged block, and the consumed block deactivates.
 *      The partner carries no content turn-integrity protects, so folding it
 *      into the merged block loses nothing.
 *   2. BLOCKED + foldable stranded partners → the merge extends to both.
 *   3. BLOCKED + PROTECTED-TOOL stranded partner → still the #5919 no-op:
 *      the protected-tool partner still dooms the merge; exempting BLOCKED
 *      must not weaken protected-tool handling.
 *   4. The #5919 pinned suite (issue5919-shredded-merge.test.ts) stays green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";

const LONG =
  "Synthetic historical content, safe for public reproduction. ".repeat(120);
const SUMMARY = "Synthetic summary for this compression test. ".repeat(4);

const config = defaultConfig(255000, {
  preserveRecentMessages: 0,
  preserveRecentTokens: 0,
  isToolProtected: (t: string) =>
    t === "mcp__bili__acp_rule" || t === "mcp__bili__compress",
  isCompressTool: (t: string) =>
    t === "mcp__bili__compress" || t === "compress",
} as never);

type PartnerSpec = {
  /** "BLOCKED" → ref BLOCKED; otherwise the result gets a numeric ref. */
  ref: string;
  /** Tool name of the stranded RESULT (drives protected-tool handling). */
  toolName: string;
};

/**
 * Layout (one turn, N tool calls; refs m00001.. in message order):
 *   u0 a0 | r t k0 l0 k1 l1 ... | far newuser
 * Blocks: b1=[u0,a0] (seeded, tier 1), b2=[r] tier 2 (surviving, covers the
 * turn's reasoning), b3=[t,k0,k1,...] tier 1 (the merge target; covers the
 * burst text and the tool calls while every result l_i sits OUTSIDE the
 * block). The turn group is {r, t, k_i, l_i} — exactly the shape that
 * strands: merging b2..b3 must close the turn or fail.
 */
function build(specs: PartnerSpec[]) {
  const core = createCore();
  const mk = (id: string, group = 0): any => {
    if (id === "u0")
      return { id, role: "user", contentType: "text", text: LONG };
    if (id === "a0")
      return {
        id,
        role: "assistant",
        contentType: "text",
        text: "Previous work finished.",
      };
    if (id === "r")
      return { id, role: "assistant", contentType: "reasoning", text: LONG };
    if (id === "t")
      return { id, role: "assistant", contentType: "text", text: LONG };
    if (id.startsWith("k"))
      return {
        id,
        role: "assistant",
        contentType: "tool-call",
        toolName: "Read",
        toolCallId: `c${group + 1}`,
        text: '{"path":"/tmp/a.txt"}',
      };
    if (id.startsWith("l"))
      return {
        id,
        role: "tool",
        contentType: "tool-result",
        toolName: specs[group]!.toolName,
        toolCallId: `c${group + 1}`,
        text: LONG,
      };
    if (id === "far")
      return { id, role: "assistant", contentType: "text", text: "Far tail." };
    if (id === "newuser")
      return { id, role: "user", contentType: "text", text: "Continue." };
    throw new Error(`unknown id ${id}`);
  };
  const messages: any[] = [mk("u0"), mk("a0"), mk("r"), mk("t")];
  for (let i = 0; i < specs.length; i++) {
    messages.push(mk(`k${i}`, i), mk(`l${i}`, i));
  }
  messages.push(mk("far"), mk("newuser"));
  const state = createInitialState();
  let n = 1;
  for (const m of messages) {
    const group = /^l(\d+)$/.exec(m.id)?.[1];
    const ref =
      group !== undefined && specs[Number(group)]!.ref === "BLOCKED"
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
  const push = (blockId: string, runId: string, ids: string[], tier = 1) =>
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
  const callIds = specs.map((_, i) => `k${i}`);
  push("b2", "r2", ["r"], 2);
  push("b3", "r3", ["t", ...callIds]);
  seeded.state.nextBlockId = 4;
  seeded.state.nextRunId = 4;
  seeded.state.stats.compressionCount = 3;
  return { core, messages, state: seeded.state };
}

test("6709-1: BLOCKED stranded partner → merge proceeds, turn closes under the merged block", () => {
  const { core, messages, state } = build([
    { ref: "BLOCKED", toolName: "Read" },
  ]);
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b2", endRef: "b3", summary: SUMMARY }],
  });
  // Pre-fix this was the #5919 idempotent no-op (blocksCreated 0, b3 stays
  // active) — the permanent deadlock #6709 reports.
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 1);
  const merged = res.state.blocks.find((b) => b.blockId === "b4");
  assert.ok(merged, "the merged block b4 must be created");
  // the extension pulls the BLOCKED result into coverage — the turn closes
  assert.ok(
    merged!.effectiveMessageIds.includes("l0"),
    "b4 coverage must include the BLOCKED stranded result l0",
  );
  assert.ok(merged!.effectiveMessageIds.includes("t"));
  assert.ok(merged!.effectiveMessageIds.includes("k0"));
  // the consumed block deactivates; the surviving tier-2 block stays
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, false);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b2")!.active, true);
  assert.ok(
    res.result.warnings.some(
      (w) =>
        w.startsWith("Extended this merge to fold stranded partner(s)") &&
        w.includes("BLOCKED"),
    ),
    `expected the extension warning naming BLOCKED, got: ${res.result.warnings.join(" | ")}`,
  );
});

test("6709-2: BLOCKED + foldable stranded partners → merge extends to both", () => {
  const { core, messages, state } = build([
    { ref: "BLOCKED", toolName: "Read" },
    { ref: "numeric", toolName: "Read" },
  ]);
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
  for (const id of ["t", "k0", "l0", "k1", "l1"]) {
    assert.ok(
      merged!.effectiveMessageIds.includes(id),
      `b4 coverage must include ${id}`,
    );
  }
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, false);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b2")!.active, true);
  assert.ok(
    res.result.warnings.some((w) =>
      w.startsWith("Extended this merge to fold stranded partner(s)"),
    ),
    `expected the extension warning, got: ${res.result.warnings.join(" | ")}`,
  );
});

test("6709-3: BLOCKED + PROTECTED-TOOL stranded partners → still the #5919 no-op", () => {
  const { core, messages, state } = build([
    { ref: "BLOCKED", toolName: "Read" },
    { ref: "numeric", toolName: "mcp__bili__acp_rule" },
  ]);
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b2", endRef: "b3", summary: SUMMARY }],
  });
  // Exempting BLOCKED must not weaken protected-tool handling: the
  // protected-tool partner still dooms the merge.
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 0);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, true);
  assert.ok(
    res.result.warnings.some(
      (w) => w.startsWith("Merge of b3 skipped") && w.includes("Do not retry"),
    ),
    `expected the skip warning, got: ${res.result.warnings.join(" | ")}`,
  );
});
