// Uncovered-history audit (#4331). The compress stop verdict and the
// acp_status overview both derive from the per-call OFFER (what this request's
// prepare pass advertised), so mid-history spans that sit outside every active
// block AND outside the current offer are invisible to both surfaces — the
// receipt can then claim "the context is already at its minimum" while tens of
// thousands of raw tokens keep going upstream. This module answers the one
// question neither surface could ask before: which contiguous runs of messages
// are uncovered by any active block, older than the protected recent window,
// and not in the actionable offer right now?
//
// Zone exclusion is computed EMPIRICALLY as the diff between two kernel offers
// (normal config vs preserve-0 config) instead of re-implementing
// computeProtectedRefs host-side: the kernel's zone rules (#2886 pair symmetry,
// neverPreserveRecentTools, …) evolve without host notice, and an empirical
// diff self-maintains. Both passes run on a structuredClone of the session
// state — processTurn is not idempotent in its nudge cadence stamps
// (nudge-inject rides lastNudgeShownTokens down and sets it on shouldInject),
// so the audit must never touch live state. The whole audit is advisory: any
// failure degrades to "no runs" rather than breaking receipts or status.

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
}

interface ProtectedCarrier {
  tokens: number;
  label: string;
}

/** #7463: the mass the meter bills but no offer can ever carry — hard
 *  protection (BLOCKED sentinel: no numeric ref, never offerable) plus the
 *  soft zone (numbered messages only the protected recent window keeps out).
 *  The usage meter counts both; offer, audit runs and acp_status all skipped
 *  both, so the gap between the meter and every decision surface was
 *  unexplainable from the model's side (session-8421629a: 400K meter, 37K
 *  offered, no surface could name the rest). */
export interface ProtectedMassLedger {
  hardTokens: number;
  hardCount: number;
  zoneTokens: number;
  zoneCount: number;
  topCarriers: ProtectedCarrier[];
}

interface UncoveredAuditResult {
  runs: UncoveredRun[];
  mass: ProtectedMassLedger;
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
  msg: CoreMessage;
}

// #7463: below this combined mass the line is noise (a fresh session's zone
// tail is small); hardcoded by design (config-surface discipline, #1911
// precedent). Render only above it.
export const PROTECTED_MASS_RENDER_FLOOR = 5_000;

function carrierLabel(msg: CoreMessage): string {
  const head = msg.toolName ? `tool:${msg.toolName}` : msg.role;
  const raw = (msg.text ?? "").replace(/\s+/g, " ").trim();
  if (raw.length === 0) return head;
  return `${head} "${raw.length > 48 ? `${raw.slice(0, 48)}…` : raw}"`;
}

function massOf(hard: ProtectedCarrier[], zone: ProtectedCarrier[]): ProtectedMassLedger {
  return {
    hardTokens: hard.reduce((s, c) => s + c.tokens, 0),
    hardCount: hard.length,
    zoneTokens: zone.reduce((s, c) => s + c.tokens, 0),
    zoneCount: zone.length,
    topCarriers: [...hard, ...zone].sort((a, b) => b.tokens - a.tokens).slice(0, 3),
  };
}

/** #7463: full acp_status line. Returns null below the render floor. No refs
 *  are emitted — carriers are named by kind + snippet only, so the line
 *  carries nothing the model could anchor a compress call to. */
export function formatProtectedMass(mass: ProtectedMassLedger): string | null {
  if (mass.hardTokens + mass.zoneTokens < PROTECTED_MASS_RENDER_FLOOR) return null;
  const top =
    mass.topCarriers.length > 0
      ? ` Top carriers: ${mass.topCarriers
          .map((c) => `${c.label} (${shortTokenCount(c.tokens)} tok)`)
          .join(", ")}.`
      : "";
  return (
    `PROTECTED MASS — ${shortTokenCount(mass.hardTokens + mass.zoneTokens)} tok in this context are outside every compress offer right now: ` +
    `hard ${shortTokenCount(mass.hardTokens)} tok (${mass.hardCount} msg(s), protection-bound — no numeric ref to cite) + ` +
    `zone ${shortTokenCount(mass.zoneTokens)} tok (${mass.zoneCount} msg(s), held by the protected recent window; they leave the zone as the context moves on).${top}`
  );
}

/** #7463: compact append for the post-fold receipt note (one line, no
 *  carriers — the detail lives in acp_status). Empty below the floor. */
export function formatProtectedMassCompact(mass: ProtectedMassLedger): string {
  if (mass.hardTokens + mass.zoneTokens < PROTECTED_MASS_RENDER_FLOOR) return "";
  return (
    ` Also protected (never in any offer): hard ${shortTokenCount(mass.hardTokens)} tok (${mass.hardCount} msg(s)) + ` +
    `zone ${shortTokenCount(mass.zoneTokens)} tok (${mass.zoneCount} msg(s)).`
  );
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

/** #7463: one audit, two ledgers — the uncovered runs AND the protected
 *  mass (hard + zone) from the same entries pass and the same two offer
 *  passes. No extra processTurn cost versus uncoveredHistoryRuns. */
export function uncoveredAudit(input: UncoveredAuditInput): UncoveredAuditResult {
  const { core, state, config } = input;
  // #5139: the internal offer passes screen against the apply view, so the
  // send view's outbound-only markers must not take part in them.
  const messages = withoutTurnSeparators(input.messages);

  // 1) Uncovered entries — the same predicate report.collectVisible uses:
  //    numbered, not folded into an active block, carrying tokens. Hard
  //    protection (BLOCKED sentinel) is tallied separately here — it was
  //    skipped on every surface before #7463.
  const covered = coveredMessageIds(state);
  const entries: RunEntry[] = [];
  const hardCarriers: ProtectedCarrier[] = [];
  messages.forEach((msg, index) => {
    const ref = refForRaw(state.messageRefs, msg.id);
    if (!ref) return;
    if (covered.has(msg.id)) return;
    if (ref === BLOCKED_REF) {
      const tokens = countMessageTokens(msg, defaultCountTokens);
      if (tokens > 0) hardCarriers.push({ tokens, label: carrierLabel(msg) });
      return;
    }
    const tokens = countMessageTokens(msg, defaultCountTokens);
    if (tokens <= 0) return;
    const num = refNum(ref);
    if (num <= 0) return;
    entries.push({ index, ref, num, tokens, msg });
  });
  if (entries.length === 0) return { runs: [], mass: massOf(hardCarriers, []) };

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
    return { runs: [], mass: massOf(hardCarriers, []) };
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
  //
  // #7463: the same membership predicate tallies the soft-zone mass per
  //    message — before #7463 this class was counted by the usage meter and
  //    skipped here (and in offer/acp_status), so the meter-vs-offer gap was
  //    unexplainable from the model's side.
  const zoneCarriers: ProtectedCarrier[] = [];
  for (const e of entries) {
    if (inAnyWindow(e.num, relaxedWindows) && !inAnyWindow(e.num, normalWindows)) {
      zoneCarriers.push({ tokens: e.tokens, label: carrierLabel(e.msg) });
    }
  }
  const out: UncoveredRun[] = [];
  for (const run of runs) {
    if (run.some((e) => inAnyWindow(e.num, actionable))) continue;
    const kept = run.filter((e) => !(inAnyWindow(e.num, relaxedWindows) && !inAnyWindow(e.num, normalWindows)));
    if (kept.length === 0) continue;
    const tokens = kept.reduce((sum, e) => sum + e.tokens, 0);
    if (tokens < VIABLE_RANGE_MIN_TOKENS) continue;
    out.push({
      startRef: kept[0].ref,
      endRef: kept[kept.length - 1].ref,
      count: kept.length,
      tokens,
    });
  }
  return { runs: out, mass: massOf(hardCarriers, zoneCarriers) };
}

export function uncoveredHistoryRuns(input: UncoveredAuditInput): UncoveredRun[] {
  return uncoveredAudit(input).runs;
}

export function shortTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `~${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}K`;
}

export function describeUncoveredRuns(runs: UncoveredRun[], maxListed = 5): string {
  const listed = runs.slice(0, maxListed).map((r) => `${r.startRef}–${r.endRef} (${r.count} msgs, ${shortTokenCount(r.tokens)} tok)`);
  const rest = runs.length - listed.length;
  return rest > 0 ? `${listed.join(", ")}, +${rest} more run(s)` : listed.join(", ");
}
