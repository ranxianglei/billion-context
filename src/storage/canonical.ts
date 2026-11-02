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
    return canonicalScalar(value, key);
}

function canonicalScalar(value: unknown, key: string | undefined): unknown {
    if (key === "biliVersion" && typeof value === "string") return "__VER__";
    if (typeof value === "number" && Number.isFinite(value) && value > 1_600_000_000_000) return "__TS__";
    if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "__UUID__";
    return value;
}

// Spec array index: "0" .. 2^32-2, no leading zeros.
function isArrayIndexKey(k: string): boolean {
    return /^(0|[1-9]\d*)$/.test(k) && Number(k) <= 4_294_967_294;
}

export function sha256(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Hash a storage view without materializing its canonical copy or JSON string. */
export function canonicalDigest(value: unknown): string {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return sha256(JSON.stringify(value));
    const hash = createHash("sha256");
    const chunkSize = 64 * 1024;
    let pending = "";
    function write(text: string): void {
        pending += text;
        if (pending.length >= chunkSize) {
            hash.update(pending, "utf8");
            pending = "";
        }
    }
    function writeString(text: string): void {
        write('"');
        for (let start = 0; start < text.length;) {
            let end = Math.min(start + chunkSize, text.length);
            const last = text.charCodeAt(end - 1);
            // Keep a surrogate pair together so JSON escaping and UTF-8 stay exact.
            if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
            write(JSON.stringify(text.slice(start, end)).slice(1, -1));
            start = end;
        }
        write('"');
    }
    function visit(current: unknown, key?: string): void {
        if (Array.isArray(current)) {
            write("[");
            for (let i = 0; i < current.length; i++) {
                if (i) write(",");
                visit(current[i]);
            }
            write("]");
        } else if (current instanceof Map) {
            write('{"__map__":[');
            let separator = "";
            for (const [k, v] of current) {
                write(separator + "[");
                // canonicalize leaves Map keys untouched.
                write(JSON.stringify(k) ?? "null");
                write(",");
                visit(v);
                write("]");
                separator = ",";
            }
            write("]}");
        } else if (current instanceof Set) {
            write('{"__set__":[');
            let separator = "";
            for (const v of current) {
                write(separator);
                visit(v);
                separator = ",";
            }
            write("]}");
        } else if (current && typeof current === "object") {
            write("{");
            let separator = "";
            // Effective order of JSON.stringify(canonicalize(v)): array-index keys
            // first, ascending numeric (spec enumeration overrides canonicalize's
            // lexicographic sort), then the remaining keys lexicographic.
            const keys = Object.keys(current);
            const orderedKeys = keys.filter(isArrayIndexKey).sort((a, b) => Number(a) - Number(b))
                .concat(keys.filter((k) => !isArrayIndexKey(k)).sort());
            for (const k of orderedKeys) {
                // Assigning __proto__ to canonicalize's plain output creates no JSON property.
                if (Object.hasOwn(DIGEST_SKIPPED_KEYS, k) || k === "__proto__") continue;
                const v = (current as Record<string, unknown>)[k];
                if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
                write(separator);
                writeString(k);
                write(":");
                visit(v, k);
                separator = ",";
            }
            write("}");
        } else {
            const normalized = canonicalScalar(current, key);
            if (typeof normalized === "string") writeString(normalized);
            else write(JSON.stringify(normalized) ?? "null");
        }
    }
    visit(value);
    hash.update(pending, "utf8");
    return hash.digest("hex");
}
