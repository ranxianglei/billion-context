// #5460 (P1): realtime performance telemetry, SQLite-backed.
//
// Design constraints (owner decisions, 2026-11-01, issue #5460):
//  * Metrics land ONLY in SQLite / database-backed storage modes — never in
//    JSON files. The pure-JSON ("legacy-only") storage mode is frozen: this
//    system has zero footprint there (init("json") is permanently inert).
//  * Telemetry must never break serving: every insert is guarded, and a
//    failure DEGRADES telemetry (one warn + dead flag), never the request
//    path (#5327 adopt discipline: observe without endangering).
//  * The metrics DB is a separate file (perf.sqlite) next to index.db, not a
//    migration of the user's own store: crash/size isolation from index.db,
//    zero schema-version coupling, trivially deletable by the owner.
//  * BILI_PERF_TELEMETRY=0 force-disables (registered in LIFECYCLE.md §2.4).
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as path from "node:path";
import { sessionsDir } from "./paths.js";

export const PERF_DB_FILE = "perf.sqlite";
const PERF_TABLE = "perf_events";
// Amortized retention sweep: keep the observability file bounded (~tens of
// MB at most). Every Nth insert deletes the oldest rows past the cap — one
// indexed range delete per batch, negligible against an 80 MiB parse pass.
const RETENTION_CAP_ROWS = 200_000;
const RETENTION_SWEEP_EVERY = 500;
const RING_SIZE = 500;
const DEFAULT_MEM_INTERVAL_MS = 30_000;
interface InitOptions { dir?: string; memIntervalMs?: number; log?: (level: "warn" | "error" | "info", msg: string) => void; }

interface PerfState {
    db: DatabaseSync | null;      // lazily opened on first record
    mode: string;                 // "sqlite" | "mysql" | "json"(off)
    dir: string | null;
    dead: boolean;                // first insert/open failure → degrade forever
    warned: boolean;
    insertsSinceSweep: number;
    memTimer: NodeJS.Timeout | null;
}

const state: PerfState = {
    db: null, mode: "", dir: null, dead: false, warned: false,
    insertsSinceSweep: 0, memTimer: null,
};

const ring: Array<Record<string, unknown>> = [];
function pushRing(row: Record<string, unknown>): void {
    ring.push(row);
    if (ring.length > RING_SIZE) ring.shift();
}

function perfEnabledByEnv(): boolean {
    const raw = process.env.BILI_PERF_TELEMETRY;
    return !(raw === "0" || raw === "false");
}

/** #5460 schema stability guard target — a change here must bump this text
 *  deliberately (same culture as the storage goldens). */
export const PERF_EVENTS_DDL =
    "CREATE TABLE IF NOT EXISTS perf_events (\n" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
    "  ts INTEGER NOT NULL,\n" +
    "  kind TEXT NOT NULL,\n" +
    "  session_id TEXT,\n" +
    "  msgs INTEGER,\n" +
    "  inbound_bytes INTEGER,\n" +
    "  outbound_bytes INTEGER,\n" +
    "  total_ms REAL,\n" +
    "  parse_ms REAL,\n" +
    "  payload TEXT\n" +
    ")";

function dbPath(dir: string): string { return path.join(dir, PERF_DB_FILE); }
// Canonical sessions dir (BILI_SESSIONS_DIR > dataDir()/sessions) — the same
// root index.db lives under; perf.sqlite keeps company without touching it.
const defaultDir = sessionsDir;

function warnDegrade(w: (level: "warn" | "error" | "info", msg: string) => void, what: string): void {
    if (state.warned) return;
    state.warned = true;
    try { w("warn", `[perf] telemetry degraded: ${what} — metrics collection stopped for this process (serving unaffected)`); } catch { /* last resort */ }
}

function ensureDb(): DatabaseSync | null {
    if (state.db) return state.db;
    if (!state.dir) return null;
    try {
        const db = new DatabaseSync(dbPath(state.dir));
        db.exec(`PRAGMA journal_mode=WAL; ${PERF_EVENTS_DDL}; CREATE INDEX IF NOT EXISTS idx_perf_events_ts ON ${PERF_TABLE}(ts);`);
        state.db = db;
        return db;
    } catch (e) {
        state.dead = true;
        warnDegrade((l, m) => console.error(l, m), `open failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

function insertRow(db: DatabaseSync, row: Record<string, unknown>, w: (level: "warn" | "error" | "info", msg: string) => void): void {
    if (state.dead) return;
    try {
        db.prepare(
            `INSERT INTO ${PERF_TABLE}(ts, kind, session_id, msgs, inbound_bytes, outbound_bytes, total_ms, parse_ms, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            row.ts as number, row.kind as string,
            (row.session_id as string) ?? null,
            (row.msgs as number) ?? null,
            (row.inbound_bytes as number) ?? null,
            (row.outbound_bytes as number) ?? null,
            (row.total_ms as number) ?? null,
            (row.parse_ms as number) ?? null,
            ((row.payload_json as string | undefined) ?? null) satisfies SQLInputValue,
        );
        pushRing(row);
        if (++state.insertsSinceSweep >= RETENTION_SWEEP_EVERY) {
            state.insertsSinceSweep = 0;
            db.prepare(`DELETE FROM ${PERF_TABLE} WHERE id IN (SELECT id FROM ${PERF_TABLE} ORDER BY id DESC LIMIT -1 OFFSET ?)`).run(RETENTION_CAP_ROWS);
        }
    } catch (e) {
        state.dead = true;
        warnDegrade(w, `insert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** Initialize telemetry for the process. Call ONCE per storage-mode decision
 *  (SessionStore construction paths); later calls are no-ops (idempotent by
 *  design — the retry/cold-open path may re-run). mode:
 *   - "sqlite": unified sidecar active (or the local engine default)
 *   - "mysql" : network backend lane — metrics still persist locally
 *   - "json"  : pure-JSON storage mode — FROZEN/deprecated, permanently off */
export function perfTelemetryInit(mode: "sqlite" | "mysql" | "json", opts?: InitOptions): boolean {
    // Idempotence FIRST: once armed, every later call (any mode) is a no-op.
    // (#5460: a stray init("json") from a secondary path must not downgrade
    // an already-running telemetry instance.)
    if (state.mode === "sqlite" || state.mode === "mysql") return true;
    if (!perfEnabledByEnv()) { state.mode = "off"; return false; }
    if (mode === "json") { state.mode = "json"; return false; }
    state.mode = mode;
    state.dir = opts?.dir ?? defaultDir();
    const log = opts?.log ?? ((l: string, m: string) => console.error(l, m));
    state.memTimer = setInterval(() => perfRecordMemSample(log), opts?.memIntervalMs ?? DEFAULT_MEM_INTERVAL_MS);
    state.memTimer.unref?.();
    return true;
}

/** Record one handled request (wired into logRequestCost — the single
 *  observation point every lane already flows through, #5408). */
export function perfRecordRequest(r: {
    sessionId: string | null;
    msgs?: number | null;
    inboundBytes?: number | null;
    outboundBytes?: number | null;
    totalMs?: number | null;
    parseMs?: number | null;
    extra?: Record<string, unknown>;
}, w?: (level: "warn" | "error" | "info", msg: string) => void): void {
    if (state.mode === "off" || state.mode === "json") return;
    const db = ensureDb();
    if (!db) return;
    const row: Record<string, unknown> = {
        ts: Date.now(), kind: "req",
        session_id: r.sessionId ?? null,
        msgs: r.msgs ?? null,
        inbound_bytes: r.inboundBytes ?? null,
        outbound_bytes: r.outboundBytes ?? null,
        total_ms: r.totalMs ?? null,
        parse_ms: r.parseMs ?? null,
        payload_json: r.extra ? JSON.stringify({ engine: state.mode, ...r.extra }) : JSON.stringify({ engine: state.mode }),
    };
    insertRow(db, row, w ?? ((l, m) => console.error(l, m)));
}

/** Memory watermark row — the OOM class (#5403 ×6) finally shows its ramp. */
export function perfRecordMemSample(w?: (level: "warn" | "error" | "info", msg: string) => void): void {
    if (state.mode === "off" || state.mode === "json") return;
    const db = ensureDb();
    if (!db) return;
    const m = process.memoryUsage();
    const row: Record<string, unknown> = {
        ts: Date.now(), kind: "mem",
        session_id: null, msgs: null, inbound_bytes: null, outbound_bytes: null,
        total_ms: null, parse_ms: null,
        payload_json: JSON.stringify({ rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers }),
    };
    insertRow(db, row, w ?? ((l, m2) => console.error(l, m2)));
}

/** Close everything (process shutdown / tests). Idempotent. */
export function perfStopAll(): void {
    if (state.memTimer) { clearInterval(state.memTimer); state.memTimer = null; }
    if (state.db) { try { state.db.close(); } catch { /* best effort */ } state.db = null; }
}

/** Full state reset — unit tests only (module singleton across test cases in
 *  one process). */
export function perfTelemetryResetForTests(): void {
    if (state.memTimer) { clearInterval(state.memTimer); state.memTimer = null; }
    if (state.db) { try { state.db.close(); } catch { /* best effort */ } state.db = null; }
    state.mode = "";
    state.dir = null;
    state.dead = false;
    state.warned = false;
    state.insertsSinceSweep = 0;
    ring.length = 0;
}

/** In-memory ring of the most recent rows — feeds /stats and the panel
 *  page without a round-trip to disk (P4 surface). */
export function perfRecentRows(): readonly Record<string, unknown>[] { return ring; }
/** Which engine tag rows carry (also the /stats "storage mode" answer). */
export function perfActiveMode(): string { return state.mode; }
