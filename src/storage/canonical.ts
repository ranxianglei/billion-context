import { createHash } from "node:crypto";

/**
 * Shared canonicalization for storage digests (#2671).
 *
 * Canonical home: this file is imported by the storage layer (shadow
 * dry-run reconciliation) and re-exported by tests/golden-canonical.ts so
 * corpus manifests and shadow checks agree byte-for-byte.
 *
 * Determinism rules, in order:
 *  - Object keys → SORTED at every depth (#4392): insertion order is not
 *    part of the contract. The live leg (kernel state) and the replay leg
 *    (unified rows rebuilt field by field) legitimately build the same
 *    values in different orders — messageRefs.byRef after a ref-ledger
 *    re-alignment, mergeState's spread-merged nudge/stats — so hashing
 *    insertion order made a single instance report drift against itself.
 *    Arrays keep their order (order IS content there).
 *  - Map/Set → tagged JSON-able envelopes (key order = insertion order; the
 *    producers below insert in deterministic order).
 *  - Wall-clock timestamps (> 2020-09-01 in ms) → "__TS__" — savedAt,
 *    createdAt, lastSeen are environment, not contract.
 *  - UUID-shaped strings → "__UUID__" — randomized trace ids.
 *  - metadata.biliVersion → "__VER__" — last-writer build stamp; a re-save
 *    by a newer build legitimately rewrites it (probe-proven: it is the ONLY
 *    field the legacy save→reload round-trip changes on the folded corpus
 *    case), so pinning it would break parity on every version bump.
 *  - storageMode / tailGaps → in DIGEST_SKIPPED_KEYS, dropped at every depth
 *    before hashing.
 */
export function canonicalize(value: unknown): unknown {
    return canonicalizeWithContext(value, undefined);
}

/**
 * Keys that are NEVER part of a digest, at any depth — the ONE skip set every
 * canonical digest producer must use (#4392). `canonicalize` below and the
 * streamed `canonicalDigest` (#4532) hash the same values through different
 * code paths; two hand-maintained skip lists drifted apart once already, which
 * is what makes a golden-corpus pin and a shadow parity check read two
 * different canonical forms of the same session. Import this table instead of
 * re-listing the keys.
 *
 * - `storageMode` — last-writer provenance (#2671): the corpus pins predate
 *   the stamp and a re-save legitimately (re)writes it; unlike biliVersion its
 *   PRESENCE is new, so masking the value like __VER__ cannot keep old pins
 *   green — the key is removed from digests altogether.
 * - `tailGaps` — read-time gap-count metadata added by loadLegacyView (#4390);
 *   the live legacy leg of any parity comparison structurally lacks the key,
 *   so digesting its presence would report drift on every sampled save. Same
 *   class as storageMode: the PRESENCE, not the value, is the problem. A
 *   genuinely missing row still diverges the message arrays themselves.
 */
export const DIGEST_SKIPPED_KEYS: Readonly<Record<string, true>> = { storageMode: true, tailGaps: true };

function canonicalizeWithContext(value: unknown, key: string | undefined): unknown {
    if (Array.isArray(value)) return value.map((v) => canonicalizeWithContext(v, undefined));
    if (value instanceof Map) return { __map__: [...value.entries()].map(([k, v]) => [k, canonicalizeWithContext(v, undefined)]) };
    if (value instanceof Set) return { __set__: [...value.values()].map((v) => canonicalizeWithContext(v, undefined)) };
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        const record = value as Record<string, unknown>;
        // Sorted keys per the #4392 rule in this file's header — see there for
        // why insertion order cannot be part of the contract.
        for (const k of Object.keys(record).sort()) {
            const v = record[k];
            // One skip table for every digest producer (#4392): see
            // DIGEST_SKIPPED_KEYS for why presence, not value, is the problem.
            // hasOwn, not `in` — a "__proto__" key must not read as skipped.
            if (Object.hasOwn(DIGEST_SKIPPED_KEYS, k)) continue;
            out[k] = canonicalizeWithContext(v, k);
        }
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
