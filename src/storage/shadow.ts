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
import type { BlockView } from "../session.js";
import { resolveStorageMode, resolveStorageWalJournalSizeLimit, type StorageMode } from "../knobs.ts";
import { UnifiedStore, StorageIntegrityError, type CheckpointRow, type SessionSummaryRow, type WebSummaryRow } from "./store.ts";
import { renameSync } from "node:fs";
import path from "node:path";
import { resolveBackendName, backendSelectionNotice, selectedBackendRaw, openBackend, type StorageBackend } from "./backend.ts";
import { canonicalize, sha256 } from "./canonical.ts";
import { recordSidecarInstance, recordSidecarOpenFailure } from "./runtime-status.ts";
import type { SqliteEngineName, SqliteEngineSource } from "./driver.ts";
import type { MessageRow, MessageRefContentRow } from "./store.js";
import type { CoreMessage, MessageContentStore } from "acp-kernel";

export const MAX_CONSECUTIVE_FAILURES = 3;

/** #3133: read-back verification cadence — the verify leg (full read-back +
 *  double shadowDigest) is O(log) per save, while the drift it guards is a
 *  migration-parity property, not a per-commit one. The FIRST ingest of a
 *  session always verifies (cold-path full check), then every N-th. */
export const VERIFY_EVERY_INGESTS = 20;

/** #4323: consecutive sampled drifts required before escalating. A one-off
 *  drift is transient external churn (the watermark clear below heals it);
 *  N in a row proves the views are STRUCTURALLY divergent — the multi-writer
 *  signature (#394), where nothing this process does can converge them.
 *  Escalation = loud WARN with both sides' fold counts + freeze of THIS
 *  process's JSON envelope writes for the session (persist.ts consults
 *  envelopeFrozen on every save route); the unified store keeps receiving
 *  every save, and the first clean sample re-admits the session. */
export const DRIFT_ESCALATE_STREAK = 3;

/** #3823: on win32 "unable to open database file" (SQLITE_CANTOPEN) is almost
 * always an OS-level refusal — antivirus/Defender holding the dir, OneDrive
 * placeholder files under the profile dir, a path past MAX_PATH, or a
 * restricted/sandboxed process whose writes Windows integrity control refuses
 * (#3823 field report: a DSH-launched child at low integrity hit exactly this
 * class on its CA bundle) — NOT a corrupt index.db, so the generic "delete
 * the file" recovery advice misleads for that class; name the real suspects
 * instead. Empty elsewhere: every field instance of this failure domain is
 * win32-x64 (#3338/#3385/#3788/#3823), and Linux/macOS CANTOPEN causes
 * (permissions, disk full) are too varied to hint at usefully. */
export function sqliteOpenFailureHint(err: string): string {
    if (process.platform !== "win32") return "";
    if (!/unable to open database file/i.test(err)) return "";
    return " (win32: the OS refused to open the file — usually antivirus/Defender locking the sessions dir, OneDrive placeholder files under the profile dir, a path over 260 chars, or a restricted/sandboxed process (low-integrity label, app container) whose writes Windows integrity control refuses; exclude %USERPROFILE%\\.local\\share\\billion-context\\ from antivirus real-time scanning first; deleting the file will not clear a lock)";
}

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
    /** #3818: records skipped from the mirror because they carry orphan
     * blockContents (ids with no state.blocks entry) — hand-built archives
     * and web seeds; the JSON envelope remains the serving copy. */
    orphanSkips: number;
}

/**
 * #3818: true when blockContents carries ids that no state.blocks entry
 * claims. The unified ingest only materializes block rows for
 * state.blocks entries, so such records cannot round-trip through viewFor
 * without losing the orphans — they must keep serving from their JSON
 * envelope. Real kernel sessions never trip this (state.blocks retains
 * consumed blocks); hand-built archives and web seeds can.
 */
export function orphanContents(legacy: LegacySessionLike): boolean {
    if (legacy.blockContents.size === 0) return false;
    const known = new Set<string>();
    for (const block of legacy.state.blocks) known.add(block.blockId);
    for (const id of legacy.blockContents.keys()) {
        if (!known.has(id)) return true;
    }
    return false;
}

export class UnifiedShadow {
    readonly mode: StorageMode;
    readonly stats: ShadowStats = { ingests: 0, deltaIngests: 0, verifySamples: 0, verifyOk: 0, verifyDrift: 0, imports: 0, disabled: false, lastError: null, orphanSkips: 0 };
    /** #3135 ④/#3818: sessions whose last sampled verify drifted. Members are
     *  served from the JSON envelope by persist.loadSync (while it exists)
     *  until a save verifies clean again; surfaced on /__bili/status wire as
     *  driftedSessions so drift is observable, not just logged. */
    readonly driftedSessions = new Set<string>();
    /** #4323: per-session consecutive sampled-drift count (resets on a clean
     *  sample). Per-process only, same as ingestCounts. */
    readonly driftStreaks = new Map<string, number>();
    /** #4323: sessions whose drift escalated to DRIFT_ESCALATE_STREAK — this
     *  process stops writing their JSON envelopes (persist.ts routes their
     *  saves index-only) so a multi-writer ping-pong (#394) can no longer
     *  churn the file copy; the first clean sample re-admits. */
    readonly frozenEnvelopeIds = new Set<string>();
    /** #3931 step 3: the sqlite fast lane. Null when the selected backend
     *  is a network backend (mysql) — then every sync facade method below
     *  returns its miss value (null / [] / no-op) and callers fall back to
     *  the JSON envelope exactly as they do when no sidecar opened, while
     *  the async twins route through `backend`. The sqlite path stays
     *  byte-identical to the pre-step-3 behavior. */
    private readonly sync: UnifiedStore | null;
    /** Async contract backend (mysql when sync === null; SqliteBackend
     *  wrapper is NOT constructed on the sqlite path — record()/viewFor()
     *  keep calling the raw store synchronously). */
    private readonly backend: StorageBackend | null = null;
    /** Serializes async-backend work (record queue) the way the sync store
     *  implicitly serialized inside one event-loop turn. */
    private queueTail: Promise<void> = Promise.resolve();
    private readonly legacyLoad: (record: unknown) => LegacySessionLike | null;
    private consecutiveFailures = 0;
    /** #3133: per-session ingest counters (verify sampling). Per-process
     *  only — nothing persisted, no schema change. */
    private readonly ingestCounts = new Map<string, number>();

    private constructor(mode: StorageMode, store: UnifiedStore | null, legacyLoad: (record: unknown) => LegacySessionLike | null, backend?: StorageBackend) {
        this.mode = mode;
        this.sync = store;
        if (store === null) this.backend = backend ?? null;
        this.legacyLoad = legacyLoad;
    }

    /** #3931 step 3: true when this shadow rides a network backend (mysql).
     *  Sync facade methods miss; async twins carry the traffic. */
    get isAsyncBackend(): boolean {
        return this.sync === null;
    }

    /** Honest engine label for status surfaces (sqlite keeps the raw store
     *  introspection; mysql reports itself). */
    get engineInfo(): { name: string; source: string } {
        return this.sync
            ? { name: this.sync.engine, source: this.sync.engineSource }
            : { name: "mysql", source: "network" };
    }

    /** Opens the sidecar when a knob asks for one; null (no cost) otherwise. */
    static maybeOpen(
        dir: string,
        env: NodeJS.ProcessEnv = process.env,
        legacyLoad?: (record: unknown) => LegacySessionLike | null,
        fileUnified?: string,
        fileWalLimit?: number,
        fileBackend?: string,
    ): UnifiedShadow | null {
        const mode = resolveStorageMode(env, fileUnified);
        if (mode === "legacy") return null;
        const walLimit = resolveStorageWalJournalSizeLimit(env, fileWalLimit);
        // #3931: the backend seam. Step 1 keeps sqlite as the only real
        // implementation; a non-sqlite selection (e.g. "mysql", step 2)
        // logs ONE notice line and stays on sqlite rather than crashing
        // boots — the hard error lives at openBackend() for the paths that
        // open a backend directly (export).
        // The notice judges the RAW selection (#3932 review): resolveBackendName's
        // output would have collapsed typo'd names to sqlite and silenced them.
        const selected = selectedBackendRaw(env, fileBackend);
        if (selected && selected !== "sqlite") {
            const notice = backendSelectionNotice(selected);
            if (notice) loggerLog("warn", notice);
        }
        let store: UnifiedStore;
        try {
            try {
                store = UnifiedStore.open(`${dir}/index.db`, undefined, { walJournalSizeLimitBytes: walLimit });
            } catch (err) {
                // #4175: quick_check failed — the file set is provably corrupt.
                // Quarantine it (db/-wal/-shm → .corrupt-<ts>, same suffix
                // discipline as the session envelopes) and retry ONCE with a
                // fresh file: the JSON envelopes remain the recovery source
                // (full mode re-imports organically on load). No auto-delete —
                // the corrupt original is kept for forensics.
                if (!(err instanceof StorageIntegrityError)) throw err;
                const stamp = Date.now();
                const quarantined: string[] = [];
                for (const suffix of ["", "-wal", "-shm"]) {
                    const from = `${dir}/index.db${suffix}`;
                    const to = `${dir}/index.db${suffix}.corrupt-${stamp}`;
                    try {
                        renameSync(from, to);
                        quarantined.push(path.basename(to));
                    } catch {
                        /* absent sidecar files are fine */
                    }
                }
                // #4609: the verdict cache belongs to the quarantined file set —
                // move it along so the fresh store starts with a clean cache
                // (its stats differ anyway; this keeps the directory honest).
                try {
                    const cacheFrom = `${dir}/index.db.chk`;
                    renameSync(cacheFrom, `${cacheFrom}.corrupt-${stamp}`);
                    quarantined.push(path.basename(`${cacheFrom}.corrupt-${stamp}`));
                } catch {
                    /* absent cache is fine */
                }
                loggerLog(
                    "error",
                    `[storage] index.db failed its integrity quick_check (${err.detail}) — quarantined ${quarantined.join(", ")} and reopened fresh; JSON envelopes remain the recovery source (#4175)`,
                );
                store = UnifiedStore.open(`${dir}/index.db`, undefined, { walJournalSizeLimitBytes: walLimit });
            }
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
            const errStr = String(err);
            // Deleting the index cannot fix a no-engine failure (this Node.js has neither builtin
            // node:sqlite nor a loadable better-sqlite3) — that advice only fits a genuine open
            // failure; the Node.js upgrade lever is surfaced via /__bili/status + the bootstrap warn.
            const tail = /no SQLite engine available/i.test(errStr)
                ? ""
                : `${sqliteOpenFailureHint(errStr)}; delete the file to reset the index`;
            loggerLog(
                "warn",
                `[storage] unified sidecar failed to open ${dir}/index.db (${errStr}) — staying legacy-only${tail}`,
            );
            recordSidecarOpenFailure(errStr);
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

    /** #3931 step 3: async open for network backends. sqlite resolves
     *  synchronously through maybeOpen (same instance, zero behavior
     *  change); mysql opens the pool + runs DDL via backend.init() and can
     *  only be awaited — SessionStore assigns this.shadow when it resolves
     *  and `ready()` gates the async consumers (saves/boot/admin). */
    static async openAsync(
        dir: string,
        env: NodeJS.ProcessEnv = process.env,
        legacyLoad?: (record: unknown) => LegacySessionLike | null,
        fileUnified?: string,
        fileWalLimit?: number,
        fileBackend?: string,
        fileMysqlDsn?: string,
    ): Promise<UnifiedShadow | null> {
        const backendName = resolveBackendName(env, fileBackend);
        if (backendName !== "mysql") return UnifiedShadow.maybeOpen(dir, env, legacyLoad, fileUnified, fileWalLimit, fileBackend);
        const mode = resolveStorageMode(env, fileUnified);
        if (mode === "legacy") return null;
        const dsn = (env.BILI_MYSQL_DSN ?? fileMysqlDsn ?? "").trim();
        if (!dsn) {
            loggerLog("warn", "[storage] storage.backend=mysql selected but no DSN is configured (BILI_MYSQL_DSN or storage.mysql.dsn) — staying legacy-only; see the CONFIGURATION storage section");
            recordSidecarOpenFailure("mysql backend selected without a DSN");
            return null;
        }
        try {
            const backend = await openBackend("mysql", dsn);
            await backend.init?.();
            const shadow = new UnifiedShadow(mode, null, legacyLoad ?? (() => null), backend);
            recordSidecarInstance(shadow);
            loggerLog("info", `[storage] unified ${mode === "full" ? "FULL" : "shadow"} mode on the MYSQL backend (dsn host ${dsn.replace(/:[^:@/]*@/, ":***@")}) — async shadow facade; JSON envelopes keep being written (writerOff is sqlite-only)`);
            return shadow;
        } catch (err) {
            const errStr = String(err);
            loggerLog("warn", `[storage] mysql backend failed to open (${errStr}) — staying legacy-only`);
            recordSidecarOpenFailure(errStr);
            return null;
        }
    }

    /** True when reads should go unified-first (full mode, sidecar healthy). */
    get readsUnified(): boolean {
        return this.mode === "full" && !this.stats.disabled;
    }

    // engine/engineSource introspection lives in engineInfo (sqlite-only
    // diagnostics widened for network backends); runtime-status reads that.

    /** Ingest + verify one committed record. Never throws.
     *
     *  `rawTail` (#2960 ⑤): the live in-memory conversation tail when the
     *  caller has one. The envelope persists only a pruned+truncated view of
     *  it (boundedFoldedSnapshot) — the unified store is supposed to hold the
     *  message log authoritatively, so the ingest uses the raw tail whenever
     *  available; both digest legs go through the same override, so parity
     *  accounting stays honest. */
    record(record: unknown, rawTail?: { lastMessages: CoreMessage[]; lastMessagesFolded?: boolean }, liveCcr?: MessageContentStore): void {
        // #3931 step 3: network backend — the ingest runs on the serial
        // queue (fire-and-forget; failures feed the same 3-strike disable).
        if (this.sync === null) {
            this.enqueueAsyncRecord(record, rawTail, liveCcr);
            return;
        }
        if (this.stats.disabled) return;
        try {
            const loaded = this.legacyLoad(record);
            if (!loaded) return;
            // #4216/#4242: the reap shape (blockContents without their
            // state.blocks entries) is now REPRESENTABLE — planIngest
            // journals the orphan contents into sessions.orphans_json and
            // the store merges it in the same transaction, while the blocks
            // stale-sweep drops the reaped rows. The old early-return here
            // froze every subsequent save for such sessions (rows stuck at
            // hours-old state, #4216). Normal ingest for everyone.
            let legacy = loaded;
            let hasRawTail = false;
            if (rawTail && rawTail.lastMessages.length > 0) {
                hasRawTail = true;
                legacy = { ...legacy, lastMessages: rawTail.lastMessages, lastMessagesFolded: rawTail.lastMessagesFolded === true };
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
                this.sync.ingestSession(plan, undefined, { completeLog: hasRawTail });
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
                const sessionRow = this.sync.getSessionRow(legacy.id);
                if (!sessionRow) throw new Error(`session row missing after ingest: ${legacy.id}`);
                const rows = {
                    session: sessionRow,
                    messages: this.sync.getMessages(legacy.id),
                    blocks: this.sync.getBlocks(legacy.id),
                    deadRefs: this.sync.getDeadRefs(legacy.id),
                    refs: this.sync.getRefs(legacy.id),
                };
                const replayed = loadLegacyView(rows);
                warnTailGaps(legacy.id, replayed);
                const expectView = { ...legacy, blockContents: orderedBlockContents(completeBlockContents(legacy.blockContents, legacy.state.blocks)) };
                const gotView = { ...replayed, blockContents: orderedBlockContents(replayed.blockContents) };
                const expect = shadowDigest(expectView);
                const got = shadowDigest(gotView);
                if (got !== expect) {
                    this.stats.verifyDrift++;
                    // #3919: membership from BEFORE this add is the repeat
                    // signal — two consecutive sampled drifts mean the views
                    // are NOT converging (the watermark clear healed nothing),
                    // which is the structural-drift signature the user needs
                    // to distinguish from one-off external churn.
                    const repeat = this.driftedSessions.has(legacy.id);
                    this.driftedSessions.add(legacy.id);
                    // #4323: count CONSECUTIVE sampled drifts — membership alone
                    // caps at "repeat yes/no" and cannot distinguish 3+ samples.
                    // N in a row proves structural divergence (multi-writer
                    // #394): escalate ONCE at the threshold with a loud WARN
                    // naming both sides' fold counts, then freeze THIS
                    // process's envelope writes for the session so the ping-
                    // pong stops churning the file copy (persist.ts consults
                    // envelopeFrozen on every save route; the unified store
                    // keeps receiving every save either way).
                    const streak = (this.driftStreaks.get(legacy.id) ?? 0) + 1;
                    this.driftStreaks.set(legacy.id, streak);
                    if (streak === DRIFT_ESCALATE_STREAK) {
                        this.frozenEnvelopeIds.add(legacy.id);
                        let sides = "";
                        try {
                            const envBlocks = expectView.state.blocks.filter((b) => b.active).length;
                            const idxBlocks = (gotView.state.blocks as { active?: boolean }[] | null | undefined)?.filter((b) => b.active === true).length ?? 0;
                            sides = ` [envelope ${envBlocks} active block(s) vs index ${idxBlocks}]`;
                        } catch {
                            // counts must never break the heal path
                        }
                        loggerLog("warn", `[storage] DIGEST DRIFT ESCALATED for ${legacy.id}: ${streak} consecutive sampled drifts — the views have stopped converging${sides}. This usually means MULTIPLE bili instances share one sessions dir (#394 anti-pattern; second-instance detection: #4177). Freezing THIS process's JSON envelope writes for the session until a clean sample re-admits it — the unified store keeps receiving every save (#4323)`);
                    }
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
                    this.sync.clearIngestWatermark(legacy.id);
                    // #3919: the digest says WHICH bytes disagree but not WHERE —
                    // append the field-level diagnosis (diverged dimensions +
                    // first divergent tail slot, fingerprints only, never body
                    // text) so one log line is enough to classify the trigger.
                    // The line prefix stays byte-identical for existing greps.
                    let diagnosis = "";
                    try {
                        diagnosis = formatDriftDiagnostics(describeViewDivergence(expectView, gotView));
                    } catch {
                        // diagnostics must never break the heal path
                    }
                    loggerLog("error", `[storage] unified shadow DIGEST DRIFT for ${legacy.id}: unified replay != legacy load view${repeat ? " (repeat: consecutive sampled drift — the views are not converging)" : ""}${diagnosis} — dropped the ingest watermark, the next save re-ingests the full tail`);
                } else {
                    this.stats.verifyOk++;
                    // #3135 ④/#3818: a clean sample re-admits the session to
                    // index-first reads (the watermark re-verify path above
                    // proved the views converged again).
                    this.driftedSessions.delete(legacy.id);
                    // #4323: convergence also ends the streak and unfreezes
                    // this process's envelope writes for the session.
                    this.driftStreaks.delete(legacy.id);
                    if (this.frozenEnvelopeIds.delete(legacy.id)) {
                        loggerLog("info", `[storage] drift resolved for ${legacy.id}: clean sample re-admits the session — envelope writes resume (#4323)`);
                    }
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
        if (this.sync === null) return false;
        try {
            const mark = this.sync.ingestWatermark(legacy.id);
            if (!mark) return false;
            // The pre-transaction probe is an optimization (skip building a
            // doomed plan); ingestSession re-verifies the boundary inside
            // BEGIN IMMEDIATE, which is the authoritative check.
            const boundary = this.sync.probeIngestBoundary(legacy.id, mark.seq);
            if (!boundary) return false;
            // #3919: the head slot of the trusted prefix rides the same
            // positional assumption as every slot below the boundary — probe
            // its stored identity too so prefix rewrites fail the delta NOW
            // instead of waiting for the sampled verify. trustedLen === 1:
            // the head IS the boundary slot, already probed above. A MISSING
            // row means a dangling pointer — refuse, never trust.
            let head: { msgId: string } | undefined;
            if (mark.tailSeqs.length > 1) {
                const headMsgId = this.sync.headRowMsgId(legacy.id, mark.tailSeqs[0]);
                if (headMsgId === null) return false;
                head = { msgId: headMsgId };
            }
            const plan = planIngestDelta(legacy, mark.seq, mark.tailSeqs, { msgId: boundary.msgId, contentHash: boundary.contentHash }, hasRawTail, head);
            if (!plan) return false;
            const applied = this.sync.ingestSession(plan, {
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
        if (this.sync === null) return null;
        if (this.stats.disabled) return null;
        try {
            const sessionRow = this.sync.getSessionRow(id);
            if (!sessionRow) return null;
            const rows = {
                session: sessionRow,
                messages: this.sync.getMessages(id),
                blocks: this.sync.getBlocks(id),
                deadRefs: this.sync.getDeadRefs(id),
                refs: this.sync.getRefs(id),
            };
            // The view's `state` object carries every MERGE_STATE_FIELDS key by
            // construction; the declared Record<string, unknown> just needs a
            // widening cast to reach LegacySessionLike.
            const unified = loadLegacyView(rows) as LegacySessionLike;
            warnTailGaps(id, unified as unknown as { tailGaps?: number });
            return unified;
        } catch (err) {
            loggerLog("warn", `[storage] unified load failed for ${id} (${String(err)}) — falling back to the legacy file`);
            return null;
        }
    }

    /** #4323: true once this session's drift escalated and no clean sample
     *  has since re-admitted it. Sqlite lanes only — network backends keep
     *  the envelope as their sync read path, where freezing would strand
     *  the session. persist.ts consults this on every save route. */
    envelopeFrozen(id: string): boolean {
        return this.sync !== null && this.frozenEnvelopeIds.has(id);
    }

    /** #4323: active block rows the unified store holds for `id` — null when
     *  the sqlite fast lane is unavailable; callers must not guess from null. */
    activeBlockCount(id: string): number | null {
        if (this.sync === null) return null;
        if (this.stats.disabled) return null;
        try {
            return this.sync.getBlocks(id).filter((b) => b.active).length;
        } catch {
            return null;
        }
    }

    /** Organic import (full mode): ingest a legacy record the index has not
     *  seen so future loads serve from the unified store. Never throws. */
    importRecord(record: unknown): LegacySessionLike | null {
        if (this.sync === null) return null;
        if (this.stats.disabled) return null;
        try {
            const legacy = this.legacyLoad(record);
            if (!legacy) return null;
            // #3818: same orphan-contents guard as record() — a record the
            // index cannot represent faithfully must not be served from a
            // viewFor rebuild; callers fall back to the envelope itself.
            // #4216/#4242: orphan shape is representable (journal rides the
            // plan) — import normally instead of rejecting.
            this.sync.ingestSession(planIngest(legacy));
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
        if (this.sync === null) return;
        this.ingestCounts.delete(id);
        this.driftStreaks.delete(id);
        this.frozenEnvelopeIds.delete(id);
        if (this.stats.disabled) return;
        try {
            this.sync.deleteSession(id);
        } catch (err) {
            loggerLog("warn", `[storage] unified remove failed for ${id} (${String(err)})`);
        }
    }

    // ---- Phase 2 checkpoints/replicas (#2671) -------------------------------
    // Thin pass-throughs so callers never touch the raw UnifiedStore. All
    // throw (never log-and-swallow): replica management is an explicit
    // operator action, unlike the never-throw shadow mirrors above.

    createCheckpoint(cp: Parameters<UnifiedStore["insertCheckpoint"]>[0]): void {
        if (this.sync === null) throw new Error('[storage] sync checkpoint API unavailable on a network backend — use the async twin');
        this.assertLive();
        this.sync.insertCheckpoint(cp);
    }

    listCheckpoints(sessionId?: string): CheckpointRow[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.listCheckpoints(sessionId);
    }

    getCheckpoint(cpId: string): CheckpointRow | undefined {
        if (this.sync === null) return undefined;
        this.assertLive();
        return this.sync.getCheckpoint(cpId);
    }

    checkpointState(cpId: string): { stateJson: string; byteLen: number } {
        if (this.sync === null) throw new Error('[storage] sync checkpoint API unavailable on a network backend — use the async twin');
        this.assertLive();
        return this.sync.checkpointState(cpId);
    }

    deleteCheckpoint(cpId: string): boolean {
        if (this.sync === null) return false;
        this.assertLive();
        return this.sync.deleteCheckpoint(cpId);
    }

    /** Ingest freshness watermark for load-side import gating (null = never
     *  ingested). See SessionStore.buildForLoadAll for the race this guards. */
    sessionUpdatedAt(sessionId: string): number | null {
        if (this.sync === null) return null;
        this.assertLive();
        return this.sync.sessionUpdatedAt(sessionId);
    }

    /** Absolute-seq tip of the session's message log (+1 = next free seq).
     *  Used as a checkpoint's seq_at. */
    sessionTipSeq(sessionId: string): number {
        if (this.sync === null) return 0;
        this.assertLive();
        let tip = 0;
        for (const m of this.sync.getMessages(sessionId)) if (m.seq + 1 > tip) tip = m.seq + 1;
        return tip;
    }

    /** #3301: message rows for specific ids (+ seq±1 neighbors) — stored
     *  decompositions for fold-anchor backfill after a wire-shape flip. */
    messagesForIds(sessionId: string, msgIds: readonly string[], includeNeighbors: boolean): { seq: number; msgId: string; content: string }[] {
        this.assertLive();
        if (!this.sync) return []; // network backends cannot serve the sync decomposition lookup (#3931 architecture)
        return this.sync.messagesForIds(sessionId, msgIds, includeNeighbors);
    }

    /** All sessions row ids present in the index (#2960 R2.1). Used by the
     *  full-mode boot union so rows whose legacy file disappeared remain
     *  enumerable. */
    listSessionIds(): string[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.listSessionIds();
    }

    /** Identity lookup passthrough (#2960 R2.1). */
    lookupConversation(namespace: string, conversationId: string): string | null {
        if (this.sync === null) return null;
        this.assertLive();
        return this.sync.lookupConversation(namespace, conversationId);
    }

    /** #3049: O(1) counter probe backing the persist stale-guard fast path.
     *  Safe on a disabled sidecar? NO — call sites must check stats first
     *  (this throws like every other pass-through; the guard treats any
     *  failure as "no fast path" and falls back to the full envelope read). */
    sessionCounters(sessionId: string): { requests: number; nextBlockId: number } | null {
        if (this.sync === null) return null;
        this.assertLive();
        return this.sync.sessionCounters(sessionId);
    }

    listConversationBindings(namespace?: string): { namespace: string; conversationId: string; sessionId: string; claimedAt: number }[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.listConversationBindings(namespace);
    }

    /** Summary fast-path rows (#2960 R2.1): export/web lists serve from one
     *  SQL instead of walking + parsing every legacy file. */
    /** #3248: raw canonical rows for the incremental lane (core-form
     *  message JSON in seq order — exactly what planIngest interned). */
    /** #3901/#3463: pass-through GC + restore (see UnifiedStore.gc). */
    /** #4175: online consistent snapshot (sqlite only — VACUUM INTO). */
    backupInto(dstPath: string): number {
        if (this.sync === null) throw new Error("backup is a sqlite-store operation (VACUUM INTO)");
        return this.sync.backupInto(dstPath);
    }

    gc(opts: { archiveAfterDays: number; archiveDir: string; vacuum?: "full" | "incremental" }): { archived: number; contentRowsDeleted: number } {
        if (this.sync === null) return { archived: 0, contentRowsDeleted: 0 };
        return this.sync.gc(opts);
    }

    restoreArchived(sessionId: string, opts: { archiveDir: string }): { ok: boolean; reason?: string } {
        if (this.sync === null) return { ok: false, reason: 'async backend — use restoreArchivedAsync' };
        return this.sync.restoreArchived(sessionId, opts);
    }

    /** #3928: pass-through single-session archive / footprint / shrink
     *  (see UnifiedStore equivalents) for the CLI maintenance surface.
     *  Network backends (#3931 step 3) have no sync store — degrade like
     *  the neighboring sync facades. */
    archiveSession(sessionId: string, opts: { archiveDir: string }): { ok: boolean; exportPath?: string; reason?: string; contentRowsDeleted?: number } {
        if (this.sync === null) return { ok: false, reason: "async backend — single-session archive unavailable" };
        return this.sync.archiveSession(sessionId, opts);
    }

    sessionStorageStats(sessionId: string): import("./store.ts").SessionStorageStats | null {
        if (this.sync === null) return null;
        return this.sync.sessionStorageStats(sessionId);
    }

    vacuum(mode: "full" | "incremental"): void {
        if (this.sync === null) throw new Error("[storage] sync vacuum unavailable on a network backend");
        return this.sync.vacuum(mode);
    }

    gcPlan(archiveAfterDays: number, now?: number): import("./store.ts").GcPlan | null {
        if (this.sync === null) return null;
        return this.sync.gcPlan(archiveAfterDays, now);
    }

    rawMessages(sessionId: string): { seq: number; content: string }[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.getMessages(sessionId).map((m) => ({ seq: m.seq, content: m.content }));
    }

    /** #3756 snapshot render: the logical view's seq pointer list
     *  (tail_json.tailSeqs). Null when absent/malformed. */
    tailSeqs(sessionId: string): number[] | null {
        if (this.sync === null) return null;
        this.assertLive();
        return this.sync.tailSeqs(sessionId);
    }

    /** #3756 snapshot render: full row view (id/ref/hash included) of the
     *  unified transcript in seq order — the render source for the outbound
     *  prefix. Same rows as rawMessages, plus the identity columns the
     *  coverage matcher needs (msgId for fast path, ref for the
     *  upgrade-tolerant interval path, contentHash for the exact-content
     *  dedup path). */
    /** #D5-5: identity-only rows (no content bytes) for the render lane. */
    messageIdRows(sessionId: string): { seq: number; msgId: string }[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.messageIdRows(sessionId);
    }

    /** #D5-5: content rows outside the covered intervals only. */
    uncoveredRows(sessionId: string, intervals: readonly [number, number][]): (MessageRow & { contentHash: string })[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.uncoveredRows(sessionId, intervals);
    }

    tailViewRows(sessionId: string): MessageRow[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.getMessages(sessionId);
    }

    /** #4738: per-ref stored message bodies (sync store only, like
     *  tailViewRows) — the web preview fallback when host-side native
     *  compaction pruned the resident window. */
    messageContentByRefNums(sessionId: string, refNums: readonly number[]): MessageRefContentRow[] {
        if (this.sync === null || refNums.length === 0) return [];
        this.assertLive();
        return this.sync.messageContentByRefNums(sessionId, refNums);
    }

    sessionSummaries(): SessionSummaryRow[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.sessionSummaries();
    }

    /** #2960 ③: whole-store CCR read from the sessions row's ccr mirror. */
    getCcr(sessionId: string): MessageContentStore | null {
        if (this.sync === null) return null;
        this.assertLive();
        return this.sync.getCcr(sessionId);
    }

    /** #4316 PR3/3: raw id → canonical seq (single-row ids only) for the
     *  one-time ledger re-stamp. Shadow mode's index may lag files it has
     *  not re-recorded, so like getCcr this is full-trust only: sync store
     *  or nothing — a stale map would re-bind citations wrongly. */
    seqByRaw(sessionId: string): Map<string, number> | null {
        if (this.sync === null) return null;
        this.assertLive();
        return this.sync.seqByRaw(sessionId);
    }

    /** #4316 PR3/3: live (non-retired) message row count. */
    liveRowCount(sessionId: string): number {
        this.assertLive();
        if (this.sync !== null) return this.sync.liveRowCount(sessionId);
        return -1;
    }

    /** #4730: highest live seq — the fork endpoint's inclusive throughSeq
     *  (NOT count - 1: tombstones keep their seq). Null when the unified
     *  store is unavailable or the session has no live rows. */
    lastLiveSeq(sessionId: string): number | null {
        if (this.sync === null) return null;
        this.assertLive();
        return this.sync.lastLiveSeq(sessionId);
    }

    /** #4316 PR3/3: fork adoption row clone. Works in shadow AND full —
     *  cloning parent rows the shadow has already mirrored keeps the child
     *  view self-consistent in both modes; a parent with no rows (never
     *  mirrored) clones nothing and the fork proceeds kernel-only. */
    cloneSessionRows(parentId: string, childId: string, throughSeq: number): boolean {
        this.assertLive();
        if (this.sync !== null) {
            this.sync.cloneSessionRows(parentId, childId, throughSeq);
            return true;
        }
        return false;
    }

    /** #2960 R2.2: web list rows (stats/metadata JSON + block aggregates). */
    webSummaryRows(): WebSummaryRow[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.webSummaryRows();
    }

    // ------------------------------------------------------------------
    // Extension namespaces (#3069 v4): thin passthroughs. Works in shadow
    // AND full mode — extension state is side-table substrate (like
    // checkpoints), not part of the legacy load path.
    // ------------------------------------------------------------------

    setSessionExt(sessionId: string, key: string, value: unknown): void {
        if (this.sync === null) return;
        this.assertLive();
        this.sync.setSessionExt(sessionId, key, value);
    }

    getSessionExt(sessionId: string, key: string): unknown {
        if (this.sync === null) return null;
        this.assertLive();
        return this.sync.getSessionExt(sessionId, key);
    }

    listSessionExt(sessionId: string): { key: string; value: unknown; updatedAt: number }[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.listSessionExt(sessionId);
    }

    deleteSessionExt(sessionId: string, key?: string): number {
        if (this.sync === null) return 0;
        this.assertLive();
        return this.sync.deleteSessionExt(sessionId, key);
    }

    setKv(namespace: string, key: string, value: unknown): void {
        if (this.sync === null) return;
        this.assertLive();
        this.sync.setKv(namespace, key, value);
    }

    getKv(namespace: string, key: string): unknown {
        if (this.sync === null) return null;
        this.assertLive();
        return this.sync.getKv(namespace, key);
    }

    listKv(namespace?: string, keyPrefix?: string): { namespace: string; key: string; value: unknown; updatedAt: number }[] {
        if (this.sync === null) return [];
        this.assertLive();
        return this.sync.listKv(namespace, keyPrefix);
    }

    deleteKv(namespace: string, key?: string): number {
        if (this.sync === null) return 0;
        this.assertLive();
        return this.sync.deleteKv(namespace, key);
    }

    // ---- #3931 step 3: async facade (network backends) ----------------------
    // On sqlite every twin delegates to the sync method above (zero behavior
    // change). On mysql the sync facades MISS by design (callers fall back to
    // JSON envelopes exactly as they do when no sidecar opened) and these
    // twins carry the traffic through the async StorageBackend contract.

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const backend = this.backend;
        if (!backend) return Promise.reject(new Error("[storage] async shadow work without a backend"));
        const next = this.queueTail.then(work, work);
        this.queueTail = next.then(() => undefined, () => undefined);
        return next;
    }

    /** record()'s async port — MUST stay in lockstep with the sync body
     *  above (orphan guard + #3841 reap journal, #3133 watermark delta,
     *  full ingest, #3133 sampled verify + drift latch). Serialized by the
     *  shadow queue; failures feed the same 3-strike disable. */
    private enqueueAsyncRecord(record: unknown, rawTail?: { lastMessages: CoreMessage[]; lastMessagesFolded?: boolean }, liveCcr?: MessageContentStore): void {
        void this.enqueue(async () => {
            if (this.stats.disabled) return;
            try {
                const backend = this.backend!;
                const loaded0 = this.legacyLoad(record);
                if (!loaded0) return;
                let legacy = loaded0;
                let hasRawTail = false;
                if (rawTail && rawTail.lastMessages.length > 0) {
                    hasRawTail = true;
                    legacy = { ...legacy, lastMessages: rawTail.lastMessages, lastMessagesFolded: rawTail.lastMessagesFolded === true };
                }
                if (liveCcr) legacy = { ...legacy, contentStore: liveCcr };
                // #3818/#3841: same orphan-guard + reap-journal semantics.
                // #4216/#4242: orphan shape rides the plan journal — normal
                // ingest (the async twin of the sync fix); no freeze.
                // #3133 watermark delta.
                let applied = false;
                try {
                    const mark = await backend.ingestWatermark(legacy.id);
                    if (mark) {
                        const boundary = await backend.probeIngestBoundary(legacy.id, mark.seq);
                        if (boundary) {
                            const plan = planIngestDelta(legacy, mark.seq, mark.tailSeqs, { msgId: boundary.msgId, contentHash: boundary.contentHash }, hasRawTail);
                            if (plan) {
                                applied = await backend.ingestSession(plan, { trustedSeq: mark.seq, boundaryMsgId: boundary.msgId, boundaryHash: boundary.contentHash, trustedTailSeqs: mark.tailSeqs });
                                if (applied) this.stats.deltaIngests++;
                            }
                        }
                    }
                } catch {
                    applied = false;
                }
                if (!applied) await backend.ingestSession(planIngest(legacy), undefined, { completeLog: hasRawTail });
                this.stats.ingests++;
                const count = (this.ingestCounts.get(legacy.id) ?? 0) + 1;
                this.ingestCounts.set(legacy.id, count);
                if ((count - 1) % VERIFY_EVERY_INGESTS === 0) {
                    this.stats.verifySamples++;
                    const sessionRow = await backend.getSessionRow(legacy.id);
                    if (!sessionRow) throw new Error(`session row missing after ingest: ${legacy.id}`);
                    const rows = {
                        session: sessionRow,
                        messages: await backend.getMessages(legacy.id),
                        blocks: await backend.getBlocks(legacy.id),
                        deadRefs: await backend.getDeadRefs(legacy.id),
                        refs: await backend.getRefs(legacy.id),
                    };
                    const loaded = loadLegacyView(rows);
                    const expect = shadowDigest({ ...legacy, blockContents: orderedBlockContents(completeBlockContents(legacy.blockContents, legacy.state.blocks)) });
                    const got = shadowDigest({ ...loaded, blockContents: orderedBlockContents(loaded.blockContents) });
                    if (got !== expect) {
                        this.stats.verifyDrift++;
                        this.driftedSessions.add(legacy.id);
                        this.stats.lastError = `digest drift for ${legacy.id}: unified replay != legacy load view`;
                        await backend.clearIngestWatermark(legacy.id);
                        loggerLog("error", `[storage] unified shadow DIGEST DRIFT for ${legacy.id}: unified replay != legacy load view — dropped the ingest watermark, the next save re-ingests the full tail`);
                    } else {
                        this.stats.verifyOk++;
                        this.driftedSessions.delete(legacy.id);
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
        });
    }

    private viaAsync<T>(miss: T, syncValue: () => T, via: () => Promise<T>): Promise<T> {
        return this.sync === null ? via() : Promise.resolve(syncValue());
    }

    viewForAsync(id: string): Promise<LegacySessionLike | null> {
        return this.viaAsync(null, () => this.viewFor(id), async () => {
            if (this.stats.disabled) return null;
            try {
                const backend = this.backend!;
                const sessionRow = await backend.getSessionRow(id);
                if (!sessionRow) return null;
                const loaded = loadLegacyView({
                    session: sessionRow,
                    messages: await backend.getMessages(id),
                    blocks: await backend.getBlocks(id),
                    deadRefs: await backend.getDeadRefs(id),
                    refs: await backend.getRefs(id),
                }) as LegacySessionLike;
                warnTailGaps(id, loaded as unknown as { tailGaps?: number });
                return loaded;
            } catch (err) {
                loggerLog("warn", `[storage] unified load failed for ${id} (${String(err)}) — falling back to the legacy file`);
                return null;
            }
        });
    }

    importRecordAsync(record: unknown): Promise<LegacySessionLike | null> {
        return this.viaAsync(null, () => this.importRecord(record), async () => {
            if (this.stats.disabled) return null;
            try {
                const legacy = this.legacyLoad(record);
                if (!legacy) return null;
                // #4216/#4242: orphan shape rides the plan journal — import normally.
                await this.enqueue(() => this.backend!.ingestSession(planIngest(legacy)));
                this.stats.imports++;
                loggerLog("info", `[storage] unified import on first open: ${legacy.id}`);
                return legacy;
            } catch (err) {
                loggerLog("warn", `[storage] unified import failed for a legacy record (${String(err)}) — serving the legacy view`);
                return null;
            }
        });
    }

    removeAsync(id: string): Promise<void> {
        return this.viaAsync(undefined, () => this.remove(id), () => this.enqueue(() => this.backend!.deleteSession(id)).then(() => undefined));
    }

    listSessionIdsAsync(): Promise<string[]> {
        return this.viaAsync([], () => this.listSessionIds(), () => this.backend!.listSessionIds());
    }

    sessionSummariesAsync(): Promise<SessionSummaryRow[]> {
        return this.viaAsync([], () => this.sessionSummaries(), () => this.backend!.sessionSummaries());
    }

    webSummaryRowsAsync(): Promise<WebSummaryRow[]> {
        return this.viaAsync([], () => this.webSummaryRows(), () => this.backend!.webSummaryRows());
    }

    lookupConversationAsync(namespace: string, conversationId: string): Promise<string | null> {
        return this.viaAsync(null, () => this.lookupConversation(namespace, conversationId), () => this.backend!.lookupConversation(namespace, conversationId));
    }

    listConversationBindingsAsync(namespace?: string): Promise<{ namespace: string; conversationId: string; sessionId: string; claimedAt: number }[]> {
        return this.viaAsync([], () => this.listConversationBindings(namespace), () => this.backend!.listConversationBindings(namespace));
    }

    sessionCountersAsync(sessionId: string): Promise<{ requests: number; nextBlockId: number } | null> {
        return this.viaAsync(null, () => this.sessionCounters(sessionId), () => this.backend!.sessionCounters(sessionId));
    }

    sessionUpdatedAtAsync(sessionId: string): Promise<number | null> {
        return this.viaAsync(null, () => this.sessionUpdatedAt(sessionId), () => this.backend!.sessionUpdatedAt(sessionId));
    }

    sessionTipSeqAsync(sessionId: string): Promise<number> {
        return this.viaAsync(0, () => this.sessionTipSeq(sessionId), async () => {
            let tip = 0;
            for (const m of await this.backend!.getMessages(sessionId)) if (m.seq + 1 > tip) tip = m.seq + 1;
            return tip;
        });
    }

    insertCheckpointAsync(cp: Parameters<UnifiedStore["insertCheckpoint"]>[0]): Promise<void> {
        return this.viaAsync(undefined, () => this.createCheckpoint(cp), () => this.enqueue(() => this.backend!.insertCheckpoint(cp)).then(() => undefined));
    }

    listCheckpointsAsync(sessionId?: string): Promise<CheckpointRow[]> {
        return this.viaAsync([], () => this.listCheckpoints(sessionId), () => this.backend!.listCheckpoints(sessionId));
    }

    getCheckpointAsync(cpId: string): Promise<CheckpointRow | undefined> {
        return this.viaAsync(undefined, () => this.getCheckpoint(cpId), () => this.backend!.getCheckpoint(cpId));
    }

    checkpointStateAsync(cpId: string): Promise<{ stateJson: string; byteLen: number }> {
        return this.viaAsync({ stateJson: "", byteLen: 0 }, () => this.checkpointState(cpId), () => this.backend!.checkpointState(cpId));
    }

    deleteCheckpointAsync(cpId: string): Promise<boolean> {
        return this.viaAsync(false, () => this.deleteCheckpoint(cpId), () => this.backend!.deleteCheckpoint(cpId));
    }

    gcAsync(opts: { archiveAfterDays: number; archiveDir: string; vacuum?: "full" | "incremental" }): Promise<{ archived: number; contentRowsDeleted: number }> {
        return this.viaAsync({ archived: 0, contentRowsDeleted: 0 }, () => this.gc(opts), () => this.enqueue(() => this.backend!.gc(opts)));
    }

    restoreArchivedAsync(sessionId: string, opts: { archiveDir: string }): Promise<{ ok: boolean; reason?: string }> {
        return this.viaAsync({ ok: false, reason: "async backend" }, () => this.restoreArchived(sessionId, opts), () => this.enqueue(() => this.backend!.restoreArchived(sessionId, opts)));
    }

    rawMessagesAsync(sessionId: string): Promise<{ seq: number; content: string }[]> {
        return this.viaAsync([], () => this.rawMessages(sessionId), async () => (await this.backend!.getMessages(sessionId)).map((m) => ({ seq: m.seq, content: m.content })));
    }

    tailSeqsAsync(sessionId: string): Promise<number[] | null> {
        return this.viaAsync(null, () => this.tailSeqs(sessionId), () => this.backend!.tailSeqs(sessionId));
    }

    tailViewRowsAsync(sessionId: string): Promise<MessageRow[]> {
        return this.viaAsync([], () => this.tailViewRows(sessionId), () => this.backend!.getMessages(sessionId));
    }

    getCcrAsync(sessionId: string): Promise<MessageContentStore | null> {
        return this.viaAsync(null, () => this.getCcr(sessionId), () => this.backend!.getCcr(sessionId));
    }

    setSessionExtAsync(sessionId: string, key: string, value: unknown): Promise<void> {
        return this.viaAsync(undefined, () => this.setSessionExt(sessionId, key, value), () => this.enqueue(() => this.backend!.setSessionExt(sessionId, key, value)).then(() => undefined));
    }

    getSessionExtAsync(sessionId: string, key: string): Promise<unknown> {
        return this.viaAsync(null, () => this.getSessionExt(sessionId, key), () => this.backend!.getSessionExt(sessionId, key));
    }

    listSessionExtAsync(sessionId: string): Promise<{ key: string; value: unknown; updatedAt: number }[]> {
        return this.viaAsync([], () => this.listSessionExt(sessionId), () => this.backend!.listSessionExt(sessionId));
    }

    deleteSessionExtAsync(sessionId: string, key?: string): Promise<number> {
        return this.viaAsync(0, () => this.deleteSessionExt(sessionId, key), () => this.backend!.deleteSessionExt(sessionId, key));
    }

    setKvAsync(namespace: string, key: string, value: unknown): Promise<void> {
        return this.viaAsync(undefined, () => this.setKv(namespace, key, value), () => this.enqueue(() => this.backend!.setKv(namespace, key, value)).then(() => undefined));
    }

    getKvAsync(namespace: string, key: string): Promise<unknown> {
        return this.viaAsync(null, () => this.getKv(namespace, key), () => this.backend!.getKv(namespace, key));
    }

    listKvAsync(namespace?: string, keyPrefix?: string): Promise<{ namespace: string; key: string; value: unknown; updatedAt: number }[]> {
        return this.viaAsync([], () => this.listKv(namespace, keyPrefix), () => this.backend!.listKv(namespace, keyPrefix));
    }

    deleteKvAsync(namespace: string, key?: string): Promise<number> {
        return this.viaAsync(0, () => this.deleteKv(namespace, key), () => this.backend!.deleteKv(namespace, key));
    }

    /** Drains the async record queue, then closes the backend pool. */
    async closeAsync(): Promise<void> {
        if (this.sync !== null) {
            this.close();
            return;
        }
        try {
            await this.queueTail;
        } catch {
            // queue work reports its own failures
        }
        await this.backend?.close();
    }

    private assertLive(): void {
        if (this.stats.disabled) throw new Error("[storage] unified sidecar is disabled (repeated failures) — replica operations are unavailable");
    }

    close(): void {
        if (this.sync === null) return;
        try {
            this.sync.close();
        } catch (err) {
            // shutdown path — never throw, but a swallowed close failure leaves
            // the sqlite handle locked (windows EBUSY on temp-dir teardown); log
            // it so the next CI red names the real culprit.
            loggerLog("warn", `[storage] sidecar sqlite close failed — handle may stay locked: ${String(err)}`);
        }
    }
}

/** #4390: tail/pluginSnapshot pointers whose backing row is gone used to be
 *  silently dropped — the view shrank with no trace (legacy tail 缺行静默
 *  缩水). Make it loud: every load path reports the gap count. */
function warnTailGaps(id: string, view: { tailGaps?: number }): void {
    if ((view.tailGaps ?? 0) > 0) {
        loggerLog("warn", `[storage] ${view.tailGaps} tail pointer(s) for ${id} reference missing rows — view is shorter than the recorded tail (#4390)`);
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

interface DriftSlotFingerprint {
    id: string;
    role: string;
    length: number;
    sha8: string;
}

interface DriftDiagnostics {
    /** Top-level view keys whose canonicalized JSON differs, sorted. */
    keys: string[];
    /** First divergent lastMessages slot (or the length-mismatch index). */
    tailSlot?: { index: number; expect: DriftSlotFingerprint; got: DriftSlotFingerprint };
}

// #3919: which dimensions disagree when the sampled verify detects drift —
// the digest is a single hash and leaves classification to guesswork. Pure;
// runs only on detected drift (rare). Fingerprints carry id/role/length/
// short-hash ONLY — never message body text (the log line goes to disk and
// mirrors publicly).
export function describeViewDivergence(expectView: unknown, gotView: unknown): DriftDiagnostics {
    const e = (expectView ?? {}) as Record<string, unknown>;
    const g = (gotView ?? {}) as Record<string, unknown>;
    const ser = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(canonicalize(v)));
    const keys: string[] = [];
    for (const k of [...new Set([...Object.keys(e), ...Object.keys(g)])].sort()) {
        // tailGaps is read-time diagnostic metadata, not parity surface (#4390) —
        // the live legacy leg structurally lacks the key, so it must never be
        // named as a diverged dimension (a real gap diverges lastMessages itself).
        if (k === "tailGaps") continue;
        if (ser(e[k]) !== ser(g[k])) keys.push(k);
    }
    const diagnostics: DriftDiagnostics = { keys };
    if (keys.includes("lastMessages") && Array.isArray(e["lastMessages"]) && Array.isArray(g["lastMessages"])) {
        const et = e["lastMessages"] as unknown[];
        const gt = g["lastMessages"] as unknown[];
        let index = -1;
        for (let i = 0; i < Math.min(et.length, gt.length); i++) {
            if (ser(et[i]) !== ser(gt[i])) { index = i; break; }
        }
        if (index === -1 && et.length !== gt.length) index = Math.min(et.length, gt.length);
        if (index !== -1) {
            const fp = (m: unknown): DriftSlotFingerprint => {
                if (!m || typeof m !== "object") return { id: "-", role: "-", length: 0, sha8: "-" };
                const s = m as { id?: unknown; role?: unknown };
                const s2 = ser(m) ?? "";
                return { id: typeof s.id === "string" ? s.id : "-", role: typeof s.role === "string" ? s.role : "-", length: s2.length, sha8: sha256(s2).slice(0, 8) };
            };
            diagnostics.tailSlot = { index, expect: fp(index < et.length ? et[index] : null), got: fp(index < gt.length ? gt[index] : null) };
        }
    }
    return diagnostics;
}

/** Compact log-suffix form of describeViewDivergence (""-free: always starts with a space). */
export function formatDriftDiagnostics(d: DriftDiagnostics): string {
    const parts = [`diverged: ${d.keys.length > 0 ? d.keys.join(",") : "<unknown>"}`];
    if (d.tailSlot) {
        const { index, expect: ex, got: go } = d.tailSlot;
        parts.push(`tail slot ${index}: expect ${ex.id}/${ex.role} len=${ex.length} sha=${ex.sha8}, got ${go.id}/${go.role} len=${go.length} sha=${go.sha8}`);
    }
    return " [" + parts.join("; ") + "]";
}
