import type { CompressionState, CoreMessage, NudgeDecision } from "./types.js";

export interface PipelineContext {
  readonly config: import("./types.js").Config;
  readonly tokenCount: number;
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
