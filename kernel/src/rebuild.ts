import { createCore } from "./compress.js";
import { parseCompressArgs } from "./parse-compress-input.js";
import { assignRefs, highestUsedIndex } from "./refs.js";
import { RETRIEVED_ID_PREFIX } from "./ccr.js";
import { defaultCountTokens } from "./tokenize.js";
import { isCompressToolName } from "./protected.js";
import type { CompressionState, Config, CoreMessage } from "./types.js";

export interface RebuildResult {
  state: CompressionState;
  blocksRebuilt: number;
}

export interface RebuildPorts {
  countTokens?: (text: string) => number;
}

/**
 * Fork-recovery: reconstruct compression state by replaying historical
 * `compress` tool-call messages. Message refs (mNNNNN) are assigned by
 * message order, so they are fork-stable — a ref in a historical compress
 * input points to the same logical message after a fork regenerates IDs.
 * The rebuilt state is an approximation: only raw model summaries are
 * replayed (no protected-content enrichments). Arguments are parsed with
 * the lenient parseCompressArgs, so truncated or stringified historical
 * inputs are salvaged instead of silently dropped.
 */
export function rebuildCompressionState(
  state: CompressionState,
  messages: CoreMessage[],
  config: import("./types.js").Config,
  ports: RebuildPorts = {},
): RebuildResult {
  const core = createCore({
    countTokens: ports.countTokens ?? defaultCountTokens,
  });
  const refResult = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: highestUsedIndex(state.messageRefs) + 1,
    shouldSkip: (m) => m.id.startsWith(RETRIEVED_ID_PREFIX),
  });
  let working: CompressionState = { ...state, messageRefs: refResult.map };

  const invocations = collectCompressInvocations(messages, config);
  let blocksRebuilt = 0;

  for (const invocation of invocations) {
    const { ranges } = parseCompressArgs(invocation.raw, {
      callId: invocation.callId,
    });
    if (ranges.length === 0) continue;
    const result = core.applyCompression({
      ranges,
      messages,
      state: working,
      config,
    });
    working = result.state;
    blocksRebuilt += result.result.blocksCreated;
  }

  return { state: working, blocksRebuilt };
}

interface CompressInvocation {
  callId: string | undefined;
  raw: string;
}

function collectCompressInvocations(
  messages: CoreMessage[],
  config: Pick<Config, "isCompressTool">,
): CompressInvocation[] {
  const invocations: CompressInvocation[] = [];
  for (const message of messages) {
    if (message.contentType !== "tool-call" || !message.toolName) continue;
    // Same predicate as every other compress recognition site, so an
    // MCP-dialect call (config.isCompressTool) rebuilds like its bare twin.
    if (!isCompressToolName(message.toolName, config)) continue;
    invocations.push({ callId: message.toolCallId, raw: message.text ?? "" });
  }
  return invocations;
}
