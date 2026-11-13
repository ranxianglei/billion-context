/**
 * #5874 — snapshot-table compression foundation: checksums (S4 + canon).
 *
 * Pure, dependency-light. Every checksum in the foundation is a lowercase
 * hex sha256 so the values are grep-able across the audit stream and the
 * storage layer (they are stored verbatim in snap_rows / snap_ckpt /
 * l1_world). The S4 per-row aggregate is the red-line invariant (iii): a
 * mismatch means the base material is corrupt and the sid plane is PERMANENTLY
 * dead (R1).
 */
import { createHash } from "node:crypto";

/** Lowercase-hex sha256 of a UTF-8 string. */
export function sha256hex(text: string): string {
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

/** sha256 of one row's post form (S4 unit). The post form is the common-core
 *  JSON; checksumming the canonical form keeps it byte-churn-proof. */
export function rowPostChecksum(postJson: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(postJson);
    } catch {
        // A non-JSON post form is itself a fault — checksum the raw bytes so
        // the mismatch is still detected (and grep-able) rather than masked.
        return sha256hex(postJson);
    }
    return sha256hex(canonicalJson(parsed));
}

/** The S4 AGGREGATE over a set of active rows (the ckpt meta's third piece).
 *  Order-stable: rows are folded in pos order, and each row contributes its
 *  pos + post checksum, so any single-row corruption moves the aggregate. */
export function s4Aggregate(
    rows: Array<{ pos: number; postJson: string }>,
): string {
    const ordered = [...rows].sort((a, b) => a.pos - b.pos);
    const material = ordered
        .map((r) => `${r.pos}:${rowPostChecksum(r.postJson)}`)
        .join("\n");
    return sha256hex(material);
}

/** sha256 of the serialized kernel state (the ckpt meta's first-piece
 *  self-checksum). */
export function stateChecksum(kernelState: Record<string, unknown>): string {
    return sha256hex(canonicalJson(kernelState));
}
