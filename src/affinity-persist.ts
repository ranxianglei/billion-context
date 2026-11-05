import fs from "node:fs";
import path from "node:path";
import { prefixAffinity, type AffinitySnapshotEntry, MAX_TRACKED_SESSIONS } from "./prefix-affinity.js";
import { stateDir } from "./paths.js";
import { log } from "./logger.js";
import { getStore, unifiedKvActive } from "./persist.js";

/**
 * #499 P1a: prefix-affinity persistence. The anonymous affinity chains were
 * pure in-memory (#309), so a proxy restart orphaned every anonymous session:
 * the next replay forked a fresh session with zero compression state and
 * resent the raw history (#351 — 458K tokens, 0% cache). The chains are
 * small (≤1024 sessions × ≤128 hashes); persist them to the state dir with a
 * debounced atomic write and hydrate on boot.
 */

/** #1834: quiesce window. Every chain mutation restarts this debounce (a
 *  busy proxy would otherwise push the write out indefinitely and a SIGKILL
 *  lost EVERYTHING since the last flush, not just 5s worth), and the
 *  max-delay budget caps how long a pending write can be starved: the file
 *  is on disk within ~500ms of the last mutation, or within 5s under
 *  sustained traffic — previously a flat 5s trailing window. */
const PERSIST_DEBOUNCE_MS = 500;
const PERSIST_MAX_DELAY_MS = 5_000;

// #5753: chains ride the UNIFIED storage (kv_store namespace
// "prefix-affinity", single row "v1" holding the snapshot) under the #5548
// carrier rules: kv primary once hydrated, the legacy file kept as pre-
// hydration fallback + sole carrier on legacy-only instances, one-time
// migration on first hydration, then a unified instance never writes it.
const AFF_NS = "prefix-affinity";
const AFF_KEY = "v1";
let kvReady = false;
let kvChain: Promise<void> = Promise.resolve();
let kvWarned = false;

function kvWarnOnce(tag: string, err: unknown): void {
    if (kvWarned) return;
    log("warn", `[prefix-affinity] ${tag} failed — chains stay on the legacy file path for this process (${err instanceof Error ? err.message : String(err)})`);
}

/** Validate a persisted unified snapshot ({version, entries}); null unusable. */
function parseStoreDoc(value: unknown): AffinitySnapshotEntry[] | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = (value as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return null;
    return entries.filter(
        (e): e is AffinitySnapshotEntry =>
            !!e && typeof e === "object" &&
            typeof (e as AffinitySnapshotEntry).sessionId === "string" &&
            typeof (e as AffinitySnapshotEntry).depth === "number" &&
            typeof (e as AffinitySnapshotEntry).tailHash === "string" &&
            Array.isArray((e as AffinitySnapshotEntry).itemHashes) &&
            ((e as AffinitySnapshotEntry).itemHashes as unknown[]).every((h) => typeof h === "string") &&
            typeof (e as AffinitySnapshotEntry).lastSeen === "number",
    );
}

function affinityFile(): string {
    return path.join(stateDir(), "prefix-affinity.json");
}

let timer: NodeJS.Timeout | null = null;
let writing = false;
let pendingSince: number | null = null;

/** Entries another process left on disk since we hydrated; null on read failure
 *  (the caller then writes its own snapshot unchanged). */
function readDiskEntries(): AffinitySnapshotEntry[] | null {
    try {
        const file = affinityFile();
        if (!fs.existsSync(file)) return [];
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        if (!Array.isArray(parsed.entries)) return [];
        return parsed.entries.filter(
            (e): e is AffinitySnapshotEntry =>
                !!e && typeof e === "object" &&
                typeof (e as AffinitySnapshotEntry).sessionId === "string" &&
                typeof (e as AffinitySnapshotEntry).depth === "number" &&
                typeof (e as AffinitySnapshotEntry).tailHash === "string" &&
                Array.isArray((e as AffinitySnapshotEntry).itemHashes) &&
                ((e as AffinitySnapshotEntry).itemHashes as unknown[]).every((h) => typeof h === "string") &&
                typeof (e as AffinitySnapshotEntry).lastSeen === "number",
        );
    } catch {
        return null;
    }
}

/** #1724: union of ours + disk keyed by sessionId, deeper/fresher chain wins per
 *  id — a restart or sibling lane can no longer clobber another process's chains
 *  via whole-file last-writer-wins (generalizes #405's "keep fresher" to a store
 *  with no global counter). Counts same-depth forks; the caller reports how
 *  many disk-only chains survived the final write. */
function mergeWithDisk(
    mine: AffinitySnapshotEntry[],
    disk: AffinitySnapshotEntry[],
): { entries: AffinitySnapshotEntry[]; forks: number } {
    const byId = new Map<string, AffinitySnapshotEntry>();
    for (const e of disk) byId.set(e.sessionId, e);
    let forks = 0;
    for (const m of mine) {
        const d = byId.get(m.sessionId);
        if (!d) {
            byId.set(m.sessionId, m);
            continue;
        }
        if (m.depth === d.depth && m.tailHash !== d.tailHash) forks++;
        byId.set(m.sessionId, m.depth > d.depth || (m.depth === d.depth && m.lastSeen >= d.lastSeen) ? m : d);
    }
    return { entries: [...byId.values()], forks };
}

/** The union is monotonic (nothing removes disk-only chains), so without
 *  re-applying the store's own bound the file would grow one entry per
 *  chain that churns through the LRU cap over a process's lifetime. Mirror
 *  the store's semantics on the write path (#1724 permanence: chains never
 *  expire with time — only the LRU cap applies, most-recently-seen first). */
function normalizeForWrite(entries: AffinitySnapshotEntry[]): AffinitySnapshotEntry[] {
    if (entries.length <= MAX_TRACKED_SESSIONS) return entries;
    return [...entries].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_TRACKED_SESSIONS);
}

function writeSnapshotLegacy(): void {
    if (writing) return;
    writing = true;
    try {
        const file = affinityFile();
        const mine = prefixAffinity.exportSnapshot();
        const disk = readDiskEntries();
        const merged = disk === null ? { entries: mine, forks: 0 } : mergeWithDisk(mine, disk);
        const entries = normalizeForWrite(merged.entries);
        const snapshot = { version: 1, entries };
        const tmp = `${file}.tmp`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // fsync before rename: a crash between write and rename otherwise leaves
        // a size-correct, VDL=0 zero file (#3157).
        const fd = fs.openSync(tmp, "w");
        try {
            fs.writeFileSync(fd, JSON.stringify(snapshot));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
        if (disk !== null) {
            const mineIds = new Set(mine.map((e) => e.sessionId));
            const preserved = entries.filter((e) => !mineIds.has(e.sessionId)).length;
            if (preserved > 0 || merged.forks > 0) {
                log("info", `[prefix-affinity] write merged ${entries.length} chain(s): kept ${preserved} disk-only, resolved ${merged.forks} same-depth fork(s) across instances (#1724)`);
            }
        }
    } catch (e) {
        log("warn", `[prefix-affinity] persist failed (${e instanceof Error ? e.message : String(e)}); affinity survives in memory`);
    } finally {
        writing = false;
        pendingSince = null;
    }
}

/** #5753: one durable unified-store RMW — read the live row (cross-lane
 *  union), merge ours in per the #1724 rule, re-apply the cap, write back.
 *  Writes are chained so back-to-back schedules never lose updates. */
function persistUnifiedNow(): void {
    kvChain = kvChain.then(async () => {
        let live: AffinitySnapshotEntry[] | null = null;
        try {
            live = parseStoreDoc(await getStore().getKvAsync(AFF_NS, AFF_KEY));
        } catch {
            live = null;
        }
        const mine = prefixAffinity.exportSnapshot();
        const merged = live === null ? { entries: mine, forks: 0 } : mergeWithDisk(mine, live);
        const entries = normalizeForWrite(merged.entries);
        await getStore().setKvAsync(AFF_NS, AFF_KEY, { version: 1, entries });
        if (merged.forks > 0) {
            log("info", `[prefix-affinity] unified write resolved ${merged.forks} same-depth fork(s) across instances (#1724)`);
        }
    }).catch((err) => kvWarnOnce("persist", err));
}

/** Presence check independent of content (an empty-but-present row still
 *  counts as migrated, so we don't re-upload over sibling lanes' empties). */
async function kvRowPresent(): Promise<boolean> {
    try {
        return (await getStore().getKvAsync(AFF_NS, AFF_KEY)) !== undefined;
    } catch {
        return false;
    }
}

/** Once per process (wired at cli start): layer the kv snapshot over what the
 *  sync boot hydrate loaded, then migrate legacy-file rows the store lacks.
 *  Never throws. */
export async function hydrateAffinityUnified(): Promise<void> {
    if (kvReady || !unifiedKvActive()) return;
    try {
        let kvEntries: AffinitySnapshotEntry[] | null = null;
        try {
            kvEntries = parseStoreDoc(await getStore().getKvAsync(AFF_NS, AFF_KEY));
        } catch {
            kvEntries = null;
        }
        kvEntries ??= [];
        const hadRow = await kvRowPresent();
        const fileEntries = readDiskEntries() ?? [];
        let merged: { entries: AffinitySnapshotEntry[]; forks: number };
        if (fileEntries.length === 0) merged = { entries: kvEntries, forks: 0 };
        else if (kvEntries.length === 0) merged = { entries: fileEntries, forks: 0 };
        else merged = mergeWithDisk(fileEntries, kvEntries);
        if (merged.entries.length > 0) {
            const imported = prefixAffinity.importSnapshot(merged.entries);
            if (imported > 0) log("info", `[prefix-affinity] hydrated ${imported} chain(s) from unified storage (kv_store namespace "${AFF_NS}") (#5753)`);
        }
        // One-time migration: file rows missing from the store travel up once.
        const kvIds = new Set(kvEntries.map((e) => e.sessionId));
        if (!hadRow || fileEntries.some((e) => !kvIds.has(e.sessionId))) {
            await getStore().setKvAsync(AFF_NS, AFF_KEY, { version: 1, entries: normalizeForWrite(merged.entries) });
            if (!hadRow && merged.entries.length > 0) log("info", `[prefix-affinity] migrated ${merged.entries.length} chain(s) from the legacy JSON file into unified storage`);
        }
        kvReady = true;
    } catch (err) {
        kvWarnOnce("hydrate", err);
    }
}

/** Test seam: drop the unified caches so the next hydrate re-reads the volume. */
export function _resetAffinityPersistForTest(): void {
    kvReady = false;
    kvChain = Promise.resolve();
    kvWarned = false;
    writing = false;
    pendingSince = null;
    if (timer) clearTimeout(timer);
    timer = null;
}

/** Debounced snapshot write — call after every affinity mutation. The
 *  trailing debounce quiesces bursts; the #1834 max-delay budget guarantees
 *  the write still lands under sustained traffic (see constants above). */
export function scheduleAffinityPersist(): void {
    const now = Date.now();
    if (pendingSince === null) pendingSince = now;
    if (timer) clearTimeout(timer);
    const budget = PERSIST_MAX_DELAY_MS - (now - pendingSince);
    timer = setTimeout(
        () => {
            timer = null;
            if (unifiedKvActive() && kvReady) {
                persistUnifiedNow();
            } else {
                // Pre-hydration window or legacy-only instance: the file keeps
                // working exactly like before (hydration imports what it holds).
                writeSnapshotLegacy();
            }
        },
        Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, budget)),
    );
    timer.unref?.();
}

/** Immediate snapshot write — shutdown path. Awaits queued unified-store
 *  writes so a graceful exit loses nothing (the file write was always sync;
 *  the store write needs the settle, hence async). */
export async function flushPrefixAffinity(): Promise<void> {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    if (unifiedKvActive() && kvReady) {
        // Must land even when no mutation waited out its debounce before exit:
        // persistUnifiedNow() is read-modify-write, so running it with nothing
        // changed merely rewrites the identical row (idempotent).
        pendingSince = null;
        await persistUnifiedNow();
    } else {
        pendingSince = null;
        writeSnapshotLegacy();
    }
}

/** Load the snapshot a previous process left behind. Call once on boot. */
export function hydratePrefixAffinity(): void {
    try {
        const file = affinityFile();
        if (!fs.existsSync(file)) return;
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        const imported = prefixAffinity.importSnapshot(parsed.entries);
        if (imported > 0) log("info", `[prefix-affinity] hydrated ${imported} chain(s) from ${path.basename(file)} — anonymous sessions reattach across restarts`);
    } catch (e) {
        log("warn", `[prefix-affinity] hydrate failed (${e instanceof Error ? e.message : String(e)}); starting with empty affinity`);
    }
}
