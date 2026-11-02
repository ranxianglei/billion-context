// #5548 P3 lane C: remote announcements from a single GitHub raw file on
// master (publish = git push, retract = delete entry + push). Mirrors the
// advisory watcher's shape — same cadence, fail-open, warnOnce logging — but
// is a pure read-only display feed: never blocks, installs, or restarts.
// A/B render first; lane C merges in whenever its entries arrive.
import fs from "node:fs";
import path from "node:path";
import { log as loggerLog, type Logger } from "./logger.js";
import { cacheDir } from "./paths.js";
import { CHECK_INTERVAL_MS, egressDispatcher } from "./update.js";
import type { FetchOptions } from "./fetch-util.js";
import { applyRemoteDoc, REMOTE_DOC_CAP_BYTES, REMOTE_DOC_VERSION, registerDynamicNoticeIds, type NoticeRecord } from "./notices.js";

export const DEFAULT_REMOTE_ANNOUNCEMENTS_URL = "https://raw.githubusercontent.com/ranxianglei/billion-context/master/announcements/remote.json";
const FETCH_TIMEOUT_MS = 8000;
const SNAPSHOT_FILE = "announcements-remote-snapshot.json";

interface RemoteAnnouncementOptions {
    /** Override the feed URL (env BILI_ANNOUNCEMENTS_URL wins over this). */
    url?: string;
    resolveProxy?: (url: string) => string | undefined;
    log?: Logger;
    /** Test seam: shorten the fetch timeout for slow-response injection. */
    timeoutMs?: number;
}

interface RemoteState {
    entries: NoticeRecord[];
    lastError?: string;
    lastCheckAt?: number;
}

let state: RemoteState = { entries: [] };
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

export function remoteAnnouncementEntries(): readonly NoticeRecord[] {
    return state.entries;
}

/** Test seam: drop in-memory state (and warn-once keys) so each test starts
 *  from a clean slate — otherwise an earlier test's identical failure key
 *  swallows a later test's expected warning. */
export function _resetRemoteAnnouncementsForTest(): void {
    state = { entries: [] };
    warned.clear();
}

export function _stopRemoteAnnouncementWatcherForTest(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}

/** BILI_ANNOUNCEMENTS_URL is the firewall-relay escape hatch (§五.3):
 *  path-relocation class env, owner-approved design point. */
export function resolveRemoteUrl(envUrl: string | undefined, optsUrl: string | undefined): string {
    const pick = (v: string | undefined): string | undefined => {
        const t = v?.trim();
        return t && t.length > 0 ? t : undefined;
    };
    return pick(envUrl) ?? pick(optsUrl) ?? DEFAULT_REMOTE_ANNOUNCEMENTS_URL;
}

function snapshotFile(): string {
    return path.join(cacheDir(), SNAPSHOT_FILE);
}

/** Last-known-good snapshot from a previous session (§五.2): a failed fetch
 *  keeps showing this instead of nothing. Absent/corrupt → no lane C. */
export function loadRemoteSnapshot(): NoticeRecord[] {
    try {
        const doc: unknown = JSON.parse(fs.readFileSync(snapshotFile(), "utf8"));
        const res = applyRemoteDoc(doc);
        if (!res.ok) return [];
        registerDynamicNoticeIds(res.entries.map((r) => r.id));
        return res.entries;
    } catch {
        return [];
    }
}

function saveRemoteSnapshot(entries: readonly NoticeRecord[]): void {
    try {
        fs.mkdirSync(path.dirname(snapshotFile()), { recursive: true });
        fs.writeFileSync(snapshotFile(), JSON.stringify({ v: REMOTE_DOC_VERSION, entries }, null, 2) + "\n");
    } catch {
        // cache dir unwritable: in-memory copy still serves this session
    }
}

const warned = new Set<string>();
function warnOnce(log: Logger, key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    log("warn", message);
}

/** One fetch cycle. Fail-open by design: any error keeps the previous
 *  entries (snapshot-seeded at startup), logs warnOnce, never throws. */
export async function runRemoteCheck(opts: RemoteAnnouncementOptions = {}): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const log = opts.log ?? loggerLog;
    try {
        const url = resolveRemoteUrl(process.env.BILI_ANNOUNCEMENTS_URL, opts.url);
        let body: string;
        try {
            const dispatcher = egressDispatcher({ resolveProxy: opts.resolveProxy }, url);
            const init: FetchOptions = {
                method: "GET",
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
                ...(dispatcher ? { dispatcher } : {}),
            };
            const res = await fetch(url, init as RequestInit);
            if (!res.ok) throw new Error(`remote announcements returned HTTP ${res.status}`);
            body = await res.text();
        } catch (e) {
            state.lastError = String(e);
            warnOnce(log, `fetch:${String(e)}`, `[notices] remote check failed (${String(e)}) — continuing with last-known-good`);
            return;
        }
        if (Buffer.byteLength(body, "utf8") > REMOTE_DOC_CAP_BYTES) {
            state.lastError = `document exceeds ${REMOTE_DOC_CAP_BYTES} bytes`;
            warnOnce(log, "size", `[notices] ignoring oversized remote document (>${REMOTE_DOC_CAP_BYTES} bytes)`);
            return;
        }
        let doc: unknown;
        try {
            doc = JSON.parse(body);
        } catch (e) {
            state.lastError = String(e);
            warnOnce(log, "parse", `[notices] ignoring malformed remote document (${String(e)})`);
            return;
        }
        const res = applyRemoteDoc(doc);
        if (!res.ok) {
            state.lastError = res.reason;
            warnOnce(log, `doc:${res.reason}`, `[notices] ignoring remote document: ${res.reason}`);
            return;
        }
        for (const w of res.warnings) warnOnce(log, `entry:${w}`, `[notices] remote document: ${w}`);
        state = { entries: res.entries, lastCheckAt: Date.now() };
        registerDynamicNoticeIds(res.entries.map((r) => r.id));
        saveRemoteSnapshot(res.entries);
    } finally {
        inFlight = false;
    }
}

/** Start the periodic feed: same cadence as the update check (§五.2), first
 *  fetch after a short startup delay like the advisory watcher, unref'd so it
 *  never holds the process open. */
export function startRemoteAnnouncementWatcher(opts: RemoteAnnouncementOptions = {}): void {
    if (timer) return;
    const log = opts.log ?? loggerLog;
    state.entries = loadRemoteSnapshot();
    log("info", `[notices] remote feed enabled (checking every ${CHECK_INTERVAL_MS / 1000 | 0}s, independent of auto-update)`);
    setTimeout(() => {
        void runRemoteCheck(opts);
    }, 10_000);
    timer = setInterval(() => {
        void runRemoteCheck(opts);
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
}
