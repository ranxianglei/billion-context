#!/usr/bin/env node
// Static blog builder for the billion-context website. Zero dependencies (Node >= 18 builtins only),
// same house style as tools/gen-config-docs.mjs. Keeps the site build-free: generated HTML is
// committed next to the markdown sources and published verbatim by GitHub Pages.
//
// Usage:   node tools/build-blog.mjs            (regenerate all)
// Input:   website/blog/posts/<YYYY-MM-DD_slug>.md        English post
//          website/blog/posts/<YYYY-MM-DD_slug>.zh.md     optional Chinese twin
// Output:  website/blog/<slug>.html, <slug>.zh.html, website/blog/index.html
//
// Frontmatter (key: value lines between --- fences):
//   title, title_zh, date (YYYY-MM-DD), excerpt, excerpt_zh
//
// Markdown subset rendered: headings (#..#### -> h2..h4), paragraphs, fenced ```code blocks,
// inline code, **bold**, *italic*, [links](url), ![img](url), - / 1. lists (flat), > blockquote,
// | tables | (with dash separator row), --- hr. Nested lists unsupported — restructure instead.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BLOG = join(ROOT, "website", "blog");
const POSTS_DIR = join(BLOG, "posts");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  let out = esc(s);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
}

function mdToHtml(src) {
  const lines = src.split("\n");
  const html = [];
  let para = [];
  const flushP = () => {
    if (para.length) { html.push(`<p>${inline(para.join(" "))}</p>`); para = []; }
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^```/.test(l)) {
      flushP();
      const lang = l.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence
      html.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ""}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(l)) { flushP(); i++; continue; }
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      flushP();
      const lv = Math.min(m[1].length + 1, 4);
      html.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      i++;
      continue;
    }
    if (/^-{3,}\s*$/.test(l)) { flushP(); html.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(l)) {
      flushP();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^>\s?/, ""))); i++; }
      html.push(`<blockquote><p>${buf.join(" ")}</p></blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushP();
      const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      html.push(
        `<table class="param-table"><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      flushP();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].trim().replace(/^[-*]\s+/, ""))}</li>`); i++; }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      flushP();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].trim().replace(/^\d+\.\s+/, ""))}</li>`); i++; }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    para.push(l.trim());
    i++;
  }
  flushP();
  return html.join("\n");
}

function parseFrontmatter(text) {
  const fm = {};
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      for (const line of text.slice(4, end).split("\n")) {
        const j = line.indexOf(":");
        if (j > 0) fm[line.slice(0, j).trim()] = line.slice(j + 1).trim().replace(/^["']|["']$/g, "");
      }
      body = text.slice(end + 5);
    }
  }
  return { fm, body };
}

function shell({ lang, title, inner }) {
  const htmlLang = lang === "zh" ? "zh-CN" : "en";
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · billion-context 博客 Blog</title>
<link rel="stylesheet" href="../styles.css">
<!-- GENERATED by tools/build-blog.mjs — edit website/blog/posts/*.md and rerun -->
</head>
<body>
<div class="blog-topbar">
  <a class="blog-brand" href="../">billion-context</a>
  <nav class="blog-nav" aria-label="Blog">
    <a href="../index.html">Home</a>
    <a href="../docs/">Docs / 文档</a>
    <a href="./index.html">Blog / 博客</a>
  </nav>
</div>
${inner}
</body>
</html>
`;
}

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
    writeFileSync(join(BLOG, p.htmlFile), shell({ lang: p.lang, title: p.title, inner }));
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
</div>`;
  writeFileSync(join(BLOG, "index.html"), shell({ lang: "en", title: "博客 Blog", inner: indexInner }));
  written++;
  console.log(`build-blog: wrote ${written} file(s) into website/blog (${posts.length} post file(s))`);
}

main();
