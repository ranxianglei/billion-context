// #6728: policy-gate REFUSED receipts (compress.requireNudge /
// requireRecommendation) charge no failure ledger — a model re-submitting a
// range bili will never fold gets byte-identical refusals forever and the
// circuit breaker never arms (9 consecutive verbatim refusals in 125 s in the
// reported pi session). The two gate branches in applyRanges return before
// any ledger call, unlike every other reject path in src/stream.ts.
// Gate discipline (#3617): BOTH directions asserted per gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage, CompressibleRange, NudgeDecision } from "acp-kernel";
import {
  createCore,
  createInitialState,
  assignRefs,
  emptyRefMap,
  defaultConfig,
} from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import {
  applyRanges,
  compressBreakerArmed,
  type RewriteCtx,
} from "../src/stream.ts";
import { storeUnpromptedGate } from "../src/unprompted-gate.ts";

const SUM = "SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK-XYZ";

type Ctx = Omit<RewriteCtx, "log"> & {
  log: (m: string) => void;
  logs: string[];
};

function makeCtx(
  messages: CoreMessage[],
  overrides?: Record<string, unknown>,
): Ctx {
  const logs: string[] = [];
  return {
    core: createCore(),
    config: defaultConfig(200000, overrides as never),
    messages,
    session: {
      id: "issue6728-test",
      meta: {},
      stats: {
        requests: 0,
        tokensSaved: 0,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        cacheSamples: 0,
        lastInputTokens: 100000,
        compressCreditTokens: 0,
        contextTokens: 0,
        retrieveCalls: 0,
        retrieveHits: 0,
        retrieveMisses: 0,
        storedBytes: 0,
        storeBytesSaved: 0,
        rangeRestores: 0,
      },
      metadata: {},
      state: createInitialState(),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      blockContents: new Map(),
      inFlight: 0,
      persisted: false,
      pendingRetrievals: [],
    },
    log: (m: string) => {
      logs.push(m);
    },
    logs,
  };
}

function withRefs(ctx: Ctx): Ctx {
  const res = assignRefs(ctx.messages, {
    existing: emptyRefMap(),
    nextIndex: 0,
  });
  ctx.session.state.messageRefs = res.map;
  return ctx;
}

function textMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
): CoreMessage {
  return { id, role, contentType: "text", text };
}

/** Nine 5000-char messages; preserveRecentMessages 2 keeps m8-m9 protected,
 *  so m1-m7 are the live fold space. */
function freshCtx(): Ctx {
  const msgs = Array.from({ length: 9 }, (_, i) =>
    textMsg(
      `raw_${i + 1}`,
      i % 2 === 0 ? "user" : "assistant",
      "x".repeat(5000),
    ),
  );
  return withRefs(
    makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }),
  );
}

function offerRange(
  startRef: string,
  endRef: string,
  count: number,
  tokens = 8000,
): CompressibleRange {
  return {
    startRef,
    endRef,
    count,
    tokens,
    chars: tokens * 4,
    toolPct: 0,
    textPct: 100,
  };
}

function setOffer(ctx: Ctx, ranges: CompressibleRange[]): void {
  ctx.lastNudge = {
    compressibleRanges: ranges,
    tier: null,
  } as unknown as NudgeDecision;
}

function runApply(
  ctx: Ctx,
  args: unknown,
  opts?: { loopTracking?: boolean },
): string {
  return applyRanges(parseCompressInput(args), ctx, opts).text;
}

function nudgeGateCtx(): Ctx {
  const ctx = freshCtx();
  storeUnpromptedGate(ctx.session, {
    nudgeInjected: false,
    requireNudge: true,
    requireRecommendation: false,
  });
  return ctx;
}

function scopeGateCtx(): Ctx {
  const ctx = freshCtx();
  setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
  storeUnpromptedGate(ctx.session, {
    nudgeInjected: true,
    requireNudge: false,
    requireRecommendation: true,
  });
  return ctx;
}

const NUDGE_CALL = {
  content: [{ startId: "m00001", endId: "m00004", summary: SUM }],
};
const SCOPE_CALL = {
  content: [{ startId: "m00005", endId: "m00007", summary: SUM }],
};

// ---------------------------------------------------------------------------
// Item 1: ledger charging — the breaker must arm on gate refusals.
// ---------------------------------------------------------------------------

test("#6728: requireNudge refusals charge the ledger — breaker arms by the 3rd identical refusal", () => {
  const ctx = nudgeGateCtx();
  const first = runApply(ctx, NUDGE_CALL);
  assert.ok(
    first.startsWith("[Compression REFUSED"),
    `expected refusal, got: ${first.slice(0, 120)}`,
  );
  assert.ok(
    !compressBreakerArmed(ctx.session),
    "breaker must not arm on the first refusal",
  );
  runApply(ctx, NUDGE_CALL);
  const third = runApply(ctx, NUDGE_CALL);
  assert.ok(
    compressBreakerArmed(ctx.session),
    "breaker must be armed after 3 consecutive gate refusals",
  );
  assert.ok(
    third.includes("COMPRESS CIRCUIT BREAKER"),
    "3rd receipt must carry the breaker paragraph:\n" + third,
  );
  assert.ok(
    third.includes("STOP calling compress"),
    "breaker paragraph must order a stop:\n" + third,
  );
});

test("#6728: requireRecommendation refusals charge the ledger — breaker arms by the 3rd identical refusal", () => {
  const ctx = scopeGateCtx();
  const first = runApply(ctx, SCOPE_CALL);
  assert.ok(
    first.startsWith("[Compression REFUSED"),
    `expected refusal, got: ${first.slice(0, 120)}`,
  );
  assert.ok(
    !compressBreakerArmed(ctx.session),
    "breaker must not arm on the first refusal",
  );
  runApply(ctx, SCOPE_CALL);
  const third = runApply(ctx, SCOPE_CALL);
  assert.ok(
    compressBreakerArmed(ctx.session),
    "breaker must be armed after 3 consecutive gate refusals",
  );
  assert.ok(
    third.includes("COMPRESS CIRCUIT BREAKER"),
    "3rd receipt must carry the breaker paragraph:\n" + third,
  );
});

test("#6728: one success after arming disarms the breaker (gate refusals behave like other failures)", () => {
  const ctx = nudgeGateCtx();
  runApply(ctx, NUDGE_CALL);
  runApply(ctx, NUDGE_CALL);
  runApply(ctx, NUDGE_CALL);
  assert.ok(compressBreakerArmed(ctx.session), "setup: breaker must be armed");
  storeUnpromptedGate(ctx.session, {
    nudgeInjected: true,
    requireNudge: true,
    requireRecommendation: false,
  });
  const out = runApply(ctx, NUDGE_CALL);
  assert.ok(
    out.startsWith("[Compressed"),
    `credit live again — fold must succeed, got: ${out.slice(0, 120)}`,
  );
  assert.ok(
    !compressBreakerArmed(ctx.session),
    "one success must clear the breaker",
  );
});

// ---------------------------------------------------------------------------
// Item 3: REFUSED repeat-folding — repeats collapse to a one-liner.
// ---------------------------------------------------------------------------

test("#6728: repeated requireNudge refusals collapse to a one-liner from the 2nd identical call", () => {
  const ctx = nudgeGateCtx();
  const first = runApply(ctx, NUDGE_CALL);
  const second = runApply(ctx, NUDGE_CALL);
  assert.ok(
    first.includes("you may only call compress while a nudge credit is live"),
    "first refusal keeps the full teaching receipt:\n" + first,
  );
  assert.ok(
    second.includes("again"),
    "repeat must be marked as a repeat:\n" + second,
  );
  assert.ok(
    !second.includes("you may only call compress while a nudge credit is live"),
    "repeat must not re-broadcast the full lecture:\n" + second,
  );
  assert.ok(
    second.length < first.length,
    "repeat one-liner must be shorter than the full receipt",
  );
});

test("#6728: repeated requireRecommendation refusals collapse to a one-liner from the 2nd identical call", () => {
  const ctx = scopeGateCtx();
  const first = runApply(ctx, SCOPE_CALL);
  const second = runApply(ctx, SCOPE_CALL);
  assert.ok(
    first.includes("Call acp_status for the current compressible ranges"),
    "first refusal keeps the full advice:\n" + first,
  );
  assert.ok(
    second.includes("again"),
    "repeat must be marked as a repeat:\n" + second,
  );
  assert.ok(
    !second.includes("Call acp_status for the current compressible ranges"),
    "repeat must not re-broadcast the full advice:\n" + second,
  );
  assert.ok(
    second.length < first.length,
    "repeat one-liner must be shorter than the full receipt",
  );
});

// ---------------------------------------------------------------------------
// Item 2: terminal wording when the recommendation set is empty.
// ---------------------------------------------------------------------------

test("#6728: scope gate with an EMPTY recommendation set uses terminal wording, not a dead-end acp_status pointer", () => {
  const ctx = freshCtx();
  ctx.session.state.deadRefs = [
    "m00001",
    "m00002",
    "m00003",
    "m00004",
    "m00005",
    "m00006",
    "m00007",
  ];
  storeUnpromptedGate(ctx.session, {
    nudgeInjected: false,
    requireNudge: false,
    requireRecommendation: true,
  });
  const out = runApply(ctx, NUDGE_CALL);
  assert.ok(
    out.startsWith("[Compression REFUSED"),
    `expected refusal, got: ${out.slice(0, 120)}`,
  );
  assert.ok(
    out.includes("requireRecommendation"),
    "receipt still names the knob:\n" + out,
  );
  assert.ok(
    !out.includes("Call acp_status for the current compressible ranges"),
    "empty set must not point at acp_status:\n" + out,
  );
  assert.ok(
    out.includes("already at its minimum"),
    "empty set must say the context is already at its minimum:\n" + out,
  );
  assert.ok(
    out.includes("continue the task without compressing"),
    "empty set must order a return to the task:\n" + out,
  );
});

test("#6728: scope gate with a NON-empty recommendation set keeps the acp_status advice (negative direction)", () => {
  const ctx = scopeGateCtx();
  const out = runApply(ctx, SCOPE_CALL);
  assert.ok(
    out.startsWith("[Compression REFUSED"),
    `expected refusal, got: ${out.slice(0, 120)}`,
  );
  assert.ok(
    out.includes("Call acp_status for the current compressible ranges"),
    "non-empty set must keep the acp_status advice:\n" + out,
  );
  assert.ok(
    !out.includes("already at its minimum"),
    "non-empty set must NOT claim the minimum:\n" + out,
  );
});

// ---------------------------------------------------------------------------
// Negative direction: the preflight lane never charges the ledger.
// ---------------------------------------------------------------------------

test("#6728: preflight lane (loopTracking:false) never charges the ledger on gate-adjacent calls", () => {
  const ctx = nudgeGateCtx();
  const out = runApply(ctx, NUDGE_CALL, { loopTracking: false });
  assert.ok(
    out.startsWith("[Compressed"),
    `preflight self-save must stay available, got: ${out.slice(0, 120)}`,
  );
  assert.ok(
    !compressBreakerArmed(ctx.session),
    "preflight success must not arm the breaker",
  );
});
