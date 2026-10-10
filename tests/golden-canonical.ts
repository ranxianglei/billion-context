import { createHash } from "node:crypto";

/**
 * Shared canonicalization for golden digests (storage-refactor pins).
 *
 * Determinism rules, in order:
 *  - Map/Set → tagged JSON-able envelopes (key order = insertion order; the
 *    producers below insert in deterministic order).
 *  - Wall-clock timestamps (> 2020-09-01 in ms) → "__TS__" — savedAt,
 *    createdAt, lastSeen are environment, not contract.
 *  - UUID-shaped strings → "__UUID__" — randomized trace ids.
 *
 * NOT normalized (deliberately contract): every other byte — ref numbers,
 * block ids, summaries, stats, metadata. A change to any of those in the
 * round-trip is a migration regression and must fail the golden.
 */
export function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value instanceof Map) return { __map__: [...value.entries()].map(([k, v]) => [k, canonicalize(v)]) };
    if (value instanceof Set) return { __set__: [...value.values()].map(canonicalize) };
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = canonicalize(v);
        return out;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 1_600_000_000_000) return "__TS__";
    if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "__UUID__";
    return value;
}

export function sha256(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Canonical JSON → sha256, with a final pass of STRING-level environment
 *  normalization (ports, session ids embedded inside text fields). */
function digestOf(value: unknown, extra?: { normalize?: (s: string) => string }): string {
    let text = JSON.stringify(canonicalize(value));
    if (extra?.normalize) text = extra.normalize(text);
    return sha256(text);
}
