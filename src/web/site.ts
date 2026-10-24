/**
 * Panel-hosted site copy: the shipped `website/` folder served read-only under
 * /__bili/site/*, so blog / article library / docs are reachable from any running
 * proxy without public-network access. Content is frozen at package-release time
 * (self-update moves it forward); the GitHub Pages deployment stays the canonical
 * always-fresh copy.
 *
 * Same gating contract as every other /__bili/ route: the loopback/trusted-origin
 * gates run BEFORE dispatch in server/admin.ts, so this handler opens nothing new.
 * Fail-soft like web/changelog.ts: site dir missing → 200 JSON error payload
 * (the panel degrades instead of throwing); bad/unknown path → plain-text 404.
 * No config keys, no env vars, no cache files — there is nothing to toggle:
 * it serves static bytes from the install itself.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

export const SITE_PREFIX = "/__bili/site";

/** Only these extensions are published; anything else (config-reference YAML
 *  seeds, post markdown sources, …) stays off the wire — 404 by design. */
const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
};

let siteDirOverride: string | undefined;
let probed: string | undefined;

function probeSiteDir(): string | undefined {
    // dist/index.js            → ../website      (installed package layout)
    // src/web/site.ts (tsx dev/tests) → ../../website (repository layout)
    const here = dirname(fileURLToPath(import.meta.url));
    for (const cand of [join(here, "..", "website"), join(here, "..", "..", "website"), join(here, "..", "..", "..", "website")]) {
        try {
            if (statSync(cand).isDirectory()) return cand;
        } catch {
            // keep probing
        }
    }
    return undefined;
}

function siteDir(): string | undefined {
    if (siteDirOverride !== undefined) return siteDirOverride;
    if (probed === undefined) probed = probeSiteDir();
    return probed;
}

/** Test seam (same pattern as _resetChangelogForTest): point the resolver at a
 *  fixture dir, or pass null to restore probing. */
export function _setSiteDirForTest(dir: string | null): void {
    siteDirOverride = dir ?? undefined;
    probed = undefined;
}

/** Map /__bili/site/<path> onto a safe absolute file inside the site root.
 *  Returns undefined for every rejection class: missing/undecodable segments,
 *  "." / ".." / empty segments, unsupported extensions, anything resolving
 *  outside the root (defense in depth on top of the segment checks). */
export function resolveSiteFile(urlPath: string, root: string): { file: string; type: string } | undefined {
    const raw = urlPath.slice(SITE_PREFIX.length);
    const parts = raw === "" ? [] : raw.split("/");
    const decoded: string[] = [];
    for (const segRaw of parts) {
        if (segRaw === "") continue; // collapsed; trailing/double slashes are cosmetic
        let seg: string;
        try {
            seg = decodeURIComponent(segRaw);
        } catch {
            return undefined; // malformed percent-encoding
        }
        if (seg === "" || seg === "." || seg === ".." || seg.includes("\0")) return undefined;
        decoded.push(seg);
    }
    if (decoded.length === 0) decoded.push("index.html");
    const file = resolve(root, ...decoded);
    if (file !== root && !file.startsWith(root + sep)) return undefined;
    const type = CONTENT_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()];
    if (type === undefined) return undefined;
    try {
        if (!statSync(file).isFile()) return undefined;
    } catch {
        return undefined;
    }
    return { file, type };
}

function notFound(res: ServerResponse, what: string): void {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
    res.end(`404 Not Found: ${what}\n`);
}

/** Strip query/hash, decode nothing further (resolveSiteFile decodes), hand the
 *  site root a bare /__bili/site[/...] path. Query strings on asset URLs must
 *  never become part of the filesystem lookup. */
function stripQuery(url: string): string {
    const i = Math.min(...[url.indexOf("?"), url.indexOf("#")].filter((n) => n >= 0));
    return i === -1 ? url : url.slice(0, i);
}

export function handleSiteGet(res: ServerResponse, url: string, base: string): void {
    const clean = stripQuery(url);
    if (clean === SITE_PREFIX) {
        // Bare prefix redirects to the slashed form so relative assets resolve.
        res.writeHead(302, { location: `${SITE_PREFIX}/`, "cache-control": "no-cache" });
        res.end();
        return;
    }
    if (!clean.startsWith(SITE_PREFIX + "/")) {
        notFound(res, "site route shape");
        return;
    }
    const root = siteDir();
    if (!root || !existsSync(root)) {
        // Installed without the website folder (custom/minimal pack) — degrade like changelog.ts.
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "offline", message: "site copy not shipped with this install" }));
        return;
    }
    const hit = resolveSiteFile(clean, root);
    if (hit === undefined) {
        notFound(res, clean.slice(SITE_PREFIX.length) || "/");
        return;
    }
    const bytes = readFileSync(hit.file);
    let body = bytes;
    let contentType = hit.type;
    if (hit.type.startsWith("text/html") && body.length > 0) {
        // Every HTML page gets one honest breadcrumb tying this copy to the
        // local proxy (relative links inside the site keep working untouched).
        const html = bytes.toString("utf8").replace(
            "<body>",
            `<body>\n<div style="padding:8px 16px;background:#111827;color:#e5e7eb;font:13px/1.5 system-ui,sans-serif">本地 bili 代理内置副本（随安装发布的网站快照）· bundled site copy served by your local proxy &nbsp;&middot;&nbsp; <a href="${base}/__bili/" style="color:#7dd3fc;text-decoration:none">&larr; 返回面板 back to panel</a></div>`,
        );
        body = Buffer.from(html, "utf8");
        contentType = hit.type;
    }
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
    res.end(body);
}
