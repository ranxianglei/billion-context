/**
 * #memory-toc: Session Memory Table of Contents (TOC).
 *
 * Compression folds turns into blocks (`b1`, `b2`, …) and only the summaries
 * stay in context. Once a session outgrows a handful of folds the model loses
 * track of WHAT lives in memory: it either re-derives decisions it already
 * made, or searches blind with a keyword it guessed. A one-line index of the
 * active blocks fixes both — the model sees the milestones by name and can go
 * straight to `decompress({ blockId })` / `search_context({ query })`.
 *
 * The index is DELIBERATELY windowed (`compress.memoryTocWindow`, default 10).
 * `search_context` already scans every block of the session, active or not, so
 * listing every historical milestone would buy nothing and cost a line per
 * block on EVERY turn. The window keeps the recent, most-cited milestones
 * inline plus an overflow line naming the older range — the model learns the
 * backlog exists and that search reaches it, without paying for the list.
 */

export interface BlockTocItem {
    blockId: string;
    active?: boolean;
    topic?: string;
    summary?: string;
    tier?: number;
    effectiveMessageIds?: readonly string[];
}

interface RenderTocOptions {
    /** Number of MOST RECENT active blocks to list (default 10). Older blocks
     *  collapse into a single overflow line; `search_context` still reaches
     *  them. A value <= 0 lists every active block (legacy behaviour). */
    window?: number;
    /** Custom heading text. */
    header?: string;
}

/** Default number of recent blocks rendered inline. */
export const DEFAULT_TOC_WINDOW = 10;

/** Upper bound accepted by the knob so a typo cannot blow up the prompt. */
const MAX_TOC_WINDOW = 200;

/**
 * Extract a concise topic from block.summary when block.topic is unset.
 */
export function extractTopicFromSummary(summary: string): string {
    if (!summary) return "(untitled)";

    // 1. Check for [Compressed conversation section] — <topic>
    const headerMatch = /^(?:\[Compressed conversation section\]\s*[—–-]\s*)([^\n]+)/m.exec(summary);
    if (headerMatch && headerMatch[1]?.trim()) {
        return headerMatch[1].trim();
    }

    // 2. Check for markdown headings: ### Topic or ## Topic or # Topic
    const headingMatch = /^\s*#{1,4}\s+([^\n]+)/m.exec(summary);
    if (headingMatch && headingMatch[1]?.trim()) {
        const text = headingMatch[1].trim();
        // Skip generic boilerplate headings if possible
        if (!/^Overall Goal/i.test(text) && !/^Context/i.test(text) && text.length > 3) {
            return text;
        }
    }

    // 3. Fallback: first non-empty line without markdown bullets
    const lines = summary.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        const clean = line.replace(/^[-*•#\s]+/, "").trim();
        if (clean.length > 5 && !clean.startsWith("[") && !clean.startsWith("TASK AS OF")) {
            return clean.length > 70 ? clean.slice(0, 67) + "..." : clean;
        }
    }
    return "(untitled)";
}

/** One rendered TOC line: `- b12 (T2): MariaDB migration`. */
function renderTocLine(b: BlockTocItem): string {
    const rawTopic = (b.topic && b.topic.trim()) ? b.topic.trim() : extractTopicFromSummary(b.summary ?? "");
    const topic = rawTopic.replace(/[\r\n]+/g, " ").trim();
    const tier = typeof b.tier === "number" && b.tier > 1 ? ` (T${b.tier})` : "";
    return `- ${b.blockId}${tier}: ${topic}`;
}

/**
 * Render a high-density, one-line-per-block index of the most recent active
 * blocks. Returns `null` if no active blocks exist.
 */
export function renderMemoryToc(
    blocks: readonly BlockTocItem[] | undefined,
    options: RenderTocOptions = {},
): string | null {
    if (!blocks || blocks.length === 0) return null;
    const active = blocks.filter((b) => b.active !== false);
    if (active.length === 0) return null;

    const rawWindow = options.window ?? DEFAULT_TOC_WINDOW;
    const window = Number.isFinite(rawWindow) ? Math.trunc(rawWindow) : DEFAULT_TOC_WINDOW;
    // window <= 0 keeps the pre-window behaviour: list everything.
    const shown = window > 0 ? Math.min(window, MAX_TOC_WINDOW) : active.length;
    const displayed = shown >= active.length ? active : active.slice(-shown);
    const omitted = active.length - displayed.length;

    const lines = displayed.map(renderTocLine);
    if (omitted > 0) {
        // Name the hidden range AND the retrieval path: the model must not read
        // a windowed index as "nothing older exists".
        const firstHidden = displayed.length > 0 ? displayed[0] : undefined;
        const olderIds = active.slice(0, omitted).map((b) => b.blockId);
        const range = olderIds.length > 0
            ? `${olderIds[0]}${olderIds.length > 1 ? `–${olderIds[olderIds.length - 1]}` : ""}`
            : "";
        const rangeNote = range ? ` (${range})` : "";
        lines.unshift(
            `... ${omitted} older block(s)${rangeNote} not listed — they ARE in memory; ` +
            `use search_context({ query }) to locate one, then decompress({ blockId }) for the full text` +
            (firstHidden ? "" : "") + ".",
        );
    }

    const header = options.header ?? "### Active Session Memory Index\nCompressed milestones in this session (call search_context({ query }) or decompress({ blockId }) to inspect details):";
    return `${header}\n${lines.join("\n")}`;
}

/**
 * Normalize a raw window value from env or config file.
 * Accepts an integer, or a numeric string. Anything else ⇒ undefined.
 */
export function normalizeTocWindow(raw: unknown): number | undefined {
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
    if (typeof raw === "string" && raw.trim().length > 0) {
        const n = Number(raw.trim());
        if (Number.isFinite(n)) return Math.trunc(n);
    }
    return undefined;
}

/**
 * Resolve the TOC window:
 *   env `BILI_MEMORY_TOC_WINDOW` > config `compress.memoryTocWindow` > default.
 * A value <= 0 means "list every active block".
 */
export function resolveMemoryTocWindow(
    env: NodeJS.ProcessEnv = process.env,
    fileValue?: number,
): number {
    const fromEnv = normalizeTocWindow(env.BILI_MEMORY_TOC_WINDOW);
    if (fromEnv !== undefined) return fromEnv;
    const fromFile = normalizeTocWindow(fileValue);
    if (fromFile !== undefined) return fromFile;
    return DEFAULT_TOC_WINDOW;
}

/**
 * Knob resolver for Memory TOC:
 * Env BILI_MEMORY_TOC wins over config file setting.
 * Defaults to true if not explicitly disabled.
 */
export function resolveMemoryToc(env: NodeJS.ProcessEnv = process.env, fileValue?: boolean): boolean {
    const raw = env.BILI_MEMORY_TOC?.trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "off") return false;
    if (raw === "1" || raw === "true" || raw === "on") return true;
    return typeof fileValue === "boolean" ? fileValue : true;
}
