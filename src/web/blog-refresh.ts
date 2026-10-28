/**
 * GitHub-master blog refresh (#4906).
 *
 * web/blogfeed.ts serves the blog & article content FROZEN into the package
 * at release time; this module pulls the LIVE `master` copy of the same tree
 * (website/blog/posts/*.md + website/articles.json entries + their images)
 * from the public GitHub APIs and registers it as the overlay that
 * getBlogFeed()/the asset route prefer over the bundled bytes.
 *
 * Design constraints (mirror web/changelog.ts):
 * - read-only public API, NO credentials, no config key, no env var:
 *   api.github.com repo-contents listing + raw.githubusercontent.com files,
 *   rate-limited unauthenticated exactly like the changelog probe;
 * - fail soft: any network failure keeps the last good overlay (or the
 *   bundled floor before the first success) and only records an "offline"
 *   marker; nothing throws out of the HTTP layer — kickBlogRefresh is
 *   fire-and-forget by construction;
 * - one round at a time (in-flight coalescing) and a TTL between rounds, so a
 *   panel that polls the feed cannot turn this into a scrape;
 * - once ANY entry point touches this module, the same TTL re-arms as an
 *   hourly self-scheduling chain (unref'd timer) that force-kicks a round:
 *   served content ages out to ~1h even when nobody keeps visiting (owner
 *   requirement, #4906 follow-up 2026-10-27). Short-lived CLIs stay
 *   unaffected — the handle is unref'd, so it never holds the event loop
 *   open.
 * - atomic replacement: a round fully downloads its document set (posts,
 *   article texts) and registers everything at once, or registers only the
 *   error marker — a half-fetched tree would render broken bilingual pairs.
 *   Two exceptions are normal churn, not failures: image 404s (their image
 *   references are then dropped by buildRemoteBlogPosts' asset-key gate,
 *   exactly like the disk path) and an absent articles.json (posts-only
 *   round).
 */
import { fetchWithTimeout } from "../fetch-util.js";
import { log as loggerLog } from "../logger.js";
import {
    ASSET_TYPES,
    buildRemoteBlogPosts,
    collectImageTargets,
    registerRemoteBlogFeed,
} from "./blogfeed.js";

const GITHUB_CONTENTS_URL = "https://api.github.com/repos/ranxianglei/billion-context/contents";
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/ranxianglei/billion-context";
const BRANCH = "master";
const POST_DIR = "website/blog/posts";
const MANIFEST_REL = "website/articles.json";
const FETCH_TIMEOUT_MS = 5_000;
/** Minimum wall-clock gap between two actual GitHub rounds (#4906 design):
 *  anonymous contents API is rate-limited ~60 req/h/IP, so a 1h window keeps
 *  even a chatty panel well inside the quota; misses are absorbed fail-soft.
 *  The first-ever round runs immediately (lastRoundStartedAt starts at 0);
 *  force overrides. */
const ROUND_TTL_MS = 60 * 60 * 1000;
const CONCURRENCY = 4;
const MAX_TEXT_BYTES = 512 * 1024;              // one markdown/article document
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;        // one figure
const MAX_TOTAL_DOWNLOAD_BYTES = 8 * 1024 * 1024; // whole round
const MAX_TOTAL_FILES = 200;                    // documents + images per round
const MAX_IMAGE_CANDIDATES = 50;                // deduped relative targets per round

type TextFileMap = Map<string, string>;                            // repo-relative path → raw text
type BinaryAssetMap = Map<string, { buf: Buffer; type: string }>;  // repo-relative path → bytes

let lastRoundStartedAt = 0;
let inflight: Promise<void> | undefined;
let warmAttempted = false;
/** Set once a round has registered a live master snapshot in this process.
 *  The status-path warmer checks this so repeat status hits on an already-warm
 *  process stay network-free — the same cadence the changelog footer has with
 *  its empty-cache check (warm only while cold). */
let remoteSnapshotPresent = false;
/** Hourly self-chain handle (#4906 follow-up); unref'd, cleared on reset. */
let scheduleHandle: ReturnType<typeof setTimeout> | undefined;
let disabled = false; // test seam

export function _resetBlogRefreshForTest(): void {
    lastRoundStartedAt = 0;
    inflight = undefined;
    warmAttempted = false;
    remoteSnapshotPresent = false;
    if (scheduleHandle !== undefined) clearTimeout(scheduleHandle);
    scheduleHandle = undefined;
    disabled = false;
}

export function _setBlogRefreshDisabledForTest(disabledFlag: boolean): void {
    disabled = disabledFlag;
}

/** Warm trigger for sync callers on the status path (plugin.ts footer, next
 *  to warmChangelogOnce): force-kicks a round so the panel can show fresh
 *  master content without waiting for /__bili/blog. Fires ONLY from cold:
 *  once any live master snapshot is registered in this process every later
 *  call is a no-op, so a long-lived panel's repeated status hits never turn
 *  this into a scrape. Fire-and-forget; never throws; at most one attempt per
 *  process lifetime. */
export function warmBlogRefreshOnce(): void {
    if (warmAttempted || remoteSnapshotPresent) return;
    warmAttempted = true;
    kickBlogRefresh({ force: true });
}

/** Hourly self-scheduling chain (#4906 follow-up): the first entry point a
 *  process reaches (the /__bili/blog route, the status-path warm, or a test
 *  round) starts a repeating force-kick every ROUND_TTL_MS, so any long-lived
 *  process serving users shows fresh master content within ~1h even with no
 *  further traffic; every later arming attempt is a no-op. Force lets a
 *  failed round retry on the hour instead of slipping a full window; the
 *  rate cost of a failing round is ~1 contents-API request. The handle is
 *  unref'd: short-lived CLIs exit normally, tests reset it per case.
 *  Disabled modules never arm. */
function armSchedule(): void {
    if (scheduleHandle !== undefined || disabled) return;
    const t = setTimeout(() => {
        scheduleHandle = undefined;
        kickBlogRefresh({ force: true }); // its head re-arms the next hop
    }, ROUND_TTL_MS);
    t.unref?.();
    scheduleHandle = t;
}

/** Fire-and-forget entry point for sync callers (the /__bili/blog handler,
 *  server warm-up). Never throws: coalesces onto an in-flight round, skips
 *  silently outside the TTL unless force. */
export function kickBlogRefresh(opts?: { force?: boolean }): void {
    armSchedule(); // first touch in this process arms the hourly chain
    if (disabled || inflight !== undefined) return;
    const due = (opts?.force ?? false) || Date.now() - lastRoundStartedAt >= ROUND_TTL_MS;
    if (!due) return;
    lastRoundStartedAt = Date.now();
    const base = runRound();
    // gate is the rejection-immune twin of base (the same guard
    //  runBlogRefreshRound carries): kickBlogRefresh is fire-and-forget, so
    //  an unexpected runRound reject must never surface as an
    //  unhandledRejection (a process crash on Node ≥ 15).
    const gate = settleRoundImmune(base, () => { if (inflight === gate) inflight = undefined; });
    inflight = gate; // assigned synchronously — the settle callback can only run later
}

/** One full GitHub pull round, awaitable (tests); production callers use
 *  kickBlogRefresh. Resolves with a snapshot of what happened — never
 *  rejects; failure details land in the registered feed error marker. */
export async function runBlogRefreshRound(opts?: { force?: boolean }): Promise<{ ok: boolean; error?: string }> {
    if (disabled) return { ok: false, error: "disabled" };
    armSchedule();
    if (inflight === undefined && !((opts?.force ?? false) || Date.now() - lastRoundStartedAt >= ROUND_TTL_MS)) {
        return { ok: true }; // within TTL and nothing running — nothing to do
    }
    if (inflight === undefined) {
        lastRoundStartedAt = Date.now();
        const base = runRound();
        // gate is the rejection-immune twin of base: it only tracks settle-
        // ment so an unexpected reject can never leak as an unhandled one.
        const gate = settleRoundImmune(base, () => { if (inflight === gate) inflight = undefined; });
        inflight = gate; // assigned synchronously — the settle callback can only run later
        try {
            await base;
            return { ok: true };
        } catch {
            // runRound catches internally; this guards only a contract break.
            return { ok: false, error: "offline" };
        }
    }
    await inflight;
    return { ok: true };
}

async function runRound(): Promise<void> {
    const files: TextFileMap = new Map();
    const assets: BinaryAssetMap = new Map();
    let downloadedBytes = 0;
    /** Whole-round download budget (#4906): overshoot fails the round.
     *  Called per completed download (concurrency-safe: one-threaded loop). */
    const account = (n: number): void => {
        downloadedBytes += n;
        if (downloadedBytes > MAX_TOTAL_DOWNLOAD_BYTES) throw new Error(`round downloads exceed ${MAX_TOTAL_DOWNLOAD_BYTES} bytes`);
    };
    try {
        // 1. Post listing via the contents API, then every .md body from the
        //    raw host (the contents API base64-encodes bodies; raw is simpler
        //    and avoids its size cap for big figures).
        const listing = await getJsonList(`${GITHUB_CONTENTS_URL}/${POST_DIR}?ref=${BRANCH}`);
        const names = listing
            .filter((e) => e.type === "file" && typeof e.name === "string" && e.name.endsWith(".md"))
            .map((e) => e.name as string)
            .sort();
        await fetchAllText(
            names.map((n) => ({ rel: `${POST_DIR}/${n}`, url: `${GITHUB_RAW_BASE}/${BRANCH}/${POST_DIR}/${encodeURIComponent(n)}` })),
            files,
            account,
        );
        if (files.size === 0) throw new Error("no post files returned");


        // 2. Article manifest: ABSENT ⇒ posts-only round (not a failure);
        //    present-but-malformed ⇒ same, degrade silently. The raw text is
        //    kept in `files` under MANIFEST_REL — buildRemoteBlogPosts re-reads
        //    it by that key when assembling the article section.
        let entries: ArticleEntry[] = [];
        try {
            const manifestText = await getText(`${GITHUB_RAW_BASE}/${BRANCH}/${MANIFEST_REL}`, account);
            files.set(MANIFEST_REL, manifestText);
            const parsed = JSON.parse(manifestText) as { articles?: unknown };
            if (Array.isArray(parsed.articles)) entries = parsed.articles.filter(isArticleEntry);
        } catch {
            entries = [];
        }
        const wanted: string[] = [];
        for (const e of entries) {
            for (const rel of [e.file, ...(e.zh_file !== undefined ? [e.zh_file] : [])]) {
                if (isSafeRelPath(rel) && !wanted.includes(rel) && !files.has(rel)) wanted.push(rel);
            }
        }
        await fetchAllText(wanted.map((rel) => ({ rel, url: rawUrl(rel) })), files, account);

        // 3. Images referenced by ANY downloaded markdown — collected BEFORE
        //    rendering so the download set and buildRemoteBlogPosts' drop
        //    decision agree by construction (#4906). A 404 is normal churn.
        const targets = new Set<string>();
        for (const [rel, text] of files) {
            if (!rel.endsWith(".md")) continue;
            const baseDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
            for (const t of collectImageTargets(text, baseDir)) {
                if (ASSET_TYPES[t.slice(t.lastIndexOf(".")).toLowerCase()] !== undefined) targets.add(t);
            }
        }
        const targetList = [...targets].sort().slice(0, MAX_IMAGE_CANDIDATES);
        if (files.size + targetList.length > MAX_TOTAL_FILES) {
            throw new Error(`round file count exceeds ${MAX_TOTAL_FILES}`);
        }
        await fetchAllBinary(targetList.map((rel) => ({ rel, url: rawUrl(rel) })), assets, account);

        registerRemoteBlogFeed({ items: buildRemoteBlogPosts(files, new Set(assets.keys())), assets });
        remoteSnapshotPresent = true; // successful round ⇒ ≥1 post registered
        loggerLog("info", `[blog-refresh] GitHub master round ok: ${files.size} documents, ${assets.size} images`);
    } catch (e) {
        // Keep whatever good overlay exists; the marker tells the panel it is
        // showing the frozen bundle (or the previous master snapshot).
        registerRemoteBlogFeed({ items: [], assets: new Map(), error: "offline" });
        loggerLog("warn", `[blog-refresh] GitHub master round failed (${String(e)}) — serving bundled/fallback content`);
    }
}

/* ------------------------- transport helpers ------------------------- */

interface ContentsEntry { name?: unknown; type?: unknown }
interface ArticleEntry { file: string; zh_file?: string; slug?: string; title?: string; title_zh?: string }

function isArticleEntry(x: unknown): x is ArticleEntry {
    const e = x as Partial<ArticleEntry>;
    return typeof e.file === "string" && e.file.length > 0 && !e.file.includes("\0")
        && (e.zh_file === undefined || typeof e.zh_file === "string");
}

/** Root-relative POSIX path without absolute/escape/odd-segment surprises —
 *  same rejection classes the bundled collectArticles applies on disk. */
function isSafeRelPath(p: string): boolean {
    if (p.startsWith("/") || p.includes("\0")) return false;
    return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function rawUrl(rel: string): string {
    return `${GITHUB_RAW_BASE}/${BRANCH}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

async function getJsonList(url: string): Promise<ContentsEntry[]> {
    const result = await fetchWithTimeout(url, ghHeaders("application/json"), FETCH_TIMEOUT_MS);
    try {
        if (!result.response.ok) throw new Error(`GitHub contents API returned HTTP ${result.response.status}`);
        const raw = await result.response.json();
        if (!Array.isArray(raw)) throw new Error("contents listing is not a JSON array");
        return raw as ContentsEntry[];
    } finally {
        result.stopIdleTimer(); // body fully consumed (fetch-util #552 contract)
    }
}

/** Download + cap + utf8-decode ONE text document. Any HTTP error, oversize
 *  body or budget miss THROWS — the caller fails the whole round; a
 *  half-fetched tree must not render. */
async function getText(url: string, account?: (bytes: number) => void): Promise<string> {
    const result = await fetchWithTimeout(url, ghHeaders(), FETCH_TIMEOUT_MS);
    try {
        if (!result.response.ok) throw new Error(`raw GET ${url} → HTTP ${result.response.status}`);
        const declared = contentLengthOf(result.response.headers);
        if (declared !== undefined && declared > MAX_TEXT_BYTES) {
            throw new Error(`text document exceeds ${MAX_TEXT_BYTES} bytes (content-length ${declared}): ${url}`);
        }
        const buf = Buffer.from(await result.response.arrayBuffer());
        if (buf.byteLength > MAX_TEXT_BYTES) throw new Error(`text document exceeds ${MAX_TEXT_BYTES} bytes: ${url}`);
        account?.(buf.byteLength);
        return buf.toString("utf8");
    } finally {
        result.stopIdleTimer();
    }
}

/** Download ONE image; 404/oversize are SILENT MISSES (return undefined), any
 *  other failure throws. The rendered feed drops references whose target did
 *  not make it into the assets map — identical to the bundled disk path. */
async function getImage(url: string, account?: (bytes: number) => void): Promise<{ buf: Buffer; type: string } | undefined> {
    let ext = "";
    const dot = url.lastIndexOf(".");
    if (dot !== -1) ext = url.slice(dot).toLowerCase();
    const type = ASSET_TYPES[ext];
    if (type === undefined) return undefined;
    const result = await fetchWithTimeout(url, ghHeaders(), FETCH_TIMEOUT_MS);
    try {
        if (result.response.status === 404) return undefined;
        if (!result.response.ok) throw new Error(`image GET ${url} → HTTP ${result.response.status}`);
        const declared = contentLengthOf(result.response.headers);
        if (declared !== undefined && declared > MAX_IMAGE_BYTES) return undefined; // never download the body
        const buf = Buffer.from(await result.response.arrayBuffer());
        if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return undefined;
        account?.(buf.byteLength);
        return { buf, type };
    } finally {
        result.stopIdleTimer();
    }
}

function ghHeaders(accept?: string): Record<string, string> {
    const h: Record<string, string> = { "user-agent": "billion-context-blog-refresh" };
    if (accept !== undefined) h.Accept = accept;
    return h;
}

/** Rejection-immune settle twin of a round promise — the guard BOTH
 *  fire-and-forget launchers (kickBlogRefresh, runBlogRefreshRound's own
 *  round start) route through: the returned promise only tracks settlement,
 *  so an unexpected runRound reject can never leak as an unhandledRejection
 *  (Node ≥ 15 crashes the process on one); onSettle clears `inflight`
 *  (caller-guarded so an older round cannot clear a newer one). */
export function settleRoundImmune(base: Promise<void>, onSettle: () => void): Promise<void> {
    return base.then(() => undefined, () => undefined).finally(onSettle);
}

/** Numeric `content-length` of a response — undefined when the header is
 *  absent or not a plain digit run. An over-limit declaration lets
 *  getText/getImage reject/miss BEFORE reading the body, so a huge response
 *  never enters RAM; the post-read byte checks stay the authority when the
 *  header is absent or lies. */
function contentLengthOf(headers: Headers): number | undefined {
    const v = headers.get("content-length");
    if (v === null || !/^\d+$/.test(v)) return undefined;
    return Number(v);
}

/** Map with bounded parallelism (CONCURRENCY), preserving input order; the
 *  first rejection rejects immediately (round fails). */
async function mapPool<T>(items: T[], fn: (t: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            await fn(items[i]);
        }
    });
    await Promise.all(workers);
}

async function fetchAllText(targets: { rel: string; url: string }[], sink: TextFileMap, account?: (bytes: number) => void): Promise<void> {
    await mapPool(targets, async (t) => { sink.set(t.rel, await getText(t.url, account)); });
}

async function fetchAllBinary(targets: { rel: string; url: string }[], sink: BinaryAssetMap, account?: (bytes: number) => void): Promise<void> {
    await mapPool(targets, async (t) => {
        const got = await getImage(t.url, account);
        if (got !== undefined) sink.set(t.rel, got);
    });
}
