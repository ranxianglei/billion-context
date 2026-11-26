// #5548 P3: remote announcements (source C) — a single JSON document on
// GitHub raw, published by git push and retracted by removing the entry.
// The watcher rides the self-updater's throttle cadence (independent of
// autoUpdate, same shape as the advisory watcher), keeps a last-known-good
// snapshot in the cache dir, and fails open like everything else here: an
// unreachable or malformed feed never degrades a working proxy — the worst
// case is "no remote banners". Emergency retraction is pushing empty
// entries; nothing in this module can force user action.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { log as loggerLog, type Logger } from "./logger.js";
import type { FetchOptions } from "./fetch-util.js";
import { CHECK_INTERVAL_MS, egressDispatcher } from "./update.js";
import type { NoticeRecord } from "./announcements.js";
import { noticePassesGates, announcementPayload, validateRecord, contentHash16 } from "./announcements.js";

/** Official feed location (trust boundary = who can push to this repo). */
export const DEFAULT_ANNOUNCEMENTS_URL = "https://raw.githubusercontent.com/ranxianglei/billion-context/master/announcements/remote.json";
const MAX_REMOTE_BYTES = 512 * 1024;
const MAX_ENTRIES = 50;
const SUPPORTED_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 8000;

/** Explicit override wins verbatim (config `remoteAnnouncementsUrl` / env
 *  BILI_ANNOUNCEMENTS_URL — firewall installs point this at their own relay);
 *  absent = the official raw URL. */
export function resolveAnnouncementsUrl(configured: string | undefined): string {
    const v = configured?.trim();
    return v ? v : DEFAULT_ANNOUNCEMENTS_URL;
}


/** Stream-read `body` and UTF-8-decode it, rejecting once accumulated bytes
 *  exceed `maxBytes` — so a feed whose Content-Length lies (or is absent/
 *  chunked) can never be fully materialized in memory before the size bound
 *  rejects it. Plain `res.text()` buffered the ENTIRE response first; the
 *  feed URL is owner-overridable (firewall relays), so the bound had to live
 *  on the read itself (release review #5826, 2026-11-06). */
async function readCappedBody(body: Response["body"], maxBytes: number): Promise<string> {
    if (body === null) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value !== undefined && value.byteLength > 0) {
                total += value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel().catch(() => {});
                    throw new Error(`document exceeds ${maxBytes} bytes`);
                }
                chunks.push(value);
            }
        }
    } finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return new TextDecoder("utf-8").decode(out);
}

/** Validate the wire document ({v:1, entries:[...]}). Bad individual entries
 *  are skipped (one typo must never blank the feed); a document that yields
 *  NOTHING from non-empty input is an error so callers keep the snapshot.
 *  Version > supported: skip the WHOLE doc (never partial-parse newer shapes). */
export function parseRemoteDoc(raw: unknown): { entries: NoticeRecord[]; error?: string } {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { entries: [], error: "document is not a JSON object" };
    const doc = raw as Record<string, unknown>;
    const v = doc["v"];
    if (typeof v !== "number" || !Number.isInteger(v)) return { entries: [], error: "missing integer v" };
    if (v !== SUPPORTED_VERSION) return { entries: [], error: `unsupported version ${v} (supported: ${SUPPORTED_VERSION})` };
    if (!Array.isArray(doc["entries"])) return { entries: [], error: "entries field is not an array" };
    const list = doc["entries"] as unknown[];
    if (list.length > MAX_ENTRIES) return { entries: [], error: `too many entries (${list.length} > ${MAX_ENTRIES})` };
    const entries: NoticeRecord[] = [];
    const seen = new Set<string>();
    for (const item of list) {
        const rec = validateRecord(item);
        if (rec && !seen.has(rec.id)) {
            seen.add(rec.id);
            entries.push(rec);
        }
    }
    if (list.length > 0 && entries.length === 0) return { entries: [], error: "no valid entries in document" };
    return { entries };
}

type State = {
    /** Records from the most recent cleanly parsed doc (fresh fetch or
     *  snapshot fallback). Undefined = never consulted the feed yet. */
    entries?: NoticeRecord[];
    lastError?: string;
    lastCheckAt?: number;
};
let state: State = {};
const warnedKeys = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let firstCheckDone = false;

function warnOnce(log: Logger, key: string, message: string): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    log("warn", message);
}

function throttleFile(): string {
    return path.join(cacheDir(), ".remote-notices-check");
}
function snapshotFile(): string {
    return path.join(cacheDir(), ".remote-notices-snapshot.json");
}

async function readLastCheck(): Promise<number> {
    try {
        return parseInt((await readFile(throttleFile(), "utf8")).trim(), 10) || 0;
    } catch {
        return 0;
    }
}
async function writeLastCheck(ts: number): Promise<void> {
    try {
        await mkdir(path.dirname(throttleFile()), { recursive: true });
        await writeFile(throttleFile(), String(ts), "utf8");
    } catch {
        // best-effort
    }
}
async function writeSnapshot(text: string): Promise<void> {
    try {
        await mkdir(path.dirname(snapshotFile()), { recursive: true });
        await writeFile(snapshotFile(), text, "utf8");
    } catch {
        // best-effort
    }
}

type RemoteNoticesOptions = {
    /** Resolved-or-raw announcements URL override (see resolveAnnouncementsUrl). */
    remoteAnnouncementsUrl?: string;
    resolveProxy?: (url: string) => string | undefined;
    /** Test seam: override the 8s fetch timeout. */
    timeoutMs?: number;
    log?: Logger;
};

/** Run one remote-announcements check (throttled unless `force`). Safe to
 *  call frequently. Never throws. On any failure serves the last known-good
 *  doc (memory first, snapshot file after restart); first-ever failure with
 *  no snapshot yields "no remote source" for this cycle. */
export async function runRemoteNoticesCheck(opts: RemoteNoticesOptions, force = false): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const log = opts.log ?? loggerLog;
    try {
        const now = Date.now();
        const lastCheck = await readLastCheck();
        if (!force && firstCheckDone && now - lastCheck < CHECK_INTERVAL_MS) return;
        await writeLastCheck(now);
        firstCheckDone = true;

        let text: string;
        try {
            const url = resolveAnnouncementsUrl(opts.remoteAnnouncementsUrl);
            const dispatcher = egressDispatcher({ resolveProxy: opts.resolveProxy }, url);
            const init: FetchOptions = {
                method: "GET",
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
                ...(dispatcher ? { dispatcher } : {}),
            };
            const res = await fetch(url, init as RequestInit);
            if (!res.ok) throw new Error(`announcements source returned HTTP ${res.status}`);
            // Bound the READ itself, not just the result: a multi-GB body from
            // a hostile or misconfigured relay used to land fully in memory
            // before MAX_REMOTE_BYTES below could reject it.
            text = await readCappedBody(res.body, MAX_REMOTE_BYTES);
        } catch (e) {
            state.lastError = String(e);
            warnOnce(log, `fetch:${String(e)}`, `[notices] remote feed unreachable (${String(e)}) — serving last known-good copy`);
            await serveFromSnapshot();
            return;
        }
        if (text.length > MAX_REMOTE_BYTES) {
            state.lastError = `document exceeds ${MAX_REMOTE_BYTES} bytes`;
            warnOnce(log, "fetch:size", `[notices] remote feed too large (> ${MAX_REMOTE_BYTES} bytes) — serving last known-good copy`);
            await serveFromSnapshot();
            return;
        }
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            state.lastError = "document is not valid JSON";
            warnOnce(log, "parse:json", "[notices] remote feed is not valid JSON — serving last known-good copy");
            await serveFromSnapshot();
            return;
        }
        const parsed = parseRemoteDoc(raw);
        if (parsed.error) {
            state.lastError = parsed.error;
            warnOnce(log, `parse:${parsed.error}`, `[notices] ignoring malformed remote feed: ${parsed.error}`);
            await serveFromSnapshot();
            return;
        }
        state.entries = parsed.entries;
        state.lastError = undefined;
        state.lastCheckAt = Date.now();
        await writeSnapshot(text);
    } catch (e) {
        state.lastError = String(e);
        warnOnce(log, `check:${String(e)}`, `[notices] remote feed check failed: ${String(e)}`);
    } finally {
        inFlight = false;
    }
}

/** After a failed fresh fetch: memory state stays authoritative when we
 *  already have one (it WAS a good doc); otherwise fall back to the on-disk
 *  snapshot; with neither, stay at "unknown" and show nothing. */
async function serveFromSnapshot(): Promise<void> {
    if (state.entries !== undefined) return;
    let text: string | undefined;
    try {
        text = await readFile(snapshotFile(), "utf8");
    } catch {
        return;
    }
    try {
        const parsed = parseRemoteDoc(JSON.parse(text));
        if (!parsed.error) {
            state.entries = parsed.entries;
            warnOnce(loggerLog, "snapshot", "[notices] remote feed offline — using cached snapshot");
        }
    } catch {
        // unreadable/corrupt snapshot → no remote source
    }
}

/** Visible remote records after every shared gate (versions/percent/time
 *  window/dismissal); wire-shaped for the web UI. Empty before the first
 *  successful feed consultation — deliberate, not an error. */
export function visibleRemoteRecords(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env) {
    if (!state.entries) return [];
    return state.entries.filter((r) => noticePassesGates(r, now, env));
}

/** Wire payloads for GET /__bili/notices / the overview field. */
export function remoteAnnouncementPayloads(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env) {
    return visibleRemoteRecords(now, env).map((r) => announcementPayload("remote", r));
}

/** Dismiss mode declared by the latest cleanly parsed doc (for the dismiss
 *  endpoint); "absent" means not a remote entry at all. Uses the RAW records
 *  (pre-gate) so an expired-by-time-window entry still routes correctly. */
export function remoteDismissMode(id: string): "persistent" | "instance" | "always" | "absent" {
    const rec = state.entries?.find((r) => r.id === id);
    return rec ? rec.dismiss : "absent";
}

/** Content-addressed dismiss key for a currently visible remote entry
 *  (same key the visibility gate filters on), else undefined (#5548 fix). */
export function remoteDismissKey(id: string): string | undefined {
    const rec = visibleRemoteRecords().find((r) => r.id === id);
    return rec ? `${id}@${contentHash16(rec)}` : undefined;
}

/** Read-only state for tests / diagnostics. */
export function getRemoteNoticesState(): Readonly<State> {
    return state;
}

/** Test seams: clear state + dedupe, stop the timer, reset throttling. */
export function _resetRemoteNoticesForTest(): void {
    state = {};
    warnedKeys.clear();
    firstCheckDone = false;
    stopRemoteNoticesWatcher();
}

export function startRemoteNoticesWatcher(opts: RemoteNoticesOptions): void {
    if (timer) return;
    loggerLog("info", `[notices] remote feed watcher enabled (checking every ${CHECK_INTERVAL_MS / 1000 | 0}s)`);
    setTimeout(() => {
        void runRemoteNoticesCheck(opts);
    }, 10_000);
    timer = setInterval(() => {
        void runRemoteNoticesCheck(opts);
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
}

/** Stop the periodic check loop (for tests / clean shutdown). */
function stopRemoteNoticesWatcher(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}
