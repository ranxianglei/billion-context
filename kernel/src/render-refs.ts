import type { CoreMessage, CompressionState, MessageRefMap } from "./types.js";
import { refForRaw, BLOCKED_REF } from "./refs.js";
import { thinkingTokenValue } from "./tokenize.js";
import type { PipelineNode, PipelineContext, NodeIO } from "./pipeline.js";

/**
 * Controls which messages get an <acp> ref tag injected into their text.
 * Ref assignment (assignRefsNode) is unconditional — every message always
 * receives a ref in state.messageRefs regardless of this setting. This only
 * governs text rendering:
 *  - "all": tag every mapped message (in-process hosts like pai-acp)
 *  - "text-only": tag only user/assistant text; leave tool-call args and
 *    tool-result content pristine (proxy hosts — structured content must not
 *    be polluted)
 *  - "none": leave all text untouched (hosts that read the ref map directly)
 */
export type RenderStrategy = "all" | "text-only" | "none";

/** Format token count: <1K raw, <10K "X.YK", >=10K "XK". */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return (tokens / 1000).toFixed(1) + "K";
  return Math.round(tokens / 1000) + "K";
}

function classifyType(message: CoreMessage): string {
  if (
    message.contentType === "tool-call" ||
    message.contentType === "tool-result"
  ) {
    return message.toolName || "tool";
  }
  return message.contentType;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LT = "\x3c";
const GT = "\x3e";
const TAG_OPEN = LT + "acp ";
const TAG_CLOSE = LT + "/acp" + GT;

function acpTag(ref: string, tokens: number, type: string): string {
  return (
    TAG_OPEN +
    'tokens="' +
    formatTokens(tokens) +
    '" type="' +
    type +
    '"' +
    GT +
    ref +
    TAG_CLOSE
  );
}

function renderMessage(
  message: CoreMessage,
  map: MessageRefMap,
  countTokens: (text: string) => number,
  strategy: RenderStrategy,
  snapshot: Record<string, number> | null = null,
  deferred: ReadonlySet<string> | null = null,
): CoreMessage {
  const ref = refForRaw(map, message.id);
  if (!ref || ref === BLOCKED_REF) return message;

  // #3939 ②/#3805: refs minted by the BLOCKED→numeric migration keep their
  // pre-migration UNTAGGED bytes until the next fold boundary — stamping the
  // tag now would rewrite an old message mid-history on a quiet turn.
  if (deferred?.has(ref)) return message;

  // "none": host reads the ref map directly — never pollute text.
  if (strategy === "none") return message;

  // text-only: never tag structured tool content. Refs are still assigned.
  if (strategy === "text-only" && message.contentType !== "text") {
    return message;
  }

  // Strip own stale tag BEFORE computing tokens (idempotency).
  // Match the message's own ref only — foreign tags survive (content-corruption fix).
  const ownTagRe = new RegExp(
    "^" +
      escapeRegex(TAG_OPEN) +
      "[^>]*" +
      GT +
      escapeRegex(ref) +
      escapeRegex(TAG_CLOSE) +
      "\\n?",
  );
  const cleanText = (message.text || "").replace(ownTagRe, "");

  // Snapshot mode: token count is fixed at first render (stable prefix cache).
  // Live mode (snapshot = null): recompute every render — legacy behavior.
  // The tag carries the metered total (text + host-projected thinking), so the
  // size the model sees per message matches block/range/breakdown accounting.
  const textTokens = snapshot
    ? (snapshot[ref] ?? (snapshot[ref] = countTokens(cleanText)))
    : countTokens(cleanText);
  const tokens = textTokens + thinkingTokenValue(message.thinkingTokens);
  const type = classifyType(message);
  const prefix = acpTag(ref, tokens, type) + "\n";

  if (!cleanText) return { ...message, text: prefix };
  return { ...message, text: prefix + cleanText };
}

export function renderVisibleRefs(
  messages: CoreMessage[],
  state: CompressionState,
  countTokens: (text: string) => number = (text) => Math.ceil(text.length / 4),
  strategy: RenderStrategy = "all",
): CoreMessage[] {
  // Legacy behavior: recompute tokens every render (snapshot = null).
  const map = state.messageRefs;
  const deferred = state.renderDeferredRefs
    ? new Set(state.renderDeferredRefs)
    : null;
  return messages.map((message) =>
    renderMessage(message, map, countTokens, strategy, null, deferred),
  );
}

export interface RenderWithSnapshotResult {
  messages: CoreMessage[];
  tokenSnapshot: Record<string, number>;
}

/** Render with a stable token snapshot: token counts are written on first
 *  render and reused forever (keyed by ref). The snapshot starts as a shallow
 *  copy of the persisted state so old entries survive; new entries are added
 *  during this render. */
export function renderWithSnapshot(
  messages: CoreMessage[],
  state: CompressionState,
  countTokens: (text: string) => number = (text) => Math.ceil(text.length / 4),
  strategy: RenderStrategy = "all",
): RenderWithSnapshotResult {
  const map = state.messageRefs;
  const snapshot = { ...(state.tokenSnapshot ?? {}) };
  const deferred = state.renderDeferredRefs
    ? new Set(state.renderDeferredRefs)
    : null;
  const rendered = messages.map((message) =>
    renderMessage(message, map, countTokens, strategy, snapshot, deferred),
  );
  return { messages: rendered, tokenSnapshot: snapshot };
}

/** Factory: build a render-refs node bound to a specific render strategy. */
export function createRenderRefsNode(strategy: RenderStrategy): PipelineNode {
  return {
    name: "render-refs",
    run(io: NodeIO, ctx: PipelineContext): NodeIO {
      const { messages, tokenSnapshot } = renderWithSnapshot(
        io.messages,
        io.state,
        ctx.countTokens,
        strategy,
      );
      // Write the snapshot back only when it grew: steady-state (all hits)
      // must not churn the state object and force an adapter save every turn.
      const prev = io.state.tokenSnapshot;
      const changed =
        !prev || Object.keys(tokenSnapshot).length !== Object.keys(prev).length;
      return changed
        ? { ...io, messages, state: { ...io.state, tokenSnapshot } }
        : { ...io, messages };
    },
  };
}

/** Backward compat: default render-refs node using strategy "all". */
export const renderRefsNode: PipelineNode = createRenderRefsNode("all");
