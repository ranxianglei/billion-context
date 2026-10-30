/**
 * Panel-embedded blog & articles (#4587): the few long-form markdown pieces we
 * ship INSIDE the install (website/blog/posts/*.md + the curated list in
 * website/articles.json) are rendered server-side with web/markdown.ts and
 * served to the panel as a JSON feed (GET /__bili/blog); their images ride
 * GET /__bili/blog-assets/<rel>. The panel renders them with its own look —
 * no full site is served.
 *
 * Freshness (#4906): the bundled content is the floor, never the ceiling —
 * web/blog-refresh.ts may overlay a newer GitHub-master pull via
 * registerRemoteBlogFeed(); the merged feed de-dupes by id with the REMOTE
 * entry winning (master is canonical and ahead of any frozen release), while
 * bundled-only ids survive (offline machines keep their shipped content).
 * The asset route answers remote image bytes (memory) before falling back to
 * the on-disk package copies.
 *
 * Fail-soft like web/changelog.ts: missing folders/manifest → empty feed or
 * plain 404s, never an exception out of the handler. No config keys, no env
 * vars, no disk cache — static bytes come from the install itself or from
 * the in-memory overlay registered by the refresher.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { markdownToHtml } from "./markdown.js";

const BLOG_ASSET_PREFIX = "/__bili/blog-assets";

export const ASSET_TYPES: Record<string, string> = {
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

/** Defense-in-depth on EVERY blog-asset response (#4958): asset bytes can
 *  come from GitHub master (remote overlay, #4906) and .svg is served as
 *  image/svg+xml — DIRECTLY NAVIGATED, that is active content on the panel
 *  origin (which also hosts the config editor and its provider API keys), so
 *  an embedded <script> would run same-origin. `sandbox` CSP strips
 *  script/origin powers from such a navigation; in-page <img> usage — the
 *  only way web/markdown.ts references these — is unaffected. nosniff pins
 *  the declared type. */
const ASSET_SECURITY_HEADERS: Record<string, string> = {
    "content-security-policy": "sandbox",
    "x-content-type-options": "nosniff",
};

/** One decoded-and-typed image served from the GitHub overlay (#4906), keyed
 *  by repo-relative POSIX path (e.g. "website/blog/posts/figures/x.png"). */
type RemoteAsset = { buf: Buffer; type: string };
/** Last registered GitHub-master round; absent until the refresher succeeds.
 *  A failed round only updates `error` — previous good bytes survive. */
let remote: { items: BlogItem[]; assets: Map<string, RemoteAsset>; error?: string } | undefined;

type BlogItem = {
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
    remote = undefined;
}

/** Mirror of the website tools' frontmatter parser (key: value between --- fences). */
function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
    // Windows checkouts use CRLF; parse and render the same Markdown on every platform.
    text = text.replace(/\r\n/g, "\n");
    const fm: Record<string, string> = {};
    // Git-for-Windows autocrlf checks .md posts out with CRLF; normalize
    // UNCONDITIONALLY so the exact-match fences survive Windows checkouts
    // (#4599) and non-frontmatter bodies cannot leak \r into rendered HTML.
    const src = text.replace(/\r\n/g, "\n");
    let body = src;
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

/** Image targets that carry a scheme (http(s), mailto, data, …) or are
 *  protocol-relative — passed through verbatim by BOTH rewrite paths. */
const SCHEME_OR_PROTO_REL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Pure (no-fs) resolution of a markdown image target against a repo-relative
 *  base dir — the remote-content twin of the root+statSync dance in
 *  rewriteImages above (#4906). Returns the normalized repo-relative POSIX
 *  path, or undefined when the target cannot exist in the tree: bad
 *  percent-encoding, NUL, absolute path, or `..` climbing ABOVE the repo root
 *  (plain stack semantics: each `..` pops the accumulator, but popping an
 *  empty stack escapes the tree — mirroring how the disk path refuses
 *  resolve() results outside the package root).
 *  Scheme/protocol-relative targets are the CALLER's business (passthrough).
 */
export function resolveRepoRel(base: string, targetRaw: string): string | undefined {
    let target: string;
    try {
        target = decodeURIComponent(targetRaw);
    } catch {
        return undefined;
    }
    if (target === "" || target.includes("\0") || target.startsWith("/")) return undefined;
    const keep = (s: string): boolean => s !== "" && s !== ".";
    const out: string[] = base.split("/").filter(keep);
    for (const seg of target.split("/")) {
        if (!keep(seg)) continue;
        if (seg === "..") {
            if (out.length === 0) return undefined; // would climb above the tree root
            out.pop();
            continue;
        }
        out.push(seg);
    }
    return out.length > 0 ? out.join("/") : undefined;
}

/** Every repo-relative image target inside one markdown source (scheme
 *  targets excluded), resolved through resolveRepoRel — the prefetch list the
 *  GitHub refresher downloads BEFORE rendering, so the render's drop-decision
 *  and the download's candidate set can never disagree (#4906). */
export function collectImageTargets(md: string, base: string): string[] {
    const found = new Set<string>();
    for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (SCHEME_OR_PROTO_REL_RE.test(target)) continue;
        const rel = resolveRepoRel(base, target);
        if (rel !== undefined) found.add(rel);
    }
    return [...found];
}

/** Remote-content twin of rewriteImages: candidates are pure strings checked
 *  against a downloaded-key set instead of disk stats — same prefix rewrite,
 *  same drop-on-miss, same scheme passthrough (#4906). */
function rewriteImagesFromAssets(md: string, assetKeys: ReadonlySet<string>, base = "website/blog/posts"): string {
    return md.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, _alt: string, target: string) => {
        if (SCHEME_OR_PROTO_REL_RE.test(target)) return `![${_alt}](${target})`;
        const rel = resolveRepoRel(base, target);
        if (rel === undefined) return "";
        const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
        if (ASSET_TYPES[ext] === undefined || !assetKeys.has(rel)) return "";
        return `![${_alt}](${BLOG_ASSET_PREFIX}/${rel})`;
    });
}

/** Strip a leading H1 line; returns [titleTextOrEmpty, rest]. */
function splitH1(body: string): [string, string] {
    const m = body.match(/^#[ \t]+([^ \t\n][^\n]*)\r?\n?/);
    if (!m) return ["", body];
    return [m[1].replace(/[*_`]/g, "").trim(), body.slice(m[0].length)];
}

function renderBody(absFile: string, root: string): { html: string; h1: string } {
    const { body } = parseFrontmatter(readFileSync(absFile, "utf8"));
    const [h1, rest] = splitH1(body);
    const srcDir = dirname(absFile);
    return { html: markdownToHtml(rewriteImages(rest, srcDir, root)), h1 };
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
    const items = postsFromPairs(pairs, (name) => {
        if (name === undefined) return undefined;
        let raw: string;
        try {
            raw = readFileSync(join(postsDir, name), "utf8");
        } catch {
            return undefined;
        }
        const { fm, body } = parseFrontmatter(raw);
        const [h1, rest] = splitH1(body);
        return { html: markdownToHtml(rewriteImages(rest, postsDir, root)), h1, fm };
    });
    return items;
}

/** One rendered side of a post pair; renderOne returns undefined when the
 *  source file/text is absent. */
type RenderedSide = { html: string; h1: string; fm: Record<string, string> };

/** Shared item assembly for bundled AND remote post pairs (#4906) — slug, date
 *  ladder, bilingual title fallbacks live in exactly ONE place. */
function postsFromPairs(
    pairs: Map<string, { en?: string; zh?: string }>,
    renderOne: (fileName: string | undefined) => RenderedSide | undefined,
): BlogItem[] {
    const items: BlogItem[] = [];
    for (const [base, pair] of pairs) {
        const slug = base.replace(/^\d{4}-\d{2}-\d{2}_/, "") || base;
        const en = renderOne(pair.en);
        const zh = renderOne(pair.zh);
        if (!en && !zh) continue;
        items.push({
            id: slug,
            kind: "post",
            date: validDate(en?.fm.date || "") ? en!.fm.date : validDate(zh?.fm.date || "") ? zh!.fm.date : (validDate(base.slice(0, 10)) ? base.slice(0, 10) : ""),
            title: en?.fm.title || en?.h1 || slug,
            titleZh: zh?.fm.title_zh || zh?.fm.title || zh?.h1 || "",
            excerpt: en?.fm.excerpt || "",
            excerptZh: zh?.fm.excerpt_zh || "",
            html: en?.html || "",
            htmlZh: zh?.html || "",
        });
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
    return sortItems([...collectPosts(root), ...collectArticles(root)]);
}

/** Cached feed (bundled content only changes across package updates → one
 *  compute per process). Never throws: any surprise degrades to an empty
 *  list. When the GitHub refresher has registered a round (#4906) the bundled
 *  floor is overlaid by the remote set — id-dedup, REMOTE wins; `error`
 *  carries the last failed round's "offline" marker (changelog-style).
 */
export function getBlogFeed(): { items: BlogItem[]; error?: string } {
    if (state === undefined) {
        try {
            state = { items: collect() };
        } catch {
            state = { items: [] };
        }
    }
    if (remote === undefined) return { items: state.items };
    const byId = new Map<string, BlogItem>();
    for (const item of state.items) byId.set(item.id, item);
    for (const item of remote.items) byId.set(item.id, item); // remote wins by id
    return { items: sortItems([...byId.values()]), ...(remote.error !== undefined ? { error: remote.error } : {}) };
}

function sortItems(items: BlogItem[]): BlogItem[] {
    // Dated entries newest-first; undated ones keep a stable id-ordered tail.
    items.sort((a, b) => {
        if (a.date && b.date) return a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? 1 : -1;
        if (a.date !== b.date) return a.date ? -1 : 1;
        return a.id.localeCompare(b.id);
    });
    return items;
}

/** One decoded-and-typed image served from the GitHub overlay (#4906), keyed
 *  by repo-relative POSIX path (e.g. "website/blog/posts/figures/x.png"). */
export function getRemoteBlogAsset(rel: string): RemoteAsset | undefined {
    return remote?.assets.get(rel);
}

/** Register ONE successful/failed GitHub-master pull round (#4906). Success:
 *  replaces the overlay wholesale (a fresh tree is self-consistent). Failure:
 *  sets the "offline" marker while KEEPING the last good overlay bytes/items,
 *  so a flaky network never blanks the panel. Never throws. */
export function registerRemoteBlogFeed(round: {
    items: BlogItem[];
    assets: Map<string, RemoteAsset>;
    error?: string;
}): void {
    if (round.error !== undefined) {
        remote = remote === undefined
            ? { items: [], assets: new Map(), error: round.error }
            : { items: remote.items, assets: remote.assets, error: round.error };
        return;
    }
    remote = { items: round.items, assets: round.assets };
}

const REMOTE_POST_DIR = "website/blog/posts";

/** Build feed items from ALREADY-DOWNLOADED repository files (#4906):
 *  `files` maps repo-relative POSIX paths to raw text, `assetKeys` is the set
 *  of images whose download succeeded. Post pairing + slug/date/bilingual
 *  title logic is shared with the bundled path (postsFromPairs); the article
 *  section mirrors collectArticles verbatim except image candidates are
 *  checked against assetKeys instead of a disk stat. Per-entry failures
 *  degrade exactly like the bundled path. */
export function buildRemoteBlogPosts(files: Map<string, string>, assetKeys: ReadonlySet<string>): BlogItem[] {
    const renderText = (relPath: string, text: string): RenderedSide | undefined => {
        try {
            const { fm, body } = parseFrontmatter(text);
            const [h1, rest] = splitH1(body);
            const baseDir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
            return { html: markdownToHtml(rewriteImagesFromAssets(rest, assetKeys, baseDir)), h1, fm };
        } catch {
            return undefined;
        }
    };
    const items: BlogItem[] = [];
    // Posts — mirror collectPosts' flat-directory .md/.zh.md pairing.
    const pairs = new Map<string, { en?: string; zh?: string }>();
    for (const key of [...files.keys()].sort()) {
        if (!key.startsWith(REMOTE_POST_DIR + "/") || !key.endsWith(".md")) continue;
        const name = key.slice(REMOTE_POST_DIR.length + 1);
        if (name.includes("/")) continue;
        const base = name.endsWith(".zh.md") ? name.slice(0, -".zh.md".length) : name.slice(0, -".md".length);
        if (!pairs.has(base)) pairs.set(base, {});
        pairs.get(base)![name.endsWith(".zh.md") ? "zh" : "en"] = key;
    }
    items.push(...postsFromPairs(pairs, (key) => {
        if (key === undefined) return undefined;
        const text = files.get(key);
        return text === undefined ? undefined : renderText(key, text);
    }));
    // Articles — mirrors collectArticles; manifest is optional.
    const manifestRaw = files.get("website/articles.json");
    if (manifestRaw !== undefined) {
        let list: unknown[] = [];
        try {
            const parsed = JSON.parse(manifestRaw) as { articles?: unknown };
            if (Array.isArray(parsed.articles)) list = parsed.articles;
        } catch {
            list = [];
        }
        for (const entryRaw of list) {
            const entry = entryRaw as { file?: unknown; zh_file?: unknown; slug?: unknown; title?: unknown; title_zh?: unknown };
            const file = typeof entry.file === "string" ? entry.file : "";
            const raw = files.get(file);
            if (!file || raw === undefined) continue;
            const en = renderText(file, raw);
            const slugIn = typeof entry.slug === "string" && entry.slug ? entry.slug : file.replace(/\.md$/, "").split("/").pop()!;
            let zhHtml = "";
            let zhTitle = "";
            if (typeof entry.zh_file === "string" && entry.zh_file) {
                const zhRaw = files.get(entry.zh_file);
                if (zhRaw !== undefined) {
                    const zh = renderText(entry.zh_file, zhRaw);
                    if (zh !== undefined) {
                        zhHtml = zh.html;
                        zhTitle = (typeof entry.title_zh === "string" && entry.title_zh ? entry.title_zh : "") || zh.fm.title_zh || zh.fm.title || zh.h1 || "";
                    }
                }
            }
            if (!en) continue;
            const date = en.fm.date || "";
            items.push({
                id: slugIn,
                kind: "article",
                date: validDate(date) ? date : "",
                title: (typeof entry.title === "string" && entry.title ? entry.title : "") || en.fm.title || en.h1 || slugIn,
                titleZh: zhTitle,
                excerpt: en.fm.excerpt || "",
                excerptZh: en.fm.excerpt_zh || "",
                html: en.html,
                htmlZh: zhHtml,
            });
        }
    }
    return sortItems(items);
}

/** GET /__bili/blog — always 200 JSON; the panel degrades on an empty list. */
export function handleBlogGet(res: ServerResponse): void {
    const data = getBlogFeed();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify(data));
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

/** GET /__bili/blog-assets/<rel> — remote overlay bytes first (#4906), then
 *  bundled disk bytes (extension gate + traversal gate); anything else is a
 *  plain-text 404. EVERY response carries sandbox CSP + nosniff (#4958). */
export function handleBlogAssetGet(res: ServerResponse, urlPath: string): void {
    const notFound = () => {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", ...ASSET_SECURITY_HEADERS });
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
    // GitHub overlay first (#4906): the master copy of an image beats the
    // frozen bundle bytes; a miss falls through to the package below.
    const overlaid = getRemoteBlogAsset(segments.join("/"));
    if (overlaid !== undefined) {
        res.writeHead(200, { "content-type": overlaid.type, "cache-control": "no-cache", ...ASSET_SECURITY_HEADERS });
        res.end(overlaid.buf);
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
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache", ...ASSET_SECURITY_HEADERS });
    res.end(readFileSync(file));
}
