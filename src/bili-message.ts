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
    /** Anthropic: the original content block for an image or a structured
     *  tool_result. Restored verbatim by coreToAnthropic. */
    rawAnthropicBlock?: unknown;
    /** OpenAI chat: the original content part for an image_url, or the
     *  original message object for a developer-role message. */
    rawOpenaiContent?: unknown;
    /** Responses API: the original input item (for input_image, or a raw
     *  function_call / function_call_output we pass through). */
    rawResponsesItem?: unknown;
    /** Anthropic thinking signature. Anthropic verifies thinking+signature
     *  pairs; without it the request is rejected. Stored alongside the
     *  reasoning text so coreToAnthropic can reattach it. */
    thinkingSignature?: string;
    /** OpenAI reasoning_content (chain-of-thought from DeepSeek-R1, GLM-4.6
     *  thinking, Qwen-QwQ). These models require reasoning_content be echoed
     *  back on subsequent requests or the API returns HTTP 400; stored so
     *  coreToOpenai can reattach it. */
    reasoningContent?: string;
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
}

/** Narrow a BiliMessage[] to CoreMessage[] for the kernel. The sidecar fields
 *  are transparently carried along — the kernel's `{ ...msg }` copies them. */
export function toCoreMessages(msgs: BiliMessage[]): CoreMessage[] {
    return msgs as CoreMessage[];
}

/** Re-decode a base64 data URL into media type + data. Returns undefined if
 *  the input is not a recognized data URL. Used by openaiToCore/responsesToCore
 *  to split image_url/input_image into the sidecar fields. */
export function parseDataUrl(url: string): { mediaType: string; base64: string } | undefined {
    const m = /^data:([^;,]+)(?:;base64)?,(.+)$/i.exec(url);
    if (!m) return undefined;
    return { mediaType: m[1], base64: m[2] };
}
