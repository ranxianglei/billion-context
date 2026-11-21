import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Explicit fork lineage for opencode sessions, read from the client's own
 * local SQLite database (the proxy-side complement of the Claude transcript
 * lineage in claude-transcript-lineage.ts).
 *
 * opencode (V2 lane) records a fork's parent in `session_v2.fork_session_id`
 * in its local DB. The host plugin only learns the parent from the
 * `session.created` event's `parentID`, which some opencode builds do not emit
 * on fork — so the proxy never learns the true parent, the byte-exact resume
 * match (which cannot see a mid-chain fork) misses, and the similarity-based
 * weak-adopt picks a globally-closest chain that can be an UNRELATED session
 * (#7421).
 *
 * Trust: the DB is a local file, so the caller only consults this for loopback
 * requests on the opencode lane. The parent it names still has to be a session
 * this proxy knows (the caller verifies via loadParent), and inheritance stays
 * content-addressed, so a wrong or stale lineage can at worst inherit nothing.
 *
 * Degrades gracefully: node:sqlite absent (Node < 22.5), DB missing, table
 * absent, or any read error → undefined, and the caller keeps its current
 * behavior. Never throws on the request path.
 */

const require = createRequire(import.meta.url);

// node:sqlite is a builtin on Node ≥ 22.5 (experimental there, stable on 24);
// engines allow Node ≥ 20, so load it lazily and treat absence as "no lineage".
// @types/node has no node:sqlite declarations, so a minimal structural type.
type SqliteStatement = { get(...params: unknown[]): unknown };
type SqliteDatabase = { prepare(sql: string): SqliteStatement; close(): void };
type SqliteModule = { DatabaseSync: new (filePath: string, options?: { readOnly?: boolean }) => SqliteDatabase };

let sqliteModule: SqliteModule | undefined | null = null; // null = not yet tried
function loadSqlite(): SqliteModule | undefined {
    if (sqliteModule !== null) return sqliteModule;
    try {
        sqliteModule = require("node:sqlite") as SqliteModule;
    } catch {
        sqliteModule = undefined;
    }
    return sqliteModule;
}

// opencode data dir: $XDG_DATA_HOME/opencode or ~/.local/share/opencode.
function opencodeDataDir(): string {
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    return path.join(base, "opencode");
}

// Candidate DB paths: OPENCODE_DB (explicit) first, then the data dir's
// opencode.db + opencode-<channel>.db variants (the CLI picks the file by
// channel; we cannot know it, so try every candidate). An EMPTY result is
// not cached: the DB may not exist yet at first probe (fresh machine, proxy
// started before opencode's first run) and must be re-probed next session.
let candidatePaths: string[] | undefined;
function candidateDbPaths(): string[] {
    if (candidatePaths !== undefined) return candidatePaths;
    const paths: string[] = [];
    const explicit = process.env.OPENCODE_DB;
    if (explicit && explicit !== ":memory:") paths.push(explicit);
    const dir = opencodeDataDir();
    try {
        for (const name of fs.readdirSync(dir)) {
            if (name === "opencode.db" || (name.startsWith("opencode-") && name.endsWith(".db"))) {
                paths.push(path.join(dir, name));
            }
        }
    } catch {
        // data dir absent — no candidates
    }
    if (paths.length > 0) candidatePaths = paths;
    return paths;
}

// Per-session fork parent: a session's fork parent never changes, so cache
// both hits and misses (a miss means "not an opencode fork in any candidate
// DB" — re-querying would just re-read the same immutable row).
const forkParentCache = new Map<string, string | undefined>();

function cacheAndReturn(sessionId: string, value: string | undefined): string | undefined {
    forkParentCache.set(sessionId, value);
    return value;
}

/**
 * Look up the fork parent recorded in opencode's `session_v2` table for the
 * given session id. Returns the parent session id, or undefined when the
 * lineage is unavailable (not an opencode fork, DB missing, no node:sqlite,
 * …). The caller must still verify the parent is a session this proxy knows.
 */
export function opencodeForkParent(sessionId: string): string | undefined {
    if (forkParentCache.has(sessionId)) return forkParentCache.get(sessionId);
    const sqlite = loadSqlite();
    if (sqlite === undefined) return cacheAndReturn(sessionId, undefined);
    for (const dbPath of candidateDbPaths()) {
        let db: SqliteDatabase | undefined;
        try {
            db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
            const row = db.prepare("SELECT fork_session_id FROM session_v2 WHERE id = ?").get(sessionId) as { fork_session_id?: string | null } | undefined;
            const parent = row?.fork_session_id;
            if (typeof parent === "string" && parent.length > 0 && parent !== sessionId) {
                return cacheAndReturn(sessionId, parent);
            }
        } catch {
            // DB missing/locked/table absent — try the next candidate
        } finally {
            try { db?.close(); } catch { /* ignore close errors */ }
        }
    }
    return cacheAndReturn(sessionId, undefined);
}

/** Test seam: clear the per-process caches (candidate DB paths, per-session
 *  fork-parent results, the node:sqlite probe) so a test can repoint
 *  XDG_DATA_HOME / OPENCODE_DB and re-probe. */
export function _resetOpencodeForkLineageForTest(): void {
    forkParentCache.clear();
    candidatePaths = undefined;
    sqliteModule = null;
}
