import fs from "node:fs";
import path from "node:path";
// Runtime (not type-only) import: this module and session-resolve form an ESM
// cycle — each uses the other's exports only inside function bodies (never at
// module evaluation), so both load orders initialize cleanly.
import { applyOrderSnapshot, orderSnapshot, type OrderSkeletonEntry } from "./session-resolve.js";
import { stateDir } from "./paths.js";
import { log } from "./logger.js";
import { persistDebounceMs, persistMaxDelayMs } from "./knobs.js";
import { kvStore } from "./persist.js";

/**
 * #3397: session-order skeleton persistence. The resolver's recorded
 * skeletons were process memory, so every proxy restart re-ran the cold-start
 * race: whichever lane (the main conversation vs a tagged shallow sidecar
 * request) arrived FIRST claimed the raw id, and the winner flipped across
 * restarts — orphaning the accumulated compression state (refs/blocks) under
 * the key the conversation lost. A dsh long session would then cite refs that
 * exist only in the orphaned generation and compress failed forever while new
 * sessions worked fine (#3397). Persisting the skeletons makes resolution
 * restart-stable: the main conversation keeps its key, sidecars keep their
 * lanes. Mirrors src/affinity-persist.ts mechanics (debounced atomic write,
 * merge-with-disk, LRU by lastSeen, hydrate on boot).
 */

// Same quiesce/max-delay discipline as #1834's affinity persistence: a busy
// proxy must not starve the write indefinitely. Both windows resolve through
// the shared persist.* knobs (#6058 QLC field report: under sustained traffic
// the 5s max-delay cap set the steady-state rewrite rate, so tuning only the
// debounce window changed nothing); defaults keep the historical 500ms / 5s.
const MAX_ORDER_ENTRIES = 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

// #5753: skeletons ride the UNIFIED storage (kv_store namespace
// "session-order", single row "v1" holding the snapshot) under the #5548
// carrier rules: kv primary once hydrated, the legacy file kept as the boot
// warm-up + pre-hydration fallback + sole carrier on legacy-only instances,
// one-time migration on first hydration, then a unified instance never writes
// the file again. The sync file hydrate still runs first at boot (resolution
// happens before routing, by RAW key, and must not wait on async startup work);
// the async kv overlay layers fresher rows on top of it.
const ORDER_NS = "session-order";
const ORDER_KEY = "v1";
let kvReady = false;
let kvChain: Promise<void> = Promise.resolve();
let kvWarned = false;

function kvWarnOnce(tag: string, err: unknown): void {
    if (kvWarned) return;
    kvWarned = true;
    log("warn", `[session-order] ${tag} failed — skeletons stay on the legacy file path for this process (${err instanceof Error ? err.message : String(err)})`);
}

/** Validate one skeleton row (kv payload or file entry share the shape). */
function orderEntryOf(e: unknown): OrderSkeletonEntry | undefined {
    if (!e || typeof e !== "object") return undefined;
    const x = e as OrderSkeletonEntry;
    if (typeof x.id !== "string") return undefined;
    if (!Array.isArray(x.kinds) || !x.kinds.every((k) => typeof k === "string")) return undefined;
    if (!Array.isArray(x.frags) || !x.frags.every((f) => typeof f === "string")) return undefined;
    if (typeof x.tagHash !== "string" || typeof x.lastSeen !== "number") return undefined;
    return x;
}

function orderFile(): string {
    return path.join(stateDir(), "session-order.json");
}

let timer: NodeJS.Timeout | null = null;
let writing = false;
let pendingSince: number | null = null;

/** Entries another process left on disk since we hydrated; null on read failure
 *  (the caller then writes its own snapshot unchanged). */
function readDiskEntries(): OrderSkeletonEntry[] | null {
    try {
        const file = orderFile();
        if (!fs.existsSync(file)) return [];
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        if (!Array.isArray(parsed.entries)) return [];
        return parsed.entries.filter(
            (e): e is OrderSkeletonEntry => orderEntryOf(e) !== undefined,
        );
    } catch {
        return null;
    }
}

/** Validate a persisted unified snapshot ({version, entries}); null unusable.
 *  Entries missing `model` are tolerated (pre-#model-field rows still resolve). */
function parseStoreDoc(value: unknown): OrderSkeletonEntry[] | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = (value as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return null;
    return entries.map(orderEntryOf).filter((e): e is OrderSkeletonEntry => e !== undefined);
}

/** Union of ours + disk keyed by id, fresher record wins per id — a restart or
 *  sibling lane cannot clobber another process's skeletons via whole-file
 *  last-writer-wins (same discipline as affinity's #1724 merge). */
function mergeWithDisk(mine: OrderSkeletonEntry[], disk: OrderSkeletonEntry[]): OrderSkeletonEntry[] {
    const byId = new Map<string, OrderSkeletonEntry>();
    for (const e of disk) byId.set(e.id, e);
    for (const m of mine) {
        const d = byId.get(m.id);
        byId.set(m.id, !d || m.lastSeen >= d.lastSeen ? m : d);
    }
    return [...byId.values()];
}

/** Re-apply the store's bounds on the write path: the union is monotonic
 *  (nothing removes disk-only records), so without the cap the file would grow
 *  one entry per conversation that churns through the lifetime. Frags can also
 *  grow with turn count — the byte budget keeps the debounced serialization
 *  cheap even for a pathological snapshot (freshest entries kept first). */
function normalizeForWrite(entries: OrderSkeletonEntry[]): OrderSkeletonEntry[] {
    const capped = entries.length <= MAX_ORDER_ENTRIES
        ? entries
        : [...entries].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_ORDER_ENTRIES);
    const kept: OrderSkeletonEntry[] = [];
    let size = JSON.stringify({ version: 1, entries: [] }).length;
    for (const e of capped) {
        const delta = JSON.stringify(e).length + 1;
        if (kept.length > 0 && size + delta > MAX_SNAPSHOT_BYTES) break;
        kept.push(e);
        size += delta;
    }
    return kept;
}

function writeSnapshotLegacy(): void {
    if (writing) return;
    writing = true;
    try {
        const file = orderFile();
        const mine = orderSnapshot();
        const disk = readDiskEntries();
        const merged = disk === null ? mine : mergeWithDisk(mine, disk);
        const entries = normalizeForWrite(merged);
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
    } catch (e) {
        log("warn", `[session-order] persist failed (${e instanceof Error ? e.message : String(e)}); skeletons survive in memory`);
    } finally {
        writing = false;
        pendingSince = null;
    }
}

/** #5753: one durable unified-store RMW — read the live row (cross-lane
 *  union), merge ours in fresher-wins, re-apply bounds, write back. Writes are
 *  chained so back-to-back schedules never lose updates against each other. */
function persistUnifiedNow(): void {
    const store = kvStore();
    if (!store) return;
    kvChain = kvChain.then(async () => {
        let live: OrderSkeletonEntry[] | null = null;
        try {
            live = parseStoreDoc(await store.getKvAsync(ORDER_NS, ORDER_KEY));
        } catch {
            live = null;
        }
        const mine = orderSnapshot();
        const merged = live === null ? mine : mergeWithDisk(mine, live);
        const entries = normalizeForWrite(merged);
        await store.setKvAsync(ORDER_NS, ORDER_KEY, { version: 1, entries });
    }).catch((err) => {
        kvWarnOnce("persist", err);
        // #5757 review fix: a failed RMW demotes this process back onto the
        // LEGACY FILE path (every subsequent timer/flush writes there) —
        // matching what the warning promises; a healthy store stays primary.
        kvReady = false;
    });
}

/** Once per process (wired at cli start): layer the kv snapshot over what the
 *  sync boot hydrate loaded, and migrate any legacy-file rows the store lacks.
 *  Never throws. */
export async function hydrateOrderUnified(): Promise<void> {
    const store = kvStore();
    if (kvReady || !store) return;
    try {
        let raw: unknown;
        try {
            raw = await store.getKvAsync(ORDER_NS, ORDER_KEY);
        } catch {
            raw = undefined;
        }
        const kvEntries = parseStoreDoc(raw) ?? [];
        // Presence-based predicate (mirrors the affinity twin): an empty but
        // PRESENT row still counts as migrated, so sibling lanes' empties are
        // not re-uploaded over every boot (#5757).
        const hadRow = raw !== undefined && raw !== null;
        const fileEntries = readDiskEntries() ?? [];
        const merged = fileEntries.length === 0
            ? kvEntries
            : (kvEntries.length === 0 ? fileEntries : mergeWithDisk(fileEntries, kvEntries));
        if (merged.length > 0) {
            const imported = applyOrderSnapshot(merged);
            if (imported > 0) log("info", `[session-order] hydrated ${imported} skeleton(s) from unified storage (kv_store namespace "${ORDER_NS}") (#5753)`);
        }
        // One-time migration: file rows missing from the store travel up once.
        const kvIds = new Set(kvEntries.map((e) => e.id));
        if (!hadRow || fileEntries.some((e) => !kvIds.has(e.id))) {
            await store.setKvAsync(ORDER_NS, ORDER_KEY, { version: 1, entries: normalizeForWrite(merged) });
            if (!hadRow && merged.length > 0) log("info", `[session-order] migrated ${merged.length} skeleton(s) from the legacy JSON file into unified storage`);
        }
        kvReady = true;
    } catch (err) {
        kvWarnOnce("hydrate", err);
    }
}

/** Test seam: drop the unified caches so the next hydrate re-reads the volume. */
export function _resetOrderPersistForTest(): void {
    kvReady = false;
    kvChain = Promise.resolve();
    kvWarned = false;
    writing = false;
    pendingSince = null;
    if (timer) clearTimeout(timer);
    timer = null;
}

/** Debounced snapshot write — called from the resolver after every record
 *  mutation. The trailing debounce quiesces bursts; the max-delay budget
 *  guarantees the write still lands under sustained traffic. */
export function scheduleOrderPersist(): void {
    const now = Date.now();
    if (pendingSince === null) pendingSince = now;
    if (timer) clearTimeout(timer);
    const budget = persistMaxDelayMs() - (now - pendingSince);
    timer = setTimeout(
        () => {
            timer = null;
            if (kvReady && kvStore() !== null) {
                persistUnifiedNow();
            } else {
                // Pre-hydration window or legacy-only instance: the file keeps
                // working exactly like before (and the boot hydration imports
                // anything it holds).
                writeSnapshotLegacy();
            }
        },
        Math.max(0, Math.min(persistDebounceMs(), budget)),
    );
    timer.unref?.();
}

/** Immediate snapshot write — shutdown/restart path. Unified instances await
 *  the queued store writes so a graceful exit loses nothing (the file write
 *  was always synchronous; the store write needs the settle, hence async). */
export async function flushOrderSkeletons(): Promise<void> {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    if (kvReady && kvStore() !== null) {
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
export function hydrateOrderSkeletons(): void {
    try {
        const file = orderFile();
        if (!fs.existsSync(file)) return;
        const entries = readDiskEntries();
        if (entries === null) {
            log("warn", `[session-order] snapshot ${path.basename(file)} is unreadable — starting with empty skeletons`);
            return;
        }
        const imported = applyOrderSnapshot(entries);
        if (imported > 0) log("info", `[session-order] hydrated ${imported} skeleton(s) from ${path.basename(file)} — persona resolution survives restarts (#3397)`);
    } catch (e) {
        log("warn", `[session-order] hydrate failed (${e instanceof Error ? e.message : String(e)}); starting with empty skeletons`);
    }
}
