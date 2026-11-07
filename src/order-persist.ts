import path from "node:path";
// Runtime (not type-only) import: this module and session-resolve form an ESM
// cycle — each uses the other's exports only inside function bodies (never at
// module evaluation), so both load orders initialize cleanly.
import { applyOrderSnapshot, orderSnapshot, type OrderSkeletonEntry } from "./session-resolve.js";
import { stateDir } from "./paths.js";
import { log } from "./logger.js";
import { openSnapshotJournal } from "./snapshot-journal.js";

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
// proxy must not starve the write indefinitely, and disk stays within ~500ms
// of the last mutation (or 5s under sustained traffic).
const PERSIST_DEBOUNCE_MS = 500;
const PERSIST_MAX_DELAY_MS = 5_000;
const MAX_ORDER_ENTRIES = 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

function orderFile(): string {
    return path.join(stateDir(), "session-order.json");
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

let timer: NodeJS.Timeout | null = null;
let writing = false;
let pendingSince: number | null = null;

function writeSnapshot(): void {
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

/** Debounced snapshot write — called from the resolver after every record
 *  mutation. The trailing debounce quiesces bursts; the max-delay budget
 *  guarantees the write still lands under sustained traffic. */
export function scheduleOrderPersist(): void {
    const now = Date.now();
    if (pendingSince === null) pendingSince = now;
    if (timer) clearTimeout(timer);
    const budget = PERSIST_MAX_DELAY_MS - (now - pendingSince);
    timer = setTimeout(
        () => {
            timer = null;
            writeSnapshot();
        },
        Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, budget)),
    );
    timer.unref?.();
}

/** Immediate snapshot write — shutdown/restart path. */
export function flushOrderSkeletons(): void {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    writeSnapshot();
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
