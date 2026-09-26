/** #1420: minimal safe Markdown → HTML for server-rendered session handoff
 *  documents. Escape-first (XSS-safe by construction — no raw source byte ever
 *  reaches the output unescaped), then transform structure only. Supports the
 *  subset kernel renderHandoff actually emits: headings, paragraphs, fenced
 *  code, inline code, bold/italic, lists, blockquotes, links (sanitized),
 *  horizontal rules. No external dependency — dist/index.js stays dep-free. */

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineMd(s: string): string {
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
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
            html.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
            i += 1;
            continue;
        }
        if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { html.push("<hr/>"); i += 1; continue; }
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
        html.push(`<p>${inlineMd(para.join(" "))}</p>`);
    }
    return html.join("\n");
}
