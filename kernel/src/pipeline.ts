import type { CompressionState, CoreMessage, NudgeDecision } from "./types.js";

export interface PipelineContext {
  readonly config: import("./types.js").Config;
  readonly tokenCount: number;
  /** Where tokenCount came from (see ProcessTurnInput.tokenCountSource):
   *  "usage" = billing-grade sample, "estimate" = local fallback. Drives the
   *  phantom-pressure guard in the nudge node. Optional — omit for legacy.
   */
  readonly tokenCountSource?: "usage" | "estimate";
  /** The #554 meter on the ACTUAL serialized outbound body (every string
   *  field, CJK-aware — tools[], system, extension fields, encrypted
   *  reasoning replay), measured by the host BEFORE this turn: when it
   *  exceeds the model window the nudge node arms a measured-pressure
   *  EMERGENCY regardless of the (possibly frozen/stale) usage reading.
   *  #6876: usage-grade 437,971 frozen at 43% while the wire body measured
   *  1,068,060 — every nudge path sat below gate while the egress fuse 413'd
   *  every round. Omit for legacy behavior (byte-identical). */
  readonly measuredBodyTokens?: number;
  readonly countTokens: (text: string) => number;
  /** Per-session CCR content store for this turn (ccr-store node updates it
   *  via effects.ccr; processTurn echoes it back in the result). */
  readonly contentStore: import("./content-store.js").MessageContentStore;
}

export interface NodeEffects {
  nudge?: NudgeDecision;
  recommendation?: import("./types.js").Recommendation;
  truncatedCount?: number;
  terminalEscape?: import("./types.js").TerminalEscapeSignal;
  truncationSkipped?: string;
  /** Pipeline-internal (#2663): the pre-prune resent array, stashed by the
   *  prune node so downstream nodes (recommend) can judge foldability on the
   *  same input class the apply side sees. Optional — custom pipelines without
   *  a prune node simply don't set it and recommend falls back to its input. */
  originalMessages?: CoreMessage[];
  /** #3236: the exact array class applyCompression runs on (host-passed, see
   *  ProcessTurnInput.applyView). Ranks above originalMessages for
   *  foldability judgment — on lanes whose processTurn input is itself a
   *  pruned/render view, even the pre-prune input is not the apply class. */
  applyView?: CoreMessage[];
  /** #3939 ⑤: the post-prune, pre-transform resent view, stashed by the
   *  pre-transform-snapshot node so the view-latch node can replay latched
   *  bytes for messages the transform nodes dropped or rewrote. */
  preTransformMessages?: CoreMessage[];
  readonly [key: string]: unknown;
}

export interface NodeIO {
  messages: CoreMessage[];
  state: CompressionState;
  effects: NodeEffects;
}

export interface PipelineNode {
  readonly name: string;
  run(io: NodeIO, ctx: PipelineContext): NodeIO;
  enabled?: (io: NodeIO, ctx: PipelineContext) => boolean;
}

export function makeIO(
  messages: CoreMessage[],
  state: CompressionState,
  effects: NodeEffects = {},
): NodeIO {
  return { messages, state, effects };
}

export function runPipeline(
  nodes: readonly PipelineNode[],
  initial: NodeIO,
  ctx: PipelineContext,
): NodeIO {
  let io = initial;
  for (const node of nodes) {
    if (node.enabled && !node.enabled(io, ctx)) continue;
    io = node.run(io, ctx);
  }
  return io;
}
