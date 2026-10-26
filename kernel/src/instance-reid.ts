import { baseIdOf } from "./prune.js";
import { coveredMessageIds } from "./state.js";
import type { CompressionState, CoreMessage } from "./types.js";

// deriveMessageId mints "h_" + 16 lowercase hex, optionally with a within-pass
// cluster suffix "_<n>" and/or a sub-id projection "#<tail>". These are the only
// ids that collide across turns; reserved ids (acp_summary_*, retrieved_*, host
// ids) never do and are left untouched.
const CONTENT_HASH_ROOT = /^h_([0-9a-f]{16})(?:_\d+)?(?:#.*)?$/;

function clusterRoot(id: string): string | null {
  const m = CONTENT_HASH_ROOT.exec(id);
  return m ? `h_${m[1]}` : null;
}

/**
 * Re-mint live messages whose id collides with an already-FOLDED copy of the same
 * content (billion-context #1476), WITHOUT un-covering the folded originals' own
 * resends (#462). Runs as the FIRST pipeline node, before assign-refs and prune,
 * so the re-minted id is what gets ref'd and what prune sees.
 *
 * Two byte-identical shapes carry an exact-covered id and must be told apart:
 *
 * - the folded original's ECHO: stateless hosts resend the full raw history
 *   every turn, so the original re-derives exactly the covered bare id. It was
 *   present in the previous pass's inbound (`state.lastPassIds`) and must KEEP
 *   its id — prune then drops it (it is already summarized) and the first-user
 *   pin keeps a stable ref. Renumbering it (#459) minted a fresh ref and, worse,
 *   made it escape prune's covered check (baseIdOf strips only "#tail", not
 *   "_n"), so folded content rejoined the wire beside its summary every turn.
 * - a genuinely NEW identical instance: absent from the previous pass, present
 *   now. Renumber it to the first "_k" no folded copy claims so assign-refs
 *   mints a distinct ref and prune keeps it (#1476's starvation fix).
 *
 * Ids that are not exactly covered (converter-numbered "_1" second-occurrence
 * forms of a covered root, non-h_ ids, roots without a covered copy) keep the
 * converter's numbering untouched — renumbering those would only churn the
 * prefix cache.
 *
 * INACTIVE blocks (#2695): their covered ids join the dodge set, because a
 * genuinely new instance landing on a dead block's number resurrects the
 * block in sync ("some covered id present") and its summary carrier starts
 * rendering — for content the instance was never part of. Renumbering
 * against a dead block is gated by cluster-root continuity: only when some
 * sibling of the same root was live last pass (the arriving instance is a
 * NEW extension of a continuing cluster). A block that is inactive at
 * pipeline start cannot itself have any covered id in `prior` (sync would
 * have kept it alive otherwise), so "inactive-covered collision + sibling
 * in prior" is exactly the new-extension-onto-dead-block shape. A
 * whole-root arrival that is new to `prior` — a client rewinding to a
 * checkpoint that still holds the folded originals — keeps the converter's
 * ids and the block legitimately resurrects (carrier + prune, the #462
 * economy restored).
 */
export function remintCoveredLiveIds(
  messages: CoreMessage[],
  state: CompressionState,
): CoreMessage[] {
  const coveredBases = new Set<string>();
  for (const id of coveredMessageIds(state)) coveredBases.add(baseIdOf(id));
  const inactiveBases = new Set<string>();
  for (const block of state.blocks) {
    if (block.active) continue;
    for (const id of block.effectiveMessageIds) {
      inactiveBases.add(baseIdOf(id));
    }
  }
  if (coveredBases.size === 0 && inactiveBases.size === 0) return messages;
  // Pre-feature persisted state has no prior-pass snapshot: fall back to
  // renumber-nothing (0.0.95 semantics) for this one pass. The snapshot is
  // written below in processTurn, so the next pass discriminates correctly.
  if (!state.lastPassIds) return messages;
  const prior = new Set(state.lastPassIds);

  const groups = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const root = clusterRoot(messages[i]!.id);
    if (root === null) continue;
    const idxs = groups.get(root);
    if (idxs) idxs.push(i);
    else groups.set(root, [i]);
  }

  const next = [...messages];
  let changed = false;
  for (const [root, idxs] of groups) {
    // Only renumber when some live instance claims an id a folded copy owns
    // (active or inactive); otherwise the converter's numbering is already
    // collision-free here.
    const conflict = idxs.some(
      (i) =>
        coveredBases.has(baseIdOf(messages[i]!.id)) ||
        inactiveBases.has(baseIdOf(messages[i]!.id)),
    );
    if (!conflict) continue;
    // #2695: an inactive block's covered id is only renumbered away when the
    // same root shows prior-pass continuity (see header) — a whole-root
    // rewind keeps its ids so the block can resurrect.
    const rootContinues = idxs.some((i) => prior.has(messages[i]!.id));
    // Renumbered ids must dodge both folded-claimed numbers and ids other
    // live instances of this root already hold (untouched ones keep theirs).
    const liveIds = new Set(idxs.map((i) => baseIdOf(messages[i]!.id)));
    let k = 1;
    for (const i of idxs) {
      const id = messages[i]!.id;
      const exactCovered = coveredBases.has(baseIdOf(id));
      const exactCoveredInactive = inactiveBases.has(baseIdOf(id));
      // Only a genuinely new instance is renumbered: its exact id is claimed
      // by a folded copy AND it was absent from the previous pass. Everything
      // else — the folded original's own resend (prior.has), converter-numbered
      // "_n" forms that no folded copy claims, the live un-folded bare, and
      // (#2695) a whole-root rewind onto an inactive block — keeps the
      // converter's numbering; renumbering those would only churn the
      // prefix cache and let summarized content escape prune (#462).
      if (prior.has(id)) continue;
      if (!exactCovered && !(exactCoveredInactive && rootContinues)) continue;
      while (
        coveredBases.has(`${root}_${k}`) ||
        inactiveBases.has(`${root}_${k}`) ||
        liveIds.has(`${root}_${k}`) ||
        prior.has(`${root}_${k}`)
      )
        k++;
      const hash = id.indexOf("#");
      const tail = hash > 0 ? id.slice(hash) : "";
      const minted = `${root}_${k}${tail}`;
      liveIds.add(baseIdOf(minted));
      next[i] = { ...messages[i]!, id: minted };
      k++;
      changed = true;
    }
  }
  return changed ? next : messages;
}
