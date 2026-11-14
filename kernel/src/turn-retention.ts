import type { Config, CompressionState, CoreMessage } from "./types.js";
import { coveredMessageIds } from "./state.js";
import { SUMMARY_HEADER } from "./prune.js";

/**
 * #4593: per-turn retention ("the last N turns stay verbatim").
 *
 * A turn boundary is a VISIBLE user message: role "user", not a summary
 * carrier, not already covered by an active block. Consecutive user messages
 * (raw adjacency) count as ONE boundary — hosts batch runtime-context
 * snapshots next to the instruction. The retention window is the suffix of
 * the messages array starting AT the (N+1)-th-from-last boundary:
 * the last N turns AND everything between them (tool calls/results, assistant
 * replies) stay protected together — the window always STARTS on a user
 * message (a clean turn boundary), never mid-turn. Fewer than N+1 boundaries
 * ⇒ the whole conversation is inside the window (boundaryIndex 0).
 *
 * POSITIONAL by design: the window slides forward with every new user
 * message, so it cannot ride the permanent BLOCKED-ref identity decision
 * (an aged-out message would stay blocked forever, or force per-turn
 * BLOCKED→numeric migration = prefix-cache churn). It recomputes every turn:
 * computeProtectedRefs unions the refs into the soft-protection set, and
 * projectUnit enforces it in two tiers — a submitted range PARTIALLY
 * overlapping the window is carved there (auditable receipt warning naming
 * the turn zone), while a range ENTIRELY inside it is rejected (the range is
 * explicit user intent aimed at protected content).
 */

export interface TurnRetention {
  /** Smallest messages-array index inside the retained suffix; everything at
   *  or after it is protected. 0 = the entire conversation is retained. */
  boundaryIndex: number;
  /** The effective (floored) N (for error wording). */
  turns: number;
}

export function computeTurnRetention(
  messages: CoreMessage[],
  state: CompressionState,
  config: Pick<Config, "preserveRecentTurns">,
): TurnRetention | null {
  const raw = config.preserveRecentTurns;
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return null;
  // The host floors at parse time (src/config.ts); the kernel must be
  // self-consistent for direct API users — a fractional N would otherwise
  // index boundaries[] fractionally and silently degrade to off.
  const turns = Math.floor(raw);
  const covered = coveredMessageIds(state);
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (m.text?.startsWith(SUMMARY_HEADER)) continue;
    if (covered.has(m.id)) continue;
    const prev = messages[i - 1];
    if (prev !== undefined && prev.role === "user") continue;
    boundaries.push(i);
  }
  if (boundaries.length < turns + 1) return { boundaryIndex: 0, turns };
  return { boundaryIndex: boundaries[boundaries.length - turns]!, turns };
}
