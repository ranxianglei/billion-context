/**
 * Panel blog live refresh (#4906): the bundled feed (web/blogfeed.ts) freezes
 * at package-release time; this layer overlays it with the LATEST
 * website/blog/posts/*.md from GitHub master so newly written posts appear in
 * the panel without waiting for a release + self-update.
 *
 * Style mirrors web/changelog.ts (#3719) exactly: in-memory cache only — no
 * config keys, no env vars, no disk cache files, no resident timer. The
 * refresh is ACCESS-DRIVEN: serving /__bili/blog triggers at most one network
 * round per REFRESH_WINDOW_MS (default 1 h); failures are throttled the same
 * way so an offline machine hammers nothing. Fail-soft end-to-end: offline,
 * HTTP errors, malformed listings and a blown wall-clock budget all degrade to
 * (or back to) the bundled feed — the handler still answers 200 and the panel
 * never errors. When a refresh SUCCEEDS the live LISTING is authoritative for
 * posts: a changed post replaces its bundled twin, new slugs are appended, a
 * post absent from the listing (deleted on master) leaves the panel; a listed
 * post whose BODY fails to fetch keeps its bundled twin (per-file fail-soft).
 * Articles (curated manifest) stay bundled — #4906 scopes the live pull to
 * posts. An empty live listing is treated as content anomaly, not truth.
 *
 * Egress: ONE api.github.com contents call per window (unauthenticated, inside
 * the anonymous 60-req/h budget) plus raw.githubusercontent.com fetches for
 * the markdown bodies (no API quota). Relative image refs in live posts are
 * rewritten onto raw.githubusercontent.com absolute URLs — web/markdown.ts
 * passes absolute http(s) image targets through untouched, so the guarded
 * /__bili/blog-assets/ route stays bundled-only.
 */
import type { ServerResponse } from "node:http";
import { fetchWithTimeout } from "../fetch-util.js";
import { log as loggerLog } from "../logger.js";
import { getBlogFeed, postIdFromBase, renderPostText, shapePost, sortBlogItems, type BlogItem, type PostHalf } from "./blogfeed.js";

const REPO = "ranxianglei/billion-context";
const BRANCH = "master";
const POSTS_PATH = "website/blog/posts";
const LISTING_URL = `https://api.github.com/repos/${REPO}/contents/${POSTS_PATH}?ref=${BRANCH}`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${POSTS_PATH}`;
/** Access-driven refresh window: one network round per hour of panel use. */
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
/** Whole-refresh wall-clock budget (listing + all bodies). Overrun aborts and
 *  fails soft instead of stalling the page; normal corpora settle far below it. */
const REFRESH_BUDGET_MS = 15 * 1000;
/** Defensive caps against pathological listing shapes. */
const MAX_FILES = 50;
const CONCURRENCY = 4;
const USER_AGENT = "billion-context-blog";

type LiveEntry = { name: string; downloadUrl: string };
type Pair = { en?: LiveEntry; zh?: LiveEntry };

type State = {
    /** Last SUCCESSFUL live post set; undefined until one ever succeeds. */
    items: BlogItem[] | undefined;
    /** Ids of every post the last successful listing contained — even ones
     *  whose body failed to render. This is the authority boundary for the
     *  merge: a bundled post outside it was deleted on master and must leave
     *  the panel, one inside it keeps its bundled twin on render failure. */
    listedIds: string[];
    lastCheckAt: number;
    lastError?: string;
};

let state: State = { items: undefined, listedIds: [], lastCheckAt: 0 };
let inflight: Promise<void> | undefined;
let seams: { refreshWindowMs?: number; budgetMs?: number } = {};

/** Test seam (mirrors _resetChangelogForTest): clear cache + throttle window +
 *  in-flight refresh; pass seams to stretch/shrink timing constants. */
export function _resetBlogLiveForTest(seamsOverride?: { refreshWindowMs?: number; budgetMs?: number }): void {
    state = { items: undefined, listedIds: [], lastCheckAt: 0 };
    inflight = undefined;
    seams = seamsOverride ?? {};
}

const refreshWindow = (): number => seams.refreshWindowMs ?? REFRESH_WINDOW_MS;
const refreshBudget = (): number => seams.budgetMs ?? REFRESH_BUDGET_MS;

/** One contents-API row → a fetchable .md entry, or undefined for every
 *  rejection class (non-file rows, non-.md names, missing/malformed urls). */
function parseListingEntry(raw: unknown): LiveEntry | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const e = raw as Record<string, unknown>;
    if (e.type !== "file") return undefined;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name.endsWith(".md")) return undefined;
    const downloadUrl = typeof e.download_url === "string" && e.download_url.startsWith("http")
        ? e.download_url
        : `${RAW_BASE}/${encodeURIComponent(name)}`;
    return { name, downloadUrl };
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
    const result = await fetchWithTimeout(
        url,
        { method: "GET", headers: { Accept: "text/plain", "user-agent": USER_AGENT } },
        FETCH_TIMEOUT_MS,
        signal,
    );
    try {
        if (!result.response.ok) throw new Error(`HTTP ${result.response.status}`);
        const text = await result.response.text();
        if (text.length === 0) throw new Error("empty body");
        return text;
    } finally {
        result.stopIdleTimer();
    }
}

/** Fixed-size worker pool over independent jobs (post bodies are independent;
 *  the listing must finish first and runs outside the pool). */
async function runPool(jobs: Array<() => Promise<void>>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= jobs.length) return;
            await jobs[i]();
        }
    });
    await Promise.all(workers);
}

/** Remote-image rewrite for live posts: relative targets resolve against the
 *  posts directory ON MASTER (posts ship their figures alongside themselves);
 *  absolute http(s)/protocol-relative refs pass through; traversal refs drop —
 *  there is no local stat to verify existence remotely, so unverifiable refs
 *  degrade to one missing <img>, never a broken panel (same drop discipline as
 *  the disk path's statSync gate). */
function rewriteRemoteImages(md: string): string {
    return md.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, target: string) => {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return `![${alt}](${target})`;
        let decoded: string;
        try {
            decoded = decodeURIComponent(target);
        } catch {
            return "";
        }
        const segs = decoded.split("/").filter((s) => s !== "" && s !== ".");
        if (segs.some((s) => s === "..")) return "";
        return `![${alt}](${RAW_BASE}/${segs.map((s) => encodeURIComponent(s)).join("/")})`;
    });
}

async function runRefresh(): Promise<void> {
    const controller = new AbortController();
    const budget = setTimeout(() => controller.abort(), refreshBudget());
    try {
        const listingResult = await fetchWithTimeout(
            LISTING_URL,
            { method: "GET", headers: { Accept: "application/vnd.github+json", "user-agent": USER_AGENT } },
            FETCH_TIMEOUT_MS,
            controller.signal,
        );
        let entries: LiveEntry[] = [];
        try {
            if (!listingResult.response.ok) throw new Error(`GitHub contents returned HTTP ${listingResult.response.status}`);
            const raw = await listingResult.response.json();
            if (!Array.isArray(raw)) throw new Error("listing payload is not a JSON array");
            entries = raw.map(parseListingEntry).filter((e): e is LiveEntry => e !== undefined);
            // Truncating here would make the dropped posts look deleted-on-master and
            // silently strip them from the panel — over-cap is an anomaly, fail soft.
            if (entries.length > MAX_FILES) throw new Error(`live listing has ${entries.length} posts (cap ${MAX_FILES})`);
        } finally {
            listingResult.stopIdleTimer();
        }
        // Pair <base>.md / <base>.zh.md exactly like the disk collector.
        const pairs = new Map<string, Pair>();
        for (const entry of entries) {
            const base = entry.name.endsWith(".zh.md") ? entry.name.slice(0, -".zh.md".length) : entry.name.slice(0, -".md".length);
            const slot = pairs.get(base) ?? {};
            slot[entry.name.endsWith(".zh.md") ? "zh" : "en"] = entry;
            pairs.set(base, slot);
        }
        // Captured BEFORE the fetch pool: it is the listing's authority even
        // for posts whose bodies later fail to render.
        const listedIds = [...pairs.keys()].map(postIdFromBase);
        const items: BlogItem[] = [];
        await runPool([...pairs.keys()].sort().map((base) => async () => {
            const pair = pairs.get(base)!;
            const half = async (which: "en" | "zh"): Promise<PostHalf | undefined> => {
                const entry = pair[which];
                if (!entry) return undefined;
                let text: string;
                try {
                    text = await fetchText(entry.downloadUrl, controller.signal);
                } catch (err) {
                    // A budget/abort failure poisons the WHOLE refresh — a
                    // partial set would wrongly become authoritative; an
                    // isolated file failure keeps just this post on its
                    // bundled twin.
                    if (controller.signal.aborted) throw err;
                    return undefined;
                }
                try {
                    return renderPostText(text, rewriteRemoteImages);
                } catch {
                    return undefined;
                }
            };
            const shaped = shapePost(base, await half("en"), await half("zh"));
            if (shaped !== undefined) items.push(shaped);
        }));
        // Content anomaly, not truth: an empty posts dir on master would wipe
        // every bundled post out of the panel, so fail soft like any error.
        if (items.length === 0) throw new Error("live listing produced no usable posts");
        state = { items, listedIds, lastCheckAt: Date.now() };
    } catch (e) {
        // Fail soft: keep the last good live set (or none), record the error,
        // throttle the retry — the bundled feed below still answers the page.
        state = { ...state, lastError: "offline", lastCheckAt: Date.now() };
        loggerLog("warn", `[blog-live] GitHub master refresh failed (${String(e)}) — serving bundled feed`);
    } finally {
        clearTimeout(budget);
    }
}

/** A successful live LISTING is authoritative for posts: a post outside
 *  listedIds was deleted on master and leaves the panel; one inside it serves
 *  its rendered live body, or keeps its bundled twin when the body failed to
 *  render; new slugs append. Articles stay bundled. */
function mergeLive(bundled: BlogItem[], live: BlogItem[], listedIds: string[]): BlogItem[] {
    const listed = new Set(listedIds);
    const liveById = new Map(live.map((i) => [i.id, i]));
    const out: BlogItem[] = [];
    for (const item of bundled) {
        if (item.kind !== "post") {
            out.push(item);
            continue;
        }
        if (!listed.has(item.id)) continue;
        const rendered = liveById.get(item.id);
        out.push(rendered ?? item);
        liveById.delete(item.id);
    }
    for (const item of liveById.values()) out.push(item);
    return sortBlogItems(out);
}

/** Access-driven throttled read: at most one GitHub round per refresh window
 *  (force bypasses). NEVER throws — every failure mode yields the bundled
 *  feed plus error:"offline" when the latest check failed. */
export async function getLiveBlogFeed(opts?: { force?: boolean }): Promise<{ items: BlogItem[]; error?: string }> {
    const stale = Date.now() - state.lastCheckAt >= refreshWindow();
    if ((opts?.force ?? false) || stale) {
        if (inflight === undefined) {
            inflight = runRefresh().finally(() => { inflight = undefined; });
        }
        await inflight;
    }
    const bundled = getBlogFeed().items;
    const items = state.items === undefined ? bundled : mergeLive(bundled, state.items, state.listedIds);
    return { items, ...(state.lastError !== undefined ? { error: state.lastError } : {}) };
}

/** GET /__bili/blog — always 200 JSON. `error` is additive (the panel ignores
 *  it today, exactly like the changelog contract); content degrades to the
 *  bundled feed on any failure mode. */
export async function handleBlogLiveGet(res: ServerResponse): Promise<void> {
    const data = await getLiveBlogFeed();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify(data));
}
