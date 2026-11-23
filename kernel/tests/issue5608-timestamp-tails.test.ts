/** #5608-B/#5608-C: the two remaining one-shot full-prefix-invalidation
 * producers, pinned at the kernel level.
 *
 * #4313 stamps each message's first-sight wall-clock into its `<acp>` tag and
 * renders only the STORED value (prefix-safe). Two cliffs survived #5609:
 *
 *   C — flipping the feature ON mid-session (upgrade default off→on) would
 *       suddenly attach time attributes to EVERY old ref, rewriting the whole
 *       cached prefix in one request.
 *   B — a FRESH-state child seeded from a parent's history would mint
 *       Date.now() for ids it never watched arrive: fabricated "today" values
 *       that lie about display AND propagate into future lineage stamps.
 *
 * Fix under test:
 *   C — `timestampsHighWaterRefSeq`: a message's stored stamp renders into a
 *       tag only when its CURRENT ref index exceeds the mark frozen at the
 *       first enabled pass (= pre-pass highest ref). Old refs keep their
 *       attribute-free bytes; new arrivals tag normally; edits/folds re-mint
 *       refs above the mark for free (the number change already broke those
 *       bytes); ledger alignment raises the mark (#5608-C).
 *   B — `suppressMintingOnce`: armed by the host before a fresh-state child's
 *       first turn; the stamp node yields honest NULL instead of Date.now()
 *       and self-clears on that pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { restampRefsToLedger } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

process.env.TZ = "Asia/Shanghai";

const msg = (id: string, text: string): CoreMessage => ({
  id, role: "user", contentType: "text", text,
});
const timeOf = (t: string | undefined): string | undefined =>
  / time="([^"]+)"/.exec(t ?? "")?.[1];
const cfg = defaultConfig(100000);

test("C: brand-new conversation is fully functional (hwm=0 opens)", () => {
  const core = createCore({ timestamps: true });
  const r1 = core.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta")],
    state: createInitialState(),
    config: cfg, tokenCount: 10,
  });
  assert.ok(timeOf(r1.messages[0]!.text!), "first arrival tagged");
  assert.ok(timeOf(r1.messages[1]!.text!), "second arrival tagged");
  assert.equal(r1.state.timestampsHighWaterRefSeq, 0, "mark frozen at empty-ledger high water");
});

test("C: upgrading the flag mid-session costs zero prefix bytes", () => {
  const off = createCore({});
  const on = createCore({ timestamps: true });
  const p1 = off.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta")],
    state: createInitialState(), config: cfg, tokenCount: 10,
  });
  // Simulated upgrade: same logical session, feature now on, one brand-new
  // turn appended after the restart point.
  const p2 = on.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta"), msg("c", "gamma")],
    state: p1.state, config: cfg, tokenCount: 12,
  });
  assert.equal(timeOf(p2.messages[0]!.text!), undefined, "old a stays attr-free after flag-on");
  assert.equal(timeOf(p2.messages[1]!.text!), undefined, "old b stays attr-free after flag-on");
  assert.ok(timeOf(p2.messages[2]!.text!), "brand-new c IS tagged (its ref exceeds the mark)");
  assert.equal(p2.state.timestampsHighWaterRefSeq, 2, "mark = pre-pass high water, never lower");
  // The mark must not flap on later passes.
  const p3 = on.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta"), msg("c", "gamma")],
    state: p2.state, config: cfg, tokenCount: 12,
  });
  assert.equal(timeOf(p3.messages[0]!.text!), undefined);
  assert.equal(timeOf(p3.messages[2]!.text!), timeOf(p2.messages[2]!.text!));
  assert.equal(p3.state.timestampsHighWaterRefSeq, 2);
});

test("C: ledger alignment raises the mark — restamped old refs gain no attrs", () => {
  const core = createCore({ timestamps: true });
  const p1 = core.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta")],
    state: createInitialState(), config: cfg, tokenCount: 10,
  });
  assert.equal(p1.state.timestampsHighWaterRefSeq, 0);
  const seqByRawId = new Map([["a", 401], ["b", 402]]);
  restampRefsToLedger(p1.state, seqByRawId);
  assert.equal(p1.state.refLedgerAligned, true);
  assert.ok(
    (p1.state.timestampsHighWaterRefSeq ?? 0) >= 402,
    "alignment seats old refs ABOVE the mark so they cannot render new attrs without a real fold",
  );
});

test("B: armed fresh-state child gets honest NULL, arm self-clears", () => {
  const core = createCore({ timestamps: true });
  const state = createInitialState();
  state.suppressMintingOnce = true; // host armed the adoption path
  const p1 = core.processTurn({
    messages: [msg("p", "parent history line"), msg("n", "genuine new turn")],
    state, config: cfg, tokenCount: 10,
  });
  assert.equal(timeOf(p1.messages[0]!.text!), undefined, "inherited id NOT fabricated as today");
  assert.ok(!("p" in (p1.state.tsStamps ?? {})), "no stamp minted for inherited id while armed");
  assert.equal(p1.state.suppressMintingOnce, undefined, "arm consumed by the first enabled pass");
  // Next pass: everything seen during the armed pass entered the ledger
  // stamped-less — it stays NULL forever (#4313 non-backfill: a late
  // Date.now() would still be a lie about display time). Only arrivals from
  // LATER passes mint normally.
  const p2 = core.processTurn({
    messages: [msg("p", "parent history line"), msg("n", "genuine new turn"), msg("o", "later arrival")],
    state: p1.state, config: cfg, tokenCount: 12,
  });
  const stamps = p2.state.tsStamps ?? {};
  assert.ok(!("p" in stamps), "inherited id remains unstamped — NULL, not fake today");
  assert.ok(!("n" in stamps), "boundary-turn arrival stays NULL once in the ledger (no backfilled today)");
  assert.ok(typeof stamps["o"] === "number", "brand-new arrival in the second pass mints normally");
  assert.equal(timeOf(p2.messages[0]!.text!), undefined, "inherited line still attr-free after next pass");
  assert.equal(timeOf(p2.messages[1]!.text!), undefined, "boundary-turn line stays attr-free");
  assert.ok(timeOf(p2.messages[2]!.text!), "second-pass arrival carries the attribute");
});
