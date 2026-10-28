/** Canonicalization lives in src/storage/canonical.ts (shared with the
 *  shadow dry-run reconciler); re-exported here so golden/corpus tests and
 *  the shadow agree byte-for-byte. */
export { canonicalize, sha256 } from "../src/storage/canonical.ts";
import { canonicalize, sha256 } from "../src/storage/canonical.ts";

/** Deterministic key order for cross-read-path digest comparisons: two views
 *  built by different hydration paths carry identical content under different
 *  map insertion orders, and canonicalize preserves insertion order — sorting
 *  here makes the digests path-independent. Maps/Sets pass through untouched
 *  (callers that need them iterable keep them intact; canonicalize flattens
 *  them downstream). */
export function sortObjectKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortObjectKeys);
    if (v && typeof v === "object" && !(v instanceof Map) && !(v instanceof Set)) {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortObjectKeys((v as Record<string, unknown>)[k]);
        return out;
    }
    return v;
}

/** Canonical JSON → sha256, with a final pass of STRING-level environment
 *  normalization (ports, session ids embedded inside text fields). */
function digestOf(value: unknown, extra?: { normalize?: (s: string) => string }): string {
    let text = JSON.stringify(canonicalize(value));
    if (extra?.normalize) text = extra.normalize(text);
    return sha256(text);
}
