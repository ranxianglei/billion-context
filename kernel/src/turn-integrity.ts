import type { CoreMessage } from "./types.js";

function isAssistantAct(msg: CoreMessage): boolean {
  return (
    msg.role === "assistant" &&
    (msg.contentType === "text" || msg.contentType === "tool-call")
  );
}

/**
 * Atomic turn groups for compression integrity (#684).
 *
 * A turn is a reasoning run, the assistant text/tool-call burst that follows
 * it, and every tool-result paired (by toolCallId) to the burst's calls.
 * Strict-echo thinking providers (DeepSeek: "The `reasoning_content` in the
 * thinking mode must be passed back to the API") reject a rebuilt request
 * whose assistant tool-call turn survives without its reasoning, and every
 * OpenAI-wire provider rejects a result whose call is gone. Turns are
 * therefore atomic for folding: all members fold together, or none do.
 *
 * Grouping is adjacency-based, mirroring {@link adjustBoundariesForReasoningPairs}:
 * a reasoning run pairs with the assistant burst immediately following it.
 * Bursts without a preceding reasoning run still group with their sibling
 * calls and results. Messages belonging to no turn (user messages, system,
 * orphan reasoning, summaries) get no group — they carry no pairing
 * constraint. Groups are disjoint.
 *
 * @returns disjoint member-id arrays; a message appears in at most one group.
 */
export function computeTurnGroups(messages: CoreMessage[]): string[][] {
  const resultIdByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (
      msg.contentType === "tool-result" &&
      typeof msg.toolCallId === "string" &&
      msg.id
    ) {
      if (!resultIdByCallId.has(msg.toolCallId))
        resultIdByCallId.set(msg.toolCallId, msg.id);
    }
  }

  const grouped = new Set<string>();
  const groups: string[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!msg.id || grouped.has(msg.id)) continue;
    if (!(msg.contentType === "reasoning" || isAssistantAct(msg))) continue;

    let reasoningStart = i;
    if (msg.contentType === "reasoning") {
      while (
        reasoningStart > 0 &&
        messages[reasoningStart - 1]!.contentType === "reasoning"
      ) {
        reasoningStart--;
      }
    } else {
      let s = i;
      while (s > 0 && isAssistantAct(messages[s - 1]!)) s--;
      reasoningStart = s;
      while (
        reasoningStart > 0 &&
        messages[reasoningStart - 1]!.contentType === "reasoning"
      ) {
        reasoningStart--;
      }
    }
    const burstStart = (() => {
      let s = reasoningStart;
      while (s < messages.length && messages[s]!.contentType === "reasoning")
        s++;
      return s;
    })();
    if (
      burstStart >= messages.length ||
      !isAssistantAct(messages[burstStart]!)
    ) {
      // Orphan reasoning run (no companion burst): no pairing constraint.
      continue;
    }
    let burstEnd = burstStart;
    while (
      burstEnd + 1 < messages.length &&
      isAssistantAct(messages[burstEnd + 1]!)
    ) {
      burstEnd++;
    }

    const members = new Set<string>();
    for (let k = reasoningStart; k <= burstEnd; k++) {
      const m = messages[k]!;
      if (!m.id) continue;
      members.add(m.id);
      if (
        m.role === "assistant" &&
        m.contentType === "tool-call" &&
        typeof m.toolCallId === "string"
      ) {
        const rid = resultIdByCallId.get(m.toolCallId);
        if (rid) members.add(rid);
      }
    }
    for (const id of members) grouped.add(id);
    groups.push([...members]);
  }
  return groups;
}

/** Which folded ids the rebuild cannot keep folded, and how many turns and
 *  call/result pairs that covers. */
export interface IntegrityWithdrawals {
  withdrawn: Set<string>;
  splitTurnCount: number;
  splitPairCount: number;
}

/**
 * Fold-integrity gate (#684): given the ids a fold removes from the visible
 * stream, return the ids that must stay visible instead.
 *
 *   - INV1 — a kept assistant tool-call must keep its reasoning run, so a turn
 *     whose reasoning folds while a call of the same turn stays visible is
 *     withdrawn wholesale (all members stay visible).
 *   - INV2 — a tool-call and its tool-result are one exchange: a pair the fold
 *     would split is withdrawn together.
 *
 * The two invariants feed each other. Withdrawing a call for INV2 leaves a turn
 * whose reasoning still folds while its call now stays visible — exactly the
 * INV1 split — and withdrawing a turn for INV1 can strand a result whose call
 * survived outside the turn. One pass in a fixed order misses both, so the gate
 * repeats until nothing changes; a turn or pair is acted on once and reported
 * once.
 *
 * The reverse direction stays allowed (#564): reasoning and text may stay
 * visible while the call and its result fold, since that leaves a valid stream.
 */
export function computeIntegrityWithdrawals(
  messages: CoreMessage[],
  foldedIds: ReadonlySet<string>,
): IntegrityWithdrawals {
  const remaining = new Set(foldedIds);
  const withdrawn = new Set<string>();
  const handledTurns = new Set<number>();
  const handledPairs = new Set<string>();

  const reasoningIds = new Set<string>();
  const callIds = new Set<string>();
  const callIdByMessageId = new Map<string, string>();
  const resultIdByCallId = new Map<string, string>();
  for (const m of messages) {
    if (!m.id) continue;
    if (m.contentType === "reasoning") reasoningIds.add(m.id);
    if (m.role === "assistant" && m.contentType === "tool-call") {
      callIds.add(m.id);
      if (typeof m.toolCallId === "string") {
        callIdByMessageId.set(m.id, m.toolCallId);
      }
    }
    if (m.contentType === "tool-result" && typeof m.toolCallId === "string") {
      if (!resultIdByCallId.has(m.toolCallId)) {
        resultIdByCallId.set(m.toolCallId, m.id);
      }
    }
  }

  const groups = computeTurnGroups(messages);
  let changed = true;
  while (changed) {
    changed = false;

    for (let g = 0; g < groups.length; g++) {
      if (handledTurns.has(g)) continue;
      const group = groups[g]!;
      const foldHasReasoning = group.some(
        (id) => remaining.has(id) && reasoningIds.has(id),
      );
      if (!foldHasReasoning) continue;
      const keptHasCall = group.some(
        (id) => !remaining.has(id) && callIds.has(id),
      );
      if (!keptHasCall) continue;
      handledTurns.add(g);
      for (const id of group) {
        remaining.delete(id);
        withdrawn.add(id);
      }
      changed = true;
    }

    for (const m of messages) {
      if (!m.id || !callIds.has(m.id)) continue;
      const callId = callIdByMessageId.get(m.id);
      if (callId === undefined || handledPairs.has(callId)) continue;
      const resultId = resultIdByCallId.get(callId);
      if (resultId === undefined) continue;
      if (remaining.has(m.id) === remaining.has(resultId)) continue;
      handledPairs.add(callId);
      remaining.delete(m.id);
      remaining.delete(resultId);
      withdrawn.add(m.id);
      withdrawn.add(resultId);
      changed = true;
    }
  }

  return {
    withdrawn,
    splitTurnCount: handledTurns.size,
    splitPairCount: handledPairs.size,
  };
}
