/**
 * Unified-storage sidecar (#2671).
 *
 * Two opt-in levels via BILI_STORAGE_UNIFIED:
 *   - `1`/`true`/`shadow` (Phase 1): double-write dry-run. Every session
 *     record the legacy SessionStore commits is ALSO ingested into
 *     <sessionsDir>/index.db, and the reconstructed view is digest-checked
 *     against what the legacy loader (buildSession) would serve after a
 *     restart. Any drift is logged as an error — that is the entire point:
 *     the unified layer must replay legacy bytes exactly, and production
 *     traffic becomes the migration test corpus.
 *   - `full` (Phase 1.5): the drop-in replacement. Reads flip to
 *     unified-first with organic import (a session the index has not seen
 *     is imported from its legacy file on first load) and legacy fallback
 *     on any miss. Legacy files keep being written (rollback = unset the
 *     env), but the unified index is the load path.
 *
 * Failure policy: sidecar problems must NEVER break the legacy write path.
 * All work is try/catch'd; after MAX_CONSECUTIVE_FAILURES consecutive
 * failures the sidecar disables itself for the process (warn once) — in
 * full mode that also flips reads back to legacy-only.
 */

import { log as loggerLog } from "../logger.js";
import { planIngest, planIngestDelta, loadLegacyView, completeBlockContents, type LegacySessionLike } from "./ingest.ts";
import { resolveStorageMode, resolveStorageWalJournalSizeLimit, type StorageMode } from "../knobs.ts";
import { UnifiedStore, type CheckpointRow, type SessionSummaryRow, type WebSummaryRow } from "./store.ts";
import { canonicalize, sha256 } from "./canonical.ts";
import { recordSidecarInstance, recordSidecarOpenFailure } from "./runtime-status.ts";
import type { SqliteEngineName, SqliteEngineSource } from "./driver.ts";
import type { CoreMessage, MessageContentStore } from "acp-kernel";

export const MAX_CONSECUTIVE_FAILURES = 3;

/** #3133: read-back verification cadence — the verify leg (full read-back +
 *  double shadowDigest) is O(log) per save, while the drift it guards is a
 *  migration-parity property, not a per-commit one. The FIRST ingest of a
 *  session always verifies (cold-path full check), then every N-th. */
export const VERIFY_EVERY_INGESTS = 20;

// Canonical home for StorageMode/resolveStorageMode is src/knobs.ts (env-var
// discipline, #2030); re-exported here for the storage-layer importers.
export { resolveStorageMode, type StorageMode } from "../knobs.ts";

interface ShadowStats {
    ingests: number;
    deltaIngests: number;
    /** #3133: sampled read-back verifications RUN (verifyOk + verifyDrift
     *  ≤ this). Sampling, not removal — drift stays observable. */
    verifySamples: number;
    verifyOk: number;
    verifyDrift: number;
    imports: number;
    disabled: boolean;
    lastError: string | null;
}

export class UnifiedShadow {
    readonly mode: StorageMode;
    readonly stats: ShadowStats = { ingests: 0, deltaIngests: 0, verifySamples: 0, verifyOk: 0, verifyDrift: 0, imports: 0, disabled: false, lastError: null };
    private readonly store: UnifiedStore;
    private readonly legacyLoad: (record: unknown) => LegacySessionLike | null;
    private consecutiveFailures = 0;
    /** #3133: per-session ingest counters (verify sampling). Per-process
     *  only — nothing persisted, no schema change. */
    private readonly ingestCounts = new Map<string, number>();

    private constructor(mode: StorageMode, store: UnifiedStore, legacyLoad: (record: unknown) => LegacySessionLike | null) {
        this.mode = mode;
        this.store = store;
        this.legacyLoad = legacyLoad;
    }

    /** Opens the sidecar when a knob asks for one; null (no cost) otherwise. */
    static maybeOpen(
        dir: string,
        env: NodeJS.ProcessEnv = process.env,
        legacyLoad?: (record: unknown) => LegacySessionLike | null,
        fileUnified?: string,
        fileWalLimit?: number,
    ): UnifiedShadow | null {
        const mode = resolveStorageMode(env, fileUnified);
        if (mode === "legacy") return null;
        const walLimit = resolveStorageWalJournalSizeLimit(env, fileWalLimit);
        let store: UnifiedStore;
        try {
            store = UnifiedStore.open(`${dir}/index.db`, undefined, { walJournalSizeLimitBytes: walLimit });
            // #3285: watermark trust does not cross process boundaries — a
            // restart-handoff overlap leaves the previous writer's rows AND
            // watermark behind; drop them all so this process's first save
            // per session re-establishes trust from its own view.
            store.resetAllIngestWatermarks();
        } catch (err) {
            // #2771: a corrupt/unreadable index.db must degrade to legacy-only
            // (same shape as the encryption opt-out), never brick SessionStore
            // construction. No auto-delete: the index may hold pinned checkpoint
            // blobs (#2671 Phase 2) — destructive recovery is operator policy.
            loggerLog(
                "warn",
                `[storage] unified sidecar failed to open ${dir}/index.db (${String(err)}) — staying legacy-only; delete the file to reset the index`,
            );
            recordSidecarOpenFailure(String(err));
            return null;
        }
        const shadow = new UnifiedShadow(mode, store, legacyLoad ?? (() => null));
        recordSidecarInstance(shadow);
        const engineTag = ` [engine: ${store.engine}/${store.engineSource}]`;
        const walTag = ` [wal-cap: ${walLimit}]`;
        loggerLog(
            "info",
            mode === "full"
                ? `[storage] unified FULL mode ENABLED (storage.unified=full or BILI_STORAGE_UNIFIED=full): index.db is the load path (unified-first, legacy fallback); legacy files keep being written — unset the knob to roll back${engineTag}${walTag}`
                : `[storage] unified shadow mode ENABLED (storage.unified=shadow or BILI_STORAGE_UNIFIED): every session write is double-ingested into index.db and digest-reconciled${engineTag}${walTag}`,
        );
        return shadow;
    }

    /** True when reads should go unified-first (full mode, sidecar healthy). */
    get readsUnified(): boolean {
        return this.mode === "full" && !this.stats.disabled;
    }

    get engine(): SqliteEngineName {
        return this.store.engine;
    }

    get engineSource(): SqliteEngineSource {
        return this.store.engineSource;
    }

    /** Ingest + verify one committed record. Never throws.
     *
     *  `rawTail` (#2960 ⑤): the live in-memory conversation tail when the
     *  caller has one. The envelope persists only a pruned+truncated view of
     *  it (boundedFoldedSnapshot) — the unified store is supposed to hold the
     *  message log authoritatively, so the ingest uses the raw tail whenever
     *  available; both digest legs go through the same override, so parity
     *  accounting stays honest. */
     record(record: unknown, rawTail?: { lastMessages: CoreMessage[]; lastMessagesFolded?: boolean; lastMessagesHostIds?: (string | null)[] }, liveCcr?: MessageContentStore): void {
        if (this.stats.disabled) return;
        try {
            const loaded = this.legacyLoad(record);
            if (!loaded) return;
            let legacy = loaded;
            let hasRawTail = false;
            if (rawTail && rawTail.lastMessages.length > 0) {
                hasRawTail = true;
                // #3464 (R1): the host-id pairing rides with the raw tail —
                // absent here means the lane was not stamped for this save.
                legacy = {
                    ...legacy,
                    lastMessages: rawTail.lastMessages,
                    lastMessagesFolded: rawTail.lastMessagesFolded === true,
                    ...(rawTail.lastMessagesHostIds ? { lastMessagesHostIds: rawTail.lastMessagesHostIds } : {}),
                };
            }
            // #2960 ③: the live kernel content store when the caller has one
            // materialized — the envelope only serializes it for fork-receipt
            // sessions, so without this override the unified ccr mirror would
            // stay empty for every plain compressed session. Both digest legs
            // flow through the same override.
            if (liveCcr) legacy = { ...legacy, contentStore: liveCcr };
            // #3133 watermark: pay the full O(log) ingest only when the
            // trusted-prefix probe cannot vouch for the stored prefix —
            // steady-state saves stringify+hash+INSERT just the NEW tail.
            // Any doubt (no watermark, foreign edit, tail shorter than the
            // watermark, snapshot-bearing session) falls back to the exact
            // full path below; the delta itself re-verifies the boundary
            // inside the ingest transaction, so a racing writer degrades to
            // a full ingest, never a corrupt one.
            if (!this.ingestDelta(legacy, hasRawTail)) {
                const plan = planIngest(legacy);
                // #3285: only a raw-tail plan is the complete log — that is
                // what lets the full path sweep foreign rows as stale.
                this.store.ingestSession(plan, undefined, { completeLog: hasRawTail });
            }
            this.stats.ingests++;
            // #3133 sampled verification: ingest integrity is already guarded
            // by the SQLite write path; the read-back digest is a migration
            // parity oracle, so it runs on the first ingest of a session and
            // then every VERIFY_EVERY_INGESTS-th (drift stays observable via
            // stats.verifyDrift on the sampled saves).
            const count = (this.ingestCounts.get(legacy.id) ?? 0) + 1;
            this.ingestCounts.set(legacy.id, count);
            if ((count - 1) % VERIFY_EVERY_INGESTS === 0) {
                this.stats.verifySamples++;
                const sessionRow = this.store.getSessionRow(legacy.id);
                if (!sessionRow) throw new Error(`session row missing after ingest: ${legacy.id}`);
                const rows = {
                    session: sessionRow,
                    messages: this.store.getMessages(legacy.id),
                    blocks: this.store.getBlocks(legacy.id),
                    deadRefs: this.store.getDeadRefs(legacy.id),
                    refs: this.store.getRefs(legacy.id),
                };
                const loaded = loadLegacyView(rows);
                const expect = shadowDigest({ ...legacy, blockContents: orderedBlockContents(completeBlockContents(legacy.blockContents, legacy.state.blocks)) });
                const got = shadowDigest({ ...loaded, blockContents: orderedBlockContents(loaded.blockContents) });
                if (got !== expect) {
                    this.stats.verifyDrift++;
                    // Panels consume {disabled, lastError} — make the sampled
                    // degradation visible there, not just in the counter/log.
                    this.stats.lastError = `digest drift for ${legacy.id}: unified replay != legacy load view`;
                    // #3166 review: the backstop must heal, not only report —
                    // the watermark still vouches for a prefix the digest just
                    // proved stale (e.g. an envelope re-render or interior
                    // rewrite below the boundary), and every same-length save
                    // would re-take the unverified empty delta against it.
                    // Drop the watermark so the next save re-points every
                    // tail slot through the exact full path (divergence
                    // window bounded to ≤ VERIFY_EVERY_INGESTS saves).
                    this.store.clearIngestWatermark(legacy.id);
                    loggerLog("error", `[storage] unified shadow DIGEST DRIFT for ${legacy.id}: unified replay != legacy load view — dropped the ingest watermark, the next save re-ingests the full tail`);
                } else {
                    this.stats.verifyOk++;
                }
            }
            this.consecutiveFailures = 0;
        } catch (err) {
            this.consecutiveFailures++;
            this.stats.lastError = String(err);
            if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                this.stats.disabled = true;
                loggerLog("warn", `[storage] unified shadow disabled after ${this.consecutiveFailures} consecutive failures (last: ${String(err)})`);
            }
        }
    }

    /** #3133 delta ingest attempt for one record's legacy view — returns
     *  true when the O(new-messages) fast path committed. Every doubt
     *  routes to `false` (→ the caller's full ingest); failures here must
     *  never throw into record(), whose catch counts toward disabling the
     *  shadow — a watermark hiccup is not a storage health problem. */
    private ingestDelta(legacy: LegacySessionLike, hasRawTail: boolean): boolean {
        try {
            const mark = this.store.ingestWatermark(legacy.id);
            if (!mark) return false;
            // The pre-transaction probe is an optimization (skip building a
            // doomed plan); ingestSession re-verifies the boundary inside
            // BEGIN IMMEDIATE, which is the authoritative check.
            const boundary = this.store.probeIngestBoundary(legacy.id, mark.seq);
            if (!boundary) return false;
            const plan = planIngestDelta(legacy, mark.seq, mark.tailSeqs, { msgId: boundary.msgId, contentHash: boundary.contentHash }, hasRawTail);
            if (!plan) return false;
            const applied = this.store.ingestSession(plan, {
                trustedSeq: mark.seq,
                boundaryMsgId: boundary.msgId,
                boundaryHash: boundary.contentHash,
                trustedTailSeqs: mark.tailSeqs,
            });
            if (applied) this.stats.deltaIngests++;
            return applied;
        } catch {
            return false;
        }
    }

    /** Loads the unified view of one session (full mode read path).
     *  Returns null on miss — the caller falls back to the legacy file. */
    viewFor(id: string): LegacySessionLike | null {
        if (this.stats.disabled) return null;
        try {
            const sessionRow = this.store.getSessionRow(id);
            if (!sessionRow) return null;
            const rows = {
                session: sessionRow,
                messages: this.store.getMessages(id),
                blocks: this.store.getBlocks(id),
                deadRefs: this.store.getDeadRefs(id),
                refs: this.store.getRefs(id),
            };
            // The view's `state` object carries every MERGE_STATE_FIELDS key by
            // construction; the declared Record<string, unknown> just needs a
            // widening cast to reach LegacySessionLike.
            return loadLegacyView(rows) as LegacySessionLike;
        } catch (err) {
            loggerLog("warn", `[storage] unified load failed for ${id} (${String(err)}) — falling back to the legacy file`);
            return null;
        }
    }

    /** Organic import (full mode): ingest a legacy record the index has not
     *  seen so future loads serve from the unified store. Never throws. */
    importRecord(record: unknown): LegacySessionLike | null {
        if (this.stats.disabled) return null;
        try {
            const legacy = this.legacyLoad(record);
            if (!legacy) return null;
            this.store.ingestSession(planIngest(legacy));
            this.stats.imports++;
            loggerLog("info", `[storage] unified import on first open: ${legacy.id}`);
            return legacy;
        } catch (err) {
            loggerLog("warn", `[storage] unified import failed for a legacy record (${String(err)}) — serving the legacy view`);
            return null;
        }
    }

    /** GC parity: remove the session's rows when the legacy files are deleted. */
    remove(id: string): void {
        this.ingestCounts.delete(id);
        if (this.stats.disabled) return;
        try {
            this.store.deleteSession(id);
        } catch (err) {
            loggerLog("warn", `[storage] unified remove failed for ${id} (${String(err)})`);
        }
    }

    // ---- Phase 2 checkpoints/replicas (#2671) -------------------------------
    // Thin pass-throughs so callers never touch the raw UnifiedStore. All
    // throw (never log-and-swallow): replica management is an explicit
    // operator action, unlike the never-throw shadow mirrors above.

    createCheckpoint(cp: Parameters<UnifiedStore["insertCheckpoint"]>[0]): void {
        this.assertLive();
        this.store.insertCheckpoint(cp);
    }

    listCheckpoints(sessionId?: string): CheckpointRow[] {
        this.assertLive();
        return this.store.listCheckpoints(sessionId);
    }

    getCheckpoint(cpId: string): CheckpointRow | undefined {
        this.assertLive();
        return this.store.getCheckpoint(cpId);
    }

    checkpointState(cpId: string): { stateJson: string; byteLen: number } {
        this.assertLive();
        return this.store.checkpointState(cpId);
    }

    deleteCheckpoint(cpId: string): boolean {
        this.assertLive();
        return this.store.deleteCheckpoint(cpId);
    }

    /** Ingest freshness watermark for load-side import gating (null = never
     *  ingested). See SessionStore.buildForLoadAll for the race this guards. */
    sessionUpdatedAt(sessionId: string): number | null {
        this.assertLive();
        return this.store.sessionUpdatedAt(sessionId);
    }

    /** Absolute-seq tip of the session's message log (+1 = next free seq).
     *  Used as a checkpoint's seq_at. */
    sessionTipSeq(sessionId: string): number {
        this.assertLive();
        let tip = 0;
        for (const m of this.store.getMessages(sessionId)) if (m.seq + 1 > tip) tip = m.seq + 1;
        return tip;
    }

    /** All sessions row ids present in the index (#2960 R2.1). Used by the
     *  full-mode boot union so rows whose legacy file disappeared remain
     *  enumerable. */
    listSessionIds(): string[] {
        this.assertLive();
        return this.store.listSessionIds();
    }

    /** Identity lookup passthrough (#2960 R2.1). */
    lookupConversation(namespace: string, conversationId: string): string | null {
        this.assertLive();
        return this.store.lookupConversation(namespace, conversationId);
    }

    /** #3049: O(1) counter probe backing the persist stale-guard fast path.
     *  Safe on a disabled sidecar? NO — call sites must check stats first
     *  (this throws like every other pass-through; the guard treats any
     *  failure as "no fast path" and falls back to the full envelope read). */
    sessionCounters(sessionId: string): { requests: number; nextBlockId: number } | null {
        this.assertLive();
        return this.store.sessionCounters(sessionId);
    }

    listConversationBindings(namespace?: string): { namespace: string; conversationId: string; sessionId: string; claimedAt: number }[] {
        this.assertLive();
        return this.store.listConversationBindings(namespace);
    }

    /** Summary fast-path rows (#2960 R2.1): export/web lists serve from one
     *  SQL instead of walking + parsing every legacy file. */
    /** #3248: raw canonical rows for the incremental lane (core-form
     *  message JSON in seq order — exactly what planIngest interned). */
    rawMessages(sessionId: string): { seq: number; content: string }[] {
        this.assertLive();
        return this.store.getMessages(sessionId).map((m) => ({ seq: m.seq, content: m.content }));
    }

    sessionSummaries(): SessionSummaryRow[] {
        this.assertLive();
        return this.store.sessionSummaries();
    }

    /** #2960 ③: whole-store CCR read from the sessions row's ccr mirror. */
    getCcr(sessionId: string): MessageContentStore | null {
        this.assertLive();
        return this.store.getCcr(sessionId);
    }

    /** #2960 R2.2: web list rows (stats/metadata JSON + block aggregates). */
    webSummaryRows(): WebSummaryRow[] {
        this.assertLive();
        return this.store.webSummaryRows();
    }

    // ------------------------------------------------------------------
    // Extension namespaces (#3069 v4): thin passthroughs. Works in shadow
    // AND full mode — extension state is side-table substrate (like
    // checkpoints), not part of the legacy load path.
    // ------------------------------------------------------------------

    setSessionExt(sessionId: string, key: string, value: unknown): void {
        this.assertLive();
        this.store.setSessionExt(sessionId, key, value);
    }

    getSessionExt(sessionId: string, key: string): unknown {
        this.assertLive();
        return this.store.getSessionExt(sessionId, key);
    }

    listSessionExt(sessionId: string): { key: string; value: unknown; updatedAt: number }[] {
        this.assertLive();
        return this.store.listSessionExt(sessionId);
    }

    deleteSessionExt(sessionId: string, key?: string): number {
        this.assertLive();
        return this.store.deleteSessionExt(sessionId, key);
    }

    setKv(namespace: string, key: string, value: unknown): void {
        this.assertLive();
        this.store.setKv(namespace, key, value);
    }

    getKv(namespace: string, key: string): unknown {
        this.assertLive();
        return this.store.getKv(namespace, key);
    }

    listKv(namespace?: string, keyPrefix?: string): { namespace: string; key: string; value: unknown; updatedAt: number }[] {
        this.assertLive();
        return this.store.listKv(namespace, keyPrefix);
    }

    deleteKv(namespace: string, key?: string): number {
        this.assertLive();
        return this.store.deleteKv(namespace, key);
    }

    private assertLive(): void {
        if (this.stats.disabled) throw new Error("[storage] unified sidecar is disabled (repeated failures) — replica operations are unavailable");
    }

    close(): void {
        try {
            this.store.close();
        } catch {
            // shutdown path — never throw
        }
    }
}

function shadowDigest(view: unknown): string {
    return sha256(JSON.stringify(canonicalize(view)));
}

// #3407: the parity digest must compare blockContents CONTENTS, not insertion order —
// the expect leg keeps the live Map's order (completeBlockContents appends synthesized
// entries at the end) while the got leg lays blocks out in state.blocks array order.
function orderedBlockContents<T>(m: Map<string, T>): Map<string, T> {
    return new Map([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}
