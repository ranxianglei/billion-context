/**
 * #6937: pin the compressible-range ref invariant.
 *
 * Incident: session 01a1e20d (2026-11-16) spent ~9 min in a
 * compression/polling loop. The model's persisted reasoning quoted
 * 'nudge' ranges with refs (m02332, m02362, m02443) that NEVER existed in
 * that session — its DB ref space is strictly monotonic 1..2291, and at
 * 17:20:38 the highest minted ref was m02146 (DB-verified). The audit
 * concluded the kernel could not have emitted those refs: every span
 * endpoint in buildCompressibleRanges comes from
 * `state.messageRefs.byRaw[msg.id]` for a message physically present in
 * the resent array (BLOCKED/unrefed rows are skipped), and refs are
 * minted monotonically. The phantom numbers were the model's own
 * mis-recall, amplified by the armed-but-silent status line (#6928/#6929,
 * removed).
 *
 * This test locks the audit into CI: across dense sessions, covered
 * holes, BLOCKED unrefed rows, dead-ref tombstones, and mid-array summary
 * nodes with fresh high refs (pi surface-replace shape), EVERY range the
 * chain emits — raw, merged, and screened — must carry endpoints that are
 * resolvable m-refs present in `state.messageRefs.byRef`. If a future
 * change to assign-refs or the lister re-introduces unbounded or
 * unresolvable endpoints, CI goes red instead of a live model concluding
 * its refs were reminted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompressibleRanges,
  computeProtectedRefs,
  mergeRangesToThreshold,
  screenRecommendedUnits,
} from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
import { defaultConfig } from "../src/config.js";
import { BLOCKED_REF, indexToRef } from "../src/refs.js";
import { SUMMARY_HEADER } from "../src/prune.js";
import type { CompressionBlock, CompressionState, CoreMessage } from "../src/types.js";

const TEXT = "hello world, enough text to register for a fold";

function mk(
  id: string,
  role: CoreMessage["role"],
  contentType: CoreMessage["contentType"] = "text",
): CoreMessage {
  return { id, role, contentType, text: TEXT };
}

function makeConfig(): ReturnType<typeof defaultConfig> {
  return defaultConfig(100_000, {
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  });
}

function activeBlock(id: string, messageIds: string[]): CompressionBlock {
  return {
    blockId: id,
    runId: "r1",
    tier: 1,
    summary: "folded history",
    directMessageIds: messageIds,
    effectiveMessageIds: messageIds,
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: 1,
    survivedCount: 0,
    generation: "young",
    active: true,
  };
}

/** The full recommendation chain every model-facing surface feeds from. */
function runChain(messages: CoreMessage[], state: CompressionState) {
  const config = makeConfig();
  const protectedRefs = computeProtectedRefs(messages, state, config, defaultCountTokens);
  const raw = buildCompressibleRanges(
    messages,
    state,
    config,
    protectedRefs,
    defaultCountTokens,
    messages,
  ).compressible;
  const merged = mergeRangesToThreshold(raw, 100);
  const screened = screenRecommendedUnits(merged, messages, state, config, protectedRefs);
  return { raw, merged, screened };
}

const REF_RE = /^m\d{5}$/;
function assertAllResolvable(
  state: CompressionState,
  ranges: { startRef: string; endRef: string }[],
  label: string,
): void {
  for (const r of ranges) {
    assert.match(
      r.startRef,
      REF_RE,
      `${label}: startRef ${r.startRef} is not a minted m-ref`,
    );
    assert.match(
      r.endRef,
      REF_RE,
      `${label}: endRef ${r.endRef} is not a minted m-ref`,
    );
    assert.ok(
      state.messageRefs.byRef[r.startRef],
      `${label}: startRef ${r.startRef} has no byRef entry`,
    );
    assert.ok(
      state.messageRefs.byRef[r.endRef],
      `${label}: endRef ${r.endRef} has no byRef entry`,
    );
  }
}

function assertChainInvariant(
  state: CompressionState,
  chain: ReturnType<typeof runChain>,
  label: string,
): void {
  assertAllResolvable(state, chain.raw, `${label}/raw`);
  assertAllResolvable(state, chain.merged, `${label}/merged`);
  assertAllResolvable(state, chain.screened, `${label}/screened`);
}

test("#6937: dense session with covered holes", () => {
  const messages: CoreMessage[] = [];
  const state = createInitialState();
  for (let i = 1; i <= 40; i++) {
    const role = i % 9 === 0 ? "user" : "assistant";
    const id = `n${i}`;
    messages.push(mk(id, role as CoreMessage["role"]));
    const ref = indexToRef(i);
    state.messageRefs.byRaw[id] = ref;
    state.messageRefs.byRef[ref] = id;
  }
  // A mid-session fold: 10 messages leave the array's compressibility.
  const hole = Array.from({ length: 10 }, (_, k) => `n${20 + k}`);
  state.blocks.push(activeBlock("b1", hole));

  const chain = runChain(messages, state);
  assert.ok(chain.raw.length > 0, "fixture must actually produce ranges");
  assertChainInvariant(state, chain, "dense");
});

test("#6937: BLOCKED unrefed rows interleaved (01a1e20d shape)", () => {
  const messages: CoreMessage[] = [];
  const state = createInitialState();
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const role = i % 5 === 0 ? "user" : "assistant";
    const id = `n${i}`;
    messages.push(mk(id, role as CoreMessage["role"]));
    const ref = indexToRef(++n);
    state.messageRefs.byRaw[id] = ref;
    state.messageRefs.byRef[ref] = id;
    // After every conversation pair: a successful compress exchange, which
    // the kernel stores with the BLOCKED sentinel (no minted ref).
    const call = mk(`tc${i}`, "assistant", "tool-call");
    const result = mk(`tr${i}`, "tool", "tool-result");
    messages.push(call, result);
    state.messageRefs.byRaw[call.id] = BLOCKED_REF;
    state.messageRefs.byRaw[result.id] = BLOCKED_REF;
  }

  const chain = runChain(messages, state);
  assert.ok(chain.raw.length > 0, "fixture must actually produce ranges");
  assertChainInvariant(state, chain, "blocked");
  // The sentinel itself must never surface as an endpoint.
  for (const r of [...chain.raw, ...chain.merged, ...chain.screened]) {
    assert.notEqual(r.startRef, BLOCKED_REF);
    assert.notEqual(r.endRef, BLOCKED_REF);
  }
});

test("#6937: dead-ref tombstones (#2362) leave resolvable endpoints", () => {
  const messages: CoreMessage[] = [];
  const state = createInitialState();
  for (let i = 1; i <= 20; i++) {
    const role = i % 6 === 0 ? "user" : "assistant";
    const id = `n${i}`;
    messages.push(mk(id, role as CoreMessage["role"]));
    const ref = indexToRef(i);
    state.messageRefs.byRaw[id] = ref;
    state.messageRefs.byRef[ref] = id;
  }
  // A dropped message: its refs stay in the map, the message is gone from
  // the array, and the kernel records it as dead.
  const ghostRef = indexToRef(5);
  messages.splice(4, 1);
  state.deadRefs = [ghostRef];
  // Plus a plain tombstone: known to the map, unreachable, unrecorded.
  const strayRef = indexToRef(99);
  state.messageRefs.byRef[strayRef] = "ghost-stray";
  state.messageRefs.byRaw["ghost-stray"] = strayRef;

  const chain = runChain(messages, state);
  assert.ok(chain.raw.length > 0, "fixture must actually produce ranges");
  assertChainInvariant(state, chain, "tombstones");
  for (const r of [...chain.raw, ...chain.merged, ...chain.screened]) {
    assert.notEqual(r.startRef, ghostRef);
    assert.notEqual(r.endRef, ghostRef);
    assert.notEqual(r.startRef, strayRef);
    assert.notEqual(r.endRef, strayRef);
  }
});

test("#6937: mid-array summary node with a fresh high ref (pi surface-replace)", () => {
  const messages: CoreMessage[] = [];
  const state = createInitialState();
  for (let i = 1; i <= 10; i++) {
    const id = `n${i}`;
    messages.push(mk(id, (i % 5 === 0 ? "user" : "assistant") as CoreMessage["role"]));
    const ref = indexToRef(i);
    state.messageRefs.byRaw[id] = ref;
    state.messageRefs.byRef[ref] = id;
  }
  // The host inserts the block's summary node mid-array; it carries a FRESH
  // HIGH ref (minted on insertion) and sits outside its block's coverage
  // (#335 live-carrier shape). The lister skips synthetic nodes by text
  // prefix — their high ref must never surface as an endpoint.
  const summaryRef = indexToRef(50);
  messages.splice(5, 0, {
    id: "summary-node",
    role: "assistant",
    contentType: "text",
    text: `${SUMMARY_HEADER} — b1\nfolded history`,
  });
  state.messageRefs.byRaw["summary-node"] = summaryRef;
  state.messageRefs.byRef[summaryRef] = "summary-node";
  state.blocks.push(activeBlock("b1", ["n1", "n2"]));

  const chain = runChain(messages, state);
  assert.ok(chain.raw.length > 0, "fixture must actually produce ranges");
  assertChainInvariant(state, chain, "high-ref-summary");
  for (const r of [...chain.raw, ...chain.merged, ...chain.screened]) {
    assert.notEqual(r.startRef, summaryRef);
    assert.notEqual(r.endRef, summaryRef);
  }
});
