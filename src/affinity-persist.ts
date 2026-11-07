import path from "node:path";
import { prefixAffinity, type AffinitySnapshotEntry, MAX_TRACKED_SESSIONS } from "./prefix-affinity.js";
import { stateDir } from "./paths.js";
import { log } from "./logger.js";
import { openSnapshotJournal } from "./snapshot-journal.js";

/**
 * #499 P1a: prefix-affinity persistence. The anonymous affinity chains were
 * pure in-memory (#309), so a proxy restart orphaned every anonymous session:
 * the next replay forked a fresh session with zero compression state and
 * resent the raw history (#351 — 458K tokens, 0% cache). The chains are
 * small (≤1024 sessions × ≤128 hashes); persist them to the state dir and
 * hydrate on boot.
 *
 * Every write goes through the immutable-publication journal
 * (src/snapshot-journal.ts): the legacy `prefix-affinity.json` is the read
 * BASELINE and is never rewritten, and each write publishes a never-reused
 * leaf that concurrent readers union. That ends the shared-`prefix-affinity.json.tmp`
 * RMW race between the launcher's proxy and a host-owned copy sharing one
 * state dir — two writers could previously drop each other's merged chains
 * inside the read→rename window (the process-local `writing` flag guarded
 * nothing across processes).
 */

/** #1834: quiesce window. Every chain mutation restarts this debounce (a
 *  busy proxy would otherwise push the write out indefinitely and a SIGKILL
 *  lost EVERYTHING since the last flush, not just 5s worth), and the
 *  max-delay budget caps how long a pending write can be starved: the file
 *  is on disk within ~500ms of the last mutation, or within 5s under
 *  sustained traffic — previously a flat 5s trailing window. */
const PERSIST_DEBOUNCE_MS = 500;
const PERSIST_MAX_DELAY_MS = 5_000;

function affinityFile(): string {
    return path.join(stateDir(), "prefix-affinity.json");
}

function validEntry(e: unknown): e is AffinitySnapshotEntry {
    if (!e || typeof e !== "object") return false;
    const r = e as AffinitySnapshotEntry;
    return typeof r.sessionId === "string"
        && typeof r.depth === "number"
        && typeof r.tailHash === "string"
        && Array.isArray(r.itemHashes)
        && (r.itemHashes as unknown[]).every((h) => typeof h === "string")
        && typeof r.lastSeen === "number";
}

/** One snapshot document → its entries. A document without an `entries` array,
 *  or one holding an invalid record, is not "empty" and not silently filtered:
 *  it is shape this build cannot fully trust, so the journal keeps the file and
 *  never reclaims it. Filtering here would let a later publish delete the only
 *  copy of the records it dropped. */
function parseSnapshotDoc(raw: unknown): AffinitySnapshotEntry[] {
    if (!raw || typeof raw !== "object" || !("entries" in raw) || !Array.isArray(raw.entries)) {
        throw new Error("not an affinity snapshot");
    }
    const entries = raw.entries as unknown[];
    if (!entries.every(validEntry)) throw new Error("affinity snapshot holds an invalid entry");
    return entries;
}

/** #1724: union keyed by sessionId with per-id depth/freshness merge — a
 *  restart or sibling lane can no longer clobber another process's chains
 *  via whole-file last-writer-wins (generalizes #405's "keep fresher" to a
 *  store with no global counter). */
function mergeEntries(a: AffinitySnapshotEntry[], b: AffinitySnapshotEntry[]): AffinitySnapshotEntry[] {
    const byId = new Map<string, AffinitySnapshotEntry>();
    for (const e of a) byId.set(e.sessionId, e);
    for (const e of b) {
        const cur = byId.get(e.sessionId);
        if (!cur) {
            byId.set(e.sessionId, e);
            continue;
        }
        byId.set(e.sessionId, e.depth > cur.depth || (e.depth === cur.depth && e.lastSeen >= cur.lastSeen) ? e : cur);
    }
    return [...byId.values()];
}

/** Same-depth, different-tail pairs are a divergence (fork) — the merge picks
 *  the fresher one, so the caller can report how many raced. */
function countSameDepthForks(a: AffinitySnapshotEntry[], b: AffinitySnapshotEntry[]): number {
    const byId = new Map(b.map((e) => [e.sessionId, e] as const));
    let forks = 0;
    for (const m of a) {
        const d = byId.get(m.sessionId);
        if (d && d.depth === m.depth && d.tailHash !== m.tailHash) forks++;
    }
    return forks;
}

/** The union is monotonic (nothing removes other lanes' chains), so without
 *  re-applying the store's own bound the published leaf would grow one entry
 *  per chain that churns through the LRU cap over a process's lifetime. Mirror
 *  the store's semantics on the write path (#1724 permanence: chains never
 *  expire with time — only the LRU cap applies, most-recently-seen first). */
function normalizeForWrite(entries: AffinitySnapshotEntry[]): AffinitySnapshotEntry[] {
    if (entries.length <= MAX_TRACKED_SESSIONS) return entries;
    return [...entries].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_TRACKED_SESSIONS);
}

/** Pre-reclaim coverage (src/snapshot-journal.ts `covers`): does the published
 *  output still dominate every record of this input under the merge rule
 *  above? `normalizeForWrite` can drop an input's record that no other input
 *  and not this process held, so merging is NOT enough to license deleting it.
 *
 *  O(n+m) per leaf, and O(n) for the output across a whole publish: the journal
 *  passes the SAME output reference for every leaf, so the per-id winner index
 *  is built once and reused. Nothing scans the output per record (that would be
 *  quadratic over a 1024-entry cap). */
let coverIndexFor: AffinitySnapshotEntry[] | null = null;
let coverIndex: Map<string, AffinitySnapshotEntry> = new Map();
function outputCovers(output: AffinitySnapshotEntry[], input: AffinitySnapshotEntry[]): boolean {
    if (output.length === 0) return input.length === 0;
    if (coverIndexFor !== output) {
        coverIndex = new Map<string, AffinitySnapshotEntry>();
        for (const e of output) coverIndex.set(e.sessionId, e);
        coverIndexFor = output;
    }
    for (const rec of input) {
        const kept = coverIndex.get(rec.sessionId);
        // Same-id: the output's record must be the one mergeEntries would have
        // chosen over this input (`e.depth > cur.depth || (equal && fresher)`).
        if (!kept || !(kept.depth > rec.depth || (kept.depth === rec.depth && kept.lastSeen >= rec.lastSeen))) return false;
    }
    return true;
}

const journal = openSnapshotJournal<AffinitySnapshotEntry[]>({
    // A resolver, not `affinityFile()`: the path depends on `XDG_STATE_HOME` at
    // call time, and a module-load-time call would freeze the pre-test/pre-move
    // directory for the life of the process.
    snapshotPath: affinityFile,
    parse: parseSnapshotDoc,
    encode: (entries) => ({ version: 1, entries }),
    merge: (a, b) => mergeEntries(a, b),
    covers: outputCovers,
    log: (level, msg) => log(level, `[prefix-affinity] ${msg}`),
});

let timer: NodeJS.Timeout | null = null;
let writing = false;
let pendingSince: number | null = null;

function writeSnapshot(): void {
    if (writing) return;
    writing = true;
    try {
        const mine = prefixAffinity.exportSnapshot();
        const census = journal.census([]);
        const entries = normalizeForWrite(mergeEntries(mine, census.records));
        const result = journal.publish(entries, census);
        if (census.incomplete) {
            // Partial coverage is a REPORTING fact, not a reclamation veto: the
            // valid inputs whose records are in `entries` were reclaimed above;
            // whatever we could not see stays on disk untouched.
            const gap = census.retained.length > 0
                ? `${census.retained.length} unreadable input(s) left in place`
                : "some durable input was unreadable or churned";
            log("warn", `[prefix-affinity] published ${entries.length} chain(s); ${gap} and still missing from this view`);
        } else if (census.leaves.length > 0) {
            const mineIds = new Set(mine.map((e) => e.sessionId));
            const preserved = entries.filter((e) => !mineIds.has(e.sessionId)).length;
            const forks = countSameDepthForks(mine, census.records);
            if (preserved > 0 || forks > 0) {
                log("info", `[prefix-affinity] write merged ${entries.length} chain(s): kept ${preserved} foreign, resolved ${forks} same-depth fork(s), reclaimed ${result.reclaimed} journal leaf(s) (#1724)`);
            }
        }
    } catch (e) {
        log("warn", `[prefix-affinity] persist failed (${e instanceof Error ? e.message : String(e)}); affinity survives in memory`);
    } finally {
        writing = false;
        pendingSince = null;
    }
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
            writeSnapshot();
        },
        Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, budget)),
    );
    timer.unref?.();
}

/** Immediate snapshot write — shutdown path. */
export function flushPrefixAffinity(): void {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    writeSnapshot();
}

/** Load the state a previous process left behind. Call once on boot.
 *
 *  Reads the legacy snapshot AND every published journal leaf, so a restart
 *  sees the union of what every instance on this state dir published. The
 *  legacy file is never rewritten or deleted here — an older client that only
 *  knows `prefix-affinity.json` keeps reading the last pre-journal state
 *  instead of a half-migrated one (mixed-version visibility is NOT backported;
 *  see the journal's module doc). */
export function hydratePrefixAffinity(): void {
    try {
        const census = journal.census([]);
        for (const w of census.warnings) log("warn", `[prefix-affinity] hydrate: ${w}`);
        const imported = prefixAffinity.importSnapshot(census.records);
        if (imported > 0) {
            log("info", `[prefix-affinity] hydrated ${imported} chain(s) from ${path.basename(affinityFile())} + ${census.leaves.length} journal leaf(s) — anonymous sessions reattach across restarts`);
        }
    } catch (e) {
        log("warn", `[prefix-affinity] hydrate failed (${e instanceof Error ? e.message : String(e)}); starting with empty affinity`);
    }
}
