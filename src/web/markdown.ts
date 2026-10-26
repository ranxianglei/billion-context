/** #1420: minimal safe Markdown → HTML for server-rendered session handoff
 *  documents. Escape-first (XSS-safe by construction — no raw source byte ever
 *  reaches the output unescaped), then transform structure only. Supports the
 *  subset kernel renderHandoff actually emits: headings, paragraphs, fenced
 *  code, inline code, bold/italic, lists, blockquotes, links (sanitized),
 *  horizontal rules, pipe tables and image refs (http(s)/panel asset routes
 *  only). No external dependency — dist/index.js stays dep-free. */

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineMd(s: string): string {
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
    // ![alt](url) — must run before the link rule so the image syntax is consumed
    // whole. Only published image sources survive: http(s), or the panel's own
    // bundled-asset route (/__bili/blog-assets/*, see web/blogfeed.ts). Quotes are
    // already escaped by escapeHtml, so attribute injection is impossible.
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => {
        if (/^(?:https?:\/\/|\/__bili\/blog-assets\/)/i.test(url)) return `<img class="md-img" src="${url}" alt="${alt}" />`;
        return "";
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // [text](url) — only http/https/relative URLs survive; anything else
    // degrades to plain bracketed text (no javascript: vectors).
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
        if (/^(https?:\/\/|\/)/i.test(url)) return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        return text;
    });
    return out;
}

export function markdownToHtml(md: string): string {
    const lines = md.split("\n");
    const html: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith("```")) {
            const buf: string[] = [];
            i += 1;
            while (i < lines.length && !lines[i].startsWith("```")) { buf.push(lines[i]); i += 1; }
            i += 1; // consume closing fence (or run past EOF)
            html.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
            continue;
        }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            const level = h[1].length;
            const inner = h[2].trim();
            // Message roles from the kernel handoff format get divider-styled badges.
            const role = level === 3 && /^(user|assistant|tool)$/i.test(inner) ? inner.toLowerCase() : null;
            html.push(role ? `<h3 class="msg-role ${role}">${inlineMd(inner)}</h3>` : `<h${level}>${inlineMd(h[2])}</h${level}>`);
            i += 1;
            continue;
        }
        if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { html.push("<hr/>"); i += 1; continue; }
        // Pipe tables (header + dash separator row + body rows). The kernel
        // handoff never emits these; bundled articles do. Rendered with the
        // panel's own .data table classes so they match every other table.
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
            const cells = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inlineMd(c.trim()));
            const head = cells(line);
            i += 2;
            const rows: string[][] = [];
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
            html.push(`<table class="data"><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` +
                `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
            continue;
        }
        // Indented runs (machine-emitted tool arguments, nested lists) stay verbatim in
        // <pre> instead of being merged into one run-on paragraph by space-joining.
        if (/^\s{2,}\S/.test(line)) {
            const buf: string[] = [];
            let indent = Infinity;
            while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
                buf.push(lines[i]);
                const m = lines[i].match(/^\s*/);
                if (m && m[0].length < indent) indent = m[0].length;
                i += 1;
            }
            const cut = Math.min(indent, 4);
            html.push(`<pre><code>${escapeHtml(buf.map((l) => l.slice(cut)).join("\n"))}</code></pre>`);
            continue;
        }
        if (/^\s*&gt;\s?/.test(line) || /^\s*>\s?/.test(line)) {
            const buf: string[] = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
            html.push(`<blockquote><p>${inlineMd(buf.join(" "))}</p></blockquote>`);
            continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(`<li>${inlineMd(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`); i += 1; }
            html.push(`<ul>${items.join("")}</ul>`);
            continue;
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(`<li>${inlineMd(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`); i += 1; }
            html.push(`<ol>${items.join("")}</ol>`);
            continue;
        }
        if (line.trim() === "") { i += 1; continue; }
        const para: string[] = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+[.)]\s|\s*>)/.test(lines[i])) {
            para.push(lines[i]);
            i += 1;
        }
        // Preserve source line breaks within a paragraph (handoff message bodies keep
        // their newlines meaningful) instead of collapsing them into spaces.
        html.push(`<p>${para.map(inlineMd).join("<br/>")}</p>`);
    }
    return html.join("\n");
}
