// #3923: per-session writer markers — session-level split-brain visibility.
// Two live bili processes sharing one sessions directory are a KNOWN topology:
// the #394 registration warning and the #2401 slow-tick peer warning both fire
// at MACHINE level, once each — but the actual damage is per-SESSION (both
// instances committing state for the SAME conversation; the #405 counter guard
// stops monotonic rollback only, divergent state with equal-or-greater counters
// still clobbers last-writer-wins). That damage was previously discoverable
// only by manually diffing [v=…] tags in the shared log. Each standalone
// instance therefore records which sessions it recently COMMITTED to a tiny
// marker file (<state>/writers/<instanceId>.json, throttled atomic writes) and
// names both sides in an error line when it commits a session another live
// instance committed within the window. Pure observability: no routing,
// locking, or serving behavior changes.

import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "./instance.js";

export interface WriterIdentity {
    instanceId: string;
    pid: number;
    origin: string;
    version: string;
    /** #3923/#3959: this instance's lane (e.g. "pi", "dsh") — additive;
     *  markers written by older builds carry none and stay valid. */
    lane?: string;
}

interface WriterMarkerFile {
    v: 1;
    instanceId: string;
    pid: number;
    origin: string;
    version: string;
    lane?: string;
    /** Set only by a graceful dispose(): this instance recorded its FINAL
     *  marker and will never commit again. Peers skip such markers outright —
     *  a positively-known dead predecessor is not a concurrent writer, even
     *  while its file is fresh (restart flows kill + immediately rebind).
     *  Markers from older builds carry none and stay valid. */
    stoppedAt?: number;
    /** sessionId → last commit time (ms epoch). */
    servedAt: Record<string, number>;
}

/** A surfaced split-brain contest: which session (id + resolved title) and
 *  who is on each side (#3923/#3959). */
interface SplitBrainContest {
    sessionId: string;
    title?: string;
    self: WriterIdentity;
    peer: WriterIdentity & { servedAt: number };
    at: number;
}

interface ServedMarkerOptions {
    /** Cheapest accessor for the session's display title (in-memory peek —
     *  never a disk read). */
    resolveTitle?: (sessionId: string) => string | undefined;
    /** Surfacing seam: called once per contested peer, AFTER the log line. */
    onContest?: (contest: SplitBrainContest) => void;
}

/** A peer that committed the same session within this window counts as
 *  concurrently active on it. */
const CONTEST_WINDOW_MS = 10 * 60_000;
/** Minimum gap between marker-file writes (per-turn commits coalesce). */
const FLUSH_MIN_INTERVAL_MS = 5_000;
/** Drop per-session entries older than this (bounds the map). */
const ENTRY_PRUNE_MS = 60 * 60_000;
/** Hard cap on tracked sessions (oldest evicted first). */
const MAX_TRACKED_SESSIONS = 128;
/** Re-evaluate (and re-log) a contested verdict at most this often per session. */
const VERDICT_TTL_MS = 60_000;
/** A peer counts as live when its pid is alive OR its marker was written
 *  within this window (covers platforms where the pid check cannot see the
 *  peer process). Gracefully-stopped peers are excluded upstream via
 *  stoppedAt — this fallback only ever rescues CRASHED peers. */
const PEER_FILE_FRESH_MS = 30_000;
/** reapStaleWriterMarkers removes files whose pid is dead AND whose mtime is
 *  older than this. */
const STALE_REAP_MS = 60 * 60_000;

export function writerMarkerDir(stateDirPath: string): string {
    return path.join(stateDirPath, "writers");
}

let tmpSeq = 0;

function durableAtomicWrite(file: string, text: string): void {
    const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${tmpSeq++}`);
    try {
        const fd = fs.openSync(tmp, "w");
        try {
            fs.writeSync(fd, text);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort: a stuck temp is swept at next boot */ }
        throw err;
    }
}

export interface ServedMarkerWriter {
    /** Record that THIS instance just committed state for a session. Cheap on
     *  the hot path: an in-memory set plus a throttled file flush; the
     *  contention verdict is evaluated at most once per VERDICT_TTL_MS per
     *  session. Never throws into the save chain. */
    noteServed(sessionId: string): void;
    /** Final flush + timer teardown (graceful shutdown). */
    dispose(): void;
}

export function createServedMarkerWriter(identity: WriterIdentity, dir: string, log: (level: string, msg: string) => void, opts?: ServedMarkerOptions): ServedMarkerWriter & { __flushForTest(): void; __servedForTest(): Record<string, number> } {
    const servedAt = new Map<string, number>();
    const verdicts = new Map<string, number>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFlushAt = 0;
    let disposed = false;
    let stoppedAt: number | undefined;

    const prune = (now: number): void => {
        for (const [id, at] of [...servedAt]) {
            if (now - at > ENTRY_PRUNE_MS) servedAt.delete(id);
        }
        while (servedAt.size > MAX_TRACKED_SESSIONS) {
            let oldest: string | undefined;
            let oldestAt = Number.MAX_SAFE_INTEGER;
            for (const [id, at] of servedAt) if (at < oldestAt) { oldest = id; oldestAt = at; }
            if (oldest === undefined) break;
            servedAt.delete(oldest);
        }
    };

    const writeMarker = (): void => {
        const now = Date.now();
        prune(now);
        const body: WriterMarkerFile = {
            v: 1,
            instanceId: identity.instanceId,
            pid: identity.pid,
            origin: identity.origin,
            version: identity.version,
            ...(identity.lane === undefined || identity.lane === "" ? {} : { lane: identity.lane }),
            ...(stoppedAt === undefined ? {} : { stoppedAt }),
            servedAt: Object.fromEntries(servedAt),
        };
        try {
            fs.mkdirSync(dir, { recursive: true });
            durableAtomicWrite(path.join(dir, `${identity.instanceId}.json`), JSON.stringify(body));
        } catch {
            // best-effort observability — a failed marker write must never
            // surface through the save chain
        }
    };

    const flush = (): void => {
        flushTimer = undefined;
        if (disposed) return;
        lastFlushAt = Date.now();
        writeMarker();
    };

    const scheduleFlush = (): void => {
        if (flushTimer !== undefined || disposed) return;
        const wait = Math.max(0, FLUSH_MIN_INTERVAL_MS - (Date.now() - lastFlushAt));
        flushTimer = setTimeout(flush, wait);
        flushTimer.unref?.();
    };

    const checkContested = (sessionId: string, now: number): void => {
        const last = verdicts.get(sessionId);
        if (last !== undefined && now - last < VERDICT_TTL_MS) return;
        verdicts.set(sessionId, now);
        for (const peer of findContestedWriters(dir, identity.instanceId, sessionId, now)) {
            // #3923/#3959: name the session (title when resolvable) and each
            // side's lane — a real conflict must be attributable on its face.
            const title = opts?.resolveTitle?.(sessionId);
            const laneOf = (x: WriterIdentity): string => (x.lane === undefined || x.lane === "" ? "" : `, lane ${x.lane}`);
            const titleOf = title === undefined || title === "" ? "" : ` "${title}"`;
            log("error", `[split-brain] session ${sessionId}${titleOf} committed by BOTH this instance (pid ${identity.pid}, ${identity.origin}${laneOf(identity)}, v${identity.version}) and another live instance (pid ${peer.pid}, ${peer.origin}${laneOf(peer)}, v${peer.version}) within ${CONTEST_WINDOW_MS / 60000}m — fold decisions are invisible across instances and the last writer wins (#394/#405); stop one of them or align your client config so one conversation rides one proxy (#3923)`);
            opts?.onContest?.({ sessionId, ...(title === undefined || title === "" ? {} : { title }), self: identity, peer, at: now });
        }
    };

    return {
        noteServed(sessionId: string): void {
            if (disposed) return;
            const now = Date.now();
            servedAt.set(sessionId, now);
            scheduleFlush();
            checkContested(sessionId, now);
        },
        dispose(): void {
            disposed = true;
            if (flushTimer !== undefined) clearTimeout(flushTimer);
            // final write (bypasses the disposed guard): peers should still be
            // able to attribute this instance's last commits after shutdown.
            // stoppedAt marks the stop as GRACEFUL so peers never flag this
            // predecessor in a split-brain contest — the freshness fallback
            // must only rescue crashed peers whose death we cannot prove.
            stoppedAt = Date.now();
            writeMarker();
        },
        __flushForTest(): void {
            flush();
        },
        __servedForTest(): Record<string, number> {
            return Object.fromEntries(servedAt);
        },
    };
}

/** Peer marker files that record a commit of `sessionId` inside the contest
 *  window by a LIVE foreign instance (pid alive or file fresh). Markers
 *  carrying stoppedAt (graceful shutdown) are skipped unconditionally — a
 *  restart flow's predecessor died seconds ago and must not raise an alarm.
 *  Malformed or tearing files are skipped silently — a marker is
 *  observability, not data. */
export function findContestedWriters(dir: string, selfInstanceId: string, sessionId: string, now: number): Array<WriterIdentity & { servedAt: number }> {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out: Array<WriterIdentity & { servedAt: number }> = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(dir, entry.name);
        try {
            const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WriterMarkerFile>;
            if (raw.v !== 1 || typeof raw.instanceId !== "string" || raw.instanceId === selfInstanceId) continue;
            if (typeof raw.stoppedAt === "number") continue;
            const at = raw.servedAt !== null && typeof raw.servedAt === "object" ? (raw.servedAt as Record<string, unknown>)[sessionId] : undefined;
            if (typeof at !== "number" || now - at > CONTEST_WINDOW_MS) continue;
            const mtimeMs = fs.statSync(file).mtimeMs;
            const alive = typeof raw.pid === "number" ? isPidAlive(raw.pid) : false;
            if (!alive && now - mtimeMs > PEER_FILE_FRESH_MS) continue;
            out.push({
                instanceId: raw.instanceId,
                pid: typeof raw.pid === "number" ? raw.pid : -1,
                origin: typeof raw.origin === "string" ? raw.origin : "unknown",
                version: typeof raw.version === "string" ? raw.version : "unknown",
                lane: typeof raw.lane === "string" && raw.lane !== "" ? raw.lane : undefined,
                servedAt: at,
            });
        } catch {
            // malformed/tearing marker — skip
        }
    }
    return out;
}

/** Startup hygiene: drop marker files whose instance is provably gone (pid
 *  dead) and stale beyond the reap horizon. Fresh files from a just-crashed
 *  peer stay — findContestedWriters' freshness test still honors them for
 *  PEER_FILE_FRESH_MS. */
export function reapStaleWriterMarkers(dir: string, now: number): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(dir, entry.name);
        try {
            const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WriterMarkerFile>;
            const dead = typeof raw.pid !== "number" || !isPidAlive(raw.pid);
            if (!dead) continue;
            if (now - fs.statSync(file).mtimeMs <= STALE_REAP_MS) continue;
            fs.rmSync(file, { force: true });
        } catch {
            // unreadable file — leave it; a later boot retries
        }
    }
}
