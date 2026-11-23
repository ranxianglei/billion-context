import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { markdownToHtml } from "../src/web/markdown.ts";
import { makeMdRender } from "../src/web/mdrender.ts";

const literalLines = [
    ["&gt; example", "<p>&amp;gt; example</p>"],
    [" &gt; example", "<p> &amp;gt; example</p>"],
    ["&gt;", "<p>&amp;gt;</p>"],
    ["&gt; <script>& text", "<p>&amp;gt; &lt;script&gt;&amp; text</p>"],
    ["# Heading\n&gt; example", "<h1>Heading</h1>\n<p>&amp;gt; example</p>"],
    ["> quote\n&gt; example", "<blockquote><p>quote</p></blockquote>\n<p>&amp;gt; example</p>"],
    ["intro\n\n&gt; example", "<p>intro</p>\n<p>&amp;gt; example</p>"],
] as const;

function assertLiteralEntities(render: (source: string) => string): void {
    for (const [source, expected] of literalLines) {
        const actual = runInNewContext("render(source)", { render, source }, { timeout: 1_000 });
        assert.equal(actual, expected, source);
    }
}

test("server Markdown finishes rendering literal greater-than entities", () => {
    assertLiteralEntities(markdownToHtml);
});

test("minified detached browser Markdown finishes rendering literal greater-than entities", async () => {
    const built = await build({ entryPoints: ["src/web/mdrender.ts"], bundle: true, format: "cjs", minify: true, write: false, logLevel: "silent" });
    const module_ = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", built.outputFiles[0]!.text)(module_, module_.exports);
    const bundled = module_.exports.makeMdRender as typeof makeMdRender;
    const detached = new Function(`return (${bundled.toString()})();`)() as ReturnType<typeof makeMdRender>;
    assertLiteralEntities(detached.render);
});

test("ordinary quote markers still produce quotes and preserve their following blocks", () => {
    assert.equal(markdownToHtml("> first\n> **second**\n\n# Heading"), "<blockquote><p>first <strong>second</strong></p></blockquote>\n<h1>Heading</h1>");
});

test("entity text embedded in paragraphs and code remains escaped text", () => {
    assert.equal(markdownToHtml("example &gt; text"), "<p>example &amp;gt; text</p>");
    assert.equal(markdownToHtml("```\n&gt; example\n```"), "<pre><code>&amp;gt; example</code></pre>");
    assert.equal(markdownToHtml("  &gt; example"), "<pre><code>&amp;gt; example</code></pre>");
});
