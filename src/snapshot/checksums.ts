/**
 * #5874 — snapshot-plane checksums (canon digests).
 *
 * Pure, dependency-light. Every checksum in the plane is a lowercase
 * hex sha256 so the values are grep-able across the audit stream and the
 * storage layer (stored verbatim in l1_world / fold_journal /
 * egress_snapshot input hashes).
 */
import { createHash } from "node:crypto";

/** Lowercase-hex sha256 of a UTF-8 string. */
function sha256hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical JSON for checksum inputs: sorted-object-key, no whitespace. This
 *  is the ONLY serialization the foundation checksums over, so a key-order
 *  shuffle (JSON.stringify non-determinism, client churn) cannot move a
 *  checksum. */
export function canonicalJson(value: unknown): string {
    return stableStringify(value);
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        if (typeof value === "string") return JSON.stringify(value);
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
    }
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const k of keys) {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) continue;
        parts.push(JSON.stringify(k) + ":" + stableStringify(v));
    }
    return "{" + parts.join(",") + "}";
}

/** sha256 of the canonical envelope JSON (the L1 world's fast-mismatch
 *  sentinel, §4.0.1). */
export function envelopeChecksum(envelope: readonly string[]): string {
    return sha256hex(canonicalJson(Array.from(envelope)));
}
