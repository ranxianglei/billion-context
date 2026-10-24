// Shared static-page kit for the billion-context website. Zero dependencies (Node >= 18 builtins only).
// Used by tools/build-blog.mjs (posts) and tools/build-articles.mjs (repository long-form articles).
// Everything here must stay deterministic: the same inputs always produce the same bytes.

export const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function inline(s) {
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

// Markdown subset rendered: headings (#..#### -> h2..h4), paragraphs, fenced ```code blocks,
// inline code, **bold**, *italic*, [links](url), ![img](url), - / 1. lists (flat), > blockquote,
// | tables | (with dash separator row), --- hr. Nested lists unsupported — restructure instead.
export function mdToHtml(src) {
  const lines = src.split("\n");
  const html = [];
  let para = [];
  const flushP = () => {
    if (para.length) { html.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
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

export function parseFrontmatter(text) {
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

// Full page shell: topbar (Home / Docs / 文库 / Blog) + content. `root` is the relative prefix
// from the output directory to the site root ("../" for website/blog/, "../../" for website/docs/articles/).
export function page({ lang, title, crumb, root, current, inner }) {
  const htmlLang = lang === "zh" ? "zh-CN" : "en";
  const item = (key, label, href) => `<a href="${href}"${current === key ? ' class="on"' : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${crumb ? ` · ${crumb}` : ""} · billion-context</title>
<link rel="stylesheet" href="${root}styles.css">
<!-- GENERATED by tools/build-blog.mjs / tools/build-articles.mjs — edit the markdown sources and rerun -->
</head>
<body>
<div class="blog-topbar">
  <a class="blog-brand" href="${root}">billion-context</a>
  <nav class="blog-nav" aria-label="Site">
    ${item("home", "Home", root)}
    ${item("docs", "Docs / 文档", root + "docs/")}
    ${item("articles", "文库 Articles", root + "docs/articles/")}
    ${item("blog", "博客 Blog", root + "blog/")}
  </nav>
</div>
${inner}
</body>
</html>
`;
}
