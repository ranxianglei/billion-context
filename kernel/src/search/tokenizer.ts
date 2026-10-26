/**
 * Search tokenizer.
 *
 * Handles mixed Latin + CJK content — the single biggest quality lever
 * over plain substring search. Latin is split on non-word boundaries;
 * CJK (no spaces) is word-segmented via Intl.Segmenter (CLDR dictionary),
 * falling back to overlapping bigrams on out-of-vocabulary text so a query
 * like "身份验证" still scores against doc text "身份验证流程".
 *
 * CJK segmentation is a SINGLE segment() pass over the whole text, not one
 * call per CJK run: a segment() call has fixed overhead (~3µs), and
 * run-heavy text (logs: dozens of short runs per line) made per-run calls
 * 10-16× slower than one bulk pass. ICU never merges CJK words across
 * non-CJK boundaries, so bulk segmentation yields the same words per run
 * (differential-verified against the per-run implementation across a
 * mixed-script stress corpus); run boundaries are re-derived below to keep
 * the all-OOV bigram fallback.
 */

/**
 * CJK ideograph/kana/hangul class — the one shared definition of "non-Latin
 * script that must be handled specially". Exported so fuzzy.ts relaxes its
 * short-query gate for the SAME range tokenizer.ts segments: two hand-copied
 * regexes would silently drift apart. Latin is deliberately absent — 2-char
 * English tokens ("to", "of") carry no meaning, while nearly all CJK words
 * are 2-char atomic units (登录/缓存), so the two scripts need opposite rules.
 */
import { stem } from "./stemmer.js";

export const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_WORD = /[a-z][a-z0-9_]*[a-z0-9]|[a-z0-9]/g;

const cjkSegmenter = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * CJK segment groups → tokens, with the all-OOV fallback.
 *
 * `segs` are the word segments the segmenter produced for ONE contiguous
 * CJK run. Multi-char words are kept as whole terms, so "国际化" matches
 * "国际化" and "试验证明" no longer scores against "验证" through accidental
 * char runs. When the dictionary finds no multi-char word at all (all-OOV
 * text) we fall back to overlapping bigrams + single chars so recall is
 * preserved — this also covers single-char queries like "验".
 */
function cjkRunTokens(segs: string[]): string[] {
  const words = segs.filter((w) => w.length >= 2);
  if (words.length > 0) return words;
  const run = segs.join("");
  const out: string[] = [];
  for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  for (const ch of run) out.push(ch);
  return out;
}

export interface TokenizeOptions {
  stem?: boolean;
}

export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  const latin = lower.match(LATIN_WORD) ?? [];
  for (let w of latin) {
    if (w.length >= 2) {
      if (opts.stem) w = stem(w);
      tokens.push(w);
    }
  }

  // CJK: one segmenter pass over the whole text instead of one
  // segment() call per CJK run. A segment() call has fixed overhead
  // (~3µs), and run-heavy text (logs: dozens of short runs per line) made
  // per-run calls 10-16× slower than one bulk pass. ICU never merges CJK
  // words across non-CJK boundaries, so bulk segmentation yields the same
  // words per run (differential-verified against the per-run
  // implementation across a mixed-script stress corpus); run boundaries
  // are re-derived below to keep the all-OOV bigram fallback.
  //
  // Guard: skip the segmenter entirely when the text has no CJK at all —
  // the old code never called it for pure-Latin text, and a bulk pass
  // would pay a full-text scan (12ms → 33ms per MB of English) for nothing.
  if (!CJK.test(lower)) return tokens;

  // Group the bulk segments back into CJK runs: a non-CJK segment is a run
  // boundary (the segmenter never puts non-CJK inside a CJK word segment).
  const runSegs: string[][] = [];
  let cur: string[] | null = null;
  for (const s of cjkSegmenter.segment(lower)) {
    const t = s.segment;
    if (t.length === 0) continue;
    if (CJK.test(t)) {
      (cur ??= []).push(t);
    } else if (cur) {
      runSegs.push(cur);
      cur = null;
    }
  }
  if (cur) runSegs.push(cur);

  for (const segs of runSegs) {
    tokens.push(...cjkRunTokens(segs));
  }

  return tokens;
}

/** Character bigrams over arbitrary text — used by fuzzy matching. */
export function charBigrams(text: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    if (pair.trim().length === pair.length) grams.push(pair);
  }
  return grams;
}

/** Term-frequency map. */
export function tfMap(text: string, stem: boolean): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokenize(text, { stem })) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
