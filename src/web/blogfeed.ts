/**
 * Panel-embedded blog & articles (#4587): the few long-form markdown pieces we
 * ship INSIDE the install (website/blog/posts/*.md + the curated list in
 * website/articles.json) are rendered server-side with web/markdown.ts and
 * served to the panel as a JSON feed (GET /__bili/blog); their images ride
 * GET /__bili/blog-assets/<rel>. The panel renders them with its own look —
 * no full site is served. Content is frozen per package release and advances
 * with self-update; web/blog-live.ts (#4906) overlays POSTS from GitHub master
 * on top of this bundled base (articles stay bundled); GitHub Pages remains the
 * always-fresh canonical copy of the full library.
 *
 * Fail-soft like web/changelog.ts: missing folders/manifest → empty feed or
 * plain 404s, never an exception out of the handler. No config keys, no env
 * vars, no disk cache — it reads static bytes from the install itself.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { markdownToHtml } from "./markdown.js";

const BLOG_ASSET_PREFIX = "/__bili/blog-assets";

const ASSET_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
};

let rootOverride: string | undefined;
let probedRoot: string | undefined;
let state: { items: BlogItem[] } | undefined;

export type BlogItem = {
    id: string;
    kind: "post" | "article";
    /** "" when the source carries no usable date. */
    date: string;
    title: string;
    titleZh: string;
    excerpt: string;
    excerptZh: string;
    /** Rendered via web/markdown.ts — escaped by construction. */
    html: string;
    htmlZh: string;
};

function probeRoot(): string | undefined {
    // dist/index.js          → ../package.json    (installed layout)
    // src/web/blogfeed.ts    → ../../package.json (repository layout)
    const here = dirname(fileURLToPath(import.meta.url));
    for (const cand of [join(here, ".."), join(here, "..", ".."), join(here, "..", "..", "..")]) {
        try {
            if (statSync(join(cand, "package.json")).isFile()) return cand;
        } catch {
            // keep probing
        }
    }
    return undefined;
}

function pkgRoot(): string | undefined {
    if (rootOverride !== undefined) return rootOverride;
    if (probedRoot === undefined) probedRoot = probeRoot();
    return probedRoot;
}

/** Test seam (same pattern as _resetChangelogForTest): point at a fixture
 *  package root, or pass null to restore probing. Also clears the feed cache. */
export function _setBlogRootForTest(root: string | null): void {
    rootOverride = root ?? undefined;
    probedRoot = undefined;
    state = undefined;
}

/** Mirror of the website tools' frontmatter parser (key: value between --- fences). */
function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
    const fm: Record<string, string> = {};
    let body = text;
    // Git-for-Windows autocrlf checks .md posts out with CRLF; normalize so
    // the exact-match fences below survive Windows checkouts (#4599).
    const src = text.startsWith("---\r\n") ? text.replace(/\r\n/g, "\n") : text;
    if (src.startsWith("---\n")) {
        const end = src.indexOf("\n---\n", 4);
        if (end !== -1) {
            for (const line of src.slice(4, end).split("\n")) {
                const j = line.indexOf(":");
                if (j > 0) fm[line.slice(0, j).trim()] = line.slice(j + 1).trim().replace(/^["']|["']$/g, "");
            }
            body = src.slice(end + 5);
        }
    }
    return { fm, body };
}

const validDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Rewrite relative image targets onto the panel asset route when the file
 *  actually ships inside the package root; drop references that would 404 so
 *  the rendered article carries no broken images. Absolute http(s) pass through. */
function rewriteImages(md: string, srcDirAbs: string, root: string): string {
    return md.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, _alt: string, target: string) => {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return `![${_alt}](${target})`;
        let abs: string;
        try {
            abs = resolve(srcDirAbs, decodeURIComponent(target));
        } catch {
            return "";
        }
        if (!abs.startsWith(root + sep)) return "";
        const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
        if (ASSET_TYPES[ext] === undefined || !statSyncSafe(abs)) return "";
        const rel = abs.slice(root.length + sep.length).split(sep).join("/");
        return `![${_alt}](${BLOG_ASSET_PREFIX}/${rel})`;
    });
}

function statSyncSafe(p: string): boolean {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

/** Strip a leading H1 line; returns [titleTextOrEmpty, rest]. */
function splitH1(body: string): [string, string] {
    const m = body.match(/^#[ \t]+([^ \t\n][^\n]*)\r?\n?/);
    if (!m) return ["", body];
    return [m[1].replace(/[*_`]/g, "").trim(), body.slice(m[0].length)];
}

export type PostHalf = { html: string; h1: string; fm: Record<string, string> };

/** One language half of a post: frontmatter parse + H1 split + caller-supplied
 *  image rewrite + markdown render. The disk path (collectPosts) and the live
 *  overlay (#4906) share this so the two views cannot drift apart. */
export function renderPostText(raw: string, rewriteImagesInMd: (md: string) => string): PostHalf {
    const { fm, body } = parseFrontmatter(raw);
    const [h1, rest] = splitH1(body);
    return { html: markdownToHtml(rewriteImagesInMd(rest)), h1, fm };
}

/** Post id from its filename base: strip a leading YYYY-MM-DD_ date prefix,
 *  fall back to the raw base. Single definition shared by disk + live (#4906). */
export function postIdFromBase(base: string): string {
    return base.replace(/^\d{4}-\d{2}-\d{2}_/, "") || base;
}

/** Assemble one bilingual post item from its rendered halves; undefined when
 *  neither half survived. The single definition of the id/date/title/excerpt
 *  fallback chains — disk and live share it (#4906). */
export function shapePost(base: string, en?: PostHalf, zh?: PostHalf): BlogItem | undefined {
    if (!en && !zh) return undefined;
    const slug = postIdFromBase(base);
    return {
        id: slug,
        kind: "post",
        date: validDate(en?.fm.date || "") ? en!.fm.date : validDate(zh?.fm.date || "") ? zh!.fm.date : (validDate(base.slice(0, 10)) ? base.slice(0, 10) : ""),
        title: en?.fm.title || en?.h1 || slug,
        titleZh: zh?.fm.title_zh || zh?.fm.title || zh?.h1 || "",
        excerpt: en?.fm.excerpt || "",
        excerptZh: zh?.fm.excerpt_zh || "",
        html: en?.html || "",
        htmlZh: zh?.html || "",
    };
}

/** Newest-first dated, stable id-ordered undated tail — the ONE feed ordering
 *  definition (collect() and the live merge, #4906). */
export function sortBlogItems(items: BlogItem[]): BlogItem[] {
    items.sort((a, b) => {
        if (a.date && b.date) return a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? 1 : -1;
        if (a.date !== b.date) return a.date ? -1 : 1;
        return a.id.localeCompare(b.id);
    });
    return items;
}

function collectPosts(root: string): BlogItem[] {
    const postsDir = join(root, "website", "blog", "posts");
    let names: string[] = [];
    try {
        names = readdirSync(postsDir).filter((f) => f.endsWith(".md")).sort();
    } catch {
        return [];
    }
    const pairs = new Map<string, { en?: string; zh?: string }>();
    for (const f of names) {
        const base = f.endsWith(".zh.md") ? f.slice(0, -".zh.md".length) : f.slice(0, -".md".length);
        if (!pairs.has(base)) pairs.set(base, {});
        pairs.get(base)![f.endsWith(".zh.md") ? "zh" : "en"] = f;
    }
    const items: BlogItem[] = [];
    for (const [base, pair] of pairs) {
        const renderOne = (kind: "en" | "zh"): PostHalf | undefined => {
            const name = pair[kind];
            if (!name) return undefined;
            let raw: string;
            try {
                raw = readFileSync(join(postsDir, name), "utf8");
            } catch {
                return undefined;
            }
            return renderPostText(raw, (md) => rewriteImages(md, postsDir, root));
        };
        const shaped = shapePost(base, renderOne("en"), renderOne("zh"));
        if (shaped !== undefined) items.push(shaped);
    }
    return items;
}

function collectArticles(root: string): BlogItem[] {
    const manifestPath = join(root, "website", "articles.json");
    if (!statSyncSafe(manifestPath)) return [];
    let manifest: unknown;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
        return [];
    }
    const list = Array.isArray((manifest as { articles?: unknown })?.articles) ? (manifest as { articles: unknown[] }).articles : [];
    const items: BlogItem[] = [];
    for (const entryRaw of list) {
        const entry = entryRaw as { file?: unknown; zh_file?: unknown; slug?: unknown; title?: unknown; title_zh?: unknown; date?: unknown };
        const file = typeof entry.file === "string" ? entry.file : "";
        if (!file || file.includes("\0")) continue;
        let abs: string;
        try {
            abs = resolve(root, decodeURIComponent(file));
        } catch {
            continue;
        }
        if (!abs.startsWith(root + sep) || !statSyncSafe(abs)) continue;
        let raw: string;
        try {
            raw = readFileSync(abs, "utf8");
        } catch {
            continue;
        }
        const { fm, body } = parseFrontmatter(raw);
        const [h1, rest] = splitH1(body);
        const slugIn = typeof entry.slug === "string" && entry.slug ? entry.slug : file.replace(/\.md$/, "").split("/").pop()!;
        let zhHtml = "";
        let zhTitle = "";
        if (typeof entry.zh_file === "string") {
            const zhAbs = resolve(root, entry.zh_file);
            if (zhAbs.startsWith(root + sep) && statSyncSafe(zhAbs)) {
                try {
                    const zparsed = parseFrontmatter(readFileSync(zhAbs, "utf8"));
                    const [zhH1, zhRest] = splitH1(zparsed.body);
                    zhHtml = markdownToHtml(rewriteImages(zhRest, dirname(zhAbs), root));
                    zhTitle = (typeof entry.title_zh === "string" && entry.title_zh ? entry.title_zh : "") || zparsed.fm.title_zh || zparsed.fm.title || zhH1 || "";
                } catch {
                    zhHtml = "";
                }
            }
        }
        const date = (typeof entry.date === "string" ? entry.date : "") || fm.date || "";
        items.push({
            id: `${slugIn}`,
            kind: "article",
            date: validDate(date) ? date : "",
            title: (typeof entry.title === "string" && entry.title ? entry.title : "") || fm.title || h1 || slugIn,
            titleZh: zhTitle,
            excerpt: fm.excerpt || "",
            excerptZh: fm.excerpt_zh || "",
            html: markdownToHtml(rewriteImages(rest, dirname(abs), root)),
            htmlZh: zhHtml,
        });
    }
    return items;
}

function collect(): BlogItem[] {
    const root = pkgRoot();
    if (!root) return [];
    // Dated entries newest-first; undated ones keep a stable id-ordered tail.
    return sortBlogItems([...collectPosts(root), ...collectArticles(root)]);
}

/** Cached feed (content only changes across package updates → one compute per
 *  process). Never throws: any surprise degrades to an empty list. */
export function getBlogFeed(): { items: BlogItem[]; error?: string } {
    if (state === undefined) {
        try {
            state = { items: collect() };
        } catch {
            state = { items: [] };
        }
    }
    return state;
}

/** One decoded-and-validated path segment list, or undefined for every
 *  rejection class: bad percent-encoding, empty/"."/".."/NUL segments. */
function safeSegments(urlPath: string): string[] | undefined {
    const raw = urlPath.slice(BLOG_ASSET_PREFIX.length + 1);
    const parts = raw === "" ? [] : raw.split("/");
    const out: string[] = [];
    for (const segRaw of parts) {
        if (segRaw === "") continue;
        let seg: string;
        try {
            seg = decodeURIComponent(segRaw);
        } catch {
            return undefined;
        }
        if (seg === "" || seg === "." || seg === ".." || seg.includes("\0")) return undefined;
        out.push(seg);
    }
    return out;
}

/** GET /__bili/blog-assets/<rel> — bundled image bytes only (extension gate +
 *  traversal gate); anything else is a plain-text 404. */
export function handleBlogAssetGet(res: ServerResponse, urlPath: string): void {
    const notFound = () => {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
        res.end(`404 Not Found: ${urlPath}\n`);
    };
    const clean = urlPath.split(/[?#]/)[0];
    if (!clean.startsWith(BLOG_ASSET_PREFIX + "/")) {
        notFound();
        return;
    }
    const root = pkgRoot();
    const segments = safeSegments(clean);
    if (!root || segments === undefined) {
        notFound();
        return;
    }
    const file = resolve(root, ...segments);
    if (!file.startsWith(root + sep)) {
        notFound();
        return;
    }
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    const type = ASSET_TYPES[ext];
    if (type === undefined || !statSyncSafe(file)) {
        notFound();
        return;
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(readFileSync(file));
}
