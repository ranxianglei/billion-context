import { createHash } from "node:crypto";

/**
 * #2265: simhash chain alignment — the second rung of the anonymous-identity
 * ladder. The exact progressive-hash chain (prefix-affinity.ts step 1) breaks
 * at the FIRST mutated message, so a client that decoratively rewrites its
 * history (Trae re-stamps every assistant message with the new model's tag on
 * a model switch) mints a fresh session on EVERY request: the fold state is
 * dropped, the full 1.4M-token history re-enters, and the compaction loop
 * replays from zero — the issue #2265 death spiral.
 *
 * Chain-level similarity is the discriminator (#2265 design, maintainer
 * formulation): a model switch does not rewrite the conversation — the message
 * COUNT lines up and every message stays ~99% similar. Two different
 * conversations cannot be 99% similar at every position of a deep chain, so
 * full-list positional similarity is ownership evidence that exact hashing
 * cannot see — and it is NOT the symmetric mid-chain contiguous match that
 * #1115 rejected (a fork's shared head is byte-exact, but the alignment here
 * demands near-similarity across the WHOLE list, head to tail).
 *
 * This module is pure math: a 64-bit simhash over canonical-message text and
 * a Hamming distance. Policy (thresholds, retention, adoption) lives in
 * prefix-affinity.ts. Everything is deterministic — the same canonical string
 * always hashes to the same sketch — so adoption decisions are reproducible
 * and the persisted snapshots are stable.
 */

/** Max shingle features per message. Simhash discrimination saturates well
 *  before this; the uniform stride sampling below keeps full-length coverage
 *  (a small mutation anywhere in a 100KB message still moves ~1/256th of the
 *  features — visible in the Hamming distance, not silently past a head cap). */
const MAX_FEATURES = 256;

/** Memo: itemHash (sha256 of the canonical string) → sketch. Content-addressed,
 *  so the sketch for an unchanged message is computed once per process no
 *  matter how many chains replay it. Bounded; the entry is tiny (16 hex). */
const SKETCH_MEMO_CAP = 8192;
const sketchMemo = new Map<string, string>();

/** FNV-1a 32-bit with a caller-chosen basis (two bases → two independent
 *  32-bit halves of the 64-bit feature id). Stays in uint32 via Math.imul. */
function fnv1a32(text: string, basis: number): number {
    let h = basis >>> 0;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

/** 64-bit simhash of a canonical message string, as 16 lowercase hex chars.
 *  Features are consecutive word-token pairs (bigram shingles); Unicode word
 *  runs so CJK behaves. Degenerate inputs (< 2 tokens) fall back to unigrams
 *  so a short message still yields a stable, comparable sketch. */
export function simhashHex(canonical: string): string {
    const tokens = canonical.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const features: string[] = [];
    if (tokens.length < 2) {
        for (const t of tokens) features.push(t);
    } else {
        for (let i = 0; i + 1 < tokens.length; i++) features.push(`${tokens[i]}\u0001${tokens[i + 1]}`);
    }
    if (features.length === 0) {
        // No word tokens at all (pure punctuation/whitespace): hash the raw
        // string so even that degenerate case is deterministic and comparable.
        features.push(canonical);
    }
    const stride = Math.max(1, Math.ceil(features.length / MAX_FEATURES));
    const v = new Int8Array(64);
    for (let f = 0; f < features.length; f += stride) {
        const h1 = fnv1a32(features[f]!, 2166136261);
        const h2 = fnv1a32(features[f]!, 2166136261 ^ 0x9e3779b9);
        for (let b = 0; b < 64; b++) {
            const bit = b < 32 ? (h1 >>> b) & 1 : (h2 >>> (b - 32)) & 1;
            v[b] += bit === 1 ? 1 : -1;
        }
    }
    let lo = 0;
    let hi = 0;
    for (let b = 0; b < 32; b++) {
        if (v[b]! > 0) lo |= 1 << b;
        if (v[b + 32]! > 0) hi |= 1 << b;
    }
    return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

/** Hamming distance between two simhash hex strings; -1 when either side is
 *  malformed (caller treats unknown distance as divergent). */
export function hammingHex(a: string, b: string): number {
    if (a.length !== 16 || b.length !== 16) return -1;
    return popcount(hexToU32(a.slice(0, 8)) ^ hexToU32(b.slice(0, 8))) +
        popcount(hexToU32(a.slice(8)) ^ hexToU32(b.slice(8)));
}

function hexToU32(hex: string): number {
    const n = Number.parseInt(hex, 16);
    return Number.isFinite(n) ? n >>> 0 : 0;
}

function popcount(x: number): number {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return (Math.imul(x, 0x01010101) >>> 24);
}

/** #2824: real SimHash evaluations (memo misses) since process start — test
 *  observability for the "no unused sketch computation" regression. */
let simhashComputeCount = 0;
export function simhashComputeCountForTest(): number {
    return simhashComputeCount;
}

/** Sketch for a canonical message, memoized by its sha256 item hash (the
 *  caller already computes that hash for the chain, so a cache hit costs one
 *  Map lookup and a miss costs one simhash — never a second stringify). */
export function sketchForCanonical(canonical: string, itemHash?: string): string {
    const key = itemHash ?? createHash("sha256").update(canonical).digest("hex");
    const hit = sketchMemo.get(key);
    if (hit !== undefined) {
        // refresh LRU recency
        sketchMemo.delete(key);
        sketchMemo.set(key, hit);
        return hit;
    }
    const sketch = simhashHex(canonical);
    simhashComputeCount++;
    if (sketchMemo.size >= SKETCH_MEMO_CAP) {
        const oldest = sketchMemo.keys().next().value;
        if (oldest !== undefined) sketchMemo.delete(oldest);
    }
    sketchMemo.set(key, sketch);
    return sketch;
}

