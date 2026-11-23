import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultCountTokens } from "../src/tokenize.js";
import {
  collectFailedCompressCallIds,
  isMessageProtected,
} from "../src/protected.js";
import type {
  Config,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

/**
 * #7536: BLOCKED compress residue must not masquerade as uncompressed fold
 * targets. Successful compress exchanges are ALWAYS_PROTECTED_TOOLS → their
 * call+result halves carry the BLOCKED sentinel (no numeric ref), forever —
 * the ref side never consults the #4348 aged exemption, only the fold gate
 * does (aged pairs are consumed by any fold spanning their position; the
 * newest 3 are protected working memory).
 *
 * Old output: range rows like `m00007–BLOCKED ⚠ not foldable: refs
 * unresolvable` (the whole turn died on one pinned pair) and a detail view
 * flooded with identical `BLOCKED (x) compress` rows that read as
 * uncompressible junk. The nudge table meanwhile skips BLOCKED silently.
 *
 * New output aligns all three surfaces:
 *   - range rows are built from the resolvable entries only (same splits as
 *     buildCompressibleRanges — it bridges over BLOCKED without a gap);
 *   - the pinned mass gets its own labeled section carrying the #4348 truth
 *     (aged folds when spanned / newest are working memory);
 *   - the detail view labels each BLOCKED compress row aged vs newest.
 */

function config(): Config {
  return {
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
    protectedTools: ["compress"],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
  };
}

let n = 0;
function raw(text: string, role: "user" | "assistant" = "user"): CoreMessage {
  n++;
  return { id: `raw${n}`, role, contentType: "text", text };
}
function exchange(i: number, kind: "ok" | "failed", size = 1500): CoreMessage[] {
  n++;
  const callId = `t${n}`;
  const call: CoreMessage = {
    id: `cc${n}`,
    role: "assistant",
    contentType: "tool-call",
    toolName: "compress",
    toolCallId: callId,
    text: JSON.stringify({ content: `m0000${i}\u2013m0001${i} topic\nsummary` }),
  };
  n++;
  const result: CoreMessage = {
    id: `cr${n}`,
    role: "tool",
    contentType: "tool-result",
    toolName: "compress",
    toolCallId: callId,
    text:
      kind === "ok"
        ? `[Compressed m0000${i}\u2013m0001${i} -> 1 block(s), ~${size} tokens saved.]\n` +
          "x".repeat(size)
        : `[Compression refused: coverage regression \u2014 nothing applied.\n` +
          "y".repeat(400),
  };
  return [call, result];
}

// Long pi-lane shape: 5 aged successful exchanges, one failed exchange
// (zero-applied → foldable refs, #4289), newest 3 successful, raw turns
// interleaved. Refs: every successful pair BLOCKED, failed pair numbered.
function fixture(): { state: CompressionState; view: CoreMessage[]; cfg: Config } {
  n = 0;
  const view: CoreMessage[] = [];
  view.push(raw("kickoff", "user"));
  for (let i = 1; i <= 5; i++) {
    view.push(raw(`turn after fold ${i}`, i % 2 ? "assistant" : "user"));
    view.push(...exchange(i, "ok", 1500 + i * 300));
  }
  view.push(raw("middle work", "user"));
  view.push(...exchange(6, "failed"));
  view.push(raw("more work", "assistant"));
  view.push(...exchange(7, "ok", 2200));
  view.push(...exchange(8, "ok", 2600));
  view.push(...exchange(9, "ok", 3100));
  view.push(raw("current question", "user"));
  const cfg = config();
  const state = createInitialState();
  state.messageRefs = assignRefs(view, {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: (m) => isMessageProtected(m, cfg, collectFailedCompressCallIds(view, cfg)),
  }).map;
  return { state, view, cfg };
}

interface ParsedRange {
  startRef: string;
  endRef: string;
  count: number;
}
function parseRanges(report: string): ParsedRange[] {
  return [
    ...report.matchAll(/^  (m\d+)(?:\u2013(m\d+))?\s+\((\d+) msgs,/gm),
  ].map((m) => ({
    startRef: m[1]!,
    endRef: m[2] ?? m[1]!,
    count: Number(m[3]),
  }));
}
function ranges(
  state: CompressionState,
  view: CoreMessage[],
  cfg: Config,
  options: Record<string, unknown> = {},
): string {
  return buildStatusReport(state, view, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    config: cfg,
    originalMessages: view,
    ...options,
  });
}

test("ranges view: no BLOCKED range rows, no 'refs unresolvable' phantoms", () => {
  const { state, view, cfg } = fixture();
  const report = ranges(state, view, cfg);
  assert.ok(!report.includes("\u2013BLOCKED"), report);
  assert.ok(!/^  (m\d+\u2013)?BLOCKED /m.test(report), report);
  assert.ok(!report.includes("refs unresolvable"), report);
  // header: 11 numbered raw msgs, 16 pinned halves (8 successful pairs)
  assert.ok(
    report.includes("| 11 visible messages + 16 unrefed"),
    `header miscounts: ${report.split("\n")[0]}`,
  );
  // #6936 regression pin: the internal sentinel never reaches the surface
  assert.ok(!report.includes("BLOCKED"), report);
});

test("ranges view: UNREFED section carries the #4348 aged/newest split", () => {
  const { state, view, cfg } = fixture();
  const report = ranges(state, view, cfg);
  assert.match(report, /UNREFED MESSAGES \u2014 16 msg\(s\)/);
  assert.match(
    report,
    /compress: 8 exchange\(s\), \S+ \u2014 pinned compress receipts: 3 newest = working memory; the 5 older exchange\(s\) are consumed by any fold that spans their position/,
    report,
  );
});

test("ranges view: without config the section is generic, never wrong", () => {
  const { state, view, cfg } = fixture();
  void cfg;
  const report = buildStatusReport(state, view, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
  });
  assert.match(report, /UNREFED MESSAGES \u2014 16 msg\(s\)/);
  assert.ok(
    report.includes("pinned compress receipts"),
    report,
  );
  assert.ok(!report.includes("working memory"), "no #4348 claim without a config to judge aged/newest");
  assert.ok(!report.includes("BLOCKED"), report);
});

test("detail view: BLOCKED compress rows are labeled aged vs newest, like the fold gate sees them", () => {
  const { state, view, cfg } = fixture();
  const report = buildStatusReport(state, view, defaultCountTokens, {
    scope: "uncompressed",
    view: "messages",
    sort: "time",
    config: cfg,
    originalMessages: view,
  });
  const aged = [...report.matchAll(/ \u00b7 aged \u2014 folds when a range spans it/g)].length;
  const newest = [...report.matchAll(/ \u00b7 newest \u2014 working memory/g)].length;
  assert.equal(aged, 10, `5 aged exchanges \u00d7 2 halves, got: ${report}`);
  assert.equal(newest, 6, `3 newest exchanges \u00d7 2 halves, got: ${report}`);
  // #6936: unrefed rows render as (unrefed), never as the raw sentinel
  assert.equal(
    [...report.matchAll(/  \(unrefed\) \(/g)].length,
    16,
    report,
  );
  assert.ok(!report.includes("BLOCKED"), report);
  // the failed exchange kept numeric refs and carries no protection suffix
  assert.ok(!/m00008 .*\u00b7/.test(report) && !/m00009 .*\u00b7/.test(report), report);
});

test("alignment: ranges view rows === nudge compressible table rows on the same fixture", () => {
  const { state, view, cfg } = fixture();
  const recommended = buildCompressibleRanges(
    view,
    state,
    cfg,
    undefined,
    defaultCountTokens,
  ).compressible.map((r) => ({
    startRef: r.startRef,
    endRef: r.endRef,
    count: r.count,
  }));
  const reported = parseRanges(ranges(state, view, cfg, { sort: "time" }));
  assert.deepEqual(reported, recommended);
  // and none of the aligned rows may be doomed
  const report = ranges(state, view, cfg, { sort: "time" });
  assert.ok(!report.includes("\u26a0"), `aligned rows should all be foldable, got: ${report}`);
});
