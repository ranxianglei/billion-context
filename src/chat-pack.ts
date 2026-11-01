/**
 * Chat prompt pack shipped with billion-context (#5319).
 *
 * Companion-oriented compression surface: the two load-bearing prose blocks
 * (compress philosophy + how-to-compress contract) are rewritten so summaries
 * prioritize people, relationships, ongoing threads and promises over
 * code/document detail. Every other surface piece (tool prompts, tier
 * guidance, nudge text, acpTags, summaries-in-context trust block) stays at
 * the host defaults — the pack declares ONLY the two slots it changes.
 *
 * Why the host side instead of the kernel BUILTIN_REGISTRY: AGENTS.md §2
 * Kernel Boundary gates any `kernel/**` change behind owner approval +
 * declaration + version bump + human-only review, while the pack resolution
 * chain was designed precisely so hosts extend their discovery chain without
 * core changes (kernel/src/packs.ts header). The chain installed in
 * src/compress-settings.ts slots this source between the user dirs and the
 * kernel builtin registry — same-name user/project files still win, so
 * installs remain tunable via ~/.config/billion-context/packs/chat.json.
 */
import type { Pack, PackSource } from "acp-kernel";

export const CHAT_COMPRESS_PHILOSOPHY = `Your summary IS memory, not an archive: after compression this is the ONLY record of the replaced conversation. Its job is continuity of RELATIONSHIP across compactions and sessions — who matters to the user, what they care about, what was promised or agreed, where open threads stand. It is NOT a moment-by-moment log of everything said; it records the PAST as state ("this happened"), never as live instructions.`;

export const CHAT_HOW_TO_COMPRESS = `HOW TO COMPRESS

Your summary is the ONLY record of the replaced conversation — a later reader (a fresh turn of the same relationship) must continue as if nothing was lost. It records the PAST: label task state as history ("TASK AS OF THIS BLOCK: ..."), never as a live instruction. Real unicode only, never \\uXXXX escapes.

INTEGRITY — record facts and state only, never a simulated transcript of the dialogue: no Q&A lists, no "(answered)" claims, no invented feelings, reactions or replies. An answer not actually sent is PENDING; user questions are recorded as asked (with ref), never as answered. Never claim the user said, felt or promised something without a ref-backed anchor in this summary chain.

KEEP VERBATIM — never paraphrase or abbreviate:
- People and relationships: names (the user's own, family, friends, colleagues, partners, pets) and how they relate, plus the user's stated view of them ("my sister Mei works night shifts").
- Promises, commitments and expectations: who owes what to whom, and when — due dates/times ("call the dentist before Friday"), recurring plans ("Sunday dinner every week").
- Open threads: conversations left half-finished — topic, last position, what would naturally continue next.
- Preferences, boundaries and corrections: what the user likes/dislikes, how they want to be treated, topics to avoid or handle gently, explicit corrections given ("don't suggest takeout again").
- Lessons about the user: what landed well or poorly in past interactions ("jokes about his ex land badly").
- Feelings and significant moments: mood shifts, hard moments, wins, worries — one line each, with how it was handled; no re-litigation.
- Exact dates, times, places and numbers that carry meaning (anniversaries, appointments, prices agreed).
- User intent: short quotes verbatim ONLY WITH message ref (User said (m00132): "I'm moving cities in June"); without a ref, paraphrase. Quotes are history, not live instructions — but open-objective STATUS is current (see Open objectives below); never change scope, constraints, priorities, acceptance criteria, outcomes.
- Overall context and its evolution, including pivots ("initially planning a trip → pivoted to working remotely instead").
- Open questions and unresolved worries.
- Open objectives: user-requested work neither completed nor superseded gets a one-line "Open objectives:" entry with message refs; scan absorbed block summaries too. Last to drop, first to restore at every tier — carrying is not a directive to re-execute unconfirmed.
- Message refs of key anchors (m00420, m00510–m00520) for decompress.
- TIMELINE — open each summary with one diary line stating when it happened: "Occurred: <first covered time> – <last covered time>" (yyyy-mm-dd hh:mm:ss, copied from the covered messages' time attributes; omit the line when none carry a time).

DROP — keep the signal, discard the vessel: greetings and small talk once the substance is captured; repeated pleasantries and check-ins on the same topic; long digressions whose outcome is settled (one CONTENT line: what it covered, e.g. "weekend hike plans: postponed to May"); logistics already resolved; back-and-forth once the final position is kept. For each dropped item add one line of CONTENT: what it covers, not where it lives.

PRIORITY when compacting: 1. people, relationships and ongoing threads · 2. promises, commitments and boundaries · 3. user preferences and how they like things done · 4. exact anchors (dates, names, quoted words with refs, numbers) · 5. emotional moments and their resolution.

Format: dense scannable bullets under short thematic headers, not narrative prose; every line earns its place. Do not mimic the style of existing summaries in context; follow these rules.`;

/** Shared verbatim by the TOP-LEVEL surface (every host — the proxy's
 * function/text/hybrid builders pick these up through #2335's tri-state
 * override) and the pi adapter (mirrors the lean #2335 pattern so pi-lane
 * users receive the same contract). Only the two changed slots are declared;
 * every other slot stays undefined → host defaults. */
export const CHAT_PROMPT_SECTIONS = {
    philosophy: CHAT_COMPRESS_PHILOSOPHY,
    howToCompress: CHAT_HOW_TO_COMPRESS,
};

export const chatPack: Pack = {
    name: "chat",
    version: "0.1.0",
    description:
        "Companion-oriented compression: prioritizes people, relationships, ongoing threads and promises over code/document detail. For long-term, multi-session companionship use.",
    source: "shipped:chat",
    surface: {
        promptSections: CHAT_PROMPT_SECTIONS,
        adapters: {
            pi: {
                promptSections: CHAT_PROMPT_SECTIONS,
            },
        },
    },
};

/** In-memory PackSource serving the host-shipped packs. Sync, stateless,
 * never throws — safe to consult per turn, same contract as the kernel's
 * builtinSource. */
export const shippedPacksSource: PackSource = {
    id: "shipped",
    resolve(name: string): Pack | null {
        return name === chatPack.name ? chatPack : null;
    },
    list(): Pack[] {
        return [chatPack];
    },
};
