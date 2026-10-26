import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCacheReport,
  computeFoldEconomics,
  decomposeSample,
  FOLD_CLAIM_COLD_ROUNDS,
  formatCacheReport,
  type CacheSample,
  type FoldEvent,
} from "../src/cache-report.js";
import {
  ACP_CACHE_TOOL_DESCRIPTION,
  ACP_CACHE_TOOL_NAME,
  ACP_CACHE_TOOL_OPENAI,
  ACP_CACHE_TOOL,
  ACP_CACHE_TOOL_RESPONSES,
  ACP_TOOLS_OPENAI,
  ACP_TOOLS_ANTHROPIC,
  ACP_TOOLS_RESPONSES,
  ACP_READONLY_TOOLS_RESPONSES,
  ACP_TOOL_NAMES,
  ACP_READONLY_TOOLS,
} from "../src/compress-tools.js";

const T0 = Date.parse("2026-09-15T10:00:00Z");
const min = 60_000;

function sample(
  atOffsetMin: number,
  input: number,
  cached: number,
  output = 0,
): CacheSample {
  return { at: T0 + atOffsetMin * min, input, cached, output };
}

test("identity holds for arbitrary inputs (property-style)", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const samples: CacheSample[] = [];
  const folds: FoldEvent[] = [];
  let t = 0;
  for (let i = 0; i < 300; i++) {
    t += 1 + Math.floor(rand() * 5);
    const input = Math.floor(5_000 + rand() * 90_000);
    const cached = Math.floor(rand() * (input + 1));
    samples.push({ at: T0 + t * min, input, cached });
    if (rand() < 0.2) {
      folds.push({
        at: T0 + (t - 0.5) * min,
        tokensCompressed: Math.floor(5_000 + rand() * 50_000),
        firstFoldStartTokens: Math.floor(rand() * 20_000),
      });
    }
  }
  const r = buildCacheReport(samples, folds);
  assert.equal(r.totals.balanced, true);
  assert.equal(r.totals.residual, 0);
  assert.equal(
    r.totals.input,
    r.totals.cached +
      r.totals.newContent +
      r.totals.compRepay +
      r.totals.ttlRepay,
  );
  for (const l of r.lines) {
    assert.ok(l.newContent >= 0 && l.compRepay >= 0 && l.ttlRepay >= 0);
    assert.equal(l.missed, l.newContent + l.compRepay + l.ttlRepay);
    assert.equal(l.missed, Math.max(0, l.input - l.cached));
  }
});

test("pure-append session: growth is new content; cold start is residual", () => {
  // No baseline before the first request → its whole miss lands in the
  // residual bucket by design (documented cold-start semantics).
  const samples = [
    sample(0, 1000, 0),
    sample(1, 2000, 1000),
    sample(2, 3000, 2000),
  ];
  const r = buildCacheReport(samples, []);
  assert.equal(r.totals.newContent, 1000 + 1000);
  assert.equal(r.totals.compRepay, 0);
  assert.equal(r.totals.ttlRepay, 1000);
  assert.equal(r.totals.balanced, true);
});

test("no folds, cold cache: miss attributed to the unattributed stable-prefix bucket", () => {
  const samples = [sample(0, 1000, 1000), sample(30, 1000, 400)];
  const r = buildCacheReport(samples, []);
  const last = r.lines[r.lines.length - 1];
  assert.equal(last.missed, 600);
  assert.equal(last.newContent, 0);
  assert.equal(last.compRepay, 0);
  assert.equal(last.ttlRepay, 600);
});

test("fold cliff: structural excess credited to the fold, remainder to ttl", () => {
  // Request A: 10K in, 9K cached. Fold removes S=5K, divergence at X=3K,
  // post-fold view V'=5.5K. Request B: 6K in (5.5K view + 500 fresh... note
  // growth is negative so newContent=0), only 1K cached (TTL ate part too).
  const samples = [sample(0, 10_000, 9_000), sample(1, 6_000, 1_000)];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 5_000,
      firstFoldStartTokens: 3_000,
      viewBefore: 10_000,
      viewAfter: 5_500,
    },
  ];
  const r = buildCacheReport(samples, folds);
  const b = r.lines[1];
  assert.equal(b.missed, 5_000);
  assert.equal(b.newContent, 0);
  assert.equal(b.compRepay, 3_000); // 6000 − 3000(X) − 0
  assert.equal(b.ttlRepay, 2_000);
  assert.equal(b.foldSeq, 1);
  const f = r.folds[0];
  assert.equal(f.T, 3_000);
  assert.equal(f.hPct, round1((1_000 / 6_000) * 100));
  assert.ok(f.breakevenTurns !== null && f.breakevenTurns > 0);
});

test("multiple folds in one window: earliest divergence point wins", () => {
  const samples = [sample(0, 10_000, 9_000), sample(1, 7_000, 2_000)];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.3 * min,
      tokensCompressed: 2_000,
      firstFoldStartTokens: 5_000,
    },
    {
      at: T0 + 0.7 * min,
      tokensCompressed: 3_000,
      firstFoldStartTokens: 2_000,
    },
  ];
  const r = buildCacheReport(samples, folds);
  const b = r.lines[1];
  // excess = 7000 − 2000(min X) = 5000; missed = 5000 → all comp, owner #2
  assert.equal(b.compRepay, 5_000);
  assert.equal(b.ttlRepay, 0);
  assert.equal(b.foldSeq, 2);
  assert.equal(r.folds[1].T, 5_000);
});

test("fold without post-fold request: zero one-time cost is instantly paid back, cadence unobserved (#2044)", () => {
  const samples = [sample(0, 10_000, 9_000)];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 5_000,
      firstFoldStartTokens: 3_000,
    },
  ];
  const r = buildCacheReport(samples, folds);
  const f = r.folds[0];
  assert.equal(f.hPct, null);
  assert.equal(f.T, 0);
  // S=50K σ=0 T=0 → ΔC₁ = −500 → n* = 0 → trivially paid back.
  assert.equal(f.paidBack, true);
  // No next fold yet → cadence stays unobserved.
  assert.equal(f.cadenceOk, null);
  assert.equal(r.economics.paidBackCount, 1);
  assert.equal(r.economics.unobservedCount, 0);
});

test("fold with S ≤ σ has null verdict (unobservable payback horizon)", () => {
  const samples = [sample(0, 70_000, 60_000), sample(1, 22_000, 5_000)];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 2_000,
      summaryTokens: 3_000,
      firstFoldStartTokens: 5_000,
    },
  ];
  const r = buildCacheReport(samples, folds);
  const f = r.folds[0];
  assert.equal(f.breakevenTurns, null);
  assert.equal(f.paidBack, null);
  assert.equal(f.cadenceOk, null);
  assert.equal(r.economics.unobservedCount, 1);
});

test("payback verdict uses the full post-fold window (#2044)", () => {
  // S=50K σ=2K, X=5K. Post-fold request: input 22667, cached 7000 → missed
  // 15667 = compRepay (excess 17667 clamps to it). Defaults w=1,r=0.1,q=4:
  // ΔC₁ = 0.9·15667 + 4·2000 − 0.1·50000 ≈ 17100 ; Δs = 48000·0.1 = 4800 → n*≈3.6
  const samples = [sample(0, 70_000, 60_000), sample(1, 22_667, 7_000)];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 50_000,
      summaryTokens: 2_000,
      firstFoldStartTokens: 5_000,
      viewBefore: 70_000,
      viewAfter: 20_000,
    },
  ];
  const r = buildCacheReport(samples, folds);
  const f = r.folds[0];
  assert.equal(f.S, 50_000);
  assert.ok(f.T > 0);
  assert.ok(
    f.breakevenTurns !== null && f.breakevenTurns > 0 && f.breakevenTurns < 10,
  );
  assert.equal(f.turnsToNextFold, null);
  // requestsAfter = 1 < n*≈3.6 → NOT PAID BACK under the full window
  // (previously unobserved forever — the last fold can now be evaluated).
  assert.equal(f.paidBack, false);
  assert.equal(f.cadenceOk, null);
  assert.equal(r.economics.notPaidBackCount, 1);
});

test("last fold with enough post-fold requests flips to PAID BACK (#2044)", () => {
  const samples = [
    sample(0, 70_000, 60_000),
    sample(1, 22_667, 7_000),
    sample(2, 24_000, 22_000),
    sample(3, 26_000, 24_000),
    sample(4, 28_000, 26_000),
    sample(5, 30_000, 28_000),
  ];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 50_000,
      summaryTokens: 2_000,
      firstFoldStartTokens: 5_000,
      viewBefore: 70_000,
      viewAfter: 20_000,
    },
  ];
  const r = buildCacheReport(samples, folds);
  const f = r.folds[0];
  assert.equal(f.turnsToNextFold, null);
  assert.equal(f.requestsAfter, 5);
  assert.ok(f.breakevenTurns !== null && f.requestsAfter >= f.breakevenTurns);
  assert.equal(f.paidBack, true);
  assert.equal(f.cadenceOk, null);
});

test("back-to-back fold: lifetime verdict PAID BACK, cadence NOT ok (#2044 regression)", () => {
  // The incident shape from the report: a fold that paid back long ago got
  // NOT PAID BACK purely because the NEXT fold arrived in the same batch
  // (k small), while savedSoFar on the same row kept growing.
  const samples = [
    sample(0, 70_000, 60_000),
    sample(1, 22_667, 7_000),
    sample(2, 24_000, 22_000),
    sample(3, 26_000, 24_000),
    sample(4, 28_000, 26_000),
    sample(5, 30_000, 28_000),
    sample(6, 32_000, 30_000),
    sample(7, 34_000, 32_000),
    sample(8, 36_000, 34_000),
    sample(9, 38_000, 36_000),
  ];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 50_000,
      summaryTokens: 2_000,
      firstFoldStartTokens: 5_000,
      viewBefore: 70_000,
      viewAfter: 20_000,
    },
    {
      // arrives in the same batch, right after one post-fold request of fold #1
      at: T0 + 1.5 * min,
      tokensCompressed: 10_000,
      summaryTokens: 800,
      firstFoldStartTokens: 3_000,
    },
  ];
  const r = buildCacheReport(samples, folds);
  const f1 = r.folds[0];
  assert.equal(f1.turnsToNextFold, 1); // short window: the next fold came early
  assert.equal(f1.requestsAfter, 9); // full window: kept counting
  // Old behavior: 1 < n*≈3.6 → NOT PAID BACK despite savedSoFar ≈ 48K×9.
  // New behavior: 9 ≥ 3.6 → PAID BACK; the too-soon signal moves to cadenceOk.
  assert.equal(f1.paidBack, true);
  assert.equal(f1.cadenceOk, false);
  assert.equal(r.economics.paidBackCount >= 1, true);
});

test("economics summary aggregates fold economics", () => {
  const samples = [
    sample(0, 70_000, 60_000),
    sample(1, 22_000, 5_000),
    sample(2, 24_000, 22_000),
    sample(3, 26_000, 24_000),
  ];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 50_000,
      summaryTokens: 2_000,
      firstFoldStartTokens: 5_000,
    },
  ];
  const r = buildCacheReport(samples, folds);
  const e = r.economics;
  assert.equal(e.folds, 1);
  assert.equal(e.summaryCost, 2_000);
  assert.equal(e.grossSaved, (50_000 - 2_000) * 3);
  assert.equal(e.netTokens, e.grossSaved - e.repayCost - e.summaryCost);
  assert.equal(e.paidBackCount + e.notPaidBackCount + e.unobservedCount, 1);
});

test("line retention: maxLines keeps newest, totals keep everything", () => {
  const samples: CacheSample[] = [];
  for (let i = 0; i < 10; i++) samples.push(sample(i, 1_000 + i * 100, 0));
  const r = buildCacheReport(samples, [], { maxLines: 3 });
  assert.equal(r.lines.length, 3);
  assert.equal(r.linesOmitted, 7);
  assert.equal(r.lines[0].seq, 8);
  assert.equal(r.totals.requests, 10);
  assert.equal(
    r.totals.input,
    samples.reduce((n, s) => n + s.input, 0),
  );
});

test("decomposeSample: no pending folds → all remainder is ttl", () => {
  const d = decomposeSample(
    sample(0, 10_000, 9_000),
    sample(1, 10_500, 4_000),
    [],
  );
  assert.equal(d.newContent, 500);
  assert.equal(d.compRepay, 0);
  assert.equal(d.ttlRepay, 6_000);
  assert.equal(d.foldIndex, null);
});

test("decomposeSample: cached beyond divergence still clamps cleanly", () => {
  const prev = sample(0, 10_000, 9_000);
  const cur = sample(1, 6_000, 4_000); // cached > X=3000
  const d = decomposeSample(prev, cur, [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 5_000,
      firstFoldStartTokens: 3_000,
    },
  ]);
  assert.equal(d.missed, 2_000);
  assert.equal(d.compRepay, 2_000);
  assert.equal(d.ttlRepay, 0);
});

test("formatter emits identity line and sections", () => {
  const samples = [sample(0, 10_000, 9_000), sample(1, 6_000, 1_000)];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 5_000,
      firstFoldStartTokens: 3_000,
      viewAfter: 5_500,
    },
  ];
  const text = formatCacheReport(buildCacheReport(samples, folds), "sess-1");
  assert.match(text, /ACP CACHE REPORT \(sess-1\)/);
  assert.match(text, /GRAND LEDGER/);
  assert.match(text, /identity check   OK/);
  assert.match(text, /FOLD ECONOMICS/);
  assert.match(text, /LINE ITEMS/);
  assert.match(text, /PAID BACK|NOT PAID BACK|\?/);
});

test("miss bucket label is honest: upstream-ttl-or-client-rewrite, never ttl/other (#392)", () => {
  const samples = [sample(0, 10_000, 9_000), sample(1, 6_000, 1_000)];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 5_000,
      firstFoldStartTokens: 3_000,
      viewAfter: 5_500,
    },
  ];
  for (const detail of ["summary", "full"] as const) {
    const text = formatCacheReport(buildCacheReport(samples, folds), "s392", {
      detail,
    });
    assert.match(
      text,
      /upstream-ttl-or-client-rewrite \(unattributed\)/,
      `${detail} mode must use the honest bucket label`,
    );
    assert.match(
      text,
      /kernel cannot distinguish/,
      `${detail} mode keeps the uncertainty wording`,
    );
    assert.ok(
      !text.includes("ttl/other"),
      `${detail} mode must not claim ttl/other (#392)`,
    );
  }
  assert.ok(
    ACP_CACHE_TOOL_DESCRIPTION.includes("upstream-ttl-or-client-rewrite"),
    "acp_cache tool description names the honest bucket",
  );
  assert.ok(
    !ACP_CACHE_TOOL_DESCRIPTION.includes("TTL expiry"),
    "acp_cache tool description must not claim TTL as fact (#392)",
  );
});

test("acp_cache tool definitions registered across wires", () => {
  assert.equal(ACP_CACHE_TOOL_NAME, "acp_cache");
  assert.equal(ACP_CACHE_TOOL_OPENAI.function.name, "acp_cache");
  assert.equal(ACP_CACHE_TOOL.name, "acp_cache");
  assert.equal(ACP_CACHE_TOOL_RESPONSES.name, "acp_cache");
  assert.ok(ACP_TOOLS_OPENAI.some((t) => t.function.name === "acp_cache"));
  assert.ok(ACP_TOOLS_ANTHROPIC.some((t) => t.name === "acp_cache"));
  assert.ok(ACP_TOOLS_RESPONSES.some((t) => t.name === "acp_cache"));
  assert.ok(ACP_READONLY_TOOLS_RESPONSES.some((t) => t.name === "acp_cache"));
  assert.ok(ACP_TOOL_NAMES.has("acp_cache"));
  assert.ok(ACP_READONLY_TOOLS.has("acp_cache"));
  assert.ok(!ACP_CACHE_TOOL_OPENAI.function.description.includes("loop"));
});

test("computeFoldEconomics matches #359 formulas under default profile", () => {
  const e = computeFoldEconomics({
    seq: 1,
    at: 1_000_000,
    S: 50_000,
    sigma: 2_000,
    hPct: 33,
    T: 17_000,
    requestsAfter: 21,
    turnsToNextFold: 21,
  });
  // ΔC₁ = (w-r)T + qσ - rS = 0.9*17000 + 4*2000 - 0.1*50000 = 18300
  assert.equal(e.oneTimeCostUnits, 18_300);
  // Δs = (S-σ)r = 48000 * 0.1 = 4800
  assert.equal(e.perTurnSavingUnits, 4_800);
  assert.ok(Math.abs(e.breakevenTurns! - 18_300 / 4_800) < 1e-9);
  assert.equal(e.paidBack, true);
  assert.equal(e.cadenceOk, true);
  assert.equal(e.savedSoFar, 48_000 * 21);
  assert.equal(e.netTokenDelta, 17_000 + 2_000 - 50_000);

  // #2044: the incident shape — next fold arrives immediately (k=0) but the
  // fold has long since paid back across the full post-fold horizon.
  const e2 = computeFoldEconomics({
    seq: 1,
    at: 1_000_000,
    S: 50_000,
    sigma: 2_000,
    hPct: 33,
    T: 17_000,
    requestsAfter: 21,
    turnsToNextFold: 0,
  });
  assert.equal(e2.paidBack, true);
  assert.equal(e2.cadenceOk, false);
  assert.equal(e2.savedSoFar, 48_000 * 21);
});

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

test("formatCacheReport defaults to summary: verdicts + anomaly-only lines", () => {
  const samples: CacheSample[] = [];
  for (let i = 0; i < 30; i++) {
    samples.push(sample(i, 100_000, 98_500));
  }
  const folds: FoldEvent[] = [];
  for (let f = 0; f < 10; f++) {
    folds.push({
      at: T0 + (f * 3 + 2.5) * min,
      tokensCompressed: 5_000 + f,
      summaryTokens: 500,
      firstFoldStartTokens: 3_000,
    });
  }
  const text = formatCacheReport(buildCacheReport(samples, folds), "s1");
  assert.match(text, /\[summary — detail:"full" for every fold & line\]/);
  assert.match(text, /→ HEALTHY\)/);
  assert.match(text, /PAID BACK \/ \d+ NOT PAID BACK \/ \d+ unobserved/);
  assert.match(text, /more folds omitted/);
  assert.match(text, /no anomalies \(30 requests, median hit 98\.5%\)/);
  assert.ok(!/\n  \s+#?\d+\s+\d\d:/m.test(text), "no per-line rows in summary");
});

test("formatCacheReport summary surfaces anomalous lines with idle gaps", () => {
  const samples: CacheSample[] = [];
  for (let i = 0; i < 20; i++) samples.push(sample(i, 100_000, 99_000));
  samples.push(sample(120, 100_000, 500));
  for (let i = 0; i < 5; i++) samples.push(sample(121 + i, 100_000, 99_000));
  const text = formatCacheReport(buildCacheReport(samples, []), "s2");
  assert.match(text, /LINE ITEMS \(anomalies: hit<85% or miss≥5000\):/);
  const anomaly = text.split("\n").filter((l) => /\s+0\.5%\s/.test(l));
  assert.equal(anomaly.length, 1, "the 500/100000 hit line is shown");
  assert.match(text, /lines omitted \(median hit 99\.0%/);
});

test("formatCacheReport detail:'full' keeps the legacy every-line listing", () => {
  const samples: CacheSample[] = [];
  for (let i = 0; i < 30; i++) samples.push(sample(i, 100_000, 98_500));
  const folds: FoldEvent[] = [];
  for (let f = 0; f < 10; f++) {
    folds.push({
      at: T0 + (f * 3 + 2.5) * min,
      tokensCompressed: 5_000 + f,
      summaryTokens: 500,
      firstFoldStartTokens: 3_000,
    });
  }
  const text = formatCacheReport(buildCacheReport(samples, folds), "s3", {
    detail: "full",
  });
  assert.ok(!text.includes("[summary"));
  const foldRows = text.split("\n").filter((l) => / S=500\d /.test(l));
  assert.equal(foldRows.length, 10, "all 10 fold rows listed");
  const lineRows = text.split("\n").filter((l) => /\s+98\.5%\s/.test(l));
  assert.equal(lineRows.length, 30, "all 30 line items listed");
  assert.match(text, /identity check   OK/);
});

test("formatCacheReport summary lists every fold when few, with TTL spike idle gap", () => {
  const samples = [sample(0, 100_000, 99_000), sample(1, 100_000, 99_000)];
  const folds: FoldEvent[] = [
    {
      at: T0 + 0.5 * min,
      tokensCompressed: 20_000,
      summaryTokens: 500,
      firstFoldStartTokens: 3_000,
    },
  ];
  samples.push(sample(10, 100_000, 10_000));
  const text = formatCacheReport(buildCacheReport(samples, folds), "s4");
  assert.match(text, /#1 .*S=20\.0K.* → (NOT PAID BACK|PAID BACK|\?)/);
  assert.ok(!text.includes("more folds omitted"));
});

test("#2929 fold cold-tail claim: the client-echo re-bill is fold-owned until a warm line retires", () => {
  // Degenerate head fold (X=3K): proxy re-request (s2) is claimed today, the
  // client echo (s3) and the cold recovery tail (s4) must ALSO carry foldSeq —
  // before #2929 s3/s4 fell into the unattributed ttlRepay residual and tripped
  // the cache-seam detector. A warm line (s5) retires the window; a later cold
  // blip (s6, real provider eviction) is NOT swallowed by the old fold.
  const samples = [
    sample(0, 100_000, 99_000),   // warm baseline
    sample(1, 51_000, 5_000),     // proxy re-request after fold: 9.8%
    sample(2, 55_000, 5_100),     // client echo re-bill: 9.3%
    sample(3, 60_000, 42_000),    // recovery: 70% (still < 85 warm line)
    sample(4, 65_000, 60_000),    // warm: 92% — retires the claim window
    sample(5, 66_000, 30_000),    // unrelated later cold blip: 45%
  ];
  const folds: FoldEvent[] = [
    { at: T0 + 0.5 * min, tokensCompressed: 50_000, firstFoldStartTokens: 3_000, viewBefore: 100_000, viewAfter: 50_500 },
  ];
  const r = buildCacheReport(samples, folds);
  const [, s2, s3, s4, s5, s6] = r.lines;
  assert.equal(s2!.foldSeq, 1, "re-request claimed (first claim, unconditional)");
  assert.equal(s2!.compRepay, 46_000);
  assert.equal(s3!.foldSeq, 1, "client-echo re-bill claimed (#2929)");
  assert.equal(s3!.compRepay, 45_900);
  assert.equal(s3!.ttlRepay, 0, "echo residual no longer lands in the unattributed bucket");
  assert.equal(s4!.foldSeq, 1, "cold recovery tail claimed");
  assert.equal(s4!.compRepay, 13_000);
  assert.equal(s5!.foldSeq, null, "warm line is never claimed as a continuation");
  assert.equal(s5!.compRepay, 0);
  assert.equal(s6!.foldSeq, null, "window closed — later cold blip is NOT the fold's");
  assert.equal(s6!.ttlRepay, 35_000, "blip falls to the unattributed residual");
  assert.equal(r.totals.ttlRepay, 36_000, "1K baseline residual + the 35K post-window blip");
  assert.equal(r.folds[0]!.T, 46_000 + 45_900 + 13_000, "fold economics absorb the full cold tail");
});

test("#2929 fold cold-tail claim: FOLD_CLAIM_COLD_ROUNDS bounds the window without a warm line", () => {
  const samples = [
    sample(0, 100_000, 99_000),
    sample(1, 51_000, 5_000),
    sample(2, 52_000, 5_100),
    sample(3, 53_000, 5_200),
    sample(4, 54_000, 5_300),
    sample(5, 55_000, 5_400),     // 5th post-fold sample: window exhausted
  ];
  const folds: FoldEvent[] = [
    { at: T0 + 0.5 * min, tokensCompressed: 50_000, firstFoldStartTokens: 3_000, viewBefore: 100_000, viewAfter: 50_500 },
  ];
  const r = buildCacheReport(samples, folds);
  const claimCount = r.lines.filter((l) => l.foldSeq === 1).length;
  assert.equal(claimCount, FOLD_CLAIM_COLD_ROUNDS, "exactly the bound — never an open-ended claim");
  assert.equal(r.lines[5]!.foldSeq, null);
  assert.ok(r.lines[5]!.ttlRepay > 0, "post-window residual is unattributed again");
});

test("#2929 fold cold-tail claim: a warm FIRST post-fold sample claims once and retires", () => {
  const samples = [
    sample(0, 100_000, 99_000),
    sample(1, 51_000, 50_000),   // 98% warm immediately after a tiny fold
    sample(2, 52_000, 20_000),   // later cold blip must not be swallowed
  ];
  const folds: FoldEvent[] = [
    { at: T0 + 0.5 * min, tokensCompressed: 5_000, firstFoldStartTokens: 3_000, viewBefore: 100_000, viewAfter: 95_500 },
  ];
  const r = buildCacheReport(samples, folds);
  assert.equal(r.lines[1]!.foldSeq, 1, "first claim is unconditional even on a warm line");
  assert.equal(r.lines[2]!.foldSeq, null, "retired by the warm first sample");
  assert.ok(r.lines[2]!.ttlRepay > 0);
});
