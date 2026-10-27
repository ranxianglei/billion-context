// #2938 Tier 1 — host-stable tool-unit id side channel (ingress half).
//
// Plugin lanes (dsh first) can carry the host's OWN stable identifiers for
// every tool unit — each tool-call block AND each tool-result block, in
// transcript order — in a private top-level body field alongside each model
// request. The proxy strips the field before ANY prepare runs (it must never
// reach an upstream), cross-checks its length against the wire-neutral
// tool-unit count of the same body, and keeps the list on the session so fold
// reconciliation can claim churned covered ids by exact host-id equality
// instead of content heuristics (#2396 family; owner rule 2026-10-12: order
// + self-minted id are first-class, content hash is a guardrail).
//
// Trust boundary: consumed ONLY under the x-bili-plugin marker header (same
// gate as every other x-bili-plugin-* value). Absent ⇒ legacy behavior, zero
// cost. Malformed or miscounted ⇒ channel rejected for THIS request (honest
// degrade — never worse than no channel). The k-th entry aligns to the k-th
// tool unit in transcript order (calls in their assistant message's order,
// results when encountered) — the same walk the wire-neutral projection uses.

import { neutralTurns } from "./affinity-neutral.js";

/** Private protocol field; underscore-prefixed like other bili internals. */
export const HOSTID_BODY_FIELD = "_bili_toolcall_ids";
/** Hard cap: 5k tool rounds × (call + result). Bounds memory for hostile input. */
export const HOSTID_MAX_UNITS = 10_000;

interface HostIdDecision {
    /** Validated list ready for session storage (undefined = not consumed). */
    list?: string[];
    /** Field was present and removed from parsed — true even when not consumed. */
    stripped: boolean;
    /** Why the field was not consumed (absent ⇒ neither flag set). */
    rejected?: "no-marker" | "malformed" | "miscount";
}

/** Count tool units (tool-call blocks + tool-result blocks, transcript order)
 *  over a RAW wire message array using the shared wire-neutral projection —
 *  the same single source of protocol-shape knowledge #2939 and session-resolve
 *  run. Null when the array is not a recognizable message list. */
export function countToolUnits(messages: unknown[]): number {
    let n = 0;
    for (const t of neutralTurns(messages)) {
        if (t.kind === "tool") n += 1;
        n += t.calls?.length ?? 0;
    }
    return n;
}

/** Extract the side-channel field from the parsed inbound body per protocol
 *  (responses carries items under `input`, google under `contents`, the rest
 *  under `messages`). Returns null when no recognizable array is present —
 *  the caller then rejects the channel rather than trusting it unchecked. */
function toolUnitCountFor(protocol: string, parsed: Record<string, unknown>): number | null {
    let messages: unknown[] | null = null;
    if (protocol === "responses") messages = Array.isArray(parsed.input) ? (parsed.input as unknown[]) : null;
    else if (protocol === "google") messages = Array.isArray(parsed.contents) ? (parsed.contents as unknown[]) : null;
    else messages = Array.isArray(parsed.messages) ? (parsed.messages as unknown[]) : null;
    return messages ? countToolUnits(messages) : null;
}

/** Consume the side channel from a parsed inbound body. REMOVES the field
 *  whenever it is present — marker or not: it is bili's reserved namespace and
 *  must never ride upstream on ANY path (prepare paths re-serialize the same
 *  object, so an un-stripped foreign value would leak to the provider). Only
 *  CONSUMPTION (validation + list return) is marker-gated. Pure w.r.t. policy:
 *  all decisions land in the returned record so the matrix is testable without HTTP. */
export function consumeHostIdChannel(
    parsed: Record<string, unknown>,
    opts: { pluginMarker: boolean; protocol: string },
): HostIdDecision {
    if (!(HOSTID_BODY_FIELD in parsed)) return { stripped: false };
    const raw = parsed[HOSTID_BODY_FIELD];
    delete parsed[HOSTID_BODY_FIELD];
    if (!opts.pluginMarker) return { stripped: true, rejected: "no-marker" };
    // Empty is well-formed: a tool-free conversation may legitimately carry
    // [] (the count check below then requires zero counted units).
    const wellFormed = Array.isArray(raw)
        && raw.length <= HOSTID_MAX_UNITS
        && raw.every((v) => typeof v === "string" && v.length > 0);
    if (!wellFormed) return { stripped: true, rejected: "malformed" };
    const expected = toolUnitCountFor(opts.protocol, parsed);
    if (expected === null || expected !== raw.length) {
        return { stripped: true, rejected: "miscount" };
    }
    return { stripped: true, list: raw as string[] };
}

/** Persistent join-table cap (derived raw id → host id). Bounded by a
 *  session's tool-unit history; overflow clears the whole map — the claim pass
 *  degrades to legacy heuristics until entries re-accumulate (the plugin
 *  re-stamps every request, so recovery is at most one request away). */
export const HOSTID_BINDINGS_CAP = 50_000;

/** Zip a validated channel list onto a PREPARED transcript's tool units:
 *  returns newRawId → hostId for every message carrying a non-empty
 *  toolCallId, in array order. Undefined when the walk count differs from the
 *  list length — a representation misalignment between the two walks must
 *  degrade honestly, never guess (misattribution is the most expensive
 *  failure, MESSAGE-IDENTITY.md). Pure; persistence is the caller's job. */
export function zipHostUnits(
    messages: readonly { id?: string; toolCallId?: string }[],
    hostIds: string[],
): Map<string, string> | undefined {
    const unitIds: string[] = [];
    for (const m of messages) {
        if (m.id !== undefined && m.toolCallId !== undefined && m.toolCallId !== "") unitIds.push(m.id);
    }
    if (unitIds.length !== hostIds.length) return undefined;
    const seen = new Set<string>();
    for (const h of hostIds) {
        if (seen.has(h)) return undefined; // a host that repeats an id breaks k-th alignment — degrade
        seen.add(h);
    }
    const out = new Map<string, string>();
    for (let i = 0; i < unitIds.length; i++) out.set(unitIds[i]!, hostIds[i]!);
    return out;
}
