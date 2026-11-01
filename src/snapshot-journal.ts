import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Immutable-publication journal for the two machine-global state snapshots
 * (src/affinity-persist.ts, src/order-persist.ts).
 *
 * Replaces whole-file RMW against ONE shared `<name>.json.tmp` renamed over
 * `<name>.json`, guarded only by a process-local flag: two instances on one
 * state dir (#4125) raced and the later rename clobbered the earlier writer's
 * merged content (#1724/#3397).
 *
 * Layout (posix rename semantics; no locks, no PID/mtime reaping — reaping a
 * "stale" lock is the correctness hole this design deletes):
 *
 *   <snapshot>                  legacy BASELINE: read, never rewritten or
 *                               removed, so a pre-journal client keeps reading
 *                               the last consistent pre-migration state. New
 *                               visibility is NOT backported to it.
 *   <snapshot>.journal/         publications live here.
 *     pub-<hex>-<hex>/          IMMUTABLE output; never reused or rewritten.
 *       snapshot.json           its single fsynced payload.
 *     .staging-<hex>-<hex>/     private in-progress publication; invisible to
 *                               every reader and reclaimer.
 *
 * Why a DIRECTORY, not a partially copied target: a complete payload becomes
 * visible through one atomic rename without requiring hard-link support. A
 * unique name is never reused; directory rename cannot replace an existing
 * nonempty publication. File fsync precedes visibility, but power-loss
 * durability still requires both directory barriers below.
 *
 * Durability order (each barrier is checked, never assumed): fsync payload
 * file → fsync its STAGING DIRECTORY (persists the payload name) → atomic
 * rename onto a unique never-reused `pub-*` name → fsync the JOURNAL PARENT →
 * only then reclaim exact consumed inputs → fsync the parent again. Fsyncing
 * the file and the outer parent alone would miss the inner directory entry.
 * Where directory fsync is unsupported or fails, publication remains visible
 * but is not proven power-loss durable. Retain every input in that case;
 * never mistake a failed barrier for permission to reclaim.
 *
 * Conservation (per-input, not all-or-nothing): for every input the census
 * either parsed it and merged its records into the output — deleting it loses
 * nothing — or could not read it, in which case it is never in `consumed`,
 * never deleted, and reported in `retained`. The output is always a superset of
 * what was reclaimed, whatever else is corrupt; `incomplete` is reporting, not
 * a reclamation veto. Reclaim unlinks the one known payload and removes the
 * now-empty directory — never a recursive delete of unknown contents.
 *
 * Concurrent compactors are fine: each publishes what IT read and deletes only
 * those exact names; the next reader unions survivors and the next writer folds
 * them.
 *
 * Honest limitations: a pre-journal client never sees post-migration writes; a
 * churned census retries a bounded number of times then publishes while
 * deleting nothing; a corrupt publication or baseline is kept, never read as
 * empty; a process killed before the rename leaves its `.staging-*` dir behind
 * forever — deliberately not reaped, since deciding a writer is dead from an
 * mtime or PID could delete a live writer's staging dir mid-rename. Debris,
 * corrupt inputs, and unreclaimed publications on filesystems without working
 * directory barriers are therefore not globally disk-bounded.
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
    /** Inputs whose records are in `records` — the ONLY ones deletable. */
    consumed: string[];
    /** Inputs the census could not parse or read; left untouched. */
    retained: string[];
    /** The census could not see the whole store; `records` may be partial —
     *  never read an empty result as "the store is empty". */
    incomplete?: boolean;
    /** What the census had to skip. Never contains payloads. */
    warnings: string[];
}

interface PublishResult {
    /** The immutable published name (`null` when nothing was published). */
    published: string | null;
    /** Inputs deleted because their records are in this output. */
    reclaimed: number;
    /** Inputs left in place (unreadable/ill-shaped, or a churned census). */
    retained: number;
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
    /** Structured log sink (the caller's own logger). */
    log?: (level: "info" | "warn", msg: string) => void;
}

/** `<snapshot>.journal/` — publications live here, beside the legacy file
 *  (never inside a directory the legacy client walks for its own data). */
export function journalDirOf(snapshotPath: string): string {
    return `${snapshotPath}.journal`;
}

function uniqueSuffix(): string {
    // Two writers on the same millisecond must not pick the same name: the
    // random half is the guarantee, the counter half is human-readable order.
    return `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

function isPublishedName(name: string): boolean {
    return name.startsWith(PUBLISHED_PREFIX);
}

/** fsync a directory so a rename/unlink inside it survives a crash. Returns
 *  false when the platform cannot do it (Windows EISDIR/EPERM, some network
 *  mounts): durability is then "as the platform permits" and the caller must
 *  not reclaim inputs. A real I/O error likewise returns false. */
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

/** Create+fsync a private staging payload, then publish it by renaming the
 *  whole staging DIRECTORY onto a never-reused name (module header explains
 *  why). False ⇒ not durable, so nothing may be reclaimed. */
/** Remove OUR OWN staging dir: our payload, then the directory. Never
 *  recursive — an unexpected file inside is not ours to destroy. */
function dropStaging(staging: string): void {
    try { fs.unlinkSync(path.join(staging, SNAPSHOT_PAYLOAD)); } catch { /* not created yet */ }
    try { fs.rmdirSync(staging); } catch { /* not empty = grew something we did not write; leave it */ }
}

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
        // Our own staging debris only — never a published name.
        try { dropStaging(staging); } catch { /* report the real error */ }
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

    /** Resolved legacy path for THIS operation (see `snapshotPath`). */
    private snapshotPath(): string {
        const p = this.opts.snapshotPath;
        return typeof p === "function" ? p() : p;
    }

    /** Apply the configured merge policy (the journal owns it, so callers do
     *  not restate it). */
    mergeWith(a: T, b: T): T {
        return this.opts.merge(a, b);
    }

    /** Merge durable inputs then `own` — oldest first, so the newest wins an
     *  exact tie (the stores break ties toward their second argument). */
    private mergeChain(baseline: T | null, leaves: readonly T[], own: T): T {
        let acc: T | null = baseline;
        for (const leaf of leaves) acc = acc === null ? leaf : this.opts.merge(acc, leaf);
        return acc === null ? own : this.opts.merge(acc, own);
    }

    /** Read + merge durable state; `own` is merged on top. Never throws and
     *  never deletes anything. */
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
            const leaves: Array<{ name: string; data: T }> = [];
            const retained: string[] = [];
            let vanished = false;
            for (const name of listed) {
                let raw: string;
                try {
                    raw = fs.readFileSync(path.join(dir, name, SNAPSHOT_PAYLOAD), "utf8");
                } catch (e) {
                    const code = (e as NodeJS.ErrnoException).code;
                    if (code === "ENOENT") {
                        // (a) a sibling reclaimed the whole publication after
                        // folding it into a durable one — our listing is stale, so
                        // re-list. (b) the directory survives with its payload
                        // gone (a compactor died mid-reclaim): permanently
                        // unreadable, and re-listing would hide every OTHER input.
                        let live = true;
                        try { fs.statSync(path.join(dir, name)); } catch { live = false; }
                        if (!live) { vanished = true; continue; }
                        retained.push(name);
                        warnings.push(`publication ${name} has no payload; left in place`);
                        continue;
                    }
                    retained.push(name);
                    warnings.push(`publication ${name} unreadable (${code ?? "error"}); left in place`);
                    continue;
                }
                const data = this.decode(raw);
                if (data === null) {
                    retained.push(name);
                    warnings.push(`publication ${name} is corrupt; left in place`);
                    continue;
                }
                leaves.push({ name, data });
            }
            if (vanished) continue;

            const baseline = this.readLegacy(warnings);
            // Oldest→newest: baseline < published inputs < own. `merge` breaks
            // exact ties toward its SECOND argument, so the newer source wins.
            const records = this.mergeChain(baseline, leaves.map((l) => l.data), own);
            // Conservation: every `consumed` name was parsed AND its records are
            // in `records`. Corrupt inputs are `retained`, never passed to publish.
            const incomplete = retained.length > 0 || this.legacyUnreadable;
            return {
                records,
                consumed: leaves.map((l) => l.name),
                retained,
                incomplete: incomplete || undefined,
                warnings,
            };
        }
        // Unreadable journal or repeated churn: the caller publishes but
        // deletes nothing.
        return {
            records: this.mergeChain(this.readLegacy(warnings), [], own),
            consumed: [],
            retained: [],
            incomplete: true,
            warnings: [
                ...warnings,
                unreadable
                    ? "journal directory unreadable; publishing own state without reclaiming anything"
                    : `journal census churned ${CENSUS_ATTEMPTS}× (concurrent compactions); publishing own state without reclaiming anything`,
            ],
        };
    }

    /** Publish `data` as one immutable output, then reclaim the inputs whose
     *  records it includes. `consumed` MUST be exactly the names the merged
     *  view covered; an empty list publishes without reclaiming. Throws only if
     *  the output could not be published; a publication that could not be made
     *  durable reclaims NOTHING. */
    publish(data: T, consumed: readonly string[]): PublishResult {
        const dir = journalDirOf(this.snapshotPath());
        const leaf = `${PUBLISHED_PREFIX}${uniqueSuffix()}`;
        fs.mkdirSync(dir, { recursive: true });
        const durable = publishAtomic(dir, leaf, JSON.stringify(this.opts.encode(data)));
        if (!durable) {
            const merged = consumed.filter(isPublishedName).length;
            // The staging dir was renamed onto `leaf`, but its journal entry is
            // not proven durable: a visible leaf may exist that a crash could
            // lose. Reclaim NOTHING — the inputs it covers are still on disk.
            this.opts.log?.("warn", `snapshot journal ${path.basename(dir)}: publication ${leaf} is not durable; reclaiming nothing`);
            return { published: leaf, reclaimed: 0, retained: merged };
        }
        let reclaimed = 0;
        let retained = 0;
        for (const name of consumed) {
            if (!isPublishedName(name)) continue; // only publications are ever inputs
            const inputDir = path.join(dir, name);
            try {
                // Payload first, then the directory: a crash between the two
                // leaves a publication with no payload, which the next census
                // sees as a vanished input and re-reads — never as a record.
                fs.unlinkSync(path.join(inputDir, SNAPSHOT_PAYLOAD));
                fs.rmdirSync(inputDir);
                reclaimed++;
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // sibling won
                retained++;
            }
        }
        if (reclaimed > 0) fsyncDir(dir);
        return { published: leaf, reclaimed, retained };
    }

    private listPublished(dir: string, warnings: string[]): string[] | null {
        try {
            return fs.readdirSync(dir).filter(isPublishedName).sort();
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return []; // no journal yet
            // An unreadable journal is NOT an empty one: returning [] here would
            // let a publish flatten a store we could not list. The caller marks
            // the census incomplete and reclaims nothing.
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
                // Present but unreadable: its records are invisible to us, so
                // the census is partial and must say so.
                warnings.push(`legacy snapshot ${path.basename(file)} unreadable (${code ?? "error"}); kept in place`);
                this.legacyUnreadable = true;
            }
            return null;
        }
        const data = this.decode(raw);
        if (data === null) {
            // Unparseable: NEVER read as "empty" (that would let the next
            // publish represent a store we simply failed to read) and never
            // delete it — a human may still need it.
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
