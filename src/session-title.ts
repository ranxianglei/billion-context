/**
 * Title/display helpers for agent-spawned subagent sessions.
 *
 * OpenCode's task/subagent tool sends the child a user-role dispatch prompt
 * that starts with this exact sentence. The prompt is machine-generated and
 * repeats verbatim across every child session, so using it as the session
 * title produces a list full of identical rows (#2118/#2286 established the
 * same rule for other host-injected user-role fragments).
 *
 * Keep this marker evidence-based: it is a fixed protocol string, not a
 * keyword filter. The dispatch envelope itself is parsed separately in
 * subagent-sessions.ts; this helper only covers the prompt text that reaches
 * the title deriver.
 */
export const SUBAGENT_PROMPT_PREFIX = "You are a subagent spawned by another session.";

export function isSubagentPrompt(text: string | undefined): boolean {
    const t = (text ?? "").trim();
    if (!t) return false;
    return t.length >= SUBAGENT_PROMPT_PREFIX.length
        && t.slice(0, SUBAGENT_PROMPT_PREFIX.length).toLowerCase() === SUBAGENT_PROMPT_PREFIX.toLowerCase();
}