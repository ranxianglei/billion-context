/**
 * Prompt-cache reconciliation (billion-context#800).
 *
 * The provider-reported per-request usage IS the grand ledger (总账) — this
 * module never invents numbers; it splits every request's cache miss into
 * three additive buckets so the totals reconcile exactly by construction:
 *
 *   missed_i = input_i − cached_i
 *            = newContent_i   content newly appended since the previous request
 *                            (legit fresh — not an invalidation at all)
 *            + compRepay_i    re-payment forced by compression folds (the
 *                            prefix diverged at the fold's first start point)
 *            + ttlRepay_i     residual: UNATTRIBUTED misses inside the
 *                            stable prefix → upstream TTL expiry /
 *                            provider-side eviction OR client-side wire
 *                            rewrite — the kernel cannot distinguish
 *
 * No estimate participates in the closure: newContent is clamped to observed
 * growth, compRepay is clamped to BOTH the remaining miss and the structural
 * excess implied by the fold divergence point, ttlRepay is whatever remains.
 * Hence, for ANY inputs:
 *
 *   Σ input = Σ cached + Σ newContent + Σ compRepay + Σ ttlRepay        (exact)
 *
 * `decomposeSample` is the single implementation used both by
 * `buildCacheReport` (batch) and by hosts that stream-record aggregates
 * incrementally — one code path, one accounting semantics.
 */

export interface CacheSample {
  /** Epoch ms when the usage report was observed. */
  at: number;
  /** Total prompt tokens billed for this request — NORMALIZED so cached is
   *  INCLUDED (Anthropic input_tokens excludes cached; OpenAI includes it). */
  input: number;
  /** Provider-reported cache-hit tokens (0 when the provider reports none). */
  cached: number;
  output?: number;
}

export interface FoldEvent {
  /** Epoch ms when the fold was applied (between two requests). */
  at: number;
  /** S: tokens removed from the view by this fold. */
  tokensCompressed: number;
  /** σ: rendered summary size in tokens (or actual summary output tokens). */
  summaryTokens?: number;
  /** X: token offset of the earliest divergence point inside the post-fold
   *  view ≈ expected post-fold hit prefix. Host-computed estimate — used
   *  only as a clamp bound, never in the closure. */
  firstFoldStartTokens?: number;
  /** V: pre-fold view size. */
  viewBefore?: number;
  /** V′: post-fold view size. */
  viewAfter?: number;
}

/** Normalized price multipliers over the input-token unit (p_in = 1).
 *  w = cacheWrite/input, r = cacheRead/input, q = output/input. */
export interface PriceProfile {
  w?: number;
  r?: number;
  q?: number;
}

/** #2929: a fold claims not only its first following sample but the whole
 *  post-fold COLD TAIL — until a warm line proves the provider re-cached or
 *  this many samples have elapsed (#1847 switch discipline, mirrored for
 *  folds). Rationale: the first post-fold request (the proxy's re-request)
 *  is attributed today, but the client-echo re-bill 25–66s later carried no
 *  fold stamp and fell into the unattributed TTL residual, tripping the
 *  cache-seam detector with "no fold attribution". Warm hit that retires
 *  the window (same threshold as the host's WARM_HIT_PCT). */
export const FOLD_CLAIM_WARM_HIT_PCT = 85;
export const FOLD_CLAIM_COLD_ROUNDS = 4;

export interface SampleDecomposition {
  missed: number;
  newContent: number;
  compRepay: number;
  ttlRepay: number;
  /** Index into `pendingFolds` of the fold credited with compRepay, or null. */
  foldIndex: number | null;
}

/** Split one request's miss into the three buckets.
 *
 * @param prev         previous sample (null for the first observed request)
 * @param cur          current sample
 * @param pendingFolds folds applied after `prev` and no later than `cur`
 */
export function decomposeSample(
  prev: CacheSample | null,
  cur: CacheSample,
  pendingFolds: readonly FoldEvent[],
): SampleDecomposition {
  const missed = Math.max(0, cur.input - cur.cached);
  const growth = prev ? Math.max(0, cur.input - prev.input) : 0;
  const newContent = Math.min(missed, growth);
  const remainder = missed - newContent;
  let compRepay = 0;
  let foldIndex: number | null = null;
  if (remainder > 0 && pendingFolds.length > 0) {
    // The combined rewrite diverges at the EARLIEST fold start point.
    let bestX = Infinity;
    let owner = -1;
    for (let i = 0; i < pendingFolds.length; i++) {
      const f = pendingFolds[i]!;
      const x = f.firstFoldStartTokens ?? f.viewAfter ?? 0;
      if (x < bestX) {
        bestX = x;
        owner = i;
      }
    }
    // Everything after the divergence point must be re-paid; subtract the
    // legitimate fresh append that also lives there.
    const structuralExcess = Math.max(0, cur.input - bestX - newContent);
    compRepay = Math.min(remainder, structuralExcess);
    if (compRepay > 0) foldIndex = owner;
  }
  return {
    missed,
    newContent,
    compRepay,
    ttlRepay: remainder - compRepay,
    foldIndex,
  };
}

export interface CacheTotals {
  requests: number;
  input: number;
  cached: number;
  output: number;
  /** cached / input × 100 (0 when input = 0). */
  hitPct: number;
  newContent: number;
  compRepay: number;
  ttlRepay: number;
  /** input − cached − (newContent + compRepay + ttlRepay); 0 by construction. */
  residual: number;
  balanced: boolean;
}

export interface FoldEconomics {
  /** 1-based chronological fold sequence. */
  seq: number;
  at: number;
  /** S: tokens compressed. */
  S: number;
  /** σ: summary tokens (0 when unknown). */
  sigma: number;
  /** V′: post-fold view size (null when unknown). */
  Vprime: number | null;
  /** Measured hit rate (0–100) of the first post-fold request, else null. */
  hPct: number | null;
  /** Measured compression re-pay (tokens) attributed to this fold. */
  T: number;
  /** Requests observed after this fold. */
  requestsAfter: number;
  /** (S−σ) × requestsAfter — tokens not billed because of this fold
   *  (regrowth eats back into it; estimate, not part of the closure). */
  savedSoFar: number;
  /** Sample count until the next fold, null for the last fold. */
  turnsToNextFold: number | null;
  /** Pure token delta (price-independent): T + σ − S. <0 means the fold
   *  removed more raw tokens than it forced us to send back. */
  netTokenDelta: number;
  /** One-time cost in input-token-equivalent units (billion-context#359):
   *  (w−r)·T + q·σ − r·S, using the effective price profile. */
  oneTimeCostUnits: number;
  /** Per-turn saving in input-token-equivalent units: (S−σ)·r. */
  perTurnSavingUnits: number;
  /** Breakeven turns n* = max(0,oneTimeCost)/perTurnSaving; null when S ≤ σ. */
  breakevenTurns: number | null;
  /** paidBack: lifetime payback verdict — post-fold requests observed so far
   *  (requestsAfter) reached the breakeven point n*. Same window as
   *  savedSoFar, so the verdict and the token figures on one row agree
   *  (billion-context#2044). null while unobservable (S ≤ σ). */
  paidBack: boolean | null;
  /** cadenceOk: the original short-window verdict — folds until the NEXT
   *  fold (turnsToNextFold) reached n*. This is an interleave-cadence
   *  signal (folded too soon after the previous one), NOT a payback
   *  verdict; null while there is no next fold. Guard-signal candidate for
   *  billion-context#1280 / #2044. */
  cadenceOk: boolean | null;
}

export interface EconomicsSummary {
  folds: number;
  /** Σ (S−σ)×requestsAfter across folds (additive: each fold removes its own
   *  tokens from every later view). */
  grossSaved: number;
  /** Σ T — measured compression re-pay. */
  repayCost: number;
  /** Σ σ — summary generation cost (output tokens). */
  summaryCost: number;
  /** grossSaved − repayCost − summaryCost. */
  netTokens: number;
  paidBackCount: number;
  notPaidBackCount: number;
  unobservedCount: number;
}

export interface CacheReportLine {
  /** 1-based request sequence. */
  seq: number;
  at: number;
  input: number;
  cached: number;
  output: number;
  hitPct: number;
  missed: number;
  newContent: number;
  compRepay: number;
  ttlRepay: number;
  /** Global fold seq credited with compRepay, or null. */
  foldSeq: number | null;
}

export interface CacheReportOptions {
  priceProfile?: PriceProfile;
  /** Max line items kept in `lines` (newest retained). Default 512. */
  maxLines?: number;
}

export interface CacheReport {
  generatedAt: number;
  /** Effective price profile used for the weighted economics fields. */
  profile: Required<PriceProfile>;
  totals: CacheTotals;
  economics: EconomicsSummary;
  folds: FoldEconomics[];
  lines: CacheReportLine[];
  /** Older lines excluded from `lines` (totals still cover them). */
  linesOmitted: number;
}

function hitPct(input: number, cached: number): number {
  return input > 0 ? (cached / input) * 100 : 0;
}

/** Measured counters for one fold. Streaming hosts accumulate these
 * incrementally; buildCacheReport derives them from raw samples. */
export interface FoldEconomicsInput {
  seq: number;
  at: number;
  /** S — tokens removed from the view by the fold. */
  S: number;
  /** σ — summary tokens that replaced them (0 when unknown). */
  sigma: number;
  Vprime?: number | null;
  /** Measured hit rate (0-100) of the first post-fold sample. */
  hPct: number | null;
  /** T — measured compRepay attributed to this fold. */
  T: number;
  requestsAfter: number;
  /** Measured turns until the next fold; null while still running. */
  turnsToNextFold: number | null;
}

export function computeFoldEconomics(
  f: FoldEconomicsInput,
  price?: PriceProfile,
): FoldEconomics {
  const w = price?.w ?? 1.0;
  const r = price?.r ?? 0.1;
  const q = price?.q ?? 4.0;
  const netTokenDelta = f.T + f.sigma - f.S;
  const savingPerTurn = f.S - f.sigma;
  const oneTimeCostUnits = (w - r) * f.T + q * f.sigma - r * f.S;
  const perTurnSavingUnits = savingPerTurn * r;
  const breakevenTurns =
    perTurnSavingUnits > 0
      ? Math.max(0, oneTimeCostUnits) / perTurnSavingUnits
      : null;
  // #2044: paidBack uses the FULL post-fold window (requestsAfter), the
  // same window savedSoFar uses, so verdict and token figures agree.
  // The old short-window verdict survives as cadenceOk (diagnostics only).
  const paidBack =
    breakevenTurns !== null ? f.requestsAfter >= breakevenTurns : null;
  const cadenceOk =
    f.turnsToNextFold !== null && breakevenTurns !== null
      ? f.turnsToNextFold >= breakevenTurns
      : null;
  return {
    seq: f.seq,
    at: f.at,
    S: f.S,
    sigma: f.sigma,
    Vprime: f.Vprime ?? null,
    hPct: f.hPct,
    T: f.T,
    requestsAfter: f.requestsAfter,
    savedSoFar: Math.max(0, savingPerTurn) * f.requestsAfter,
    turnsToNextFold: f.turnsToNextFold,
    netTokenDelta,
    oneTimeCostUnits: round1(oneTimeCostUnits),
    perTurnSavingUnits: round1(perTurnSavingUnits),
    breakevenTurns,
    paidBack,
    cadenceOk,
  };
}

export function summarizeFoldEconomics(
  foldEcon: readonly FoldEconomics[],
): EconomicsSummary {
  const econ: EconomicsSummary = {
    folds: foldEcon.length,
    grossSaved: foldEcon.reduce((n, e) => n + e.savedSoFar, 0),
    repayCost: foldEcon.reduce((n, e) => n + e.T, 0),
    summaryCost: foldEcon.reduce((n, e) => n + e.sigma, 0),
    netTokens: 0,
    paidBackCount: 0,
    notPaidBackCount: 0,
    unobservedCount: 0,
  };
  econ.netTokens = econ.grossSaved - econ.repayCost - econ.summaryCost;
  for (const e of foldEcon) {
    if (e.paidBack === true) econ.paidBackCount++;
    else if (e.paidBack === false) econ.notPaidBackCount++;
    else econ.unobservedCount++;
  }
  return econ;
}

export function buildCacheReport(
  samplesIn: readonly CacheSample[],
  foldsIn: readonly FoldEvent[],
  opts: CacheReportOptions = {},
): CacheReport {
  const samples = [...samplesIn].sort((a, b) => a.at - b.at);
  const folds = [...foldsIn].sort(
    (a, b) => a.at - b.at || a.tokensCompressed - b.tokensCompressed,
  );
  const maxLines = opts.maxLines && opts.maxLines > 0 ? opts.maxLines : 512;
  const price = opts.priceProfile;
  const w = price?.w ?? 1.0;
  const r = price?.r ?? 0.1;
  const q = price?.q ?? 4.0;

  type Dec = SampleDecomposition & { foldSeq: number | null };
  const decs: Dec[] = [];
  // #2929: per-fold cold-tail claim state. A fold claims its FIRST following
  // sample unconditionally (the materialization re-bill), then keeps claiming
  // subsequent cold samples until a warm line (>= FOLD_CLAIM_WARM_HIT_PCT)
  // proves re-cache or it has claimed FOLD_CLAIM_COLD_ROUNDS samples. A warm
  // sample is never claimed as a continuation (it proves the damage is over).
  const foldClaims: number[] = folds.map(() => 0);
  const foldRetired: boolean[] = folds.map(() => false);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const prev = i > 0 ? samples[i - 1]! : null;
    const warm = s.input > 0 && hitPct(s.input, s.cached) >= FOLD_CLAIM_WARM_HIT_PCT;
    const pending: FoldEvent[] = [];
    const pendingIdx: number[] = [];
    let pendingBase = 0;
    for (let j = 0; j < folds.length; j++) {
      const fj = folds[j]!;
      if (fj.at > s.at) break;
      if (foldRetired[j]) continue;
      // First claim is unconditional; a warm continuation proves re-cache and
      // is not the fold's damage anymore.
      if (foldClaims[j] === 0 || !warm) {
        if (pending.length === 0) pendingBase = j;
        pending.push(fj);
        pendingIdx.push(j);
      }
    }
    const d = decomposeSample(prev, s, pending);
    decs.push({
      ...d,
      foldSeq: d.foldIndex !== null ? pendingBase + d.foldIndex + 1 : null,
    });
    for (const j of pendingIdx) {
      foldClaims[j] = foldClaims[j]! + 1;
      if (foldClaims[j]! >= FOLD_CLAIM_COLD_ROUNDS) foldRetired[j] = true;
    }
    // A warm line retires EVERY open window — claimed or not this sample
    // (#1847 discipline: it proves the provider re-cached, so a later cold
    // blip is a new, unrelated event and must not be swallowed).
    if (warm) {
      for (let j = 0; j < folds.length; j++) {
        if (folds[j]!.at <= s.at) foldRetired[j] = true;
      }
    }
  }

  const totals: CacheTotals = {
    requests: samples.length,
    input: 0,
    cached: 0,
    output: 0,
    hitPct: 0,
    newContent: 0,
    compRepay: 0,
    ttlRepay: 0,
    residual: 0,
    balanced: true,
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const d = decs[i]!;
    totals.input += s.input;
    totals.cached += s.cached;
    totals.output += s.output ?? 0;
    totals.newContent += d.newContent;
    totals.compRepay += d.compRepay;
    totals.ttlRepay += d.ttlRepay;
  }
  totals.hitPct = round1(hitPct(totals.input, totals.cached));
  totals.residual =
    totals.input -
    totals.cached -
    (totals.newContent + totals.compRepay + totals.ttlRepay);
  totals.balanced = totals.residual === 0;

  const lines: CacheReportLine[] = samples.map((s, i) => {
    const { foldIndex, ...rest } = decs[i]!;
    return {
      seq: i + 1,
      at: s.at,
      input: s.input,
      cached: s.cached,
      output: s.output ?? 0,
      hitPct: round1(hitPct(s.input, s.cached)),
      ...rest,
    };
  });
  const linesOmitted = Math.max(0, lines.length - maxLines);
  const visibleLines = lines.slice(linesOmitted);

  const foldEcon: FoldEconomics[] = folds.map((f, j) => {
    const seq = j + 1;
    const S = f.tokensCompressed;
    const sigma = f.summaryTokens ?? 0;
    const T = decs.reduce(
      (n, d) => (d.foldSeq === seq ? n + d.compRepay : n),
      0,
    );
    // First sample strictly after the fold = the request that materialized it.
    let hPct: number | null = null;
    let requestsAfter = 0;
    for (const s of samples) {
      if (s.at <= f.at) continue;
      requestsAfter++;
      if (hPct === null) hPct = round1(hitPct(s.input, s.cached));
    }
    const nextAt = j + 1 < folds.length ? folds[j + 1]?.at : undefined;
    const turnsToNextFold =
      nextAt !== undefined
        ? samples.filter((s) => s.at > f.at && s.at <= nextAt).length
        : null;
    return computeFoldEconomics(
      {
        seq,
        at: f.at,
        S,
        sigma,
        Vprime: f.viewAfter,
        hPct,
        T,
        requestsAfter,
        turnsToNextFold,
      },
      { w, r, q },
    );
  });

  const econ = summarizeFoldEconomics(foldEcon);

  return {
    generatedAt: Date.now(),
    profile: { w, r, q },
    totals,
    economics: econ,
    folds: foldEcon,
    lines: visibleLines,
    linesOmitted,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmtTok(n: number): string {
  const v = Math.round(n);
  return v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(2)}M`
    : v >= 10_000
      ? `${(v / 1000).toFixed(1)}K`
      : String(v);
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Render options: "summary" (default) distills to totals + verdicts +
 *  notable folds + anomalous lines; "full" keeps the legacy every-fold,
 *  every-line listing. */
export interface FormatCacheReportOptions {
  detail?: "summary" | "full";
}

const HIT_HEALTHY_PCT = 90;
const HIT_WATCH_PCT = 70;
const ANOMALY_HIT_PCT = 85;
const ANOMALY_MISS_TOK = 5_000;
const TTL_SPIKE_TOK = 10_000;
const SUMMARY_FOLD_TOPS = 3;
const SUMMARY_ANOMALY_CAP = 20;

function hitVerdict(pct: number): string {
  if (pct >= HIT_HEALTHY_PCT) return "HEALTHY";
  if (pct >= HIT_WATCH_PCT) return "WATCH";
  return "INVESTIGATE";
}

function medianHitPct(lines: CacheReportLine[]): number | null {
  if (lines.length === 0) return null;
  const xs = lines.map((l) => l.hitPct).sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)] ?? null;
}

function fmtIdleGap(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 36 * 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function foldVerdict(f: FoldEconomics): string {
  return f.paidBack === null ? "?" : f.paidBack ? "PAID BACK" : "NOT PAID BACK";
}

function formatCacheReportFull(report: CacheReport): string {
  const t = report.totals;
  const out: string[] = [];
  out.push("GRAND LEDGER");
  out.push(`  total input    ${fmtTok(t.input)} tok`);
  out.push(
    `  total cached   ${fmtTok(t.cached)} tok  (hit ${t.hitPct.toFixed(1)}%)`,
  );
  out.push(`  total output   ${fmtTok(t.output)} tok`);
  out.push(
    `  miss breakdown (input − cached = ${fmtTok(Math.max(0, t.input - t.cached))} tok):`,
  );
  out.push(
    `    new content     ${fmtTok(t.newContent)} tok  (fresh append — not an invalidation)`,
  );
  out.push(`    compress re-pay ${fmtTok(t.compRepay)} tok  (caused by folds)`);
  out.push(
    `    upstream-ttl-or-client-rewrite (unattributed)  ${fmtTok(t.ttlRepay)} tok  (stable-prefix misses: upstream TTL expiry / eviction or client-side wire rewrite — kernel cannot distinguish)`,
  );
  out.push(
    `  identity check   ${t.balanced ? "OK" : "BROKEN"} — ${fmtTok(t.input)} = ${fmtTok(t.cached)} + ${fmtTok(t.newContent)} + ${fmtTok(t.compRepay)} + ${fmtTok(t.ttlRepay)} (residual ${t.residual})`,
  );
  const e = report.economics;
  if (e.folds > 0) {
    const p = report.profile;
    out.push("");
    out.push(`FOLD ECONOMICS (${e.folds} folds @ w=${p.w} r=${p.r} q=${p.q})`);
    out.push(
      `  gross saved ${fmtTok(e.grossSaved)} tok · repay cost ${fmtTok(e.repayCost)} tok · summary cost ${fmtTok(e.summaryCost)} tok → net ${e.netTokens >= 0 ? "+" : ""}${fmtTok(e.netTokens)} tok`,
    );
    out.push(
      `  verdict: ${e.paidBackCount} paid back, ${e.notPaidBackCount} not paid back, ${e.unobservedCount} unobserved`,
    );
    for (const f of report.folds) {
      const nstar =
        f.breakevenTurns === null ? "n/a" : f.breakevenTurns.toFixed(2);
      const k = f.turnsToNextFold === null ? "—" : String(f.turnsToNextFold);
      const verdict =
        f.paidBack === null ? "?" : f.paidBack ? "PAID BACK" : "NOT PAID BACK";
      const h = f.hPct === null ? "n/a" : `${f.hPct.toFixed(1)}%`;
      out.push(
        `  #${f.seq} ${fmtTime(f.at)} S=${fmtTok(f.S)} σ=${fmtTok(f.sigma)} h=${h} T=${fmtTok(f.T)} ΔC₁=${fmtTok(f.oneTimeCostUnits)} Δs=${fmtTok(f.perTurnSavingUnits)}/turn n*=${nstar} k=${k} → ${verdict}`,
      );
    }
  }
  if (report.lines.length > 0) {
    out.push("");
    if (report.linesOmitted > 0)
      out.push(
        `LINE ITEMS (last ${report.lines.length} of ${report.lines.length + report.linesOmitted}):`,
      );
    else out.push("LINE ITEMS:");
    out.push(
      "  #     time      input  cached    hit%      new    comp     ttl  fold",
    );
    for (const l of report.lines) {
      const fold = l.foldSeq !== null ? `#${l.foldSeq}` : "";
      out.push(
        `  ${String(l.seq).padStart(4)}  ${fmtTime(l.at)}  ${fmtTok(l.input).padStart(7)}  ${fmtTok(l.cached).padStart(7)}  ${l.hitPct.toFixed(1).padStart(5)}%  ${fmtTok(l.newContent).padStart(6)}  ${fmtTok(l.compRepay).padStart(6)}  ${fmtTok(l.ttlRepay).padStart(6)}  ${fold}`,
      );
    }
  }
  return out.join("\n");
}

function formatCacheReportSummary(report: CacheReport): string {
  const t = report.totals;
  const out: string[] = [];
  out.push("GRAND LEDGER");
  out.push(`  total input    ${fmtTok(t.input)} tok`);
  out.push(
    `  total cached   ${fmtTok(t.cached)} tok  (hit ${t.hitPct.toFixed(1)}% → ${hitVerdict(t.hitPct)})`,
  );
  out.push(`  total output   ${fmtTok(t.output)} tok`);
  out.push(
    `  miss breakdown (input − cached = ${fmtTok(Math.max(0, t.input - t.cached))} tok):`,
  );
  const avgNew = t.requests > 0 ? t.newContent / t.requests : 0;
  out.push(
    `    new content     ${fmtTok(t.newContent)} tok  (~${fmtTok(avgNew)}/req fresh append — not an invalidation)`,
  );
  out.push(
    `    compress re-pay ${fmtTok(t.compRepay)} tok  (${report.economics.folds} folds — re-billed prefix)`,
  );
  const spikeIdx: number[] = [];
  report.lines.forEach((l, i) => {
    if (l.ttlRepay >= TTL_SPIKE_TOK) spikeIdx.push(i);
  });
  const spikes = [...spikeIdx]
    .sort(
      (a, b) =>
        (report.lines[b]?.ttlRepay ?? 0) - (report.lines[a]?.ttlRepay ?? 0),
    )
    .slice(0, SUMMARY_FOLD_TOPS)
    .sort((a, b) => a - b);
  const spikeText = spikes
    .map((i) => {
      const l = report.lines[i];
      if (!l) return "";
      let idle = "";
      const prev = report.lines[i - 1];
      if (prev && l.at > prev.at) idle = `, idle ${fmtIdleGap(l.at - prev.at)}`;
      return `#${l.seq} ${fmtTok(l.ttlRepay)}${idle}`;
    })
    .join(" · ");
  out.push(
    `    upstream-ttl-or-client-rewrite (unattributed)  ${fmtTok(t.ttlRepay)} tok  (stable-prefix misses: upstream TTL expiry / eviction or client-side wire rewrite — kernel cannot distinguish${spikeText ? `; top spikes: ${spikeText}` : ""})`,
  );
  out.push(
    `  identity check   ${t.balanced ? "OK" : "BROKEN"} — ${fmtTok(t.input)} = ${fmtTok(t.cached)} + ${fmtTok(t.newContent)} + ${fmtTok(t.compRepay)} + ${fmtTok(t.ttlRepay)} (residual ${t.residual})`,
  );
  const e = report.economics;
  if (e.folds > 0) {
    const p = report.profile;
    out.push("");
    out.push(`FOLD ECONOMICS (${e.folds} folds @ w=${p.w} r=${p.r} q=${p.q})`);
    out.push(
      `  gross saved ${fmtTok(e.grossSaved)} tok · repay cost ${fmtTok(e.repayCost)} tok · summary cost ${fmtTok(e.summaryCost)} tok → net ${e.netTokens >= 0 ? "+" : ""}${fmtTok(e.netTokens)} tok`,
    );
    out.push(
      `  verdict: ${e.paidBackCount} PAID BACK / ${e.notPaidBackCount} NOT PAID BACK / ${e.unobservedCount} unobserved`,
    );
    if (e.notPaidBackCount > 0)
      out.push(
        `  NOT PAID BACK = post-fold requests so far have not reached n* (early fold or session ended before payback — one-time cost, not data loss)`,
      );
    if (report.folds.length <= SUMMARY_FOLD_TOPS * 2) {
      for (const f of report.folds) {
        const nstar =
          f.breakevenTurns === null ? "n/a" : f.breakevenTurns.toFixed(2);
        const k = f.turnsToNextFold === null ? "—" : String(f.turnsToNextFold);
        const h = f.hPct === null ? "n/a" : `${f.hPct.toFixed(1)}%`;
        out.push(
          `  #${f.seq} ${fmtTime(f.at)} S=${fmtTok(f.S)} σ=${fmtTok(f.sigma)} h=${h} T=${fmtTok(f.T)} ΔC₁=${fmtTok(f.oneTimeCostUnits)} Δs=${fmtTok(f.perTurnSavingUnits)}/turn n*=${nstar} k=${k} → ${foldVerdict(f)}`,
        );
      }
    } else {
      const largest = [...report.folds]
        .sort((a, b) => b.S - a.S)
        .slice(0, SUMMARY_FOLD_TOPS);
      const worst = [...report.folds]
        .sort((a, b) => b.oneTimeCostUnits - a.oneTimeCostUnits)
        .slice(0, SUMMARY_FOLD_TOPS);
      out.push(
        `  largest folds: ${largest.map((f) => `#${f.seq} S=${fmtTok(f.S)} ${foldVerdict(f)}`).join(" · ")}`,
      );
      out.push(
        `  worst one-time: ${worst.map((f) => `#${f.seq} ΔC₁=${fmtTok(f.oneTimeCostUnits)} (${foldVerdict(f)}${f.turnsToNextFold !== null ? `, k=${f.turnsToNextFold}` : ""})`).join(" · ")}`,
      );
      const shown = new Set([...largest, ...worst]);
      if (report.folds.length > shown.size)
        out.push(
          `  → ${report.folds.length - shown.size} more folds omitted (detail:"full" lists every fold)`,
        );
    }
  }
  if (report.lines.length > 0) {
    out.push("");
    const shownIdx: number[] = [];
    report.lines.forEach((l, i) => {
      if (l.hitPct < ANOMALY_HIT_PCT || l.missed >= ANOMALY_MISS_TOK)
        shownIdx.push(i);
    });
    const last = report.lines.length - 1;
    if (!shownIdx.includes(last)) shownIdx.push(last);
    const kept = shownIdx.slice(
      Math.max(0, shownIdx.length - SUMMARY_ANOMALY_CAP),
    );
    const anomalies = kept.filter((i) => {
      const l = report.lines[i];
      if (!l) return false;
      return l.hitPct < ANOMALY_HIT_PCT || l.missed >= ANOMALY_MISS_TOK;
    }).length;
    if (anomalies === 0) {
      const med = medianHitPct(report.lines);
      out.push(
        `LINE ITEMS — no anomalies (${report.lines.length} requests, median hit ${med !== null ? med.toFixed(1) : "n/a"}%${report.linesOmitted > 0 ? `, ${report.linesOmitted} older outside window` : ""})`,
      );
    } else {
      out.push(
        `LINE ITEMS (anomalies: hit<${ANOMALY_HIT_PCT}% or miss≥${fmtTok(ANOMALY_MISS_TOK)}):`,
      );
      out.push(
        "  #     time      input  cached    hit%      new    comp     ttl  fold",
      );
      for (const i of kept) {
        const l = report.lines[i];
        if (!l) continue;
        const fold = l.foldSeq !== null ? `#${l.foldSeq}` : "";
        out.push(
          `  ${String(l.seq).padStart(4)}  ${fmtTime(l.at)}  ${fmtTok(l.input).padStart(7)}  ${fmtTok(l.cached).padStart(7)}  ${l.hitPct.toFixed(1).padStart(5)}%  ${fmtTok(l.newContent).padStart(6)}  ${fmtTok(l.compRepay).padStart(6)}  ${fmtTok(l.ttlRepay).padStart(6)}  ${fold}`,
        );
      }
      const omitted = report.lines.length - kept.length;
      if (omitted > 0) {
        const rest = report.lines.filter((_, i) => !kept.includes(i));
        const med = medianHitPct(rest);
        out.push(
          `  … ${omitted} lines omitted (median hit ${med !== null ? med.toFixed(1) : "n/a"}%${report.linesOmitted > 0 ? `, ${report.linesOmitted} older outside window` : ""} — detail:"full" lists all)`,
        );
      }
    }
  }
  return out.join("\n");
}

/** Render the report as compact, model- and human-readable text.
 *  The identity line is always printed so a broken implementation cannot hide.
 *  Default detail is "summary"; pass { detail: "full" } for the legacy
 *  every-fold, every-line listing. */
export function formatCacheReport(
  report: CacheReport,
  sessionLabel?: string,
  opts?: FormatCacheReportOptions,
): string {
  const t = report.totals;
  const header = `ACP CACHE REPORT${sessionLabel ? ` (${sessionLabel})` : ""} — ${t.requests} requests`;
  if (opts?.detail === "full") {
    return [header, "", formatCacheReportFull(report)].join("\n");
  }
  return [
    header + `  [summary — detail:"full" for every fold & line]`,
    "",
    formatCacheReportSummary(report),
  ].join("\n");
}
