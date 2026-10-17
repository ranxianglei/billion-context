import fs from "node:fs";
import path from "node:path";
// Runtime (not type-only) import: this module and session-resolve form an ESM
// cycle — each uses the other's exports only inside function bodies (never at
// module evaluation), so both load orders initialize cleanly.
import { applyOrderSnapshot, orderSnapshot, type OrderSkeletonEntry } from "./session-resolve.js";
import { stateDir } from "./paths.js";
import { log } from "./logger.js";

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
// proxy must not starve the write indefinitely, and disk stays within ~500ms
// of the last mutation (or 5s under sustained traffic).
const PERSIST_DEBOUNCE_MS = 500;
const PERSIST_MAX_DELAY_MS = 5_000;
const MAX_ORDER_ENTRIES = 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

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
            (e): e is OrderSkeletonEntry =>
                !!e && typeof e === "object" &&
                typeof (e as OrderSkeletonEntry).id === "string" &&
                Array.isArray((e as OrderSkeletonEntry).kinds) &&
                ((e as OrderSkeletonEntry).kinds as unknown[]).every((k) => typeof k === "string") &&
                Array.isArray((e as OrderSkeletonEntry).frags) &&
                ((e as OrderSkeletonEntry).frags as unknown[]).every((f) => typeof f === "string") &&
                typeof (e as OrderSkeletonEntry).tagHash === "string" &&
                typeof (e as OrderSkeletonEntry).lastSeen === "number",
        );
    } catch {
        return null;
    }
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

function writeSnapshot(): void {
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

/** Load the snapshot a previous process left behind. Call once on boot. A
 *  missing file is a no-op first boot; an unreadable/corrupt one degrades to a
 *  warning + empty skeletons (the next flush heals the file). */
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
