import { createHash } from "node:crypto";

/**
 * Shared canonicalization for storage digests (#2671).
 *
 * Canonical home: this file is imported by the storage layer (shadow
 * dry-run reconciliation) and re-exported by tests/golden-canonical.ts so
 * corpus manifests and shadow checks agree byte-for-byte.
 *
 * Determinism rules, in order:
 *  - Map/Set → tagged JSON-able envelopes (key order = insertion order; the
 *    producers below insert in deterministic order).
 *  - Wall-clock timestamps (> 2020-09-01 in ms) → "__TS__" — savedAt,
 *    createdAt, lastSeen are environment, not contract.
 *  - UUID-shaped strings → "__UUID__" — randomized trace ids.
 *  - metadata.biliVersion → "__VER__" — last-writer build stamp; a re-save
 *    by a newer build legitimately rewrites it (probe-proven: it is the ONLY
 *    field the legacy save→reload round-trip changes on the folded corpus
 *    case), so pinning it would break parity on every version bump.
 *
 * NOT normalized (deliberately contract): every other byte — ref numbers,
 * block ids, summaries, stats, metadata. A change to any of those in the
 * round-trip is a migration regression and must fail the golden.
 */
export function canonicalize(value: unknown): unknown {
    return canonicalizeWithContext(value, undefined);
}

function canonicalizeWithContext(value: unknown, key: string | undefined): unknown {
    if (Array.isArray(value)) return value.map((v) => canonicalizeWithContext(v, undefined));
    if (value instanceof Map) return { __map__: [...value.entries()].map(([k, v]) => [k, canonicalizeWithContext(v, undefined)]) };
    if (value instanceof Set) return { __set__: [...value.values()].map((v) => canonicalizeWithContext(v, undefined)) };
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = canonicalizeWithContext(v, k);
        return out;
    }
    if (key === "biliVersion" && typeof value === "string") return "__VER__";
    if (typeof value === "number" && Number.isFinite(value) && value > 1_600_000_000_000) return "__TS__";
    if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "__UUID__";
    return value;
}

export function sha256(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}
