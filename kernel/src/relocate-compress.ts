import { BLOCKED_REF } from "./refs.js";
import { refNum } from "./hide-consumed.js";
import type { CompressionState, CoreMessage } from "./types.js";

/** Opt-in view transform (experimental, default OFF — see Config.compressAtFoldPoint):
 *  relocate the SUMMARY TEXT of each still-visible compress carrier pair to the
 *  fold point, leaving the pair itself in its chronological slot with the call
 *  args replaced by a short pointer.
 *
 * Semantics (v2, #5470 follow-up — replaces the verbatim-pair move): when the
 *  knob is on, for each compress call/result pair that still owns an active
 *  block:
 *  - a synthetic `user` text core carrying the call's summary text (the args
 *    `content`, or the raw args string when not JSON) is inserted directly
 *    after the pair's own folded region ("[folded region] – [summary carrier] –
 *    [protected messages]");
 *  - the pair STAYS at its original (chronological) position — the tool
 *    exchange keeps reading as history, not as a fresh command — with the call
 *    core's args text replaced by a short pointer ("compression succeeded;
 *    summary relocated to its fold point above") so a weak-attention model
 *    cannot mistake the pair for an unfinished compression. The result core is
 *    forwarded verbatim.
 *
 * Why v2: with the v1 verbatim move, every historical pair stays visible
 * mid-history as a fully-shaped compress interaction — for weak-attention
 * models that gallery reads as an open invitation to keep compressing
 * (observed: voluntary re-compress loops). v2 keeps exactly one recent
 * interaction shape per fold (the pointer pair, which explicitly says
 * "already folded") and renders the payloads the model actually needs to
 * re-read (the summaries) as plain text at the place they describe.
 *
 * Invariants:
 *  - VIEW-ONLY + deterministic f(history, state): nothing is persisted, refs are
 *    untouched (assign-refs already ran; messageRefs is a persistent id→ref map),
 *    so the layout is recomputed identically on every turn — byte-stable from the
 *    second turn on, no incremental prefix-cache cost beyond the fold's own break.
 *    The call core is rewritten via a shallow CLONE (input cores are never
 *    mutated — callers reuse them for persistence and round-2 rebuilds).
 *  - Idempotent: a call id whose carrier (`acp_reloc_<callId>`) is already
 *    present, or whose args already carry the relocation marker, is skipped —
 *    re-running the transform on its own output is a same-reference no-op.
 *  - Pair integrity: a call is rewritten only when BOTH cores are present, in
 *    order, adjacent, and unambiguous (exactly one tool-call core per active
 *    block's call id). Any anomaly → the pair stays verbatim (safe direction).
 *  - Boundary rule: insert the carrier before the first surviving core whose
 *    allocated ref is strictly greater than max(endRef) across the blocks this
 *    call created (multi-range batches → rightmost boundary); when none exists
 *    (fold reaches the window end, #4732 regime) append at the tail instead.
 *  - Thinking clear (second opt-in, default off, predicate-gated): the run of
 *    contiguous `reasoning` cores immediately preceding the pair may be dropped
 *    IF opts.reasoningDroppable accepts each one. Without a predicate
 *    NOTHING is dropped — signed-thinking / strict-echo awareness lives in the
 *    host (it owns the wire signatures), and the conservative default here is
 *    "never drop". */
export interface RelocateOptions {
  /** Same contract as Config.isCompressTool: host dialect names count as a
   *  compress call. Unset = bare-name only. */
  isCompressTool?: (toolName: string) => boolean;
  /** Enable the #651-style reasoning drop around kept pairs. */
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
  /** Index of the tool-result core in the input array (stays in place, verbatim). */
  resultIndex: number;
  /** Survivor ordinal: emit the carrier before the k-th surviving (non-removed)
   *  input. k == total survivors ⇒ tail append (#4732 regime). */
  insertAtOutput: number;
  /** Input indices of dropped reasoning cores (adjacent run before the call). */
  droppedReasoningIndices: number[];
  /** Synthetic fold-point carrier carrying the relocated summary text. */
  carrier: CoreMessage;
  /** Replacement args text for the call core (pointer JSON). */
  pointerText: string;
}

export interface RelocatePlan {
  moves: RelocateMove[];
  /** Input indices of ALL cores removed (dropped reasoning only — pairs stay). */
  removedInputIndices: Set<number>;
  changed: boolean;
}

const bareIsCompressTool = (toolName: string | undefined): boolean =>
  toolName === "compress";

/** Marker embedded in the pointer args text; also the idempotency detector for
 *  hosts that round-trip a view whose carrier ids did not survive. */
export const RELOCATED_POINTER_MARKER =
  "[bili] compression succeeded — summary relocated";

const carrierIdFor = (callId: string): string => `acp_reloc_${callId}`;

/** Pull the summary text out of a compress call's args. The plugin dialect
 *  rides JSON `{"content": "…"}`; anything else is used verbatim. Pure. */
function summaryTextOf(callText: string | undefined): string {
  if (!callText) return "";
  try {
    const parsed: unknown = JSON.parse(callText);
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as { content?: unknown }).content === "string"
    ) {
      return (parsed as { content: string }).content;
    }
  } catch {
    // not JSON — raw args are the summary
  }
  return callText;
}

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
  const blockIdsByCallId = new Map<string, string[]>();
  for (const block of state.blocks) {
    if (!block.active || !block.compressCallId) continue;
    const n = refNum(block.endRef);
    if (n === null) continue; // legacyLiveByCallId-era or unresolved boundary
    const prev = endRefNumByCallId.get(block.compressCallId) ?? 0;
    if (n > prev) endRefNumByCallId.set(block.compressCallId, n);
    const ids = blockIdsByCallId.get(block.compressCallId);
    if (ids === undefined) blockIdsByCallId.set(block.compressCallId, [block.blockId]);
    else ids.push(block.blockId);
  }
  if (endRefNumByCallId.size === 0) {
    return { moves: [], removedInputIndices: new Set(), changed: false };
  }

  const refOf = (m: CoreMessage): number | null => {
    const ref = byRaw[m.id];
    return ref === undefined || ref === BLOCKED_REF ? null : refNum(ref);
  };

  // Idempotency probes (view-only transform may be re-run on its own output
  // by the relay round-2 mirror and the plugin-render mirror).
  const presentCarrierIds = new Set<string>();
  for (const m of messages) presentCarrierIds.add(m.id);

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
    if (callIndices.length !== 1) continue; // ambiguous carrier: do not touch
    const j = callIndices[0]!;
    // Already relocated in a previous pass of this view? Skip entirely.
    if (presentCarrierIds.has(carrierIdFor(callId))) continue;
    if ((messages[j]!.text ?? "").includes(RELOCATED_POINTER_MARKER)) continue;
    const resultIndex = j + 1;
    const r = messages[resultIndex];
    if (!r || r.contentType !== "tool-result" || r.toolCallId !== callId) continue;
    // Adjacent ordered pair confirmed.
    const blockIds = blockIdsByCallId.get(callId) ?? [];
    const blockLabel = blockIds.length > 0 ? `block(s) ${blockIds.join(", ")}` : "fold";
    const summary = summaryTextOf(messages[j]!.text);
    const carrier: CoreMessage = {
      id: carrierIdFor(callId),
      role: "user",
      contentType: "text",
      text:
        `[bili fold summary — ${blockLabel}; relocated from compress call ${callId} ` +
        `(the call/result exchange stays in its chronological slot below)]\n${summary}`,
    };
    const pointerText = JSON.stringify({
      content:
        `${RELOCATED_POINTER_MARKER} to its fold point above (${blockLabel}); ` +
        `these ranges are already folded — do not re-compress them.`,
    });
    // 3. Optional thinking clear: contiguous reasoning run directly before the
    //    pair, predicate-gated per core (predicate unset ⇒ drop nothing).
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
    moves.push({ callId, callIndex: j, resultIndex, insertAtOutput: 0, droppedReasoningIndices, carrier, pointerText });
  }
  if (moves.length === 0) {
    return { moves: [], removedInputIndices: new Set(), changed: false };
  }

  // 4. Resolve each insertion point against the INPUT array, then convert to
  //  output space (output = input minus `removed`). A qualifying survivor is
  //  any non-removed core whose ref strictly exceeds this call's boundary —
  //  chronology of allocated refs equals ingest order (monotonic mint). The
  //  kept pair cores themselves carry no refs (tool-call/result cores are not
  //  ref-minted), so they never qualify as boundaries.
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

/** Apply the plan to `messages`, returning a NEW array when anything changed.
 *  Fast path: no-op plans return the SAME array reference (byte-identical
 *  guarantee for the default-off regime).
 *
 *  Placement keys on the SURVIVOR ordinal, not the raw output length: a
 *  carrier "with insertAtOutput k" must appear right BEFORE the k-th surviving
 *  input. Emitted carriers grow the output array between survivors, so keying on
 *  out.length would skip slots whenever an earlier carrier landed first (two
 *  calls folding different ranges may legally interleave).
 *
 *  The rewritten call core is a shallow CLONE of the input (view-only purity:
 *  callers reuse input cores for persistence and round-2 rebuilds); every other
 *  core is forwarded by reference. */
export function relocateCompressCarriers(
  messages: CoreMessage[],
  state: CompressionState,
  opts: RelocateOptions = {},
): CoreMessage[] {
  const plan = planRelocateCompressCarriers(messages, state, opts);
  if (!plan.changed) return messages;
  const dueAt = new Map<number, RelocateMove[]>();
  const rewrite = new Map<number, string>(); // input index → pointer args
  for (const move of plan.moves) {
    const list = dueAt.get(move.insertAtOutput);
    if (list === undefined) dueAt.set(move.insertAtOutput, [move]);
    else list.push(move);
    rewrite.set(move.callIndex, move.pointerText);
  }
  // Per-slot order: earliest call slot first (deterministic tie-break when
  // several carriers share one insertion point).
  for (const list of dueAt.values()) {
    list.sort((a, b) => a.callIndex - b.callIndex);
  }
  const out: CoreMessage[] = [];
  const flushDue = (k: number): void => {
    const due = dueAt.get(k);
    if (due === undefined) return;
    dueAt.delete(k);
    for (const move of due) out.push(move.carrier);
  };
  let survivors = 0;
  for (let i = 0; i < messages.length; i++) {
    if (plan.removedInputIndices.has(i)) continue;
    flushDue(survivors);
    const m = messages[i]!;
    const pointer = rewrite.get(i);
    out.push(pointer === undefined ? m : { ...m, text: pointer });
    survivors++;
  }
  flushDue(survivors); // tail fallback (#4732 regime)
  return out;
}
