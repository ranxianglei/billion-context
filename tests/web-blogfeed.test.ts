/**
 * Panel blog/articles feed (#4587, src/web/blogfeed.ts) — bundled markdown →
 * server-rendered JSON feed + guarded image assets. Covers both directions of
 * every gate: dated/undated ordering, bilingual pairing, frontmatter titles,
 * XSS-escaped rendering, image rewrite vs drop (incl. traversal refs),
 * GFM tables, asset route (png allowed / md denied / traversal / encoding /
 * missing), malformed manifest degradation, absent-root empty feed, and the
 * real-tree probe finding the repository's website/blog/posts.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { getBlogFeed, handleBlogGet, handleBlogAssetGet, _setBlogRootForTest } from "../src/web/blogfeed.ts";

let pkgRoot = "";
let outsideDir = "";

function fakeRes(): { res: ServerResponse; status: number | undefined; headers: Record<string, string>; body: string } {
    const out: { res: ServerResponse; status: number | undefined; headers: Record<string, string>; body: string } =
        { res: undefined as unknown as ServerResponse, status: undefined, headers: {}, body: "" };
    out.res = {
        writeHead(_status: number, headers?: Record<string, string>) { out.status = _status; out.headers = headers ?? {}; },
        end(chunk?: string | Uint8Array) { if (chunk !== undefined) out.body += Buffer.from(chunk).toString("utf8"); },
    } as unknown as ServerResponse;
    return out;
}

function buildFixture(): void {
    mkdirSync(join(pkgRoot, "website", "blog", "posts"), { recursive: true });
    mkdirSync(join(pkgRoot, "website", "blog", "posts", "figures"), { recursive: true });
    mkdirSync(join(pkgRoot, "paper", "figures"), { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), "{}");
    writeFileSync(join(pkgRoot, "outside-secret.yaml"), "nope");
    const posts = join(pkgRoot, "website", "blog", "posts");
    writeFileSync(join(posts, "2026-10-08_demo.md"),
        "---\ntitle: \"Demo post\"\nexcerpt: \"EN excerpt.\"\n---\n\n## Body\n\nText with <script>alert(1)</script> inline.\n\n![shot](figures/shot.png)\n\n![escape](../../outside-secret.yaml)\n");
    writeFileSync(join(posts, "2026-10-08_demo.zh.md"),
        "---\ntitle_zh: \"演示文章\"\nexcerpt_zh: \"中文摘要。\"\n---\n\n## 正文\n\n中文内容。\n");
    writeFileSync(join(posts, "2026-10-09_new.md"), "# Undated-by-frontmatter post\n\nNewer content.\n");
    writeFileSync(join(posts, "notes.md"), "# Plain notes\n\nNo date anywhere.\n");
    writeFileSync(join(posts, "figures", "shot.png"), "POSTPNG");
    writeFileSync(join(pkgRoot, "website", "articles.json"), JSON.stringify({ articles: [
        { file: "paper/a.md", zh_file: "paper/b.md", slug: "alpha" },
        { file: "paper/missing.md" },
    ] }));
    writeFileSync(join(pkgRoot, "paper", "a.md"),
        "# Article Alpha\n\nTable below:\n\n| k | v |\n|---|---|\n| 1 | two |\n\n![fig](figures/p.png)\n");
    writeFileSync(join(pkgRoot, "paper", "b.md"), "# 文章 Alpha（中文）\n\n中文正文。\n");
    writeFileSync(join(pkgRoot, "paper", "figures", "p.png"), "PAPERPNG");
}

beforeEach(() => {
    outsideDir = mkdtempSync(join(tmpdir(), "bili-blogroot-"));
    pkgRoot = join(outsideDir, "pkg");
    buildFixture();
    _setBlogRootForTest(pkgRoot);
});

afterEach(() => {
    _setBlogRootForTest(null);
    rmSync(outsideDir, { recursive: true, force: true });
});

test("feed composes posts + manifest articles, dated newest-first, undated tail", () => {
    const data = getBlogFeed();
    assert.equal(data.items.length, 4); // demo + new(10-09) + alpha(article, undated) + notes(no date anywhere)
    assert.deepEqual(data.items.map((i) => i.id), ["new", "demo", "alpha", "notes"]);
    // A post with neither a filename date nor a frontmatter date must degrade to an
    // empty date (stable undated tail), not a garbage 10-char slice of the filename.
    assert.equal(data.items[3].date, "");
    assert.equal(data.items[1].kind, "post");
    assert.equal(data.items[2].kind, "article");
    assert.equal(data.items[2].date, "");
    assert.equal(data.items[1].title, "Demo post");
    assert.equal(data.items[1].titleZh, "演示文章");
    assert.ok(data.items[1].excerpt.endsWith("EN excerpt."));
    assert.equal(data.items[1].excerptZh, "中文摘要。");
    assert.ok(data.items[2].title === "Article Alpha", "article title falls back to H1");
    assert.equal(data.items[2].titleZh, "文章 Alpha（中文）");
    assert.ok(!JSON.stringify(data.items).includes("missing.md"), "unresolvable manifest entry is skipped, not fatal");
});

test("rendering is escape-first: script tags survive only escaped; tables become panel data tables", () => {
    const data = getBlogFeed();
    const demo = data.items.find((i) => i.id === "demo")!;
    assert.ok(demo.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!demo.html.includes("<script>alert"));
    const alpha = data.items.find((i) => i.id === "alpha")!;
    assert.ok(alpha.html.includes('<table class="data">'));
    assert.ok(alpha.html.includes("<td>two</td>"));
});

test("image refs: shipped files reroute to the panel asset prefix; traversal/unshipped refs drop silently", () => {
    const data = getBlogFeed();
    const demo = data.items.find((i) => i.id === "demo")!;
    assert.ok(demo.html.includes("/__bili/blog-assets/website/blog/posts/figures/shot.png"));
    assert.ok(!demo.html.includes("outside-secret"), "no yaml byte ever rides into the rendered html");
    const alpha = data.items.find((i) => i.id === "alpha")!;
    assert.ok(alpha.html.includes("/__bili/blog-assets/paper/figures/p.png"));
});

test("asset route: png allowed with exact bytes; md/traversal/encoding/missing all 404", () => {
    const ok = fakeRes();
    handleBlogAssetGet(ok.res, "/__bili/blog-assets/paper/figures/p.png?v=1");
    assert.equal(ok.status, 200);
    assert.match(String(ok.headers["content-type"]), /^image\/png/);
    assert.equal(ok.body, "PAPERPNG");

    for (const url of [
        "/__bili/blog-assets/outside-secret.yaml",
        "/__bili/blog-assets/%2e%2e/outside-secret.yaml",
        "/__bili/blog-assets/paper/../outside-secret.yaml",
        "/__bili/blog-assets/paper/figures/nope.png",
        "/__bili/blog-assets/%zz.png",
    ]) {
        const r = fakeRes();
        handleBlogAssetGet(r.res, url);
        assert.equal(r.status, 404, `expected 404 for ${url}`);
    }
    // The positive half: a SHIPPED md file still 404s — extension gate, not existence gate.
    const md = fakeRes();
    handleBlogAssetGet(md.res, "/__bili/blog-assets/paper/a.md");
    assert.equal(md.status, 404);
});

test("handleBlogGet answers 200 JSON always; broken manifest degrades to posts-only", () => {
    const warm = fakeRes();
    handleBlogGet(warm.res);
    assert.equal(warm.status, 200);
    assert.match(String(warm.headers["content-type"]), /^application\/json/);
    assert.ok(Array.isArray(JSON.parse(warm.body).items));

    writeFileSync(join(pkgRoot, "website", "articles.json"), "{ not json");
    _setBlogRootForTest(pkgRoot); // clears the cache
    const data = getBlogFeed();
    assert.ok(data.items.every((i) => i.kind === "post"));
});

test("a root without content degrades to an empty list instead of throwing", () => {
    _setBlogRootForTest(join(outsideDir, "does-not-exist"));
    assert.deepEqual(getBlogFeed(), { items: [] });
});

test("CRLF frontmatter (Windows autocrlf checkout) still yields title/excerpt/date", () => {
    const posts = join(pkgRoot, "website", "blog", "posts");
    writeFileSync(join(posts, "2026-10-08_crlf.md"), "---\r\ntitle: \"CRLF post\"\r\nexcerpt: \"EN excerpt.\"\r\n---\r\n\r\n## Body\r\n\r\nText.\r\n");
    _setBlogRootForTest(pkgRoot);
    const data = getBlogFeed();
    const crlf = data.items.find((i) => i.id === "crlf");
    assert.ok(crlf, "crlf post listed");
    assert.equal(crlf.title, "CRLF post");
    assert.equal(crlf.excerpt, "EN excerpt.");
    assert.equal(crlf.date, "2026-10-08");
});

test("default probing finds the repository tree from the TS source layout", () => {
    _setBlogRootForTest(null);
    const data = getBlogFeed();
    assert.ok(data.items.some((i) => i.title === "Meet billion-context"), "bundled meet-bili post found");
});
