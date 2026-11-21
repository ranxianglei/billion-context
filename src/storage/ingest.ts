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
 *  - Cross-save reconciliation is by CLIENT IDENTITY ONLY ((session_id,
 *    msg_id, identity); 2026-11-21, #3285 follow-through): a save points a
 *    view slot at the stored row whose id matches, serializes only what is
 *    new, and the completeLog sweep retires rows whose identity the view no
 *    longer presents. There is NO positional watermark and no writer trust
 *    — a slot's identity match holds across processes by construction, so
 *    nothing has to be vouched for (or NULLed) at a handoff.
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
import { splitMediaContent, identityOfStoredContent } from "./identity.js";

/**
 * Field order of the hydration merge output — DERIVED from mergeState itself
 * (src/state-hydration.ts), not hand-kept: the hand list had already drifted
 * (#4192). The loader rebuilds the state object in exactly this order.
 */
import { COMPRESSION_STATE_FIELDS as MERGE_STATE_FIELDS } from "../state-hydration.js";

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
    /** #3301: external-converter import payload — original message
     *  decompositions interned BEFORE the snapshot/tail so their rows get the
     *  lowest seqs (they are the oldest evidence). */
    decompositionLog?: CoreMessage[];
    contentStore?: { version: 1; byHash: Record<string, string>; byRef: Record<string, unknown> };
}

interface IngestPlan extends IngestSessionInput {
    /** Resolved log seqs for pluginSnapshot entries (null when absent).
     *  Reconciled (shallow) plans carry a MIX: non-negative values are
     *  ABSOLUTE stored seqs (identity pointer), negative values are
     *  sentinels -(j+1) naming messages[j]. */
    pluginSnapshotSeqs: number[] | null;
    tailSeqs: number[] | null;
}

/** One row of the in-transaction stored-message index (the reconciler's
 *  join set) — read by UnifiedStore.storedMessagesIndex inside the write
 *  transaction so the partition it produces is exactly what the apply sees.
 *  Retired rows are included on purpose: a pointer may legally land on a
 *  tombstone (rewind-redo) and the pin/reactivate path needs its seq. */
export interface StoredMessageRow {
    seq: number;
    msgId: string;
    contentHash: string;
    identity: string;
    retiredAt: number | null;
    ref: string | null;
}

/** #3133 test instrumentation: per-message JSON serializations performed by
 *  the planners in this process (intern pass, reconciler new/ambiguous pass).
 *  Reconciliation exists to make this O(new messages) per save instead of
 *  O(full log) — the reconciliation tests assert exactly that; production
 *  code never reads it. */
export const ingestSerializations = { count: 0 };

/** One messages-log entry with its ABSOLUTE seq already assigned (intern
 *  assigns first-seen order; the delta planner continues after the trusted
 *  prefix). */
/**
 * #3762 media CAS split: pull the top-level imageBase64 payload out of the
 * serialized message. The stored content keeps the key POSITION but carries
 * a {"$media": sha256(bytes)} reference; the bytes themselves live in the
 * content CAS, refcounted via message_media rows. Key order is preserved by
 * JSON.parse, so hydrate-and-restringify is byte-identical — every existing
 * reader (getMessages hydrates before returning) sees the verbatim original.
 * No media (or empty) → passthrough with the plain content hash.
 */
interface LogEntry {
    seq: number;
    msgId: string;
    content: string;
    hash: string;
    identity: string;
    role: string;
    kind: string;
    ref: string | null;
    media?: { hash: string; bytes: string }[];
    /** #4313: first-sight wall-clock stamp carried by the message object
     *  (absent for pre-feature / imported payloads). Stored into the
     *  messages.ts column verbatim; the value is NEVER part of content
     *  (see serializeForStore). */
    ts?: number;
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
    decompositionLog?: LegacySessionLike["decompositionLog"];
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
        decompositionLog: s.decompositionLog,
        contentStore: s.contentStore,
    };
}

/** #4313: storage serialization of a message — ts rides the dedicated
 *  column, NEVER the content bytes: stored content stays byte-identical to
 *  what a pre-feature save wrote for the same logical message, so content
 *  hash / identity / boundary probes cannot churn when stamps attach.
 *  ts is appended last by its producers (stamper node, row hydration), so
 *  deleting it restores the pre-feature key order exactly. */
function serializeForStore(m: CoreMessage): string {
    if (m.ts === undefined) return stringifyForStore(m);
    const copy = { ...m };
    delete copy.ts;
    return stringifyForStore(copy);
}

/** #5627: V8's serializer recurses into arbitrarily nested data, so a
 *  pathologically nested message dies as the generic "Maximum call stack
 *  size exceeded" naming nothing. Re-throw naming the OFFENDING MESSAGE so
 *  the failure forensics point at the exact row to remove or flatten. */
function stringifyForStore(m: CoreMessage): string {
    try {
        return JSON.stringify(m);
    } catch (err) {
        if (err instanceof RangeError) {
            throw new RangeError(`message ${m.id}: nesting too deep for JSON serialization (engine call-stack overflow) — remove or flatten this message to unblock the unified store`);
        }
        throw err;
    }
}

/** A persisted turn-final reply row. Stored under the session's
 *  `metadata.handoffReply` (see src/server/handoff-response.ts) — OUTSIDE the
 *  messages table on purpose: the table's seq space is the ref-ledger
 *  substrate (persist.maybeRestampToLedger aligns live refs onto row seq+1,
 *  #4316), so non-view rows would desync every post-fold ref. metadata_json
 *  is persisted in both the legacy file and the unified DB (identical in
 *  both views ⇒ digest-equal), so the reply still lands durably in the DB —
 *  #6947 — without touching the view, the ledger, or any wire. */
export interface HandoffReplyStashRow {
    msgId: string;
    content: string;
    hash: string;
    identity: string;
    role: string;
    kind: string;
    media?: { hash: string; bytes: string }[];
    ts?: number;
}

/** Plan-ready representation of a core the store has never seen through a
 *  request — the turn-final handoff reply. Runs the EXACT serialization
 *  chain the planners use (serializeForStore → splitMediaContent →
 *  identityOfStoredContent), so the row's identity equals the one a client
 *  re-send of the same reply would derive — DB readers can dedup the stash
 *  against view rows by (msgId, identity) if they ever join. Exported so the
 *  host capture (handoff-response.ts) and this module cannot drift apart. */
export function planStoredMessageRow(m: CoreMessage): HandoffReplyStashRow {
    const raw = serializeForStore(m);
    ingestSerializations.count++;
    const parsed = JSON.parse(raw) as { role?: unknown; contentType?: unknown };
    const split = splitMediaContent(raw);
    return {
        msgId: m.id,
        content: split.content,
        hash: split.hash,
        identity: identityOfStoredContent(split.content),
        role: typeof parsed.role === "string" ? parsed.role : "assistant",
        kind: typeof parsed.contentType === "string" ? parsed.contentType : "message",
        ...(split.media.length > 0 ? { media: split.media } : {}),
        ...(typeof m.ts === "number" ? { ts: m.ts } : {}),
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
    // identity WeakMap never hits on the production save path. The per-save
    // cost cut lives in planReconciled's blind pins (zero serializations for
    // slots whose id already has one live stored row).
    const log: LogEntry[] = [];
    const seqByIdentity = new Map<string, number>();
    const intern = (m: CoreMessage): number => {
        // #4390: the cross-save JOIN key is the POSITION-INDEPENDENT identity
        // (stored-bytes serialization minus id/wireIndex). content_hash stays
        // the byte-faithful CAS key; only the join moves to identity.
        const entry = entryFor(m, byRawRef);
        const key = `${m.id}\u0000${entry.identity}`;
        const existing = seqByIdentity.get(key);
        if (existing !== undefined) return existing;
        const seq = log.length;
        seqByIdentity.set(key, seq);
        log.push({ seq, ...entry });
        return seq;
    };
    // #3301: import payload first — its rows must sit below the snapshot/tail
    // seqs so the stored log reads oldest-evidence-first.
    if (session.decompositionLog && session.decompositionLog.length > 0) session.decompositionLog.forEach(intern);
    const pluginSnapshotSeqs = session.pluginSnapshot ? session.pluginSnapshot.map(intern) : null;
    const tailSeqs = session.lastMessages ? session.lastMessages.map(intern) : null;

    return finishPlan(session, byRawRef, log, pluginSnapshotSeqs, tailSeqs);
}

/** New-row sentinels in reconciled plans: a slot the reconciler cannot
 *  pin to a stored row carries SENTINEL_BASE + its log index; the store
 *  renumbers them from max(stored seq)+1 inside the write transaction
 *  (same anchoring discipline the old delta path had, without the trust
 *  the watermark carried). The base sits far above any real seq and never
 *  touches the -1/-1 "no claim" block-bounds sentinel. */
const RECONCILE_SENTINEL_BASE = 2_000_000_000;

/** One serialized log entry without its seq — the shared per-message work
 *  of both planners (serializeForStore → #5627-guarded parse →
 *  splitMediaContent → role/kind → #4390 position-independent identity).
 *  Both planners MUST derive byte-identical entries from the same wire
 *  message: a drift here would make the deep and reconciled paths assign
 *  different content hashes to one logical message and fork the CAS pool. */
function entryFor(m: CoreMessage, byRawRef: Record<string, string>): Omit<LogEntry, "seq"> {
    const raw = serializeForStore(m);
    ingestSerializations.count++;
    const parsed = JSON.parse(raw) as { role: string; contentType?: string };
    const split = splitMediaContent(raw);
    return {
        msgId: m.id,
        content: split.content,
        hash: split.hash,
        identity: identityOfStoredContent(split.content),
        role: parsed.role,
        kind: parsed.contentType ?? "message",
        ref: byRawRef[m.id] ?? null,
        ...(split.media.length > 0 ? { media: split.media } : {}),
        ...(typeof m.ts === "number" ? { ts: m.ts } : {}),
    };
}

/** Cross-save reconciler (2026-11-21 — REPLACES planIngestDelta and the
 *  sessions.last_ingested_seq watermark it rode on). One save reconciles
 *  its log against the session's stored messages rows by CLIENT-SENT
 *  identity only: a presented msg id re-points at its stored row instead
 *  of writing a new one; everything genuinely new is a new row; rows whose
 *  identity the save does not present are retired by the store's sweep
 *  (completeLog gate — same discipline as the deep path). There is NO
 *  stored trust: nothing in the DB vouches for a prefix, a process
 *  handoff inherits nothing to be voided, and two writers converge on the
 *  same identities — the second simply re-points the rows the first wrote.
 *
 *  Cost model (the #3133 property, kept): a msg id with exactly ONE live
 *  stored row pins BLIND — zero serializations for that slot (client ids
 *  are content-derived, so a slot rewrite mints a NEW id and arrives as a
 *  new row; the same-id byte-drift residue — a #4390 wireIndex re-mint
 *  keeping id AND identity — rides the pinned old generation and is
 *  healed by the sampled verify → deep path within VERIFY_EVERY_INGESTS
 *  saves, the exact trade-off the #3919 delta made for its prefix). Only
 *  unknown ids, multi-generation ids (split tool-call cores, #1476) and
 *  tombstone rows (rewind-redo) pay stringify+hash.
 *
 *  `known` MUST come from the SAME transaction the plan is applied in
 *  (UnifiedStore.ingestReconciled reads it under BEGIN IMMEDIATE); a
 *  pre-transaction read could join against a partition a racing writer
 *  just changed and land a pin on a vanished row.
 *
 *  Pin shape: the pinned log slot carries ABSOLUTE stored seq, the stored
 *  content hash, and — for blind pins — EMPTY content (""), which tells
 *  the store's insert loop "live row, CAS intact: skip all CAS/media
 *  ops". New rows carry RECONCILE_SENTINEL_BASE + log index; tailSeqs /
 *  pluginSnapshotSeqs mix absolutes and sentinels until the store
 *  renumbers. `opts.deep` (drift-latched sessions, #5677) never pins — it
 *  delegates to planIngest so every row re-serializes and the save
 *  converges a proven-divergent view (the old latched-full behavior). */
export function planReconciled(
    session: LegacySessionLike,
    known: StoredMessageRow[],
    opts: { deep?: boolean } = {},
): IngestPlan {
    if (opts.deep === true) return planIngest(session);
    const byRawRef = session.state.messageRefs.byRaw;
    const knownById = new Map<string, StoredMessageRow[]>();
    for (const row of known) {
        const list = knownById.get(row.msgId);
        if (list === undefined) knownById.set(row.msgId, [row]);
        else list.push(row);
    }
    const log: LogEntry[] = [];
    const newDedup = new Map<string, number>();
    const intern = (m: CoreMessage): number => {
        const candidates = knownById.get(m.id);
        if (candidates !== undefined && candidates.length === 1) {
            const row = candidates[0];
            if (row.retiredAt === null) {
                // BLIND pin (the steady-state append): zero serializations.
                const idx = log.length;
                log.push({ seq: row.seq, msgId: m.id, content: "", hash: row.contentHash, identity: row.identity, role: "pinned", kind: "pinned", ref: byRawRef[m.id] ?? null });
                return idx;
            }
        }
        // Serialize: unknown id, multi-generation id, or a tombstone row
        // (rewind-redo — the insert loop restores its media mappings and
        // the store clears the tombstone when the identity matches).
        const entry = entryFor(m, byRawRef);
        let pin: StoredMessageRow | undefined;
        if (candidates !== undefined) {
            pin = candidates.find((r) => r.identity === entry.identity);
        }
        if (pin !== undefined) {
            const idx = log.length;
            log.push({ seq: pin.seq, ...entry });
            return idx;
        }
        // New row (or divergent generation): relative sentinel seq for now.
        // Two slots of the same NEW identity dedup onto one log entry —
        // the intra-plan half of #4182 falls out for free (both tailSeqs
        // slots carry that one entry's seq).
        const key = `${m.id}\u0000${entry.identity}`;
        const existing = newDedup.get(key);
        if (existing !== undefined) return existing;
        const idx = log.length;
        log.push({ seq: RECONCILE_SENTINEL_BASE + idx, ...entry });
        newDedup.set(key, idx);
        return idx;
    };
    // #3301: import payload first — same order as planIngest, so a deep
    // re-plan of the same session interns in the identical sequence.
    if (session.decompositionLog && session.decompositionLog.length > 0) session.decompositionLog.forEach(intern);
    // The plan's tail/snapshot pointers must carry each entry's OWN seq
    // (absolute for pins, sentinel for new rows) — NOT the log index. The
    // store's remap builds planToAbs keyed by the entry's seq; deep plans
    // happen to have seq === log index, but a reconciled plan's pins carry
    // arbitrary absolute seqs, so log-index pointers would silently
    // survive the remap as stale numbers (tail resolves to the wrong row
    // or to no row at all). finishPlan stores these arrays verbatim in
    // tail_json.
    const toSeqs = (idxs: number[] | null): number[] | null => (idxs === null ? null : idxs.map((i) => log[i]!.seq));
    const pluginSnapshotSeqs = session.pluginSnapshot ? toSeqs(session.pluginSnapshot.map(intern)) : null;
    const tailSeqs = session.lastMessages ? toSeqs(session.lastMessages.map(intern)) : null;
    return finishPlan(session, byRawRef, log, pluginSnapshotSeqs, tailSeqs);
}


/** Shared plan tail (everything except the messages log): given the same
 *  log + session, byte-identical output for both planners — the reconciler
 *  must not change what a deep ingest would write for the same log. (#4182:
 *  duplicate-identity slots dedup onto one log entry in both planners, so
 *  their tailSeqs slots share the one row's seq.) */
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
        identity: e.identity,
        ...(e.media && e.media.length > 0 ? { media: e.media } : {}),
        ...(typeof e.ts === "number" ? { ts: e.ts } : {}),
    }));

    // #4316 layer 3: the ledger positions of a block's covered messages —
    // min/max seq over the rows its coverage resolves to. Ghost ids (no row
    // in this plan's log) are skipped; a block whose coverage resolves to no
    // row keeps the -1/-1 "unknown bounds" shape (pre-layer-3
    // rows stored 0/0 placeholders; both are simply "no interval evidence"). These bounds are the durable interval form of coverage:
    // independent of message ids, so byte churn can never invalidate them.
    const seqById = new Map<string, number>();
    for (const e of log) if (!seqById.has(e.msgId)) seqById.set(e.msgId, e.seq);

    const blocks: BlockRow[] = session.state.blocks.map((b, ord) => {
        const views = completeBlockContents(session.blockContents, session.state.blocks).get(b.blockId);
        const full = views?.full ?? { text: b.summary, count: 0 };
        const one = views?.one ?? null;
        const summaryJson = JSON.stringify(full);
        const oneJson = one === null ? null : JSON.stringify(one);
        const covered = { effectiveMessageIds: b.effectiveMessageIds, directMessageIds: b.directMessageIds };
        let startSeq = -1;
        let endSeq = -1;
        for (const id of b.effectiveMessageIds) {
            const s = seqById.get(id);
            if (s === undefined) continue;
            if (startSeq === -1 || s < startSeq) startSeq = s;
            if (s > endSeq) endSeq = s;
        }
        return {
            blockId: b.blockId,
            ord,
            startSeq,
            endSeq,
            startRef: b.startRef !== undefined ? refToIndex(b.startRef) : null,
            endRef: b.endRef !== undefined ? refToIndex(b.endRef) : null,
            tier: b.tier,
            summary: summaryJson,
            one: oneJson,
            // #5744: carry the digests so ingestSession can compare against the
            // stored row BEFORE any CAS op (putContent with a precomputed hash
            // recomputes nothing — same bytes, same utf8, same sha256).
            summaryHash: sha256Hex(summaryJson),
            oneHash: oneJson === null ? null : sha256Hex(oneJson),
            supersedesBlockId: null,
            active: b.active,
            createdAt: b.createdAt,
            coveredHash: sha256Hex(JSON.stringify(covered)),
            payloadJson: JSON.stringify(b),
        };
    });

    // #4216/#4242: the orphan journal — blockContents entries whose block is
    // gone from state.blocks (#2695 reap keeps the contents for decompress).
    // Rides every plan; the store merges it into sessions.orphans_json in the
    // same transaction as the rest of the session. This is what makes the
    // reap shape REPRESENTABLE, so record() no longer skips the ingest (the
    // freeze in #4216: sessions stuck at hours-old rows).
    const knownBlockIds = new Set(session.state.blocks.map((b) => b.blockId));
    const orphanEntries: Record<string, { one: unknown; full: unknown }> = {};
    for (const [blockId, view] of session.blockContents) {
        if (!knownBlockIds.has(blockId)) orphanEntries[blockId] = { one: view.one, full: view.full };
    }
    const orphansJson = Object.keys(orphanEntries).length > 0 ? JSON.stringify(orphanEntries) : null;

    const deadRefs = (session.state.deadRefs ?? []).map((ref, ord) => ({
        ord,
        ref,
        refNum: refToIndex(ref) ?? Number.MAX_SAFE_INTEGER,
        recordedAt: session.lastSeen,
    }));

    const ccrEntries: CcrEntryRow[] = session.contentStore
        ? Object.entries(session.contentStore.byRef).map(([key, value], ord) => {
              const content = JSON.stringify(value);
              return { ord, key, content, contentHash: sha256Hex(content) };
          })
        : [];

    const kstate: Record<string, unknown> = {};
    for (const field of MERGE_STATE_FIELDS) {
        if (TABLE_OWNED_FIELDS.has(field)) continue;
        const v = (session.state as Record<string, unknown>)[field];
        if (v !== undefined) kstate[field] = v;
    }

    const sessionRow: SessionRow = {
        sessionId: session.id,
        // #4390: fork lineage into the unified row — the envelope's
        // metadata.derivedFromSessionId (written by handle.ts at fork time)
        // used to be the ONLY carrier; envelope loss orphaned the family.
        parentSessionId: typeof session.metadata.derivedFromSessionId === "string" && session.metadata.derivedFromSessionId.length > 0
            ? session.metadata.derivedFromSessionId
            : null,
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
        orphansJson,
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

interface LegacyViewRows {
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
        orphansJson?: string | null;
    };
    messages: { seq: number; msgId: string; ref: string | null; content: string }[];
    blocks: { blockId: string; summary: string; one: string | null; payloadJson: string }[];
    deadRefs: { ord: number; ref: string }[];
    refs: { ord: number; rawId: string; ref: string }[];
}

interface LegacyView {
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
    /** #4390: tail/pluginSnapshot pointers whose backing row is missing. */
    tailGaps?: number;
}

type BlockContents = LegacyView["blockContents"];

/** Shared by full-view and resident-field reads; each page is released after parsing. */
export function appendBlockContents(contents: BlockContents, rows: Pick<LegacyViewRows["blocks"][number], "blockId" | "summary" | "one">[]): void {
    for (const b of rows) {
        contents.set(b.blockId, {
            one: b.one === null ? null : (JSON.parse(b.one) as BlockView),
            full: JSON.parse(b.summary) as BlockView,
        });
    }
}

export function mergeOrphanBlockContents(contents: BlockContents, orphansJson: string | null | undefined): void {
    // Reaped originals survive without resurrecting their state.blocks rows.
    if (orphansJson !== null && orphansJson !== undefined && orphansJson !== "") {
        try {
            const orphans = JSON.parse(orphansJson) as Record<string, { one: BlockView | null; full: BlockView }>;
            for (const [blockId, view] of Object.entries(orphans)) {
                if (!contents.has(blockId)) contents.set(blockId, view);
            }
        } catch {
            // corrupt journal → skip; the JSON envelope still carries the text
        }
    }
}

/** Incremental cold-load assembly keeps raw CAS strings to one page at a time. */
export class LegacyViewBuilder {
    readonly messageSeqs: number[];
    private readonly tail: {
        pluginSnapshotSeqs: number[] | null;
        tailSeqs: number[] | null;
        tailFolded: boolean;
    };
    private readonly state: Record<string, unknown> = {};
    private readonly blocks: unknown[] = [];
    private readonly blockContents: BlockContents = new Map();
    private readonly messagesBySeq = new Map<number, CoreMessage>();

    constructor(
        private readonly session: LegacyViewRows["session"],
        refs: LegacyViewRows["refs"],
        deadRefs: LegacyViewRows["deadRefs"],
    ) {
        const kstate = JSON.parse(session.kstateJson) as Record<string, unknown>;
        this.tail = JSON.parse(session.tailJson);
        this.messageSeqs = [...new Set([...(this.tail.tailSeqs ?? []), ...(this.tail.pluginSnapshotSeqs ?? [])])];

        // messageRefs rebuilt from the ref ledger verbatim: ord preserves the
        // persisted map's key order (digest-sensitive), and ghost ids survive
        // even though no message row backs them (#2362 Kernel Contract).
        const byRaw: Record<string, string> = {};
        const byRef: Record<string, string> = {};
        for (const r of refs) {
            byRaw[r.rawId] = r.ref;
            // "BLOCKED" is a byRaw-only token: the in-memory map keeps the
            // inverse projection strictly mNNNNN→rawId. Admitting it into byRef
            // mints a key the persisted state never had (#2671 soak: sub-agent
            // sessions with protected messages drifted on every save).
            if (r.ref !== "BLOCKED" && byRef[r.ref] === undefined) byRef[r.ref] = r.rawId;
        }

        const state = this.state;
        for (const field of MERGE_STATE_FIELDS) {
            switch (field) {
                case "blocks":
                    state.blocks = this.blocks;
                    break;
                case "messageRefs":
                    state.messageRefs = { byRaw, byRef };
                    break;
                case "deadRefs":
                    state.deadRefs = deadRefs.length > 0 ? deadRefs.map((d) => d.ref) : undefined;
                    break;
                case "nextBlockId":
                    state.nextBlockId = session.nextBlockId;
                    break;
                case "nextRunId":
                    state.nextRunId = session.nextRunId;
                    break;
                default:
                    if (kstate[field] !== undefined) state[field] = kstate[field];
                    break;
            }
        }
    }

    addBlocks(rows: LegacyViewRows["blocks"]): void {
        for (const b of rows) this.blocks.push(JSON.parse(b.payloadJson));
        appendBlockContents(this.blockContents, rows);
    }

    addMessages(rows: LegacyViewRows["messages"]): void {
        for (const m of rows) this.messagesBySeq.set(m.seq, JSON.parse(m.content) as CoreMessage);
    }

    finish(): LegacyView {
        const s = this.session;
        const tail = this.tail;
        mergeOrphanBlockContents(this.blockContents, s.orphansJson);
        // #4390: a tail pointer whose row is gone used to be silently filtered
        // out — the view shrank with no trace. Count the gaps so callers can
        // warn (persist logs them); the surviving members still load.
        let tailGaps = 0;
        const resolveSeqs = (seqs: number[]): CoreMessage[] => {
            const out: CoreMessage[] = [];
            for (const seq of seqs) {
                const m = this.messagesBySeq.get(seq);
                if (m === undefined) tailGaps++;
                else out.push(m);
            }
            return out;
        };
        const lastMessages = tail.tailSeqs ? resolveSeqs(tail.tailSeqs) : undefined;
        const pluginSnapshot = tail.pluginSnapshotSeqs ? resolveSeqs(tail.pluginSnapshotSeqs) : undefined;

        const out: LegacyView = {
            id: s.sessionId,
            createdAt: s.createdAt,
            lastSeen: s.updatedAt,
            tailGaps,
            meta: JSON.parse(s.metaJson),
            stats: JSON.parse(s.statsJson),
            metadata: JSON.parse(s.metadataJson),
            state: this.state,
            blockContents: this.blockContents,
            lastMessages,
            lastMessagesFolded: tail.tailFolded,
        };
        if (pluginSnapshot) out.pluginSnapshot = pluginSnapshot;
        if (s.ccrJson !== null) out.contentStore = JSON.parse(s.ccrJson);
        return out;
    }
}

/** Compatibility wrapper for callers that already hold all rows. */
export function loadLegacyView(rows: LegacyViewRows): LegacyView {
    const builder = new LegacyViewBuilder(rows.session, rows.refs, rows.deadRefs);
    builder.addBlocks(rows.blocks);
    builder.addMessages(rows.messages);
    return builder.finish();
}
