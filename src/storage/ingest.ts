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
     *  lowest seqs (they are the oldest evidence). Consumed by the full
     *  ingest only; the delta planner falls back to the full path while it is
     *  present (its rows would otherwise be skipped as "trusted prefix"). */
    decompositionLog?: CoreMessage[];
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
    const intern = (m: CoreMessage): number => {
        const raw = JSON.stringify(m);
        ingestSerializations.count++;
        const parsed = JSON.parse(raw) as { role: string; contentType?: string };
        const split = splitMediaContent(raw);
        const entry = { msgId: m.id, content: split.content, hash: split.hash, role: parsed.role, kind: parsed.contentType ?? "message", media: split.media };
        // #4390: the cross-save JOIN key is the POSITION-INDEPENDENT identity
        // (stored-bytes serialization minus id/wireIndex). content_hash stays
        // the byte-faithful CAS key; only the join moves to identity.
        const identity = identityOfStoredContent(entry.content);
        const key = `${m.id}\u0000${identity}`;
        const existing = seqByIdentity.get(key);
        if (existing !== undefined) return existing;
        const seq = log.length;
        seqByIdentity.set(key, seq);
        log.push({ seq, msgId: m.id, content: entry.content, hash: entry.hash, identity, role: entry.role, kind: entry.kind, ref: byRawRef[m.id] ?? null, ...(entry.media.length > 0 ? { media: entry.media } : {}) });
        return seq;
    };
    // #3301: import payload first — its rows must sit below the snapshot/tail
    // seqs so the stored log reads oldest-evidence-first.
    if (session.decompositionLog && session.decompositionLog.length > 0) session.decompositionLog.forEach(intern);
    const pluginSnapshotSeqs = session.pluginSnapshot ? session.pluginSnapshot.map(intern) : null;
    const tailSeqs = session.lastMessages ? session.lastMessages.map(intern) : null;

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
 *  stringify+hash; given the same log, finishPlan() emits every row family
 *  byte-identical to planIngest's. The store-state equivalence holds under
 *  a strict-append precondition (#4182): no message in tail[L..] may
 *  carry an ALREADY-STORED identity (msg_id + content_hash). The planner
 *  cannot see stored prefix identities — that is the point of skipping
 *  them — so a resent/replayed message (#3661-class: content-derived ids
 *  mean a resend IS the same identity) is appended as a fresh placeholder
 *  slot, and the RAW PLAN diverges from planIngest, which dedups it onto
 *  its existing seq via seqByIdentity. That divergence is by design,
 *  neutralized at the store layer: UnifiedStore.ingestSession's delta
 *  branch probes every new message's identity against the messages table
 *  inside its transaction (the strictly-append guard behind
 *  UNIQUE(session_id, msg_id, content_hash), SQLite + MySQL) and refuses
 *  the whole plan on any hit; the caller then runs the exact full path,
 *  whose dedup makes the COMMITTED store state equal to a pure full
 *  ingest's anyway. Cost of a violation: one refused delta attempt + one
 *  redundant full write — never wrong rows.
 *
 *  A second, intra-plan facet of the #4182 divergence stays open: two NEW
 *  byte-identical messages inside the same tail share ONE content-derived
 *  identity, so both pass the stored-identity probe above; the UNIQUE
 *  constraint then silently skips the second insert, leaving its tailSeqs
 *  slot pointing at nothing — the read view drops that entry for one save
 *  cycle. The next save self-heals: the boundary probe finds no row at the
 *  new watermark, refuses the delta, and the exact full path re-dedups.
 *  Bounded and unusual-input-only; closing it (an intra-plan seen-set in
 *  the store guard) changes fallback behavior and is a separate decision.
 *
 *  Returns null (→ full ingest) when: a pluginSnapshot is present (its
 *  entries may dedup against the trusted prefix and renumber the log),
 *  the tail is absent or not longer than the trusted prefix (shrunk /
 *  rewound / folded-in-place), or the boundary identity disagrees with the
 *  tail slot at L-1 (edited/deleted/re-minted history). Interior edits
 *  BELOW the boundary are the watermark design's accepted trade-off — they
 *  never mis-attribute, only leave stale rows, and the sampled verify
 *  digest is the backstop. Exception (#3919): the HEAD slot (index 0) is
 *  additionally probed via `head` (id-only, zero serialization cost — core
 *  ids are content-derived, so a rewrite changes the id) so prefix rewrites
 *  fail the delta immediately instead of riding it for ≤ VERIFY_EVERY_
 *  INGESTS saves; deeper same-id byte drift below the boundary stays the
 *  sampled backstop's job. */
export function planIngestDelta(
    session: LegacySessionLike,
    watermark: number,
    trustedTailSeqs: number[],
    boundary: { msgId: string; contentHash: string },
    hasRawTail: boolean,
    head?: { msgId: string } | null,
): IngestPlan | null {
    if (session.pluginSnapshot && session.pluginSnapshot.length > 0) return null;
    // #3301: an import payload would be skipped as "trusted prefix" here — force
    // the full path so its rows actually land.
    if (session.decompositionLog && session.decompositionLog.length > 0) return null;
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
    // #3762: the stored boundary hash covers the MEDIA-SPLIT serialization;
    // split the probe the same way so image messages verify identically.
    if (tail[trustedLen - 1].id !== boundary.msgId || splitMediaContent(probe).hash !== boundary.contentHash) return null;
    // #3919 head probe: the positional assumption covers the whole trusted
    // prefix, but historically only its LAST slot was vouched for — a
    // rewrite of an older message below the boundary rode the delta until
    // the sampled verify cleared the watermark ≤ VERIFY_EVERY_INGESTS saves
    // later (in full mode those stale bytes could even be served from the
    // index). Id-only compare: core ids are content-derived, so a rewrite
    // changes the id at zero serialization cost per save; mismatch fails
    // soft to the exact full path. Deeper same-id byte drift below the
    // boundary stays the sampled backstop's job (trade-off unchanged).
    if (head !== undefined && head !== null && trustedLen > 1 && tail[0].id !== head.msgId) return null;
    const byRawRef = session.state.messageRefs.byRaw;
    const log: LogEntry[] = [];
    const appended: number[] = [];
    for (let i = trustedLen; i < tail.length; i++) {
        const m = tail[i];
        const raw = JSON.stringify(m);
        ingestSerializations.count++;
        const parsed = JSON.parse(raw) as { role: string; contentType?: string };
        const split = splitMediaContent(raw);
        // Placeholder seqs under the aligned assumption (no rows above the
        // watermark); ingestSession renumbers from max(seq)+1 inside the
        // transaction when a fold left rows above the trusted tip.
        const seq = watermark + 1 + log.length;
        appended.push(seq);
        log.push({
            seq,
            msgId: m.id,
            content: split.content,
            hash: split.hash,
            identity: identityOfStoredContent(split.content),
            role: parsed.role,
            kind: parsed.contentType ?? "message",
            ref: byRawRef[m.id] ?? null,
            ...(split.media.length > 0 ? { media: split.media } : {}),
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

/** Shared plan tail (everything except the messages log): given the same
 *  log + session, byte-identical output for both planners — the watermark
 *  fast path must not change what a full ingest would write. (#4182: the
 *  duplicate-identity case feeds this function DIFFERENT logs by design;
 *  see planIngestDelta's strict-append precondition.) */
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
            summary: JSON.stringify(full),
            one: one === null ? null : JSON.stringify(one),
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
            orphansJson?: string | null;
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
    /** #4390: tail/pluginSnapshot pointers whose backing row is missing. */
    tailGaps?: number;
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
    // #3841 reap journal: journal'd orphan contents (reaped blocks) ride
    // blockContents so the derived-decompress fallback survives restarts —
    // WITHOUT resurrecting state.blocks (the reaped entries stay reaped).
    if (s.orphansJson !== null && s.orphansJson !== undefined && s.orphansJson !== "") {
        try {
            const orphans = JSON.parse(s.orphansJson) as Record<string, { one: BlockView | null; full: BlockView }>;
            for (const [blockId, view] of Object.entries(orphans)) {
                if (!blockContents.has(blockId)) blockContents.set(blockId, view);
            }
        } catch {
            // corrupt journal → skip; the JSON envelope still carries the text
        }
    }

    const messagesBySeq = new Map(rows.messages.map((m) => [m.seq, JSON.parse(m.content) as CoreMessage]));
    // #4390: a tail pointer whose row is gone used to be silently filtered
    // out — the view shrank with no trace. Count the gaps so callers can
    // warn (persist logs them); the surviving members still load.
    let tailGaps = 0;
    const resolveSeqs = (seqs: number[]): CoreMessage[] => {
        const out: CoreMessage[] = [];
        for (const seq of seqs) {
            const m = messagesBySeq.get(seq);
            if (m === undefined) tailGaps++;
            else out.push(m);
        }
        return out;
    };
    const lastMessages = tail.tailSeqs ? resolveSeqs(tail.tailSeqs) : undefined;
    const pluginSnapshot = tail.pluginSnapshotSeqs ? resolveSeqs(tail.pluginSnapshotSeqs) : undefined;

    const out: ReturnType<typeof loadLegacyView> = {
        id: s.sessionId,
        createdAt: s.createdAt,
        lastSeen: s.updatedAt,
        tailGaps,
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
