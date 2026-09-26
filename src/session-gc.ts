import { readdir, rm, rmdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { log as loggerLog } from "./logger.js";
import { defaultCountTokens } from "acp-kernel";
import { getStore, type SessionStore } from "./persist.js";
import { sessionsDir } from "./paths.js";
import { dropSessionForGc, peekSession } from "./session.js";

/**
 * Session-file garbage collection (#1082). OPT-IN: disabled unless
 * BILI_SESSION_GC is set to 1/true/on. Session files are user data
 * (exportable, resumable), so there is no silent deletion policy — the
 * kernel store never deletes, and this sweep only runs when asked to.
 *
 * When enabled, the sweep deletes a file only when BOTH conditions hold
 * (owner requirement #1082: both are load-bearing, neither alone suffices):
 *
 *   1. AGE: last activity (envelope savedAt) older than
 *      BILI_SESSION_GC_MAX_AGE_DAYS (default 7d). The threshold must stay far
 *      beyond any plausible resume window: after deletion a resumed session
 *      restarts numbering from m00001 while a resuming agent's transcript may
 *      still cite old numbers (kernel contract: ids are never reused), so a
 *      short threshold risks silent misattribution.
 *   2. SMALL / LOSSLESS REBUILD: the session was NEVER compressed (zero
 *      blocks, active or inactive, and no blockContents) AND its re-send size
 *      is bounded — deleting it loses no summaries, only bytes:
 *        2a. metadata.rawInputTokens known (recorded per turn since #1082):
 *            rawInputTokens <= BILI_SESSION_GC_MAX_TOKENS (default 1M);
 *        2b. unknown (legacy/pre-upgrade file): stats.contextTokens <= the
 *            same threshold. A session WITH folds can read small in context
 *            yet carry huge raw history (compressed 300K → 20K) and its
 *            summaries cannot be rebuilt losslessly — those files are always
 *            kept, regardless of size.
 *
 * Every deletion is audit-logged individually (path, size, age) plus one
 * summary line per non-empty sweep. The sweep touches ONLY the sessions dir.
 *
 * The sweep walks the DISK tree, not the in-memory map: sessions evicted by
 * the MAX_SESSIONS LRU cap or dropped at boot still have files, and only a
 * disk walk sees them. mtime is a cheap pre-filter; only age-eligible files
 * are decoded (any codec-framed file — encrypted today, zstd-compressed
 * once #1083 lands — works via the store's format-agnostic reader).
 * Corrupt/unreadable files are left in place, never guessed at.
 *
 * #1180: the per-session CCR content store (#1097) lives next to its session
 * file as `<hash>.content-store.json` and shares the session's lifecycle —
 * it holds lossless payload bytes (originals of oversized tool results), so
 * deleting the session loses exactly those bytes, the class of file this
 * sweep exists to clean:
 *   - co-deleted with its session file (the sweep never leaves orphans) —
 *     except when a surviving twin of the same id lacks its own store: after
 *     meta fill-once migrates _unknown/ -> ns/ without cleaning the old path
 *     (kernel writes never delete), the stale duplicate's sibling may still be
 *     the live fallback store; it is kept then and orphan-swept once the twin
 *     goes;
 *   - swept directly when orphaned (session file already gone — leftovers
 *     from versions that deleted sessions without their stores);
 *   - its token footprint (unique-content via the kernel's CJK-aware
 *     defaultCountTokens, same estimator as rawInputTokens) counts toward the
 *     size gate, so a tiny session with a huge store does not slip under it;
 *   - attached to a kept session → kept untouched; an unreadable/foreign
 *     companion next to an otherwise-eligible session → both kept (never
 *     guess at unreadable files).
 */

interface GcConfig {
    enabled: boolean;
    maxAgeMs: number;
    maxTokens: number;
    intervalMs: number;
}

const DEFAULT_MAX_AGE_DAYS = 7;
// Owner decision (#1082): aggressive by design — a cold rebuild (client re-sends
// full history, proxy folds via preflight) is acceptable even for large idle
// sessions, so the size gate rarely bites; the age gate does the work.
const DEFAULT_MAX_TOKENS = 1_000_000;
const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function gcConfigFromEnv(): GcConfig {
    // Opt-in only (owner requirement #1082): unset means disabled.
    const env = process.env.BILI_SESSION_GC?.toLowerCase();
    const enabled = env === "1" || env === "true" || env === "on";
    return {
        enabled,
        maxAgeMs: intEnv("BILI_SESSION_GC_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS) * DAY_MS,
        maxTokens: intEnv("BILI_SESSION_GC_MAX_TOKENS", DEFAULT_MAX_TOKENS),
        intervalMs: intEnv("BILI_SESSION_GC_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    };
}

function intEnv(name: string, fallback: number): number {
    const v = process.env[name];
    if (!v) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface FileView {
    id: string | null;
    savedAt: number;
    contextTokens: number;
    everCompressed: boolean;
    rawInputTokens: number | null;
    /** #1180: companion content-store (#1097) footprint folded into the size gate by isGcEligible; absent = no companion */
    storedTokens?: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Interpret a parsed session record (v3 envelope or legacy flat, grouped-then-
 *  flat fallbacks mirroring the readers in persist.ts). Null when unusable. */
export function viewFromParsed(parsed: unknown): FileView | null {
    const top = asRecord(parsed);
    if (!top) return null;
    const payload = asRecord(top.payload);
    const rec = payload ?? top;
    const savedAt = num(top.savedAt ?? rec.savedAt);
    if (savedAt === null || savedAt <= 0) return null;
    const state = asRecord(rec.state);
    const blocks = Array.isArray(state?.blocks) ? (state!.blocks as unknown[]) : [];
    // Any block — active OR inactive — or any stored fold content means the
    // session was compressed at some point: its summaries cannot be rebuilt
    // losslessly from a client re-send, so the file is never GC-eligible.
    const blockContents = asRecord(rec.blockContents);
    const everCompressed = blocks.length > 0 || (blockContents !== null && Object.keys(blockContents).length > 0);
    const stats = asRecord(rec.stats);
    const contextTokens = num(stats?.contextTokens ?? rec.contextTokens) ?? 0;
    const metadata = asRecord(rec.metadata);
    const rawInputTokens = num(metadata?.rawInputTokens);
    const id = typeof top.id === "string" ? top.id
        : typeof rec.id === "string" ? rec.id
            : null;
    return { id, savedAt, contextTokens, everCompressed, rawInputTokens };
}

/** Approximate token footprint of a parsed CCR content-store envelope
 *  (#1097): unique-content (byHash values) tokens via the kernel's CJK-aware
 *  defaultCountTokens — the same estimator rawInputTokens uses (persist.ts),
 *  so the size gate never mixes estimators (chars÷4 undercounts CJK-heavy
 *  stores up to 4×). Null when the value is not a store envelope — the
 *  caller keeps the session rather than guessing at an unknown companion. */
export function contentStoreTokens(parsed: unknown): number | null {
    const rec = asRecord(parsed);
    if (!rec || rec.version !== 1) return null;
    const byHash = asRecord(rec.byHash);
    const byRef = asRecord(rec.byRef);
    if (!byHash || !byRef) return null;
    let tokens = 0;
    for (const text of Object.values(byHash)) {
        if (typeof text === "string") tokens += defaultCountTokens(text);
    }
    return tokens;
}

export function isGcEligible(view: FileView, now: number, cfg: Pick<GcConfig, "maxAgeMs" | "maxTokens">): boolean {
    if (now - view.savedAt < cfg.maxAgeMs) return false;
    if (view.everCompressed) return false;
    // #1180: the companion store's lossless originals die with this file, so
    // its footprint joins the re-send size in the gate.
    const base = view.rawInputTokens !== null ? view.rawInputTokens : view.contextTokens;
    return base + (view.storedTokens ?? 0) <= cfg.maxTokens;
}

async function walkSessionFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...(await walkSessionFiles(full)));
        } else if (e.isFile() && e.name.endsWith(".json") && !e.name.startsWith(".") && !e.name.includes(".tmp-")) {
            out.push(full);
        }
    }
    return out;
}

interface GcResult {
    removed: number;
    kept: number;
    unreadable: number;
    bytesFreed: number;
    /** #1180: content-store companion files removed (co-deletions + orphan sweeps) */
    companionsRemoved: number;
}

export async function gcSessionFiles(opts?: { dir?: string; store?: SessionStore; now?: number }): Promise<GcResult> {
    const result: GcResult = { removed: 0, kept: 0, unreadable: 0, bytesFreed: 0, companionsRemoved: 0 };
    const cfg = gcConfigFromEnv();
    if (!cfg.enabled) return result;
    const store = opts?.store ?? getStore();
    if (!store.enabled) return result;
    const dir = opts?.dir ?? sessionsDir();
    const now = opts?.now ?? Date.now();
    let files: string[];
    try {
        files = await walkSessionFiles(dir);
    } catch {
        return result;
    }
    // #1180: split sessions from CCR companions (#1097); companion path is the
    // deterministic sibling per contentStoreRelPathFor — no decode to pair them.
    const companionSuffix = ".content-store.json";
    const sessionFiles: string[] = [];
    const companions: string[] = [];
    for (const f of files) {
        if (f.endsWith(companionSuffix)) companions.push(f);
        else sessionFiles.push(f);
    }
    const deletedSessions = new Set<string>();
    const coDeleted = new Set<string>();
    for (const file of sessionFiles) {
        let st;
        try {
            st = await stat(file);
        } catch {
            continue;
        }
        if (!st.isFile() || now - st.mtimeMs < cfg.maxAgeMs) {
            result.kept++;
            continue;
        }
        const parsed = await store.readRawFile(file);
        const view = parsed === null ? null : viewFromParsed(parsed);
        if (!view) {
            result.unreadable++;
            continue;
        }
        // #1180: measure the companion BEFORE judging "small enough" — its
        // lossless originals die with this file, so they are part of what a
        // deletion loses.
        const companion = file.slice(0, -".json".length) + companionSuffix;
        let compSt: Stats | undefined;
        try {
            const s = await stat(companion);
            if (s.isFile()) compSt = s;
        } catch { /* no companion */ }
        if (compSt) {
            const stored = contentStoreTokens(await store.readRawFile(companion));
            if (stored === null) {
                // Companion present but not a recognizable store envelope —
                // cannot verify what deletion would lose. Keep both (same rule
                // as unreadable session files: never guess).
                loggerLog("info", `[gc] kept session ${path.relative(dir, file)}: companion ${path.basename(companion)} is not a recognizable content store`);
                result.kept++;
                continue;
            }
            view.storedTokens = stored;
        }
        if (!isGcEligible(view, now, cfg)) {
            result.kept++;
            continue;
        }
        if (view.id !== null) {
            const resident = peekSession(view.id);
            if (resident) {
                // Resident + fresh in memory (activity after the on-disk write,
                // in-flight request, or pending debounced save) → deleting the
                // file would lose live state or be undone by the writer. Defer
                // to the next sweep.
                if (resident.inFlight > 0 || store.hasPending(view.id) || resident.lastSeen > view.savedAt + 1000) {
                    result.kept++;
                    continue;
                }
                dropSessionForGc(view.id);
            }
        }
        try {
            await rm(file, { force: true });
        } catch {
            result.kept++;
            continue;
        }
        // Audit trail (owner requirement #1082/#1180): every deletion is
        // individually traceable — which file, how big, how old.
        loggerLog("info", `[gc] removed ${path.relative(dir, file)} (${st.size} B, age ${Math.round((now - view.savedAt) / DAY_MS)}d)`);
        result.removed++;
        result.bytesFreed += st.size;
        deletedSessions.add(file);
        if (compSt) {
            // Co-delete the companion so the sweep never leaves orphans. On
            // failure it surfaces as an orphan on the very next pass below.
            // Cross-namespace exception: meta fill-once can migrate a session
            // _unknown/<h>.json -> ns/host_<h>.json without cleaning the old
            // path (kernel writes never delete the previous relPath), and
            // saveContentStore only rewrites when dirty — so a moved session
            // whose store was not re-saved since the move still reads its LIVE
            // store from this stale duplicate's sibling (loadContentStore
            // probes _unknown/ when the namespaced store is absent, and stops
            // at the first EXISTING candidate). Co-deleting it here would lose
            // retrievable originals. Skip when a surviving twin shares the
            // hash stem and has no store of its own; the bytes stay referenced
            // until the twin is swept, then the orphan pass collects them.
            const stem = path.basename(file, ".json");
            let keepCompanion = false;
            for (const sf of sessionFiles) {
                if (sf === file || deletedSessions.has(sf)) continue;
                if (!path.basename(sf).endsWith(stem + ".json")) continue;
                let twinHasOwnStore = false;
                try {
                    const s2 = await stat(sf.slice(0, -".json".length) + companionSuffix);
                    // Existence alone is not adoption: loadContentStore falls
                    // through to _unknown/ when the namespaced store exists but
                    // is UNREADABLE — the stale sibling stays the twin's live
                    // store. Probe the shape, not the inode.
                    twinHasOwnStore = s2.isFile() && contentStoreTokens(await store.readRawFile(sf.slice(0, -".json".length) + companionSuffix)) !== null;
                } catch { /* no sibling, or unreadable: keep — never guess */ }
                if (!twinHasOwnStore) {
                    keepCompanion = true;
                    break;
                }
            }
            if (keepCompanion) {
                loggerLog("info", `[gc] kept content store ${path.relative(dir, companion)} (${compSt.size} B): live fallback store of a surviving twin`);
            } else {
                try {
                    await rm(companion, { force: true });
                    loggerLog("info", `[gc] removed content store ${path.relative(dir, companion)} (${compSt.size} B)`);
                    result.bytesFreed += compSt.size;
                    result.companionsRemoved++;
                    coDeleted.add(companion);
                } catch { /* orphan pass retries */ }
            }
        }
        const parent = path.dirname(file);
        if (parent !== dir) await rmdir(parent).catch(() => {});
    }
    // #1180: orphaned companions — the session file is already gone (leftovers
    // from versions that deleted sessions without their stores). Unreferenced
    // payload garbage once old enough; the mtime pre-filter keeps live saves safe.
    for (const companion of companions) {
        if (coDeleted.has(companion)) continue;
        let st;
        try {
            st = await stat(companion);
        } catch {
            continue;
        }
        if (!st.isFile() || now - st.mtimeMs < cfg.maxAgeMs) {
            result.kept++;
            continue;
        }
        // Referenced when ANY surviving session file shares the hash stem —
        // namespaced `host_<hash>.json` and flat `_unknown/<hash>.json` both end
        // with `<hash>.json`, and meta fill-once can migrate a session between
        // those namespaces without cleaning the old path: sibling-only matching
        // would false-orphan (delete live store bytes) across that move.
        const stem = path.basename(companion).slice(0, -companionSuffix.length);
        let referenced = false;
        for (const sf of sessionFiles) {
            if (deletedSessions.has(sf)) continue;
            if (path.basename(sf).endsWith(stem + ".json")) {
                referenced = true;
                break;
            }
        }
        if (referenced) {
            result.kept++;
            continue;
        }
        try {
            await rm(companion, { force: true });
        } catch {
            result.kept++;
            continue;
        }
        loggerLog("info", `[gc] removed orphaned content store ${path.relative(dir, companion)} (${st.size} B)`);
        // Companions count in their own field — `removed` stays "session files".
        result.companionsRemoved++;
        result.bytesFreed += st.size;
        const parent = path.dirname(companion);
        if (parent !== dir) await rmdir(parent).catch(() => {});
    }
    if (result.removed > 0 || result.unreadable > 0 || result.companionsRemoved > 0) {
        loggerLog(result.unreadable > 0 ? "warn" : "info",
            `[gc] removed ${result.removed} stale session file(s)${result.companionsRemoved > 0 ? ` + ${result.companionsRemoved} content store file(s)` : ""} (age>${Math.round(cfg.maxAgeMs / DAY_MS)}d, ≤${cfg.maxTokens}tok), freed ${(result.bytesFreed / 1024).toFixed(1)} KB${result.unreadable > 0 ? `; left ${result.unreadable} unreadable file(s) in place` : ""}`);
    }
    return result;
}
