/**
 * #5874 — snapshot-table compression foundation: egress (stage 4).
 *
 * `mapEgress` reconstructs the outbound model view from the SNAPSHOT TABLE
 * (the server's single storage source of truth) instead of the client's
 * re-sent bytes:
 *
 *   egress view = (active rows' post cores, in pos order) ++ (this turn's NEW
 *                 tail cores, freshly parsed)
 *
 * The active rows already encode the post-rewrite state (a summary row for a
 * folded prefix, plain rows for the tail), so the prefix bytes come from the
 * table — stable across client byte churn (re-stamps, image re-encodes). That
 * is the goal function: prefix-cache byte stability is a STRUCTURAL
 * guarantee, not a side effect (§4.4). The fresh tail is appended, then the
 * whole view is mapped to the target wire protocol by coreToX.
 *
 * DESYNC (join chain broken / mismatch) is NOT handled here: the caller has
 * already degraded the whole turn to legacy (red gate) before egress. This
 * function assumes a green plane.
 */
import type { EgressInput, EgressOutput } from "./types.ts";

/** Reconstruct the flat egress view. `activeRows` are the post-rewrite cores
 *  (each postJson is a JSON array of common cores) in pos order; `tailCores`
 *  are the freshly-parsed cores for envelope elements not yet in the ledger
 *  (also in pos order). Returns the concatenated flat core array. */
export function buildEgressView(input: EgressInput): EgressOutput {
    const cores: unknown[] = [];
    let prefixCount = 0;
    for (const row of input.activeRows) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.postJson);
        } catch {
            // A corrupt post form must NOT be silently emitted — that would
            // poison the prefix cache. The caller's S4 gate (R1) is the
            // permanent kill; this is the last-line tripwire: throw so the
            // turn degrades rather than emitting garbage bytes.
            throw new Error(`snapshot egress: corrupt post form at pos ${row.pos}`);
        }
        if (!Array.isArray(parsed)) {
            throw new Error(`snapshot egress: post form at pos ${row.pos} is not an array`);
        }
        for (const c of parsed) {
            cores.push(c);
            prefixCount++;
        }
    }
    let tailCount = 0;
    for (const elem of input.tailCores) {
        for (const c of elem) {
            cores.push(c);
            tailCount++;
        }
    }
    return { cores, prefixCount, tailCount };
}
