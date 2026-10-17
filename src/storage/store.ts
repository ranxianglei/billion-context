/**
 * Unified storage store (#2671 Phase 1).
 *
 * One SQLite database (index.db, WAL) + content-addressed blobs in the
 * content table. Every mutation is one transaction; messages and content
 * are append-only.
 *
 * Phase 1 fidelity contract (pinned by tests/storage-unified.test.ts against
 * tests/golden/storage-corpus): a legacy session ingested here and loaded
 * via loadLegacyView() MUST reproduce the exact canonical digest that
 * SessionStore.loadSync produces for the same on-disk files.
 *
 * Representation discipline: verbatim facts (payload_json / content / *_json
 * bags) are the truth; scalar columns are projections; verifyProjections()
 * asserts they agree. Readers migrate from facts to projections field by
 * field, always guarded by those assertions.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log as loggerLog } from "../logger.js";
import { openSqliteDatabase, type SqliteDatabase, type SqliteEngineName, type SqliteEngineSource } from "./driver.js";
import { migrateSchema, storagePragmas, WAL_JOURNAL_SIZE_LIMIT } from "./schema.js";
import type { StorageBackend } from "./backend.js";
import type { MessageContentStore } from "acp-kernel";

/** #3250: run a PASSIVE wal_checkpoint every N successful ingests. The
 *  built-in autocheckpoint alone cannot guarantee reclamation in a long-lived
 *  process: while a foreign connection holds a read snapshot (dashboard /
 *  export / second lane sharing the directory — #2671 topology) WAL backfill
 *  is blocked at that snapshot and the file grows until the reader lets go.
 *  PASSIVE never blocks the ingest path; a failed checkpoint is logged and
 *  forgotten — the next tick retries and journal_size_limit does the rest. */
const WAL_CHECKPOINT_EVERY_INGESTS = 20;

export function sha256Hex(bytes: string | Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export interface SessionRow {
    sessionId: string;
    parentSessionId?: string | null;
    forkPointSeq?: number | null;
    protocol?: string | null;
    label?: string | null;
    title?: string | null;
    hostTitle?: string | null;
    /** #2960: owning agent namespace (metadata.pluginAgent, "proxy" for
     *  bare proxy lanes) and the persistence-time upstream origin. Identity
     *  metadata — R2.1 will make them part of the row key. */
    namespace?: string;
    origin?: string | null;
    status?: string;
    createdAt: number;
    updatedAt: number;
    nextBlockId: number;
    nextRunId: number;
    metaJson: string;
    statsJson: string;
    metadataJson: string;
    /** Kernel-state fields with no dedicated tables yet, EXCLUDING
     *  blocks/messageRefs/deadRefs/nextBlockId/nextRunId (those come from
     *  tables). Key order inside is irrelevant — loadLegacyView rebuilds the
     *  state object in mergeState field order. */
    kstateJson: string;
    /** View pointers: {tailSeqs: number[]|null, tailFolded: boolean,
     *  pluginSnapshotLen: number|null}. Content itself lives in messages. */
    tailJson: string;
    /** Verbatim CCR store JSON (dying subsystem, Phase 3 removes it). */
    ccrJson: string | null;
    /** #3133 ingest watermark: highest absolute message seq whose bytes this
     *  index has verified (NULL = no trusted prefix → next save ingests
     *  fully). Computed by ingestSession only (delta provenance or full-path
     * alignment) — never by planners or callers; read via ingestWatermark(). */
    lastIngestedSeq?: number | null;
}

export interface MessageRow {
    seq: number;
    msgId: string;
    /** Verbatim ref token from state.messageRefs.byRaw (may be "BLOCKED"). */
    ref: string | null;
    /** Numeric projection of ref (null when ref is null or non-numeric). */
    refNum: number | null;
    role: string;
    kind: string;
    /** Verbatim serialized message (includes id; exact parsed-file bytes). */
    content: string;
    /** #3133: sha256(content) as computed by the planner's intern pass —
     *  lets ingestSession skip re-hashing every message on every save.
     *  Identical value to sha256Hex(content); optional for direct callers. */
    contentHash?: string;
}

export interface BlockRow {
    blockId: string;
    ord: number;
    startSeq: number;
    endSeq: number;
    startRef: number | null;
    endRef: number | null;
    tier: number;
    /** JSON of the full BlockView {text, count}. */
    summary: string;
    /** JSON of the one-line BlockView, or null (legacy #401 collapse). */
    one: string | null;
    supersedesBlockId: string | null;
    active: boolean;
    createdAt: number;
    coveredHash: string;
    /** Verbatim serialized CompressionBlock (includes summary). */
    payloadJson: string;
}

export interface RefRow {
    ord: number;
    rawId: string;
    /** Verbatim ref token ("m00123" or "BLOCKED"). */
    ref: string;
    refNum: number | null;
}

export interface CcrEntryRow {
    ord: number;
    key: string;
    content: string;
}

/** One checkpoint/replica row (Phase 2, #2671). `state_hash` never leaves
 *  the store — list/get return this projection only; the blob itself is
 *  read via checkpointState() when restoring. */
export interface CheckpointRow {
    cp_id: string;
    session_id: string;
    seq_at: number;
    block_set_hash: string;
    kind: "auto" | "manual" | "replica" | "fork_base";
    created_at: number;
    pinned: number;
    label: string | null;
}

/** Summary row for the export/web list fast path (#2960 R2.1). Parity
 *  contract with the legacy walk in export.ts listSessions. updatedAt (#3199)
 *  = sessions.updated_at (ms epoch, last ingest time) — boot uses it as the
 *  alias savedAt when seeding label aliases from rows without decoding files. */
export interface SessionSummaryRow {
    sessionId: string;
    title: string | undefined;
    label: string | undefined;
    protocol: string | undefined;
    origin: string | undefined;
    namespace: string;
    blocks: number;
    latestBlockAt: number | undefined;
    contextTokens: number | undefined;
    updatedAt: number;
}

/** #2960 R2.2: row backing the WEB session list in full mode. Carries the
 *  JSON columns the web summaryOf needs (stats/metadata) plus block
 *  aggregates extracted from payloads (topic/summary lead of the first
 *  block, gross compressed tokens over ACTIVE blocks) — everything the
 *  bounded disk index used to decode whole envelope files for. */
export interface WebSummaryRow {
    sessionId: string;
    title: string | undefined;
    hostTitle: string | undefined;
    label: string | undefined;
    protocol: string | undefined;
    origin: string | undefined;
    updatedAt: number;
    statsJson: string;
    metadataJson: string;
    blocks: number;
    firstTopic: string | null;
    firstSummary: string | null;
    activeCompressedTokens: number;
}

export interface IngestSessionInput {
    session: SessionRow;
    messages: MessageRow[];
    blocks: BlockRow[];
    deadRefs: { ord: number; ref: string; refNum: number; recordedAt: number }[];
    refs: RefRow[];
    ccrEntries: CcrEntryRow[];
    /** Plan-space pointer sequences (indices into `messages`), if the caller
     *  has them. ingestSession rewrites both the rows and these pointers to
     *  absolute seqs before insert — see remapPlanSeqs. */
    pluginSnapshotSeqs?: number[] | null;
    tailSeqs?: number[] | null;
}

/** Extension-namespace guards (#3069): keys/namespaces are non-empty
 *  printable ASCII-range strings up to 256 chars — loose by design (callers
 *  namespace by convention like "r3:" / "web:" / "lane:"), hostile by
 *  accident is what we guard, not hostile by design. */
const EXT_KEY_MAX = 256;
const EXT_VALUE_MAX_BYTES = 4 * 1024 * 1024;

function validateExtKey(value: string, what: string): void {
    if (typeof value !== "string" || value.length === 0 || value.length > EXT_KEY_MAX) {
        throw new Error(`[storage] extension ${what} must be a non-empty string of at most ${EXT_KEY_MAX} characters`);
    }
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) {
            throw new Error(`[storage] extension ${what} must not contain control characters`);
        }
    }
}

function serializeExtValue(value: unknown): string {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new Error("[storage] extension values must be JSON-serializable (undefined/functions are not)");
    }
    if (json.length > EXT_VALUE_MAX_BYTES) {
        throw new Error(`[storage] extension value exceeds ${EXT_VALUE_MAX_BYTES} bytes — store large payloads in the content CAS instead`);
    }
    return json;
}

/** Escapes LIKE metacharacters for the ESCAPE '\\' clause used by listKv. */
function likeEscape(prefix: string): string {
    return prefix.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

export class UnifiedStore implements StorageBackend {
    readonly engine: SqliteEngineName;
    /** Where the engine came from (#2833): builtin / host / self-downloaded — logged at enable so field diagnosis can tell which acquisition path a lane ran on. */
    readonly engineSource: SqliteEngineSource;
    private readonly db: SqliteDatabase;
    /** #3250: successful-ingest counter driving the WAL_CHECKPOINT_EVERY_INGESTS cadence. */
    private ingestCount = 0;

    private constructor(db: SqliteDatabase, engine: SqliteEngineName, engineSource: SqliteEngineSource) {
        this.db = db;
        this.engine = engine;
        this.engineSource = engineSource;
    }

    static open(
        path: string,
        engine?: SqliteEngineName,
        opts?: { walJournalSizeLimitBytes?: number },
    ): UnifiedStore {
        mkdirSync(dirname(path), { recursive: true });
        const { db, engine: used, source } = openSqliteDatabase(path, engine);
        try {
            const limit = opts?.walJournalSizeLimitBytes ?? WAL_JOURNAL_SIZE_LIMIT;
            for (const pragma of storagePragmas(limit)) db.exec(pragma);
            migrateSchema(db);
        } catch (err) {
            // The handle we just opened must not leak when the file turns out
            // to be corrupt: the #2771 fallback tells operators to DELETE the
            // file to reset the index — and Windows refuses to delete a file a
            // live process still holds open. Close, then rethrow for the
            // shadow's legacy-only degradation.
            db.close();
            throw err;
        }
        // #3250: converge the WAL an unclean exit left behind (SIGKILL / power
        // loss never reaches close()). Moving committed frames into the main db
        // now shortens the NEXT crash's recovery replay. Isolated from the open
        // contract above on purpose: under a multi-process shared directory
        // (#2671) a TRUNCATE can come back busy while a foreign connection is
        // mid-transaction — that must log, not fail the open; the periodic and
        // close-time passes retry the reclamation.
        try {
            db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        } catch (err) {
            loggerLog("warn", `[storage] WAL checkpoint on open failed for ${path}: ${String(err)}`);
        }
        return new UnifiedStore(db, used, source);
    }

    close(): void {
        // #3250: converge the WAL before releasing the handle so a clean exit
        // leaves nothing for the next boot's recovery to replay. Same isolation
        // as open(): a checkpoint hiccup logs and never throws — callers treat
        // close() as best-effort shutdown work.
        try {
            this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        } catch (err) {
            loggerLog("warn", `[storage] WAL checkpoint on close failed: ${String(err)}`);
        }
        try {
            this.db.close();
        } catch (err) {
            loggerLog("warn", `[storage] db handle release on close failed: ${String(err)}`);
        }
    }

    /** #3049: O(1) ownership probe for the persist stale-guard. Reads only
     *  the two monotonic counters the rollback guard compares (stats.requests,
     *  state.nextBlockId) — never the payload columns — so the guard can skip
     *  its full envelope read+parse when nothing else has committed since this
     *  process's last save. next_block_id is a dedicated column; requests is
     *  the one small stats_json parse. Null = no row yet (organic import
     *  pending / foreign id). */
    sessionCounters(sessionId: string): { requests: number; nextBlockId: number } | null {
        const row = this.db
            .prepare("SELECT next_block_id, stats_json FROM sessions WHERE session_id = ?")
            .get(sessionId) as { next_block_id: number; stats_json: string } | undefined;
        if (!row) return null;
        try {
            const stats = JSON.parse(row.stats_json) as { requests?: unknown };
            return {
                requests: typeof stats.requests === "number" ? stats.requests : 0,
                nextBlockId: row.next_block_id,
            };
        } catch {
            return null;
        }
    }

    /** Content CAS: insert-if-absent + refcount bump; returns hash. */
    private putContent(content: string | Buffer, precomputedHash?: string): string {
        const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        // #3133: planner-produced rows carry the digest from their intern or
        // delta pass — skip the per-message re-hash here (same value: sha256
        // over the same utf8 bytes). Only direct callers without a planner
        // pay the hash at this layer.
        const hash = precomputedHash ?? sha256Hex(bytes);
        const existing = this.db.prepare("SELECT refcount FROM content WHERE hash = ?").get(hash) as
            | { refcount: number }
            | undefined;
        if (existing) {
            this.db.prepare("UPDATE content SET refcount = refcount + 1 WHERE hash = ?").run(hash);
        } else {
            this.db
                .prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 1, 'sha256', ?)")
                .run(hash, bytes.byteLength, bytes);
        }
        return hash;
    }

    /** refcount-aware release; the CAS body itself never leaves. */
    private releaseContent(hash: string | null): void {
        if (!hash) return;
        this.db.prepare("UPDATE content SET refcount = MAX(refcount - 1, 0) WHERE hash = ?").run(hash);
    }

    /** Ingests one session plan as a single transaction. Full path (no
     *  `delta`): identity-based absolute-seq remap of every plan row; the
     *  watermark becomes the abs seq backing the plan's LAST tail message
     *  (NULL when the plan carries no tail) — the trusted tip need not be
     *  the table's max, because delta appends anchor at max(seq)+1, never
     *  at watermark+1, so rows above the tip (a fold's summary) cannot
     *  collide with them.
     *
     *  Delta path (#3133, `delta` given): the plan carries ONLY messages
     *  past the trusted prefix, with placeholder seqs (renumbered here).
     *  The boundary row (msg_id + content_hash at seq trustedSeq) is
     *  RE-VERIFIED inside this transaction (BEGIN IMMEDIATE serializes
     *  writers, so the in-tx check is authoritative — the caller's pre-plan
     *  probe was just an optimization), every delta message's identity must
     *  be absent (strictly-append — a re-derived tail would otherwise be
     *  silently dropped by the UNIQUE constraint), and new rows take
     *  max(seq)+1.. so no slot can collide. On any disagreement this
     *  returns false WITHOUT writing anything; the caller falls back to the
     *  full plan. A stale or foreign-written watermark therefore costs one
     *  redundant full write — never wrong rows — and the watermark write
     *  itself rides the SAME transaction as the rows. */
    ingestSession(
        input: IngestSessionInput,
        delta?: { trustedSeq: number; boundaryMsgId: string; boundaryHash: string; trustedTailSeqs: number[] },
        opts?: { completeLog?: boolean },
    ): boolean {
        const s = input.session;
        const ok = this.db.transaction((): boolean => {
            let messages: MessageRow[];
            let watermark: number | null;
            if (delta) {
                const probe = this.probeIngestBoundary(s.sessionId, delta.trustedSeq);
                if (!probe || probe.msgId !== delta.boundaryMsgId || probe.contentHash !== delta.boundaryHash) {
                    return false;
                }
                // Strictly-append guard: a delta message whose identity
                // already has a row (rewound/re-derived tail) must not be
                // silently skipped by the UNIQUE(session_id, msg_id,
                // content_hash) constraint — its tailSeqs slot would point
                // at nothing and the read view would drop it. One indexed
                // probe per NEW message; any hit → full ingest instead.
                const existingIdentity = this.db.prepare(
                    "SELECT 1 FROM messages WHERE session_id = ? AND msg_id = ? AND content_hash = ?",
                );
                for (const m of input.messages) {
                    if (!m.contentHash) return false;
                    if (existingIdentity.get(s.sessionId, m.msgId, m.contentHash)) return false;
                }
                // Placeholder→absolute renumber: the plan emitted
                // watermark+1.. under the aligned assumption; anchoring at
                // the CURRENT max(seq)+1 (re-read inside this transaction)
                // is what makes slot collisions structurally impossible —
                // identical to the full path's nextSeq discipline, and it
                // keeps the delta valid even when a fold left rows above
                // the trusted tip.
                messages = input.messages.map((m, i) => ({ ...m, seq: probe.maxSeq + 1 + i }));
                const tail = JSON.parse(s.tailJson) as { tailSeqs?: number[] | null };
                // Defense: the plan's tailSeqs prefix must be exactly the
                // trusted prefix the watermark read produced (same-tick by
                // construction; disagreement means a stale plan).
                const prefixOk =
                    Array.isArray(tail.tailSeqs) &&
                    tail.tailSeqs.length === delta.trustedTailSeqs.length + input.messages.length &&
                    delta.trustedTailSeqs.every((v, i) => tail.tailSeqs?.[i] === v);
                if (!prefixOk) return false;
                s.tailJson = JSON.stringify({
                    ...tail,
                    tailSeqs: [...delta.trustedTailSeqs, ...messages.map((m) => m.seq)],
                });
                watermark = messages.length > 0 ? messages[messages.length - 1].seq : delta.trustedSeq;
            } else {
                const full = this.remapPlanToAbsolute(input);
                messages = full.messages;
                watermark = full.watermark;
                // #3285: authoritative-set discipline for messages — same as
                // blocks / refs / dead_refs / ccr_entries below, but ONLY when
                // completeLog says the plan IS the whole log (the raw tail).
                // Envelope-only plans are pruned renders (bounded folded view,
                // #2960 ⑤; folded-resident re-renders, persist ②a caveat), and
                // sweeping on those would delete raw rows that earlier saves
                // interned beyond the render window. With a complete plan,
                // rows whose identity is absent are stale — foreign-writer
                // leftovers from a restart-handoff overlap (#3285/#2671 shared
                // directory) or below-boundary rewrites the sampled digest
                // caught (#3166). INSERT OR IGNORE alone can never remove
                // them, so without this sweep they ride every unified replay
                // forever (permanent DIGEST DRIFT even after the #3166
                // watermark-clear heal). Release their CAS refs and drop them.
                //
                // LANE EXCLUSION (#3248): the incremental lane consumes this
                // table POSITIONALLY — its baseSeq epoch is an absolute row
                // count recorded at resync, and rejected-branch rows must stay
                // in the table as an audit floor the served history slices
                // past. Sweeping them would invalidate the epoch (cold rebuild
                // serves an empty canonical → 409 loop). Lane-owned sessions
                // therefore opt out; they keep #3166-class orphans (bounded —
                // the boot watermark reset still re-establishes delta trust).
                if (opts?.completeLog === true && !this.hasLaneExt(s.sessionId)) {
                    const incomingIds = new Set<string>();
                    for (const m of messages) {
                        incomingIds.add(`${m.msgId}\u0000${m.contentHash ?? sha256Hex(m.content)}`);
                    }
                    const staleRows = this.db
                        .prepare("SELECT seq, msg_id, content_hash FROM messages WHERE session_id = ?")
                        .all(s.sessionId) as { seq: number; msg_id: string; content_hash: string }[];
                    for (const row of staleRows) {
                        if (incomingIds.has(`${row.msg_id}\u0000${row.content_hash}`)) continue;
                        this.releaseContent(row.content_hash);
                        this.db.prepare("DELETE FROM messages WHERE session_id = ? AND seq = ?").run(s.sessionId, row.seq);
                    }
                }
            }
            this.db
                .prepare(
                    `INSERT INTO sessions (session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, namespace, origin,
                       status, created_at, updated_at, next_block_id, next_run_id,
                       meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json, last_ingested_seq)
                     VALUES (@sessionId, @parentSessionId, @forkPointSeq, @protocol, @label, @title, @hostTitle, @namespace, @origin,
                       @status, @createdAt, @updatedAt, @nextBlockId, @nextRunId,
                       @metaJson, @statsJson, @metadataJson, @kstateJson, @tailJson, @ccrJson, @lastIngestedSeq)
                     ON CONFLICT(session_id) DO UPDATE SET
                       parent_session_id = excluded.parent_session_id,
                       fork_point_seq = excluded.fork_point_seq,
                       protocol = excluded.protocol,
                       label = excluded.label,
                       title = excluded.title,
                       host_title = excluded.host_title,
                       namespace = excluded.namespace,
                       origin = excluded.origin,
                       status = excluded.status,
                       updated_at = excluded.updated_at,
                       next_block_id = excluded.next_block_id,
                       next_run_id = excluded.next_run_id,
                       meta_json = excluded.meta_json,
                       stats_json = excluded.stats_json,
                       metadata_json = excluded.metadata_json,
                       kstate_json = excluded.kstate_json,
                       tail_json = excluded.tail_json,
                       ccr_json = excluded.ccr_json,
                       last_ingested_seq = excluded.last_ingested_seq`,
                )
                .run({
                    sessionId: s.sessionId,
                    parentSessionId: s.parentSessionId ?? null,
                    forkPointSeq: s.forkPointSeq ?? null,
                    protocol: s.protocol ?? null,
                    label: s.label ?? null,
                    title: s.title ?? null,
                    hostTitle: s.hostTitle ?? null,
                    namespace: s.namespace ?? "proxy",
                    origin: s.origin ?? null,
                    status: s.status ?? "active",
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                    nextBlockId: s.nextBlockId,
                    nextRunId: s.nextRunId,
                    metaJson: s.metaJson,
                    statsJson: s.statsJson,
                    metadataJson: s.metadataJson,
                    kstateJson: s.kstateJson,
                    tailJson: s.tailJson,
                    ccrJson: s.ccrJson,
                    lastIngestedSeq: watermark,
                });

            // Identity index (#2960 R2.1): claim (namespace, conversation_id)
            // → session_id. ON CONFLICT DO NOTHING — first claimant wins; while
            // the v1 mapping is the identity a re-ingest is the same triple.
            this.db
                .prepare(
                    "INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES (?, ?, ?, ?) " +
                        "ON CONFLICT(namespace, conversation_id) DO NOTHING",
                )
                .run(s.namespace ?? "proxy", s.sessionId, s.sessionId, s.updatedAt);

            for (const m of messages) {
                const hash = this.putContent(m.content, m.contentHash);
                const res = this.db
                    .prepare(
                        "INSERT OR IGNORE INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .run(s.sessionId, m.seq, m.msgId, m.ref, m.refNum, m.role, m.kind, hash);
                if (res.changes === 0) {
                    // Idempotent re-receipt: the CAS row is still referenced
                    // by the existing message row — undo our refcount bump.
                    this.releaseContent(hash);
                }
            }

            // blocks: the incoming set is AUTHORITATIVE. Upsert alone leaves
            // rows for blocks that no longer exist (e.g. #2695 zombie reaping
            // via reapDestroyedSubstrate) — they would resurrect on every
            // unified load. Drop absent ids first, releasing their content
            // refs inside the same transaction (deleteSession discipline).
            const incomingBlockIds = new Set(input.blocks.map((b) => b.blockId));
            const staleBlocks = this.db
                .prepare("SELECT block_id, summary_hash, one_hash FROM blocks WHERE session_id = ?")
                .all(s.sessionId) as Array<{ block_id: string; summary_hash: string; one_hash: string | null }>;
            for (const stale of staleBlocks) {
                if (incomingBlockIds.has(stale.block_id)) continue;
                this.releaseContent(stale.summary_hash);
                if (stale.one_hash !== null) this.releaseContent(stale.one_hash);
                this.db.prepare("DELETE FROM blocks WHERE session_id = ? AND block_id = ?").run(s.sessionId, stale.block_id);
            }
            for (const b of input.blocks) {
                const summaryHash = this.putContent(b.summary);
                const oneHash = b.one === null ? null : this.putContent(b.one);
                // Re-ingest of the same block id replaces the row (dry-run
                // idempotence). Refcount math must distinguish identical
                // re-ingest (bump then undo) from a true replacement (release
                // the old hash, keep the new bump) — otherwise identical
                // re-ingest drives the surviving refcount to zero.
                const existing = this.db
                    .prepare("SELECT summary_hash, one_hash FROM blocks WHERE session_id = ? AND block_id = ?")
                    .get(s.sessionId, b.blockId) as { summary_hash: string; one_hash: string | null } | undefined;
                if (existing) {
                    if (existing.summary_hash === summaryHash) this.releaseContent(summaryHash);
                    else this.releaseContent(existing.summary_hash);
                    if (existing.one_hash !== null) {
                        if (existing.one_hash === oneHash && oneHash !== null) this.releaseContent(oneHash);
                        else this.releaseContent(existing.one_hash);
                    }
                }
                this.db
                    .prepare(
                        `INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier,
                           summary_hash, one_hash, supersedes_block_id, active, created_at, covered_hash, payload_json)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(session_id, block_id) DO UPDATE SET
                           ord = excluded.ord, start_seq = excluded.start_seq, end_seq = excluded.end_seq,
                           start_ref = excluded.start_ref, end_ref = excluded.end_ref, tier = excluded.tier,
                           summary_hash = excluded.summary_hash, one_hash = excluded.one_hash,
                           supersedes_block_id = excluded.supersedes_block_id, active = excluded.active,
                           created_at = excluded.created_at, covered_hash = excluded.covered_hash,
                           payload_json = excluded.payload_json`,
                    )
                    .run(
                        b.blockId,
                        s.sessionId,
                        b.ord,
                        b.startSeq,
                        b.endSeq,
                        b.startRef,
                        b.endRef,
                        b.tier,
                        summaryHash,
                        oneHash,
                        b.supersedesBlockId,
                        b.active ? 1 : 0,
                        b.createdAt,
                        b.coveredHash,
                        b.payloadJson,
                    );
            }

            // dead_refs: tombstones can be LIFTED (backing message
            // reappears) — the array is authoritative, so rows at ords the
            // incoming set no longer covers are stale and must go.
            this.db.prepare("DELETE FROM dead_refs WHERE session_id = ? AND ord >= ?").run(s.sessionId, input.deadRefs.length);
            for (const d of input.deadRefs) {
                this.db
                    .prepare(
                        "INSERT INTO dead_refs (session_id, ord, ref, ref_num, recorded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, ord) DO UPDATE SET ref = excluded.ref, ref_num = excluded.ref_num, recorded_at = excluded.recorded_at",
                    )
                    .run(s.sessionId, d.ord, d.ref, d.refNum, d.recordedAt);
            }

            // refs: the incoming array is AUTHORITATIVE — native compaction
            // and the #2695 zombie reap renumber byRaw/byRef (survivors move
            // to lower ords, pruned ids vanish). Upserting onto that shape
            // either hits the (session_id, ord) PK (ingest rolls back, 3-strike
            // self-disable — review #2690 blocking 1) or leaves ghost rows that
            // make the loaded map strictly larger than legacy (permanent
            // DIGEST DRIFT spam — blocking 2). Replace the whole set.
            this.db.prepare("DELETE FROM refs WHERE session_id = ?").run(s.sessionId);
            for (const r of input.refs) {
                this.db
                    .prepare(
                        "INSERT INTO refs (session_id, ord, raw_id, ref, ref_num) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, raw_id) DO UPDATE SET ord = excluded.ord, ref = excluded.ref, ref_num = excluded.ref_num",
                    )
                    .run(s.sessionId, r.ord, r.rawId, r.ref, r.refNum);
            }

            // ccr_entries: the content store is a map whose keys can be
            // dropped — full-replace keeps the table authoritative. Release
            // every old hash first, then re-insert (idempotent: identical
            // sets cancel out bump+release).
            const oldCcr = this.db
                .prepare("SELECT content_hash FROM ccr_entries WHERE session_id = ?")
                .all(s.sessionId) as { content_hash: string }[];
            for (const row of oldCcr) this.releaseContent(row.content_hash);
            this.db.prepare("DELETE FROM ccr_entries WHERE session_id = ?").run(s.sessionId);
            for (const e of input.ccrEntries) {
                const hash = this.putContent(e.content);
                this.db
                    .prepare("INSERT INTO ccr_entries (session_id, ord, ccr_key, content_hash) VALUES (?, ?, ?, ?)")
                    .run(s.sessionId, e.ord, e.key, hash);
            }
            return true;
        });
        if (ok) this.maybeCheckpointWal();
        return ok;
    }

    /** #3250: cadence-tick WAL reclamation (see WAL_CHECKPOINT_EVERY_INGESTS).
     *  Never throws into the ingest path — a failed checkpoint just leaves the
     *  WAL longer than ideal until the next tick. */
    private maybeCheckpointWal(): void {
        this.ingestCount += 1;
        if (this.ingestCount % WAL_CHECKPOINT_EVERY_INGESTS !== 0) return;
        try {
            // Log the result: operators tuning storage.walJournalSizeLimitBytes
            // need to see whether ticks are actually reclaiming frames.
            const row = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
            loggerLog(
                "debug",
                `[storage] periodic WAL checkpoint at ingest ${this.ingestCount}: busy=${row.busy} log=${row.log} checkpointed=${row.checkpointed}`,
            );
        } catch (err) {
            loggerLog("debug", `[storage] periodic WAL checkpoint failed at ingest ${this.ingestCount}: ${String(err)}`);
        }
    }

    /** Full-ingest path of ingestSession, extracted for readability: the
     *  absolute-seq remap plus the #3133 watermark alignment decision.
     *  Mutates input.session.tailJson (pointer sequences become absolute). */
    private remapPlanToAbsolute(input: IngestSessionInput): { messages: MessageRow[]; watermark: number | null } {
        const s = input.session;
        // Absolute-seq remap (#2671 soak finding): planIngest assigns seq
        // RELATIVE to the current snapshot's log (pluginSnapshot first,
        // then tail). For a folded session whose tail slides every save
        // (and no pluginSnapshot to pin the prefix), plan seq 0 re-bases
        // to a DIFFERENT message each save — while messages is keyed
        // (session_id, seq) with INSERT OR IGNORE, so the FIRST row wins
        // forever and tail pointers resolve to stale turns. Remap to
        // stable absolute seqs: same identity (msgId + content hash)
        // keeps its old seq; new identities continue after max(seq).
        const existing = this.db
            .prepare("SELECT seq, msg_id, content_hash FROM messages WHERE session_id = ?")
            .all(s.sessionId) as { seq: number; msg_id: string; content_hash: string }[];
        const seqByIdentity = new Map<string, number>();
        let nextSeq = 0;
        for (const row of existing) {
            seqByIdentity.set(`${row.msg_id}\u0000${row.content_hash}`, row.seq);
            if (row.seq + 1 > nextSeq) nextSeq = row.seq + 1;
        }
        // #3133 watermark gate (full path): the watermark names the abs seq
        // backing the plan's LAST tail message. It need not be the table's
        // max — a fold's summary lands above surviving old rows — because
        // delta appends anchor at max(seq)+1, never at watermark+1. NULL
        // when the plan carries no tail (envelope-only imports): the next
        // save runs the full ingest.
        const planToAbs = new Map<number, number>();
        const messages = input.messages.map((m) => {
            // #3133: plan rows carry the intern-pass hash; only direct
            // callers without a planner pay the sha256 here.
            const hash = m.contentHash ?? sha256Hex(m.content);
            const key = `${m.msgId}\u0000${hash}`;
            let abs = seqByIdentity.get(key);
            if (abs === undefined) {
                abs = nextSeq++;
                seqByIdentity.set(key, abs);
            }
            planToAbs.set(m.seq, abs);
            return { ...m, seq: abs };
        });
        const remapSeqs = (seqs: number[] | null | undefined): number[] | null | undefined =>
            seqs === null || seqs === undefined ? seqs : seqs.map((p) => planToAbs.get(p) ?? p);
        const pluginSnapshotSeqs = remapSeqs(input.pluginSnapshotSeqs);
        const tailSeqs = remapSeqs(input.tailSeqs);
        const watermark = tailSeqs !== null && tailSeqs !== undefined && tailSeqs.length > 0 ? tailSeqs[tailSeqs.length - 1] : null;
        s.tailJson = JSON.stringify({
            ...(JSON.parse(s.tailJson) as Record<string, unknown>),
            ...(pluginSnapshotSeqs !== undefined ? { pluginSnapshotSeqs } : {}),
            ...(tailSeqs !== undefined ? { tailSeqs } : {}),
        });
        return { messages, watermark };
    }

    /** #3133: the session's ingest watermark — the absolute seq backing the
     *  LAST message of the tail as ingested by the most recent save, plus
     *  that save's trusted tailSeqs (same transaction wrote both). NULL (or
     *  a shape that disagrees with tail_json — foreign write, partial
     *  upgrade) means "no trusted prefix": the next save runs the full
     *  ingest. Point read on the sessions PK. */
    ingestWatermark(sessionId: string): { seq: number; tailSeqs: number[] } | null {
        const row = this.db
            .prepare("SELECT last_ingested_seq, tail_json FROM sessions WHERE session_id = ?")
            .get(sessionId) as { last_ingested_seq: number | null; tail_json: string } | undefined;
        if (!row) return null;
        const seq = row.last_ingested_seq;
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
        const tail = JSON.parse(row.tail_json) as { tailSeqs?: number[] | null };
        const seqs = tail.tailSeqs;
        if (!Array.isArray(seqs) || seqs.length === 0 || seqs[seqs.length - 1] !== seq) return null;
        return { seq, tailSeqs: seqs };
    }

    /** #3166 review (heal half of the sampled-verify backstop): drop the
     *  durable watermark so the next save takes the exact full path and
     *  re-points every tail slot. Called when the read-back digest proves
     *  the stored prefix no longer matches the record of truth — without it
     *  every same-length save would re-take the unverified empty delta
     *  against a stale watermark and the divergence would be permanent. */
    clearIngestWatermark(sessionId: string): void {
        this.db.prepare("UPDATE sessions SET last_ingested_seq = NULL WHERE session_id = ?").run(sessionId);
    }

    /** #3285: drop EVERY session's ingest watermark at once. A watermark
     *  vouches "the writer that set it verified this prefix" but carries no
     *  writer identity, so the trust must not survive a process handoff:
     *  under the multi-process shared-directory contract (#2671) a
     *  restart-handoff overlap (old instance still draining while the new
     *  one boots, both sharing index.db) leaves a foreign process's rows
     *  AND its watermark behind, and inheriting that trust lets the new
     *  process take unverified empty deltas against rows it never wrote.
     *  Called once at writer init (UnifiedShadow.maybeOpen); pure readers
     *  (export) must not call it. After the reset each session's first save
     *  takes the exact full path — an authoritative replace, see
     *  ingestSession — re-establishing trust from this process's own view.
     *  Cost: one full ingest per saved session per boot. */
    resetAllIngestWatermarks(): void {
        this.db.prepare("UPDATE sessions SET last_ingested_seq = NULL").run();
    }

    /** #3248 lane-ownership probe for the message sweep (#3285): every ext
     *  key the incremental lane persists is "inc:"-prefixed, so any such key
     *  marks a session whose messages table the lane consumes positionally. */
    private hasLaneExt(sessionId: string): boolean {
        return this.db.prepare("SELECT 1 FROM session_ext WHERE session_id = ? AND key LIKE 'inc:%' LIMIT 1").get(sessionId) !== undefined;
    }

    /** #3133 boundary probe: the identity of the messages row at
     *  (session_id, seq) plus the session's current max seq — both lookups
     *  ride the PRIMARY KEY (session_id, seq) / idx_messages_session (no
     *  full existing-rows scan, no seqByIdentity map). null when the row is
     *  missing. The identity half is the trust decision; the max-seq half
     *  is the ANCHOR delta appends continue after (max+1, the same
     *  strictly-above discipline as the full path's remap, so appends can
     *  never collide with an existing slot — rows above the watermark,
     *  e.g. a fold's summary, are expected and harmless). */
    probeIngestBoundary(sessionId: string, seq: number): { msgId: string; contentHash: string; maxSeq: number } | null {
        const row = this.db
            .prepare("SELECT msg_id, content_hash FROM messages WHERE session_id = ? AND seq = ?")
            .get(sessionId, seq) as { msg_id: string; content_hash: string } | undefined;
        if (!row) return null;
        const max = this.db
            .prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ?")
            .get(sessionId) as { m: number | null };
        return { msgId: row.msg_id, contentHash: row.content_hash, maxSeq: max.m ?? -1 };
    }

    /** Deletes one session and releases every CAS refcount it holds
     *  (GC parity with the legacy path's file removal). Rows that other
     *  sessions also reference survive via their own refcounts. Checkpoints
     *  of the session: PINNED ones survive (their state blob keeps its
     *  refcount — replica GC protection, #2671 Phase 2); unpinned ones are
     *  swept here together with the session. */
    deleteSession(sessionId: string): void {
        this.db.transaction(() => {
            const refs: string[] = [];
            for (const m of this.db
                .prepare("SELECT content_hash FROM messages WHERE session_id = ?")
                .all(sessionId) as { content_hash: string }[]) refs.push(m.content_hash);
            for (const b of this.db
                .prepare("SELECT summary_hash, one_hash FROM blocks WHERE session_id = ?")
                .all(sessionId) as { summary_hash: string; one_hash: string | null }[]) {
                refs.push(b.summary_hash);
                if (b.one_hash !== null) refs.push(b.one_hash);
            }
            for (const e of this.db
                .prepare("SELECT content_hash FROM ccr_entries WHERE session_id = ?")
                .all(sessionId) as { content_hash: string }[]) refs.push(e.content_hash);
            // Checkpoints: pinned replicas keep their rows + CAS refcounts; the
            // rest die with the session.
            for (const cp of this.db
                .prepare("SELECT cp_id, state_hash FROM checkpoints WHERE session_id = ? AND pinned = 0")
                .all(sessionId) as { cp_id: string; state_hash: string }[]) {
                this.db.prepare("DELETE FROM checkpoints WHERE cp_id = ?").run(cp.cp_id);
                refs.push(cp.state_hash);
            }
            this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM blocks WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM dead_refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM ccr_entries WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM conversations WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM session_ext WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
            for (const hash of refs) this.releaseContent(hash);
            // CAS rows at zero refcount are unreferenced garbage — collect.
            this.db.prepare("DELETE FROM content WHERE refcount <= 0").run();
        });
    }

    /** Freezes one session record as a checkpoint row + CAS blob. The row
     *  owns exactly one refcount on the blob; identical consecutive states
     *  dedup to a single CAS entry (the CoW behind cheap repeated
     *  checkpoints). Single transaction: the checkpoint is either fully
     *  visible or not at all. */
    insertCheckpoint(cp: {
        cpId: string;
        sessionId: string;
        seqAt: number;
        blockSetHash: string;
        kind: "auto" | "manual" | "replica" | "fork_base";
        label?: string | null;
        pinned: boolean;
        createdAt: number;
        stateJson: string;
    }): void {
        this.db.transaction(() => {
            const stateHash = this.putContent(cp.stateJson);
            this.db
                .prepare(
                    "INSERT INTO checkpoints (cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label, state_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .run(cp.cpId, cp.sessionId, cp.seqAt, cp.blockSetHash, cp.kind, cp.createdAt, cp.pinned ? 1 : 0, cp.label ?? null, stateHash);
        });
    }

    listCheckpoints(sessionId?: string): CheckpointRow[] {
        const cols = "cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label";
        return sessionId
            ? (this.db.prepare(`SELECT ${cols} FROM checkpoints WHERE session_id = ? ORDER BY created_at, cp_id`).all(sessionId) as CheckpointRow[])
            : (this.db.prepare(`SELECT ${cols} FROM checkpoints ORDER BY created_at, cp_id`).all() as CheckpointRow[]);
    }

    // ------------------------------------------------------------------
    // Extension namespaces (#3069 v4). Host/plugin/UI substrate — never
    // kernel session state (that lives in kstate_json). Guards: key and
    // namespace are non-empty printable strings <= 256 chars; the JSON
    // payload is capped so a runaway caller cannot balloon index.db.
    // ------------------------------------------------------------------

    setSessionExt(sessionId: string, key: string, value: unknown): void {
        validateExtKey(sessionId, "session id");
        validateExtKey(key, "key");
        const valueJson = serializeExtValue(value);
        this.db
            .prepare(
                "INSERT INTO session_ext (session_id, key, value_json, updated_at) VALUES (?, ?, ?, ?) " +
                    "ON CONFLICT (session_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            )
            .run(sessionId, key, valueJson, Date.now());
    }

    getSessionExt(sessionId: string, key: string): unknown {
        validateExtKey(sessionId, "session id");
        validateExtKey(key, "key");
        const row = this.db
            .prepare("SELECT value_json FROM session_ext WHERE session_id = ? AND key = ?")
            .get(sessionId, key) as { value_json: string } | undefined;
        return row === undefined ? undefined : JSON.parse(row.value_json);
    }

    listSessionExt(sessionId: string): { key: string; value: unknown; updatedAt: number }[] {
        validateExtKey(sessionId, "session id");
        return (
            this.db
                .prepare("SELECT key, value_json, updated_at FROM session_ext WHERE session_id = ? ORDER BY key")
                .all(sessionId) as { key: string; value_json: string; updated_at: number }[]
        ).map((r) => ({ key: r.key, value: JSON.parse(r.value_json), updatedAt: r.updated_at }));
    }

    /** Deletes one key (or every key of the session when omitted). Returns
     *  the number of rows removed. The deleteSession sweep calls this table
     *  too — session-bound state dies with the session. */
    deleteSessionExt(sessionId: string, key?: string): number {
        validateExtKey(sessionId, "session id");
        if (key === undefined) {
            return Number(this.db.prepare("DELETE FROM session_ext WHERE session_id = ?").run(sessionId).changes);
        }
        validateExtKey(key, "key");
        return Number(this.db.prepare("DELETE FROM session_ext WHERE session_id = ? AND key = ?").run(sessionId, key).changes);
    }

    setKv(namespace: string, key: string, value: unknown): void {
        validateExtKey(namespace, "namespace");
        validateExtKey(key, "key");
        const valueJson = serializeExtValue(value);
        this.db
            .prepare(
                "INSERT INTO kv_store (namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?) " +
                    "ON CONFLICT (namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            )
            .run(namespace, key, valueJson, Date.now());
    }

    getKv(namespace: string, key: string): unknown {
        validateExtKey(namespace, "namespace");
        validateExtKey(key, "key");
        const row = this.db
            .prepare("SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?")
            .get(namespace, key) as { value_json: string } | undefined;
        return row === undefined ? undefined : JSON.parse(row.value_json);
    }

    listKv(namespace?: string, keyPrefix?: string): { namespace: string; key: string; value: unknown; updatedAt: number }[] {
        const where: string[] = [];
        const args: unknown[] = [];
        if (namespace !== undefined) {
            validateExtKey(namespace, "namespace");
            where.push("namespace = ?");
            args.push(namespace);
        }
        if (keyPrefix !== undefined && keyPrefix !== "") {
            validateExtKey(keyPrefix, "key prefix");
            where.push("key LIKE ? ESCAPE '\\'");
            args.push(likeEscape(keyPrefix) + "%");
        }
        const sql =
            "SELECT namespace, key, value_json, updated_at FROM kv_store" +
            (where.length > 0 ? " WHERE " + where.join(" AND ") : "") +
            " ORDER BY namespace, key";
        return (
            this.db.prepare(sql).all(...(args as never[])) as { namespace: string; key: string; value_json: string; updated_at: number }[]
        ).map((r) => ({ namespace: r.namespace, key: r.key, value: JSON.parse(r.value_json), updatedAt: r.updated_at }));
    }

    /** Deletes one key of a namespace, or the whole namespace when the key
     *  is omitted ("retire a lane" = deleteKv("lane:18835")). Returns the
     *  number of rows removed. */
    deleteKv(namespace: string, key?: string): number {
        validateExtKey(namespace, "namespace");
        if (key === undefined) {
            return Number(this.db.prepare("DELETE FROM kv_store WHERE namespace = ?").run(namespace).changes);
        }
        validateExtKey(key, "key");
        return Number(this.db.prepare("DELETE FROM kv_store WHERE namespace = ? AND key = ?").run(namespace, key).changes);
    }

    /** Sessions-row updated_at (ms epoch) — the ingest freshness watermark
     *  load-side imports compare the legacy payload against. null when the
     *  index has never seen the id. */
    sessionUpdatedAt(sessionId: string): number | null {
        const row = this.db
            .prepare("SELECT updated_at FROM sessions WHERE session_id = ?")
            .get(sessionId) as { updated_at: number } | undefined;
        return row?.updated_at ?? null;
    }

    getCheckpoint(cpId: string): CheckpointRow | undefined {
        return this.db
            .prepare("SELECT cp_id, session_id, seq_at, block_set_hash, kind, created_at, pinned, label FROM checkpoints WHERE cp_id = ?")
            .get(cpId) as CheckpointRow | undefined;
    }

    /** The frozen record blob (state_hash → CAS bytes). Throws if the row or
     *  the blob is missing — callers treat that as a corrupt checkpoint. */
    checkpointState(cpId: string): { stateJson: string; byteLen: number } {
        const row = this.db.prepare("SELECT state_hash FROM checkpoints WHERE cp_id = ?").get(cpId) as
            | { state_hash: string }
            | undefined;
        if (!row) throw new Error(`checkpoint not found: ${cpId}`);
        const blob = this.db.prepare("SELECT bytes, byte_len FROM content WHERE hash = ?").get(row.state_hash) as
            | { bytes: Uint8Array; byte_len: number }
            | undefined;
        if (!blob) throw new Error(`checkpoint blob missing (CAS leak): ${cpId}`);
        return { stateJson: Buffer.from(blob.bytes).toString("utf8"), byteLen: blob.byte_len };
    }

    /** Drops a checkpoint row and releases its CAS refcount. Explicit delete
     *  overrides `pinned` — pinning protects against GC, not the operator. */
    deleteCheckpoint(cpId: string): boolean {
        return this.db.transaction((): boolean => {
            const row = this.db.prepare("SELECT state_hash FROM checkpoints WHERE cp_id = ?").get(cpId) as
                | { state_hash: string }
                | undefined;
            if (!row) return false;
            this.db.prepare("DELETE FROM checkpoints WHERE cp_id = ?").run(cpId);
            this.releaseContent(row.state_hash);
            this.db.prepare("DELETE FROM content WHERE refcount <= 0").run();
            return true;
        });
    }

    /** Asserts every projection column equals its verbatim fact. Throws on
     *  the first disagreement with a field-labeled message. */
    verifyProjections(sessionId: string): { ok: true; checks: number } | { ok: false; error: string } {
        const fail = (where: string, msg: string): { ok: false; error: string } => ({
            ok: false,
            error: `${sessionId}: ${where}: ${msg}`,
        });
        let checks = 0;
        const s = this.getSessionRow(sessionId);
        if (!s) return fail("sessions", "row missing");
        const meta = JSON.parse(s.metaJson) as Record<string, unknown>;
        checks++;
        if ((s.protocol ?? null) !== (meta.protocol ?? null)) return fail("sessions.protocol", `${s.protocol} vs ${String(meta.protocol)}`);
        if ((s.label ?? null) !== (meta.label ?? null)) return fail("sessions.label", `${s.label} vs ${String(meta.label)}`);
        if ((s.title ?? null) !== (meta.title ?? null)) return fail("sessions.title", `${s.title} vs ${String(meta.title)}`);
        if ((s.hostTitle ?? null) !== (meta.hostTitle ?? null)) return fail("sessions.hostTitle", `${s.hostTitle} vs ${String(meta.hostTitle)}`);

        const kstate = JSON.parse(s.kstateJson) as Record<string, unknown>;
        checks++;
        if (kstate.nextBlockId !== undefined || kstate.nextRunId !== undefined) {
            return fail("sessions.kstate_json", "must not carry nextBlockId/nextRunId (columns own them)");
        }

        const messages = this.getMessages(sessionId);
        const refByRaw = new Map(this.getRefs(sessionId).map((r) => [r.rawId, r.ref]));
        for (const m of messages) {
            checks++;
            if (m.ref !== (refByRaw.get(m.msgId) ?? null)) {
                return fail(`messages[${m.seq}].ref`, `${String(m.ref)} vs refs ledger ${String(refByRaw.get(m.msgId))}`);
            }
        }
        for (const m of messages) {
            checks++;
            const parsed = JSON.parse(m.content) as { id?: string; role?: string; contentType?: string };
            if (parsed.id !== m.msgId) return fail(`messages[${m.seq}].msg_id`, `${m.msgId} vs ${String(parsed.id)}`);
            if (parsed.role !== m.role) return fail(`messages[${m.seq}].role`, `${m.role} vs ${String(parsed.role)}`);
            if ((parsed.contentType ?? "message") !== m.kind) {
                return fail(`messages[${m.seq}].kind`, `${m.kind} vs ${String(parsed.contentType)}`);
            }
        }

        const blocks = this.getBlocks(sessionId);
        for (const b of blocks) {
            checks++;
            const payload = JSON.parse(b.payloadJson) as Record<string, unknown>;
            if (payload.blockId !== b.blockId) return fail(`blocks[${b.blockId}].blockId`, "id mismatch");
            if (payload.tier !== b.tier) return fail(`blocks[${b.blockId}].tier`, `${b.tier} vs ${String(payload.tier)}`);
            if ((payload.active ?? true) !== b.active) {
                return fail(`blocks[${b.blockId}].active`, `${b.active} vs ${String(payload.active)}`);
            }
            // NOTE: summary/one CAS views are blockContents facts, not
            // projections of the block payload (payload.summary is a plain
            // string) — comparing them would be comparing different facts.
        }
        return { ok: true, checks };
    }

    counts(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const t of ["sessions", "messages", "refs", "blocks", "dead_refs", "ccr_entries", "content", "checkpoints"]) {
            const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
            out[t] = row.n;
        }
        return out;
    }

    contentDedupReport(): { rows: number; bytesTotal: number; refcounted: number } {
        const row = this.db
            .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(byte_len),0) AS b, COALESCE(SUM(refcount),0) AS r FROM content")
            .get() as { n: number; b: number; r: number };
        return { rows: row.n, bytesTotal: row.b, refcounted: row.r };
    }

    listSessionIds(): string[] {
        return (this.db.prepare("SELECT session_id FROM sessions ORDER BY session_id").all() as { session_id: string }[]).map(
            (r) => r.session_id,
        );
    }

    /** Identity lookup (#2960 R2.1): resolve the durable (namespace,
     *  conversation id) pair to its sessions row key. Null when the pair was
     *  never claimed. */
    lookupConversation(namespace: string, conversationId: string): string | null {
        const row = this.db
            .prepare("SELECT session_id FROM conversations WHERE namespace = ? AND conversation_id = ?")
            .get(namespace, conversationId) as { session_id: string } | undefined;
        return row ? row.session_id : null;
    }

    /** All identity bindings, optionally filtered by namespace (test/web
     *  consumption face). */
    listConversationBindings(namespace?: string): { namespace: string; conversationId: string; sessionId: string; claimedAt: number }[] {
        const rows = (namespace === undefined
            ? this.db.prepare("SELECT namespace, conversation_id, session_id, claimed_at FROM conversations ORDER BY namespace, conversation_id").all()
            : this.db
                  .prepare(
                      "SELECT namespace, conversation_id, session_id, claimed_at FROM conversations WHERE namespace = ? ORDER BY conversation_id",
                  )
                  .all(namespace)
        ) as { namespace: string; conversation_id: string; session_id: string; claimed_at: number }[];
        return rows.map((r) => ({ namespace: r.namespace, conversationId: r.conversation_id, sessionId: r.session_id, claimedAt: r.claimed_at }));
    }

    /** Summary rows for the export/web list fast path (#2960 R2.1):
     *  one SQL over the sessions table + blocks aggregate — no legacy file
     *  parse, no Session hydration. Parity contract with the legacy walk
     *  (export.ts listSessions): display title = host_title ?? title;
     *  display time = latest block created_at; blocks = ALL blocks count. */
    sessionSummaries(): SessionSummaryRow[] {
        const rows = this.db
            .prepare(
                `SELECT s.session_id AS sessionId, s.host_title AS hostTitle, s.title AS title, s.label AS label,
                        s.protocol AS protocol, s.origin AS origin, s.namespace AS namespace, s.stats_json AS statsJson,
                        s.updated_at AS updatedAt,
                        (SELECT COUNT(*) FROM blocks b WHERE b.session_id = s.session_id) AS blocks,
                        (SELECT MAX(b.created_at) FROM blocks b WHERE b.session_id = s.session_id) AS latestBlockAt
                  FROM sessions s`,
            )
            .all() as {
            sessionId: string;
            hostTitle: string | null;
            title: string | null;
            label: string | null;
            protocol: string | null;
            origin: string | null;
            namespace: string;
            statsJson: string;
            updatedAt: number;
            blocks: number;
            latestBlockAt: number | null;
        }[];
        return rows.map((r) => {
            let contextTokens: number | undefined;
            try {
                const v = (JSON.parse(r.statsJson) as { contextTokens?: unknown }).contextTokens;
                if (typeof v === "number" && Number.isFinite(v)) contextTokens = v;
            } catch {
                /* malformed stats: leave undefined, same as a missing field */
            }
            return {
                sessionId: r.sessionId,
                title: r.hostTitle ?? r.title ?? undefined,
                label: r.label ?? undefined,
                protocol: r.protocol ?? undefined,
                origin: r.origin ?? undefined,
                namespace: r.namespace,
                blocks: r.blocks,
                latestBlockAt: r.latestBlockAt ?? undefined,
                contextTokens,
                updatedAt: r.updatedAt,
            };
        });
    }

    /** #2960 R2.2: web list rows — sessions table + block aggregates in one
     *  SQL (payload json_extract for the first-block lead and active-block
     *  compressed-token sum). Replaces the bounded envelope-file decode the
     *  disk index performs per refresh. */
    webSummaryRows(): WebSummaryRow[] {
        const rows = this.db
            .prepare(
                `SELECT s.session_id AS sessionId, s.title AS title, s.host_title AS hostTitle, s.label AS label,
                        s.protocol AS protocol, s.origin AS origin, s.updated_at AS updatedAt,
                        s.stats_json AS statsJson, s.metadata_json AS metadataJson,
                        (SELECT COUNT(*) FROM blocks b WHERE b.session_id = s.session_id) AS blocks,
                        (SELECT json_extract(b.payload_json, '$.topic') FROM blocks b
                          WHERE b.session_id = s.session_id
                            AND (json_extract(b.payload_json, '$.topic') IS NOT NULL
                                 OR json_extract(b.payload_json, '$.summary') IS NOT NULL)
                          ORDER BY b.ord LIMIT 1) AS firstTopic,
                        (SELECT json_extract(b.payload_json, '$.summary') FROM blocks b
                          WHERE b.session_id = s.session_id
                            AND (json_extract(b.payload_json, '$.topic') IS NOT NULL
                                 OR json_extract(b.payload_json, '$.summary') IS NOT NULL)
                          ORDER BY b.ord LIMIT 1) AS firstSummary,
                        (SELECT COALESCE(SUM(json_extract(b.payload_json, '$.compressedTokens')), 0)
                          FROM blocks b WHERE b.session_id = s.session_id AND b.active = 1) AS activeCompressed
                 FROM sessions s`,
            )
            .all() as Array<{
                sessionId: string;
                title: string | null;
                hostTitle: string | null;
                label: string | null;
                protocol: string | null;
                origin: string | null;
                updatedAt: number;
                statsJson: string;
                metadataJson: string;
                blocks: number;
                firstTopic: string | null;
                firstSummary: string | null;
                activeCompressed: number | null;
            }>;
        return rows.map((r) => ({
            sessionId: r.sessionId,
            title: r.title ?? undefined,
            hostTitle: r.hostTitle ?? undefined,
            label: r.label ?? undefined,
            protocol: r.protocol ?? undefined,
            origin: r.origin ?? undefined,
            updatedAt: r.updatedAt,
            statsJson: r.statsJson,
            metadataJson: r.metadataJson,
            blocks: r.blocks,
            firstTopic: r.firstTopic,
            firstSummary: r.firstSummary,
            activeCompressedTokens: r.activeCompressed ?? 0,
        }));
    }

    private getContent(hash: string): string | null {
        const row = this.db.prepare("SELECT bytes FROM content WHERE hash = ?").get(hash) as
            | { bytes: Buffer }
            | undefined;
        if (!row) return null;
        return Buffer.from(row.bytes).toString("utf8");
    }

    getSessionRow(sessionId: string): SessionRow | null {
        const row = this.db
            .prepare(
                `SELECT session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, namespace, origin, status,
                        created_at, updated_at, next_block_id, next_run_id,
                        meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json, last_ingested_seq
                 FROM sessions WHERE session_id = ?`,
            )
            .get(sessionId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
            sessionId: row.session_id as string,
            parentSessionId: (row.parent_session_id as string | null) ?? null,
            forkPointSeq: (row.fork_point_seq as number | null) ?? null,
            protocol: (row.protocol as string | null) ?? null,
            label: (row.label as string | null) ?? null,
            title: (row.title as string | null) ?? null,
            hostTitle: (row.host_title as string | null) ?? null,
            namespace: (row.namespace as string | undefined) ?? "proxy",
            origin: (row.origin as string | null | undefined) ?? null,
            status: row.status as string,
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
            nextBlockId: row.next_block_id as number,
            nextRunId: row.next_run_id as number,
            metaJson: row.meta_json as string,
            statsJson: row.stats_json as string,
            metadataJson: row.metadata_json as string,
            kstateJson: row.kstate_json as string,
            tailJson: row.tail_json as string,
            ccrJson: (row.ccr_json as string | null) ?? null,
            lastIngestedSeq: (row.last_ingested_seq as number | null | undefined) ?? null,
        };
    }

    getMessages(sessionId: string): (MessageRow & { contentHash: string })[] {
        const rows = this.db
            .prepare("SELECT seq, msg_id, ref, ref_num, role, kind, content_hash FROM messages WHERE session_id = ? ORDER BY seq")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            seq: r.seq as number,
            msgId: r.msg_id as string,
            ref: (r.ref as string | null) ?? null,
            refNum: (r.ref_num as number | null) ?? null,
            role: r.role as string,
            kind: r.kind as string,
            contentHash: r.content_hash as string,
            content: this.getContent(r.content_hash as string) ?? "",
        }));
    }

    getBlocks(sessionId: string): (BlockRow & { summaryHash: string; oneHash: string | null })[] {
        const rows = this.db
            .prepare(
                `SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, one_hash,
                        supersedes_block_id, active, created_at, covered_hash, payload_json
                 FROM blocks WHERE session_id = ? ORDER BY ord`,
            )
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            blockId: r.block_id as string,
            ord: r.ord as number,
            startSeq: r.start_seq as number,
            endSeq: r.end_seq as number,
            startRef: (r.start_ref as number | null) ?? null,
            endRef: (r.end_ref as number | null) ?? null,
            tier: r.tier as number,
            summaryHash: r.summary_hash as string,
            oneHash: (r.one_hash as string | null) ?? null,
            summary: this.getContent(r.summary_hash as string) ?? "",
            one: r.one_hash ? (this.getContent(r.one_hash as string) ?? null) : null,
            supersedesBlockId: (r.supersedes_block_id as string | null) ?? null,
            active: (r.active as number) === 1,
            createdAt: r.created_at as number,
            coveredHash: r.covered_hash as string,
            payloadJson: r.payload_json as string,
        }));
    }

    getDeadRefs(sessionId: string): { ord: number; ref: string; refNum: number; recordedAt: number }[] {
        const rows = this.db
            .prepare("SELECT ord, ref, ref_num, recorded_at FROM dead_refs WHERE session_id = ? ORDER BY ord")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            ord: r.ord as number,
            ref: r.ref as string,
            refNum: r.ref_num as number,
            recordedAt: r.recorded_at as number,
        }));
    }

    getRefs(sessionId: string): RefRow[] {
        const rows = this.db
            .prepare("SELECT ord, raw_id, ref, ref_num FROM refs WHERE session_id = ? ORDER BY ord")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            ord: r.ord as number,
            rawId: r.raw_id as string,
            ref: r.ref as string,
            refNum: (r.ref_num as number | null) ?? null,
        }));
    }

    getCcr(sessionId: string): MessageContentStore | null {
        const row = this.db
            .prepare("SELECT ccr_json FROM sessions WHERE session_id = ?")
            .get(sessionId) as { ccr_json: string | null } | undefined;
        if (!row || row.ccr_json === null) return null;
        try {
            const parsed = JSON.parse(row.ccr_json) as MessageContentStore;
            if (parsed && typeof parsed === "object" && parsed.version === 1
                && parsed.byHash && typeof parsed.byHash === "object"
                && parsed.byRef && typeof parsed.byRef === "object") {
                return parsed;
            }
        } catch {
            // fall through: a corrupt mirror degrades to the file path
        }
        return null;
    }

    getCcrEntries(sessionId: string): CcrEntryRow[] {
        const rows = this.db
            .prepare("SELECT ord, ccr_key, content_hash FROM ccr_entries WHERE session_id = ? ORDER BY ord")
            .all(sessionId) as Record<string, unknown>[];
        return rows.map((r) => ({
            ord: r.ord as number,
            key: r.ccr_key as string,
            content: this.getContent(r.content_hash as string) ?? "",
        }));
    }
}
