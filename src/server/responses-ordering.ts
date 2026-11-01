/**
 * #564/#2627 producer-owned Responses ordering separators.
 *
 * `repairResponsesAssistantOrdering` inserts a synthetic user marker between
 * assistant runs that the Responses wire would otherwise reject. Because it is
 * outbound-only, the actual-wire invariant judge saw it as client prose "bolted
 * into the middle of history" and filed a `mid-insertion` finding on every
 * folded turn.
 *
 * The judge cannot recognise the marker by inspection: after serialization it
 * is `{type:"message",role:"user",content:"<literal>"}`, byte-identical to the
 * same sentence typed by a client, and `responsesToCore` re-derives core ids
 * from content, so the internal `acp_turn_sep_*` id never reaches the wire.
 *
 * The contract is identity in, index out:
 *
 *  1. THE PRODUCER MINTS IDENTITY. `repairResponsesAssistantOrdering`
 *     records, for each marker, the exact core it pushed AND the exact carrier it
 *     minted for the wire. Those two object identities are the only ownership
 *     record: neither the id prefix nor the separator text decides who owns what,
 *     so client-controlled look-alikes are never exempted.
 *  2. THE CODEC EMITS THAT CARRIER BY REFERENCE. The producer allocates the
 *     canonical wire item (`{type:"message",role:"user",content:<text>}`) and
 *     hangs it on the marker core's existing `rawResponsesItem` sidecar.
 *     `coreToResponses`' single-user-run branch pushes that sidecar object
 *     UNCHANGED when its display text matches the core text, and
 *     `patchResponsesInput`'s new-core insertion reaches the same code path, so
 *     the exact object the producer minted is the exact object on the wire. The
 *     body is built normally, ONCE; this module never renders it again.
 *  3. ONE LINEAR WALK MAPS IDENTITY TO INDEX. At the last index-mutating boundary
 *     before serialization, `resolveSeparatorIndexes` walks the FINAL array once,
 *     looks each item up in a `Map` keyed by carrier object identity, and records
 *     the index where its carrier was found. No codec call, no per-item
 *     serialization, no text/id/prefix matching, no layout guess.
 *  4. THE RELAY REVALIDATES. Bind those proven indexes to the already serialized
 *     immutable body string. A fresh parse may use them only when its source
 *     string equals that exact binding; any byte-changing rewrite fails closed.
 *     Canonical shape then validates the already-owned indexes, not ownership.
 *
 * Only indexes surviving all four steps are exempt in the judge; every other
 * element — including identical prose at any index — is judged normally. The
 * carrier-shape check is validation of a claim, never evidence of ownership.
 */

import type { BiliMessage, ResponseInputItem } from "acp-kernel/wire";
import { RESPONSES_TURN_SEPARATOR_ID_PREFIX } from "../turn-separator.js";
import { CoreMessage } from "acp-kernel";

/** The separator's wire text. One literal shared by the producer, the manifest
 *  and the judge; no other module re-exports it (#2627). */
export const RESPONSES_TURN_SEPARATOR = "[The exchange between these two assistant turns was compressed.]";

/**
 * One marker the producer actually inserted: the exact object identities that
 * make it ours.
 *
 * The carrier is the item the producer will put on the wire; the codec emits
 * that very object by reference (see `coreToResponses`' single-user-run branch,
 * which pushes the `rawResponsesItem` sidecar unchanged when its display text
 * matches). Ownership is therefore reference equality against the FINAL array,
 * never a text, id-prefix or position guess.
 */
export interface SeparatorSlot {
  /** The `acp_turn_sep_<n>` core id minted for this marker. */
  id: string;
  /** The core the producer pushed. */
  core: CoreMessage;
  /** The wire carrier carried on that core's `rawResponsesItem` sidecar — the
   *  exact object the codec emits. Reference identity is the ownership proof. */
  carrier: ResponseInputItem;
}

/**
 * Canonical serialized shape of a lone separator marker: `coreToResponses`
 * renders a single-user-core run to exactly `{type, role, content}` with a
 * plain string body. Requiring EXACTLY those three keys (and a non-empty string
 * body equal to `text`) means a client item carrying extra fields, or an array
 * content, is never mistaken for a carrier.
 */
export function isSeparatorCarrier(item: unknown, text: string = RESPONSES_TURN_SEPARATOR): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3) return false;
  return record["type"] === "message" && record["role"] === "user" && record["content"] === text;
}

/**
 * A marker confirmed to occupy `index` of the array being serialized.
 *
 * `index` is the FINAL wire index, produced by the single rendering pass in
 * `resolveSeparatorIndexes` — never by searching the array for a match.
 */
interface SeparatorClaim {
  id: string;
  index: number;
  /** The exact wire object the producer minted for this marker. Re-anchoring at
   *  a later boundary is reference equality against this object, never a shape
   *  or text match, so an identical client item can never inherit the claim. */
  carrier: ResponseInputItem;
}

export interface SeparatorManifest {
  /** The separator literal these claims were produced for. */
  text: string;
  /** Producer-owned wire indexes, ascending, in the array these were proven on. */
  claims: readonly SeparatorClaim[];
  /** Total outbound items when the manifest was taken. */
  length: number;
  /**
   * The EXACT serialized body these indexes were proven against.
   *
   * This is the provenance binding, and it is a reference to the caller's own
   * string — never a re-serialization. `JSON.parse` destroys object identity, so
   * a downstream judge re-parses the body and cannot see the producer's carriers;
   * string equality against this field is what proves the body it holds is
   * byte-for-byte the one the claims were derived from. Any byte-changing rewrite
   * (budget shedding, a re-serialize, a patched payload) mismatches and the claims
   * are dropped, which is the safe direction.
   */
  body: string;
}

// #564: folding + stripKernelSummaries can merge two assistant turns into one
// run, which Responses rejects (run order reasoning* -> message* ->
// function_call*, <=1 reasoning). Rebuild boundaries from the ORIGINAL history
// AFTER dedup: drop a reasoning whose turn body was wholly folded away (keep
// originally-reasoning-only turns), else separate the runs with a user marker.
//
// Markers are recorded in `slots` as they are inserted: that record is the only
// place their provenance exists. It is OUTBOUND-ONLY — no client history
// contains one, so `withoutTurnSeparators` strips them from any analysis pass
// screened against the apply view (#5139).
//
// Returns the repaired array and the markers minted while building it.
export function repairResponsesAssistantOrdering(
    folded: CoreMessage[],
    original: CoreMessage[],
): { messages: CoreMessage[]; slots: SeparatorSlot[] } {
    const runOf = new Map<string, number>();
    const runHasBody = new Map<number, boolean>();
    let run = 0;
    let inRun = false;
    for (const m of original) {
        if (m.role === "assistant") {
            if (!inRun) { run++; inRun = true; }
            runOf.set(m.id, run);
            if (m.contentType !== "reasoning") runHasBody.set(run, true);
        } else {
            inRun = false;
        }
    }
    const survivorCount = new Map<number, number>();
    for (const m of folded) {
        const r = m.role === "assistant" ? runOf.get(m.id) : undefined;
        if (r !== undefined) survivorCount.set(r, (survivorCount.get(r) ?? 0) + 1);
    }

    const out: CoreMessage[] = [];
    const slots: SeparatorSlot[] = [];
    let phase = -1;
    let seenReasoning = false;
    let sepSeq = 0;
    const pushSeparator = (): void => {
        sepSeq++;
        const id = `${RESPONSES_TURN_SEPARATOR_ID_PREFIX}${sepSeq}`;
        // The canonical carrier, allocated HERE so the producer — not the codec
        // and not a later reader — is the sole author of this object. It rides
        // the core's existing `rawResponsesItem` sidecar, which `coreToResponses`
        // (single-user-run branch) pushes unchanged once its display text matches
        // the core text, and which `patchResponsesInput` reaches through the same
        // code path for newly inserted cores.
        const carrier: ResponseInputItem = {
            type: "message",
            role: "user",
            content: RESPONSES_TURN_SEPARATOR,
        };
        const marker: BiliMessage = {
            id,
            role: "user",
            contentType: "text",
            text: RESPONSES_TURN_SEPARATOR,
            rawResponsesItem: carrier,
        };
        out.push(marker);
        // Record the marker's identities in the same statement sequence that
        // allocates them. No index is recorded here: the wire index is measured
        // against the final array at send time (see the module header).
        slots.push({ id, core: marker, carrier });
        phase = -1;
        seenReasoning = false;
    };
    for (const m of folded) {
        if (m.role !== "assistant") {
            out.push(m);
            phase = -1;
            seenReasoning = false;
            continue;
        }
        const kind = m.contentType === "reasoning" ? "reasoning" : m.contentType === "tool-call" ? "tool-call" : "message";
        const r = runOf.get(m.id);
        if (kind === "reasoning" && r !== undefined && runHasBody.get(r) && survivorCount.get(r) === 1) continue;
        if ((kind === "reasoning" && (phase > 0 || seenReasoning)) || (kind === "message" && phase === 2)) pushSeparator();
        out.push(m);
        if (kind === "reasoning") { phase = Math.max(phase, 0); seenReasoning = true; }
        else if (kind === "message") phase = Math.max(phase, 1);
        else phase = Math.max(phase, 2);
    }
    return { messages: out, slots };
}


/**
 * Ownership lookup: the exact carrier object the producer minted → its slot.
 *
 * Built once per body. `Map` keyed by object identity, so nothing about the
 * item's text, its role, an id prefix or its index can ever match.
 */
function carrierOwners(slots: readonly SeparatorSlot[] | null | undefined): Map<ResponseInputItem, SeparatorSlot> {
  const owners = new Map<ResponseInputItem, SeparatorSlot>();
  if (!Array.isArray(slots)) return owners;
  for (const slot of slots) owners.set(slot.carrier, slot);
  return owners;
}

/**
 * Index the producer's carriers in the FINAL wire array by one linear walk.
 *
 * This is the whole mapping: no codec call, no serialization, no comparison of
 * text or ids. The body was built normally, exactly once; the codec emitted each
 * marker's canonical carrier by reference, so a reference hit IS the proof of
 * provenance and its array position IS the wire index.
 *
 * Fail-closed: a carrier that is absent (dropped, replaced, or re-serialized into
 * a new object) produces no claim for that marker, and a claim is recorded only
 * when the item found at the index is still a canonical carrier. Claims are never
 * widened to a neighbour or shifted to compensate for an insertion.
 */
function resolveSeparatorIndexes(
  finalWire: readonly unknown[] | null | undefined,
  slots: readonly SeparatorSlot[] | null | undefined,
): SeparatorClaim[] {
  if (!Array.isArray(finalWire) || !Array.isArray(slots) || slots.length === 0) return [];
  const owners = carrierOwners(slots);
  if (owners.size === 0) return [];
  const claims: SeparatorClaim[] = [];
  for (let index = 0; index < finalWire.length; index++) {
    const slot = owners.get(finalWire[index] as ResponseInputItem);
    if (slot === undefined || !isSeparatorCarrier(finalWire[index])) continue;
    claims.push({ id: slot.id, index, carrier: slot.carrier });
    owners.delete(slot.carrier);
  }
  return claims;
}

/**
 * Build the manifest the judge consumes, bound to the serialized body.
 *
 * `finalWire` must be the array that becomes `body.input` and `body` the EXACT
 * string the caller is about to send (the one its own single `JSON.stringify`
 * produced — pass that reference, never re-serialize). The binding is what lets a
 * downstream judge, which can only re-parse the bytes, prove the claims belong to
 * the body it is holding: carriers cannot be recovered from a parse, but the body
 * string survives verbatim.
 *
 * `undefined` when this turn produced no marker, when no carrier is present in
 * `finalWire`, or when `body` is not a non-empty string — a marker whose binding
 * cannot be recorded is not exempted at all.
 */
export function collectSeparatorManifest(
  finalWire: readonly unknown[] | null | undefined,
  slots: readonly SeparatorSlot[] | null | undefined,
  body: string | null | undefined,
): SeparatorManifest | undefined {
  if (!Array.isArray(finalWire) || !Array.isArray(slots) || slots.length === 0) return undefined;
  if (typeof body !== "string" || body.length === 0) return undefined;
  const claims = resolveSeparatorIndexes(finalWire, slots);
  if (claims.length === 0) return undefined;
  return { text: RESPONSES_TURN_SEPARATOR, claims, length: finalWire.length, body };
}

/**
 * The wire indexes a manifest legitimately owns in the body being judged.
 *
 * Provenance here is BODY EQUALITY plus exact index: the caller passes the body
 * string it is about to send (or is parsing), and the claims survive only when
 * that string is byte-for-byte the one the claims were proven against. A rewrite
 * that changed a single byte — budget shedding, a re-serialize, a patched
 * payload — fails this test and no index is exempt.
 *
 * Because carriers cannot be recovered from a parse, the index is then validated
 * by the canonical carrier SHAPE at that exact position. That shape check is
 * validation of an already-proven claim, never evidence of ownership on its own:
 * the claim's existence is established by the body binding above, so identical
 * client text at any other index is not reached by this function at all.
 *
 * A non-string / unmatched body, a shorter array, or a missing carrier at a
 * claimed index drops that index; nothing is widened or shifted.
 */
export function separatorProvenanceSet(
  manifest: SeparatorManifest | undefined,
  wire: readonly unknown[] | null | undefined,
  body: string | null | undefined,
): ReadonlySet<number> {
  const owned = new Set<number>();
  if (!manifest || !Array.isArray(wire)) return owned;
  if (typeof body !== "string" || body.length === 0) return owned;
  if (body !== manifest.body) return owned;
  for (const claim of manifest.claims) {
    if (claim.index >= wire.length) continue;
    if (!isSeparatorCarrier(wire[claim.index], manifest.text)) continue;
    owned.add(claim.index);
  }
  return owned;
}

/**
 * Translate wire indexes into indexes of a core list parsed from the SAME wire.
 *
 * `responsesToCore` stamps every core it derives from an item with that item's
 * `wireIndex`, and a lone user message yields exactly one core, so the owned wire
 * index maps to the owned core deterministically. Cores without a `wireIndex`
 * (other wire protocols) never match, so non-Responses traffic is unaffected.
 */
export function separatorCoreProvenance(
  ownedWireIndexes: ReadonlySet<number>,
  cores: readonly CoreMessage[] | null | undefined,
): ReadonlySet<number> {
  const owned = new Set<number>();
  if (ownedWireIndexes.size === 0 || !Array.isArray(cores)) return owned;
  for (let index = 0; index < cores.length; index++) {
    const wireIndex = cores[index]!.wireIndex;
    if (wireIndex !== undefined && ownedWireIndexes.has(wireIndex)) owned.add(index);
  }
  return owned;
}

