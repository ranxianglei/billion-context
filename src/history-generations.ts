import type { CompressionBlock, MessageContentStore, MessageRefMap } from "acp-kernel";
import type { BlockContent, Session } from "./session.js";

/** Metadata key holding the durable, append-only index of closed history
 *  generations. Payloads (blocks / originals / refs / raw messages / the CCR
 *  slice) live in a separate sidecar envelope so the session record stays
 *  small and the archive survives a restart without being re-materialized
 *  into live state. */
export const HISTORY_GENERATIONS_KEY = "historyGenerations";
export const HISTORY_GENERATIONS_VERSION = 1;

export type HistoryGenerationMeta = {
    generation: number;
    id: string;
    at: number;
    cause: string;
    source?: string;
    checkpointId?: string;
    firstRef?: string;
    lastRef?: string;
    maxRefIndex: number;
    messageCount: number;
    blockCount: number;
    blockIds: string[];
    tokensCompressed: number;
};

export type HistoryGeneration = HistoryGenerationMeta & {
    blocks: CompressionBlock[];
    blockContents: Record<string, BlockContent>;
    messageRefs: MessageRefMap;
    messages: unknown[];
    contentStore?: MessageContentStore;
};

export type HistoryArchive = {
    version: typeof HISTORY_GENERATIONS_VERSION;
    sessionId: string;
    generations: HistoryGeneration[];
};

type HistoryCloseInput = {
    cause: string;
    source?: string;
    checkpointId?: string;
    messages?: readonly unknown[];
    contentStore?: MessageContentStore | null;
    now?: number;
};

function isHistoryGenerationMeta(value: unknown): value is HistoryGenerationMeta {
    if (value === null || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    return typeof v.generation === "number" && Number.isFinite(v.generation)
        && typeof v.id === "string"
        && typeof v.at === "number"
        && typeof v.cause === "string"
        && Array.isArray(v.blockIds);
}

export function historyIndex(session: Session): HistoryGenerationMeta[] {
    const raw = session.metadata[HISTORY_GENERATIONS_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter(isHistoryGenerationMeta).sort((a, b) => a.generation - b.generation);
}

function blockIdNumber(blockId: string): number {
    const m = /^b(\d+)$/.exec(blockId);
    return m ? Number(m[1]) : 0;
}

export function maxBlockIdNumber(blocks: readonly CompressionBlock[]): number {
    let max = 0;
    for (const b of blocks) max = Math.max(max, blockIdNumber(b.blockId));
    return max;
}

export function refIndex(ref: string): number {
    const m = /^m(\d+)$/.exec(ref);
    return m ? Number(m[1]) : 0;
}

const REF_FLOOR_RAW = "bili:ref-floor";

function highestRefIndex(map: MessageRefMap): number {
    let max = 0;
    for (const [ref, rawId] of Object.entries(map.byRef)) {
        if (rawId === REF_FLOOR_RAW) continue;
        max = Math.max(max, refIndex(ref));
    }
    for (const [rawId, ref] of Object.entries(map.byRaw)) {
        if (rawId === REF_FLOOR_RAW) continue;
        max = Math.max(max, refIndex(ref));
    }
    return max;
}

function lowestRefIndex(map: MessageRefMap): number {
    let min = 0;
    for (const [ref, rawId] of Object.entries(map.byRef)) {
        if (rawId === REF_FLOOR_RAW) continue;
        const idx = refIndex(ref);
        if (idx > 0 && (min === 0 || idx < min)) min = idx;
    }
    return min;
}

function indexToRef(index: number): string {
    return `m${String(index).padStart(5, "0")}`;
}

export function buildHistoryGeneration(
    session: Session,
    input: HistoryCloseInput,
): HistoryGeneration | null {
    const blocks = session.state.blocks.map((b) => ({ ...b }));
    const messages = (input.messages ?? []).slice();
    const messageRefs: MessageRefMap = {
        byRaw: { ...session.state.messageRefs.byRaw },
        byRef: { ...session.state.messageRefs.byRef },
    };
    const store = input.contentStore ?? undefined;
    const hasRefs = Object.keys(messageRefs.byRef).length > 0;
    if (blocks.length === 0 && messages.length === 0 && !hasRefs && !store) return null;

    const blockContents: Record<string, BlockContent> = {};
    for (const b of blocks) {
        let content: BlockContent | undefined;
        try {
            content = session.blockContents.get(b.blockId);
        } catch {
            // A dropped LazyBlockContents map that cannot re-materialize keeps
            // the generation readable for summaries/refs; it just has no verbatim
            // copy for this block, and decompress says so explicitly.
            content = undefined;
        }
        if (!content) continue;
        blockContents[b.blockId] = {
            one: content.one ? { text: content.one.text, count: content.one.count } : null,
            full: { text: content.full.text, count: content.full.count },
        };
    }

    const maxRef = highestRefIndex(messageRefs);
    const minRef = lowestRefIndex(messageRefs);
    const at = input.now ?? Date.now();
    const generation = historyIndex(session).length + 1;
    const tokens = blocks.reduce((sum, b) => sum + (Number.isFinite(b.compressedTokens) ? b.compressedTokens : 0), 0);
    return {
        generation,
        id: `${session.id}#g${generation}`,
        at,
        cause: input.cause,
        source: input.source,
        checkpointId: input.checkpointId,
        firstRef: minRef > 0 ? indexToRef(minRef) : undefined,
        lastRef: maxRef > 0 ? indexToRef(maxRef) : undefined,
        maxRefIndex: maxRef,
        messageCount: messages.length,
        blockCount: blocks.length,
        blockIds: blocks.map((b) => b.blockId),
        tokensCompressed: tokens,
        blocks,
        blockContents,
        messageRefs,
        messages,
        contentStore: store,
    };
}

export function metaOf(gen: HistoryGeneration): HistoryGenerationMeta {
    const { blocks: _blocks, blockContents: _blockContents, messageRefs: _messageRefs, messages: _messages, contentStore: _contentStore, ...meta } = gen;
    return meta;
}

/** Ref aliases worth freezing into a generation's CCR slice: every ref the
 *  generation ever assigned, plus entries whose number is below its ceiling
 *  (dead/pruned refs still cited by old summaries). */
export function generationContentStore(
    store: MessageContentStore | null | undefined,
    map: MessageRefMap,
    maxRefIndex: number,
): MessageContentStore | undefined {
    if (!store) return undefined;
    const wanted = new Set<string>(Object.keys(map.byRef));
    for (const ref of Object.keys(store.byRef)) {
        if (refIndex(ref) > 0 && refIndex(ref) <= maxRefIndex) wanted.add(ref);
    }
    const byRef: MessageContentStore["byRef"] = {};
    const byHash: MessageContentStore["byHash"] = {};
    for (const [ref, entry] of Object.entries(store.byRef)) {
        if (!wanted.has(ref)) continue;
        byRef[ref] = { ...entry };
        const text = store.byHash[entry.hash];
        if (text !== undefined && !(entry.hash in byHash)) byHash[entry.hash] = text;
    }
    return Object.keys(byRef).length > 0 ? { version: 1, byHash, byRef } : undefined;
}

export type FoundArchivedBlock = { generation: HistoryGeneration; block: CompressionBlock };
type FoundArchivedRef = { generation: HistoryGeneration; ref: string; rawId: string };

export function findArchivedBlock(generations: readonly HistoryGeneration[], blockId: string): FoundArchivedBlock | null {
    for (let i = generations.length - 1; i >= 0; i -= 1) {
        const block = generations[i].blocks.find((b) => b.blockId === blockId);
        if (block) return { generation: generations[i], block };
    }
    return null;
}

export function findArchivedRef(generations: readonly HistoryGeneration[], ref: string): FoundArchivedRef | null {
    const idx = refIndex(ref);
    if (idx === 0) return null;
    for (let i = generations.length - 1; i >= 0; i -= 1) {
        const gen = generations[i];
        const rawId = gen.messageRefs.byRef[ref];
        if (rawId) return { generation: gen, ref, rawId };
        if (idx <= gen.maxRefIndex) return { generation: gen, ref, rawId: "" };
    }
    return null;
}

export function archivedBlockView(found: FoundArchivedBlock, full: boolean): { body: string; count: number } | null {
    const content = found.generation.blockContents[found.block.blockId];
    if (!content) return null;
    const view = full ? content.full : (content.one ?? content.full);
    return { body: view.text, count: view.count };
}

export function archivedBlockHeader(found: FoundArchivedBlock): string {
    const gen = found.generation;
    const when = new Date(gen.at).toISOString().slice(0, 10);
    return `[Block ${found.block.blockId} content — read-only from history generation ${gen.generation} (${gen.cause}, closed ${when})]`;
}

export function archivedRefText(found: FoundArchivedRef): string | null {
    const entry = found.generation.contentStore?.byRef[found.ref];
    if (!entry) return null;
    const text = found.generation.contentStore?.byHash[entry.hash];
    return typeof text === "string" ? text : null;
}

type ArchivedOriginal = { generation: number; blockId: string; text: string };

export function archivedOriginalTexts(generations: readonly HistoryGeneration[]): ArchivedOriginal[] {
    const out: ArchivedOriginal[] = [];
    for (const gen of generations) {
        for (const block of gen.blocks) {
            const content = gen.blockContents[block.blockId];
            if (!content) continue;
            out.push({ generation: gen.generation, blockId: block.blockId, text: content.full.text });
        }
    }
    return out;
}

export function messageText(message: unknown): string {
    const record = message as Record<string, unknown> | null;
    if (!record || typeof record !== "object") return "";
    const value = record.content;
    if (typeof value === "string") return value;
    // Core messages carry the text in `text`; wire messages carry `content`
    // parts. Both shapes land in a generation, so read either.
    if (!Array.isArray(value)) return typeof record.text === "string" ? record.text : "";
    const parts: string[] = [];
    for (const part of value) {
        if (typeof part === "string") {
            parts.push(part);
            continue;
        }
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") parts.push(p.text);
        else if (typeof p.content === "string") parts.push(p.content);
        else if (p.type === "tool-result" || p.type === "tool_result") {
            // Wire tool results carry their payload under `output`
            // ({type:"text"|"error-text", value}); losing it would break the
            // call/result association an archived generation must preserve.
            const output = p.output;
            if (typeof output === "string") parts.push(output);
            else if (output && typeof output === "object" && typeof (output as Record<string, unknown>).value === "string") {
                parts.push((output as Record<string, unknown>).value as string);
            } else parts.push(JSON.stringify(p));
        } else if (p.type === "tool-call" || p.type === "tool_call") parts.push(JSON.stringify(p));
    }
    const joined = parts.join("\n");
    return joined || (typeof record.text === "string" ? record.text : "");
}

type ArchivedMessageHit = { generation: number; ref: string; role: string; text: string; blockId?: string };

export function archivedMessageHits(generations: readonly HistoryGeneration[]): ArchivedMessageHit[] {
    const out: ArchivedMessageHit[] = [];
    for (const gen of generations) {
        for (const message of gen.messages) {
            const record = message as Record<string, unknown> | null;
            if (!record || typeof record !== "object") continue;
            const text = messageText(record);
            if (!text) continue;
            const rawId = typeof record.id === "string" ? record.id : "";
            const ref = rawId ? gen.messageRefs.byRaw[rawId] ?? "" : "";
            if (!ref) continue;
            const role = typeof record.role === "string" ? record.role : "unknown";
            const blockId = typeof record.summaryOfBlockId === "string" ? record.summaryOfBlockId : undefined;
            out.push({ generation: gen.generation, ref, role, text, blockId });
        }
    }
    return out;
}

const NAV_LIMIT = 4;

/** Compact navigation index injected at compaction boundaries only: names the
 *  read-only generations and how to search them. Never carries payload. */
const NAV_TOPIC_CHARS = 120;
const NAV_POINT_CHARS = 240;
const NAV_SUMMARY_CHARS = 1_200;

function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function clampText(text: string, max: number): string {
    const flat = oneLine(text);
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Merge the summaries of every closed generation into ONE consolidated summary.
 * Consecutive cloud compactions would otherwise leave the model with N disjoint
 * generations, each only reachable through its own lookup; the newest summary
 * per topic wins, so re-folded material never appears twice. Bounded so the
 * navigation index stays a note, not a payload.
 */
export function mergeGenerationSummaries(generations: readonly HistoryGeneration[], limit: number = NAV_SUMMARY_CHARS): string | null {
    const seen = new Set<string>();
    const lines: string[] = [];
    let used = 0;
    for (const generation of [...generations].reverse()) {
        for (const block of generation.blocks) {
            const topic = clampText(block.topic ?? block.blockId, NAV_TOPIC_CHARS);
            const key = topic.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const point = clampText(block.summary, NAV_POINT_CHARS);
            const line = `- ${topic}: ${point}`;
            if (used + line.length > limit) {
                if (lines.length === 0) lines.push(`${line.slice(0, limit)}…`);
                return lines.join("\n");
            }
            used += line.length + 1;
            lines.push(line);
        }
    }
    return lines.length > 0 ? lines.join("\n") : null;
}

export function historyNavNote(session: Session, generations?: readonly HistoryGeneration[]): string | null {
    const index = historyIndex(session);
    if (index.length === 0) return null;
    const tail = index.slice(-NAV_LIMIT);
    const lines = tail.map((gen) => {
        const when = new Date(gen.at).toISOString().slice(0, 10);
        const span = gen.maxRefIndex > 0 ? `refs m00001–${indexToRef(gen.maxRefIndex)}` : "no message refs";
        return `- generation ${gen.generation} — ${when} — ${gen.blockCount} block(s), ${gen.messageCount} message(s), ${span} — closed by ${gen.cause}`;
    });
    const omitted = index.length - tail.length;
    return [
        `[bili] ${index.length} closed history generation(s) are preserved read-only and stay searchable.`,
        ...(omitted > 0 ? [`- ${omitted} older generation(s) omitted from this index (still searchable)`] : []),
        ...lines,
        ...(index.length > 1 && generations !== undefined
            ? (() => {
                const merged = mergeGenerationSummaries(generations);
                return merged === null ? [] : ["Consolidated summary of the closed history (newest first):", merged];
            })()
            : []),
        "Use search_context to locate folded or archived detail; decompress(blockId) and the retrieve tool resolve blocks and refs from these generations as well. Archived content is read-only and never re-sent to the model.",
    ].join("\n");
}
