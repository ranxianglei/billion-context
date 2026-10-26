/** Short topic for a block when the model did not provide one: first sentence
 *  segment, leading quotes stripped, truncated to 30 chars with an ellipsis.
 *  Used wherever block lists are rendered (panels, search results). */
import { clampPrefix } from "../truncate.js";

export function topicFallback(summary: string): string {
  const first = summary.split(/[.\n]/)[0] ?? "";
  const t = first
    .trim()
    .replace(/^["'`]+/, "")
    .trim();
  return t.length <= 30 ? t : `${clampPrefix(t, 30).trimEnd()}…`;
}
