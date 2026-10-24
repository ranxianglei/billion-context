#!/usr/bin/env node
// Static blog builder for the billion-context website. Zero dependencies (Node >= 18 builtins only),
// same house style as tools/gen-config-docs.mjs. Keeps the site build-free: generated HTML is
// committed next to the markdown sources and published verbatim by GitHub Pages.
// Rendering kit lives in tools/lib/md-web.mjs (shared with tools/build-articles.mjs).
//
// Usage:   node tools/build-blog.mjs            (regenerate all)
// Input:   website/blog/posts/<YYYY-MM-DD_slug>.md        English post
//          website/blog/posts/<YYYY-MM-DD_slug>.zh.md     optional Chinese twin
// Output:  website/blog/<slug>.html, <slug>.zh.html, website/blog/index.html
//
// Frontmatter (key: value lines between --- fences):
//   title, title_zh, date (YYYY-MM-DD), excerpt, excerpt_zh

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { esc, mdToHtml, parseFrontmatter, page } from "./lib/md-web.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BLOG = join(ROOT, "website", "blog");
const POSTS_DIR = join(BLOG, "posts");
const CRUMB = "博客 Blog";

function collectPosts() {
  let files;
  try { files = readdirSync(POSTS_DIR); } catch { files = []; }
  const posts = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".md")) continue;
    const lang = f.endsWith(".zh.md") ? "zh" : "en";
    const rawName = f.endsWith(".zh.md") ? f.slice(0, -".zh.md".length) : f.slice(0, -".md".length);
    const slug = rawName.replace(/^\d{4}-\d{2}-\d{2}_/, "") || rawName;
    const { fm, body } = parseFrontmatter(readFileSync(join(POSTS_DIR, f), "utf8"));
    posts.push({
      base: rawName,
      slug,
      lang,
      date: fm.date || rawName.slice(0, 10),
      title: fm.title || slug,
      titleZh: fm.title_zh || "",
      excerpt: fm.excerpt || "",
      excerptZh: fm.excerpt_zh || "",
      htmlFile: `${slug}${lang === "zh" ? ".zh" : ""}.html`,
      body,
    });
  }
  return posts;
}

function main() {
  mkdirSync(BLOG, { recursive: true });
  const posts = collectPosts();
  let written = 0;
  for (const p of posts) {
    const bodyHtml = mdToHtml(p.body);
    const hasTwin = posts.some((q) => q.base === p.base && q.lang !== p.lang);
    const twinUrl = p.lang === "en" ? `${p.slug}.zh.html` : `${p.slug}.html`;
    const langLabel = p.lang === "zh" ? "中文版" : "English";
    const twinLabel = p.lang === "en" ? "中文版" : "English";
    const meta = [p.date, langLabel, hasTwin ? `<a href="${twinUrl}">${twinLabel}</a>` : null].filter(Boolean).join(" · ");
    const inner = `<article class="blog-wrap post-article">
<h1>${esc(p.title)}</h1>
<p class="post-meta">${meta}</p>
${bodyHtml}
<p class="post-foot"><a href="./index.html">&larr; Blog / 博客</a></p>
</article>`;
    writeFileSync(join(BLOG, p.htmlFile), page({ lang: p.lang, title: p.title, crumb: CRUMB, root: "../", current: "blog", inner }));
    written++;
  }

  const groups = new Map();
  for (const p of [...posts].sort((a, b) => (a.base < b.base ? -1 : 1))) {
    if (!groups.has(p.base)) groups.set(p.base, []);
    groups.get(p.base).push(p);
  }
  const cards = [...groups.entries()]
    .sort((a, b) => {
      const da = a[1][0].date, db = b[1][0].date;
      return da === db ? 0 : da < db ? 1 : -1;
    })
    .map(([base, pair]) => {
      const en = pair.find((x) => x.lang === "en");
      const zh = pair.find((x) => x.lang === "zh");
      const refs = [en, zh].filter(Boolean);
      const date = refs[0].date;
      const titles = [
        en ? `<a href="${en.htmlFile}">${esc(en.title)}</a>` : "",
        zh ? `<a href="${zh.htmlFile}" class="post-title-zh">${esc(zh.title)}</a>` : "",
      ].filter(Boolean).join(" &nbsp;/&nbsp; ");
      const exs = [en?.excerpt, zh?.excerptZh].filter(Boolean).map((e) => `<span>${esc(e)}</span>`).join("");
      return `<li class="post-card">
<time datetime="${esc(date)}">${esc(date)}</time>
<h3>${titles}</h3>
<p class="post-ex">${exs}</p>
</li>`;
    })
    .join("\n");

  const indexInner = `<div class="blog-wrap blog-index-page">
<h1>博客 <span class="blog-alt">Blog</span></h1>
<p class="blog-sub">发布说明、设计笔记和事故复盘——都写自仓库里真实发生的事情。</p>
<ul class="blog-index">
${cards || "<li class=\"post-ex\">暂无文章 / No posts yet.</li>"}
</ul>
<p class="post-foot"><a href="../docs/articles/">文库 Long-form articles &rarr;</a></p>
</div>`;
  writeFileSync(join(BLOG, "index.html"), page({ lang: "en", title: "billion-context", crumb: CRUMB, root: "../", current: "blog", inner: indexInner }));
  written++;
  console.log(`build-blog: wrote ${written} file(s) into website/blog (${posts.length} post file(s))`);
}

main();
