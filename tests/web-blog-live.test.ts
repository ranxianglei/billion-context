/**
 * Panel blog live refresh (#4906, src/web/blog-live.ts) — overlaying GitHub
 * master's website/blog/posts/*.md onto the bundled feed. Covers both
 * directions of every gate: merge semantics (same-id replace / new-id append /
 * deleted-on-master drops out / curated articles stay bundled), access-driven
 * throttle (one round per window, force bypasses, failures throttled too),
 * fail-soft paths (network reject, HTTP 500 listing, non-array payload, empty
 * listing = content anomaly, over-cap listing = anomaly not truncation,
 * per-file failure keeps the bundled twin), remote
 * image rewrite (relative → raw host, traversal drop, absolute passthrough),
 * malformed listing rows skipped individually, budget overrun aborting the
 * whole refresh so no partial set becomes authoritative, and
 * handleBlogLiveGet's always-200 JSON.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { getLiveBlogFeed, handleBlogLiveGet, _resetBlogLiveForTest } from "../src/web/blog-live.ts";
import { _setBlogRootForTest } from "../src/web/blogfeed.ts";

const LISTING_URL = "https://api.github.com/repos/ranxianglei/billion-context/contents/website/blog/posts?ref=master";
const RAW_BASE = "https://raw.githubusercontent.com/ranxianglei/billion-context/master/website/blog/posts";
const rawUrl = (name: string): string => `${RAW_BASE}/${name}`;

let outsideDir = "";
let pkgRoot = "";

function buildFixture(): void {
    mkdirSync(join(pkgRoot, "website", "blog", "posts"), { recursive: true });
    mkdirSync(join(pkgRoot, "paper"), { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), "{}");
    const posts = join(pkgRoot, "website", "blog", "posts");
    // Bundled post whose live twin replaces it.
    writeFileSync(join(posts, "2026-10-08_demo.md"), "---\ntitle: \"Demo post\"\nexcerpt: \"Bundled excerpt.\"\n---\n\n## Body\n\nBundled text.\n");
    writeFileSync(join(posts, "2026-10-08_demo.zh.md"), "---\ntitle_zh: \"演示文章\"\n---\n\n捆绑正文。\n");
    // Bundled post that is deleted on master — disappears once live succeeds.
    writeFileSync(join(posts, "2026-10-07_gone.md"), "# Gone post\n\nWill be deleted on master.\n");
    // Curated article — must stay bundled regardless of the live pull.
    writeFileSync(join(pkgRoot, "paper", "a.md"), "# Article Alpha\n\nAlpha body.\n");
    writeFileSync(join(pkgRoot, "website", "articles.json"), JSON.stringify({ articles: [{ file: "paper/a.md", slug: "alpha" }] }));
}

type RouteFn = (init?: RequestInit) => Response | Promise<Response>;

function mdResponse(text: string, status = 200): Response {
    return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** URL-keyed fetch stub that honors init.signal exactly like undici does —
 *  the budget-abort case depends on in-flight requests rejecting when the
 *  internal controller fires. */
function installFetch(routes: Record<string, RouteFn>): string[] {
    const hits: string[] = [];
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        hits.push(u);
        const route = routes[u];
        if (!route) return Promise.reject(new Error(`unexpected fetch in test: ${u}`));
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
        const outcome = Promise.resolve(route(init));
        if (!signal) return outcome;
        return new Promise<Response>((resolve, reject) => {
            const onAbort = () => reject(signal.reason ?? new Error("aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
            outcome.then(
                (r) => { signal.removeEventListener("abort", onAbort); resolve(r); },
                (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
            );
        });
    }) as typeof fetch;
    return hits;
}

function fakeRes(): { res: ServerResponse; status: number | undefined; ct: unknown; body: string } {
    const out: { res: ServerResponse; status: number | undefined; ct: unknown; body: string } =
        { res: undefined as unknown as ServerResponse, status: undefined, ct: undefined, body: "" };
    out.res = {
        writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.ct = headers?.["content-type"]; },
        end(chunk?: string) { if (chunk !== undefined) out.body += chunk; },
    } as unknown as ServerResponse;
    return out;
}

const origFetch = globalThis.fetch;

beforeEach(() => {
    outsideDir = mkdtempSync(join(tmpdir(), "bili-bloglive-"));
    pkgRoot = join(outsideDir, "pkg");
    buildFixture();
    _setBlogRootForTest(pkgRoot);
    _resetBlogLiveForTest();
});

afterEach(() => {
    _resetBlogLiveForTest();
    _setBlogRootForTest(null);
    globalThis.fetch = origFetch;
    rmSync(outsideDir, { recursive: true, force: true });
});

test("successful refresh is authoritative for posts: replace same-id, append new, drop deleted, keep articles", async () => {
    installFetch({
        [LISTING_URL]: () => jsonResponse([
            { type: "file", name: "2026-10-08_demo.md", download_url: rawUrl("2026-10-08_demo.md") },
            { type: "file", name: "2026-10-08_demo.zh.md", download_url: rawUrl("2026-10-08_demo.zh.md") },
            { type: "file", name: "2026-10-10_fresh.md", download_url: rawUrl("2026-10-10_fresh.md") },
        ]),
        [rawUrl("2026-10-08_demo.md")]: () => mdResponse("---\ntitle: \"Demo post\"\nexcerpt: \"Live excerpt.\"\n---\n\n## Body\n\nLIVE text.\n"),
        [rawUrl("2026-10-08_demo.zh.md")]: () => mdResponse("---\ntitle_zh: \"演示文章\"\n---\n\n实时正文。\n"),
        [rawUrl("2026-10-10_fresh.md")]: () => mdResponse("# Fresh post\n\nBrand new content.\n"),
    });
    const data = await getLiveBlogFeed();
    assert.equal(data.error, undefined);
    assert.deepEqual(data.items.map((i) => i.id), ["fresh", "demo", "alpha"], "dated newest-first, undated article tail");
    assert.ok(!data.items.some((i) => i.id === "gone"), "post deleted on master leaves the panel");
    const demo = data.items.find((i) => i.id === "demo")!;
    assert.ok(demo.html.includes("LIVE text"), "changed post serves its live body");
    assert.ok(demo.excerpt.endsWith("Live excerpt."));
    assert.ok(demo.htmlZh.includes("实时正文。"));
    const fresh = data.items.find((i) => i.id === "fresh")!;
    assert.equal(fresh.date, "2026-10-10");
    assert.equal(fresh.title, "Fresh post");
});

test("throttle: one network round per window; force bypasses", async () => {
    let listingHits = 0;
    installFetch({
        [LISTING_URL]: () => { listingHits += 1; return jsonResponse([]); },
    });
    await getLiveBlogFeed();
    await getLiveBlogFeed();
    assert.equal(listingHits, 1, "second read inside the window must not re-fetch");
    await getLiveBlogFeed({ force: true });
    assert.equal(listingHits, 2, "force bypasses the window");
});

test("network failure: bundled feed + error offline, never throws; failures throttled too", async () => {
    installFetch({}); // every URL rejects
    const data = await getLiveBlogFeed(); // must not reject
    assert.equal(data.error, "offline");
    assert.deepEqual(data.items.map((i) => i.id), ["demo", "gone", "alpha"], "pure bundled feed, bundled order");
    let hits = 0;
    installFetch({
        [LISTING_URL]: () => { hits += 1; return jsonResponse([]); },
    });
    const again = await getLiveBlogFeed();
    assert.equal(hits, 0, "a failed check is throttled — no retry storm while offline");
    assert.equal(again.error, "offline");
});

test("keeps stale live view on a failed forced check and recovers on success", async () => {
    installFetch({
        [LISTING_URL]: () => jsonResponse([{ type: "file", name: "2026-10-10_fresh.md", download_url: rawUrl("2026-10-10_fresh.md") }]),
        [rawUrl("2026-10-10_fresh.md")]: () => mdResponse("# Fresh post\n\nNew.\n"),
    });
    assert.ok((await getLiveBlogFeed()).items.some((i) => i.id === "fresh"));
    installFetch({});
    const failed = await getLiveBlogFeed({ force: true });
    assert.equal(failed.error, "offline");
    assert.ok(failed.items.some((i) => i.id === "fresh"), "stale live view retained while offline");
    installFetch({
        [LISTING_URL]: () => jsonResponse([
            { type: "file", name: "2026-10-10_fresh.md", download_url: rawUrl("2026-10-10_fresh.md") },
            { type: "file", name: "2026-10-11_newer.md", download_url: rawUrl("2026-10-11_newer.md") },
        ]),
        [rawUrl("2026-10-10_fresh.md")]: () => mdResponse("# Fresh post\n\nNew.\n"),
        [rawUrl("2026-10-11_newer.md")]: () => mdResponse("# Newer post\n\nEven newer.\n"),
    });
    const ok = await getLiveBlogFeed({ force: true });
    assert.equal(ok.error, undefined);
    assert.ok(ok.items.some((i) => i.id === "newer"), "recovered refresh serves the newest master state");
});

test("listing HTTP 500, non-array payload and empty listing all fail soft to bundled", async () => {
    globalThis.fetch = (() => Promise.resolve(jsonResponse([], 500))) as typeof fetch;
    let data = await getLiveBlogFeed();
    assert.equal(data.error, "offline");
    assert.equal(data.items.length, 3);
    _resetBlogLiveForTest();
    globalThis.fetch = (() => Promise.resolve(jsonResponse({ message: "API rate limit exceeded" }))) as typeof fetch;
    data = await getLiveBlogFeed();
    assert.equal(data.error, "offline", "non-array payload is not a listing");
    _resetBlogLiveForTest();
    globalThis.fetch = (() => Promise.resolve(jsonResponse([]))) as typeof fetch;
    data = await getLiveBlogFeed();
    assert.equal(data.error, "offline", "empty listing is a content anomaly, not truth");
    assert.equal(data.items.length, 3, "bundled posts survive an empty master listing");
});

test("a listing over the post cap fails soft — truncation would read as deletions on master", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
        type: "file",
        name: `post-${String(i).padStart(2, "0")}.md`,
        download_url: rawUrl(`post-${String(i).padStart(2, "0")}.md`),
    }));
    globalThis.fetch = (() => Promise.resolve(jsonResponse(rows))) as typeof fetch;
    const data = await getLiveBlogFeed();
    assert.equal(data.error, "offline", "over-cap is an anomaly, not a truth to truncate");
    assert.deepEqual(data.items.map((i) => i.id), ["demo", "gone", "alpha"], "bundled feed intact");
});

test("per-file failure keeps just that post on its bundled twin", async () => {
    installFetch({
        [LISTING_URL]: () => jsonResponse([
            { type: "file", name: "2026-10-08_demo.md", download_url: rawUrl("2026-10-08_demo.md") },
            { type: "file", name: "2026-10-10_fresh.md", download_url: rawUrl("2026-10-10_fresh.md") },
        ]),
        [rawUrl("2026-10-08_demo.md")]: () => mdResponse("", 404),
        [rawUrl("2026-10-10_fresh.md")]: () => mdResponse("# Fresh post\n\nNew.\n"),
    });
    const data = await getLiveBlogFeed();
    assert.equal(data.error, undefined);
    const demo = data.items.find((i) => i.id === "demo")!;
    assert.ok(demo.html.includes("Bundled text."), "failed post falls back to its bundled body");
    assert.ok(data.items.some((i) => i.id === "fresh"), "other posts still take their live bodies");
    assert.ok(!data.items.some((i) => i.id === "gone"), "deleted-on-master drops out even with a per-file failure elsewhere");
});

test("remote images: relative refs ride the raw host, traversal drops, absolute passes through", async () => {
    installFetch({
        [LISTING_URL]: () => jsonResponse([{ type: "file", name: "2026-10-10_imgs.md", download_url: rawUrl("2026-10-10_imgs.md") }]),
        [rawUrl("2026-10-10_imgs.md")]: () => mdResponse("# Imgs\n\n![fig](figures/f.png)\n\n![bad](../../secret.yaml)\n\n![abs](https://example.com/a.png)\n"),
    });
    const data = await getLiveBlogFeed();
    const item = data.items.find((i) => i.id === "imgs")!;
    assert.ok(item.html.includes(`${RAW_BASE}/figures/f.png`), "relative ref rewrites onto the raw host");
    assert.ok(!item.html.includes("secret.yaml"), "traversal ref dropped");
    assert.ok(item.html.includes("https://example.com/a.png"), "absolute ref untouched");
});

test("malformed listing rows are skipped individually, not fatal", async () => {
    const hits = installFetch({
        [LISTING_URL]: () => jsonResponse([
            { type: "file", name: "2026-10-10_ok.md", download_url: rawUrl("2026-10-10_ok.md") },
            { type: "dir", name: "figures" },
            { name: "no-type.md" },
            null,
            { type: "file", name: "notes.txt" },
            { type: "file", name: 42 },
        ]),
        [rawUrl("2026-10-10_ok.md")]: () => mdResponse("# OK\n\nFine.\n"),
    });
    const data = await getLiveBlogFeed();
    assert.equal(data.error, undefined);
    assert.ok(data.items.some((i) => i.id === "ok"));
    assert.ok(!hits.some((h) => h.includes("/figures") || h.includes("notes.txt")), "unusable rows never reach the wire");
});

test("budget overrun aborts the whole refresh — no partial set becomes authoritative", async () => {
    _resetBlogLiveForTest({ budgetMs: 50 });
    const slowBody = () => new Promise<Response>((resolve) => { setTimeout(() => resolve(mdResponse("# Slow\n\nLate.\n")), 500); });
    installFetch({
        [LISTING_URL]: () => jsonResponse([{ type: "file", name: "2026-10-10_slow.md", download_url: rawUrl("2026-10-10_slow.md") }]),
        [rawUrl("2026-10-10_slow.md")]: slowBody,
    });
    const data = await getLiveBlogFeed();
    assert.equal(data.error, "offline", "aborted refresh fails soft");
    assert.ok(!data.items.some((i) => i.id === "slow"), "an aborted refresh contributes nothing");
    assert.equal(data.items.length, 3, "bundled feed intact");
});

test("handleBlogLiveGet answers 200 JSON — merged path and offline path", async () => {
    installFetch({
        [LISTING_URL]: () => jsonResponse([{ type: "file", name: "2026-10-10_fresh.md", download_url: rawUrl("2026-10-10_fresh.md") }]),
        [rawUrl("2026-10-10_fresh.md")]: () => mdResponse("# Fresh post\n\nNew.\n"),
    });
    const warm = fakeRes();
    await handleBlogLiveGet(warm.res);
    assert.equal(warm.status, 200);
    assert.match(String(warm.ct), /^application\/json/);
    const parsedWarm = JSON.parse(warm.body) as { items: Array<{ id: string }>; error?: string };
    assert.ok(parsedWarm.items.some((i) => i.id === "fresh"));
    assert.equal(parsedWarm.error, undefined);

    _resetBlogLiveForTest();
    globalThis.fetch = (() => Promise.reject(new Error("ENOTFOUND"))) as typeof fetch;
    const cold = fakeRes();
    await handleBlogLiveGet(cold.res);
    assert.equal(cold.status, 200, "the panel degrades, it never errors");
    const parsedCold = JSON.parse(cold.body) as { items: unknown[]; error: string };
    assert.equal(parsedCold.items.length, 3);
    assert.equal(parsedCold.error, "offline");
});
