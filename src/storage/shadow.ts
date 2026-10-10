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
import { planIngest, loadLegacyView, type LegacySessionLike } from "./ingest.ts";
import { UnifiedStore } from "./store.ts";
import { canonicalize, sha256 } from "./canonical.ts";

const MAX_CONSECUTIVE_FAILURES = 3;

export type StorageMode = "legacy" | "shadow" | "full";

/** Resolves the unified-storage level from BILI_STORAGE_UNIFIED. */
export function resolveStorageMode(env: NodeJS.ProcessEnv = process.env): StorageMode {
    const raw = env.BILI_STORAGE_UNIFIED?.trim().toLowerCase();
    if (!raw || raw === "0" || raw === "false" || raw === "legacy") return "legacy";
    if (raw === "full" || raw === "unified") return "full";
    if (raw === "1" || raw === "true" || raw === "shadow") return "shadow";
    return "legacy";
}

interface ShadowStats {
    ingests: number;
    verifyOk: number;
    verifyDrift: number;
    imports: number;
    disabled: boolean;
    lastError: string | null;
}

export class UnifiedShadow {
    readonly mode: StorageMode;
    readonly stats: ShadowStats = { ingests: 0, verifyOk: 0, verifyDrift: 0, imports: 0, disabled: false, lastError: null };
    private readonly store: UnifiedStore;
    private readonly legacyLoad: (record: unknown) => LegacySessionLike | null;
    private consecutiveFailures = 0;

    private constructor(mode: StorageMode, store: UnifiedStore, legacyLoad: (record: unknown) => LegacySessionLike | null) {
        this.mode = mode;
        this.store = store;
        this.legacyLoad = legacyLoad;
    }

    /** Opens the sidecar when the env knob asks for one; null (no cost) otherwise. */
    static maybeOpen(
        dir: string,
        env: NodeJS.ProcessEnv = process.env,
        legacyLoad?: (record: unknown) => LegacySessionLike | null,
    ): UnifiedShadow | null {
        const mode = resolveStorageMode(env);
        if (mode === "legacy") return null;
        const store = UnifiedStore.open(`${dir}/index.db`);
        const shadow = new UnifiedShadow(mode, store, legacyLoad ?? (() => null));
        loggerLog(
            "info",
            mode === "full"
                ? "[storage] unified FULL mode ENABLED (BILI_STORAGE_UNIFIED=full): index.db is the load path (unified-first, legacy fallback); legacy files keep being written — unset the env to roll back"
                : "[storage] unified shadow mode ENABLED (BILI_STORAGE_UNIFIED): every session write is double-ingested into index.db and digest-reconciled",
        );
        return shadow;
    }

    /** True when reads should go unified-first (full mode, sidecar healthy). */
    get readsUnified(): boolean {
        return this.mode === "full" && !this.stats.disabled;
    }

    /** Ingest + verify one committed record. Never throws. */
    record(record: unknown): void {
        if (this.stats.disabled) return;
        try {
            const legacy = this.legacyLoad(record);
            if (!legacy) return;
            const plan = planIngest(legacy);
            this.store.ingestSession(plan);
            this.stats.ingests++;
            const sessionRow = this.store.getSessionRow(legacy.id);
            if (!sessionRow) throw new Error(`session row missing after ingest: ${legacy.id}`);
            const rows = {
                session: sessionRow,
                messages: this.store.getMessages(legacy.id),
                blocks: this.store.getBlocks(legacy.id),
                deadRefs: this.store.getDeadRefs(legacy.id),
                refs: this.store.getRefs(legacy.id),
            };
            const expect = shadowDigest(legacy);
            const got = shadowDigest(loadLegacyView(rows));
            if (got !== expect) {
                this.stats.verifyDrift++;
                loggerLog("error", `[storage] unified shadow DIGEST DRIFT for ${legacy.id}: unified replay != legacy load view — migration parity broken, report this`);
            } else {
                this.stats.verifyOk++;
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
        if (this.stats.disabled) return;
        try {
            this.store.deleteSession(id);
        } catch (err) {
            loggerLog("warn", `[storage] unified remove failed for ${id} (${String(err)})`);
        }
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
