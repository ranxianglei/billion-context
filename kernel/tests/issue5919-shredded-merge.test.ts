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

test("5919-2: CONTENT-FREE (BLOCKED) stranded partner → merge proceeds (#6709)", () => {
  // 'Read' is NOT a protected tool, so a ref=BLOCKED 'l' here models a
  // content-free partner (body removed by native compression): nothing live
  // for the integrity gate to protect. #6709: it must flow to rung 2 and be
  // folded into the merged block instead of dead-locking every merge of this
  // turn (the reported 6,115 BLOCKED / 67% ceiling case).
  const { core, messages, state } = build("BLOCKED", "Read");
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b2", endRef: "b3", summary: SUMMARY }],
  });
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 1);
  // b3 is consumed (deactivated); the surviving tier-2 block stays
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, false);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b2")!.active, true);
  const merged = res.state.blocks.find((b) => b.blockId === "b4")!;
  // the extension pulled the content-free BLOCKED result into coverage — the
  // turn closes under the merged block
  assert.ok(merged.effectiveMessageIds.includes("l"), "b4 must cover the BLOCKED result l");
  assert.ok(merged.effectiveMessageIds.includes("t"));
  assert.ok(merged.effectiveMessageIds.includes("k"));
  // the old no-op skip warning must be gone
  assert.ok(
    !res.result.warnings.some((w) => w.startsWith("Merge of b3 skipped")),
    "the skip warning must not appear — the merge now proceeds",
  );
  assert.ok(
    !res.result.warnings.some((w) => w.includes("age into coverage")),
    "the 'age into coverage' promise must not appear anywhere",
  );
});

test("5919-5: LIVE protected tool stored as ref BLOCKED → still no-op (#6709 guard)", () => {
  // A protected tool exchange is pinned to ref BLOCKED by assignRefs WHILE its
  // full body stays in the wire. Exempting ref==BLOCKED partners from the
  // merge-deadlock must NOT weaken those: folding the live call/result in would
  // drop protected content, and leaving them split emits an orphaned tool_call.
  // So a live protected tool that happens to carry ref BLOCKED STILL dooms the
  // merge — the honest idempotent no-op. (This is the case both #6719 and
  // #6731 missed: their tests gave the protected partner a numeric ref.)
  const { core, messages, state } = build("BLOCKED", "mcp__bili__acp_rule");
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b2", endRef: "b3", summary: SUMMARY }],
  });
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 0);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, true);
  const skip = res.result.warnings.find(
    (w) =>
      w.startsWith("Merge of b3 skipped") && w.includes("Do not retry"),
  );
  assert.ok(
    skip,
    `expected the no-op skip warning, got: ${res.result.warnings.join(" | ")}`,
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

/**
 * Build a session whose turn {r, t, k, l} carries a compress receipt 'l'
 * (call k / result l, toolName mcp__bili__compress — a protected tool that
 * assignRefs pins to ref BLOCKED), plus other compress exchanges, so 'l' is
 * either AGED (outside the keepRecent window, #4348) or the NEWEST (inside it).
 * This is the real #6709 incident shape — the 6,115 stale BLOCKED pins were aged
 * compress receipts — and it exercises the #4348 exemption (isExemptFold) that
 * the synthetic 5919-2 'Read' case cannot reach.
 */
function seedCompressReceipt(messages: any[], blockedId: string) {
  const core = createCore();
  const state = createInitialState();
  let n = 1;
  for (const m of messages) {
    const ref =
      m.id === blockedId ? "BLOCKED" : `m${String(n++).padStart(5, "0")}`;
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

const COMPRESS_RECEIPT =
  "[Compressed m00001-m00002 -> 1 block(s), ~100 tokens saved]";
/** one compress call+result exchange (callId `cc${i}`) */
function cex(i: number) {
  return [
    { id: `kc${i}`, role: "assistant", contentType: "tool-call", toolName: "mcp__bili__compress", toolCallId: `cc${i}`, text: "{}" },
    { id: `lc${i}`, role: "tool", contentType: "tool-result", toolName: "mcp__bili__compress", toolCallId: `cc${i}`, text: COMPRESS_RECEIPT },
  ];
}

test("5919-6: AGED compress receipt (real #6709 class) ref BLOCKED → merge proceeds", () => {
  // 'k'/'l' (callId c1) is a compress receipt pinned to ref BLOCKED; three
  // newer compress exchanges follow (c2,c3,c4) → l is OUTSIDE the keepRecent
  // window → aged per #4348 → foldable. This is exactly the incident shape: a
  // stale BLOCKED compress receipt that used to dead-lock every merge of its
  // turn (the 6,115-BLOCKED / 67% ceiling case). It must now fold in.
  const messages: any[] = [
    { id: "u0", role: "user", contentType: "text", text: LONG },
    { id: "a0", role: "assistant", contentType: "text", text: "Previous work finished." },
    ...cex(1),
    { id: "r", role: "assistant", contentType: "reasoning", text: LONG },
    { id: "t", role: "assistant", contentType: "text", text: LONG },
    { id: "k", role: "assistant", contentType: "tool-call", toolName: "mcp__bili__compress", toolCallId: "c1", text: "{}" },
    { id: "l", role: "tool", contentType: "tool-result", toolName: "mcp__bili__compress", toolCallId: "c1", text: COMPRESS_RECEIPT },
    ...cex(2),
    ...cex(3),
    ...cex(4),
    { id: "far", role: "assistant", contentType: "text", text: "Far tail." },
    { id: "newuser", role: "user", contentType: "text", text: "Continue." },
  ];
  const { core, state } = seedCompressReceipt(messages, "l");
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b2", endRef: "b3", summary: SUMMARY }],
  });
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 1);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b3")!.active, false);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b2")!.active, true);
  const merged = res.state.blocks.find((b) => b.blockId === "b4")!;
  assert.ok(merged.effectiveMessageIds.includes("l"), "b4 must cover the aged BLOCKED compress receipt l");
  assert.ok(merged.effectiveMessageIds.includes("t"));
  assert.ok(merged.effectiveMessageIds.includes("k"));
  assert.ok(
    !res.result.warnings.some((w) => w.startsWith("Merge of b3 skipped")),
    "the aged receipt must not be treated as a protected no-op",
  );
});

test("5919-7: NEWEST compress receipt (in keepRecent window) ref BLOCKED → still no-op", () => {
  // Control for 5919-6: 'l' is the NEWEST compress exchange (zero newer), so it
  // is INSIDE the keepRecent working-memory window. Aged-receipt folding must
  // not bleed into the live window — a fresh BLOCKED-pinned compress receipt
  // STILL dooms the merge (honest idempotent no-op, not a bypass).
  const messages: any[] = [
    { id: "u0", role: "user", contentType: "text", text: LONG },
    { id: "a0", role: "assistant", contentType: "text", text: "Previous work finished." },
    ...cex(1),
    ...cex(2),
    ...cex(3),
    { id: "r", role: "assistant", contentType: "reasoning", text: LONG },
    { id: "t", role: "assistant", contentType: "text", text: LONG },
    { id: "k", role: "assistant", contentType: "tool-call", toolName: "mcp__bili__compress", toolCallId: "c1", text: "{}" },
    { id: "l", role: "tool", contentType: "tool-result", toolName: "mcp__bili__compress", toolCallId: "c1", text: COMPRESS_RECEIPT },
    { id: "far", role: "assistant", contentType: "text", text: "Far tail." },
    { id: "newuser", role: "user", contentType: "text", text: "Continue." },
  ];
  const { core, state } = seedCompressReceipt(messages, "l");
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
    res.result.warnings.some(
      (w) => w.startsWith("Merge of b3 skipped") && w.includes("Do not retry"),
    ),
    `expected the no-op skip warning, got: ${res.result.warnings.join(" | ")}`,
  );
});

/**
 * #6709 LOCKSTEP (coupling) regression — pins the invariant that the merge
 * guard's content-free exemption (isContentFreeBlocked5919,
 * unit-projection.ts:591) and the fresh-fold path (unit-projection.ts:250)
 * make the SAME fold/protect decision for a given tool class, because BOTH
 * delegate to `filterProtectedToolMessages` with the identical `shared`
 * context. A partner the fold path protects is therefore NEVER un-doomed by
 * the guard (no live-body drop, no orphaned tool_call/tool_result), and a
 * partner the fold path folds is NEVER left dead-locked (no #6709 regression).
 *
 * We observe the fold path's decision on the NUMERIC-ref twin (a plain
 * message-range fresh-fold, which can only address m-referenced messages) and
 * the guard's decision on the BLOCKED twin (the block-range merge), then assert
 * the two AGREE. The two tool classes below span both branches of the single
 * delegated decision (fold vs protect); the media / paired-result /
 * aged-compress branches are pinned individually by 5919-6/7 and the probe
 * suite and route through the same filter. (Review B risk #1 / review A r1.)
 */
test("6709-lockstep: merge guard and fresh-fold path agree on every BLOCKED class", () => {
  const cases: Array<{ label: string; toolName: string; expectFold: boolean }> = [
    { label: "ordinary (content-free) tool", toolName: "Read", expectFold: true },
    { label: "live protected tool", toolName: "mcp__bili__acp_rule", expectFold: false },
  ];
  for (const c of cases) {
    // fold path: NUMERIC-ref twin, plain message-range fresh-fold of k..l.
    const fold = build("m00006", c.toolName);
    const fres = fold.core.applyCompression({
      messages: fold.messages,
      state: fold.state,
      config,
      ranges: [{ startRef: "m00005", endRef: "m00006", summary: SUMMARY }],
    });
    const fblock = fres.state.blocks.find((b) => b.blockId === "b4");
    const foldPathFolds = !!fblock && fblock.effectiveMessageIds.includes("l");

    // merge guard: BLOCKED twin, block-range merge b2..b3 (strands l).
    const guard = build("BLOCKED", c.toolName);
    const gres = guard.core.applyCompression({
      messages: guard.messages,
      state: guard.state,
      config,
      ranges: [{ startRef: "b2", endRef: "b3", summary: SUMMARY }],
    });
    const guardProceeds = gres.result.blocksCreated === 1;

    assert.equal(
      foldPathFolds,
      c.expectFold,
      `fold path [${c.label}]: expected fold=${c.expectFold}, got ${foldPathFolds}`,
    );
    assert.equal(
      guardProceeds,
      c.expectFold,
      `merge guard [${c.label}]: expected proceed=${c.expectFold}, got ${guardProceeds}`,
    );
    assert.equal(
      foldPathFolds,
      guardProceeds,
      `COUPLING [${c.label}]: fold path (fold=${foldPathFolds}) and merge guard (proceed=${guardProceeds}) MUST agree — a partner the fold path protects must not be un-doomed, and one it folds must not be dead-locked`,
    );
  }
});
