import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { markdownToHtml } from "../src/web/markdown.ts";
import { makeMdRender } from "../src/web/mdrender.ts";

const malformed = [
    ["unclosed link labels", "[".repeat(200_000)],
    ["unclosed image labels", "![".repeat(100_000)],
    ["nested link starts before an invalid URL", "[x](".repeat(30_000) + " invalid"],
    ["nested URL starts sharing whitespace before a closing parenthesis", "[x](".repeat(200_000) + " )"],
] as const;

function boundedRender(render: (source: string) => string, source: string): string {
    // Interrupt the synchronous old regex path without hanging the test runner. These inputs
    // need only a short scan; the budget leaves ample room for a loaded CI machine.
    return runInNewContext("render(source)", { render, source }, { timeout: 2_000 }) as string;
}

for (const [name, source] of malformed) {
    test(`server Markdown finishes ${name} without rescanning every suffix`, () => {
        assert.equal(boundedRender(markdownToHtml, source), `<p>${source}</p>`);
    });
}

test("the minified detached browser renderer finishes the same malformed link inputs", async () => {
    const built = await build({ entryPoints: ["src/web/mdrender.ts"], bundle: true, format: "cjs", minify: true, write: false, logLevel: "silent" });
    const module_ = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", built.outputFiles[0]!.text)(module_, module_.exports);
    const bundled = module_.exports.makeMdRender as typeof makeMdRender;
    const detached = new Function(`return (${bundled.toString()})();`)() as ReturnType<typeof makeMdRender>;
    for (const [, source] of malformed) assert.equal(boundedRender(detached.render, source), `<p>${source}</p>`);
});

const compatibility = [
    ["[outer [inner](https://example.test)", '<p><a href="https://example.test" target="_blank" rel="noopener noreferrer">outer [inner</a></p>'],
    ["[bad](not [good](https://example.test))", '<p>[bad](not <a href="https://example.test" target="_blank" rel="noopener noreferrer">good</a>)</p>'],
    ["[bad]([good with spaces](https://example.test))", '<p>[bad](<a href="https://example.test" target="_blank" rel="noopener noreferrer">good with spaces</a>)</p>'],
    ["![outer ![inner](https://example.test/a.png)", '<p><img class="md-img" src="https://example.test/a.png" alt="outer ![inner" /></p>'],
    ["[](/no-label) ![](https://example.test/empty.png)", '<p>[](/no-label) <img class="md-img" src="https://example.test/empty.png" alt="" /></p>'],
    ["[x](https://example.test/[path](tail))", '<p><a href="https://example.test/[path](tail" target="_blank" rel="noopener noreferrer">x</a>)</p>'],
    ["[x](bad url) [ok](/safe)", '<p>[x](bad url) <a href="/safe" target="_blank" rel="noopener noreferrer">ok</a></p>'],
    ["[x](javascript:alert(1))", "<p>x)</p>"],
] as const;

for (const [source, expected] of compatibility) {
    test(`link scanning preserves existing delimiter and URL rules: ${source}`, () => {
        assert.equal(markdownToHtml(source), expected);
    });
}
