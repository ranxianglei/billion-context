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

/** System-prompt section name carrying the acp_delegate prompt. */
export const DELEGATE_PROMPT_SECTION = "acp_delegate";

type BeforeAgentStartShape = {
  systemPrompt?: string | string[];
  systemPromptOptions?: { sections?: unknown; forceSystemPrompt?: unknown };
};

/** Add `content` to a before_agent_start event as the named system-prompt
 *  section, falling back to a returned systemPrompt append.
 *
 *  The section form is required for hosts that rebuild the prompt from its
 *  structured parts: pi-claude-bridge forwards systemPromptOptions.sections to
 *  Claude Code and drops a handler-returned systemPrompt. Section support is
 *  detected by effect — pi 1.x renders `event.systemPrompt` live from the
 *  mutable options, so the rendered prompt changes once the section lands.
 *
 *  Two cases also return the append:
 *  - An earlier handler forced the prompt. pi renders the forced text verbatim
 *    and ignores sections, so the append carries the prompt for pi, while the
 *    section stays for hosts that read the structured parts.
 *  - The rendered prompt did not change (options are informational, as in
 *    pi 0.83). The section is withdrawn so it never renders in addition to
 *    the append.
 *  Returns the handler result (undefined = the section alone carries it). */
export function addPromptSection(event: unknown, name: string, content: string): { systemPrompt: string } | undefined {
  const e = event as BeforeAgentStartShape;
  const sections = e.systemPromptOptions?.sections;
  const body = content.trim();
  if (body.length > 0 && sections !== null && typeof sections === "object" && !Array.isArray(sections)) {
    const map = sections as Record<string, string>;
    const forced = typeof e.systemPromptOptions?.forceSystemPrompt === "string";
    const before = normalizeSystemPrompt(e.systemPrompt);
    const previous = map[name];
    map[name] = body;
    if (!forced) {
      if (previous === body || normalizeSystemPrompt(e.systemPrompt) !== before) return undefined;
      if (previous === undefined) delete map[name];
      else map[name] = previous;
    }
  }
  return { systemPrompt: formatSystemPromptForEvent(e.systemPrompt ?? "", content) };
}
