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

/**
 * The display title for a session row, shared by every surface that shows a
 * session's name (web list, web detail handoff, `bili export` list + handoff).
 *
 * A host-provided name (pi /name) always wins. Otherwise, when the stored
 * title is the subagent dispatch boilerplate and a first-block topic exists,
 * the topic is shown instead: the boilerplate is byte-identical across every
 * child session and identifies nothing, while the first block's topic is the
 * task the child actually worked on. #7590/#7595.
 *
 * `title` may be the already-merged `hostTitle ?? title` (the storage fast
 * path) — the hostTitle parameter disambiguates, so a host name still wins.
 * Returns undefined when there is no title at all (callers render their own
 * "(untitled)" / 无标题 fallback).
 */
export function displaySessionTitle(
    hostTitle: string | null | undefined,
    title: string | null | undefined,
    firstBlockTopic: string | null | undefined,
): string | undefined {
    const stored = hostTitle || title;
    if (!stored) return undefined;
    if (hostTitle) return stored;
    if (firstBlockTopic && isSubagentPrompt(stored)) return firstBlockTopic;
    return stored;
}

/**
 * The first-block topic/summary lead as a list hint: whitespace-normalized,
 * capped at 48 chars — the exact value the web list's firstBlockHint shows,
 * so every surface that falls back to it renders the same string. #7590/#7595.
 */
export function topicLeadFrom(
    topic: string | null | undefined,
    summary: string | null | undefined,
): string | undefined {
    const raw = topic || summary;
    if (!raw) return undefined;
    let hint = String(raw).replace(/\s+/g, " ").trim();
    if (!hint) return undefined;
    if (hint.length > 48) hint = hint.slice(0, 48) + "…";
    return hint;
}

/** First compression block's topic (or summary lead) as a hint, from an in-memory block list. */
export function firstBlockTopicLead(
    blocks: ReadonlyArray<{ topic?: string; summary?: string }>,
): string | undefined {
    const fb = blocks.find((b) => b.topic || b.summary);
    if (!fb) return undefined;
    return topicLeadFrom(fb.topic, fb.summary);
}
