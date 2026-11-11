import { clampPrefix, clampWindow } from "./truncate.js";
import type { Config, CoreMessage } from "./types.js";
import { SUMMARY_HEADER, isRenderedSummaryMessage } from "./prune.js";
import { isRetrievedMessage } from "./ccr.js";

export interface TruncateOptions {
  minOutputTokens?: number;
  keepPrefixChars?: number;
  keepSuffixChars?: number;
  protectRecentMessages?: number;
  /** Also consider user/assistant text messages as LAST-RESORT candidates,
   *  applied only after tool-result truncation fails to reach the target
   *  (#300). Rendered block summaries are never touched. */
  includeTextMessages?: boolean;
}

export interface TruncateResult {
  messages: CoreMessage[];
  truncatedCount: number;
  savedTokens: number;
  /** Size-qualified candidates found (pre-truncation). 0 explains a silent
   *  no-op at/above threshold — hosts should warn-log (#300). */
  candidatesFound: number;
  /** Ids of the messages actually clipped this pass (#3939 ③ latch). Empty
   *  when truncatedCount is 0. */
  truncatedIds?: string[];
}

const TRUNCATION_MARKER = "[truncated for context space]";

const DEFAULTS: Required<Omit<TruncateOptions, "includeTextMessages">> = {
  minOutputTokens: 1000,
  keepPrefixChars: 2000,
  keepSuffixChars: 2000,
  protectRecentMessages: 3,
};

export function truncateLargeToolOutputs(
  messages: CoreMessage[],
  tokenCount: number,
  config: Config,
  countTokens: (text: string) => number,
  options: TruncateOptions = {},
): TruncateResult {
  const opts = { ...DEFAULTS, ...options };
  const limit = config.modelContextLimit;
  if (limit <= 0 || tokenCount < config.truncate.threshold * limit) {
    return { messages, truncatedCount: 0, savedTokens: 0, candidatesFound: 0, truncatedIds: [] };
  }

  const protectedIndex = messages.length - opts.protectRecentMessages;

  const findCandidates = (
    predicate: (message: CoreMessage) => boolean,
  ): CoreMessage[] => {
    const found: CoreMessage[] = [];
    for (let i = 0; i < protectedIndex; i++) {
      const message = messages[i]!;
      if (!predicate(message)) continue;
      const text = message.text ?? "";
      if (text.length === 0 || text.includes(TRUNCATION_MARKER)) continue;
      if (countTokens(text) < opts.minOutputTokens) continue;
      found.push(message);
    }
    return found.sort(
      (a, b) => countTokens(b.text ?? "") - countTokens(a.text ?? ""),
    );
  };

  const toolResults = findCandidates((m) => m.contentType === "tool-result");
  // Last-resort stage (#300): oversized visible TEXT (user requests, assistant
  // prose) when tool outputs alone cannot close the gap. Role-restricted so
  // system prompts / standing prompts stay intact; rendered block summaries
  // ("[Compressed conversation section]") are NEVER touched — they are the
  // only durable record of compressed content.
  const textMessages = options.includeTextMessages
    ? findCandidates(
        (m) =>
          m.contentType === "text" &&
          (m.role === "user" || m.role === "assistant") &&
          !isRenderedSummaryMessage(m) &&
          !isRetrievedMessage(m) &&
          !m.text?.startsWith(SUMMARY_HEADER),
      )
    : [];
  const candidatesFound = toolResults.length + textMessages.length;

  let truncatedCount = 0;
  let savedTokens = 0;
  let remaining = tokenCount;
  const targetTokens = config.truncate.threshold * limit * 0.9;
  const replacements = new Map<string, string>();
  const truncatedIds: string[] = [];

  const applyTo = (candidates: CoreMessage[]) => {
    for (const candidate of candidates) {
      if (remaining <= targetTokens) break;
      const original = candidate.text ?? "";
      const tokens = countTokens(original);
      if (original.length <= opts.keepPrefixChars + opts.keepSuffixChars) {
        continue;
      }
      // #3935: the clip must come out STRICTLY shorter than the original —
      // prefix + suffix + marker briefly exceeded the source text just above
      // the keep window (4001 → 4064), rewriting banked prefix-cache bytes and
      // INFLATING the context while "saving" tokens. Cap the total keep
      // window to whatever room the original actually leaves below the
      // marker; candidates too small to leave room are skipped verbatim.
      const marker = `\n\n...${TRUNCATION_MARKER} — original ~${tokens} tokens]...\n\n`;
      const maxKeep = original.length - marker.length - 4;
      if (maxKeep < 64) continue;
      const keep = Math.min(
        opts.keepPrefixChars + opts.keepSuffixChars,
        maxKeep,
      );
      const prefixKeep = Math.floor(keep / 2);
      const suffixKeep = keep - prefixKeep;
      const prefix = clampPrefix(original, prefixKeep);
      const suffix = clampWindow(
        original,
        original.length - suffixKeep,
        original.length,
      );
      const replacement = `${prefix}${marker}${suffix}`;
      if (replacement.length >= original.length) continue;
      replacements.set(candidate.id, replacement);
      truncatedIds.push(candidate.id);
      truncatedCount++;
      remaining -= tokens - countTokens(replacement);
      savedTokens += tokens - countTokens(replacement);
    }
  };

  applyTo(toolResults);
  applyTo(textMessages);

  if (replacements.size === 0) {
    return { messages, truncatedCount: 0, savedTokens: 0, candidatesFound, truncatedIds: [] };
  }
  return {
    messages: messages.map((m) =>
      replacements.has(m.id) ? { ...m, text: replacements.get(m.id)! } : m,
    ),
    truncatedCount,
    savedTokens,
    candidatesFound,
    truncatedIds,
  };
}
