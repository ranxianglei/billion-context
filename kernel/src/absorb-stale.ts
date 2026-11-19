import { activeBlocks } from "./state.js";
import type { Config, CompressionState, CoreMessage } from "./types.js";
import { computeProtectedRefs } from "./recommend.js";
import { buildPairMap } from "./unit-projection.js";

export interface AbsorptionReport {
  blockId: string;
  /** Refs (display ids) of the messages absorbed into the block. */
  refs: string[];
}

/**
 * Fold-residue self-heal (companion of CompressionBlock.excludedMessageIds).
 *
 * A message that falls inside a fold's requested range but is excluded by
 * the protected-zone carve (recent-N / last-user anchor) stays visible
 * OUTSIDE the block's coverage — correct at fold time, it must be re-target
 * protected. But the moment the last-user anchor moves on, such a message
 * can never be folded again by any ordinary path: it is small
 * (sub-threshold), it is surrounded by covered blocks on both sides (a
 * sub-threshold segment bounded by coverage gaps is never offered — the
 * nudge must not be stretched across a gap), and the fold receipt already
 * told the model off from targeting it. It orphans on the wire forever.
 *
 * This closes the loop: every turn, each block's recorded exclusions are
 * re-tested against the CURRENT protected zone, and every id that has left
 * it is absorbed into the block's effective coverage. Absorption is
 * id-append only, so the summary's fidelity is unaffected (the excluded
 * message was quoted into the summary at fold time — see the
 * "User (mNNNNN, visible)" marker — or stays decompress-restorable).
 *
 * Per-id admission:
 *  - the id must still exist in the current view (a re-minted / dropped
 *    id is retried next turn; it is simply not absorbable right now);
 *  - its ref must exist, be non-BLOCKED, and be OUTSIDE the current
 *    protected zone — absorbing a message the client still protects would
 *    hide it mid-zone;
 *  - for tool-call/tool-result cores, the paired half must already be in
 *    the block's coverage or co-absorbed in this same pass (absorbing one
 *    half of a live pair would strand the other exactly like #684); a
 *    rejected half stays on the pending list and is retried next turn.
 *
 * When any id is absorbed the block's startSeq/endSeq ledger-interval claim
 * is invalidated (#4316 layer 3): the recorded interval described the
 * ORIGINAL coverage, and the absorbed id extends the claim — the id path
 * stays authoritative from here on.
 *
 * Mutates the given blocks in place (processTurn runs this on the live
 * state copy right after the pipeline, before it is returned/persisted).
 * Returns one report per block that absorbed anything.
 */
export function absorbStaleExclusions(
  state: CompressionState,
  messages: CoreMessage[],
  config: Config,
  countTokens: (text: string) => number,
): AbsorptionReport[] {
  const candidates = activeBlocks(state).filter(
    (block) => (block.excludedMessageIds?.length ?? 0) > 0,
  );
  if (candidates.length === 0) return [];
  const indexById = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) indexById.set(messages[i]!.id, i);
  const protectedRefs = computeProtectedRefs(
    messages,
    state,
    config,
    countTokens,
  );
  const pairByCallId = buildPairMap(messages);
  const reports: AbsorptionReport[] = [];
  for (const block of candidates) {
    const covered = new Set(block.effectiveMessageIds);
    // Phase 1: zone + presence screen.
    const absorbable: CoreMessage[] = [];
    const pendingRefs: string[] = [];
    const keep: string[] = [];
    for (const id of block.excludedMessageIds ?? []) {
      const at = indexById.get(id);
      if (at === undefined) {
        keep.push(id);
        continue;
      }
      const ref = state.messageRefs.byRaw[id];
      if (ref === undefined || ref === "BLOCKED" || protectedRefs.has(ref)) {
        keep.push(id);
        continue;
      }
      absorbable.push(messages[at]!);
      pendingRefs.push(ref);
    }
    // Phase 2: pair-integrity — both halves of a tool exchange must end up
    // covered by this block (already covered, or both absorbed here).
    const absorbSet = new Set<string>();
    for (const m of absorbable) absorbSet.add(m.id);
    const admitted: Array<{ message: CoreMessage; ref: string }> = [];
    const pairRejected: string[] = [];
    for (let i = 0; i < absorbable.length; i++) {
      const m = absorbable[i]!;
      let ok = true;
      if (
        m.contentType === "tool-call" ||
        m.contentType === "tool-result"
      ) {
        const pair = pairByCallId.get(m.toolCallId ?? m.id);
        if (pair) {
          for (const half of pair) {
            if (
              half !== "" &&
              half !== m.id &&
              !covered.has(half) &&
              !absorbSet.has(half)
            ) {
              ok = false;
              break;
            }
          }
        }
      }
      if (ok) {
        admitted.push({ message: m, ref: pendingRefs[i]! });
      } else {
        pairRejected.push(m.id);
      }
    }
    if (admitted.length === 0) continue;
    for (const a of admitted) {
      block.effectiveMessageIds.push(a.message.id);
    }
    // The ledger interval described the original coverage; the append
    // breaks its exactness — drop the claim, the id path is authoritative.
    block.startSeq = undefined;
    block.endSeq = undefined;
    // Phase-2 rejects stay pending (retried next turn) — merging them into
    // keep preserves the original order and never drops a pending id.
    const pendingAfter = new Set([...keep, ...pairRejected]);
    const keptAfter = (block.excludedMessageIds ?? []).filter((id) =>
      pendingAfter.has(id),
    );
    if (keptAfter.length > 0) block.excludedMessageIds = keptAfter;
    else delete block.excludedMessageIds;
    reports.push({ blockId: block.blockId, refs: admitted.map((a) => a.ref) });
  }
  return reports;
}
