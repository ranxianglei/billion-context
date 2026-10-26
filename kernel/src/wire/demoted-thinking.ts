/** Inline "demoted thinking" normalization.
 *
 * Hosts that cannot replay prior-turn reasoning as a structured block
 * (pi-ai transform-messages demotion on model switch, openai-completions
 * `requiresThinkingAsText` profiles, gateways that inline native
 * reasoning) fold it INTO the assistant content string wrapped in a
 * dialect tag:
 *
 *   glm / deepseek / kimi / qwen3 / hermes : <think>\n{text}\n</think>
 *   anthropic / minimax / xml              : <thinking>\n{text}\n</thinking>
 *   gemini                                 : ```thinking\n{text}\n```
 *
 * followed by a single "\n" glue before the next content block. The same
 * logical turn can therefore arrive as a `reasoning_content` field (or a
 * separate reasoning item on /v1/responses) OR as this inline form. If the
 * wire codecs kept both as one text blob, the two serializations of one
 * turn would land in DIFFERENT core-id/fingerprint spaces — exactly the
 * issue #64 "restart loses blocks" class, where the mirror produced one
 * form and the live wire the other.
 *
 * splitDemotedThinking() reverses the rendering byte-exactly so both
 * codecs can normalize before identity derivation (deriveMessageId). It
 * only fires when the tag opens at offset 0 of the content, which is the
 * only position the demotion renderer can produce it in.
 *
 * One form is intentionally NOT recoverable here: the pi-ai anthropic
 * dialect demotes to BARE text (no tag), which is indistinguishable from
 * ordinary assistant prose; that case must be aligned upstream (mirror
 * uses the same bare rendering), not parsed. */

export type DemotedSplit = {
  reasoning: string;
  text: string;
};

type DelimitedForm = {
  open: string;
  close: string;
};

/** The three inline tag forms hosts actually emit (see file comment). */
const FORMS: readonly DelimitedForm[] = [
  { open: "<think>\n", close: "\n</think>" },
  { open: "<thinking>\n", close: "\n</thinking>" },
  { open: "```thinking\n", close: "\n```" },
];

/** If `content` starts with one or more inline demoted-thinking blocks,
 *  split them out. Returns null when no tag opens the content (the common
 *  case — including every user message and every assistant message whose
 *  reasoning traveled as a field/item), in which case callers keep the
 *  content as-is. Malformed (unterminated) or empty blocks do not match;
 *  the content is then treated as plain text, never dropped. */
export function splitDemotedThinking(content: string): DemotedSplit | null {
  let rest = content;
  const parts: string[] = [];
  for (;;) {
    let matched = false;
    for (const form of FORMS) {
      if (!rest.startsWith(form.open)) continue;
      const end = rest.indexOf(form.close, form.open.length);
      if (end < 0) continue;
      const inner = rest.slice(form.open.length, end);
      if (inner.length === 0) continue;
      parts.push(inner);
      rest = rest.slice(end + form.close.length);
      // Glue the demotion renderer inserts between a demoted block
      // and the block that follows it.
      if (rest.startsWith("\n")) rest = rest.slice(1);
      matched = true;
      break;
    }
    if (!matched) break;
  }
  if (parts.length === 0) return null;
  return { reasoning: parts.join("\n"), text: rest };
}
