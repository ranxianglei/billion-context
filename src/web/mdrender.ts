/**
 * Dependency-free Markdown → HTML + code-highlight core, shared by the
 * server (web/markdown.ts → handoff fallback / blog articles) and the
 * browser IIFE (web/client.ts inlines it via `.toString()`, same
 * single-implementation discipline as the JSONC helpers there).
 *
 * Escape-first: no raw source byte ever reaches the output unescaped, so
 * the output is XSS-safe by construction (no sanitizer dependency —
 * dist/index.js stays dep-free).
 *
 * `makeMdRender` is the ONE implementation and is fully self-contained:
 * no module-level state, no references outside the factory body. That is
 * what lets the minified `.toString()` source run verbatim inside the
 * browser IIFE — keep it that way (nested helpers may call each other,
 * but nothing may reach out to this module's scope).
 */
interface MdRenderApi {
    escape(s: string): string;
    /** Block-level render: headings, paragraphs (<br/>-joined), fenced code
     *  (highlighted when a known language is tagged), lists, blockquotes,
     *  pipe tables, indented pre, hr. */
    render(md: string): string;
    /** Token highlight for a code block. Unknown languages come back
     *  escaped-plain. Never returns unescaped input. */
    highlight(code: string, lang: string): string;
}

export function makeMdRender(): MdRenderApi {
    function escape(s: string): string {
        return s
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function inlineMd(s: string): string {
        let out = escape(s);
        out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
        // ![alt](url) — must run before the link rule so the image syntax is
        // consumed whole. Only published image sources survive: http(s), or the
        // panel's own bundled-asset route (/__bili/blog-assets/*, see
        // web/blogfeed.ts). Quotes are already escaped by escape, so attribute
        // injection is impossible.
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

    // ------------------------------------------------------------------
    // Code highlighting (hand-rolled token scanners — dist stays dep-free,
    // so no highlight.js). Each scanner walks the RAW text once with one
    // combined regex, escapes gaps and tokens separately, and wraps tokens
    // in a class span. Tokens are escaped, so they cannot break out of the
    // wrapping span or inject markup.
    // ------------------------------------------------------------------

    function scan(code: string, re: RegExp, cls: (m: RegExpExecArray, src: string) => string): string {
        let out = "";
        let last = 0;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
            if (m.index > last) out += escape(code.slice(last, m.index));
            const c = cls(m, code);
            out += c ? `<span class="${c}">${escape(m[0])}</span>` : escape(m[0]);
            last = m.index + m[0].length;
            if (m[0].length === 0) re.lastIndex += 1; // zero-length guard
        }
        if (last < code.length) out += escape(code.slice(last));
        return out;
    }

    const JSON_RE = /"(?:\\.|[^"\\\n])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
    function highlightJson(code: string): string {
        return scan(code, JSON_RE, (m) => {
            const t = m[0];
            if (t[0] === '"') {
                // key vs value: a colon (ignoring whitespace) follows the key
                const rest = code.slice(m.index + t.length);
                return /^\s*:/.test(rest) ? "hl-key" : "hl-str";
            }
            if (t[0] === "-" || (t[0] >= "0" && t[0] <= "9")) return "hl-num";
            return "hl-bool"; // true / false / null
        });
    }

    const C_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|import|from|export|default|class|extends|new|delete|typeof|instanceof|in|of|void|this|super|static|async|await|try|catch|finally|throw|yield|public|private|protected|readonly|interface|type|enum|namespace|declare|implements|keyof|satisfies|as|is|fn|mut|impl|trait|struct|use|mod|pub|where|func|package|chan|map|range|defer|select|fallthrough|goto|end|begin|rescue|ensure|module|require|include)\b/g;
    function highlightC(code: string): string {
        return scan(code, C_RE, (m) => {
            const t = m[0];
            if (t[0] === "/" ) return "hl-c";
            if (t[0] === '"' || t[0] === "'" || t[0] === "`") return "hl-str";
            if (t[0] >= "0" && t[0] <= "9") return "hl-num";
            return "hl-k";
        });
    }

    const PY_RE = /#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[jJ]?\b|\b(?:def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|async|await|in|not|and|or|is|None|True|False|global|nonlocal|del|assert|match|case)\b/g;
    function highlightPy(code: string): string {
        return scan(code, PY_RE, (m) => {
            const t = m[0];
            if (t[0] === "#") return "hl-c";
            if (t[0] === '"' || t[0] === "'") return "hl-str";
            if (t[0] >= "0" && t[0] <= "9") return "hl-num";
            return "hl-k";
        });
    }

    const SH_RE = /#[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:[^'\\\n]|\\.)*'|`(?:\\.|[^`\\\n])*`|\b\d+(?:\.\d+)?\b|\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|local|export|return|echo|set|unset|shift|source|readonly|cd|exit|trap|select|time|eval|exec|test|declare|type|alias|unalias|read|printf)\b/g;
    function highlightSh(code: string): string {
        return scan(code, SH_RE, (m) => {
            const t = m[0];
            if (t[0] === "#") return "hl-c";
            if (t[0] === '"' || t[0] === "'" || t[0] === "`") return "hl-str";
            if (t[0] >= "0" && t[0] <= "9") return "hl-num";
            return "hl-k";
        });
    }

    function highlightDiff(code: string): string {
        return code.split("\n").map((ln) => {
            let c = "";
            if (ln.startsWith("@@")) c = "hl-hunk";
            else if (ln.startsWith("\\") || ln.startsWith("diff ") || ln.startsWith("index ") || ln.startsWith("From ")) c = "hl-hunk";
            else if (ln.startsWith("+") && !ln.startsWith("+++")) c = "hl-add";
            else if (ln.startsWith("-") && !ln.startsWith("---")) c = "hl-del";
            return c ? `<span class="${c}">${escape(ln)}</span>` : escape(ln);
        }).join("\n");
    }

    function highlight(code: string, lang: string): string {
        const l = (lang || "").trim().toLowerCase().split(/\s+/)[0] || "";
        if (l === "json" || l === "json5") return highlightJson(code);
        if (l === "diff" || l === "patch" || l === "git") return highlightDiff(code);
        if (l === "py" || l === "python" || l === "ruby" || l === "rb") return highlightPy(code);
        if (l === "sh" || l === "bash" || l === "zsh" || l === "shell" || l === "fish" || l === "console") return highlightSh(code);
        if (["js", "javascript", "mjs", "cjs", "ts", "typescript", "jsx", "tsx", "go", "c", "cpp", "cc", "cxx", "h", "hpp", "cs", "java", "rust", "rs", "kt", "kts", "swift", "scala", "dart", "groovy"].indexOf(l) > -1) return highlightC(code);
        return escape(code);
    }

    function render(md: string): string {
        const lines = md.split("\n");
        const html: string[] = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (line.startsWith("```")) {
                // ```lang — the language tag (first word) selects the
                // highlighter; unknown/absent tags stay escaped-plain.
                const tag = line.slice(3).trim().split(/\s+/)[0] || "";
                const buf: string[] = [];
                i += 1;
                while (i < lines.length && !lines[i].startsWith("```")) { buf.push(lines[i]); i += 1; }
                i += 1; // consume closing fence (or run past EOF)
                const body = buf.join("\n");
                html.push(tag ? `<pre><code class="hl-${escape(tag)}">${highlight(body, tag)}</code></pre>` : `<pre><code>${escape(body)}</code></pre>`);
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
                html.push(`<pre><code>${escape(buf.map((l) => l.slice(cut)).join("\n"))}</code></pre>`);
                continue;
            }
            if (/^\s*>\s?/.test(line)) {
                const buf: string[] = [];
                while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
                html.push(`<blockquote><p>${inlineMd(buf.join(" "))}</p></blockquote>`);
                continue;
            }
            if (/^\s*[-*]\s+/.test(line)) {
                const items: string[] = [];
                while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                    const rest = lines[i].replace(/^\s*[-*]\s+/, "");
                    // GFM task lists (kernel handoffs carry TODO checklists);
                    // the <input> is hardcoded, content stays escaped-then-inlined.
                    const task = rest.match(/^\[([ xX])\]\s+(.*)$/);
                    items.push(task
                        ? `<li><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inlineMd(task[2])}</li>`
                        : `<li>${inlineMd(rest)}</li>`);
                    i += 1;
                }
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

    return { escape, render, highlight };
}
