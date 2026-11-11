import path from "node:path";
// Runtime (not type-only) import: this module and session-resolve form an ESM
// cycle — each uses the other's exports only inside function bodies (never at
// module evaluation), so both load orders initialize cleanly.
import { applyOrderSnapshot, orderSnapshot, type OrderSkeletonEntry } from "./session-resolve.js";
import { stateDir } from "./paths.js";
import { log } from "./logger.js";
import { openSnapshotJournal } from "./snapshot-journal.js";
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
 * lanes. Mirrors src/affinity-persist.ts mechanics (debounced write,
 * merge-with-disk, LRU by lastSeen, hydrate on boot) — and, like it, writes
 * through the immutable-publication journal (src/snapshot-journal.ts) so two
 * instances sharing a state dir can no longer interleave RMW on one shared
 * `session-order.json.tmp`.
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

/** Entries another process left on disk since we hydrated: the legacy baseline ∪
 *  every published journal leaf (#5480 — since publications, the baseline file
 *  alone is not the whole on-disk store; the census never throws or deletes, so
 *  the null-on-failure shape is gone). */
function readDiskEntries(): OrderSkeletonEntry[] {
    return journal.census([]).records;
}

/** Validate a persisted unified snapshot ({version, entries}); null unusable.
 *  Entries missing `model` are tolerated (pre-#model-field rows still resolve). */
function parseStoreDoc(value: unknown): OrderSkeletonEntry[] | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = (value as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return null;
    return entries.map(orderEntryOf).filter((e): e is OrderSkeletonEntry => e !== undefined);
}

function validEntry(e: unknown): e is OrderSkeletonEntry {
    if (!e || typeof e !== "object") return false;
    const r = e as OrderSkeletonEntry;
    return typeof r.id === "string"
        && Array.isArray(r.kinds)
        && (r.kinds as unknown[]).every((k) => typeof k === "string")
        && Array.isArray(r.frags)
        && (r.frags as unknown[]).every((f) => typeof f === "string")
        && typeof r.tagHash === "string"
        && typeof r.lastSeen === "number";
}

/** One snapshot document → its valid skeletons. A document without an
 *  `entries` array is an unknown shape, not an empty store: the journal treats
 *  the throw as an unusable input and keeps the file for diagnosis. */
function parseSnapshotDoc(raw: unknown): OrderSkeletonEntry[] {
    if (!raw || typeof raw !== "object" || !("entries" in raw) || !Array.isArray(raw.entries)) {
        throw new Error("not an order snapshot");
    }
    const entries = raw.entries as unknown[];
    // An invalid record means the document is not fully understood: keep the
    // file (the journal retains any input it could not read) instead of
    // filtering, so a later publish cannot reclaim the dropped records' source.
    if (!entries.every(validEntry)) throw new Error("order snapshot holds an invalid entry");
    return entries;
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

/** Union keyed by id, fresher record wins per id — a restart or sibling lane
 *  cannot clobber another process's skeletons via last-writer-wins (same
 *  discipline as affinity's #1724 merge). */
function mergeEntries(a: OrderSkeletonEntry[], b: OrderSkeletonEntry[]): OrderSkeletonEntry[] {
    const byId = new Map<string, OrderSkeletonEntry>();
    for (const e of a) byId.set(e.id, e);
    for (const e of b) {
        const cur = byId.get(e.id);
        byId.set(e.id, !cur || e.lastSeen >= cur.lastSeen ? e : cur);
    }
    return [...byId.values()];
}

/** Re-apply the store's bounds on the write path: the union is monotonic
 *  (nothing removes other lanes' records), so without the cap the published
 *  leaf would grow one entry per conversation that churns through the
 *  lifetime. Frags can also grow with turn count — the byte budget keeps the
 *  debounced serialization cheap even for a pathological snapshot (freshest
 *  entries kept first). */
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

/** Pre-reclaim coverage (src/snapshot-journal.ts `covers`): does the published
 *  output still dominate every record of this input under the merge rule
 *  above? `normalizeForWrite` applies the entry cap AND the byte budget, so an
 *  input's record can be capped out even though it was parsed and merged.
 *
 *  O(n+m) per leaf, and O(n) for the output across a whole publish: the journal
 *  passes the SAME output reference for every leaf, so the per-id index is
 *  built once and reused — never a rescan of the output per record. */
let coverIndexFor: OrderSkeletonEntry[] | null = null;
let coverIndex: Map<string, OrderSkeletonEntry> = new Map();
function outputCovers(output: OrderSkeletonEntry[], input: OrderSkeletonEntry[]): boolean {
    if (output.length === 0) return input.length === 0;
    if (coverIndexFor !== output) {
        coverIndex = new Map<string, OrderSkeletonEntry>();
        for (const e of output) coverIndex.set(e.id, e);
        coverIndexFor = output;
    }
    for (const rec of input) {
        const kept = coverIndex.get(rec.id);
        // Merge admits a newer record only when it is at least as fresh, so the
        // output must carry this id at `lastSeen >= rec.lastSeen`.
        if (!kept || kept.lastSeen < rec.lastSeen) return false;
    }
    return true;
}

const journal = openSnapshotJournal<OrderSkeletonEntry[]>({
    // Resolver, not `orderFile()`: the path depends on `XDG_STATE_HOME` at call
    // time (see the same note in affinity-persist.ts).
    snapshotPath: orderFile,
    parse: parseSnapshotDoc,
    encode: (entries) => ({ version: 1, entries }),
    merge: (a, b) => mergeEntries(a, b),
    covers: outputCovers,
    log: (level, msg) => log(level, `[session-order] ${msg}`),
});

function writeSnapshotLegacy(): void {
    if (writing) return;
    writing = true;
    try {
        const mine = orderSnapshot();
        const census = journal.census([]);
        const entries = normalizeForWrite(mergeEntries(mine, census.records));
        const result = journal.publish(entries, census);
        if (census.incomplete) {
            const gap = census.retained.length > 0
                ? `${census.retained.length} unreadable input(s) left in place`
                : "some durable input was unreadable or churned";
            log("warn", `[session-order] published ${entries.length} skeleton(s); ${gap} and still missing from this view`);
        } else if (result.reclaimed > 0 && entries.length !== mine.length) {
            log("info", `[session-order] write merged ${entries.length} skeleton(s) across instances and reclaimed ${result.reclaimed} journal leaf(s)`);
        }
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
        const fileEntries = readDiskEntries();
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

/** Load the state a previous process left behind. Call once on boot. A missing
 *  legacy file with no journal is a no-op first boot; an unreadable/corrupt
 *  input is reported and LEFT IN PLACE (the journal never deletes what it could
 *  not read, so a human can still inspect it). */
export function hydrateOrderSkeletons(): void {
    try {
        const census = journal.census([]);
        for (const w of census.warnings) log("warn", `[session-order] hydrate: ${w}`);
        const imported = applyOrderSnapshot(census.records);
        if (imported > 0) {
            log("info", `[session-order] hydrated ${imported} skeleton(s) from ${path.basename(orderFile())} + ${census.leaves.length} journal leaf(s) — persona resolution survives restarts (#3397)`);
        }
    } catch (e) {
        log("warn", `[session-order] hydrate failed (${e instanceof Error ? e.message : String(e)}); starting with empty skeletons`);
    }
}
