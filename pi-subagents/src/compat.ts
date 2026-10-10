/** Normalize systemPrompt to a single string (join with newlines if array). */
export function normalizeSystemPrompt(input: string | string[] | undefined): string {
  if (input === undefined) return "";
  if (Array.isArray(input)) return input.join("\n");
  return input;
}

/** Append this package's prompt section to the host's current system prompt.
 *  Always returns a string to satisfy pi's type definition, but handles both
 *  string (pi) and string[] (omp) input types at runtime. */
export function formatSystemPromptForEvent(base: string | string[], append: string): string {
  const normalized = normalizeSystemPrompt(base);
  return `${normalized}\n\n${append}`;
}

/** Compose this package's appendix onto the before_agent_start system prompt so
 *  it coexists with other extensions regardless of load order (#2531 /
 *  billion-context-pi#630). pi >= 0.87 exposes a live `get systemPrompt()`
 *  getter and maps a returned `{ systemPrompt }` to `forceSystemPrompt`, whose
 *  state builder returns ONLY the forced text and silently drops every other
 *  extension's `appendSystemPrompt` — so on that shape we append to
 *  `systemPromptOptions.appendSystemPrompt` and do NOT force. pi <= 0.86 exposes
 *  a plain string and consumes only a returned replacement (option mutations are
 *  ignored), so we fall back to the byte-identical replacement. Detection is by
 *  event shape (accessor vs data property), not version number. Idempotent per
 *  options object; returns undefined when nothing was forced. */
export function injectSystemPromptAppendix(
  event: unknown,
  block: string,
): { systemPrompt?: string } | undefined {
  const ev = event as {
    systemPrompt?: string | string[];
    systemPromptOptions?: { appendSystemPrompt?: unknown };
  };
  const desc = Object.getOwnPropertyDescriptor(ev, "systemPrompt");
  if (desc && typeof desc.get === "function") {
    const opts = ev.systemPromptOptions;
    if (!opts || typeof opts !== "object") return undefined;
    const current = typeof opts.appendSystemPrompt === "string" ? opts.appendSystemPrompt : "";
    if (current.includes(block)) return undefined;
    opts.appendSystemPrompt = current ? `${current}\n\n${block}` : block;
    return undefined;
  }
  return { systemPrompt: formatSystemPromptForEvent(ev.systemPrompt ?? "", block) };
}
