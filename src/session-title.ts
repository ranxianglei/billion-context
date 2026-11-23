/**
 * Title/display helpers for agent-spawned subagent sessions.
 *
 * OpenCode's subagent dispatch sends the child ONE user-role message: the
 * machine-written prefix below, a newline, then the parent's task text
 * (anomalyco/opencode packages/core/src/tool/plugin/subagent.ts and
 * config/plugin/command.ts: [SUBAGENT_PROMPT_PREFIX, prompt].join("\n")).
 * The prefix repeats verbatim across every child session, so the raw
 * message makes a list full of identical rows; the task after the prefix
 * is the real title source. #2118/#2286 established the same
 * evidence-permitlist discipline for other host-injected user-role
 * fragments.
 *
 * Keep this marker evidence-based: it is a fixed protocol string, not a
 * keyword filter. The dispatch envelope itself is parsed separately in
 * subagent-sessions.ts; this helper only covers the prompt text that
 * reaches the title deriver.
 */
export const SUBAGENT_PROMPT_PREFIX = "You are a subagent spawned by another session.";

const SUBAGENT_PROMPT_PREFIX_CI = SUBAGENT_PROMPT_PREFIX.toLowerCase();

export function isSubagentPrompt(text: string | undefined): boolean {
    const t = (text ?? "").trim();
    if (!t) return false;
    return t.length >= SUBAGENT_PROMPT_PREFIX.length
        && t.slice(0, SUBAGENT_PROMPT_PREFIX.length).toLowerCase() === SUBAGENT_PROMPT_PREFIX_CI;
}

/**
 * The parent's task text after the dispatch prefix. undefined when the text
 * is not a dispatch prompt; "" when it is one with no task after the prefix.
 */
export function subagentPromptTask(text: string | undefined): string | undefined {
    const t = (text ?? "").trim();
    if (!isSubagentPrompt(t)) return undefined;
    return t.slice(SUBAGENT_PROMPT_PREFIX.length).trim();
}
