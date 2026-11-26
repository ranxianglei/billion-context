/**
 * #5108/#4816: corruption-shaped SQLite error classification.
 *
 * PRAGMA quick_check has TWO failure shapes: it can RETURN non-ok verdict
 * rows (page-level damage), or it can THROW out of the statement itself
 * (truncated file, garbage header, broken overflow chain — probe-verified on
 * node:sqlite v22: ERR_SQLITE_ERROR with the raw sqlite3_errmsg text). The
 * #4175 decision chain (alarm + start WITHOUT the index, files left exactly
 * in place — no automatic file moves and no auto-rebuild, per the 2026-10-30
 * owner follow-up, final form) originally saw only the verdict-row shape, so
 * every throwing corruption escaped as a raw driver error that neither the
 * alarm nor the classification handled.
 *
 * This classifier maps the throwing shapes onto the same decision. It
 * matches ONLY SQLITE_CORRUPT / SQLITE_NOTADB:
 *   - better-sqlite3 stamps err.code with the symbolic name ("SQLITE_CORRUPT",
 *     "SQLITE_NOTADB");
 *   - node:sqlite throws ERR_SQLITE_ERROR whose message IS the stable English
 *     errmsg text ("database disk image is malformed" / "file is not a
 *     database") — matched by substring, which also catches the
 *     [storage:<engine>] wrapper prefix openSqliteDatabase adds.
 *
 * Transient shapes MUST NOT match: BUSY/LOCKED (a live foreign process —
 * the supported shared-directory topology, #3923/#3959), IOERR (Windows
 * Defender real-time scan / sync-folder locks, #362 class), CANTOPEN
 * (permissions). Quarantining a merely locked-but-healthy index over a
 * transient condition would destroy a working index — the exact opposite of
 * what recovery is for.
 *
 * NOTE: the background-check worker (integrity-check.ts WORKER_SOURCE) is
 * bundled VERBATIM into dist and cannot import this module — it carries an
 * inlined copy of these matchers. Keep the two in sync (the worker-facet
 * regression test pins the behavior end to end).
 */

const CORRUPTION_ERRMSG_MARKERS = [
    "database disk image is malformed", // SQLITE_CORRUPT
    "file is not a database", // SQLITE_NOTADB
];

/** Returns the error detail when `err` is a corruption-shaped SQLite failure,
 *  null otherwise. */
export function sqliteCorruptionDetail(err: unknown): string | null {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string") {
        const upper = code.toUpperCase();
        if (upper === "SQLITE_CORRUPT" || upper === "SQLITE_NOTADB") {
            return err instanceof Error ? err.message : String(err);
        }
    }
    const msg = err instanceof Error ? err.message : String(err ?? "");
    for (const marker of CORRUPTION_ERRMSG_MARKERS) {
        if (msg.includes(marker)) return msg;
    }
    return null;
}
