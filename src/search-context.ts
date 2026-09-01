// search_context handler shared by all three compress loops.
//
// Corpus (maintainer directive, PR#415 review):
//   1. PRIMARY — the ORIGINAL text of folded-away messages, indexed
//      per-message so role weighting works and each hit names the exact
//      owning block. Coverage is decided by block effectiveMessageIds over
//      ALL blocks (active or inactive): tier-2+ compression deactivates
//      tier-1 blocks whose originals remain the finest-grained retrieval
//      unit, and decompress ignores `active`. Originals ride in the log the
//      client re-sends every turn (session.lastMessages snapshot).
//   2. CACHE — blocks whose originals no longer appear in the log
//      (client-side native compaction deleted them) fall back to the
//      blockContents cache captured at compress time, indexed as one
//      block-level doc of real original text.
//   3. SUMMARY — every block's summary as a secondary signal; blocks with
//      neither log originals nor cache are marked "summary only".
//   Visible (uncovered) messages are NOT indexed: they are already in
//   the model's attention, searching them is redundant.
import {
    messageDocs,
    searchBlocks,
    type CompressionBlock,
    type CompressionState,
    type CoreMessage,
    type MessageInput,
    type SearchDoc,
} from "acp-kernel";
import type { Session } from "./session.js";

export function parseSearchContextArgs(args: Record<string, unknown>): { query: string; limit: number } {
    const query = typeof args.query === "string" ? args.query : "";
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
    return { query, limit };
}

/** Most specific block covering `rawId`: deepest tier first, then smallest coverage. */
function ownerOf(state: CompressionState, rawId: string): CompressionBlock | undefined {
    let best: CompressionBlock | undefined;
    for (const b of state.blocks) {
        if (!b.effectiveMessageIds.includes(rawId)) continue;
        if (
            !best ||
            b.tier < best.tier ||
            (b.tier === best.tier && b.effectiveMessageIds.length < best.effectiveMessageIds.length)
        ) {
            best = b;
        }
    }
    return best;
}

function foldedMessageInputs(state: CompressionState, log: CoreMessage[]): MessageInput[] {
    const byRaw = state.messageRefs.byRaw;
    const foldedRaw = new Set<string>();
    for (const b of state.blocks) {
        for (const id of b.effectiveMessageIds) foldedRaw.add(id);
    }
    const out: MessageInput[] = [];
    const seen = new Set<string>();
    for (const m of log) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (!foldedRaw.has(m.id)) continue;
        if (m.role === "system") continue;
        const text = m.text ?? "";
        if (text.length === 0) continue;
        const ref = byRaw[m.id];
        if (typeof ref !== "string" || ref.length === 0) continue;
        const owner = ownerOf(state, m.id);
        const role =
            m.role === "tool" || m.contentType === "tool-call" || m.contentType === "tool-result"
                ? "tool"
                : m.role;
        out.push({ ref, role, text, blockId: owner?.blockId, tier: owner?.tier });
    }
    return out;
}

// Kernel prune empties folded messages (text: ""), so collected text that
// renders role headers only carries no content.
function hasSubstance(text: string): boolean {
    return text.replace(/^\[[^\]]*\]\s*$/gm, "").trim().length > 0;
}

function blockHasOriginals(blockId: string, byId: Map<string, CompressionBlock>, owners: Set<string>): boolean {
    const b = byId.get(blockId);
    if (!b) return false;
    if (owners.has(blockId)) return true;
    return b.directBlockIds.some((id) => blockHasOriginals(id, byId, owners));
}

export function handleSearchContext(
    args: Record<string, unknown>,
    session: Session,
    messages: CoreMessage[],
): string {
    const { query, limit } = parseSearchContextArgs(args);
    if (query.length === 0) return "[search_context FAILED: query is required]";
    const state = session.state;
    const log = session.lastMessages && session.lastMessages.length > 0 ? session.lastMessages : messages;

    const messageInputs = foldedMessageInputs(state, log);
    const owners = new Set(
        messageInputs.map((m) => m.blockId).filter((b): b is string => typeof b === "string"),
    );
    const byId = new Map(state.blocks.map((b) => [b.blockId, b] as const));

    const docs: SearchDoc[] = [...messageDocs(messageInputs)];
    const summaryOnly = new Set<string>();
    let cachedBlocks = 0;
    for (const b of state.blocks) {
        const base: Omit<SearchDoc, "text"> = {
            kind: "block",
            ref: b.blockId,
            title: b.topic ?? b.blockId,
            blockId: b.blockId,
            tier: b.tier,
            tokens: b.compressedTokens,
        };
        const summaryText = `${b.topic ?? ""} ${b.summary ?? ""}`.trim();
        if (blockHasOriginals(b.blockId, byId, owners)) {
            docs.push({ ...base, text: summaryText });
            continue;
        }
        const cached = session.blockContents.get(b.blockId)?.full;
        if (cached && hasSubstance(cached.text)) {
            cachedBlocks++;
            docs.push({ ...base, text: `${cached.text}\n\n${summaryText}`.trim() });
        } else {
            summaryOnly.add(b.blockId);
            docs.push({ ...base, text: summaryText });
        }
    }

    const results = searchBlocks(docs, query, { limit });

    if (results.length === 0) {
        return `[No matches for "${query}" — searched ${state.blocks.length} block(s) (${owners.size + cachedBlocks} with folded originals, ${summaryOnly.size} summary-only) and ${messageInputs.length} folded-away message(s). Folded originals are matched on full text. Try a broader term, or decompress the block you suspect holds it.]`;
    }

    const lines = results.map((r) => {
        if (r.kind === "block") {
            const topic = r.title === r.ref ? "(no topic)" : r.title;
            const mark = summaryOnly.has(r.ref) ? ", summary only" : "";
            return `${r.ref} (T${r.tier}${mark}) "${topic}"\n  ${r.preview}`;
        }
        return r.blockId
            ? `${r.ref} (${r.role ?? "message"}, in ${r.blockId})\n  ${r.preview}`
            : `${r.ref} (${r.role ?? "message"})\n  ${r.preview}`;
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
