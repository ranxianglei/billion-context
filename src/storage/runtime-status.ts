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
import { log as loggerLog } from "../logger.js";
import { safePrefix, safeSuffix } from "../text-safe.js";
import { resolvedSqliteEngineInfo } from "./driver.js";
import { sqliteOpenFailureHint, type UnifiedShadow } from "./shadow.js";
import type { StorageMode } from "./shadow.js";

/** The driver's no-engine error text — one predicate, used wherever the
 *  "is this actually an engine problem?" distinction matters (#5108). */
function isNoEngineError(errStr: string): boolean {
    return /no SQLite engine available/i.test(errStr);
}

interface RuntimeState {
    /** Recorded by the SessionStore constructor; null only before first store build. */
    requested: StorageMode | null;
    encryptionBlocked: boolean;
    /** #3135 ②/#3818: persistence disabled (BILI_PERSIST=0 / enabled:false) — intentional legacy-only, never warns. */
    persistDisabled: boolean;
    sidecar: UnifiedShadow | null;
    sidecarOpenError: string | null;
    bootstrap: BootstrapOutcome | null;
    /** #4175 durability trio facts. integrity/backup are null until the first
     *  store open / backup call; secondProcess is set only while a live
     *  foreign pid holds the db lockfile. */
    integrity: { ok: boolean; checkedAt: number; durationMs: number; detail?: string } | null;
    /** #4175/#3959: live foreign pid holding <db>.lock at open. Self-cleared
     *  at status read once the pid dies (never freezes). #5082: coexistence
     *  on one index.db is the supported topology, ALWAYS informational;
     *  `benign` is kept for wire-shape compat and is always true from the
     *  store path. */
    secondProcess: { pid: number; at: number; lane?: string; instanceId?: string; benign: boolean } | null;
    /** #3923/#3959: latest surfaced split-brain contest (newest wins; cleared
     *  via the ack endpoint, which pins the acknowledged peer servedAt). */
    splitBrain: SplitBrainContestInput | null;
    /** ack guard: "sessionId|peerInstanceId" → acknowledged peer servedAt; a
     *  re-contest at the same/older servedAt stays dismissed, a NEW contest
     *  (newer servedAt) re-surfaces. */
    splitBrainAcks: Map<string, number>;
    backup: { lastPath: string; lastAt: number; lastBytes: number } | null;
}

function freshState(): RuntimeState {
    return { requested: null, encryptionBlocked: false, persistDisabled: false, sidecar: null, sidecarOpenError: null, bootstrap: null, integrity: null, secondProcess: null, splitBrain: null, splitBrainAcks: new Map(), backup: null };
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

/** #4175: quick_check outcome of the latest store open (pass or fail). */
export function recordIntegrityOutcome(dbPath: string, ok: boolean, durationMs: number, detail?: string): void {
    state.integrity = { ok, checkedAt: Date.now(), durationMs, ...(detail === undefined ? {} : { detail: `${dbPath}: ${detail}` }) };
}

/** #4175: a live foreign pid holds <db>.lock. `info` adds the registry facts
 *  (pid/lane naming). #5082: purely informational, never an alarm; the
 *  same-session hazard is reported by the split-brain contest instead. */
export function recordSecondProcessOwner(pid: number, info?: { lane?: string; instanceId?: string; benign: boolean }): void {
    state.secondProcess = { pid, at: Date.now(), benign: false, ...(info ?? {}) };
}

interface SplitBrainIdentity {
    instanceId: string;
    pid: number;
    origin: string;
    /** Undefined for instances/older markers that never declared one. */
    lane?: string;
    version: string;
}

export interface SplitBrainContestInput {
    sessionId: string;
    title?: string;
    self: SplitBrainIdentity;
    peer: SplitBrainIdentity & { servedAt: number };
    at: number;
}

/** #3923/#3959: surface a split-brain contest on the web wire. Suppressed
 *  when this exact contest (peer + servedAt) was already acknowledged. */
export function recordSplitBrainContest(contest: SplitBrainContestInput): void {
    const acked = state.splitBrainAcks.get(`${contest.sessionId}|${contest.peer.instanceId}`);
    if (acked !== undefined && contest.peer.servedAt <= acked) return;
    state.splitBrain = contest;
}

/** Dismiss the surfaced contest for `sessionId` (web ack). Returns false
 *  when nothing matching is surfaced (→ HTTP 400). */
export function ackSplitBrainContest(sessionId: string): boolean {
    const cur = state.splitBrain;
    if (cur === null || cur.sessionId !== sessionId) return false;
    state.splitBrainAcks.set(`${cur.sessionId}|${cur.peer.instanceId}`, cur.peer.servedAt);
    while (state.splitBrainAcks.size > MAX_SPLIT_BRAIN_ACKS) {
        const oldest = state.splitBrainAcks.keys().next().value;
        if (oldest === undefined) break;
        state.splitBrainAcks.delete(oldest);
    }
    state.splitBrain = null;
    return true;
}

const MAX_SPLIT_BRAIN_ACKS = 64;

// #4626: the stored verdict must be a function of CURRENT evidence, not a
// replay of one moment's snapshot — at detection time the restart-handover
// tombstone is seconds fresh, but it must not pin the notice forever. The
// server registers the evidence check (the accused peer's own marker, judged
// by the same "still contests" definition as detection); without a registered
// check the stored entry is replayed as-is (legacy behavior, standalone
// record/ack use). The check is TRI-STATE and fails closed: an unknown result
// (the marker could not be read at status-read time) keeps the notice —
// dropping a real notice on a transient FS error is the wrong direction.
let splitBrainEvidenceCheck: ((contest: SplitBrainContestInput) => boolean | null) | null = null;

export function registerSplitBrainEvidenceCheck(check: ((contest: SplitBrainContestInput) => boolean | null) | null): void {
    splitBrainEvidenceCheck = check;
}

/** #4175: the last successful VACUUM INTO backup. */
export function recordBackupOutcome(lastPath: string, lastBytes: number): void {
    state.backup = { lastPath, lastAt: Date.now(), lastBytes };
}

export function _resetStorageRuntimeStatusForTest(): void {
    state = freshState();
    cooldownCache = null;
    splitBrainEvidenceCheck = null;
}

/** #4175: true when a pid belongs to a live process (EPERM = alive, foreign user). */
function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Short one-line form of a raw error for interpolation into banner text. */
function shortenError(err: string): string {
    const oneLine = err.replace(/\s+/g, " ").trim();
    if (oneLine.length <= 160) return oneLine;
    // #5108/#4816: both ends carry signal — the error class up front, the
    // errno/detail at the end (e.g. "corruption detail: …") — so
    // cut the MIDDLE (usually a long path) instead of the tail. Head-only
    // truncation made the actionable detail invisible on exactly the
    // long-path machines (Windows user profiles) this fix targets.
    return `${safePrefix(oneLine, 78)}…${safeSuffix(oneLine, 78)}`;
}

function degradeReason(): string {
    // No pinned artifact serves this runtime (below every Node floor, or a Node
    // ABI no prebuild targets), so the engine is refused BEFORE any load and the
    // sidecar open ALSO fails with the generic no-engine error — surface the real
    // reason first, or the sidecar-open-error branch below would shadow it (#3894).
    if (state.bootstrap?.status === "unsupported-node") {
        // #4444: the specific coverage detail outranks the generic no-engine reason
        // (#3894), but must still carry the Node.js upgrade lever the sidecar-open
        // branch below carries — an unsupported Node is exactly where it's actionable.
        return `no self-downloaded SQLite engine supports this Node.js (${state.bootstrap.detail ?? "unknown"})${nodeSqliteUpgradeHint()}`;
    }
    if (state.sidecarOpenError) {
        const e = shortenError(state.sidecarOpenError);
        // #5046/B: shadow.ts records second-writer refusals pre-formatted (already names the fix + what's lost) — render verbatim instead of wrapping them as "index database failed to open".
        if (e.startsWith("second-writer:")) return e;
        // The driver's no-engine error surfaces through the same open path —
        // say what it actually is instead of "index database failed to open".
        if (isNoEngineError(e)) {
            return `no SQLite engine available (node:sqlite missing, better-sqlite3 not installed)${nodeSqliteUpgradeHint()}`;
        }
        // #4626-era owner chain (final, 2026-10-30): a provably-corrupt index
        // stays EXACTLY in place (no move, no copy, no rebuild) and bili
        // starts WITHOUT it — envelope-served until an operator repairs the
        // files or moves them aside by hand; the reason carries that fix.
        if (/StorageIntegrityError|integrity quick_check failed/i.test(state.sidecarOpenError)) {
            return `index database failed its integrity check and was left UNTOUCHED (${e}) — bili is starting WITHOUT the index (envelope-served); fix: back up index.db{,-wal,-shm}, move those files aside by hand, start again`;
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
    /** #4175 durability trio. */
    integrity: { ok: boolean; checkedAt: number; durationMs: number; detail?: string } | null;
    secondProcess: { pid: number; at: number; lane?: string; instanceId?: string; benign: boolean } | null;
    splitBrain: SplitBrainContestInput | null;
    backup: { lastPath: string; lastAt: number; lastBytes: number } | null;
    /** #4323: sessions whose JSON-envelope writes this process froze after repeated non-converging drift samples. */
    frozenEnvelopeSessions: number;
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
    // healthy sidecar ⇒ its mode === requested (maybeOpen opens only under
    // shadow/full); anything else means SQLite carries no data right now.
    const effective: "legacy" | "shadow" | "full" =
        requested !== "legacy" && !intentionalOptOut && sidecar ? requested : "legacy";
    const degraded = requested !== "legacy" && !intentionalOptOut && sidecar === null;
    const cd = cooldownState();
    // #3923/#3959: the second-process warning must never freeze — a foreign
    // pid that has since exited is cleared here, at the status read.
    const sp = state.secondProcess;
    if (sp !== null && !pidAlive(sp.pid)) {
        state.secondProcess = null;
        loggerLog("info", `[storage] second-process pid ${sp.pid} has exited — stale warning cleared`);
    }
    // #4626: same never-freeze discipline as above — once the peer PROVABLY
    // stops contesting, the stored verdict clears itself; an unknown verdict
    // (marker unreadable at read time) keeps it.
    const sb = state.splitBrain;
    if (sb !== null && splitBrainEvidenceCheck !== null && splitBrainEvidenceCheck(sb) === false) {
        state.splitBrain = null;
        loggerLog("info", `[split-brain] session ${sb.sessionId} notice cleared — peer ${sb.peer.instanceId} (pid ${sb.peer.pid}) no longer contests it`);
    }
    return {
        requested,
        effective,
        degraded,
        intentionalOptOut,
        reason: degraded ? degradeReason() : null,
        // #5108: an open failure AFTER the engine resolved (corrupt index.db,
        // …) must not report "engine: none" — that misdirected triage toward
        // an engine problem when the engine was fine and the file was not.
        engine: sidecar
            ? sidecar.engineInfo
            : state.sidecarOpenError !== null && !isNoEngineError(state.sidecarOpenError)
                ? resolvedSqliteEngineInfo()
                : null,
        bootstrap: state.bootstrap?.status ?? null,
        bootstrapFailure: cd.marker,
        cooldownRemainingMs: cd.remainingMs,
        // The breaker that used to self-disable the sidecar (3-strike) was
        // removed by owner policy 2026-10-30 — index writes are never
        // abandoned — so this field is permanently false (kept for the
        // pre-existing API shape).
        sidecarDisabled: false,
        sidecarLastError: sidecar?.stats.lastError ?? null,
        indexDbOpenError: state.sidecarOpenError,
        // #3135 ④/#3818: the sampled digest-drift counter — once the index is
        // the default load path (full), drift must be OBSERVABLE, not just a
        // log line; drifted sessions are served from the JSON envelope
        // (persist.ts loadSync) while the envelope still exists.
        verifyDrift: sidecar?.stats.verifyDrift ?? 0,
        driftedSessions: sidecar?.driftedSessions.size ?? 0,
        integrity: state.integrity,
        secondProcess: state.secondProcess,
        splitBrain: state.splitBrain,
        backup: state.backup,
        frozenEnvelopeSessions: sidecar?.frozenEnvelopeIds.size ?? 0,
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
    /** #4175 durability trio. */
    integrity: { ok: boolean; checkedAt: number; durationMs: number; detail?: string } | null;
    secondProcess: { pid: number; at: number; lane?: string; instanceId?: string; benign: boolean } | null;
    /** #3923/#3959: the surfaced split-brain contest, if any (servedAt stripped). */
    splitBrain: { sessionId: string; title?: string; self: SplitBrainIdentity; peer: SplitBrainIdentity; at: number } | null;
    backup: { lastPath: string; lastAt: number; lastBytes: number } | null;
    /** #4323: envelope-write freeze count on the wire. */
    frozenEnvelopeSessions: number;
}

function splitBrainWire(cur: SplitBrainContestInput | null): { sessionId: string; title?: string; self: SplitBrainIdentity; peer: SplitBrainIdentity; at: number } | null {
    if (cur === null) return null;
    const strip = (x: SplitBrainIdentity): SplitBrainIdentity => ({ instanceId: x.instanceId, pid: x.pid, origin: x.origin, version: x.version, lane: x.lane });
    return { sessionId: cur.sessionId, title: cur.title, self: strip(cur.self), peer: strip(cur.peer), at: cur.at };
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
        integrity: st.integrity,
        secondProcess: st.secondProcess,
        splitBrain: splitBrainWire(st.splitBrain),
        backup: st.backup,
        frozenEnvelopeSessions: st.frozenEnvelopeSessions,
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
        `engine: ${st.engine ? `${st.engine.name}/${st.engine.source}${state.sidecarOpenError !== null && !isNoEngineError(state.sidecarOpenError) ? " (resolved, but index.db open failed — see degrade reason)" : ""}` : "none"}`,
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
