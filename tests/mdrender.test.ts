// The web panel must ship zero runtime dependencies, so Markdown rendering is
// hand-rolled in src/web/mdrender.ts (makeMdRender) — one implementation, used
// server-side via markdown.ts and inlined into the browser IIFE via
// `.toString()`. These tests pin the behavior both paths share AND prove the
// inlining contract: the factory source must run in a scope with no outer
// closures (exactly what the minified IIFE gives it).
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { makeMdRender } from "../src/web/mdrender.ts";
import { markdownToHtml } from "../src/web/markdown.ts";

const md = makeMdRender();

// --- inlining contract: the browser IIFE embeds makeMdRender via
// `.toString()` (client.ts, same discipline as the JSONC helpers). tsup
// ships that function through esbuild bundling + minification, so the test
// reproduces exactly that: bundle mdrender.ts alone with esbuild, then run
// the bundled function's .toString() source in a scope with nothing but
// globals. If the factory ever reaches outside its own body, this throws
// ReferenceError exactly as the deployed page would.
async function makeDetached() {
    const res = await build({
        entryPoints: ["src/web/mdrender.ts"],
        bundle: true,
        format: "cjs",
        minify: true,
        write: false,
        logLevel: "silent",
    });
    const code = res.outputFiles[0].text;
    const module_ = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", code)(module_, module_.exports);
    const bundled = module_.exports.makeMdRender as typeof makeMdRender;
    return new Function(`return (${bundled.toString()})();`)() as ReturnType<typeof makeMdRender>;
}

test("makeMdRender is self-contained (IIFE inlining contract)", async () => {
    const det = await makeDetached();
    assert.equal(typeof det.render, "function");
    assert.equal(typeof det.highlight, "function");
    assert.equal(typeof det.escape, "function");
    // identical output to the module-scope instance for the whole sample surface
    const sample = [
        "# title",
        "",
        "text with **bold** and `code` and a [link](https://example.com/x)",
        "",
        "```ts",
        "const n = 1; // c",
        "```",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
    ].join("\n");
    assert.equal(det.render(sample), md.render(sample));
    assert.equal(det.highlight('{"a": 1}', "json"), md.highlight('{"a": 1}', "json"));
});

const literalCodeSamples = [
    "*literal* **also literal**",
    "[guide](https://example.test/docs)",
    "![diagram](https://example.test/image.png)",
    "[blocked](javascript:alert(1))",
    '<img src=x onerror=alert(1)> & "quotes"',
    "plain_code",
];

function assertLiteralCode(html: string, expected: string): void {
    const inner = /<code>([\s\S]*?)<\/code>/.exec(html)?.[1];
    assert.notEqual(inner, undefined);
    assert.ok(!inner!.includes("<"), "code contains text rather than nested markup");
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };
    const text = inner!.replace(/&#(\d+);|&#x([a-f\d]+);|&(amp|lt|gt|quot);/gi, (_match, decimal, hex, named) =>
        decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : entities[named.toLowerCase()]!);
    assert.equal(text, expected);
}

for (const sample of literalCodeSamples) {
    test(`server Markdown preserves inline code literally: ${sample}`, () => {
        assertLiteralCode(markdownToHtml(`\`${sample}\``), sample);
    });
}

test("detached browser renderer keeps inline code literal", async () => {
    const detached = await makeDetached();
    for (const sample of literalCodeSamples) assertLiteralCode(detached.render(`\`${sample}\``), sample);
});

test("inline code keeps its literal content inside a link label", () => {
    const html = md.render("[read `**literal**`](https://example.test/docs)");
    assert.match(html, /<a href="https:\/\/example.test\/docs"/);
    assertLiteralCode(html, "**literal**");
});

test("protecting inline code keeps surrounding emphasis and links active", () => {
    const html = md.render("**bold** and `*literal*` and *italic* and [link](https://example.test/docs)");
    assertLiteralCode(html, "*literal*");
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.equal((html.match(/<a /g) ?? []).length, 1);
});

// --- escaping / XSS ---

test("escape turns & < > \" into entities (single quote passes through, as in the old renderer)", () => {
    assert.equal(md.escape(`<a href="x" onerror='y'>&`), "&lt;a href=&quot;x&quot; onerror='y'&gt;&amp;");
});

test("raw script tags and attributes are inert", () => {
    const html = md.render(`<script>alert(1)<\/script>\n\nonerror="pwn" **bold**`);
    assert.ok(!html.includes("<script>"), "no live script tag");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes('onerror="'), "attribute quotes stay escaped");
    assert.ok(html.includes("<strong>bold</strong>"));
});

test("links: http(s) and relative survive, javascript: does not", () => {
    const html = md.render("[ok](https://example.com/a) [bad](javascript:alert(1)) [rel](/x)");
    assert.ok(html.includes('href="https://example.com/a"'));
    assert.ok(!html.includes("javascript:"));
    assert.ok(html.includes('href="/x"'));
});

test("images: only http(s) or /__bili/blog-assets/ render, rest drop silently", () => {
    const ok = md.render("![a](https://example.com/i.png)");
    assert.ok(ok.includes('<img class="md-img" src="https://example.com/i.png"'));
    const bad = md.render("![a](data:text/html,<script>alert(1)</script>)");
    assert.ok(!bad.includes("<img"), "data: image dropped");
    assert.ok(!bad.includes("<script>"));
});

// --- block level ---

test("fences: language tag drives highlight class, unknown tag stays plain", () => {
    const ts = md.render("```ts\nconst a = 1;\n```");
    assert.match(ts, /<pre><code class="hl-ts">/);
    assert.ok(ts.includes("hl-k"), "keyword span present");
    const plain = md.render("```\ncode < & \"q\"\n```");
    assert.ok(plain.includes("<pre><code>code &lt; &amp; &quot;q&quot;</code></pre>"));
});

test("headings, rule, quote, lists, tables", () => {
    const html = md.render("# T\n\n---\n\n> quoted\n\n- a\n- b\n\n1. one\n2. two\n\n| h1 | h2 |\n|----|----|\n| c1 | c2 |");
    assert.ok(html.includes("<h1>T</h1>"));
    assert.ok(html.includes("<hr/>"));
    assert.ok(html.includes("<blockquote><p>quoted</p></blockquote>"));
    assert.ok(html.includes("<ul><li>a</li><li>b</li></ul>"));
    assert.ok(html.includes("<ol><li>one</li><li>two</li></ol>"));
    assert.ok(html.includes("<table class=\"data\"><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>c1</td><td>c2</td></tr></tbody></table>"));
});

test("GFM task lists render checkboxes (eWork parity)", () => {
    const html = md.render("- [x] done\n- [ ] todo\n- plain");
    assert.ok(html.includes('<li><input type="checkbox" disabled checked> done</li>'));
    assert.ok(html.includes('<li><input type="checkbox" disabled> todo</li>'));
    assert.ok(html.includes("<li>plain</li>"));
});

test("kernel role headings keep the msg-role divider (server fallback path)", () => {
    assert.ok(md.render("### user").includes('<h3 class="msg-role user">user</h3>'));
    assert.ok(md.render("### 7.1 三层体系").includes("<h3>7.1 三层体系</h3>"), "in-body heading is a plain h3");
});

test("paragraphs keep their line breaks as <br/>", () => {
    assert.ok(md.render("line one\nline two").includes("<p>line one<br/>line two</p>"));
});

// --- highlighters ---

test("json: keys and string values get distinct classes, colon never inside a key span", () => {
    const html = md.highlight('{"name": "x", "n": 1, "on": true, "o": null}', "json");
    const keySpan = html.match(/<span class="hl-key">([^<]*)<\/span>/g) ?? [];
    assert.ok(keySpan.every((s) => !s.includes(":")), "no trailing colon inside a key span");
    assert.ok(html.includes('<span class="hl-key">&quot;name&quot;</span>'));
    assert.ok(html.includes('<span class="hl-str">&quot;x&quot;</span>'));
    assert.ok(html.includes('<span class="hl-num">1</span>'));
    assert.ok(html.includes('<span class="hl-bool">true</span>'));
    assert.ok(html.includes('<span class="hl-bool">null</span>'));
});

test("diff: +/- lines colored, file headers not", () => {
    const html = md.highlight('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new', "diff");
    assert.ok(html.includes('<span class="hl-del">-old</span>'));
    assert.ok(html.includes('<span class="hl-add">+new</span>'));
    assert.ok(html.includes('<span class="hl-hunk">@@ -1 +1 @@</span>'));
    assert.ok(!html.includes('hl-del">---'));
    assert.ok(!html.includes('hl-add">+++'));
});

test("C-family: keyword, string, number, line and block comment", () => {
    const html = md.highlight('const s = "hi";\n/* block */\nlet n = 3.5; // tail', "ts");
    assert.ok(html.includes('<span class="hl-k">const</span>'));
    assert.ok(html.includes('<span class="hl-str">&quot;hi&quot;</span>'));
    assert.ok(html.includes('<span class="hl-num">3.5</span>'));
    assert.ok(html.includes('<span class="hl-c">/* block */</span>'));
    assert.ok(html.includes('<span class="hl-c">// tail</span>'));
});

test("python: keyword, string, number, comment", () => {
    const html = md.highlight('def f(x):\n    return 1  # note', "py");
    assert.ok(html.includes('<span class="hl-k">def</span>'));
    assert.ok(html.includes('<span class="hl-num">1</span>'));
    assert.ok(html.includes('<span class="hl-c"># note</span>'));
});

test("shell: comment, string, keyword", () => {
    const html = md.highlight("# top\necho \"hi\"\nif [ -f x ]; then fi", "sh");
    assert.ok(html.includes('<span class="hl-c"># top</span>'));
    assert.ok(html.includes('<span class="hl-str">&quot;hi&quot;</span>'));
    assert.ok(html.includes('<span class="hl-k">if</span>'));
});

test("unknown language: escaped plain text, no spans", () => {
    const html = md.highlight('const <x> = "1";', "makefile");
    assert.equal(html, md.escape('const <x> = "1";'));
});

test("highlight never emits unescaped source bytes", () => {
    for (const [code, lang] of [
        ['</span><script>alert(1)</script>', "json"],
        ["const a = '</span>';", "ts"],
        ["+ </span>\n- <x>", "diff"],
        ["# </span>", "sh"],
    ] as const) {
        const html = md.highlight(code, lang);
        assert.ok(!html.includes("<script>"), lang + ": no live script");
        assert.ok(!html.includes("</span><script"), lang + ": no span injection");
        assert.ok(html.includes("&lt;") || html.includes("&quot;"), lang + ": source escaped");
    }
});

// --- markdownToHtml thin wrapper parity ---

test("markdownToHtml delegates to makeMdRender", () => {
    const src = "# T\n\n**b** and `c`\n\n```json\n{\"k\": 1}\n```\n\n- [x] done";
    assert.equal(markdownToHtml(src), md.render(src));
    assert.match(markdownToHtml(src), /<span class="hl-key">/);
});
