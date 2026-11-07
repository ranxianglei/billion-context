// Uncovered-history audit (#4331). The compress stop verdict and the
// acp_status overview both derive from the per-call OFFER (what this request's
// prepare pass advertised), so mid-history spans that sit outside every active
// block AND outside the current offer are invisible to both surfaces — the
// receipt can then claim "the context is already at its minimum" while tens of
// thousands of raw tokens keep going upstream. This module answers the one
// question neither surface could ask before: which contiguous runs of messages
// sit outside every active block and the actionable offer right now — older
// than the protected window, or inside one of its components?
//
// Zone exclusion is computed EMPIRICALLY as the diff between two kernel offers
// (normal config vs preserve-0 config) instead of re-implementing
// computeProtectedRefs host-side: the kernel's zone rules (#2886 pair symmetry,
// neverPreserveRecentTools, …) evolve without host notice, and an empirical
// diff self-maintains. The diff therefore only detects the message-window
// component of the zone: zeroing both preserve knobs also switches off the
// token rule and the user-anchor rule (kernel Rule 3, coupled to
// preserveRecentMessages>0), so mass claimed purely by those components reads
// as zone-hidden — #5780 second repro. The protected-claim estimate below
// recovers such runs when their head predates the naive claim, and the
// apply-side screen labels whatever it finds. Both passes run on a
// structuredClone of the session
// state — processTurn is not idempotent in its nudge cadence stamps
// (nudge-inject rides lastNudgeShownTokens down and sets it on shouldInject),
// so the audit must never touch live state. The whole audit is advisory: any
// failure degrades to "no runs" rather than breaking receipts or status.
//
// #5780: listing a run is not claiming it folds. The audit once advertised
// turn fragments that apply STRUCTURALLY rejects ("Range would split N
// turn(s)"), costing a round trip and dragging the sibling range down in the
// atomic batch rollback (#3939). Advertise and execute must share ONE
// judgment (#3236 doctrine): every final run is now screened through
// core.applyCompression on a structuredClone of the state with a throwaway
// summary — the public API (zero kernel surface change), running byte-for-byte
// the code path a real submission takes. Structurally doomed runs (turn split
// at the protected boundary / entirely zoned) carry a compact ⚠ note;
// transient refusals (below the fold-size gate, already covered) stay plain
// because combined with adjacent mass they DO fold. Any screen failure
// degrades to "unmarked", consistent with the advisory posture above.
// Companion fix: a run whose WHOLE body the zone diff claims was silently
// dropped even when its head predates the protected window (the diff cannot
// separate "protected" from "structurally withheld") — such runs are now
// reported and labeled by the screen instead of vanishing.

import {
  BLOCKED_REF,
  VIABLE_RANGE_MIN_TOKENS,
  coveredMessageIds,
  countMessageTokens,
  defaultCountTokens,
  refForRaw,
  type CompressionCore,
  type CompressionState,
  type Config,
  type CoreMessage,
  type MessageContentStore,
} from "acp-kernel";
import { withoutTurnSeparators } from "./turn-separator.js";

interface UncoveredRun {
  startRef: string;
  endRef: string;
  count: number;
  tokens: number;
  /** #5780: set when the apply-side judgment says this exact span cannot fold
   *  RIGHT NOW for structural reasons (turn split at the protected boundary /
   *  entirely inside the zone). Transient refusals leave it unset. */
  note?: string;
}

// #5780: throwaway summary for the apply-side foldability screen. It must clear
// the kernel's summary-length validation (default minSummaryLength = 50 chars);
// it is deliberately long so sane user-tuned minimums still pass — an
// over-tuned minimum degrades gracefully to "unmarked", never to a false note.
const FOLDABILITY_PROBE_SUMMARY =
  "Foldability screen probe — judged against the live session state through the same apply path a real compression takes; it is never stored and never rendered.";

// Structural-class markers keyed off the STABLE wording of the kernel's
// projectUnit fatal errors (kernel/src/unit-projection.ts: "Range would
// split …", "cannot satisfy turn integrity without unfolding", "entirely
// within the protected zone") AND its #5253-family soft no-ops (kernel/src/
// compress.ts: "folded nothing — it lies entirely inside the protected
// zone … do not resend this range", "all of its content is protected or
// filtered"). A no-op is the same structural class as the zone fatal:
// resending the span cannot fold anything until the zone moves. Transient
// refusals ("too small", already covered, unknown refs) intentionally fall
// through to unmarked — they self-teach via their own text.
const SPLIT_NOTE = "\u26a0 not foldable: would split a turn at the protected boundary";
const ZONE_NOTE = "\u26a0 not foldable: entirely inside the protected zone";

/**
 * #5780: run the run's exact span through the apply-side judgment on a state
 * clone (public core API — byte-for-byte the path a real submission takes).
 * Returns a compact note for structural fatals/no-ops, undefined when the
 * span folds or its refusal is transient. Any failure → undefined (advisory
 * degrades).
 */
function foldabilityNote(
  core: CompressionCore,
  state: CompressionState,
  config: Config,
  messages: CoreMessage[],
  startRef: string,
  endRef: string,
): string | undefined {
  try {
    const { result } = core.applyCompression({
      ranges: [{ startRef, endRef, summary: FOLDABILITY_PROBE_SUMMARY }],
      messages,
      state: structuredClone(state),
      config,
    });
    if (result.errors.length === 0 && result.blocksCreated > 0) return undefined;
    for (const err of result.errors) {
      if (/would split|cannot satisfy turn integrity/.test(err)) return SPLIT_NOTE;
      if (/entirely within the protected zone/.test(err)) return ZONE_NOTE;
    }
    for (const warning of result.warnings) {
      if (/lies entirely inside the protected zone|all of its content is protected/.test(warning)) return ZONE_NOTE;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface UncoveredAuditInput {
  core: CompressionCore;
  /** Full resent log (apply class) — same array class prepare runs on. */
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
  /** statusInputBaseline — the token level the live-recompute lanes use. */
  tokenCount?: number;
  contentStore?: MessageContentStore;
  applyView?: CoreMessage[];
  /** Spans the model can act on right now (post-filter offer / remaining list).
   *  Runs overlapping these are NOT reported — they are surfaced elsewhere. */
  actionableSpans?: readonly { startRef: string; endRef: string }[];
  /** A caller that already ran the normal-config offer pass may pass its
   *  ranges here so the audit skips re-running it (acp_status reuses its live
   *  Compressible-ranges pass, cutting the audit from two processTurn calls
   *  to one on that surface). UNDEFINED means "no caller data" — the audit
   *  runs its own normal pass; an array (even empty) means "trust this". */
  normalRanges?: readonly { startRef: string; endRef: string }[];
}

interface RunEntry {
  index: number;
  ref: string;
  num: number;
  tokens: number;
  role: string;
  /** Position within the entries array (contiguous-run walk order). */
  pos: number;
}

// #5780: host-side estimate of where the protected claim begins, in ENTRY
// space. Claim = last `preserveRecentMessages` entries plus the most recent
// user anchor (the kernel's two core zone rules). Two biases, both safe:
// (1) the #2886-family zone extensions (pair-closure pullback,
// neverPreserveRecentTools, token-based protection) protect MORE than this
// count+anchor estimate, so it sits behind the true zone start — doomed mass
// just ahead of the zone is reported and screen-labeled instead of vanishing;
// (2) when covered/zero-token messages sit INSIDE the recent window, the
// last-N entries span more than N messages, so the estimate can also reach
// further back than the naive message-space zone — that corner errs toward
// SILENCE for doomed mass in that band (bounded by the covered count in the
// window; degrades to pre-#5780 behavior, never to a false "folds" claim).
// Neither direction claims a span folds that apply rejects: the screen below
// labels every reported span.
function protectedClaimStart(entries: RunEntry[], config: Config): number {
  let start = entries.length - (config.preserveRecentMessages ?? 0);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === "user") {
      start = Math.min(start, i);
      break;
    }
  }
  return Math.max(0, Math.min(start, entries.length));
}

function refNum(ref: string): number {
  const n = Number(ref.replace(/\D/g, ""));
  return Number.isFinite(n) ? n : 0;
}

type SpanWindow = readonly [number, number];

function windowsOf(spans: readonly { startRef: string; endRef: string }[]): SpanWindow[] {
  const out: SpanWindow[] = [];
  for (const s of spans) {
    const a = refNum(s.startRef);
    const b = refNum(s.endRef);
    if (a > 0 && b > 0) out.push(a <= b ? [a, b] : [b, a]);
  }
  return out;
}

function inAnyWindow(n: number, windows: readonly SpanWindow[]): boolean {
  return windows.some(([lo, hi]) => n >= lo && n <= hi);
}

export function uncoveredHistoryRuns(input: UncoveredAuditInput): UncoveredRun[] {
  const { core, state, config } = input;
  // #5139: the internal offer passes screen against the apply view, so the
  // send view's outbound-only markers must not take part in them.
  const messages = withoutTurnSeparators(input.messages);

  // 1) Uncovered entries — the same predicate report.collectVisible uses:
  //    numbered, not folded into an active block, carrying tokens.
  const covered = coveredMessageIds(state);
  const entries: RunEntry[] = [];
  messages.forEach((msg, index) => {
    const ref = refForRaw(state.messageRefs, msg.id);
    if (!ref || ref === BLOCKED_REF) return;
    if (covered.has(msg.id)) return;
    const tokens = countMessageTokens(msg, defaultCountTokens);
    if (tokens <= 0) return;
    const num = refNum(ref);
    if (num <= 0) return;
    entries.push({ index, ref, num, tokens, role: msg.role, pos: entries.length });
  });
  if (entries.length === 0) return [];

  // 2) Contiguous runs: array adjacency defines "contiguous" (what the wire
  //    actually carries next to itself); covered or zero-token neighbors break
  //    a run conservatively.
  const runs: RunEntry[][] = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1].index === e.index - 1) last.push(e);
    else runs.push([e]);
  }

  // 3) Empirical zone diff. Cloned state: see header note on cadence stamps.
  const normalWindows = input.normalRanges ? windowsOf(input.normalRanges) : [];
  let relaxedWindows: SpanWindow[] = [];
  try {
    const clone = structuredClone(state);
    const base = {
      messages,
      tokenCount: input.tokenCount ?? 0,
      renderTags: "none" as const,
      contentStore: input.contentStore,
      applyView: input.applyView,
    };
    if (!input.normalRanges) {
      normalWindows.push(...windowsOf(
        core.processTurn({ ...base, state: clone, config }).nudge?.compressibleRanges ?? [],
      ));
    }
    relaxedWindows = windowsOf(
      core
        .processTurn({
          ...base,
          state: clone,
          config: { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 },
        })
        .nudge?.compressibleRanges ?? [],
    );
  } catch {
    return [];
  }

  const actionable = windowsOf(input.actionableSpans ?? []);

  // 4) Per-run classification. A ref is zone-hidden when the relaxed pass
  //    reaches it but the normal pass does not — i.e. only the protected
  //    recent window keeps it off the offer. Refs in NEITHER window are
  //    structurally unoffered (dead-ref holes, checkpoint carriers, integrity
  //    withdrawals, …) and stay reported: that is exactly the mass the user
  //    cannot fold through ordinary ranges and needs to see. Over-approximate
  //    window membership errs toward under-reporting, never toward claiming a
  //    protected tail message is leakable mass.
  const out: UncoveredRun[] = [];
  const claimStart = protectedClaimStart(entries, config);
  for (const run of runs) {
    if (run.some((e) => inAnyWindow(e.num, actionable))) continue;
    let span = run.filter((e) => !(inAnyWindow(e.num, relaxedWindows) && !inAnyWindow(e.num, normalWindows)));
    if (span.length === 0) {
      // #5780: the zone diff cannot tell "hidden by the recent window" from
      // "withheld because structurally doomed" — both are absent from the
      // normal offer. A head INSIDE the protected claim is a genuine tail
      // (silent, as before); a head PREDATING it is doomed mass the user can
      // never fold through ordinary ranges — report the full run and let the
      // apply-side screen below label it honestly.
      if (run[0].pos >= claimStart) continue;
      span = run;
    }
    const tokens = span.reduce((sum, e) => sum + e.tokens, 0);
    if (tokens < VIABLE_RANGE_MIN_TOKENS) continue;
    // #5780: advertise only what apply will accept — same judgment as execute.
    // applyView-first mirrors the production apply call (stream.ts), falling
    // back to this module's separator-stripped log when no apply view exists.
    const note = foldabilityNote(core, state, config, input.applyView ?? messages, span[0].ref, span[span.length - 1].ref);
    const candidate: UncoveredRun = {
      startRef: span[0].ref,
      endRef: span[span.length - 1].ref,
      count: span.length,
      tokens,
    };
    if (note !== undefined) candidate.note = note;
    out.push(candidate);
  }
  return out;
}

export function shortTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `~${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}K`;
}

export function describeUncoveredRuns(runs: UncoveredRun[], maxListed = 5): string {
  const listed = runs.slice(0, maxListed).map((r) => `${r.startRef}–${r.endRef} (${r.count} msgs, ${shortTokenCount(r.tokens)} tok${r.note ? `, ${r.note}` : ""})`);
  const rest = runs.length - listed.length;
  return rest > 0 ? `${listed.join(", ")}, +${rest} more run(s)` : listed.join(", ");
}
