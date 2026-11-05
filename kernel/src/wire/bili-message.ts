/**
 * Lossless message bridge between protocol-specific message formats and the
 * kernel's CoreMessage.
 *
 * Problem: `anthropicToCore` / `openaiToCore` / `responsesToCore` flatten
 * rich protocol blocks (images, thinking signatures, tool_result.is_error,
 * developer-role messages, image_url) into plain `{ text }` placeholders.
 * The reverse `coreToX` then can't reconstruct them — `is_error` is lost
 * (upstream can't tell a tool error from a result), `thinking.signature` is
 * lost (Anthropic rejects thinking blocks without a matching signature),
 * images become "[image]" (the model never sees the picture).
 *
 * Solution: `BiliMessage` extends CoreMessage with optional sidecar fields.
 * The kernel only reads `{ ...message }` (spread copy) and known fields, so
 * the extra fields survive the compression pipeline unchanged and arrive back
 * at `coreToX`, which prefers them over the flattened `text`. No `as any`
 * needed — TypeScript array covariance lets `BiliMessage[]` satisfy a
 * `CoreMessage[]` parameter.
 */

import type { CoreMessage } from "acp-kernel";

/** A message that carries its original protocol block(s) verbatim, so the
 *  reverse conversion can reconstruct losslessly. Every field is optional —
 *  plain text messages (the common case) have none set. */
export interface BiliMessage extends CoreMessage {
  /** Anthropic: the original content block for an image, a structured
   *  tool_result, or a redacted_thinking block. Restored verbatim by
   *  coreToAnthropic (redacted_thinking must reach the wire byte-exact —
   *  Anthropic rejects modified thinking-family blocks). */
  rawAnthropicBlock?: unknown;
  /** Anthropic: a whole mid-conversation `role:"system"` wire message
   *  (Pi's `tool_addition` / `tool_removal` deltas, message-level
   *  `output_config`). Re-emitted verbatim by coreToAnthropic as its own
   *  system-role message; kernel-synthesized system cores (rendered
   *  summaries) never carry it and keep their user-role mapping. */
  rawAnthropicMessage?: unknown;
  /** OpenAI chat: the original content part for an image_url (data: or
   *  remote URL) or the original message object for a developer-role
   *  message. */
  rawOpenaiContent?: unknown;
  /** Responses API: the original input item (for input_image, or a raw
   *  function_call / function_call_output we pass through). */
  rawResponsesItem?: unknown;
  /** #3642: this core IS an image part of a split multi-part wire message
   *  (canonical granularity: one core per content part). Set by every codec
   *  at parse time; rebuild paths key off this flag — NEVER off text
   *  equality with the "[image]" marker, because render/ref-tag injection
   *  rewrites the marker text ("[image]<acp ...>") and a wire image part
   *  has no text slot to carry a tag anyway. */
  imagePart?: true;
  /** Google/Gemini: the original content parts of this message, in wire
   *  order (inlineData/fileData, executableCode, functionCall/Response ids,
   *  thought parts and unknown future part types). coreToGoogle rebuilds
   *  the content from these when present, so parts the core does not model
   *  survive a round-trip. */
  rawGoogleParts?: unknown[];
  /** Source wire-message ordinal for this core message, tagged by the
   *  converters (`wireIndex` of the protocol message it was flattened from).
   *  Host-side consumers use it to translate core-space fold coverage back
   *  into wire positions without re-deriving each codec's block-split
   *  behavior. Optional:
   *  converters adopt it incrementally; absence means "unknown". */
  wireIndex?: number;
  /** Anthropic thinking signature. Anthropic verifies thinking+signature
   *  pairs; without it the request is rejected. Stored alongside the
   *  reasoning text so coreToAnthropic can reattach it. */
  thinkingSignature?: string;
  /** Google/Gemini thought signature (thoughtSignature). Gemini 3 validates
   *  the signature of every replayed thought part, so a reasoning core
   *  carries it here for coreToGoogle to reattach. */
  googleThoughtSignature?: string;
  /** OpenAI reasoning_content (chain-of-thought from DeepSeek-R1, GLM-4.6
   *  thinking, Qwen-QwQ). These models require reasoning_content be echoed
   *  back on subsequent requests or the API returns HTTP 400; stored so
   *  coreToOpenai can reattach it. */
  reasoningContent?: string;
  /** OpenAI: the host's wire carried `reasoning_content` with a BLANK value.
   *  Strict-echo thinking models (DeepSeek et al.) reject a replayed
   *  assistant turn whose reasoning_content is MISSING but accept a blank
   *  one, so "blank" and "absent" are different requests. openaiToCore sets
   *  this when it found no reasoning text to store; coreToOpenai re-emits
   *  the key (blank) instead of dropping it. */
  reasoningPresent?: boolean;
  /** Anthropic tool_result.is_error. Marks the tool result as an error so
   *  the model knows the tool failed (not just returned an error string). */
  toolIsError?: boolean;
  /** OpenAI: original role was "developer" (reconstructed as "system" by
   *  openaiToCore for the kernel; coreToOpenai restores "developer"). */
  originalRole?: "system" | "developer";
  /** The original media type for an image (image/png, image/jpeg, image/gif,
   *  image/webp). Lets coreToOpenai/coreToResponses rebuild image_url /
   *  input_image with the right data URL. */
  imageMediaType?: string;
  /** The base64 data of an image (without the data: prefix). Lets the
   *  reverse conversion rebuild the full image payload. */
  imageBase64?: string;
  /** OpenAI chat: ALL original image_url content parts (data: or remote
   *  URL) for a user message carrying more than one image, in wire order.
   *  coreToOpenai re-emits these verbatim (after the text part). The
   *  singular `rawOpenaiContent` still covers the single-image case and
   *  legacy persisted state. Typed as unknown[] (not OpenAIContentPart) to
   *  avoid a circular import with the openai codec. */
  rawOpenaiContentParts?: unknown[];
}

/** Narrow a BiliMessage[] to CoreMessage[] for the kernel. The sidecar fields
 *  are transparently carried along — the kernel's `{ ...msg }` copies them. */
export function toCoreMessages(msgs: BiliMessage[]): CoreMessage[] {
  return msgs as CoreMessage[];
}

/** Re-decode a base64 data URL into media type + data. Returns undefined if
 *  the input is not a recognized data URL. Used by openaiToCore/responsesToCore
 *  to split image_url/input_image into the sidecar fields. */
export function parseDataUrl(
  url: string,
): { mediaType: string; base64: string } | undefined {
  const m = /^data:([^;,]+)(?:;base64)?,(.+)$/i.exec(url);
  if (!m) return undefined;
  return { mediaType: m[1]!, base64: m[2]! };
}
