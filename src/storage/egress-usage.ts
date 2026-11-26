import type { SqliteDatabase } from "./driver.js";

// Egress usage plane (7773 follow-up, owner ruling 2026-11-27) — the 8th
// egress-family table. The cache ledger (session.metadata["cacheLedger"]) is
// the in-memory analytics source; on a fresh 7+1-table instance it survives
// a restart ONLY through this event stream, replayed on load.
//
// Event semantics (row_type):
//   M — boot boundary (synthesized before the first sample of a new boot
//       epoch: a live restart, or the first sample observed after an
//       in-memory ledger wipe). Replay re-arms the ledger's boot-epoch
//       sentinel so the "restarted" fresh-cause fires exactly as it did
//       live.
//   S — one usage settlement (settleUsageReport). payload = the EXACT
//       arguments recordCacheSample was called with. Replay re-runs
//       recordCacheSample verbatim, so the line fields come out
//       byte-identical to the live run.
//   F — one fold landing in session.state.blocks (the next REQUEST's
//       detectNewFolds picks it up; at settlement time the fold block
//       exists but has not entered the ledger yet). payload = the fold
//       row object recordCacheFoldsFromBlocks would build. Replay
//       re-pushes it in the same order as the live run.
//
// Ordering contract (op_seq assignment order == apply order):
//   F rows PRECEDE the S row of the same settlement — the live ledger
//   ingests the fold inside the settle's recordCacheSample call, and
//   foldSeq / fold-window attribution depend on it.
//
// Fork copies per owner ruling: fork-to-now copies the WHOLE stream
// (one usage stream per session); point-fork copies the at <=
// watermark prefix. Replay is idempotent against the current session
// state (block rows are the same object graph the live ledger saw), so
// no re-materialization is needed — the stream is pure.

export type EgressUsageRowType = "M" | "S" | "F";

export interface EgressUsageEvent {
  type: EgressUsageRowType;
  /** Epoch milliseconds — replay sorts (at, op-seq); F-before-S ties are
   *  preserved because op_seq is the tiebreaker and append order is
   *  F-then-S. */
  at: number;
  /** S: the recordCacheSample input object. F: the fold row object. M:
   *  null (nothing to re-apply — the row IS the sentinel). */
  payload?: unknown;
}

export interface EgressUsageRow {
  opSeq: number;
  rowType: EgressUsageRowType;
  at: number;
  /** Raw payload text (M rows are "null"). */
  payloadText: string;
}

export function egressUsageAppend(
  db: SqliteDatabase,
  sessionId: string,
  events: readonly EgressUsageEvent[],
): number {
  if (events.length === 0) return 0;
  const out = db.transaction(() => {
    const base = (
      db.prepare("SELECT COALESCE(MAX(op_seq), 0) AS n FROM egress_usage WHERE session_id = ?").get(sessionId) as { n: number }
    ).n;
    let n = 0;
    const ins = db.prepare(
      "INSERT INTO egress_usage (session_id, op_seq, row_type, at, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let opSeq = base;
    const now = Date.now();
    for (const ev of events) {
      if (ev.type !== "M" && ev.type !== "S" && ev.type !== "F") {
        throw new Error(`egress-usage: unknown row_type ${String(ev.type)}`);
      }
      if (!Number.isFinite(ev.at) || ev.at < 0) {
        throw new Error(`egress-usage: bad event at=${String(ev.at)}`);
      }
      ++opSeq;
      ins.run(sessionId, opSeq, ev.type, Math.floor(ev.at), JSON.stringify(ev.payload ?? null), now);
      ++n;
    }
    return n;
  });
  return out;
}

export function egressUsageRows(db: SqliteDatabase, sessionId: string): EgressUsageRow[] {
  const rows = db
    .prepare("SELECT op_seq, row_type, at, payload FROM egress_usage WHERE session_id = ? ORDER BY op_seq ASC")
    .all(sessionId) as Array<{ op_seq: number; row_type: string; at: number; payload: string }>;
  return rows.map((r) => ({
    opSeq: r.op_seq,
    rowType: r.row_type as EgressUsageRowType,
    at: r.at,
    payloadText: r.payload,
  }));
}

/** Fork-to-now: the WHOLE stream rides with the parent (owner ruling:
 *  one usage stream per session). op_seq is preserved — the stream is
 *  already append-only ordered and the child keeps its own numbering
 *  space from here on (MAX(op_seq)+1 within the child). */
export function egressUsageForkCopy(db: SqliteDatabase, fromSessionId: string, toSessionId: string): void {
  if (fromSessionId === toSessionId) throw new Error("egress-usage fork: source and target are the same session");
  // Idempotent re-fork of the same parent pair: replace, like the flow copies.
  db.prepare("DELETE FROM egress_usage WHERE session_id = ?").run(toSessionId);
  db.prepare(
    "INSERT INTO egress_usage (session_id, op_seq, row_type, at, payload, created_at) SELECT ?, op_seq, row_type, at, payload, created_at FROM egress_usage WHERE session_id = ?",
  ).run(toSessionId, fromSessionId);
}

/** Point-fork: the at <= watermark prefix (same discipline as the egress
 *  flow's op_seq <= watermark prefix). */
export function egressUsageForkCopyPrefix(
  db: SqliteDatabase,
  fromSessionId: string,
  toSessionId: string,
  watermarkAt: number,
): void {
  if (fromSessionId === toSessionId) throw new Error("egress-usage fork: source and target are the same session");
  db.prepare("DELETE FROM egress_usage WHERE session_id = ?").run(toSessionId);
  db.prepare(
    "INSERT INTO egress_usage (session_id, op_seq, row_type, at, payload, created_at) SELECT ?, op_seq, row_type, at, payload, created_at FROM egress_usage WHERE session_id = ? AND at <= ?",
  ).run(toSessionId, fromSessionId, Math.floor(watermarkAt));
}

/** Session deletion (deleteSession / deleteEgressOps): drop the stream. */
export function egressUsageDelete(db: SqliteDatabase, sessionId: string): number {
  const b = db.prepare("DELETE FROM egress_usage WHERE session_id = ?").run(sessionId);
  return Number(b.changes);
}

// ── session_ext materialized stats row ────────────────────────────────────
// "usage:stats" — the bounded materialized view of the stream (the ext
// twin of flow/state: the stream is truth, the row is a fast read that is
// re-derived on damage). The value is a single JSON object; the 1024-CHAR
// budget is a self-imposed invariant (session_ext rows stay human-greppable
// and the kv budget discipline of the egress plane), enforced at write time.

export const USAGE_STAT_KEY = "usage:stats";
export const USAGE_STATS_MAX_CHARS = 1024;

export function readUsageStats(db: SqliteDatabase, sessionId: string): string | null {
  const row = db
    .prepare("SELECT value_json FROM session_ext WHERE session_id = ? AND key = ?")
    .get(sessionId, USAGE_STAT_KEY) as { value_json: string } | null;
  return row ? row.value_json : null;
}

/** Enforces the 1024-char serialized budget (throw — callers decide
 *  whether to degrade); independent transaction (owner ruling 4). */
export function writeUsageStats(db: SqliteDatabase, sessionId: string, json: string): void {
  if (typeof json !== "string" || json.length === 0) throw new Error("egress-usage stats: empty value");
  if (json.length > USAGE_STATS_MAX_CHARS) {
    throw new Error(`egress-usage stats: value exceeds ${USAGE_STATS_MAX_CHARS} chars (${json.length}) — the stream is truth; trim the fields, never the budget`);
  }
  // Validate it is a JSON object before spending the row.
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("egress-usage stats: value must be a JSON object");
  }
  db.prepare(
    "INSERT INTO session_ext (session_id, key, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (session_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
  ).run(sessionId, USAGE_STAT_KEY, json, Date.now());
}

/** Best-effort write for the hot path (settlement): the stream already
 *  holds the truth — a stats-row failure must not kill the request, it
 *  warns once per process. */
let statsWarned = false;
export function writeUsageStatsBestEffort(db: SqliteDatabase, sessionId: string, json: string, log: (msg: string) => void): boolean {
  try {
    writeUsageStats(db, sessionId, json);
    return true;
  } catch (err) {
    if (!statsWarned) {
      statsWarned = true;
      log(`[storage] egress usage stats row for session=${sessionId} not written (${err instanceof Error ? err.message : String(err)}) — the egress_usage stream keeps the truth; the stats row stays stale until a successful write`);
    }
    return false;
  }
}
