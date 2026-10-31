/**
 * Evaluation-only reference frozen from src/decompress-shared.ts at
 * b0b0e66ff085b08e8e26c02f1f79ad2a8849a496. Keep this independent of the new
 * extractor/ranker so regressions cannot silently redefine the baseline.
 * The unchanged overlap sorter also accepts extracted terms for ablation.
 * Kernel tool-pattern matching is unchanged by this experiment.
 */
import { matchToolMessagePattern, toolPathOf, type CompressionBlock, type CoreMessage } from "acp-kernel";

export const LEGACY_PLAN_COMMIT = "b0b0e66ff085b08e8e26c02f1f79ad2a8849a496";
const PLANNING_TOOL_PATTERNS = ["TodoWrite", "todowrite", "todo_list", "update_plan", "TaskCreate", "TaskUpdate"];
const PLAN_WINDOW_MESSAGES = 40;
const PLAN_TEXT_CHAR_CAP = 4000;
const PLAN_STOPWORDS = new Set([
    "the", "and", "for", "with", "this", "that", "from", "have", "has", "had",
    "was", "were", "are", "will", "would", "should", "could", "can", "may",
    "into", "onto", "over", "under", "about", "after", "before", "between",
    "each", "all", "any", "some", "not", "but", "then", "than", "when",
    "while", "where", "which", "who", "what", "how", "why", "because",
    "being", "done", "todo", "todos", "task", "tasks", "status", "pending",
    "in_progress", "completed", "cancelled", "progress", "update", "updates",
    "step", "steps", "item", "items", "list", "plan",
]);

function planTokenize(text: string): string[] {
    const out: string[] = [];
    const clean = text.replace(/\x3cacp\b[\s\S]*?\x3c\/acp\x3e/g, " ");
    const re = /[a-z0-9]+|[\u4e00-\u9fff]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean.toLowerCase())) !== null) {
        const t = m[0];
        const cjk = /[\u4e00-\u9fff]/.test(t);
        if (!cjk && t.length < 3) continue;
        if (!cjk && PLAN_STOPWORDS.has(t)) continue;
        out.push(t);
    }
    return out;
}

export function legacyExtractPlanState(messages: CoreMessage[], extraPatterns?: string[]): { terms: Map<string, number> } | null {
    const patterns = [...new Set([...PLANNING_TOOL_PATTERNS, ...(extraPatterns ?? [])])];
    const start = Math.max(0, messages.length - PLAN_WINDOW_MESSAGES);
    const latestByPattern = new Map<string, CoreMessage>();
    let lastUserText: string | undefined;
    for (let i = start; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.contentType === "tool-call" && msg.toolName) {
            for (const p of patterns) {
                if (matchToolMessagePattern(msg, p)) {
                    latestByPattern.set(p.includes("/") ? toolPathOf(msg) : p, msg);
                    break;
                }
            }
        } else if (msg.role === "user" && msg.contentType === "text" && msg.text) {
            lastUserText = msg.text;
        }
    }
    const sources: Array<{ text: string; weight: number }> = [];
    for (const msg of latestByPattern.values()) if (msg.text) sources.push({ text: msg.text, weight: 2 });
    if (lastUserText) sources.push({ text: lastUserText, weight: 1 });
    if (sources.length === 0) return null;
    const terms = new Map<string, number>();
    for (const { text, weight } of sources) {
        const capped = text.length > PLAN_TEXT_CHAR_CAP ? text.slice(0, PLAN_TEXT_CHAR_CAP) : text;
        for (const tok of planTokenize(capped)) terms.set(tok, (terms.get(tok) ?? 0) + weight);
    }
    return terms.size > 0 ? { terms } : null;
}

function planBlockScore(topic: string | undefined, summary: string, terms: Map<string, number>): number {
    const hay = `${topic ?? ""}\n${summary}`.toLowerCase();
    let score = 0;
    for (const [term, weight] of terms) {
        if (!hay.includes(term)) continue;
        let count = 0;
        let index = hay.indexOf(term);
        while (index !== -1) {
            count++;
            index = hay.indexOf(term, index + term.length);
        }
        score += weight * count;
    }
    return score;
}

export function legacyPlanRank(
    pool: readonly CompressionBlock[],
    messages: CoreMessage[],
    limit: number,
    extraPatterns?: string[],
): string[] {
    return legacyRankTerms(pool, legacyExtractPlanState(messages, extraPatterns)?.terms ?? null, limit);
}

export function legacyRankTerms(pool: readonly CompressionBlock[], terms: Map<string, number> | null, limit: number): string[] {
    if (!terms || pool.length <= limit) return pool.slice(0, limit).map((block) => block.blockId);
    return pool.map((block, index) => ({ block, index, score: planBlockScore(block.topic, block.summary, terms) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map(({ block }) => block.blockId);
}

/**
 * Exercise the real legacy fallback and renderer without mocking core.search.
 * A punctuation suffix invalidates JSON but is invisible to the old tokenizer.
 * Appending also preserves the original text at the inspection-cap boundary.
 * The runner asserts token and ranking parity with the frozen code above.
 */
export function legacyFallbackMessages(messages: CoreMessage[]): CoreMessage[] {
    return messages.map((message) => {
        if (message.contentType !== "tool-call"
            || (message.toolName !== "TodoWrite" && message.toolName !== "todowrite")
            || !message.text) return message;
        return { ...message, text: `${message.text}!` };
    });
}
