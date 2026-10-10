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
import { openSqliteDatabase, type SqliteDatabase, type SqliteEngineName } from "./driver.js";
import { migrateSchema, STORAGE_PRAGMAS } from "./schema.js";

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

export interface IngestSessionInput {
    session: SessionRow;
    messages: MessageRow[];
    blocks: BlockRow[];
    deadRefs: { ord: number; ref: string; refNum: number; recordedAt: number }[];
    refs: RefRow[];
    ccrEntries: CcrEntryRow[];
}

export class UnifiedStore {
    readonly engine: SqliteEngineName;
    private readonly db: SqliteDatabase;

    private constructor(db: SqliteDatabase, engine: SqliteEngineName) {
        this.db = db;
        this.engine = engine;
    }

    static open(path: string, engine?: SqliteEngineName): UnifiedStore {
        mkdirSync(dirname(path), { recursive: true });
        const { db, engine: used } = openSqliteDatabase(path, engine);
        for (const pragma of STORAGE_PRAGMAS) db.exec(pragma);
        migrateSchema(db);
        return new UnifiedStore(db, used);
    }

    close(): void {
        this.db.close();
    }

    /** Content CAS: insert-if-absent + refcount bump; returns hash. */
    private putContent(content: string | Buffer): string {
        const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        const hash = sha256Hex(bytes);
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

    ingestSession(input: IngestSessionInput): void {
        const s = input.session;
        this.db.transaction(() => {
            this.db
                .prepare(
                    `INSERT INTO sessions (session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title,
                       status, created_at, updated_at, next_block_id, next_run_id,
                       meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json)
                     VALUES (@sessionId, @parentSessionId, @forkPointSeq, @protocol, @label, @title, @hostTitle,
                       @status, @createdAt, @updatedAt, @nextBlockId, @nextRunId,
                       @metaJson, @statsJson, @metadataJson, @kstateJson, @tailJson, @ccrJson)
                     ON CONFLICT(session_id) DO UPDATE SET
                       parent_session_id = excluded.parent_session_id,
                       fork_point_seq = excluded.fork_point_seq,
                       protocol = excluded.protocol,
                       label = excluded.label,
                       title = excluded.title,
                       host_title = excluded.host_title,
                       status = excluded.status,
                       updated_at = excluded.updated_at,
                       next_block_id = excluded.next_block_id,
                       next_run_id = excluded.next_run_id,
                       meta_json = excluded.meta_json,
                       stats_json = excluded.stats_json,
                       metadata_json = excluded.metadata_json,
                       kstate_json = excluded.kstate_json,
                       tail_json = excluded.tail_json,
                       ccr_json = excluded.ccr_json`,
                )
                .run({
                    sessionId: s.sessionId,
                    parentSessionId: s.parentSessionId ?? null,
                    forkPointSeq: s.forkPointSeq ?? null,
                    protocol: s.protocol ?? null,
                    label: s.label ?? null,
                    title: s.title ?? null,
                    hostTitle: s.hostTitle ?? null,
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
                });

            for (const m of input.messages) {
                const hash = this.putContent(m.content);
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

            for (const b of input.blocks) {
                const summaryHash = this.putContent(b.summary);
                const oneHash = b.one === null ? null : this.putContent(b.one);
                // Re-ingest of the same block id replaces the row (dry-run
                // idempotence). Refcount math must distinguish identical
                // re-ingest (bump then undo) from a true replacement (release
                // the old hash, keep the new bump) — otherwise identical
                // re-ingest drives the surviving refcount to zero.
                const existing = this.db
                    .prepare("SELECT summary_hash, one_hash FROM blocks WHERE block_id = ?")
                    .get(b.blockId) as { summary_hash: string; one_hash: string | null } | undefined;
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
                         ON CONFLICT(block_id) DO UPDATE SET
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
        });
    }

    /** Deletes one session and releases every CAS refcount it holds
     *  (GC parity with the legacy path's file removal). Rows that other
     *  sessions also reference survive via their own refcounts. */
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
            this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM blocks WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM dead_refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM refs WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM ccr_entries WHERE session_id = ?").run(sessionId);
            this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
            for (const hash of refs) this.releaseContent(hash);
            // CAS rows at zero refcount are unreferenced garbage — collect.
            this.db.prepare("DELETE FROM content WHERE refcount <= 0").run();
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
        for (const t of ["sessions", "messages", "refs", "blocks", "dead_refs", "ccr_entries", "content", "conversations", "checkpoints"]) {
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
                `SELECT session_id, parent_session_id, fork_point_seq, protocol, label, title, host_title, status,
                        created_at, updated_at, next_block_id, next_run_id,
                        meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json
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
