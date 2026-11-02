import type { CoreMessage } from "./types.js";
import { isSignedThinkingFamily } from "./turn-integrity.js";

/**
 * Adjust compression range boundaries to keep a `reasoning` message together
 * with the assistant text/tool-call it belongs to.
 *
 * Reasoning models (DeepSeek-R1, GLM-4.6 thinking, Qwen-QwQ, Anthropic
 * thinking) emit a `reasoning_content` / thinking block that strict providers
 * require to be echoed back alongside the response on every subsequent
 * request. In acp-kernel that block is a separate `contentType: "reasoning"`
 * message immediately preceding the assistant text/tool-call of the same turn.
 * If a compression range covers only one half of the pair, the rebuilt
 * conversation ships reasoning without its response (or vice versa) and the
 * provider returns HTTP 400 (DeepSeek: "reasoning_content in the thinking mode
 * must be passed back to the API").
 *
 * This is the reasoning analogue of {@link adjustBoundariesForToolPairs}:
 * before a range is applied, pull the orphan half INTO the range so the pair
 * compresses together — zero information loss. Only MESSAGE-boundary ranges
 * are adjusted (block-boundary ranges are left untouched, like tool pairs).
 *
 * Pairing is adjacency-based — there is no shared id (unlike toolCallId). A
 * `reasoning` message pairs with the assistant text/tool-call immediately
 * following its reasoning run, and an assistant text/tool-call pairs with the
 * reasoning run immediately preceding it. This matches the round-trip contract
 * every adapter relies on when reconstructing reasoning_content.
 *
 * Signed extension (#4885): for UNSIGNED reasoning the adjacency rule above
 * holds exactly (the #564 directional allowance depends on it). When the
 * stretch preceding a burst carries a SIGNED thinking-family block (Anthropic
 * thinking signature / redacted_thinking sidecar), the backward pull widens to
 * the whole consecutive reasoning+assistant-text stretch instead: rebuild
 * merges that stretch into one provider message, so leaving any part of it
 * behind orphans the signature (permanent 400). See
 * isSignedThinkingFamily (turn-integrity.ts) for the predicate.
 *
 * @returns Adjusted { startIndex, endIndex } — may be wider than input.
 */
export function adjustBoundariesForReasoningPairs(
  startIndex: number,
  endIndex: number,
  messages: CoreMessage[],
): { startIndex: number; endIndex: number } {
  if (startIndex > endIndex) {
    return { startIndex, endIndex };
  }
  let newStartIndex = startIndex;
  let newEndIndex = endIndex;

  for (let i = startIndex; i <= endIndex && i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.contentType === "reasoning") {
      // Forward: pull the companion assistant text/tool-call that follows
      // this reasoning run into the range.
      let j = i;
      while (
        j + 1 < messages.length &&
        messages[j + 1]!.contentType === "reasoning"
      ) {
        j++;
      }
      const companion = messages[j + 1];
      if (
        companion !== undefined &&
        companion.role === "assistant" &&
        (companion.contentType === "text" ||
          companion.contentType === "tool-call")
      ) {
        // Pull the WHOLE assistant burst following the reasoning run, not just
        // the first companion (#684): a turn may carry several tool-calls, and
        // pulling one leaves its siblings outside the range. The composed
        // fixpoint's tool-pair pass then widens for every result.
        let e = j + 1;
        while (
          e + 1 < messages.length &&
          messages[e + 1]!.role === "assistant" &&
          (messages[e + 1]!.contentType === "text" ||
            messages[e + 1]!.contentType === "tool-call")
        ) {
          e++;
        }
        if (e > newEndIndex) newEndIndex = e;
      }
    }

    if (
      msg.role === "assistant" &&
      (msg.contentType === "text" || msg.contentType === "tool-call")
    ) {
      // Backward: pull the reasoning run immediately preceding this assistant
      // message into the range (legacy adjacent-run behavior — unchanged for
      // unsigned wires, where the #564 directional allowance depends on it).
      let k = i - 1;
      while (k >= 0 && messages[k]!.contentType === "reasoning") {
        k--;
      }
      const runStart = k + 1;
      const legacyPull =
        runStart < i &&
        runStart >= 0 &&
        messages[runStart]!.contentType === "reasoning" &&
        runStart < newStartIndex;
      // #4885: rebuild merges the whole consecutive-assistant stretch into ONE
      // provider message, so a signed thinking block must never be left behind
      // by a fold. The adjacent scan above stops at the FIRST non-reasoning
      // message, which orphans the signature when prose sits between the
      // thinking and its tool_use ([thinking][text][tool_use], redacted_
      // thinking separators, multiple thinking blocks) — permanent 400 on the
      // Anthropic wire. When the stretch preceding this burst carries a signed
      // thinking-family block, pull the ENTIRE stretch (contiguous reasoning +
      // assistant-text, stopping at anything else — tool results and foreign
      // tool-calls always break it) into the range instead.
      let s = i;
      while (
        s > 0 &&
        messages[s - 1]!.role === "assistant" &&
        (messages[s - 1]!.contentType === "text" ||
          messages[s - 1]!.contentType === "tool-call")
      ) {
        s--;
      }
      let u = s - 1;
      let stretchStart = s;
      let signedInStretch = false;
      while (
        u >= 0 &&
        (messages[u]!.contentType === "reasoning" ||
          (messages[u]!.role === "assistant" &&
            messages[u]!.contentType === "text"))
      ) {
        if (!signedInStretch && isSignedThinkingFamily(messages[u]!))
          signedInStretch = true;
        u--;
        stretchStart = u + 1;
      }
      if (signedInStretch && stretchStart < newStartIndex) {
        newStartIndex = stretchStart;
      } else if (legacyPull) {
        newStartIndex = runStart;
      }
    }
  }

  return { startIndex: newStartIndex, endIndex: newEndIndex };
}
