#!/usr/bin/env node
// Static article sync for the billion-context website. Zero dependencies (Node >= 18 builtins only).
// Renders long-form markdown that lives ELSEWHERE in the repository (paper/, root *.md, ...) into
// committed static pages under website/docs/articles/, sharing the rendering kit with tools/build-blog.mjs.
//
// Usage:   node tools/build-articles.mjs        (regenerate all)
// Input:   website/articles.json               manifest, repo-relative sources
//          { "articles": [ { file, zh_file?, slug?, title?, title_zh?, date? } ] }
// Output:  website/docs/articles/<slug>.html (+ <slug>.zh.html for a zh twin), index.html
//          website/docs/assets/<slug>/...      image/link targets referenced by the source
//
// Rules: only listed files are published (explicit over implicit — internal notes stay private
// unless someone adds them here). Relative media references resolve against the source directory
// and are copied next to the rendered page; external/absolute anchors pass through untouched.
// Deterministic: same inputs, same bytes (safe to rerun in CI on every deploy).

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { esc, mdToHtml, parseFrontmatter, page } from "./lib/md-web.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "website", "articles.json");
const OUT = join(ROOT, "website", "docs", "articles");
const ASSETS = join(ROOT, "website", "docs", "assets");
const CRUMB = "文库 Articles";
const SRC_BASE = "https://github.com/ranxianglei/billion-context/blob/master/";
const ROOT_PREFIX = "../../";
// Article pages live in docs/articles/ while copied media lands in docs/assets/ —
// one level up from the page, not two (the site-root prefix above is the depth
// to styles.css/topbar links, not to the sibling assets dir).
const MEDIA_PREFIX = "../";

function fail(msg) {
  console.error("[build-articles] " + msg);
  process.exit(1);
}

const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const srcUrl = (p) => SRC_BASE + encPath(p);

function isZhhName(name) {
  return /\.zh(-CN)?\.md$/.test(name);
}

function readSource(relPath, ctx) {
  const abs = join(ROOT, relPath);
  if (!abs.startsWith(ROOT + sep)) fail(`${ctx}: path escapes the repository: ${relPath}`);
  if (!existsSync(abs) || !statSync(abs).isFile()) fail(`${ctx}: missing source file: ${relPath}`);
  return readFileSync(abs, "utf8");
}

// Rewrite relative link/image targets so they point at the copied asset tree; copy the files.
function prepareMedia(md, relPath, slug) {
  const srcDir = dirname(join(ROOT, relPath));
  const destDir = join(ASSETS, slug);
  return md.replace(/(!?\[[^\]]*\])\(([^()\s]+)(?:#[^()]*?)?\)/g, (whole, pre, target) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(target)) return whole;
    const abs = resolve(srcDir, target);
    if (!abs.startsWith(resolve(srcDir) + sep) || !existsSync(abs) || !statSync(abs).isFile()) return whole;
    const rel = relative(resolve(srcDir), abs).split(sep);
    mkdirSync(dirname(join(destDir, ...rel)), { recursive: true });
    copyFileSync(abs, join(destDir, ...rel));
    return `${pre}(${MEDIA_PREFIX}assets/${encPath(slug + "/" + rel.join("/"))})`;
  });
}

function renderEntry(entry) {
  const ctx = entry.slug || entry.file;
  const file = entry.file;
  const lang = isZhhName(file) ? "zh" : "en";
  const { fm, body } = parseFrontmatter(readSource(file, ctx));
  const slug = entry.slug || file.replace(/\.md$/, "").split("/").pop();
  rmSync(join(ASSETS, slug), { recursive: true, force: true });

  const h1Raw = body.match(/^#\s+(.+?)\s*$/m)?.[1];
  const title = entry.title || fm.title || h1Raw?.replace(/[*_`]/g, "") || slug;
  const dated = entry.date || fm.date || "";
  const dateShown = /^\d{4}-\d{2}-\d{2}$/.test(dated) ? dated : "";

  const variants = [{ key: "", lang, rel: file }];
  if (entry.zh_file) variants.push({ key: ".zh", lang: "zh", rel: entry.zh_file });
  const titles = {};

  for (const v of variants) {
    const parsed = parseFrontmatter(readSource(v.rel, ctx));
    const h1 = parsed.body.match(/^#\s+(.+?)\s*$/m)?.[1]?.replace(/[*_`]/g, "");
    const variantTitle = v.key === ".zh"
      ? entry.title_zh || parsed.fm.title_zh || parsed.fm.title || h1 || title
      : entry.title || parsed.fm.title || h1 || title;
    titles[v.key] = variantTitle;
    const bodyHtml = mdToHtml(prepareMedia(parsed.body.replace(/^#[ \t]+[^\n]*\r?\n/, ""), v.rel, slug));
    const metaParts = [];
    if (dateShown) metaParts.push(`<time datetime="${dateShown}">${dateShown}</time>`);
    metaParts.push(`<a href="${srcUrl(v.rel)}">source on GitHub</a>`);
    const siblingKey = v.key === ".zh" ? "" : ".zh";
    const sibling = variants.find((x) => x.key === siblingKey);
    if (sibling) {
      const label = sibling.lang === "zh" ? "中文版" : "English";
      metaParts.push(`<a href="${slug}${sibling.key}.html">${label}</a>`);
    }
    const inner = `<article class="blog-wrap post-article">
<h1>${esc(variantTitle)}</h1>
<p class="post-meta">${metaParts.join(" · ")}</p>
${bodyHtml}
<p class="post-foot"><a href="./index.html">&larr; 文库 Articles</a></p>
</article>`;
    writeFileSync(join(OUT, `${slug}${v.key}.html`), page({ lang: v.lang, title: variantTitle, crumb: CRUMB, root: ROOT_PREFIX, current: "articles", inner }));
  }
  return { entry, slug, title, titleZh: titles[".zh"] || "", lang, dateShown };
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.log("build-articles: no website/articles.json — nothing to do");
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const entries = manifest.articles ?? [];
  if (!Array.isArray(entries)) fail("manifest.articles must be an array");
  mkdirSync(OUT, { recursive: true });
  const rendered = entries.map(renderEntry);

  const cards = rendered
    .map(({ slug, title, titleZh, dateShown, entry }) => {
      const lines = dateShown ? [`<time datetime="${dateShown}">${dateShown}</time>`] : [];
      const titles = [`<a href="${slug}.html">${esc(title)}</a>`];
      if (entry.zh_file) titles.push(`<a href="${slug}.zh.html" class="post-title-zh">${esc(titleZh)}</a>`);
      const exs = `<span><a href="${srcUrl(entry.file)}">source on GitHub</a></span>`;
      return `<li class="post-card">
${[...lines, `<h3>${titles.join(" &nbsp;/&nbsp; ")}</h3>`, `<p class="post-ex">${exs}</p>`].join("\n")}
</li>`;
    })
    .join("\n");

  const indexInner = `<div class="blog-wrap blog-index-page">
<h1>文库 <span class="blog-alt">Articles</span></h1>
<p class="blog-sub">长文档同步自本仓库(paper、技术笔记等)。由 CI 定时重新渲染发布,与仓库保持半小时内一致。</p>
<ul class="blog-index">
${cards || "<li class=\"post-ex\">暂无文章 / No articles yet.</li>"}
</ul>
<p class="post-foot"><a href="../index.html">&larr; Docs / 文档</a> · <a href="../../blog/">博客 Blog &rarr;</a></p>
</div>`;
  writeFileSync(join(OUT, "index.html"), page({ lang: "en", title: "billion-context", crumb: CRUMB, root: ROOT_PREFIX, current: "articles", inner: indexInner }));
  const pages = rendered.reduce((n, r) => n + (r.entry.zh_file ? 2 : 1), 0);
  console.log(`build-articles: wrote ${pages} article page(s) + index into website/docs/articles (${entries.length} manifest entr(y/ies))`);
}

main();
