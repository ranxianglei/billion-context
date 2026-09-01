// search_context handler shared by all three compress loops. Corpus = the
// FOLDED ORIGINALS of active blocks (error text, paths, variable names that
// summaries drop), via the kernel's published engine (hybrid BM25+fuzzy,
// CJK-aware). Visible messages are NOT indexed — they are already in the
// model's attention. Folding only rewrites the view forwarded upstream: the
// client re-sends complete history every turn, so originals live in
// session.lastMessages even though ctx.messages (folded view) has them
// emptied; the blockContents cache (captured at compress time) is the fast
// path and survives client-side history deletion (native compaction).
import {
    collectBlockContent,
    searchBlocks,
    type CompressionBlock,
    type CompressionState,
    type CoreMessage,
    type SearchDoc,
} from "acp-kernel";
import type { Session } from "./session.js";

export function parseSearchContextArgs(args: Record<string, unknown>): { query: string; limit: number } {
    const query = typeof args.query === "string" ? args.query : "";
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
    return { query, limit };
}

// Kernel prune empties folded messages (text: ""), so collectBlockContent on
// the folded view renders role headers only — headers are not content.
function hasSubstance(text: string): boolean {
    return text.replace(/^\[[^\]]*\]\s*$/gm, "").trim().length > 0;
}

function collectFromSource(state: CompressionState, block: CompressionBlock, source: CoreMessage[] | undefined): string {
    if (!source || source.length === 0) return "";
    const collected = collectBlockContent(state, block, source, { full: true });
    if (collected.count === 0 || !hasSubstance(collected.text)) return "";
    return collected.text;
}

// "" when the originals are gone from every payload (then the caller falls
// back to the summary and annotates the result).
function blockOriginals(state: CompressionState, block: CompressionBlock, session: Session, messages: CoreMessage[]): string {
    const cached = session.blockContents.get(block.blockId)?.full.text;
    if (cached && hasSubstance(cached)) return cached;
    return collectFromSource(state, block, session.lastMessages) || collectFromSource(state, block, messages);
}

export function handleSearchContext(
    args: Record<string, unknown>,
    session: Session,
    messages: CoreMessage[],
): string {
    const { query, limit } = parseSearchContextArgs(args);
    if (query.length === 0) return "[search_context FAILED: query is required]";
    const state = session.state;

    const docs: SearchDoc[] = [];
    const summaryOnly = new Set<string>();
    let withOriginals = 0;
    for (const b of state.blocks) {
        if (!b.active) continue;
        const base: Omit<SearchDoc, "text"> = {
            kind: "block",
            ref: b.blockId,
            title: b.topic ?? b.blockId,
            blockId: b.blockId,
            tier: b.tier ?? 1,
            tokens: b.compressedTokens,
        };
        const originals = blockOriginals(state, b, session, messages);
        if (originals) {
            withOriginals++;
            // Summary appended as a secondary signal, not the corpus.
            docs.push({ ...base, text: `${originals}\n\n${b.topic ?? ""} ${b.summary ?? ""}`.trim() });
        } else {
            summaryOnly.add(b.blockId);
            docs.push({ ...base, text: `${b.topic ?? ""} ${b.summary ?? ""}`.trim() });
        }
    }

    const results = searchBlocks(docs, query, { limit });

    if (results.length === 0) {
        return `[No matches for "${query}" — searched ${docs.length} active block(s) (${withOriginals} with folded originals, ${summaryOnly.size} summary-only). Try a broader term, or decompress the block you suspect holds it.]`;
    }

    const lines = results.map((r) => {
        const topic = r.title === r.ref ? "(no topic)" : r.title;
        const marker = summaryOnly.has(r.ref) ? " [summary-only]" : "";
        return `${r.ref} (T${r.tier}) "${topic}"${marker}\n  ${r.preview}`;
    });
    return `Found ${results.length} block(s) for "${query}":\n\n${lines.join("\n\n")}`;
}
