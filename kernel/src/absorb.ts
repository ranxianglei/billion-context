import { rawForRef, refForRaw, BLOCKED_REF } from "./refs.js";
import { ACP_TOOL_NAMES, ABSORB_TOOL_NAME } from "./compress-tools.js";
import { isStoredPlaceholderText } from "./ccr.js";
import {
  collectLatestProtected,
  collectProtectedToolCallIds,
  isMessageLatestProtected,
  isMessageProtectedWithPairing,
  matchToolPattern,
  type LatestProtected,
} from "./protected.js";
import type {
  AbsorbRecord,
  Config,
  CompressionState,
  CoreMessage,
  ResolvedAbsorbConfig,
} from "./types.js";

/**
 * Instant tool-result absorption ("absorb") — the middle layer between
 * "let output pile up until a 50K-token nudge fires" and "the model can't
 * work at a 10K window". When enabled, the kernel appends a FORCED prompt to
 * every eligible large tool result demanding the model immediately distill it
 * via absorb({ ref, summary }); the original tool-call + tool-result pair is
 * then hidden from all subsequent turns, leaving the model's absorb call as
 * the durable record. Absorb calls are ordinary messages: the regular
 * compression pipeline can fold them later (orthogonal by design).
 */

export const ABSORB_PROMPT_MARKER = "[ACP absorb]";

export const DEFAULT_ABSORB_CONFIG: ResolvedAbsorbConfig = {
  enabled: false,
  toolName: ABSORB_TOOL_NAME,
  // Raised 1000 → 4000 (issue #352): lossless CCR takes over large-result
  // handling; absorb's forced distillation only fires above the new bar.
  minToolTokens: 4000,
  contextThresholdPct: 0,
  excludeTools: [],
};

export function resolveAbsorbConfig(config: Config): ResolvedAbsorbConfig {
  return { ...DEFAULT_ABSORB_CONFIG, ...(config.absorb ?? {}) };
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return (tokens / 1000).toFixed(1) + "K";
  return Math.round(tokens / 1000) + "K";
}

export function buildAbsorbPrompt(
  ref: string,
  tokens: number,
  toolName: string = ABSORB_TOOL_NAME,
): string {
  return (
    `${ABSORB_PROMPT_MARKER} This tool result (~${formatTokenCount(tokens)} tokens) will be REMOVED from context. ` +
    `Your IMMEDIATE next action: call ${toolName}({ ref: "${ref}", summary: "..." }) — summary = distilled essentials only ` +
    `(outcome, key values, exact paths:lines, error text verbatim, decisions). ` +
    `Afterwards work from your summary; do NOT re-run this tool. ` +
    `If the result contains nothing you need, call ${toolName} with summary "(nothing needed)".`
  );
}

/** System-prompt section for adapters with absorb enabled. */
export function buildAbsorbSystemPrompt(
  toolName: string = ABSORB_TOOL_NAME,
): string {
  return `INSTANT TOOL-RESULT ABSORPTION (${toolName})

Some tool results end with a ${ABSORB_PROMPT_MARKER} instruction. When you see one, your IMMEDIATE next action must be calling ${toolName}({ ref, summary }) — distill that tool result's essentials into summary: outcome, key values, exact paths:lines, error text verbatim, decisions. The original output is then removed from context; your ${toolName} summary becomes the only durable record of it, so distill carefully. Never call another tool or answer the user before absorbing a marked result. Do not re-run the original tool afterwards — work from your summary. ${toolName} calls are ordinary context: the regular compression system may fold them later like any other message.`;
}

function isAcpOrConfiguredTool(
  toolName: string | undefined,
  cfg: ResolvedAbsorbConfig,
): boolean {
  if (!toolName) return false;
  if (toolName === cfg.toolName) return true;
  return ACP_TOOL_NAMES.has(toolName);
}

const NO_PROTECTED_CALLS = new Set<string>();

/** True when a tool-result message is in scope for absorption prompting:
 *  a tool-result of a non-ACP, non-excluded, non-protected tool. */
export function isAbsorbCandidate(
  msg: CoreMessage,
  config: Config,
  latest?: LatestProtected,
  protectedCallIds?: Set<string>,
): boolean {
  if (msg.contentType !== "tool-result" || !msg.toolCallId) return false;
  if (isStoredPlaceholderText(msg.text ?? "")) return false;
  const cfg = resolveAbsorbConfig(config);
  if (isAcpOrConfiguredTool(msg.toolName, cfg)) return false;
  if (
    isMessageProtectedWithPairing(
      msg,
      config,
      protectedCallIds ?? NO_PROTECTED_CALLS,
    )
  )
    return false;
  if (latest && isMessageLatestProtected(msg, latest)) return false;
  for (const pattern of cfg.excludeTools) {
    if (msg.toolName && matchToolPattern(msg.toolName, pattern)) return false;
  }
  return true;
}

/** Drop tool-call + tool-result pairs recorded in state.absorbed. Both halves
 *  go together so the provider-visible conversation stays structurally valid;
 *  prune's orphan stripping cleans up any straddling leftovers. */
export function hideAbsorbedMessages(
  messages: CoreMessage[],
  state: CompressionState,
): CoreMessage[] {
  const records = state.absorbed ?? [];
  if (records.length === 0) return messages;
  const hidden = new Set<string>();
  for (const record of records) {
    if (record.callMessageId) hidden.add(record.callMessageId);
    if (record.resultMessageId) hidden.add(record.resultMessageId);
  }
  return messages.filter((msg) => !hidden.has(msg.id));
}

export interface AppendAbsorbPromptsResult {
  messages: CoreMessage[];
  promptedCount: number;
}

/** Append the forced absorb prompt to every eligible, un-absorbed, large
 *  tool result in the visible view. Per-turn view-only text (never persisted
 *  by the kernel): the prompt re-appears each turn until the model absorbs,
 *  and disappears once the pair is hidden by hideAbsorbedMessages. */
export function appendAbsorbPrompts(
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  tokenCount: number,
  countTokens: (text: string) => number,
): AppendAbsorbPromptsResult {
  const cfg = resolveAbsorbConfig(config);
  if (!cfg.enabled) return { messages, promptedCount: 0 };

  const limit = config.modelContextLimit;
  if (
    cfg.contextThresholdPct > 0 &&
    limit > 0 &&
    tokenCount < cfg.contextThresholdPct * limit
  ) {
    return { messages, promptedCount: 0 };
  }

  const absorbedIds = new Set<string>();
  for (const record of state.absorbed ?? []) {
    if (record.resultMessageId) absorbedIds.add(record.resultMessageId);
  }

  let promptedCount = 0;
  const latest = collectLatestProtected(messages, config);
  const protectedCallIds = collectProtectedToolCallIds(messages, config);
  const out = messages.map((msg) => {
    if (!isAbsorbCandidate(msg, config, latest, protectedCallIds)) return msg;
    if (absorbedIds.has(msg.id)) return msg;
    const text = msg.text ?? "";
    if (text.includes(ABSORB_PROMPT_MARKER)) return msg;
    const tokens = countTokens(text);
    if (tokens < cfg.minToolTokens) return msg;
    const ref = refForRaw(state.messageRefs, msg.id);
    if (!ref || ref === BLOCKED_REF) return msg;
    promptedCount++;
    return {
      ...msg,
      text: text + "\n\n" + buildAbsorbPrompt(ref, tokens, cfg.toolName),
    };
  });
  return { messages: out, promptedCount };
}

export interface ParsedAbsorb {
  ref: string;
  summary: string;
  absorbCallId?: string;
}

/** Lenient parse of an absorb tool-call argument object. Accepts `ref`
 *  spellings ref/messageId/of and summary spellings summary/content, plus a
 *  JSON-encoded string payload (stringifying providers). */
export function parseAbsorbInput(
  input: unknown,
  callId?: string,
  onWarn?: (message: string) => void,
): ParsedAbsorb | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === "object") {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      obj = null;
    }
  } else if (input && typeof input === "object") {
    obj = input as Record<string, unknown>;
  }
  if (!obj) {
    onWarn?.(`[acp-absorb-input] rejected: not an object (${typeof input})`);
    return null;
  }
  const ref = pickString(obj, "ref", "messageId", "of");
  const summary = pickString(obj, "summary", "content");
  if (typeof ref !== "string" || typeof summary !== "string") {
    onWarn?.(
      `[acp-absorb-input] rejected: need ref (string) + summary (string); keys: ${Object.keys(obj).join(",")}`,
    );
    return null;
  }
  return {
    ref: ref.trim(),
    summary,
    ...(callId ? { absorbCallId: callId } : {}),
  };
}

function pickString(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export interface AbsorbInput {
  ref: string;
  summary: string;
  absorbCallId?: string;
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
  countTokens?: (text: string) => number;
}

export interface AbsorbOutcome {
  state: CompressionState;
  ok: boolean;
  resultText: string;
}

/** Apply a model-issued absorb call: validate the target tool-result, record
 *  the absorption in state, and report. The pair is hidden on the NEXT
 *  processTurn (hideAbsorbedMessages), never mid-turn. */
export function applyAbsorb(input: AbsorbInput): AbsorbOutcome {
  const countTokens =
    input.countTokens ?? ((text: string) => Math.ceil(text.length / 4));
  const summary = input.summary?.trim() ?? "";
  if (!summary) {
    return {
      state: input.state,
      ok: false,
      resultText:
        "absorb failed: summary is empty — provide the distilled key info of the tool result.",
    };
  }

  const cfg = resolveAbsorbConfig(input.config);
  const rawId = rawForRef(input.state.messageRefs, input.ref.trim());
  if (!rawId) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ref ${input.ref} does not exist in this session (it may be hidden, already compressed, or stale).`,
    };
  }
  const existing = (input.state.absorbed ?? []).find(
    (record) => record.resultMessageId === rawId,
  );
  if (existing) {
    return {
      state: input.state,
      ok: true,
      resultText: `already absorbed (${input.ref}) — no change.`,
    };
  }
  const target = input.messages.find((m) => m.id === rawId);
  if (!target) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ref ${input.ref} is not visible in this session (hidden or compressed).`,
    };
  }
  if (target.contentType !== "tool-result") {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ref ${input.ref} is a ${target.contentType}, not a tool result.`,
    };
  }
  if (isAcpOrConfiguredTool(target.toolName, cfg)) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ${target.toolName} is an ACP-managed tool result — it is not absorbable.`,
    };
  }
  if (
    isMessageProtectedWithPairing(
      target,
      input.config,
      collectProtectedToolCallIds(input.messages, input.config),
    ) ||
    isMessageLatestProtected(
      target,
      collectLatestProtected(input.messages, input.config),
    )
  ) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ${target.toolName} is a protected tool — its results must stay visible.`,
    };
  }
  if (!target.toolCallId) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ref ${input.ref} has no tool-call id — cannot pair it for hiding.`,
    };
  }

  const call = input.messages.find(
    (m) => m.contentType === "tool-call" && m.toolCallId === target.toolCallId,
  );
  const tokens = countTokens(target.text ?? "");
  const summaryTokens = countTokens(summary);

  const record: AbsorbRecord = {
    toolCallId: target.toolCallId,
    callMessageId: call?.id ?? "",
    resultMessageId: target.id,
    ...(input.absorbCallId ? { absorbCallId: input.absorbCallId } : {}),
    summary,
    tokensReclaimed: tokens,
    createdAt: Date.now(),
  };
  const state: CompressionState = {
    ...input.state,
    absorbed: [...(input.state.absorbed ?? []), record],
    stats: {
      ...input.state.stats,
      absorbedTokens: (input.state.stats.absorbedTokens ?? 0) + tokens,
    },
  };

  const bloat =
    summaryTokens >= tokens && tokens > 0
      ? ` WARNING: your summary (~${formatTokenCount(summaryTokens)} tokens) is not smaller than the original (~${formatTokenCount(tokens)} tokens) — distill harder next time.`
      : "";
  return {
    state,
    ok: true,
    resultText: `absorbed ${input.ref} (~${formatTokenCount(tokens)} tokens → summary ~${formatTokenCount(summaryTokens)}). The original tool output is now hidden; your summary is the durable record.${bloat}`,
  };
}
