import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Every Han ideograph — basic block, extensions A/B–H, compatibility ideographs
// and their supplement — via the Unicode script property (stays current as new
// extension blocks land), plus the kana and Hangul-syllable ranges the estimator
// has always billed at ~1 token per char (#4315).
const CJK_TOKEN_RE = /[\p{Script=Han}\u3040-\u30ff\uac00-\ud7af]/gu;

export function defaultCountTokens(text: string): number {
  if (!text) return 0;
  // CJK chars tokenize ~1:1 (some providers split rare glyphs further, but
  // 1:1 is the right default bias). Count them directly, then estimate the
  // non-CJK remainder with chars/4.
  const cjk = text.match(CJK_TOKEN_RE);
  const cjkCount = cjk?.length ?? 0;
  // Supplementary-plane matches occupy TWO UTF-16 units each in text.length;
  // subtract their full unit footprint (not the char count) or their second
  // unit leaks into the chars/4 remainder (#4315).
  const cjkUnits = cjk?.join("").length ?? 0;
  return cjkCount + Math.ceil((text.length - cjkUnits) / 4);
}

export function estimateMessageTokens(text: string | undefined): number {
  return defaultCountTokens(text ?? "");
}

/** Guarded contribution of a host-projected thinking payload to the metered
 *  message size. Non-finite or non-positive values are treated as absent (0),
 *  so a bad host value can never poison the accounting. */
export function thinkingTokenValue(thinking: number | undefined): number {
  return typeof thinking === "number" &&
    Number.isFinite(thinking) &&
    thinking > 0
    ? thinking
    : 0;
}

/** Total metered size of a core message: visible text plus any host-projected
 *  thinking payload (CoreMessage.thinkingTokens). Every per-message counting
 *  site (range recommendations, block compressedTokens, status reports, context
 *  breakdown) goes through this so all surfaces share one caliber. */
export function countMessageTokens(
  message: { text?: string; thinkingTokens?: number },
  countTokens: TokenCountFn = defaultCountTokens,
): number {
  return (
    countTokens(message.text ?? "") + thinkingTokenValue(message.thinkingTokens)
  );
}

export function estimateTokensFast(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export type TokenCountFn = (text: string) => number;

const BPE_SIZE_GUARD = 100_000;

export function createBpeTokenizer(): TokenCountFn {
  try {
    const mod = require("@anthropic-ai/tokenizer");
    const bpeCount = mod.countTokens ?? mod.default?.countTokens;
    if (typeof bpeCount !== "function") return defaultCountTokens;
    return (text: string) => {
      if (text.length > BPE_SIZE_GUARD) return defaultCountTokens(text);
      try {
        return bpeCount(text);
      } catch {
        return defaultCountTokens(text);
      }
    };
  } catch {
    return defaultCountTokens;
  }
}
