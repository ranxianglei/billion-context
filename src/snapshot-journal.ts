import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Immutable-publication journal for the two machine-global state snapshots
 * (src/affinity-persist.ts, src/order-persist.ts). Replaces whole-file RMW
 * against ONE shared `<name>.json.tmp` renamed over `<name>.json` guarded only
 * by a process-local flag: two instances on one state dir (#4125) raced and the
 * later rename clobbered the earlier writer's merged content (#1724/#3397).
 *
 * Layout (posix rename semantics; no locks and no PID/mtime reaping — treating
 * a lock as stale is the correctness hole this design deletes). A DIRECTORY
 * because complete bytes become visible through one atomic rename without hard
 * links, and directory rename cannot replace a nonempty one:
 *
 *   <snapshot>              legacy BASELINE: read, never rewritten or removed, so
 *                           a pre-journal client reads the last consistent state;
 *                           new visibility is NOT backported to it.
 *   <snapshot>.journal/
 *     pub-<hex>-<hex>/      IMMUTABLE output; never reused or rewritten.
 *       snapshot.json       its single fsynced payload.
 *     .staging-<hex>-<hex>/ private in-progress publication; invisible to every
 *                           reader and reclaimer.
 *
 * Durability order (every barrier checked, never assumed): fsync payload →
 * fsync its STAGING DIRECTORY (persists the payload name) → atomic rename onto
 * a unique never-reused `pub-*` name → fsync the JOURNAL PARENT → only then
 * reclaim covered inputs → fsync the parent again. Fsyncing the file and outer
 * parent alone would miss the inner directory entry. Without a working
 * directory barrier the publication stays visible but is not proven power-loss
 * durable: retain every input instead of reading a failed barrier as permission
 * to reclaim.
 *
 * Conservation: an input the census could not read is never among its `leaves`,
 * never deleted, and reported in `retained`. Parsing is necessary but not
 * sufficient — both stores BOUND what they write (entry cap, byte budget), so a
 * merged view can legitimately drop a record one input held alone. Reclaim
 * therefore judges each leaf by the data the CENSUS parsed from it (never a
 * caller-supplied name) and asks the caller's `covers`, the store's own
 * dominance rule; a leaf the output does not dominate stays and is counted
 * `uncovered`, because a bounded output is no claim about the whole on-disk
 * store. `incomplete` reports, it does not veto reclamation. Reclaim unlinks the
 * one known payload then removes the now-empty directory — never a recursive
 * delete of unknown contents. Concurrent compactors are fine: each publishes
 * what IT read and reclaims only inputs it verified; the next reader unions
 * survivors and the next writer folds them.
 *
 * Not globally disk-bounded: debris, corrupt inputs and unreclaimed publications
 * (without a working directory barrier) can keep growing the store — operating
 * caveats live in reference/architecture.md and the CHANGELOG entry.
 */

/** Retry budget for a census whose inputs vanished mid-read (a sibling took
 *  one we listed). It settles quickly: every compactor removes what it read. */
const CENSUS_ATTEMPTS = 4;

const PUBLISHED_PREFIX = "pub-";
const STAGING_PREFIX = ".staging-";
export const SNAPSHOT_PAYLOAD = "snapshot.json";

interface JournaledSnapshot<T> {
    /** Baseline + every valid publication, merged by the caller's policy,
     *  plus whatever `merge` was handed as `own`. */
    records: T;
    /** Inputs the census could not parse or read; left untouched. */
    retained: string[];
    /** The census could not see the whole store; `records` may be partial —
     *  never read an empty result as "the store is empty". */
    incomplete?: boolean;
    /** What the census had to skip. Never contains payloads. */
    warnings: string[];
    /** The ONLY deletable inputs, each paired with the records actually parsed
     *  from it: `publish` reclaims against THIS read, never a name alone. */
    leaves: JournalLeaf<T>[];
}

/** One census-parsed input: name, the bytes read, and the records decoded from
 *  them. Keeping the bytes makes "is this still the document I judged?" exact. */
interface JournalLeaf<T> {
    name: string;
    raw: string;
    data: T;
}

interface PublishResult {
    /** The immutable published name (`null` when nothing was published). */
    published: string | null;
    /** Inputs deleted because their records are in this output. */
    reclaimed: number;
    /** Census inputs left in place: `uncovered` ones plus covered leaves whose
     *  bytes a sibling changed or that failed to delete, and — when the
     *  publication was not durable — every leaf. */
    retained: number;
    /** Parsed inputs the output does NOT hold, so `covers` was false. A subset
     *  of `retained`; they stay until a wider output dominates them and are
     *  reported once per publish: a bounded output is never mistaken for
     *  "everything on disk is in here". */
    uncovered: number;
}

interface SnapshotJournalOptions<T> {
    /** Legacy path (or resolver — pass a function when it depends on runtime
     *  state such as `XDG_STATE_HOME`, which a load-time call would freeze). */
    snapshotPath: string | (() => string);
    /** Merge two record sets. MUST apply the store's own per-id merge rules
     *  AND its bounds (LRU/byte caps) — the journal adds no policy of its own. */
    merge: (a: T, b: T) => T;
    /** Decode one document into records. MUST throw if the document or ANY
     *  record in it is invalid: the journal then retains that whole publication
     *  and reports the gap. Never return a filtered subset — that would let a
     *  publication delete the source of the records it silently dropped. */
    parse: (raw: unknown) => T;
    /** Serialize the records into the on-disk document shape. */
    encode: (data: T) => unknown;
    /** Does `output` still hold every record of `input` under the STORE's own
     *  merge/dominance rule? False keeps that input and counts it uncovered.
     *  Required because the stores BOUND what they write, so merging is not
     *  dominance. Runs once per leaf: index one side, stream the other. */
    covers: (output: T, input: T) => boolean;
    /** Structured log sink (the caller's own logger). */
    log?: (level: "info" | "warn", msg: string) => void;
}

/** `<snapshot>.journal/` — publications live beside the legacy file, never
 *  inside a directory the legacy client walks for its own data. */
export function journalDirOf(snapshotPath: string): string {
    return `${snapshotPath}.journal`;
}

function uniqueSuffix(): string {
    // Two writers on one millisecond must not collide: random is the guarantee,
    // the time half is human-readable order.
    return `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

function isPublishedName(name: string): boolean {
    return name.startsWith(PUBLISHED_PREFIX);
}

/** fsync a directory so a rename/unlink inside it survives a crash. False when
 *  the platform cannot do it (Windows EISDIR/EPERM, some network mounts) or on a
 *  real I/O error: durability is then "as the platform permits", so the caller
 *  must not reclaim inputs. */
function fsyncDir(dir: string): boolean {
    let fd: number | undefined;
    try {
        fd = fs.openSync(dir, "r");
    } catch {
        return false;
    }
    try {
        fs.fsyncSync(fd);
        return true;
    } catch {
        return false;
    } finally {
        try { fs.closeSync(fd); } catch { /* already unusable */ }
    }
}

/** Remove OUR OWN staging dir: our payload, then the directory. Never
 *  recursive — an unexpected file inside is not ours to destroy. */
function dropStaging(staging: string): void {
    try { fs.unlinkSync(path.join(staging, SNAPSHOT_PAYLOAD)); } catch { /* not created yet */ }
    try { fs.rmdirSync(staging); } catch { /* grew something we did not write; leave it */ }
}

/** Create+fsync a private staging payload, then publish it by renaming the
 *  whole staging DIRECTORY onto a never-reused name. False ⇒ not durable, so
 *  nothing may be reclaimed. */
function publishAtomic(dir: string, finalName: string, bytes: string): boolean {
    const staging = path.join(dir, `${STAGING_PREFIX}${uniqueSuffix()}`);
    const target = path.join(dir, finalName);
    let fd: number | undefined;
    let stagingDurable = false;
    try {
        fs.mkdirSync(staging, { mode: 0o700 });
        fd = fs.openSync(path.join(staging, SNAPSHOT_PAYLOAD), "wx", 0o600);
        fs.writeFileSync(fd, bytes, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        // Publish complete bytes even where a directory barrier is unsupported,
        // but a failed barrier can never authorize reclamation of prior inputs.
        stagingDurable = fsyncDir(staging);
        // The one atomic step: before it, readers see nothing; after it, the
        // complete payload. A crash here leaves an invisible staging dir.
        fs.renameSync(staging, target);
    } catch (e) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* temp unsynced at worst */ }
        }
        try { dropStaging(staging); } catch { /* ours; report the real error */ }
        throw e;
    }
    const parentDurable = fsyncDir(dir);
    return stagingDurable && parentDurable;
}

class SnapshotJournal<T> {
    /** Baseline exists but cannot be read: its records are missing from every
     *  view we build. */
    private legacyUnreadable = false;

    constructor(private readonly opts: SnapshotJournalOptions<T>) {}

    private snapshotPath(): string {
        const p = this.opts.snapshotPath; // resolved per operation, never frozen
        return typeof p === "function" ? p() : p;
    }

    /** The configured merge policy, exposed so tests need not restate it. */
    mergeWith(a: T, b: T): T { return this.opts.merge(a, b); }

    /** Merge durable inputs then `own`, oldest first: `merge` breaks exact ties
     *  toward its SECOND argument, so the newer source wins. */
    private mergeChain(baseline: T | null, leaves: readonly T[], own: T): T {
        let acc: T | null = baseline;
        for (const leaf of leaves) acc = acc === null ? leaf : this.opts.merge(acc, leaf);
        return acc === null ? own : this.opts.merge(acc, own);
    }

    /** Read + merge durable state; `own` on top. Never throws, never deletes. */
    census(own: T): JournaledSnapshot<T> {
        const dir = journalDirOf(this.snapshotPath());
        const warnings: string[] = [];
        this.legacyUnreadable = false;
        let unreadable = false;
        for (let attempt = 0; attempt < CENSUS_ATTEMPTS && !unreadable; attempt++) {
            const listed = this.listPublished(dir, warnings);
            if (listed === null) {
                unreadable = true; // we cannot see the whole store: reclaim nothing
                break;
            }
            const leaves: JournalLeaf<T>[] = [];
            const retained: string[] = [];
            const keep = (name: string, why: string) => {
                retained.push(name);
                warnings.push(`publication ${name} ${why}; left in place`);
            };
            let vanished = false;
            for (const name of listed) {
                let raw: string;
                try {
                    raw = fs.readFileSync(path.join(dir, name, SNAPSHOT_PAYLOAD), "utf8");
                } catch (e) {
                    const code = (e as NodeJS.ErrnoException).code;
                    if (code !== "ENOENT") { keep(name, `unreadable (${code ?? "error"})`); continue; }
                    // ENOENT is ambiguous: (a) a sibling reclaimed the publication
                    // after folding it into a durable one — a stale listing, so
                    // re-list; (b) the directory survives with its payload gone (a
                    // compactor died mid-reclaim) — permanently unreadable, and
                    // re-listing would hide every OTHER input.
                    let live = true;
                    try { fs.statSync(path.join(dir, name)); } catch { live = false; }
                    if (live) keep(name, "has no payload");
                    else vanished = true;
                    continue;
                }
                const data = this.decode(raw);
                if (data === null) keep(name, "is corrupt");
                else leaves.push({ name, raw, data });
            }
            if (vanished) continue;

            const baseline = this.readLegacy(warnings);
            const records = this.mergeChain(baseline, leaves.map((l) => l.data), own);
            const incomplete = retained.length > 0 || this.legacyUnreadable || undefined;
            return { records, retained, incomplete, warnings, leaves };
        }
        // Unreadable journal or repeated churn: the caller publishes, deletes nothing.
        warnings.push(
            unreadable
                ? "journal directory unreadable; publishing own state without reclaiming anything"
                : `journal census churned ${CENSUS_ATTEMPTS}× (concurrent compactions); publishing own state without reclaiming anything`,
        );
        return { records: this.mergeChain(this.readLegacy(warnings), [], own), retained: [], incomplete: true, warnings, leaves: [] };
    }

    /** Publish `data` as one immutable output, then reclaim only the inputs it
     *  still covers. `census` is the read this view came from, and each leaf is
     *  judged by the data the census ACTUALLY parsed from it: a caller can merge,
     *  then cap, then hand back names whose records the cap dropped, so no
     *  caller name is trusted alone. Reclaims NOTHING unless durable. */
    publish(data: T, census: Pick<JournaledSnapshot<T>, "leaves">): PublishResult {
        const dir = journalDirOf(this.snapshotPath());
        const leaf = `${PUBLISHED_PREFIX}${uniqueSuffix()}`;
        fs.mkdirSync(dir, { recursive: true });
        const bytes = JSON.stringify(this.opts.encode(data));
        if (!publishAtomic(dir, leaf, bytes)) {
            // Renamed into place, but its journal entry is not proven durable: a
            // crash could lose a visible leaf. Reclaim NOTHING.
            this.opts.log?.("warn", `snapshot journal ${path.basename(dir)}: publication ${leaf} is not durable; reclaiming nothing`);
            return { published: leaf, reclaimed: 0, retained: census.leaves.length, uncovered: 0 };
        }
        // Coverage over the whole census BEFORE a single unlink.
        const covering: JournalLeaf<T>[] = [];
        let uncovered = 0;
        for (const input of census.leaves) {
            if (this.opts.covers(data, input.data)) covering.push(input);
            else uncovered++;
        }
        let reclaimed = 0;
        let retained = uncovered; // every uncovered leaf stays
        for (const input of covering) {
            const inputDir = path.join(dir, input.name);
            // A sibling may have reclaimed this leaf or replaced it: only the
            // bytes we covered are ours to delete.
            const current = this.stillParsed(inputDir, input);
            if (current === "missing") continue; // a sibling already reclaimed it
            if (current === "changed") {
                retained++;
                continue;
            }
            try {
                // Payload then directory: a crash between the two leaves a
                // payload-less publication, which the next census treats as a
                // vanished input — never as a record.
                fs.unlinkSync(path.join(inputDir, SNAPSHOT_PAYLOAD));
                fs.rmdirSync(inputDir);
                reclaimed++;
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // sibling won
                retained++;
            }
        }
        if (uncovered > 0) {
            // ONE bounded line per publish: a bounded output is not a claim that
            // every record on disk is inside it.
            this.opts.log?.("warn", `snapshot journal ${path.basename(dir)}: published output ${leaf} does not cover ${uncovered} input(s) (store bound dropped records this output lacks); kept in place`);
        }
        if (reclaimed > 0) fsyncDir(dir);
        return { published: leaf, reclaimed, retained, uncovered };
    }

    /** Is `inputDir` still the exact document the census judged? Byte identity ⇒
     *  the coverage answer for those bytes still applies; anything else
     *  (vanished, replaced, unreadable) is not ours to delete. */
    private stillParsed(inputDir: string, judged: JournalLeaf<T>): "same" | "changed" | "missing" {
        try {
            return fs.readFileSync(path.join(inputDir, SNAPSHOT_PAYLOAD), "utf8") === judged.raw ? "same" : "changed";
        } catch (e) {
            return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "changed";
        }
    }

    private listPublished(dir: string, warnings: string[]): string[] | null {
        try {
            return fs.readdirSync(dir).filter(isPublishedName).sort();
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return []; // no journal yet
            // Unreadable is NOT empty: returning [] would let a publish flatten a
            // store we could not list. The caller marks it incomplete.
            warnings.push(`journal directory ${path.basename(dir)} unreadable (${code ?? "error"}); nothing will be reclaimed`);
            return null;
        }
    }

    private decode(raw: string): T | null {
        try {
            return this.opts.parse(JSON.parse(raw) as unknown);
        } catch {
            return null;
        }
    }

    private readLegacy(warnings: string[]): T | null {
        const file = this.snapshotPath();
        let raw: string;
        try {
            raw = fs.readFileSync(file, "utf8");
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
                // Present but unreadable: its records are invisible, so the
                // census is partial and must say so.
                warnings.push(`legacy snapshot ${path.basename(file)} unreadable (${code ?? "error"}); kept in place`);
                this.legacyUnreadable = true;
            }
            return null;
        }
        const data = this.decode(raw);
        if (data === null) {
            // Unparseable: NEVER "empty" (that would let the next publish claim a
            // store we failed to read) and never deleted.
            warnings.push(`legacy snapshot ${path.basename(file)} is corrupt; treating it as absent and keeping the file`);
            this.legacyUnreadable = true;
            return null;
        }
        return data;
    }
}

/** Convenience wrapper: the journal for one snapshot path. */
export function openSnapshotJournal<T>(opts: SnapshotJournalOptions<T>): SnapshotJournal<T> {
    return new SnapshotJournal<T>(opts);
}
