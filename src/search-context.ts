// search_context handler shared by all three compress loops. Deliberately
// bypasses core.search (active-only corpus, exact-substring scorer whose
// 0.1 threshold a single summary hit could never reach) in favor of the
// kernel's published engine: hybrid BM25+fuzzy, CJK-aware, corpus =
// active blocks + visible messages.
import {
    blockDocs,
    messageDocs,
    searchBlocks,
    type CompressionState,
    type CoreMessage,
    type MessageInput,
} from "acp-kernel";

export function parseSearchContextArgs(args: Record<string, unknown>): { query: string; limit: number } {
    const query = typeof args.query === "string" ? args.query : "";
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
    return { query, limit };
}

function visibleMessageInputs(state: CompressionState, messages: CoreMessage[]): MessageInput[] {
    const byRaw = state.messageRefs.byRaw;
    const out: MessageInput[] = [];
    for (const m of messages) {
        const ref = byRaw[m.id];
        if (typeof ref !== "string" || ref.length === 0) continue;
        if (m.role === "system") continue;
        const text = m.text ?? "";
        if (text.length === 0) continue;
        const role =
            m.role === "tool" || m.contentType === "tool-call" || m.contentType === "tool-result"
                ? "tool"
                : m.role;
        out.push({ ref, role, text });
    }
    return out;
}

export function handleSearchContext(
    args: Record<string, unknown>,
    state: CompressionState,
    messages: CoreMessage[],
): string {
    const { query, limit } = parseSearchContextArgs(args);
    if (query.length === 0) return "[search_context FAILED: query is required]";

    const activeBlockIds = new Set(state.blocks.filter((b) => b.active).map((b) => b.blockId));
    const blockCorpus = blockDocs(state).filter((d) => activeBlockIds.has(d.ref));
    const messageInputs = visibleMessageInputs(state, messages);
    const results = searchBlocks([...blockCorpus, ...messageDocs(messageInputs)], query, { limit });

    if (results.length === 0) {
        return `[No matches for "${query}" — searched ${blockCorpus.length} block(s) and ${messageInputs.length} visible message(s). Compressed content is searchable only through its summary; try a broader term, or decompress the block you suspect holds it.]`;
    }

    const lines = results.map((r) => {
        if (r.kind === "block") {
            const topic = r.title === r.ref ? "(no topic)" : r.title;
            return `${r.ref} (T${r.tier}) "${topic}"\n  ${r.preview}`;
        }
        return `${r.ref} (${r.role ?? "message"})\n  ${r.preview}`;
    });
    const blockHits = results.filter((r) => r.kind === "block").length;
    const messageHits = results.length - blockHits;
    const what = [
        blockHits > 0 ? `${blockHits} block(s)` : "",
        messageHits > 0 ? `${messageHits} message(s)` : "",
    ]
        .filter(Boolean)
        .join(", ");
    return `Found ${what} for "${query}":\n\n${lines.join("\n\n")}`;
}
