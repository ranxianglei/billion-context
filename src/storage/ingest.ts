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
 *  - #3464 (R1): stamped lanes additionally key by the host message id —
 *    one row per (host_id, host_slot), where slot is the core's ordinal
 *    inside its wire message (host-id channel). A byte-drifted resend of a
 *    host-identified message REFRESHES that row's bytes/ref instead of
 *    minting a twin (the documented append-only exception: the stored view
 *    must stay equal to the in-memory tail or the verify digest false-
 *    alarms); the row keeps its first-seen seq position. Lanes without
 *    host ids keep pure byte-key behavior.
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
import { coreHostRefs, hostKeyOf, type CoreHostRef } from "../host-id-channel.js";
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
    /** #3464 (R1): wire-aligned host message ids, index-for-index with the
     *  matching leg (null entry = that wire message carries no id). */
    lastMessagesHostIds?: (string | null)[] | null;
    pluginSnapshotHostIds?: (string | null)[] | null;
    contentStore?: { version: 1; byHash: Record<string, string>; byRef: Record<string, unknown> };
}

interface IngestPlan extends IngestSessionInput {
    /** Resolved log seqs for pluginSnapshot entries (null when absent). */
    pluginSnapshotSeqs: number[] | null;
    tailSeqs: number[] | null;
}

/** #3133 test instrumentation: per-message JSON serializations performed by
 *  the planners in this process (intern pass, delta probe, delta new-tail
 *  pass). The watermark fix exists to make this O(new messages) per save
 *  instead of O(full log) — the storage watermark tests assert exactly
 *  that; production code never reads it. */
export const ingestSerializations = { count: 0 };

/** One messages-log entry with its ABSOLUTE seq already assigned (intern
 *  assigns first-seen order; the delta planner continues after the trusted
 *  prefix). */
interface LogEntry {
    seq: number;
    msgId: string;
    content: string;
    hash: string;
    role: string;
    kind: string;
    ref: string | null;
    hostId: string | null;
    hostSlot: number | null;
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
    lastMessagesHostIds?: LegacySessionLike["lastMessagesHostIds"];
    pluginSnapshotHostIds?: LegacySessionLike["pluginSnapshotHostIds"];
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
        lastMessagesHostIds: s.lastMessagesHostIds,
        pluginSnapshotHostIds: s.pluginSnapshotHostIds,
        contentStore: s.contentStore,
    };
}

/** Builds rows + pointer sequences. Pure: no database touched, so tests can
 *  assert the mapping itself. seq assignment: first-seen over the ordered
 *  union (pluginSnapshot first — frozen raw prefix — then fresh tail ids). */
export function planIngest(session: LegacySessionLike): IngestPlan {
    const byRawRef = session.state.messageRefs.byRaw;

    // Pass 1: ordered union of identities (msg_id + content hash).
    // #3133: no cross-save memo — the wire entry points replace the message
    // array with freshly parsed objects on every request, so an object-
    // identity WeakMap never hits on the production save path. The cost cut
    // lives in planIngestDelta + the sessions.last_ingested_seq watermark.
    const log: LogEntry[] = [];
    const seqByIdentity = new Map<string, number>();
    // #3464 (R1): on stamped lanes the host key (host_id + slot inside its
    // wire message) is the primary identity — byte drift across legs must
    // land in ONE row. First-seen wins the seq position; the LATER leg's
    // bytes win the row's unit (the snapshot leg interns first, so the
    // fresh tail refreshes drifted rows — the stored view must equal the
    // in-memory tail or the verify digest false-alarms).
    const seqByHostKey = new Map<string, number>();
    const intern = (m: CoreMessage, hostRef: CoreHostRef | null | undefined): number => {
        const content = JSON.stringify(m);
        ingestSerializations.count++;
        const parsed = JSON.parse(content) as { role: string; contentType?: string };
        const entry = { msgId: m.id, content, hash: sha256Hex(content), role: parsed.role, kind: parsed.contentType ?? "message" };
        const key = `${m.id}\u0000${entry.hash}`;
        const existing = seqByIdentity.get(key);
        if (existing !== undefined) return existing;
        if (hostRef !== null && hostRef !== undefined) {
            const hk = hostKeyOf(hostRef);
            const survivorIdx = seqByHostKey.get(hk);
            if (survivorIdx !== undefined) {
                const survivor = log[survivorIdx];
                if (survivor.msgId !== entry.msgId || survivor.hash !== entry.hash || survivor.role !== entry.role || survivor.kind !== entry.kind) {
                    for (const [bk, idx] of seqByIdentity) {
                        if (idx === survivorIdx) seqByIdentity.delete(bk);
                    }
                    survivor.msgId = entry.msgId;
                    survivor.content = entry.content;
                    survivor.hash = entry.hash;
                    survivor.role = entry.role;
                    survivor.kind = entry.kind;
                    survivor.ref = byRawRef[entry.msgId] ?? null;
                }
                seqByIdentity.set(key, survivorIdx);
                return survivorIdx;
            }
            seqByHostKey.set(hk, log.length);
            const seq = log.length;
            seqByIdentity.set(key, seq);
            log.push({ seq, msgId: entry.msgId, content: entry.content, hash: entry.hash, role: entry.role, kind: entry.kind, ref: byRawRef[entry.msgId] ?? null, hostId: hostRef.hostId, hostSlot: hostRef.slot });
            return seq;
        }
        const seq = log.length;
        seqByIdentity.set(key, seq);
        log.push({ seq, msgId: m.id, content: entry.content, hash: entry.hash, role: entry.role, kind: entry.kind, ref: byRawRef[m.id] ?? null, hostId: null, hostSlot: null });
        return seq;
    };
    const snapshotRefs = session.pluginSnapshot ? coreHostRefs(session.pluginSnapshot, session.pluginSnapshotHostIds) : null;
    const tailRefs = session.lastMessages ? coreHostRefs(session.lastMessages, session.lastMessagesHostIds) : null;
    const pluginSnapshotSeqs = session.pluginSnapshot ? session.pluginSnapshot.map((m, i) => intern(m, snapshotRefs?.[i] ?? null)) : null;
    const tailSeqs = session.lastMessages ? session.lastMessages.map((m, i) => intern(m, tailRefs?.[i] ?? null)) : null;

    return finishPlan(session, byRawRef, log, pluginSnapshotSeqs, tailSeqs);
}

/** #3133 fast-path planner: build the ingest plan for a session whose
 *  stored tail is a VERIFIED trusted prefix — the sessions row's watermark
 *  names the absolute seq backing the LAST tail message at save time, and
 *  `trustedTailSeqs` is that save's persisted tailSeqs (same transaction
 *  wrote both, so they cannot disagree). Soundness of skipping rows 0..L-1:
 *  every one of them was part of the tail that set the watermark (rows
 *  written by that save), and the probe pins slot L-1 to row `watermark`
 *  with nothing above it — so this save only has to append tail[L..] at
 *  watermark+1, watermark+2, … Only messages PAST the trusted prefix pay
 *  stringify+hash; every other row family is byte-identical to
 *  planIngest's, so the resulting store state equals a full ingest's.
 *
 *  Returns null (→ full ingest) when: a pluginSnapshot is present (its
 *  entries may dedup against the trusted prefix and renumber the log),
 *  the tail is absent or not longer than the trusted prefix (shrunk /
 *  rewound / folded-in-place), or the boundary identity disagrees with the
 *  tail slot at L-1 (edited/deleted/re-minted history). Interior edits
 *  BELOW the boundary are the watermark design's accepted trade-off — they
 *  never mis-attribute, only leave stale rows, and the sampled verify
 *  digest is the backstop. */
export function planIngestDelta(
    session: LegacySessionLike,
    watermark: number,
    trustedTailSeqs: number[],
    boundary: { msgId: string; contentHash: string },
    hasRawTail: boolean,
): IngestPlan | null {
    if (session.pluginSnapshot && session.pluginSnapshot.length > 0) return null;
    const tail = session.lastMessages;
    const trustedLen = trustedTailSeqs.length;
    if (
        !tail ||
        trustedLen === 0 ||
        !Number.isSafeInteger(watermark) ||
        watermark < 0 ||
        // An equal-length tail is a VALID empty delta, but ONLY on the raw
        // lineage: a caller passing the envelope's bounded folded RE-RENDER
        // (no rawTail — e.g. the stale-convergence record(disk) path) may
        // present the SAME identities in a DIFFERENT order (#2960 ⑤: the
        // table holds the raw tail; the envelope re-renders it folded), and
        // the boundary probe can match while the served view would stay on
        // the raw ordering instead of the envelope render the disk record
        // promised. Envelope renders must fall through to the full ingest,
        // which rebuilds tailSeqs in the envelope's order.
        (tail.length === trustedLen && !hasRawTail) ||
        tail.length < trustedLen ||
        trustedTailSeqs[trustedLen - 1] !== watermark
    ) {
        return null;
    }
    // Boundary probe, content side: ONE serialization+hash of the tail slot
    // at the trusted prefix's end. Identities are content-derived and
    // unique within one conversion pass, so a match proves this tail slot
    // IS the message the watermark was set from.
    const probe = JSON.stringify(tail[trustedLen - 1]);
    ingestSerializations.count++;
    if (tail[trustedLen - 1].id !== boundary.msgId || sha256Hex(probe) !== boundary.contentHash) return null;
    const byRawRef = session.state.messageRefs.byRaw;
    const log: LogEntry[] = [];
    const appended: number[] = [];
    // #3464 (R1): stamped entries carry their host key through to the row.
    // No dedup against the trusted prefix here — a collision with an
    // existing (host_id, host_slot) row is an integrity violation the
    // store's strict-append guard aborts this delta for (full ingest then
    // reconciles it). Slots are unique within one leg, so no local map.
    const tailRefs = coreHostRefs(tail, session.lastMessagesHostIds);
    for (let i = trustedLen; i < tail.length; i++) {
        const m = tail[i];
        const content = JSON.stringify(m);
        ingestSerializations.count++;
        const parsed = JSON.parse(content) as { role: string; contentType?: string };
        const hostRef = tailRefs[i];
        // Placeholder seqs under the aligned assumption (no rows above the
        // watermark); ingestSession renumbers from max(seq)+1 inside the
        // transaction when a fold left rows above the trusted tip.
        const seq = watermark + 1 + log.length;
        appended.push(seq);
        log.push({
            seq,
            msgId: m.id,
            content,
            hash: sha256Hex(content),
            role: parsed.role,
            kind: parsed.contentType ?? "message",
            ref: byRawRef[m.id] ?? null,
            hostId: hostRef?.hostId ?? null,
            hostSlot: hostRef?.slot ?? null,
        });
    }
    // planIngest's snapshot ternary replicated on the ORIGINAL value: an
    // array (even empty, as fork receipts carry) maps to [], null stays
    // null — loadLegacyView distinguishes the two, so they must not collapse.
    const pluginSnapshotSeqs = session.pluginSnapshot ? [] : null;
    // tailSeqs stay ABSOLUTE (the trusted prefix's seqs are the stored ones,
    // holes included — folding removes log positions from the middle); the
    // delta path skips remapPlanToAbsolute by construction.
    const tailSeqs = [...trustedTailSeqs, ...appended];
    return finishPlan(session, byRawRef, log, pluginSnapshotSeqs, tailSeqs);
}

/** Shared plan tail (everything except the messages log): byte-identical
 *  output for both planners — the watermark fast path must not change what
 *  a full ingest would write for the same session. */
function finishPlan(
    session: LegacySessionLike,
    byRawRef: Record<string, string>,
    log: LogEntry[],
    pluginSnapshotSeqs: number[] | null,
    tailSeqs: number[] | null,
): IngestPlan {
    // Ref ledger: verbatim, ordered by the persisted map's key order.
    // Ghost ids (dead refs) have rows here and nowhere else — by design.
    const refs: RefRow[] = Object.entries(byRawRef).map(([rawId, ref], ord) => ({
        ord,
        rawId,
        ref,
        refNum: refToIndex(ref),
    }));

    const messages: MessageRow[] = log.map((e) => ({
        seq: e.seq,
        msgId: e.msgId,
        ref: e.ref,
        refNum: e.ref === null ? null : refToIndex(e.ref),
        role: e.role,
        kind: e.kind,
        content: e.content,
        contentHash: e.hash,
        hostId: e.hostId,
        hostSlot: e.hostSlot,
    }));

    const blocks: BlockRow[] = session.state.blocks.map((b, ord) => {
        const views = completeBlockContents(session.blockContents, session.state.blocks).get(b.blockId);
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
        // #2960: identity columns — the agent namespace that owns the
        // conversation and the upstream origin the JSON shard was written
        // under. Descriptive here; R2.1 promotes them into the row key.
        namespace: typeof session.metadata.pluginAgent === "string" && session.metadata.pluginAgent
            ? session.metadata.pluginAgent
            : "proxy",
        origin: typeof session.meta.upstreamOrigin === "string" ? session.meta.upstreamOrigin : null,
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
/** Digest/enrichment symmetry (#2960 R2.2): sessions MAY carry state.blocks
 *  entries with no blockContents map slot (hand-built records, web seeds —
 *  real compression always populates both). planIngest synthesizes a view for
 *  such blocks ({text: block.summary, count: 0}, one: null) so the index can
 *  replay every block row; the replay side (loadLegacyView) then shows MORE
 *  than the sparse original and the shadow digest would false-alarm. The
 *  expect leg must apply the same completion — single source, both legs. */
export function completeBlockContents(
    views: Map<string, { one: BlockView | null; full: BlockView }>,
    blocks: ReadonlyArray<{ blockId: string; summary?: string | undefined }>,
): Map<string, { one: BlockView | null; full: BlockView }> {
    if (blocks.length === 0 || (views.size >= blocks.length && blocks.every((b) => views.has(b.blockId)))) return views;
    const out = new Map(views);
    for (const b of blocks) {
        if (!out.has(b.blockId)) out.set(b.blockId, { one: null, full: (b.summary === undefined ? { count: 0 } : { text: b.summary, count: 0 }) as BlockView });
    }
    return out;
}

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
    createdAt: number;
    lastSeen: number;
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
        // "BLOCKED" is a byRaw-only token: the in-memory map keeps the
        // inverse projection strictly mNNNNN→rawId. Admitting it into byRef
        // mints a key the persisted state never had (#2671 soak: sub-agent
        // sessions with protected messages drifted on every save).
        if (r.ref !== "BLOCKED" && byRef[r.ref] === undefined) byRef[r.ref] = r.rawId;
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
        createdAt: s.createdAt,
        lastSeen: s.updatedAt,
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
