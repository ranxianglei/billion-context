/**
 * GitHub-master blog refresh (#4906) — src/web/blog-refresh.ts + the remote
 * overlay seams it registers into src/web/blogfeed.ts. Covers: merge
 * priority (remote wins per id, bundled-only ids survive), asset route
 * remote-first/disk-fallback split, image-404 churn (reference dropped,
 * round succeeds), fail-soft (offline marker + last-good/bundled content
 *  kept, nothing throws), TTL gating + single-flight coalescing, remote
 *  long-form article rendering from the manifest (+ malformed-manifest
 *  degrade), the pure resolveRepoRel escape classes, and collectImageTargets
 *  candidate sets.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import {
    getBlogFeed,
    handleBlogAssetGet,
    getRemoteBlogAsset,
    _setBlogRootForTest,
    resolveRepoRel,
    collectImageTargets,
} from "../src/web/blogfeed.ts";
import {
    runBlogRefreshRound,
    kickBlogRefresh,
    warmBlogRefreshOnce,
    _resetBlogRefreshForTest,
    _setBlogRefreshDisabledForTest,
    settleRoundImmune,
} from "../src/web/blog-refresh.ts";
import { blogCacheStale } from "../src/web/client.ts";
import { MESSAGES } from "../src/web/i18n.ts";

const CONTENTS_URL = "https://api.github.com/repos/ranxianglei/billion-context/contents/website/blog/posts?ref=master";
const rawUrl = (rel: string): string => `https://raw.githubusercontent.com/ranxianglei/billion-context/master/${rel}`;

const REMOTE_PNG = Buffer.from("REMOTE-PNG-BYTES");
const GOOD_PNG = Buffer.from("GOOD-PNG");
const BUNDLED_PNG = Buffer.from("BUNDLED-PNG");

let outsideDir = "";
let pkgRoot = "";
let origFetch: typeof fetch | undefined;
let hits: string[] = [];
/** URL → Response factory; a thrown error simulates network failure. */
let router: (url: string) => Response | Promise<Response> = () => { throw new Error("unexpected fetch"); };

function fakeRes(): { res: ServerResponse; status: number | undefined; headers: Record<string, string>; body: string } {
    const out: { res: ServerResponse; status: number | undefined; headers: Record<string, string>; body: string } =
        { res: undefined as unknown as ServerResponse, status: undefined, headers: {}, body: "" };
    out.res = {
        writeHead(_status: number, headers?: Record<string, string>) { out.status = _status; out.headers = headers ?? {}; },
        end(chunk?: string | Uint8Array) { if (chunk !== undefined) out.body += Buffer.from(chunk).toString("utf8"); },
    } as unknown as ServerResponse;
    return out;
}

function installGithubRouter(): void {
    router = (url) => {
        if (url === CONTENTS_URL) {
            return new Response(JSON.stringify([
                { name: "2026-10-08_demo.md", type: "file" },
                { name: "2026-10-08_demo.zh.md", type: "file" },
                { name: "2026-10-09_fresh.md", type: "file" },
                { name: "figures", type: "dir" },
            ]), { status: 200 });
        }
        switch (url) {
            case rawUrl("website/blog/posts/2026-10-08_demo.md"):
                return new Response("---\ntitle: \"Demo (remote updated)\"\ndate: \"2026-10-08\"\nexcerpt: \"EN remote\"\n---\n\n## Remote body\n\n![r](figures/r.png)\n", { status: 200 });
            case rawUrl("website/blog/posts/2026-10-08_demo.zh.md"):
                return new Response("---\ntitle_zh: \"演示（远端更新）\"\nexcerpt_zh: \"中文远端\"\n---\n\n中文远端正文。\n", { status: 200 });
            case rawUrl("website/blog/posts/2026-10-09_fresh.md"):
                return new Response("# Brand new post\n\nfresh text\n\n![ok](figures/good.png)\n\n![gone](figures/missing.png)\n", { status: 200 });
            case rawUrl("website/blog/posts/figures/r.png"):
                return new Response(REMOTE_PNG, { status: 200 });
            case rawUrl("website/blog/posts/figures/good.png"):
                return new Response(GOOD_PNG, { status: 200 });
            case rawUrl("website/blog/posts/figures/missing.png"):
                return new Response("nope", { status: 404 });
            default:
                return new Response("not here", { status: 404 }); // e.g. articles.json absent ⇒ posts-only
        }
    };
}

function makeAllFail(): void {
    router = () => { throw new Error("network down"); };
}

beforeEach(() => {
    outsideDir = mkdtempSync(join(tmpdir(), "bili-blogrefresh-"));
    pkgRoot = join(outsideDir, "pkg");
    const posts = join(pkgRoot, "website", "blog", "posts");
    mkdirSync(join(posts, "figures"), { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), "{}");
    writeFileSync(join(posts, "2026-10-08_demo.md"), "---\ntitle: \"Demo (bundled)\"\ndate: \"2026-10-08\"\n---\n\nbundled body\n");
    writeFileSync(join(posts, "2025-01-01_old.md"), "# Bundled-only post\n\nolder bundled content\n");
    writeFileSync(join(posts, "figures", "b.png"), BUNDLED_PNG);
    _setBlogRootForTest(pkgRoot);
    _resetBlogRefreshForTest();
    hits = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = ((url: unknown) => {
        const u = String(url);
        hits.push(u);
        return Promise.resolve(router(u));
    }) as typeof fetch;
});

afterEach(() => {
    if (origFetch !== undefined) globalThis.fetch = origFetch;
    _setBlogRootForTest(null);
    _resetBlogRefreshForTest();
    rmSync(outsideDir, { recursive: true, force: true });
});

test("successful round overlays master onto the bundled feed (remote wins per id)", async () => {
    installGithubRouter();
    const before = getBlogFeed().items.map((i) => i.id);
    assert.ok(before.includes("old"));
    const out = await runBlogRefreshRound({ force: true });
    assert.equal(out.ok, true);
    const feed = getBlogFeed();
    assert.equal(feed.error, undefined);
    const byId = new Map(feed.items.map((i) => [i.id, i]));
    assert.equal(byId.get("demo")?.title, "Demo (remote updated)");           // remote wins
    assert.equal(byId.get("demo")?.titleZh, "演示（远端更新）");
    assert.equal(byId.get("fresh")?.title, "Brand new post");                 // brand-new master id
    assert.equal(byId.get("old")?.title, "Bundled-only post");                // bundled id survives
    assert.match(byId.get("demo")?.html ?? "", /\/__bili\/blog-assets\/website\/blog\/posts\/figures\/r\.png/);
});

test("asset route serves remote-memory images first, bundled disk bytes after, 404 misses stay 404", async () => {
    installGithubRouter();
    await runBlogRefreshRound({ force: true });
    assert.ok(getRemoteBlogAsset("website/blog/posts/figures/r.png"));  // direct map access
    assert.equal(getRemoteBlogAsset("never/fetched.png"), undefined);
    const r1 = fakeRes();
    handleBlogAssetGet(r1.res, "/__bili/blog-assets/website/blog/posts/figures/r.png");
    assert.equal(r1.status, 200);
    assert.equal(Buffer.from(r1.body, "utf8").toString(), "REMOTE-PNG-BYTES");
    const r2 = fakeRes();
    handleBlogAssetGet(r2.res, "/__bili/blog-assets/website/blog/posts/figures/b.png");
    assert.equal(r2.status, 200);
    assert.equal(r2.body, "BUNDLED-PNG");
    const r3 = fakeRes();
    handleBlogAssetGet(r3.res, "/__bili/blog-assets/website/blog/posts/figures/missing.png");
    assert.equal(r3.status, 404);
});

test("image 404 during download is churn: its reference is dropped, the round still succeeds", async () => {
    installGithubRouter();
    const out = await runBlogRefreshRound({ force: true });
    assert.equal(out.ok, true);
    const fresh = getBlogFeed().items.find((i) => i.id === "fresh");
    assert.match(fresh?.html ?? "", /good\.png/);
    assert.doesNotMatch(fresh?.html ?? "", /missing\.png/);
});

test("failed round keeps the last good overlay and records an offline marker (nothing throws)", async () => {
    installGithubRouter();
    assert.equal((await runBlogRefreshRound({ force: true })).ok, true);
    makeAllFail();
    const out = await runBlogRefreshRound({ force: true });
    assert.equal(out.ok, true); // resolves — failure rides the feed error marker
    const feed = getBlogFeed();
    assert.equal(feed.error, "offline");
    const ids = feed.items.map((i) => i.id);
    for (const id of ["demo", "fresh", "old"]) assert.ok(ids.includes(id));
});

test("first-ever round failing still serves the bundled floor with the marker", async () => {
    makeAllFail();
    await runBlogRefreshRound({ force: true });
    const feed = getBlogFeed();
    assert.equal(feed.error, "offline");
    assert.deepEqual(feed.items.map((i) => i.id).sort(), ["demo", "old"]);
});

test("disabled state short-circuits rounds without network (test escape hatch)", async () => {
    installGithubRouter();
    _setBlogRefreshDisabledForTest(true);
    const out = await runBlogRefreshRound({ force: true });
    assert.equal(out.ok, false);
    assert.equal(out.error, "disabled");
    assert.equal(hits.length, 0);
});

test("TTL gates repeated kicks; single-flight coalesces; force bypasses", async () => {
    installGithubRouter();
    await runBlogRefreshRound({ force: true });
    const afterOne = hits.length;
    kickBlogRefresh();               // within TTL, idle → no network
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(hits.length, afterOne);
    kickBlogRefresh({ force: true }); // bypasses the window
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(hits.length > afterOne);
});

test("concurrent forced rounds coalesce into one network pass (single-flight)", async () => {
    installGithubRouter();
    await Promise.all([runBlogRefreshRound({ force: true }), runBlogRefreshRound({ force: true })]);
    assert.equal(hits.filter((u) => u === CONTENTS_URL).length, 1);
});

/* ---------------- hourly self-chain (#4906 follow-up) ------------------ */

test("first touch arms the hourly chain: forced rounds land at ~1h and ~2h without traffic", async (t) => {
    installGithubRouter();
    t.mock.timers.enable({ apis: ["setTimeout"] });   // active BEFORE any arm
    await runBlogRefreshRound({ force: true });
    const after1 = hits.filter((u) => u === CONTENTS_URL).length;
    assert.equal(after1, 1);
    const ROUND = 60 * 60 * 1000;                     // must match ROUND_TTL_MS
    t.mock.timers.tick(ROUND);                        // an hour passes, zero traffic
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    const after2 = hits.filter((u) => u === CONTENTS_URL).length;
    assert.ok(after2 > after1, "the hourly forced round ran");
    t.mock.timers.tick(ROUND);                        // chain re-armed inside the kick
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    const after3 = hits.filter((u) => u === CONTENTS_URL).length;
    assert.ok(after3 > after2, "the chain keeps ticking");
    t.mock.timers.reset();                            // drop the pending mock timer
});

test("armSchedule stays silent while disabled (test escape hatch never arms)", async () => {
    installGithubRouter();
    _setBlogRefreshDisabledForTest(true);
    const out = await runBlogRefreshRound({ force: true });
    assert.equal(out.ok, false);
    assert.equal(hits.length, 0);
});

/* ---------------- status-path warm trigger (plugin.ts cadence) ---------- */

test("warmBlogRefreshOnce pulls exactly once per process from fully cold state", async () => {
    installGithubRouter();
    warmBlogRefreshOnce();                    // cold process → force round
    const n = hits.filter((u) => u === CONTENTS_URL).length;
    assert.equal(n, 1);                       // round kicked
    warmBlogRefreshOnce();                    // later status hit while in-flight
    await runBlogRefreshRound({ force: true }); // settle (coalesces onto it)
    warmBlogRefreshOnce();                    // much later status hit
    assert.equal(hits.filter((u) => u === CONTENTS_URL).length, 1);
});

test("warmBlogRefreshOnce skips when a master snapshot already exists in-process", async () => {
    installGithubRouter();
    await runBlogRefreshRound({ force: true });   // e.g. /__bili/blog warmed it first
    const afterOne = hits.length;
    warmBlogRefreshOnce();                    // snapshot present → no pull
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(hits.length, afterOne);
});

/* ---------------- remote long-form articles (manifest overlay) ------------ */

test("successful round renders master long-form articles from the manifest", async () => {
    router = (url) => {
        switch (url) {
            case CONTENTS_URL:
                return new Response(JSON.stringify([{ name: "2026-10-09_fresh.md", type: "file" }]), { status: 200 });
            case rawUrl("website/blog/posts/2026-10-09_fresh.md"):
                return new Response("# Fresh post\n\npost body\n", { status: 200 });
            case rawUrl("website/articles.json"):
                return new Response(JSON.stringify({ articles: [
                    { file: "website/articles/long-form.md", zh_file: "website/articles/long-form.zh.md", slug: "long-form", title: "Long Form", title_zh: "长文" },
                ] }), { status: 200 });
            case rawUrl("website/articles/long-form.md"):
                return new Response("---\ntitle: \"Long Form\"\ndate: \"2026-01-01\"\n---\n\n# Long Form\n\nlong form body\n", { status: 200 });
            case rawUrl("website/articles/long-form.zh.md"):
                return new Response("---\ntitle_zh: \"长文\"\n---\n\n中文长文正文。\n", { status: 200 });
            default:
                return new Response("not here", { status: 404 });
        }
    };
    const out = await runBlogRefreshRound({ force: true });
    assert.equal(out.ok, true);
    const art = getBlogFeed().items.find((i) => i.kind === "article" && i.id === "long-form");
    assert.ok(art, "remote long-form article must appear in the merged feed");
    assert.equal(art?.title, "Long Form");
    assert.equal(art?.titleZh, "长文");
    assert.match(art?.html ?? "", /long form body/);
    assert.match(art?.htmlZh ?? "", /中文长文正文/);
});

test("an oversize document blows the round budget: fail-soft keeps the last good overlay", async () => {
    installGithubRouter();
    assert.equal((await runBlogRefreshRound({ force: true })).ok, true); // good baseline
    const big = "x".repeat(512 * 1024 + 1);
    router = (url) => {
        if (url === CONTENTS_URL) return new Response(JSON.stringify([{ name: "2026-10-09_fresh.md", type: "file" }]), { status: 200 });
        if (url === rawUrl("website/blog/posts/2026-10-09_fresh.md")) return new Response(big, { status: 200 });
        return new Response("not here", { status: 404 });
    };
    const out = await runBlogRefreshRound({ force: true });
    assert.equal(out.ok, true); // resolves — the failure rides the feed marker
    const feed = getBlogFeed();
    assert.equal(feed.error, "offline");
    assert.ok(feed.items.some((i) => i.id === "demo"), "previous good overlay survives");
});

test("malformed articles.json degrades to a posts-only round without failing", async () => {
    router = (url) => {
        if (url === CONTENTS_URL) return new Response(JSON.stringify([{ name: "2026-10-09_fresh.md", type: "file" }]), { status: 200 });
        if (url === rawUrl("website/blog/posts/2026-10-09_fresh.md")) return new Response("# Fresh post\n\npost body\n", { status: 200 });
        if (url === rawUrl("website/articles.json")) return new Response("{ not json", { status: 200 });
        return new Response("not here", { status: 404 });
    };
    const out = await runBlogRefreshRound({ force: true });
    assert.equal(out.ok, true);
    const feed = getBlogFeed();
    assert.ok(feed.items.some((i) => i.kind === "post" && i.id === "fresh"));
    assert.ok(!feed.items.some((i) => i.kind === "article"));
});

/* ---------------- pure helpers exported from blogfeed ---------------- */

test("resolveRepoRel: normal resolution, sibling .., root-escape, bad input", () => {
    assert.equal(resolveRepoRel("website/blog/posts", "figures/x.png"), "website/blog/posts/figures/x.png");
    assert.equal(resolveRepoRel("website/blog/posts", "./y.png"), "website/blog/posts/y.png");
    assert.equal(resolveRepoRel("website/blog/posts", "../shared/y.png"), "website/blog/shared/y.png");
    assert.equal(resolveRepoRel("", "root-level.png"), "root-level.png");
    assert.equal(resolveRepoRel("paper/a", "../../../z.png"), undefined); // climbs above the tree root
    assert.equal(resolveRepoRel("a", "../..//../../w.png"), undefined);
    assert.equal(resolveRepoRel("a", "/abs.png"), undefined);              // absolute
    assert.equal(resolveRepoRel("a", "%zz"), undefined);                   // bad percent-encoding
    assert.equal(resolveRepoRel("a", "nul\x00.png"), undefined);
    assert.equal(resolveRepoRel("a", ""), undefined);
});

test("collectImageTargets: dedupes, skips scheme targets, resolves against the file dir", () => {
    const md = "![a](figs/p.png)\n![b](figs/p.png)\n![c](../shared/q.gif)\n![d](http://x.example/z.png)\n![e](mailto:a@b.c)\n![f](bad %zz)\n";
    assert.deepEqual(collectImageTargets(md, "website/blog/posts").sort(), [
        "website/blog/posts/figs/p.png",
        "website/blog/shared/q.gif",
    ]);
});

/** Response whose body is never supposed to be read: the precheck must trip
 *  on the declared content-length BEFORE arrayBuffer() is touched (#4906 P3). */
function spyBody(body: ConstructorParameters<typeof Response>[0], init?: ConstructorParameters<typeof Response>[1]): { res: Response; bodyRead(): boolean } {
    let read = false;
    const res = new Response(body, init);
    const orig = res.arrayBuffer.bind(res);
    Object.defineProperty(res, "arrayBuffer", { value: async () => { read = true; return orig(); } });
    return { res, bodyRead: () => read };
}

test("#4906 P3 content-length precheck: oversized declarations refuse before the body is read", async () => {
    installGithubRouter();
    assert.equal((await runBlogRefreshRound({ force: true })).ok, true); // good baseline
    // TEXT: declared 600KB > MAX_TEXT_BYTES with a tiny real body — the
    // precheck must fail the round without downloading a byte.
    const textSpy = spyBody("tiny", { status: 200, headers: { "content-length": String(600 * 1024) } });
    router = (url) => {
        if (url === CONTENTS_URL) return new Response(JSON.stringify([{ name: "2026-10-09_fresh.md", type: "file" }]), { status: 200 });
        if (url === rawUrl("website/blog/posts/2026-10-09_fresh.md")) return textSpy.res;
        return new Response("not here", { status: 404 });
    };
    assert.equal((await runBlogRefreshRound({ force: true })).ok, true); // fail-soft, marker rides the feed
    assert.equal(getBlogFeed().error, "offline");
    assert.equal(textSpy.bodyRead(), false, "oversize text: body never downloaded");
    // IMAGE: declared 3MB > MAX_IMAGE_BYTES — a silent miss (404-churn
    // discipline), round still succeeds, body never downloaded.
    installGithubRouter();
    assert.equal((await runBlogRefreshRound({ force: true })).ok, true);
    const imgSpy = spyBody("IMG", { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } });
    const base = router; // the default GitHub router installed above
    router = (url) => (url === rawUrl("website/blog/posts/figures/good.png") ? imgSpy.res : base(url));
    assert.equal((await runBlogRefreshRound({ force: true })).ok, true, "oversize image is churn, not a failed round");
    assert.equal(getBlogFeed().error, undefined, "no marker: the round itself succeeded");
    assert.equal(imgSpy.bodyRead(), false, "oversize image: body never downloaded");
});

test("#4906 P3 lying-small content-length: the post-read byte check stays the authority", async () => {
    installGithubRouter();
    assert.equal((await runBlogRefreshRound({ force: true })).ok, true);
    const big = "x".repeat(512 * 1024 + 1);
    router = (url) => {
        if (url === CONTENTS_URL) return new Response(JSON.stringify([{ name: "2026-10-09_fresh.md", type: "file" }]), { status: 200 });
        if (url === rawUrl("website/blog/posts/2026-10-09_fresh.md")) return new Response(big, { status: 200, headers: { "content-length": "10" } });
        return new Response("not here", { status: 404 });
    };
    assert.equal((await runBlogRefreshRound({ force: true })).ok, true); // fail-soft
    assert.equal(getBlogFeed().error, "offline", "header said 10 bytes; the real 512KB+1 body still blew the limit");
});

test("#4906 P3 settleRoundImmune: a rejecting round never leaks an unhandledRejection", async () => {
    let unhandled: unknown = undefined;
    const onUn = (e: unknown) => { unhandled = e; };
    process.on("unhandledRejection", onUn);
    let settled = 0;
    const gate = settleRoundImmune(Promise.reject(new Error("unexpected")), () => { settled++; });
    await gate; // resolves despite the rejecting base — fire-and-forget safe
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", onUn);
    assert.equal(settled, 1, "onSettle ran exactly once");
    assert.equal(unhandled, undefined, "no unhandledRejection escaped (Node >= 15 would crash)");
    // Resolving bases settle too — the gate is direction-agnostic.
    let settled2 = 0;
    await settleRoundImmune(Promise.resolve(), () => { settled2++; });
    assert.equal(settled2, 1);
});

test("#4906 P3 blogCacheStale boundary + neutral offline wording pins", () => {
    assert.equal(blogCacheStale(0, 60 * 60 * 1000 - 1), false, "just under 1h: cached feed still served");
    assert.equal(blogCacheStale(0, 60 * 60 * 1000), true, "at 1h: stale -> background re-pull (bl.sub cadence)");
    assert.ok(MESSAGES["zh-CN"]["bl.offline"].includes("上次拉取未完成"), "zh wording no longer blames GitHub reachability");
    assert.ok(MESSAGES["en"]["bl.offline"].startsWith("Last refresh did not finish"), "en wording no longer blames GitHub reachability");
});
