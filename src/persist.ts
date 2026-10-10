import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { StateStore, flatFileNameFor, type PersistedEnvelope, type StateStoreCodec } from "acp-kernel/persist";
import { sessionsDir } from "./paths.js";
import {
    persistEnabled as knobPersistEnabled,
    persistZstdEnabled as knobPersistZstdEnabled,
    persistDebounceMs as knobPersistDebounceMs,
    persistTailTokens as knobPersistTailTokens,
    persistEpermAlertThreshold as knobPersistEpermAlertThreshold,
    persistEpermAlertRepeatMs as knobPersistEpermAlertRepeatMs,
} from "./knobs.js";
import { log as loggerLog } from "./logger.js";
import { VERSION } from "./version.js";
import { createStorageCodec, parseEncryptionKey } from "./encrypt.js";
import { PersistEpermAlert } from "./persist-eperm.js";
import { createInitialState, defaultCountTokens, prune, type CompressionState, type CoreMessage, type MessageContentStore } from "acp-kernel";
import { markDirty, scrubTurnSeparatorIds } from "./session.js";
import type { Session, BlockContent, BlockView } from "./session.js";
import type { WireProtocol } from "./util.js";
import { currentContextObservation, CALIBRATION_CLAMP_MAX, CALIBRATION_CLAMP_MIN, CALIBRATION_SAMPLE_MAX, CALIBRATION_SAMPLE_MIN, CALIBRATION_SAMPLE_WINDOW } from "./cache-ledger.js";

/**
 * On-disk persistence for proxy sessions.
 *
 * WHY: proxy sessions previously lived only in process memory. A restart
 * dropped all compression state. For sessions whose raw history has grown
 * past the model's context limit, the client re-sends full history on the
 * next request — without the saved block summaries there is nothing to fold
 * it under, so the model rejects the oversized request and the session hangs
 * permanently. Persisting the CompressionState (and the blockContents
 * originals cache) lets the proxy rebuild the folded view after a restart so
 * the model only ever sees the small compressed context.
 *
 * DESIGN:
 *  - Memory is a bounded cache (MAX_SESSIONS in session.ts). The disk is the
 *    source of truth. Evicting a session from memory flushes it to disk first;
 *    a later miss reloads it. So memory is bounded while ALL sessions persist.
 *  - One JSON file per session, atomic write (temp + rename) — survives a
 *    *process* crash mid-write (rename is atomic on posix; a partial temp is
 *    left behind and discarded on next load by the corrupt-file fallback).
 *    Does NOT survive power loss (no fsync of the directory entry); the
 *    debounced writes keep the on-disk state within ~debounce of in-memory.
 *  - Forward-compat: `mergeState` fills any fields missing on a file written
 *    by an older version, so a schema change never breaks old files.
 *  - Disable with BILI_PERSIST=0 for ephemeral/test runs.
 *  - Storage encoding at rest: via the kernel store's codec hook, every file
 *    is optionally zstd-compressed when BILI_PERSIST_ZSTD=1/true (default
 *    off — plain JSON; #1080, BILIZSTD1 envelope) and, independently,
 *    AES-256-GCM-encrypted when
 *    BILI_ENCRYPTION_KEY (hex/base64, exactly 32 bytes) is set (#708,
 *    BILIENC1 envelope) — the body-mode byte records compression even inside
 *    BILIENC1, so the two stay separately configurable. Legacy plaintext
 *    files are NEVER rewritten at boot (downgrade safety — see
 *    sweepStaleTemps); they convert organically on their next save. Key
 *    material never touches disk or logs.
 *
 * MECHANISM lives in `acp-kernel/persist` (StateStore: atomic write, rename
 * retries, debounce, per-id serialization, corrupt-tolerant load, recursive
 * discovery). This module is POLICY: the record schema (PersistedSession),
 * the namespaced layout (relPathFor), validity (isValidRecord), and legacy
 * adoption for files written by the pre-envelope store.
 *
 * ON-DISK FORMAT (v3+): an envelope `{version, savedAt, id, payload}` where
 * payload is the flat PersistedSession record. Files written by earlier
 * proxy versions (flat record, no envelope) are adopted on load via the
 * kernel's `legacy` hook and re-persisted in envelope form on the next dirty
 * write — old files keep loading, files migrate organically.
 *
 * KNOWN LIMITATIONS:
 *  - No fsync of temp file or directory entry — a power loss can lose the
 *    most recent debounce window. Process crashes (SIGKILL) are safe up to
 *    the last successful write.
 *  - No cross-process lock — two proxy processes sharing BILI_SESSIONS_DIR
 *    race on every write. The #405 monotonic-counter guard refuses to roll
 *    the disk record back, and since #2401 the stale resident additionally
 *    converges its in-memory state to the newer disk record at save time, so
 *    serving tracks the newest lineage within one debounce window instead of
 *    staying stale until restart. Residual: a lagging instance whose counters
 *    later CATCH UP numerically is judged fresh again and may re-clobber —
 *    true multi-writer coherence would need an election/lock, which this
 *    design deliberately does not attempt. Recommendation: one state dir =
 *    one live serving instance; restart the proxy on upgrade before resuming
 *    sessions.
 *  - All writes within a process are serialized per-session by the kernel
 *    store's write chains; there is no per-session *request* serialization
 *    (two concurrent HTTP requests for the same session can interleave
 *    processTurn and corrupt in-memory state). This is a known limitation; a
 *    per-session lock should be added before promoting multi-agent
 *    concurrency as safe.
 */

const PERSIST_VERSION = 3;
/** Dotfile (invisible to the kernel's .json walk): written after the first
 *  successful #286 migration pass so later boots skip the scan entirely. */
const MIGRATION_MARKER = ".bili-migration-286.done";

const STALE_WARN_THROTTLE_MS = 60_000;

interface PersistedSession {
    version: number;
    savedAt: number;
    id: string;
    /** Identity / descriptive metadata (v2+). Absent on v1 files; read via the
     *  flat fallbacks below. */
    meta?: {
        protocol?: WireProtocol;
        upstreamOrigin?: string;
        label?: string;
        title?: string;
        activePack?: string;
        hostTitle?: string;
    };
    /** Cumulative usage stats (v2+). Absent on v1 files; read via the flat
     *  fallbacks below. */
    stats?: {
        requests?: number;
        tokensSaved?: number;
        inputTokens?: number;
        cachedTokens?: number;
        outputTokens?: number;
        cacheSamples?: number;
        lastInputTokens?: number;
        lastInputTokensSource?: string;
        lastInputTokensOrigin?: string;
        overflowArmTokens?: number;
        contextTokens?: number;
        contextTokensSource?: string;
        // #2129: measurement-state fields buildRecord persists via spread —
        // declared here so the on-disk schema documents what the loader must
        // restore (the five decision-grade ones below plus the in-memory-only
        // pendingFoldUsage / lastLocalTextEstimate(+Origin), which ride along
        // but are deliberately not restored — see buildSession).
        localInputEstimate?: number;
        lastUsageGradeTokens?: number;
        calibratedEstimate?: number;
        calibratedEstimateOrigin?: string;
        calibrationRing?: { origin: string; values: number[] };
        pendingFoldUsage?: boolean;
        lastLocalTextEstimate?: number;
        lastLocalTextEstimateOrigin?: string;
        retrieveCalls?: number;
        retrieveHits?: number;
        retrieveMisses?: number;
        retrieveDropped?: number;
        retrieveDelivered?: number;
        storedBytes?: number;
        storeBytesSaved?: number;
        imageShrunkCount?: number;
        imageBytesSaved?: number;
        imageTokensSaved?: number;
        imageFullCalls?: number;
        imageFullRestores?: number;
        rangeRestores?: number;
        wholeBlockRestores?: number;
        wholeBlockRestoresPreciseAvailable?: number;
    };
    /** Free-form escape hatch (v2+). */
    metadata?: Record<string, unknown>;
    createdAt: number;
    // Legacy flat fields (v1). Kept optional only so buildSession can read
    // older files; v2 records emit grouped meta/stats instead.
    protocol?: WireProtocol;
    upstreamOrigin?: string;
    label?: string;
    requests?: number;
    tokensSaved?: number;
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    cacheSamples?: number;
    lastInputTokens?: number;
    contextTokens?: number;
    state: CompressionState;
    /** blockContents serialized as a plain record (Maps do not survive JSON). */
    blockContents: Record<string, BlockContent>;
    /** Latest folded-view conversation snapshot (v3+): prune() rendered
     *  summaries in place of folded ranges, then truncated to the newest
     *  BILI_PERSIST_TAIL_TOKENS tokens (#401) — the raw full history is NOT
     *  persisted (it duplicated 63% of the corpus; originals of folded
     *  ranges remain available offline via blockContents). Absent on v2
     *  files and when the tail budget is 0 — export falls back to
     *  block-only rendering. */
    messages?: CoreMessage[];
    /** True when `messages` is an already-pruned folded snapshot (see above);
     *  absent on records written before #401, whose `messages` held the raw
     *  history and must still be pruned at export time. */
    messagesFolded?: boolean;
    pluginSnapshot?: CoreMessage[];
    forkContentStore?: MessageContentStore;
}

type Logger = (level: "info" | "warn" | "error", msg: string) => void;

/** Forward-compat: merge a parsed state with a fresh one so missing fields
 * (added in later versions) get sane defaults instead of `undefined`. */
function mergeState(parsed: CompressionState): CompressionState {
    const fresh = createInitialState();
    return {
        // #2627: heal persisted state written before the turn-separator fix —
        // those blocks' coverage carries outbound-only acp_turn_sep_* ids that
        // no resent history can ever contain; scrubbing at hydration is what
        // stops live long sessions from alarming forever after an upgrade.
        blocks: (() => { const blocks = parsed.blocks ?? fresh.blocks; scrubTurnSeparatorIds(blocks); return blocks; })(),
        messageRefs: parsed.messageRefs ?? fresh.messageRefs,
        nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
        stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
        nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
        nextRunId: parsed.nextRunId ?? fresh.nextRunId,
        tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot,
        lastPassIds: parsed.lastPassIds ?? fresh.lastPassIds,
        hiddenOrphanRefs: parsed.hiddenOrphanRefs ?? fresh.hiddenOrphanRefs,
        // #2362: without this a restart forgets which refs are dead and the
        // model re-learns each one by failing a compress call again.
        deadRefs: parsed.deadRefs ?? fresh.deadRefs,
        terminalStreak: parsed.terminalStreak ?? fresh.terminalStreak,
        nextRuleId: parsed.nextRuleId ?? fresh.nextRuleId,
        // Without this, a restart re-exposes absorbed tool outputs: state
        // resurrects with absorbed=[] and hideAbsorbedMessages has nothing to hide.
        absorbed: parsed.absorbed ?? fresh.absorbed,
        rules: parsed.rules ?? fresh.rules,
        // #1095: without these, a restart forgets both which refs are restored
        // (image_full silently re-downscales them) and the shrink records that
        // keep re-encoding deterministic per ref.
        imageFullRestored: parsed.imageFullRestored ?? fresh.imageFullRestored,
        imageShrinks: parsed.imageShrinks ?? fresh.imageShrinks,
    };
}

/** Extract a short host label from an upstream origin URL, safe for a
 *  filename. Uses the full hostname (sanitized) rather than guessing the
 *  registrable domain — a public-suffix-list lookup is overkill, and the full
 *  host is unambiguous and grep-able. e.g.
 *    "https://coding.dashscope.aliyuncs.com" -> "coding.dashscope.aliyuncs.com"
 *  Falls back to a hash of the origin if parsing fails, so two distinct
 *  origins never collide. */
function hostLabel(upstreamOrigin?: string): string {
    if (!upstreamOrigin) return "unknown";
    try {
        const host = new URL(upstreamOrigin).hostname || "unknown";
        return host.replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 48) || "unknown";
    } catch {
        return "unknown-" + createHash("sha256").update(upstreamOrigin, "utf8").digest("hex").slice(0, 6);
    }
}

/** Relative path (under the sessions dir) for a session, namespaced by
 *  protocol and upstream host so a human can tell sessions apart at a glance:
 *    anthropic/bailian_<hash>.json
 *    openai/zhipu_<hash>.json
 *    responses/comfly_<hash>.json
 *  When protocol meta is absent (e.g. a session loaded from an old file
 *  written before meta was captured), fall back to _unknown/ so it still
 *  loads — it will be rewritten with the right namespace on next persist.
 *  Deterministic from (id, protocol, upstreamOrigin), so loadAll can verify
 *  the filename matches the body and loadSync can reverse-lookup. */
export function relPathFor(id: string, protocol?: string, upstreamOrigin?: string): string {
    const proto = protocol ?? "_unknown";
    const host = protocol ? hostLabel(upstreamOrigin) + "_" : "";
    return path.join(proto, `${host}${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24)}.json`);
}

/** #1097: the kernel CCR content-store envelope lives in ONE dedicated file
 *  per session, next to the session JSON (same namespace, same codec): the
 *  originals are payload bytes, not state — keeping them out of the session
 *  record preserves whole-file encryption, .json discovery, and the bounded
 *  in-memory session cache (the envelope is lazily loaded per session). */
function contentStoreRelPathFor(id: string, protocol?: string, upstreamOrigin?: string): string {
    const base = relPathFor(id, protocol, upstreamOrigin);
    return base.slice(0, -".json".length) + ".content-store.json";
}

/** #1937: true when a walked FILENAME is the canonical (or legacy flat /
 *  .fb fallback) name for record `id` — mirrors the kernel StateStore.loadAll
 *  owner check so independent directory walkers agree with loadSync about
 *  which files are addressable. Renamed files fail this check and stay
 *  invisible, exactly as they do for boot/reload. */
export function fileNameMatchesId(base: string, id: string, protocol?: string, upstreamOrigin?: string): boolean {
    const relBase = path.basename(relPathFor(id, protocol, upstreamOrigin));
    const flatBase = flatFileNameFor(id);
    if (base === relBase || base === flatBase) return true;
    if (base.endsWith(".fb.json")) {
        const canonicalBase = `${base.slice(0, -".fb.json".length)}.json`;
        return canonicalBase === relBase || canonicalBase === flatBase;
    }
    return false;
}

/** Session persistence policy over the kernel StateStore mechanism. The
 *  public API predates the extraction and is kept stable for session.ts /
 *  server.ts / export.ts. */
export class SessionStore {
    readonly enabled: boolean;
    private readonly sessionsDir: string;
    private readonly store: StateStore<PersistedSession>;
    private readonly log: Logger;
    private readonly staleWarnAt = new Map<string, number>();
    private readonly codec?: StateStoreCodec;

    constructor(opts?: { dir?: string; debounceMs?: number; enabled?: boolean; log?: Logger }) {
        const debounceMs = opts?.debounceMs ?? defaultDebounce();
        this.enabled = (opts?.enabled ?? true) && debounceMs >= 0;
        this.sessionsDir = opts?.dir ?? defaultDir();
        const baseLog = opts?.log ?? defaultLogger;
        this.log = baseLog;
        // #708/#1080: env-only storage policy (a key file next to the data
        // sits on the same untrusted filesystem). Compression is OPT-IN
        // (owner decision, #1080): BILI_PERSIST_ZSTD=1/true enables it, the
        // default stays plain JSON. Invalid key values throw here — fail
        // fast at startup instead of running silently unencrypted.
        const keyEnv = process.env.BILI_ENCRYPTION_KEY;
        let key: Buffer | null = null;
        if (keyEnv) key = parseEncryptionKey(keyEnv);
        this.codec = createStorageCodec({ key, compress: persistZstdEnabled() });
        if (key) {
            baseLog("info", "[persist] session-file encryption enabled (AES-256-GCM)");
        } else if (this.codec) {
            baseLog("info", "[persist] session-file compression enabled (zstd, BILIZSTD1)");
        }
        const epermAlert = new PersistEpermAlert({
            dir: this.sessionsDir,
            threshold: epermAlertThreshold(),
            repeatMs: epermAlertRepeatMs(),
        });
        this.store = new StateStore<PersistedSession>({
            dir: this.sessionsDir,
            version: PERSIST_VERSION,
            debounceMs: Math.max(0, debounceMs),
            enabled: this.enabled,
            codec: this.codec,
            log: (level, msg) => {
                epermAlert.observe(level, msg);
                baseLog(level, msg);
            },
            relPath: (id, payload) =>
                relPathFor(id, payload.meta?.protocol ?? payload.protocol, payload.meta?.upstreamOrigin ?? payload.upstreamOrigin),
            // Adopt the pre-envelope flat format this store itself wrote
            // before the kernel extraction (and every v1/v2 file before it).
            legacy: (parsed) => (isValidRecord(parsed) ? { id: parsed.id, payload: parsed, version: parsed.version, savedAt: parsed.savedAt } : null),
            validate: (envelope) => isValidRecord(envelope.payload),
            // #2298: CCR content-store envelopes (#1097) co-reside in the SAME
            // namespace by design (<proto>/<host>_<hash>.content-store.json) but
            // are not session records — declaring them foreign keeps the boot
            // scan from parsing each one and warning "skipping invalid record"
            // per file (hundreds of warns per start at multi-relay scale). Same
            // suffix predicate the GC (#1180) and web walkers already use.
            foreignFile: (file) => path.basename(file).endsWith(".content-store.json"),
        });
    }

    /** #1097: load the session's kernel content-store envelope (namespaced
     *  path first, then the _unknown/ fallback — same probe order as
     *  loadEnvelope). Returns null when absent or unreadable; callers degrade
     *  to a fresh store (retrieve misses), never crash the request. */
    loadContentStore(session: Session): MessageContentStore | null {
        if (!this.enabled) return null;
        const rels = [
            contentStoreRelPathFor(session.id, session.meta.protocol, session.meta.upstreamOrigin),
            contentStoreRelPathFor(session.id),
        ];
        for (const rel of rels) {
            let buf: Buffer;
            try {
                buf = readFileSync(path.join(this.sessionsDir, rel));
            } catch {
                continue;
            }
            try {
                const text = this.codec ? this.codec.decode(buf) : buf.toString("utf8");
                const parsed = JSON.parse(text) as MessageContentStore;
                if (parsed && typeof parsed === "object" && parsed.version === 1
                    && parsed.byHash && typeof parsed.byHash === "object"
                    && parsed.byRef && typeof parsed.byRef === "object") {
                    return parsed;
                }
                this.log("warn", `[persist] content-store for ${session.id} malformed, starting fresh`);
                return null;
            } catch (err) {
                this.log("warn", `[persist] content-store for ${session.id} unreadable, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        }
        return null;
    }

    /** #1097: persist the content-store envelope when dirty; an emptied store
     *  (rebase reset) deletes the file. Payload-first: runs BEFORE the session
     *  state write so a crash mid-save leaves at worst a retrieve miss, never
     *  a placeholder whose original is gone. */
    private saveContentStore(session: Session): void {
        if (!this.enabled || !session.contentStoreDirty) return;
        session.contentStoreDirty = false;
        const rel = contentStoreRelPathFor(session.id, session.meta.protocol, session.meta.upstreamOrigin);
        const abs = path.join(this.sessionsDir, rel);
        if (!session.contentStore || Object.keys(session.contentStore.byRef).length === 0) {
            rmSync(abs, { force: true });
            return;
        }
        try {
            mkdirSync(path.dirname(abs), { recursive: true });
            const text = JSON.stringify(session.contentStore);
            writeFileSync(abs, this.codec ? this.codec.encode(text) : text);
        } catch (err) {
            session.contentStoreDirty = true;
            this.log("warn", `[persist] content-store write failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** Bulk-load every persisted session from disk into a map keyed by the
     *  REAL session id (read from the file body, not the filename). Called once
     *  at startup before the server accepts traffic. Corrupt individual files
     *  are skipped (logged) — one bad file never blocks boot. */
    async loadAll(): Promise<Map<string, Session>> {
        const out = new Map<string, Session>();
        if (!this.enabled) return out;
        let clamped = 0;
        for (const [id, envelope] of await this.store.loadAll()) {
            const session = buildSession(envelope.payload);
            if (hasNegativePersistedTokens(envelope.payload)) {
                // #408 one-time migration: the in-memory value is already
                // clamped by buildSession — rewrite the stale file so the
                // negative value is gone from disk.
                await this.store.writeNow(id, () => buildRecord(session));
                clamped++;
            }
            out.set(id, session);
        }
        if (clamped > 0) {
            loggerLog("info", `[persist] one-time migration (#408): clamped negative lastInputTokens/contextTokens in ${clamped} session(s) to 0`);
        }
        return out;
    }

    /** Single-pass boot (#401): ONE loadAll walk+parse, then the #286
     *  identity migration over the SAME parsed map (no extra directory
     *  walk), then hydration into Sessions. initSessions calls this instead
     *  of migrateLegacyIds()+loadAll(), which walked and parsed the whole
     *  tree twice per start. */
    async boot(): Promise<Map<string, Session>> {
        if (!this.enabled) return new Map();
        await this.sweepStaleTemps();
        const loaded = await this.store.loadAll();
        await this.applyLegacyMigration(loaded);
        const out = new Map<string, Session>();
        for (const [id, envelope] of loaded) {
            out.set(id, buildSession(envelope.payload));
        }
        return out;
    }

    /** #708/#1080 review: boot NEVER rewrites session file CONTENT. The first
     *  draft re-encoded every legacy plaintext file in place at boot — a mass
     *  format flip that a downgrade (rollback during incident triage) would
     *  meet with "skipping corrupt file" + empty-session resume + overwrite,
     *  silently destroying history. Legacy plaintext files keep loading via
     *  the codec's magic dispatch and convert organically on their next save;
     *  the only thing boot touches is orphaned `.tmp-enc-*` temps from crashed
     *  writes of previous runs (pure deletion of garbage, never content). */
    private async sweepStaleTemps(): Promise<void> {
        let files: string[];
        try {
            files = await walkJsonFiles(this.sessionsDir);
        } catch {
            return;
        }
        for (const file of files) {
            if (STALE_ENC_TEMP_RE.test(path.basename(file))) {
                await rm(file, { force: true }).catch(() => {});
            }
        }
    }

    /** One-time migration for the #286 identity change: sessions persisted
     *  under the old derived hash id are re-keyed to the client-provided
     *  conversation value stored in meta.label (which is now the session id
     *  itself). Collisions on the same label keep the most recently saved
     *  record; the losers, and any label already claimed by a new-format
     *  session, are deleted. Records without a label cannot be mapped and are
     *  left in place (they load under their old id but are never requested
     *  again — the new proxy 400s anonymous requests). Self-terminating:
     *  after one pass no loaded id differs from its label. A completion
     *  marker makes it run ONCE EVER (#401): the old code re-scanned the tree
     *  on every boot because unlabeled files are intentionally kept, so the
     *  "one-time" log line repeated forever. */
    async migrateLegacyIds(): Promise<void> {
        if (!this.enabled) return;
        if (existsSync(this.markerPath())) return;
        const loaded = await this.store.loadAll();
        await this.applyLegacyMigration(loaded);
    }

    private markerPath(): string {
        return path.join(this.sessionsDir, MIGRATION_MARKER);
    }

    private async applyLegacyMigration(loaded: Map<string, PersistedEnvelope<PersistedSession>>): Promise<void> {
        // Marker gate lives HERE (not just in migrateLegacyIds) because boot()
        // invokes this directly — unlabeled files are intentionally kept
        // forever, so without the gate the "one-time" pass would re-run and
        // re-log on every single start (#401 root cause 3).
        if (existsSync(this.markerPath())) return;
        const claimed = new Set<string>();
        const byLabel = new Map<string, { id: string; savedAt: number; session: Session }>();
        let unlabeled = 0;
        for (const [id, envelope] of loaded) {
            // #499: anonymous prefix-affinity sessions (#309) carry the shared
            // display label "prefix-affinity" ≠ their pfa- id — they are
            // CURRENT-format, not legacy derived-hash sessions. Migrating them
            // would rekey every pfa session to the single id "prefix-affinity"
            // and DELETE all but the newest sibling on every boot (silent data
            // loss of saved compression state).
            if (id.startsWith("pfa-")) continue;
            const session = buildSession(envelope.payload);
            const label = session.meta.label;
            if (!label) {
                unlabeled++;
                continue;
            }
            if (label === id) {
                claimed.add(id);
                continue;
            }
            const prev = byLabel.get(label);
            if (!prev || envelope.savedAt >= prev.savedAt) {
                if (prev) {
                    await this.removeLegacyFile(prev.id, prev.session);
                    loaded.delete(prev.id);
                }
                byLabel.set(label, { id, savedAt: envelope.savedAt, session });
            } else {
                await this.removeLegacyFile(id, session);
                loaded.delete(id);
            }
        }
        let rekeyed = 0;
        for (const [label, { id, session }] of byLabel) {
            if (claimed.has(label)) {
                await this.removeLegacyFile(id, session);
                loaded.delete(id);
                continue;
            }
            session.id = label;
            await this.store.writeNow(label, () => buildRecord(session));
            await this.removeLegacyFile(id, session);
            const envelope = loaded.get(id);
            if (envelope) {
                loaded.set(label, { ...envelope, id: label, payload: { ...envelope.payload, id: label } });
            }
            loaded.delete(id);
            claimed.add(label);
            rekeyed++;
        }
        try {
            mkdirSync(this.sessionsDir, { recursive: true });
            writeFileSync(this.markerPath(), String(Date.now()), "utf8");
        } catch {
            // Read-only dir — migration re-runs next boot (it is idempotent).
        }
        if (rekeyed || unlabeled) {
            loggerLog("info", `[persist] one-time migration (#286): rekeyed ${rekeyed} legacy session(s), left ${unlabeled} unlabeled legacy file(s) in place`);
        }
    }

    /** Remove a legacy session file. The kernel store never deletes (cleanup
     *  is downstream policy), so the path is recomputed here: the namespaced
     *  layout for v2+/v3 files, the _unknown/ fallback, and the flat default
     *  name for pre-envelope v1 files. */
    private async removeLegacyFile(id: string, session: Session): Promise<void> {
        const candidates = new Set([
            relPathFor(id, session.meta.protocol, session.meta.upstreamOrigin),
            relPathFor(id),
            flatFileNameFor(id),
        ]);
        for (const rel of candidates) {
            await rm(path.join(this.sessionsDir, rel), { force: true }).catch(() => {});
        }
        for (const rel of [
            contentStoreRelPathFor(id, session.meta.protocol, session.meta.upstreamOrigin),
            contentStoreRelPathFor(id),
        ]) {
            await rm(path.join(this.sessionsDir, rel), { force: true }).catch(() => {});
        }
    }

    /** Shared envelope probe for the sync read paths: namespaced path
     *  first, then the _unknown/ location, letting the kernel store layer
     *  also check its discovered map and the flat legacy name. */
    private loadEnvelope(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): PersistedEnvelope<PersistedSession> | null {
        const envelopes = [
            this.store.loadSync(id, relPathFor(id, meta?.protocol, meta?.upstreamOrigin)),
            meta?.protocol ? this.store.loadSync(id, relPathFor(id)) : null,
        ];
        for (const envelope of envelopes) {
            if (envelope) return envelope;
        }
        return null;
    }

    /** Synchronous reload of a single session. Used on a memory miss (after
     *  LRU eviction). Sync fs is acceptable here because a miss is rare and
     *  reads a single small file (~1ms). Returns null if missing/corrupt or the
     *  body id does not match what we asked for. */
    loadSync(id: string, meta?: { protocol?: string; upstreamOrigin?: string }): Session | null {
        if (!this.enabled) return null;
        const envelope = this.loadEnvelope(id, meta);
        if (!envelope) return null;
        const session = buildSession(envelope.payload);
        if (hasNegativePersistedTokens(envelope.payload)) {
            // #408: sync context — debounce the stale-file rewrite
            // (buildSession already clamped the in-memory value).
            this.scheduleSave(session);
            loggerLog("info", `[persist] clamped negative token stats on reload for ${id} (#408)`);
        }
        return session;
    }

    /** Read-only state load for cross-session search (#841): unlike loadSync,
     *  never schedules a save (no #408 clamp-rewrite side effect). */
    loadStateForSearch(id: string): CompressionState | null {
        if (!this.enabled) return null;
        const envelope = this.loadEnvelope(id);
        if (!envelope) return null;
        return mergeState(envelope.payload.state);
    }

    /** #1937: sessions directory this store resolves against (the web summary
     *  index walks it; tests swap BILI_SESSIONS_DIR between runs, so the value
     *  must come from THIS instance, not a fresh env read). */
    get dir(): string {
        return this.sessionsDir;
    }

    /** #1937: decode ONE session file by PATH into a full Session for the web
     *  detail view (lazy single-file load — no full-directory scan). Returns
     *  null when absent/undecodable/invalid, or when the body id does not
     *  match `expectId` (renamed-file race; mirrors kernel loadSync's
     *  envelope.id === id guard). Read-only: no #408 clamp-rewrite side
     *  effect, like loadStateForSearch. */
    async loadSessionFromFile(file: string, expectId?: string): Promise<Session | null> {
        const parsed = await this.readRawFile(file);
        if (!parsed || typeof parsed !== "object") return null;
        const p = parsed as Record<string, unknown>;
        const rec = p.payload && typeof p.payload === "object" ? p.payload : parsed;
        if (!isValidRecord(rec)) return null;
        if (expectId !== undefined && rec.id !== expectId) return null;
        return buildSession(rec);
    }

    /** #1082 GC: read+decode a single session file by PATH (not session id),
     *  returning the parsed record (envelope or legacy flat) or null when the
     *  file is missing, undecodable, or not JSON. The codec-aware twin of the
     *  kernel store's id-keyed loaders: the GC walks the directory itself
     *  (mtime pre-filter) and only decodes age-eligible candidates. */
    async readRawFile(file: string): Promise<unknown | null> {
        try {
            const raw = await readFile(file);
            // Format-agnostic (GC #1082 review): try plain JSON first, then any
            // codec framing (BILIENC1 encryption, plus opt-in zstd body per
            // #1083). Enumerating magic bytes here would re-create the cross-PR
            // drift this method exists to avoid — every new on-disk frame would
            // silently no-op the sweep. Framed files fail the utf8 parse on
            // the magic prefix, so the fallback order is exact.
            try {
                return JSON.parse(raw.toString("utf8"));
            } catch {
                return this.codec ? JSON.parse(this.codec.decode(raw)) : null;
            }
        } catch {
            return null;
        }
    }

    /** #405 fix #4: dual-instance rollback guard. When two proxy processes
     *  share BILI_SESSIONS_DIR, whoever saves last used to win — an instance
     *  holding a STALE in-memory copy would roll counters back (requests:3 →
     *  2). Both signals below are monotonic per session id, so either being
     *  strictly smaller proves staleness. Returns the fresher-on-disk payload
     *  when the incoming record is stale, else null. */
    private staleDiskPayload(incoming: PersistedSession): PersistedSession | null {
        const envelope = this.loadEnvelope(incoming.id, incoming.meta);
        if (!envelope) return null;
        const disk = envelope.payload;
        const diskRequests = disk.stats?.requests ?? disk.requests ?? 0;
        const incRequests = incoming.stats?.requests ?? incoming.requests ?? 0;
        if (incRequests < diskRequests) return disk;
        if (incRequests === diskRequests) {
            const diskBlocks = disk.state?.nextBlockId ?? 0;
            const incBlocks = incoming.state?.nextBlockId ?? 0;
            if (incBlocks < diskBlocks) return disk;
        }
        return null;
    }

    private guardedBuild(session: Session): () => PersistedSession {
        return () => {
            const record = buildRecord(session);
            const disk = this.staleDiskPayload(record);
            if (disk === null) return record;
            const now = Date.now();
            const last = this.staleWarnAt.get(record.id) ?? 0;
            if (now - last >= STALE_WARN_THROTTLE_MS) {
                this.staleWarnAt.set(record.id, now);
                this.log(
                    "warn",
                    `[persist] rejected stale snapshot for session ${record.id}: in-memory copy is older than the on-disk one (another bili instance holds newer state) — keeping disk state and converging in-memory state to it, so subsequent requests serve the fuller fold coverage instead of the stale view (#405/#2401)`,
                );
            }
            // #2401: the guard proved the disk record is strictly newer — but
            // only protecting DISK left this resident serving forever-stale
            // fold state (missing blocks' covered content re-entered the wire
            // unfolded and got re-billed until restart). Apply the disk record
            // to the live session so serving converges on the same newest-wins
            // arbitration the write side just used.
            this.convergeToDisk(session, disk);
            // Rewrite the disk's own payload: content-identical no-op that
            // preserves the newer state while satisfying the write chain.
            return disk;
        };
    }

    /** #2401: read-side convergence. Replace the live session's persisted
     *  surfaces with the newer disk record, in place (the object identity is
     *  load-bearing — request handlers and the pool map hold references to
     *  THIS object). The client/agent re-sends full history on the next
     *  request in BOTH compression modes, so any in-turn progress made on the
     *  losing lineage is re-derived from the resend; worst case costs one
     *  extra compression round-trip. Deliberately NOT copied: contentStore
     *  (separate-file lifecycle — degrades to retrieve misses, never crashes),
     *  runtime-only fields (inFlight, pendingRetrievals handled below,
     *  restored, lockChain), and metadata (kept local; re-stamped per request
     *  where it matters). */
    private convergeToDisk(session: Session, disk: PersistedSession): void {
        const fresh = buildSession(disk);
        const droppedRetrievals = session.pendingRetrievals.length;
        session.state = fresh.state;
        session.blockContents = fresh.blockContents;
        session.stats = fresh.stats;
        session.lastMessages = fresh.lastMessages;
        session.lastMessagesFolded = fresh.lastMessagesFolded;
        session.pluginSnapshot = fresh.pluginSnapshot;
        session.lastSeen = fresh.lastSeen;
        if (!session.meta.protocol && fresh.meta.protocol) session.meta.protocol = fresh.meta.protocol;
        if (!session.meta.upstreamOrigin && fresh.meta.upstreamOrigin) session.meta.upstreamOrigin = fresh.meta.upstreamOrigin;
        if (!session.meta.label && fresh.meta.label) session.meta.label = fresh.meta.label;
        // Queued injections reference refs of the replaced lineage — drop them
        // the way a full rebase does (#1343 rationale) instead of misattributing
        // the expected loss as a proxy-restart drop later.
        session.pendingRetrievals.length = 0;
        delete session.metadata.ccrUndelivered;
        delete session.metadata.ccrDropNotes;
        if (droppedRetrievals > 0) {
            this.log("warn", `[persist] ${session.id}: dropped ${droppedRetrievals} queued retrieval(s) during state convergence to the newer disk record (#2401)`);
        }
        markDirty(session);
    }

    /** Schedule a debounced write for a session. Multiple calls within the
     *  window coalesce; the record is built at WRITE time, so the freshest
     *  session state is persisted. Safe to call on the hot path. No-op if
     *  disabled. */
    scheduleSave(session: Session): void {
        this.saveContentStore(session);
        this.store.scheduleSave(session.id, this.guardedBuild(session));
    }

    /** Asynchronously persist a session right now (skips the debounce). Throws
     *  on write failure so callers can react (e.g. avoid evicting). Serialized
     *  per-session by the kernel store's write chains. */
    async writeNow(session: Session): Promise<void> {
        this.saveContentStore(session);
        await this.store.writeNow(session.id, this.guardedBuild(session));
    }

    /** Synchronous flush for a single session. Used on memory eviction so a
     *  dirty evicted session is not lost. Sync because eviction runs in the
     *  sync getSession path; a single small write is acceptable.
     *  Returns true on success, false on failure (caller must NOT evict on
     *  failure for a never-persisted session or it is lost permanently). */
    flushSync(session: Session): boolean {
        this.saveContentStore(session);
        return this.store.flushSync(session.id, this.guardedBuild(session));
    }

    /** Flush all dirty content stores, then pending session writes. Called on
     *  SIGTERM/SIGINT for graceful shutdown. Content stores live outside the
     *  kernel StateStore, so retry them from the resident session list before
     *  the kernel drains its pending writes and in-flight chains. */
    async flushAll(sessions: Iterable<Session> = []): Promise<void> {
        for (const session of sessions) this.saveContentStore(session);
        await this.store.flushAll();
    }

    /** Whether a write is currently pending (debounce timer armed) for a id. */
    hasPending(id: string): boolean {
        return this.store.hasPending(id);
    }

    /** Cancel all pending writes without flushing (e.g. for tests). */
    cancelAll(): void {
        this.store.cancelAll();
    }
}

function buildRecord(session: Session): PersistedSession {
    const snapshot = boundedFoldedSnapshot(session);
    const observation = currentContextObservation(session);
    if (session.pluginSnapshot && session.contentStore) {
        const previous = session.metadata.publicSnapshotStoredRefs;
        session.metadata.publicSnapshotStoredRefs = [...new Set([
            ...(Array.isArray(previous) ? previous : []),
            ...session.pluginSnapshot.flatMap((m) => {
                const ref = session.state.messageRefs.byRaw[m.id];
                return ref && session.contentStore!.byRef[ref] ? [ref] : [];
            }),
        ])];
    }
    return {
        version: PERSIST_VERSION,
        savedAt: Date.now(),
        id: session.id,
        meta: { ...session.meta },
        // Credits are one-shot and are not restored; persist the effective view instead.
        stats: { ...session.stats, ...(observation ? { contextTokens: observation.tokens, contextTokensSource: observation.source } : {}) },
        messages: snapshot,
        messagesFolded: snapshot ? true : undefined,
        // #2077: the raw snapshot is persisted lazily — only once it becomes an
        // external contract (a fork receipt exists on this session, or a fork
        // was cut from this one and set the sticky retained flag). Non-forking
        // sessions pay no disk cost; the in-memory copy self-heals on the next
        // model request because plugin agents resend their full history.
        pluginSnapshot: session.metadata.publicForkReceipt !== undefined || session.metadata.publicSnapshotRetained === true ? session.pluginSnapshot : undefined,
        forkContentStore: session.metadata.publicForkReceipt ? session.contentStore : undefined,
        // Per-session provenance: record the bili build that wrote this file so the
        // web UI can show which version last touched the session; pre-stamp files
        // load without the key and render an honest dash.
        metadata: { ...session.metadata, biliVersion: VERSION },
        state: session.state,
        blockContents: Object.fromEntries(session.blockContents),
        createdAt: session.createdAt,
    };
}

function isBlockView(v: unknown): v is BlockView {
    return !!v && typeof v === "object" && typeof (v as BlockView).text === "string" && typeof (v as BlockView).count === "number";
}

// #2129: restore-time validation for the #1933 F1 calibrated factor. The learner
// publishes factors clamped to [CLAMP_MIN, CLAMP_MAX] (two-way since #2366), but
// applyEstimateCalibration applies whatever it is given UNCLAMPED — a corrupt or
// hand-edited file outside the published band would move every calibrated reading
// off-scale (k̂>4 over-inflates, k̂<0.25 over-deflates). Reject out-of-band values
// instead of trusting them: absent falls back to the raw estimate (legacy behavior).
function restoreCalibratedEstimate(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) && v >= CALIBRATION_CLAMP_MIN && v <= CALIBRATION_CLAMP_MAX ? v : undefined;
}

// #2129: same discipline for the evidence ring — keep only samples the learner
// itself would admit (finite, within the plausibility band) and only the newest
// window-size entries; anything else drops the ring wholesale so a malformed
// file can neither teach a factor nor mask a fresh learning run on restart.
function restoreCalibrationRing(v: unknown): { origin: string; values: number[] } | undefined {
    if (!v || typeof v !== "object") return undefined;
    const ring = v as { origin?: unknown; values?: unknown };
    if (typeof ring.origin !== "string" || ring.origin.length === 0) return undefined;
    if (!Array.isArray(ring.values)) return undefined;
    const values = ring.values.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= CALIBRATION_SAMPLE_MIN && x <= CALIBRATION_SAMPLE_MAX);
    const recent = values.slice(-CALIBRATION_SAMPLE_WINDOW);
    return recent.length > 0 ? { origin: ring.origin, values: recent } : undefined;
}

function buildSession(parsed: PersistedSession): Session {
    const blockContents = new Map<string, BlockContent>();
    for (const [bid, content] of Object.entries(parsed.blockContents ?? {})) {
        if (!content || typeof content !== "object") continue;
        const full = (content as Record<string, unknown>).full;
        if (!isBlockView(full)) continue;
        // Legacy files stored byte-identical one/full pairs (#401); normalize
        // to the single-copy form on load so the next write persists it once.
        const one = (content as Record<string, unknown>).one;
        const oneView = isBlockView(one) ? one : null;
        blockContents.set(bid, {
            one: oneView && !(oneView.text === full.text && oneView.count === full.count) ? oneView : null,
            full,
        });
    }
    // Read grouped shape (v2+); fall back to flat fields for v1 files.
    const meta = parsed.meta ?? {};
    const stats = parsed.stats ?? {};
    return {
        id: parsed.id,
        meta: {
            protocol: meta.protocol ?? parsed.protocol,
            upstreamOrigin: meta.upstreamOrigin ?? parsed.upstreamOrigin,
            label: meta.label ?? parsed.label,
            title: meta.title,
            // #1724: buildRecord persists activePack via spread but this reader dropped it
            activePack: typeof meta.activePack === "string" ? meta.activePack : undefined,
            // #2322: same as activePack above — buildRecord persists hostTitle via the spread; restore so the name survives restart
            hostTitle: typeof meta.hostTitle === "string" ? meta.hostTitle : undefined,
        },
        stats: {
            requests: stats.requests ?? parsed.requests ?? 0,
            tokensSaved: stats.tokensSaved ?? parsed.tokensSaved ?? 0,
            inputTokens: stats.inputTokens ?? parsed.inputTokens ?? 0,
            cachedTokens: stats.cachedTokens ?? parsed.cachedTokens ?? 0,
            outputTokens: stats.outputTokens ?? parsed.outputTokens ?? 0,
            cacheSamples: stats.cacheSamples ?? parsed.cacheSamples ?? 0,
            // #408: clamp at restore — pre-clamp versions persisted negative
            // values (lastInputTokens = total − credit before the Math.max
            // guard existed) which would otherwise revive after upgrade and
            // feed the /acp panel + web stats as negative percentages.
            lastInputTokens: Math.max(0, stats.lastInputTokens ?? parsed.lastInputTokens ?? 0),
            // #857: provenance — legacy files lack it; absent stays absent and
            // evidence-grade consumers treat absent as untrusted.
            lastInputTokensSource: stats.lastInputTokensSource === "usage" || stats.lastInputTokensSource === "estimate" || stats.lastInputTokensSource === "overflow-arm" ? stats.lastInputTokensSource : undefined,
            // #1110: one-shot overflow arm — legacy files lack it; absent = no arm.
            overflowArmTokens: typeof stats.overflowArmTokens === "number" && Number.isFinite(stats.overflowArmTokens) && stats.overflowArmTokens > 0 ? stats.overflowArmTokens : undefined,
            // In-memory only — a fresh process has no pending compress fold.
            compressCreditTokens: 0,
            contextTokens: Math.max(0, stats.contextTokens ?? parsed.contextTokens ?? 0),
            // #1839: display provenance — legacy files lack it; absent = no marker.
            contextTokensSource: stats.contextTokensSource === "usage" || stats.contextTokensSource === "estimate" ? stats.contextTokensSource : undefined,
            // #2129: measurement-state fields buildRecord persists via spread but this
            // reader used to drop — after a restart the preflight gate judged on the
            // UNCALIBRATED local estimate (k̂ lost → folded fitting payloads) and nudge
            // sizing fell through to the raw char-count bound (usage anchor lost →
            // EMERGENCY ghosts, #2122 incident). Restored with the same validation
            // discipline as the entries above: corrupt values are rejected outright.
            localInputEstimate: typeof stats.localInputEstimate === "number" && Number.isFinite(stats.localInputEstimate) && stats.localInputEstimate > 0 ? stats.localInputEstimate : undefined,
            lastUsageGradeTokens: typeof stats.lastUsageGradeTokens === "number" && Number.isFinite(stats.lastUsageGradeTokens) && stats.lastUsageGradeTokens >= 0 ? stats.lastUsageGradeTokens : undefined,
            lastInputTokensOrigin: typeof stats.lastInputTokensOrigin === "string" && stats.lastInputTokensOrigin.trim().length > 0 ? stats.lastInputTokensOrigin : undefined,
            calibratedEstimate: restoreCalibratedEstimate(stats.calibratedEstimate),
            calibratedEstimateOrigin: typeof stats.calibratedEstimateOrigin === "string" && stats.calibratedEstimateOrigin.trim().length > 0 ? stats.calibratedEstimateOrigin : undefined,
            calibrationRing: restoreCalibrationRing(stats.calibrationRing),
            // Intentionally NOT restored (#2129 triage): pendingFoldUsage is set at
            // compress execution and consumed only as a log-suffix attribution by the
            // NEXT usage report (#695) — restoring a stale true would mislabel an
            // unrelated post-reload report, and losing it costs one log suffix.
            // lastLocalTextEstimate(+Origin) is the pending k̂ pairing input whose
            // session.ts doc already says "a restart simply loses one pending pair".
            retrieveCalls: stats.retrieveCalls ?? 0,
            retrieveHits: stats.retrieveHits ?? 0,
            retrieveMisses: stats.retrieveMisses ?? 0,
            retrieveDropped: stats.retrieveDropped ?? 0,
            retrieveDelivered: stats.retrieveDelivered ?? 0,
            storedBytes: stats.storedBytes ?? 0,
            storeBytesSaved: stats.storeBytesSaved ?? 0,
            imageShrunkCount: stats.imageShrunkCount ?? 0,
            imageBytesSaved: stats.imageBytesSaved ?? 0,
            imageTokensSaved: stats.imageTokensSaved ?? 0,
            imageFullCalls: stats.imageFullCalls ?? 0,
            imageFullRestores: stats.imageFullRestores ?? 0,
            rangeRestores: stats.rangeRestores ?? 0,
            // #1336: retrieval-quality counters (whole-block restores vs cheaper
            // precise path available) — round-trip so the long-run ratio in
            // acp_status survives restarts instead of silently resetting.
            wholeBlockRestores: stats.wholeBlockRestores ?? 0,
            wholeBlockRestoresPreciseAvailable: stats.wholeBlockRestoresPreciseAvailable ?? 0,
        },
        metadata: parsed.metadata ?? {},
        state: mergeState(parsed.state),
        createdAt: parsed.createdAt ?? Date.now(),
        // #404: lastSeen reflects the on-disk savedAt (the last real
        // activity), NOT the restore moment — a restart must not fabricate
        // activity for every session (broke fallback=latest ties, panel
        // freshness, and eviction ordering). Consumers that need "has this
        // session been used since boot" read the restored flag.
        lastSeen: parsed.savedAt ?? Date.now(),
        restored: true,
        // #1343: arm the reload reconcile for the first request of THIS
        // process — getSession() clears `restored` before prepare runs, so
        // the reconcile needs its own one-shot marker to fire exactly once.
        ccrReconcilePending: true,
        blockContents,
        lastMessages: Array.isArray(parsed.messages) ? parsed.messages : undefined,
        lastMessagesFolded: parsed.messagesFolded === true,
        pluginSnapshot: Array.isArray(parsed.pluginSnapshot) ? parsed.pluginSnapshot : undefined,
        contentStore: parsed.forkContentStore,
        inFlight: 0,
        persisted: true,
        pendingRetrievals: [],
    };
}

export function isValidRecord(parsed: unknown): parsed is PersistedSession {
    if (!parsed || typeof parsed !== "object") return false;
    const r = parsed as Partial<PersistedSession>;
    return typeof r.id === "string" && typeof r.state === "object" && r.state !== null && Array.isArray(r.state.blocks);
}

/** #408: true when a persisted record (grouped v2+ or flat v1) carries a
 *  negative lastInputTokens/contextTokens — only possible in files written by
 *  pre-clamp versions. buildSession clamps on read; this lets the loaders
 *  rewrite the stale file once so the negative value is gone from disk. */
function hasNegativePersistedTokens(parsed: PersistedSession): boolean {
    const stats = parsed.stats ?? {};
    const last = stats.lastInputTokens ?? parsed.lastInputTokens;
    const ctx = stats.contextTokens ?? parsed.contextTokens;
    return (typeof last === "number" && last < 0) || (typeof ctx === "number" && ctx < 0);
}

function defaultDir(): string {
    return sessionsDir();
}

function defaultDebounce(): number {
    return knobPersistDebounceMs();
}

function persistEnabled(): boolean {
    return knobPersistEnabled();
}

/** #1080 (owner decision): session files stay plain JSON by default —
 *  recoverability (jq/grep-debuggable, no downgrade tail risk) beats silent
 *  disk savings. Only persist.enabled=false / BILI_PERSIST_ZSTD=1/true opts
 *  into zstd (BILIZSTD1); anything else keeps plain JSON. */
function persistZstdEnabled(): boolean {
    return knobPersistZstdEnabled();
}

/** Temp name used by atomic codec writes: `<file>.tmp-enc-<pid>-<ts>`. A
 *  process death between write and rename orphans it; any such name present
 *  at boot is stale by definition (the walk runs before this boot writes
 *  anything) and gets swept. */
const STALE_ENC_TEMP_RE = /\.tmp-enc-\d+-\d+$/;

async function walkJsonFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...(await walkJsonFiles(full)));
        } else if (e.isFile() && (STALE_ENC_TEMP_RE.test(e.name) || (e.name.endsWith(".json") && !e.name.startsWith(".tmp-")))) {
            out.push(full);
        }
    }
    return out;
}

/** Token budget for the persisted folded-view snapshot (#401). The raw full
 *  history is never persisted — prune() first replaces folded ranges with
 *  their summaries (exactly what `bili export` renders by default), then the
 *  OLDEST messages are dropped until the view fits. 0 disables message
 *  persistence entirely (block summaries + blockContents survive). */
function persistTailTokens(): number {
    return knobPersistTailTokens();
}

/** Bounded folded-view snapshot for the on-disk record (#401). See
 *  PersistedSession.messages. Truncation keeps whole messages from the NEWEST
 *  end; at least one message always survives (even if it alone exceeds the
 *  budget — a handoff doc with an empty tail is useless). */
function boundedFoldedSnapshot(session: Session): CoreMessage[] | undefined {
    const msgs = session.lastMessages;
    if (!msgs || msgs.length === 0) return undefined;
    const budget = persistTailTokens();
    if (budget === 0) return undefined;
    let view = prune(msgs, session.state);
    let total = 0;
    for (const m of view) total += defaultCountTokens(m.text ?? "");
    if (total > budget) {
        let acc = 0;
        let start = 0;
        for (let i = view.length - 1; i >= 0; i--) {
            acc += defaultCountTokens(view[i]!.text ?? "");
            if (acc > budget) {
                start = Math.min(i + 1, view.length - 1);
                break;
            }
        }
        if (start > 0) view = view.slice(start);
    }
    return view;
}

function epermAlertThreshold(): number {
    return knobPersistEpermAlertThreshold();
}

function epermAlertRepeatMs(): number {
    return knobPersistEpermAlertRepeatMs();
}

function defaultLogger(level: string, m: string): void {
    // Route through the tee logger (file + stderr) when available; fall back
    // to console.error only if the logger hasn't been configured yet (e.g.
    // during early init or tests).
    loggerLog(level, m);
}

/** Singleton store for the running proxy. */
let _store: SessionStore | null = null;

export function getStore(): SessionStore {
    if (!_store) {
        _store = new SessionStore({ enabled: persistEnabled(), log: defaultLogger });
    }
    return _store;
}

/** Test hook: inject a store with a temp dir. */
export function _setStoreForTest(store: SessionStore): void {
    _store = store;
}
