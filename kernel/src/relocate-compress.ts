import { BLOCKED_REF } from "./refs.js";
import { refNum } from "./hide-consumed.js";
import type { CompressionState, CoreMessage } from "./types.js";

/** Opt-in view transform (experimental, default OFF — see Config.compressAtFoldPoint):
 *  move each still-visible compress carrier pair from its ORIGINAL position to
 *  the fold point.
 *
 * Why: the compress call/result pair is created at the TAIL of the live view at
 *  fold time and stays there (pi plugin mode persists it; the proxy loop re-rides
 *  ephemeral copies every round). For models with weak attention over long tails,
 *  a tool exchange sitting at the very end of resent history reads like a NEW
 *  command to execute — not as closed bookkeeping. Relocating the pair to sit
 *  directly after its own folded region ("[folded/summary region] – [compress
 *  pair] – [protected messages]") removes that ambiguity: the tail is clean, and
 *  the pair visibly belongs to the fold it documents.
 *
 * Invariants:
 *  - VIEW-ONLY + deterministic f(history, state): nothing is persisted, refs are
 *    untouched (assign-refs already ran; messageRefs is a persistent id→ref map),
 *    so the layout is recomputed identically on every turn — byte-stable from the
 *    second turn on, no incremental prefix-cache cost beyond the fold's own break.
 *  - Pair integrity: a pair moves only when BOTH cores are present, in order,
 *    adjacent, and unambiguous (exactly one tool-call core per active-block call
 *    id). Any anomaly → the pair stays where it is (the safe direction).
 *  - Boundary rule: insert before the first surviving core whose allocated ref is
 *    strictly greater than max(endRef) across the blocks this call created
 *    (multi-range batches → rightmost boundary); when none exists (fold reaches
 *    the window end, #4732 regime) append at the tail instead.
 *  - Thinking clear (second opt-in, default off, predicate-gated): the run of
 *    contiguous `reasoning` cores immediately preceding a moved call may be
 *    dropped IF opts.reasoningDroppable accepts each one. Without a predicate
 *    NOTHING is dropped — signed-thinking / strict-echo awareness lives in the
 *    host (it owns the wire signatures), and the conservative default here is
 *    "never drop". */
export interface RelocateOptions {
  /** Same contract as Config.isCompressTool: host dialect names count as a
   *  compress call. Unset = bare-name only. */
  isCompressTool?: (toolName: string) => boolean;
  /** Enable the #651-style reasoning drop around moved pairs. */
  clearThinking?: boolean;
  /** Host predicate deciding which reasoning cores may be dropped (signed
   *  thinking and strict-echo sessions must answer false). UNSET ⇒ no drop even
   *  with clearThinking set. Must be pure and cheap: runs once per candidate. */
  reasoningDroppable?: (msg: CoreMessage) => boolean;
}

export interface RelocateMove {
  callId: string;
  /** Index of the tool-call core in the input array. */
  callIndex: number;
  /** Survivor ordinal: emit before the k-th surviving (non-removed) input.
   *  k == total survivors ⇒ tail append (#4732 regime). */
  insertAtOutput: number;
  /** Input indices of dropped reasoning cores (adjacent run before the call). */
  droppedReasoningIndices: number[];
}

export interface RelocatePlan {
  moves: RelocateMove[];
  /** Input indices of ALL cores removed (pairs + dropped reasoning). */
  removedInputIndices: Set<number>;
  changed: boolean;
}

const bareIsCompressTool = (toolName: string | undefined): boolean =>
  toolName === "compress";

/** Compute the relocation plan for `messages` under `state`. Pure: same inputs
 *  always yield the same plan (host-side determinism requirement). */
export function planRelocateCompressCarriers(
  messages: CoreMessage[],
  state: CompressionState,
  opts: RelocateOptions = {},
): RelocatePlan {
  const isCompressTool = opts.isCompressTool ?? bareIsCompressTool;
  const byRaw = state.messageRefs.byRaw;

  // 1. Which call ids still own an ACTIVE block whose boundaries are numeric
  //    (legacy blocks lack start/endRef — they cannot get a boundary, skip).
  const endRefNumByCallId = new Map<string, number>();
  for (const block of state.blocks) {
    if (!block.active || !block.compressCallId) continue;
    const n = refNum(block.endRef);
    if (n === null) continue; // legacyLiveByCallId-era or unresolved boundary
    const prev = endRefNumByCallId.get(block.compressCallId) ?? 0;
    if (n > prev) endRefNumByCallId.set(block.compressCallId, n);
  }
  if (endRefNumByCallId.size === 0) {
    return { moves: [], removedInputIndices: new Set(), changed: false };
  }

  const refOf = (m: CoreMessage): number | null => {
    const ref = byRaw[m.id];
    return ref === undefined || ref === BLOCKED_REF ? null : refNum(ref);
  };

  // 2. Locate candidate pairs (one pass; duplicates disqualify their call id).
  const callsByCallId = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.contentType !== "tool-call" || !m.toolCallId) continue;
    if (!isCompressTool(m.toolName ?? "")) continue;
    if (!endRefNumByCallId.has(m.toolCallId)) continue;
    const list = callsByCallId.get(m.toolCallId);
    if (list === undefined) callsByCallId.set(m.toolCallId, [i]);
    else list.push(i);
  }

  const moves: RelocateMove[] = [];
  const removed = new Set<number>();
  for (const [callId, callIndices] of [...callsByCallId.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (callIndices.length !== 1) continue; // ambiguous carrier: do not move
    const j = callIndices[0]!;
    const resultIndex = j + 1;
    const r = messages[resultIndex];
    if (!r || r.contentType !== "tool-result" || r.toolCallId !== callId) continue;
    // Adjacent ordered pair confirmed. Record removals up front so later
    // boundary scans never mistake another planned pair for a survivor.
    removed.add(j);
    removed.add(resultIndex);
    // 3. Optional thinking clear: contiguous reasoning run directly before the
    //    call, predicate-gated per core (predicate unset ⇒ drop nothing).
    const droppedReasoningIndices: number[] = [];
    if (opts.clearThinking && typeof opts.reasoningDroppable === "function") {
      for (let k = j - 1; k >= 0; k--) {
        const c = messages[k]!;
        if (c.contentType !== "reasoning") break;
        if (opts.reasoningDroppable(c)) {
          droppedReasoningIndices.push(k);
          removed.add(k);
        }
      }
    }
    moves.push({ callId, callIndex: j, insertAtOutput: 0, droppedReasoningIndices });
  }
  if (moves.length === 0) {
    return { moves: [], removedInputIndices: new Set(), changed: false };
  }

  // 4. Resolve each insertion point against the INPUT array, then convert to
  //    output space (output = input minus `removed`). A qualifying survivor is
  //    any non-removed core whose ref strictly exceeds this call's boundary —
  //    chronology of allocated refs equals ingest order (monotonic mint).
  for (const move of moves) {
    const boundary = endRefNumByCallId.get(move.callId)!;
    let at = messages.length; // tail fallback (#4732 regime)
    for (let i = 0; i < messages.length; i++) {
      if (removed.has(i)) continue;
      const n = refOf(messages[i]!);
      if (n !== null && n > boundary) {
        at = i;
        break;
      }
    }
    let out = 0;
    for (let i = 0; i < at; i++) {
      if (!removed.has(i)) out++;
    }
    move.insertAtOutput = out;
  }
  // Determinism: order by call id so the plan does not depend on Map
  // iteration order (two calls folding different ranges may otherwise
  // resolve to insertion points in the OPPOSITE order of their call slots).
  moves.sort((a, b) => (a.callId < b.callId ? -1 : 1));
  return { moves, removedInputIndices: removed, changed: true };
}

/** Apply the plan to `messages`, returning a NEW array when anything moved.
 *  Fast path: no-op plans return the SAME array reference (byte-identical
 *  guarantee for the default-off regime).
 *
 *  Placement keys on the SURVIVOR ordinal, not the raw output length: a
 *  move "with insertAtOutput k" must appear right BEFORE the k-th surviving
 *  input. Emitted pairs grow the output array between survivors, so keying on
 *  out.length would skip slots whenever an earlier pair landed first (two
 *  calls folding different ranges may legally interleave). */
export function relocateCompressCarriers(
  messages: CoreMessage[],
  state: CompressionState,
  opts: RelocateOptions = {},
): CoreMessage[] {
  const plan = planRelocateCompressCarriers(messages, state, opts);
  if (!plan.changed) return messages;
  const dueAt = new Map<number, RelocateMove[]>();
  for (const move of plan.moves) {
    const list = dueAt.get(move.insertAtOutput);
    if (list === undefined) dueAt.set(move.insertAtOutput, [move]);
    else list.push(move);
  }
  // Per-slot order: earliest call slot first (deterministic tie-break when
  // several pairs share one insertion point).
  for (const list of dueAt.values()) {
    list.sort((a, b) => a.callIndex - b.callIndex);
  }
  const out: CoreMessage[] = [];
  const flushDue = (k: number): void => {
    const due = dueAt.get(k);
    if (due === undefined) return;
    dueAt.delete(k);
    for (const move of due) {
      out.push(messages[move.callIndex]!, messages[move.callIndex + 1]!);
    }
  };
  let survivors = 0;
  for (let i = 0; i < messages.length; i++) {
    if (plan.removedInputIndices.has(i)) continue;
    flushDue(survivors);
    out.push(messages[i]!);
    survivors++;
  }
  flushDue(survivors); // tail fallback (#4732 regime)
  return out;
}
