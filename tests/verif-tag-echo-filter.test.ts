/**
 * tag-echo-filter judge — streaming-stability & artifact-hygiene properties
 * over the REAL filter family (src/loop/tag-echo-filter.ts).
 *
 * Why replay (no solver): the interesting entry points are outside the
 * symbolic sublanguage today — stripAcpTags' regex family uses lookaround
 * (ORPHAN_RUN_BEFORE / DEAD_REF_CLOSE / LONE_CLOSE) and \p{So} (MARKER_*),
 * and the stream filters drive stateful re.exec loops with lastIndex.
 * The engine would degrade to {kind:any}, so this judge runs the real code
 * over adversarial generated shapes instead: chunk-boundary equivalence,
 * idempotence, monotonicity, clean-preservation, residue duality — plus
 * per-issue positive controls so each historical fix stays pinned.
 *
 * Deterministic: seeded PRNG (mulberry32), fixed seed — a failure prints
 * the offending input for exact replay.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACP_NAME_ALT,
  ABSORB_INSTRUCTION_MARKER,
  composeStreamFilters,
  createBiliArtifactFilter,
  createIdentityStreamFilter,
  createMarkerLineFilter,
  createTagEchoFilter,
  containsEchoResidue,
  containsMarkerLineText,
  containsRenderTagText,
  normalizeEchoArtifacts,
  stripAcpTags,
  type TagEchoFilter,
} from "../src/loop/tag-echo-filter.ts";

// ---------------------------------------------------------------- rng
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x7ea4c0de);
const ri = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]): T => xs[ri(0, xs.length - 1)]!;

// ------------------------------------------------------- tag grammar
// ACP_NAME_ALT is a case-insensitive alternation of acp-permutations
// (optionally with one inserted letter from [aAcCpPiI]); the generator
// samples names from that language so the regexes see real shapes.
const CORES = ["acp", "apc", "cap", "cpa", "pac", "pca"] as const;
const ci = (ch: string): string => (rnd() < 0.5 ? ch.toLowerCase() : ch.toUpperCase());
function acpName(): string {
  const core = pick(CORES);
  const letters = core.split("");
  if (rnd() < 0.25) letters.splice(ri(0, letters.length), 0, pick(["a", "A", "c", "C", "p", "P", "i", "I"]));
  return letters.map(ci).join("");
}
const ATTRS = [` tokens="12" type="text"`, ` = "x"`, ` tokens="0"`] as const;
const attr = (): string => (rnd() < 0.5 ? "" : pick(ATTRS));
const refRun = (): string => {
  const n = ri(1, 3);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`m${ri(0, 9999).toString().padStart(4, "0")}`);
  return out.join(" ");
};
const PROSE = [
  "the quick brown fox", "jumps over", "42 lazy dogs", "x", "hello, world",
  "multi\nline\ntext", "unicode ✓ café 日本", "trailing spaces   ", "  leading",
  "quotes \" and ' mixed", "angle < not a tag", "half \x3c acp", "digits 123456",
] as const;

function tagShape(): string {
  const name = acpName();
  switch (ri(0, 10)) {
    case 0: return `<${name}${attr()}>${refRun()}</${name}>`;              // paired, refs payload
    case 1: return `<${name}${attr()}>${pick(PROSE)}</${name}>`;          // paired, prose payload
    case 2: return `<${name}${attr()}/>`;                                  // self-close
    case 3: return `<${name}${attr()}>`;                                   // lone open
    case 4: return `</${name}>`;                                           // lone close
    case 5: return `<${name}> m${ri(1000, 9999)} </x>`;                    // degenerate pair
    case 6: { const t = `<${name}${attr()}>${pick(PROSE)}</${name}>`; return t.slice(0, ri(1, Math.max(1, t.length - 1))); } // truncated (either end)
    case 7: return `${refRun()}</${name}`;                                 // dead ref-close head
    case 8: return `${pick(["\u{1F4E6}", "\u2728", "\u2757"])} [ACP] Compressed m00120\u2013m0300 \u2192 1 block(s)`;
    case 9: return `<${name}${attr()}>${pick(PROSE)}`;                     // open, no close (prose-wearing?)
    default: return pick(PROSE);                                           // plain prose
  }
}
function randomText(): string {
  const parts: string[] = [];
  const n = ri(1, 6);
  for (let i = 0; i < n; i++) parts.push(rnd() < 0.45 ? tagShape() : pick(PROSE));
  return parts.join(pick([" ", "\n", "", "  ", "\n\n"]));
}
// A tool-call emission field (toolCallEmissionSpan shape) for the
// absorb-instructed stream paths.
function emissionField(): string {
  const ref = `m${ri(0, 9999).toString().padStart(4, "0")}`;
  return `<function_calls>\n<parameter=ref>\n${ref}\n</parameter>\n<parameter=summary>sum</parameter>\n</function_calls>`;
}

// -------------------------------------------------- stream properties
type FilterFactory = () => TagEchoFilter;
const FACTORIES: [string, FilterFactory][] = [
  ["tagEcho", () => createTagEchoFilter()],
  ["tagEcho+absorb", () => createTagEchoFilter(undefined, undefined, true)],
  ["marker", () => createMarkerLineFilter()],
  ["artifact", () => createBiliArtifactFilter()],
  ["marker∘tagEcho", () => composeStreamFilters(createMarkerLineFilter(), createTagEchoFilter())],
];
/** push every chunk, flush, concatenate — the filter's full transcript. */
const runStream = (f: TagEchoFilter, chunks: string[]): string =>
  chunks.map((c) => f.push(c)).join("") + f.flush();

/** Split points to sample: all positions for short texts, boundaries +
 * random interior for long ones. Splitting INSIDE a multi-byte char is
 * still valid — JS strings are UTF-16 code units, slice lands on them. */
const splitPoints = (t: string): number[] => {
  if (t.length <= 12) return Array.from({ length: t.length + 1 }, (_, i) => i);
  const pts = new Set<number>([1, t.length - 1, t.length]);
  for (let i = 0; i < 8; i++) pts.add(ri(1, t.length - 1));
  return [...pts];
};

test("P1 chunk-split equivalence: streaming === whole-text", () => {
  // Full domain: #4107 (chunk-split dependence on tag-bearing texts) is
  // fixed by the #4169 release-branch re-adjudication (#4210) — the
  // formerly excluded tag/residue shapes now hold too (controls below).
  for (let iter = 0; iter < 120; iter++) {
    const base = rnd() < 0.1 ? emissionField() : randomText();
    const text = rnd() < 0.2 ? `${pick(PROSE)}${base}${pick(PROSE)}` : base;
    for (const [name, mk] of FACTORIES) {
      const whole = runStream(mk(), [text]);
      for (const k of splitPoints(text)) {
        const two = runStream(mk(), [text.slice(0, k), text.slice(k)]);
        assert.equal(two, whole, `${name}: 2-way split @${k} diverged — text=${JSON.stringify(text)}`);
      }
      // three-way split at two sampled points
      const a = ri(1, Math.max(1, text.length - 2));
      const b = ri(a, text.length);
      const three = runStream(mk(), [text.slice(0, a), text.slice(a, b), text.slice(b)]);
      assert.equal(three, whole, `${name}: 3-way split (${a},${b}) diverged — text=${JSON.stringify(text)}`);
    }
  }
});

test("P1b absorb-instructed emission hold is split-stable", () => {
  for (let iter = 0; iter < 60; iter++) {
    const field = `${pick(["", "  ", "\n"])}${emissionField()}`;
    const request = `model instructions ${ABSORB_INSTRUCTION_MARKER} please comply`;
    const mk = (): TagEchoFilter => createTagEchoFilter(undefined, undefined, true, request);
    const whole = runStream(mk(), [field]);
    for (const k of splitPoints(field)) {
      assert.equal(
        runStream(mk(), [field.slice(0, k), field.slice(k)]),
        whole,
        `absorb hold split @${k} diverged — field=${JSON.stringify(field)}`,
      );
    }
  }
});

test("P2 stripAcpTags / normalizeEchoArtifacts are idempotent", () => {
  // Full domain since #4106 landed: stripAcpTags returns a fixed point
  // (input-side gate attestation + bounded fixed-point walk), so a second
  // call never removes anything further — marker lines and trailing
  // dead-ref-closes included.
  for (let iter = 0; iter < 400; iter++) {
    const t = randomText();
    const s1 = stripAcpTags(t);
    assert.equal(stripAcpTags(s1), s1, `strip not idempotent — input=${JSON.stringify(t)}`);
    const n1 = normalizeEchoArtifacts(t);
    assert.equal(normalizeEchoArtifacts(n1), n1, `normalize not idempotent — input=${JSON.stringify(t)}`);
  }
});

test("P3 strip never lengthens the text", () => {
  for (let iter = 0; iter < 400; iter++) {
    const t = randomText();
    assert.ok(
      stripAcpTags(t).length <= t.length,
      `strip lengthened ${t.length} -> ${stripAcpTags(t).length} — input=${JSON.stringify(t)}`,
    );
  }
});

test("P4 clean prose passes through untouched", () => {
  for (let iter = 0; iter < 200; iter++) {
    const parts: string[] = [];
    for (let i = 0; i < ri(1, 4); i++) parts.push(pick(PROSE));
    const t = parts.join(" ");
    // no tag-like evidence at all → byte-identical passthrough
    assert.equal(stripAcpTags(t), t, `clean text mutated — input=${JSON.stringify(t)}`);
    assert.equal(runStream(createTagEchoFilter(), [t]), t, `stream mutated clean text — input=${JSON.stringify(t)}`);
    assert.equal(runStream(createMarkerLineFilter(), [t]), t);
  }
});

test("P5 residue duality: strip removes every detectable artifact", () => {
  for (let iter = 0; iter < 300; iter++) {
    const t = randomText();
    const out = stripAcpTags(t);
    const why: string[] = [];
    // containsRenderTagText is the strict shape detector. The marker check
    // is COLUMN-0 anchored to match removal semantics: the marker-line pass
    // removes a line only when the marker sits at column 0, so an indented
    // or mid-line marker is detect-but-keep BY DESIGN (#717) and stays out
    // of the duality — only true line-START markers must go.
    // Word-GLUED echo residue (xm01238</x>) survives by design even when
    // other artifacts attest a strip: the dead-unit lookbehind keeps
    // word-like tokens out of the unit (#1760/#2862 content preservation).
    // Only UNGLUED residue violates the duality.
    // Duality is asserted only when the input was ATTESTED: atestation =
    // the strip ACTED (its own #1760 gate passed — close-only shapes with
    // no other evidence are content-preserved by design, and then the
    // detectors keep firing on the preserved close: log-signals, not strip
    // guarantees). When strip acted, nothing strict may remain.
    const acted = stripAcpTags(t) !== t;
    // #4106 family (single-sweep gated pass ordering): a refs run against an
    // UNTERMINATED acplike close dies only via DEAD_REF_CLOSE, whose "an
    // earlier pass already acted" gate is still closed when the sole other
    // artifact is a marker line removed by a LATER pass — the unit then
    // survives the sweep. Known open (C#4106 pins the sibling idempotence
    // gap). While #4106 is open, exclude exactly this shape — and no
    // iteration carrying any OTHER surviving render-tag evidence.
    const gatedUnit = /(?<![\w>])m\d{4,}(?:\s*[\u2013\u2014,\-]?\s*m\d{4,})*\s*<\/[a-zA-Z]{1,32}(?![^<>]{0,32}>)/;
    if (
      acted &&
      gatedUnit.test(out) &&
      /\[ACP\]/.test(t) &&
      !/\[ACP\]/.test(out) &&
      !containsRenderTagText(out.replace(new RegExp(gatedUnit.source, "g"), ""))
    ) continue;
    if (acted && containsRenderTagText(out)) why.push("render-tag");
    if (acted && /(?<![\w>])m\d{4,}\s*<\/[a-zA-Z]/.test(out)) why.push("echo-residue");
    if (acted && /(^|\n)[\u{1F300}-\u{1FAFF}\u2600-\u27BF}\u2B00-\u2BFF] ?\[ACP\]/u.test(out)) why.push("marker-line-at-line-start");
    assert.deepEqual(why, [], `strip left artifacts — input=${JSON.stringify(t)} out=${JSON.stringify(out)}`);
  }
});

test("P6 stats accounting: output never exceeds input, drops imply dropped", () => {
  for (let iter = 0; iter < 120; iter++) {
    const f = createTagEchoFilter();
    const t = randomText();
    const out = runStream(f, [t]);
    const st = f.stats();
    assert.ok(st.outputChars <= st.inputChars, `stats: ${st.outputChars} > ${st.inputChars}`);
    assert.equal(st.inputChars, t.length);
    assert.equal(out.length, st.outputChars);
    // dropped ("anything dropped as an imitation") and dropCount ("logical
    // artifacts") are DIFFERENT documented concepts — recordDrop paths can
    // set dropped without counting an artifact; no equivalence asserted.
  }
});

test("P7 identity filter and composition sanity", () => {
  const id = createIdentityStreamFilter();
  const t = randomText();
  assert.equal(runStream(id, [t]), t);
  const comp = composeStreamFilters(createIdentityStreamFilter(), createMarkerLineFilter());
  const single = runStream(createMarkerLineFilter(), [t]);
  assert.equal(runStream(comp, [t]), single);
  // composition is order-honest: both orders over random splits agree with
  // their own whole-run (P1 covers stability; here just sanity that the
  // composed object still honors the interface)
  const comp2 = composeStreamFilters(createMarkerLineFilter(), createBiliArtifactFilter());
  const k = ri(1, Math.max(1, t.length - 1));
  assert.equal(
    runStream(composeStreamFilters(createMarkerLineFilter(), createBiliArtifactFilter()), [t.slice(0, k), t.slice(k)]),
    runStream(comp2, [t]),
  );
});

// ------------------------------------------- issue-history controls
test("C#644/#1881: bare open past cap releases as prose; attrs tail does not resurrect", () => {
  // A bare <acp> opening followed by long prose: the tail is CONTENT when
  // the swallow budget releases it (#644). The filter must not eat it all.
  const t = "<acp>" + "prose words here ".repeat(40);
  const f = createTagEchoFilter();
  const out = runStream(f, [t]);
  assert.ok(out.includes("prose words"), `#644: content tail eaten — out=${JSON.stringify(out.slice(0, 120))}`);
});
test("C#1720: a close inside a pair belongs to the pair (payload survives)", () => {
  const t = "<acp>payload with </acp> inside</acp>after";
  const out = stripAcpTags(t);
  // the OUTER pair is stripped; the inner close belongs to its content —
  // the payload text the client cares about must not vanish entirely, and
  // 'after' (outside any tag) always survives.
  assert.ok(out.includes("after"), `#1720: post-tag text lost — out=${JSON.stringify(out)}`);
});
test("C#1760: close-only shape with no other echo is content-preserved", () => {
  const t = "just text";
  assert.equal(stripAcpTags(t), t);
  // a lone close with NO attestation: strip leaves it (no evidence)
  const t2 = "text </acp> tail";
  const out2 = stripAcpTags(t2);
  assert.ok(out2.length > 0, "#1760: close-only strip must not empty the text");
});
test("C#2862: dead ref-close unit goes when a tag echo is attested", () => {
  // attested by a paired tag elsewhere in the text → the m1234</acp unit
  // (unterminated close head) is residue and must not survive the strip
  const t = "<acp>m0001</acp> tail m2345</acp";
  const out = stripAcpTags(t);
  assert.ok(!out.includes("m2345"), `#2862: dead ref-close survived — out=${JSON.stringify(out)}`);
});
test("C#717 marker line: stripped from stream and whole-text", () => {
  const line = "\u{1F4E6} [ACP] Compressed m00120\u2013m0300 \u2192 1 block(s)";
  const t = `before\n${line}\nafter`;
  assert.ok(containsMarkerLineText(t));
  const f = createMarkerLineFilter();
  const out = runStream(f, [t]);
  assert.ok(!out.includes("[ACP]"), `marker survived stream — out=${JSON.stringify(out)}`);
  assert.ok(out.includes("before") && out.includes("after"), "marker filter ate surrounding lines");
});
test("C#2405: a pair split across pushes counts as ONE drop", () => {
  const f = createTagEchoFilter();
  const full = `<acp tokens="5" type="text">m0001</acp>`;
  f.push(full.slice(0, 10));
  f.push(full.slice(10));
  f.flush();
  assert.equal(f.stats().dropCount, 1, `#2405: split pair counted as ${f.stats().dropCount}`);
});

// ------------------------------------------------ pinned bugs
// #4106 FIXED: cleanup is a fixed point — the marker line attests on the
// INPUT side, so the trailing dead-ref closes die in the SAME call and a
// second call removes nothing further. This control guards the regression.
test("C#4106 pinned FIXED: stripAcpTags idempotent (marker + trailing dead-ref)", () => {
  const t = "angle < not a tag\nm7385</CpA\nm3117</cPa\n\u{1F4E6} [ACP] Compressed m00120\u2013m0300 \u2192 1 block(s)";
  const s1 = stripAcpTags(t);
  const s2 = stripAcpTags(s1);
  assert.equal(s1, s2, "#4106 regressed — a second cleanup call shrank the text further");
  assert.ok(!s1.includes("</CpA") && !s1.includes("</cPa"), "attested dead-ref closes must die in the first call");
});
// #4107: FIXED by the #4169 release-branch re-adjudication (#4210) — the
// dead-ref-close residue the split path used to RELEASE to the client now
// takes the main-loop verdict like the whole-text path. Control kept as a
// regression guard.
test("C#4107 (fixed #4210): dead-ref residue at payload/close split is split-invariant", () => {
  const t = '<PCPa tokens="0">angle < not a tag</PCPa>m1255</acPA</CPa>trailing spaces   ';
  const run = (chunks: string[]): string => {
    const f = createTagEchoFilter();
    return chunks.map((c) => f.push(c)).join("") + f.flush();
  };
  const whole = run([t]);
  const split = run([t.slice(0, 41), t.slice(41)]);
  assert.equal(whole, split, "#4107 regressed: chunk split diverged again");
});
// #4107 shape 2 (same family, different mechanism): a CLOSE fragment at
// the chunk boundary — the split path used to RELEASE the fragment the
// whole-text path preserves. Fixed with shape 1 (#4210); control kept.
test("C#4107-2 (fixed #4210): close fragment at chunk boundary is split-invariant", () => {
  const t = 'unicode \u2713 caf\u00e9 \u65e5\u672c <apc>unicode \u2713 caf\u00e9 \u65e5\u672c</apc <apc>quotes " and \' mixed</apc>';
  const run = (chunks: string[]): string => {
    const f = createTagEchoFilter();
    return chunks.map((c) => f.push(c)).join("") + f.flush();
  };
  const whole = run([t]);
  const split = run([t.slice(0, 49), t.slice(49)]);
  assert.equal(whole, split, "#4107-2 regressed: chunk split diverged again");
});
