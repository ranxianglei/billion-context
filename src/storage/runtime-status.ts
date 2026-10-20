/**
 * Runtime storage status registry (#3040).
 *
 * The unified-store degradation paths (engine ladder exhausted, self-download
 * blocked/corrupt-platform, corrupt index.db guard #2771, 3-strike sidecar
 * disable) are all fail-open by contract (#2825): the proxy keeps running on
 * legacy JSON. That is correct — but until now the condition was only visible
 * as one-time log lines. This module records the runtime facts from their
 * single production seams and derives one structured status that feeds BOTH
 * web surfaces (the #2152 parity discipline: /__bili/status and
 * /__bili/overview share one helper) plus the diagnostics blob builder.
 *
 * Recording seams (each fires exactly once per process in production):
 *   - cli.ts:        recordEngineBootstrap(ensureSqliteEngine outcome)
 *   - shadow.ts:     recordSidecarOpenFailure / recordSidecarInstance
 *                    (inside UnifiedShadow.maybeOpen)
 *   - persist.ts:    recordRequestedMode(mode, encryptionBlocked) — the
 *                    SessionStore constructor is the single mode-resolution
 *                    seam, so it also owns the requested-mode record.
 *
 * The BILI_ENCRYPTION_KEY opt-out is INTENTIONAL legacy-only (index.db would
 * hold cleartext payloads); it is reported as intentionalOptOut and must NOT
 * raise the degraded warning.
 */

import type { BootstrapOutcome, CooldownMarker } from "./engine-bootstrap.js";
import { bootstrapFailureMarkerPath, COOLDOWN_MS, nodeSqliteUpgradeHint, readBootstrapFailureMarker } from "./engine-bootstrap.js";
import { fileStorageAutoDownload, fileStorageJsonWriter, fileStorageUnified, fileStorageWalJournalSizeLimit, resolveStorageMode } from "../knobs.js";
import { MAX_CONSECUTIVE_FAILURES, sqliteOpenFailureHint, type UnifiedShadow } from "./shadow.js";
import type { StorageMode } from "./shadow.js";

interface RuntimeState {
    /** Recorded by the SessionStore constructor; null only before first store build. */
    requested: StorageMode | null;
    encryptionBlocked: boolean;
    /** #3135 ②/#3818: persistence disabled (BILI_PERSIST=0 / enabled:false) — intentional legacy-only, never warns. */
    persistDisabled: boolean;
    sidecar: UnifiedShadow | null;
    sidecarOpenError: string | null;
    bootstrap: BootstrapOutcome | null;
}

function freshState(): RuntimeState {
    return { requested: null, encryptionBlocked: false, persistDisabled: false, sidecar: null, sidecarOpenError: null, bootstrap: null };
}

let state: RuntimeState = freshState();

export function recordEngineBootstrap(outcome: BootstrapOutcome): void {
    state.bootstrap = outcome;
}

export function recordSidecarOpenFailure(error: string): void {
    state.sidecar = null;
    state.sidecarOpenError = error;
}

export function recordSidecarInstance(shadow: UnifiedShadow): void {
    state.sidecar = shadow;
    state.sidecarOpenError = null;
}

export function recordRequestedMode(mode: StorageMode, encryptionBlocked: boolean, persistDisabled = false): void {
    state.requested = mode;
    state.encryptionBlocked = encryptionBlocked;
    state.persistDisabled = persistDisabled;
}

export function _resetStorageRuntimeStatusForTest(): void {
    state = freshState();
    cooldownCache = null;
}

/** Short one-line form of a raw error for interpolation into banner text. */
function shortenError(err: string): string {
    const oneLine = err.replace(/\s+/g, " ").trim();
    return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

function degradeReason(): string {
    const sidecar = state.sidecar;
    if (sidecar && sidecar.stats.disabled) {
        const last = sidecar.stats.lastError ? shortenError(sidecar.stats.lastError) : "unknown";
        return `unified store auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures (last: ${last})`;
    }
    // A too-old Node is refused BEFORE any engine load, so the sidecar open ALSO
    // fails with the generic no-engine error — surface the real floor reason first,
    // or the sidecar-open-error branch below would shadow it (#3894).
    if (state.bootstrap?.status === "unsupported-node") {
        return `self-downloaded SQLite engine requires a newer Node.js (${state.bootstrap.detail ?? "unknown"})`;
    }
    if (state.sidecarOpenError) {
        const e = shortenError(state.sidecarOpenError);
        // The driver's no-engine error surfaces through the same open path —
        // say what it actually is instead of "index database failed to open".
        if (/no SQLite engine available/i.test(e)) {
            return `no SQLite engine available (node:sqlite missing, better-sqlite3 not installed)${nodeSqliteUpgradeHint()}`;
        }
        return `index database failed to open (${e})${sqliteOpenFailureHint(state.sidecarOpenError)}`;
    }
    const b = state.bootstrap;
    if (b) {
        switch (b.status) {
            case "cooldown":
                return `SQLite self-download blocked (${b.detail ?? "unknown"}), retrying after cooldown`;
            case "unsupported-platform":
                return `unsupported platform for SQLite self-download (${b.detail ?? "?"})`;
            case "disabled":
                return "SQLite self-download disabled by configuration";
            case "failed":
                return `SQLite self-download failed (${b.detail ?? "unknown"})`;
            default:
                break;
        }
    }
    return `no SQLite engine available (node:sqlite missing, better-sqlite3 not installed)${nodeSqliteUpgradeHint()}`;
}

const COOLDOWN_CACHE_MS = 30_000;
let cooldownCache: { at: number; marker: CooldownMarker | null } | null = null;

function cooldownState(): { marker: CooldownMarker | null; remainingMs: number | null } {
    const now = Date.now();
    if (cooldownCache && now - cooldownCache.at < COOLDOWN_CACHE_MS) {
        return { marker: cooldownCache.marker, remainingMs: cooldownCache.marker ? Math.max(0, cooldownCache.marker.atMs + COOLDOWN_MS - now) : null };
    }
    const marker = readBootstrapFailureMarker();
    cooldownCache = { at: now, marker };
    return { marker, remainingMs: marker ? Math.max(0, marker.atMs + COOLDOWN_MS - now) : null };
}

interface StorageRuntimeStatus {
    requested: StorageMode;
    effective: "legacy" | "shadow" | "full";
    /** Requested a unified mode but the sidecar is not carrying data. */
    degraded: boolean;
    /** BILI_ENCRYPTION_KEY opt-out or disabled persistence — intentional legacy-only, never warns. */
    intentionalOptOut: boolean;
    /** Human-readable degrade cause (set iff degraded). */
    reason: string | null;
    engine: { name: string; source: string } | null;
    bootstrap: string | null;
    bootstrapFailure: { atMs: number; reason: string } | null;
    cooldownRemainingMs: number | null;
    sidecarDisabled: boolean;
    sidecarLastError: string | null;
    indexDbOpenError: string | null;
    /** #3135 ④/#3818: sampled digest-drift counter (observable, not just logged). */
    verifyDrift: number;
    /** #3135 ④/#3818: sessions currently served from the JSON envelope because the index view drifted. */
    driftedSessions: number;
}

function getStorageRuntimeStatus(): StorageRuntimeStatus {
    // Fallback before the first SessionStore build: full knob resolution
    // (a running server always has a store, so this path is defensive).
    const requested = state.requested ?? resolveStorageMode(process.env, fileStorageUnified());
    // #3135 ②/#3818: both "the user turned this off on purpose" flavors —
    // encryption opt-out and disabled persistence — are intentional and must
    // never surface as a degrade.
    const intentionalOptOut = state.encryptionBlocked || state.persistDisabled;
    const sidecar = state.sidecar;
    const disabled = !!sidecar?.stats.disabled;
    // healthy sidecar ⇒ its mode === requested (maybeOpen opens only under
    // shadow/full); anything else means SQLite carries no data right now.
    const effective: "legacy" | "shadow" | "full" =
        requested !== "legacy" && !intentionalOptOut && sidecar && !disabled ? requested : "legacy";
    const degraded = requested !== "legacy" && !intentionalOptOut && (sidecar === null || disabled);
    const cd = cooldownState();
    return {
        requested,
        effective,
        degraded,
        intentionalOptOut,
        reason: degraded ? degradeReason() : null,
        engine: sidecar ? { name: sidecar.engine, source: sidecar.engineSource } : null,
        bootstrap: state.bootstrap?.status ?? null,
        bootstrapFailure: cd.marker,
        cooldownRemainingMs: cd.remainingMs,
        sidecarDisabled: disabled,
        sidecarLastError: sidecar?.stats.disabled ? sidecar.stats.lastError : null,
        indexDbOpenError: state.sidecarOpenError,
        // #3135 ④/#3818: the sampled digest-drift counter — once the index is
        // the default load path (full), drift must be OBSERVABLE, not just a
        // log line; drifted sessions are served from the JSON envelope
        // (persist.ts loadSync) while the envelope still exists.
        verifyDrift: sidecar?.stats.verifyDrift ?? 0,
        driftedSessions: sidecar?.driftedSessions.size ?? 0,
    };
}

/** Wire payload shared by /__bili/status and /__bili/overview (#2152 parity:
 *  one helper, two surfaces — they can never drift apart again). */
interface StorageStatusWire {
    requested: StorageMode;
    effective: "legacy" | "shadow" | "full";
    degraded: boolean;
    intentionalOptOut: boolean;
    reason: string | null;
    engine: { name: string; source: string } | null;
    bootstrap: string | null;
    bootstrapFailure: { atMs: number; reason: string } | null;
    cooldownRemainingMs: number | null;
    sidecarDisabled: boolean;
    /** #3135 ④/#3818: drift observability on the wire. */
    verifyDrift: number;
    driftedSessions: number;
}

export function storageStatusWire(): StorageStatusWire {
    const st = getStorageRuntimeStatus();
    return {
        requested: st.requested,
        effective: st.effective,
        degraded: st.degraded,
        intentionalOptOut: st.intentionalOptOut,
        reason: st.reason,
        engine: st.engine,
        bootstrap: st.bootstrap,
        bootstrapFailure: st.bootstrapFailure,
        cooldownRemainingMs: st.cooldownRemainingMs,
        sidecarDisabled: st.sidecarDisabled,
        verifyDrift: st.verifyDrift,
        driftedSessions: st.driftedSessions,
    };
}

/** Extra diagnostics-blob lines for the `storage-legacy-only` topic (#3040):
 *  the resolved knob stack (env + file tiers verbatim), ladder outcome,
 *  failure payload, and the recent [storage] log tail supplied by the caller
 *  (kept out of this module so it stays free of logger/session imports). */
export function storageDiagnosticsLines(ctx: { sessions: number; storageLogLines: string[] }): string[] {
    const st = getStorageRuntimeStatus();
    const env = process.env;
    const fileUnified = fileStorageUnified();
    const fileJsonWriter = fileStorageJsonWriter();
    const fileAutoDownload = fileStorageAutoDownload();
    const fileWalLimit = fileStorageWalJournalSizeLimit();
    const lines: string[] = [
        "--- storage ---",
        `requested mode: ${st.requested}`,
        `effective mode: ${st.effective}${st.intentionalOptOut ? " (BILI_ENCRYPTION_KEY opt-out — intentional)" : ""}`,
        ...(st.degraded && st.reason ? [`degrade reason: ${st.reason}`] : []),
        `engine: ${st.engine ? `${st.engine.name}/${st.engine.source}` : "none"}`,
        `engine bootstrap: ${st.bootstrap ?? "not run"}`,
        ...(st.bootstrapFailure ? [
            `bootstrap failure marker: at=${new Date(st.bootstrapFailure.atMs).toISOString()} reason="${st.bootstrapFailure.reason}"${st.cooldownRemainingMs ? ` (cooldown ~${Math.round(st.cooldownRemainingMs / 60_000)}m remaining, until ${new Date(st.bootstrapFailure.atMs + COOLDOWN_MS).toISOString()})` : ""}`,
            `force immediate retry: delete ${bootstrapFailureMarkerPath()} and restart`,
        ] : []),
        `BILI_STORAGE_UNIFIED: ${env.BILI_STORAGE_UNIFIED ?? "(unset)"}`,
        `storage.unified (config file): ${fileUnified ?? "(unset)"}`,
        `BILI_STORAGE_JSON_WRITER: ${env.BILI_STORAGE_JSON_WRITER ?? "(unset)"}`,
        `storage.jsonWriter (config file): ${fileJsonWriter ?? "(unset)"}`,
        `BILI_SQLITE_AUTO_DOWNLOAD: ${env.BILI_SQLITE_AUTO_DOWNLOAD ?? "(unset)"}`,
        `storage.sqliteAutoDownload (config file): ${fileAutoDownload ?? "(unset)"}`,
        `BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES: ${env.BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES ?? "(unset)"}`,
        `storage.walJournalSizeLimitBytes (config file): ${fileWalLimit ?? "(unset)"}`,
        `BILI_ENCRYPTION_KEY set: ${env.BILI_ENCRYPTION_KEY !== undefined && env.BILI_ENCRYPTION_KEY !== "" ? "yes" : "no"}`,
        `sessions on disk: ${ctx.sessions}`,
    ];
    if (ctx.storageLogLines.length > 0) {
        lines.push("last [storage] log lines:");
        lines.push(...ctx.storageLogLines.map((l) => `  ${l}`));
    }
    return lines;
}
