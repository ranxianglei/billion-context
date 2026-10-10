/**
 * Shadow/dry-run writer for the unified storage layer (#2671 Phase 1).
 *
 * OPT-IN via BILI_STORAGE_UNIFIED=1/true. While enabled, every session
 * record the legacy SessionStore commits is ALSO ingested into
 * <sessionsDir>/index.db, and the reconstructed view is digest-checked
 * against what the legacy loader (buildSession) would serve after a
 * restart. Any drift is logged as an error — that is the entire point:
 * the unified layer must replay legacy bytes exactly, and production
 * traffic becomes the migration test corpus.
 *
 * Failure policy: shadow problems must NEVER break the legacy write path.
 * All work is try/catch'd; after MAX_CONSECUTIVE_FAILURES consecutive
 * failures the shadow disables itself for the process (warn once).
 */

import { log as loggerLog } from "../logger.js";
import { planIngest, loadLegacyView, type LegacySessionLike } from "./ingest.ts";
import { UnifiedStore } from "./store.ts";
import { canonicalize, sha256 } from "./canonical.ts";

const MAX_CONSECUTIVE_FAILURES = 3;

interface ShadowStats {
    ingests: number;
    verifyOk: number;
    verifyDrift: number;
    disabled: boolean;
    lastError: string | null;
}

export class UnifiedShadow {
    readonly stats: ShadowStats = { ingests: 0, verifyOk: 0, verifyDrift: 0, disabled: false, lastError: null };
    private readonly store: UnifiedStore;
    private readonly legacyLoad: (record: unknown) => LegacySessionLike | null;
    private consecutiveFailures = 0;

    private constructor(store: UnifiedStore, legacyLoad: (record: unknown) => LegacySessionLike | null) {
        this.store = store;
        this.legacyLoad = legacyLoad;
    }

    /** Opens the shadow when the env knob is set; null (no cost) otherwise. */
    static maybeOpen(dir: string, env: NodeJS.ProcessEnv = process.env, legacyLoad?: (record: unknown) => LegacySessionLike | null): UnifiedShadow | null {
        const raw = env.BILI_STORAGE_UNIFIED;
        if (raw !== "1" && raw !== "true") return null;
        const store = UnifiedStore.open(`${dir}/index.db`);
        const shadow = new UnifiedShadow(store, legacyLoad ?? (() => null));
        loggerLog("info", "[storage] unified shadow mode ENABLED (BILI_STORAGE_UNIFIED): every session write is double-ingested into index.db and digest-reconciled");
        return shadow;
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
