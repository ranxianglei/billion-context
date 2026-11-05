/**
 * Web changelog (#3719): per-release notes for the admin panel, sourced from
 * the GitHub Releases API. The web UI shows a collapsible "更新日志 / Changelog"
 * section (see page.ts/client.ts) and the /acp panel appends a latest-release
 * pointer line from the same cache (plugin.ts).
 *
 * Fail-soft by contract, mirroring the release-notes watcher discipline in
 * src/update-notes.ts but kept in-memory only (no disk cache files, no config
 * keys, no env vars): one network hit per THROTTLE_MS window; every failure —
 * offline, HTTP error, malformed document — degrades to the cached view with
 * `error: "offline"` and never throws into the caller. A GitHub failure must
 * never break the panel or the status endpoint.
 */
import type { ServerResponse } from "node:http";
import { fetchWithTimeout } from "../fetch-util.js";
import { log as loggerLog } from "../logger.js";

type ChangelogRelease = {
    /** GitHub release tag (e.g. v0.1.203). */
    tag: string;
    /** Release title when distinct from the tag. */
    name?: string;
    /** ISO publish timestamp. */
    publishedAt?: string;
    /** Release notes body (markdown source; the UI renders it as escaped
     *  plain text with URL links — no markdown dependency). */
    body?: string;
    /** GitHub release page URL. */
    url: string;
};

type ChangelogData = {
    releases: ChangelogRelease[];
    /** Set on a failed/stale-throttled read ("offline"); absent when the
     *  cached data is fresh. HTTP is always 200 — the UI degrades gracefully. */
    error?: string;
};

const GITHUB_RELEASES_URL = "https://api.github.com/repos/ranxianglei/billion-context/releases?per_page=20";
/** One network hit per window (mirrors the release-notes checker cadence);
 *  failures are throttled too, so an offline machine hammers nothing. */
const THROTTLE_MS = 10 * 60 * 1000;
/** Newest-first cap on entries served to the panel. */
const MAX_ENTRIES = 20;
const FETCH_TIMEOUT_MS = 5000;

type State = {
    releases: ChangelogRelease[];
    lastError?: string;
    lastCheckAt: number;
};

let state: State = { releases: [], lastCheckAt: 0 };
let inflight: Promise<void> | undefined;
/** One background warm-up per process for network-free callers (/acp panel);
 *  real cadence is driven by the admin endpoint's 10-minute throttle. */
let warmAttempted = false;

/** Test seam: clear cache + throttle + in-flight + warm-up guards. */
export function _resetChangelogForTest(): void {
    state = { releases: [], lastCheckAt: 0 };
    inflight = undefined;
    warmAttempted = false;
}

/** Synchronous read of the newest cached release for surfaces that must not
 *  await the network (the /acp panel line). Undefined until the first
 *  successful fetch. */
export function latestChangelog(): ChangelogRelease | undefined {
    return state.releases[0];
}

/** Map one GitHub Releases API item. Items without a usable tag+url are
 *  skipped individually so one bad row cannot kill the feed. */
function parseRelease(raw: unknown): ChangelogRelease | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const e = raw as Record<string, unknown>;
    const tag = typeof e.tag_name === "string" ? e.tag_name.trim() : "";
    const url = typeof e.html_url === "string" ? e.html_url.trim() : "";
    if (!tag || !url) return undefined;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const publishedAt = typeof e.published_at === "string" ? e.published_at.trim() : "";
    const body = typeof e.body === "string" ? e.body : undefined;
    return {
        tag,
        url,
        ...(name !== "" && name !== tag ? { name } : {}),
        ...(publishedAt !== "" ? { publishedAt } : {}),
        ...(body !== undefined ? { body } : {}),
    };
}

async function runCheck(): Promise<void> {
    try {
        const result = await fetchWithTimeout(
            GITHUB_RELEASES_URL,
            { method: "GET", headers: { Accept: "application/json", "user-agent": "billion-context-changelog" } },
            FETCH_TIMEOUT_MS,
        );
        try {
            if (!result.response.ok) throw new Error(`GitHub Releases returned HTTP ${result.response.status}`);
            const raw = await result.response.json();
            if (!Array.isArray(raw)) throw new Error("response is not a JSON array");
            const releases: ChangelogRelease[] = [];
            for (const item of raw) {
                const rel = parseRelease(item);
                if (rel !== undefined) releases.push(rel);
                if (releases.length >= MAX_ENTRIES) break;
            }
            state = { releases, lastCheckAt: Date.now() };
        } finally {
            // Fully consumed the body — stop the idle watchdog so the timer
            // cannot pin the event loop (fetch-util's #552 contract).
            result.stopIdleTimer();
        }
    } catch (e) {
        // Fail soft: keep any stale cache, record the error, throttle retries.
        state = { ...state, lastError: "offline", lastCheckAt: Date.now() };
        loggerLog("warn", `[changelog] GitHub Releases check failed (${String(e)}) — serving cached view`);
    }
}

/** Fire at most one background refresh per process from sync callers that
 *  must not await the network (the /acp panel footer line). Fail silent by
 *  construction — getChangelog never throws. */
export function warmChangelogOnce(): void {
    if (warmAttempted || latestChangelog() !== undefined) return;
    warmAttempted = true;
    void getChangelog();
}

/** Throttled changelog read (at most one network hit per THROTTLE_MS;
 *  `force` bypasses the window). Never throws: offline/malformed sources
 *  yield `{ releases: <cached>, error: "offline" }`. */
export async function getChangelog(opts?: { force?: boolean }): Promise<ChangelogData> {
    const stale = Date.now() - state.lastCheckAt >= THROTTLE_MS;
    if ((opts?.force ?? false) || stale) {
        if (inflight === undefined) {
            inflight = runCheck().finally(() => { inflight = undefined; });
        }
        await inflight;
    }
    return { releases: state.releases, ...(state.lastError !== undefined ? { error: state.lastError } : {}) };
}

/** GET /__bili/changelog handler (admin-gated like the other read-only
 *  /__bili/ routes in server/admin.ts). Always HTTP 200 — even for the
 *  offline/error payload — so the panel can degrade instead of erroring. */
export async function handleChangelogGet(res: ServerResponse): Promise<void> {
    const data = await getChangelog();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
}
