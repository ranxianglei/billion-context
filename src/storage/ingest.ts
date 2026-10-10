/**
 * Legacy → unified mapping (#2671 Phase 1).
 *
 * ingestSession() converts a session as returned by SessionStore.loadSync
 * into UnifiedStore rows. loadLegacyView() reconstructs, from those rows
 * alone, the same view object the corpus pins digests for.
 *
 * Migration contract (every line here is load-bearing for digest equality):
 *  - messages is an APPEND-ONLY LOG keyed by identity (session, msg_id,
 *    content_hash). Split tool-call cores share an id but hold different
 *    content parts → distinct rows. Byte-identical resends are the same row
 *    (kernel identity is id-based; #1476 renumbers new instances, which get
 *    new ids anyway). seq = first-seen arrival order.
 *  - pluginSnapshot / lastMessages are POINTER SEQUENCES into that log
 *    (tail_json): they are views (subsequences), never re-stored as content.
 *    pluginSnapshot is the frozen raw prefix; lastMessages is the folded
 *    visible tail — a suffix SLICE of the log would be wrong because
 *    folding removes entries from the middle.
 *  - ref numbers come from state.messageRefs.byRaw verbatim (TEXT, may be
 *    \"BLOCKED\"); ref_num is the numeric projection for ordering queries.
 *  - blocks.ord = state.blocks array order (== blockContents Map order);
 *    payload_json carries the verbatim CompressionBlock.
 *  - the state object is rebuilt in mergeState field order (persist.ts) —
 *    canonical digests are key-order sensitive.
 *  - dead_refs.ord preserves the kernel's numeric-ascending array order.
 */

import type { CoreMessage, CompressionBlock } from "../../kernel/src/types.js";
import type { BlockView } from "../session.js";
import { refToIndex } from "../../kernel/src/refs.js";
import { sha256Hex, type BlockRow, type CcrEntryRow, type IngestSessionInput, type MessageRow, type RefRow, type SessionRow } from "./store.js";

/** Field order of mergeState() output (src/persist.ts) — the loader must
 *  rebuild the state object in exactly this order. Keep in sync. */
const MERGE_STATE_FIELDS = [
    "blocks",
    "messageRefs",
    "nudge",
    "stats",
    "nextBlockId",
    "nextRunId",
    "tokenSnapshot",
    "lastPassIds",
    "hiddenOrphanRefs",
    "deadRefs",
    "terminalStreak",
    "nextRuleId",
    "absorbed",
    "rules",
    "imageFullRestored",
    "imageShrinks",
] as const;

/** Fields owned by dedicated tables/columns — never inside kstate_json. */
const TABLE_OWNED_FIELDS = new Set(["blocks", "messageRefs", "deadRefs", "nextBlockId", "nextRunId"]);

export interface LegacySessionLike {
    id: string;
    createdAt: number;
    lastSeen: number;
    meta: Record<string, unknown>;
    stats: Record<string, unknown>;
    metadata: Record<string, unknown>;
    state: {
        blocks: CompressionBlock[];
        messageRefs: { byRaw: Record<string, string>; byRef: Record<string, string> };
        deadRefs?: string[];
        nextBlockId: number;
        nextRunId: number;
        [k: string]: unknown;
    };
    blockContents: Map<string, { one: BlockView | null; full: BlockView }>;
    lastMessages?: CoreMessage[];
    lastMessagesFolded?: boolean;
    pluginSnapshot?: CoreMessage[];
    contentStore?: { version: 1; byHash: Record<string, string>; byRef: Record<string, unknown> };
}

interface IngestPlan extends IngestSessionInput {
    /** Resolved log seqs for pluginSnapshot entries (null when absent). */
    pluginSnapshotSeqs: number[] | null;
    tailSeqs: number[] | null;
}

/** Adapts any Session-shaped object (persist loadSync output) to the
 *  ingest input type. Structural on purpose: no import of src/session.ts
 *  (avoids a module cycle through persist.ts). */
export function toLegacyLike(s: {
    id: string;
    createdAt: number;
    lastSeen: number;
    meta: Record<string, unknown>;
    stats: Record<string, unknown>;
    metadata: Record<string, unknown>;
    state: unknown;
    blockContents: LegacySessionLike["blockContents"];
    lastMessages?: LegacySessionLike["lastMessages"];
    lastMessagesFolded?: boolean;
    pluginSnapshot?: LegacySessionLike["pluginSnapshot"];
    contentStore?: LegacySessionLike["contentStore"];
}): LegacySessionLike {
    return {
        id: s.id,
        createdAt: s.createdAt,
        lastSeen: s.lastSeen,
        meta: s.meta,
        stats: s.stats,
        metadata: s.metadata,
        state: s.state as unknown as LegacySessionLike["state"],
        blockContents: s.blockContents,
        lastMessages: s.lastMessages,
        lastMessagesFolded: s.lastMessagesFolded,
        pluginSnapshot: s.pluginSnapshot,
        contentStore: s.contentStore,
    };
}

/** Builds rows + pointer sequences. Pure: no database touched, so tests can
 *  assert the mapping itself. seq assignment: first-seen over the ordered
 *  union (pluginSnapshot first — frozen raw prefix — then fresh tail ids). */
export function planIngest(session: LegacySessionLike): IngestPlan {
    const byRawRef = session.state.messageRefs.byRaw;

    // Pass 1: ordered union of identities (msg_id + content hash).
    const log: { msgId: string; content: string; hash: string; ref: string | null }[] = [];
    const seqByIdentity = new Map<string, number>();
    const intern = (m: CoreMessage): number => {
        const content = JSON.stringify(m);
        const hash = sha256Hex(content);
        const key = `${m.id}\u0000${hash}`;
        const existing = seqByIdentity.get(key);
        if (existing !== undefined) return existing;
        const seq = log.length;
        seqByIdentity.set(key, seq);
        log.push({ msgId: m.id, content, hash, ref: byRawRef[m.id] ?? null });
        return seq;
    };
    const pluginSnapshotSeqs = session.pluginSnapshot ? session.pluginSnapshot.map(intern) : null;
    const tailSeqs = session.lastMessages ? session.lastMessages.map(intern) : null;

    // Ref ledger: verbatim, ordered by the persisted map's key order.
    // Ghost ids (dead refs) have rows here and nowhere else — by design.
    const refs: RefRow[] = Object.entries(byRawRef).map(([rawId, ref], ord) => ({
        ord,
        rawId,
        ref,
        refNum: refToIndex(ref),
    }));

    const messages: MessageRow[] = log.map((e, seq) => ({
        seq,
        msgId: e.msgId,
        ref: e.ref,
        refNum: e.ref === null ? null : refToIndex(e.ref),
        role: (JSON.parse(e.content) as { role: string }).role,
        kind: (JSON.parse(e.content) as { contentType?: string }).contentType ?? "message",
        content: e.content,
    }));

    const blocks: BlockRow[] = session.state.blocks.map((b, ord) => {
        const views = session.blockContents.get(b.blockId);
        const full = views?.full ?? { text: b.summary, count: 0 };
        const one = views?.one ?? null;
        const covered = { effectiveMessageIds: b.effectiveMessageIds, directMessageIds: b.directMessageIds };
        return {
            blockId: b.blockId,
            ord,
            startSeq: 0,
            endSeq: 0,
            startRef: b.startRef !== undefined ? refToIndex(b.startRef) : null,
            endRef: b.endRef !== undefined ? refToIndex(b.endRef) : null,
            tier: b.tier,
            summary: JSON.stringify(full),
            one: one === null ? null : JSON.stringify(one),
            supersedesBlockId: null,
            active: b.active,
            createdAt: b.createdAt,
            coveredHash: sha256Hex(JSON.stringify(covered)),
            payloadJson: JSON.stringify(b),
        };
    });

    const deadRefs = (session.state.deadRefs ?? []).map((ref, ord) => ({
        ord,
        ref,
        refNum: refToIndex(ref) ?? Number.MAX_SAFE_INTEGER,
        recordedAt: session.lastSeen,
    }));

    const ccrEntries: CcrEntryRow[] = session.contentStore
        ? Object.entries(session.contentStore.byRef).map(([key, value], ord) => ({
              ord,
              key,
              content: JSON.stringify(value),
          }))
        : [];

    const kstate: Record<string, unknown> = {};
    for (const field of MERGE_STATE_FIELDS) {
        if (TABLE_OWNED_FIELDS.has(field)) continue;
        const v = (session.state as Record<string, unknown>)[field];
        if (v !== undefined) kstate[field] = v;
    }

    const sessionRow: SessionRow = {
        sessionId: session.id,
        parentSessionId: null,
        forkPointSeq: null,
        protocol: typeof session.meta.protocol === "string" ? session.meta.protocol : null,
        label: typeof session.meta.label === "string" ? session.meta.label : null,
        title: typeof session.meta.title === "string" ? session.meta.title : null,
        hostTitle: typeof session.meta.hostTitle === "string" ? session.meta.hostTitle : null,
        status: "active",
        createdAt: session.createdAt,
        updatedAt: session.lastSeen,
        nextBlockId: session.state.nextBlockId,
        nextRunId: session.state.nextRunId,
        metaJson: JSON.stringify(session.meta),
        statsJson: JSON.stringify(session.stats),
        metadataJson: JSON.stringify(session.metadata),
        kstateJson: JSON.stringify(kstate),
        tailJson: JSON.stringify({ pluginSnapshotSeqs, tailSeqs, tailFolded: session.lastMessagesFolded === true }),
        ccrJson: session.contentStore ? JSON.stringify(session.contentStore) : null,
    };

    return { session: sessionRow, messages, blocks, deadRefs, refs, ccrEntries, pluginSnapshotSeqs, tailSeqs };
}

/** Rebuilds the legacy load view from unified rows alone. */
export function loadLegacyView(
    rows: {
        session: {
            sessionId: string;
            createdAt: number;
            updatedAt: number;
            nextBlockId: number;
            nextRunId: number;
            metaJson: string;
            statsJson: string;
            metadataJson: string;
            kstateJson: string;
            tailJson: string;
            ccrJson: string | null;
        };
        messages: { seq: number; msgId: string; ref: string | null; content: string }[];
        blocks: { blockId: string; summary: string; one: string | null; payloadJson: string }[];
        deadRefs: { ord: number; ref: string }[];
        refs: { ord: number; rawId: string; ref: string }[];
    },
): {
    id: string;
    meta: Record<string, unknown>;
    stats: Record<string, unknown>;
    metadata: Record<string, unknown>;
    state: Record<string, unknown>;
    blockContents: Map<string, { one: BlockView | null; full: BlockView }>;
    lastMessages?: CoreMessage[];
    lastMessagesFolded?: boolean;
    pluginSnapshot?: CoreMessage[];
    contentStore?: LegacySessionLike["contentStore"];
} {
    const s = rows.session;
    const kstate = JSON.parse(s.kstateJson) as Record<string, unknown>;
    const tail = JSON.parse(s.tailJson) as {
        pluginSnapshotSeqs: number[] | null;
        tailSeqs: number[] | null;
        tailFolded: boolean;
    };

    // messageRefs rebuilt from the ref ledger verbatim: ord preserves the
    // persisted map's key order (digest-sensitive), and ghost ids survive
    // even though no message row backs them (#2362 Kernel Contract).
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    for (const r of rows.refs) {
        byRaw[r.rawId] = r.ref;
        if (byRef[r.ref] === undefined) byRef[r.ref] = r.rawId;
    }

    const state: Record<string, unknown> = {};
    for (const field of MERGE_STATE_FIELDS) {
        switch (field) {
            case "blocks":
                state.blocks = rows.blocks.map((b) => JSON.parse(b.payloadJson));
                break;
            case "messageRefs":
                state.messageRefs = { byRaw, byRef };
                break;
            case "deadRefs":
                state.deadRefs = rows.deadRefs.length > 0 ? rows.deadRefs.map((d) => d.ref) : undefined;
                break;
            case "nextBlockId":
                state.nextBlockId = s.nextBlockId;
                break;
            case "nextRunId":
                state.nextRunId = s.nextRunId;
                break;
            default:
                if (kstate[field] !== undefined) state[field] = kstate[field];
                break;
        }
    }

    const blockContents = new Map<string, { one: BlockView | null; full: BlockView }>();
    for (const b of rows.blocks) {
        blockContents.set(b.blockId, {
            one: b.one === null ? null : (JSON.parse(b.one) as BlockView),
            full: JSON.parse(b.summary) as BlockView,
        });
    }

    const messagesBySeq = new Map(rows.messages.map((m) => [m.seq, JSON.parse(m.content) as CoreMessage]));
    const lastMessages = tail.tailSeqs
        ? tail.tailSeqs.map((seq) => messagesBySeq.get(seq)).filter((m): m is CoreMessage => m !== undefined)
        : undefined;
    const pluginSnapshot = tail.pluginSnapshotSeqs
        ? tail.pluginSnapshotSeqs
              .map((seq) => messagesBySeq.get(seq))
              .filter((m): m is CoreMessage => m !== undefined)
        : undefined;

    const out: ReturnType<typeof loadLegacyView> = {
        id: s.sessionId,
        meta: JSON.parse(s.metaJson),
        stats: JSON.parse(s.statsJson),
        metadata: JSON.parse(s.metadataJson),
        state,
        blockContents,
        lastMessages,
        lastMessagesFolded: tail.tailFolded,
    };
    if (pluginSnapshot) out.pluginSnapshot = pluginSnapshot;
    if (s.ccrJson !== null) out.contentStore = JSON.parse(s.ccrJson);
    return out;
}
