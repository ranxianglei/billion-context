/**
 * Blog view routing (#4587) — the REAL WEB_CLIENT exercised in a vm sandbox
 * (same harness pattern as the #2321 cases in web-i18n.test.ts). Regression for
 * the owner-reported "点不了博客": the route() hash whitelist had drifted from
 * the PAGES list, so #/blog silently fell through to overview. Both directions
 * are pinned: #/blog activates the blog section AND fetches the feed; the
 * default hash does neither. The #/blog/<slug> sub-route renders a single
 * article page (unknown slugs degrade to a back-link, no crash).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { WEB_CLIENT } from "../src/web/client.ts";

type HarnessEl = {
    textContent: string; innerHTML: string; value: string; hidden: boolean;
    style: Record<string, unknown>; dataset: Record<string, unknown>;
    attrs: Record<string, string>; children: unknown[]; handlers: Record<string, () => void>;
    setAttribute(k: string, v: string): void; getAttribute(k: string): string | null;
    appendChild(c: unknown): unknown; prepend(c: unknown): unknown;
    removeChild(): void; remove(): void; focus(): void; click(): void;
    addEventListener(type: string, fn: () => void): void; removeEventListener(): void;
    querySelectorAll(): unknown[]; querySelector(): null;
};
const mkHarnessEl = (): HarnessEl => ({
    textContent: "", innerHTML: "", value: "", hidden: false, style: {}, dataset: {},
    attrs: {}, children: [], handlers: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    prepend(c) { this.children.unshift(c); return c; },
    removeChild() { }, remove() { }, focus() { }, click() { },
    addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener() { },
    querySelectorAll: () => [], querySelector: () => null,
});

const FEED = { items: [{ id: "demo", kind: "post", date: "2026-10-08", title: "Demo post", titleZh: "演示", excerpt: "ex", html: "<p>hi</p>", htmlZh: "<p>你好</p>" }] };

async function runClient(hash: string): Promise<{ els: Map<string, HarnessEl>; blogHits: number; unhandled: unknown[] }> {
    const unhandled: unknown[] = [];
    const onRej = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onRej);
    try {
        const byId = new Map<string, HarnessEl>();
        const idEl = (id: string): HarnessEl => { let e = byId.get(id); if (!e) { e = mkHarnessEl(); byId.set(id, e); } return e; };
        let blogHits = 0;
        const documentStub = {
            hidden: false,
            documentElement: { lang: "" as string },
            body: mkHarnessEl(),
            getElementById: (id: string) => idEl(id),
            createElement: () => mkHarnessEl(),
            querySelectorAll: () => [] as unknown[],
            querySelector: () => null,
            addEventListener() { }, removeEventListener() { },
            execCommand() { return true; },
        };
        const sandbox: Record<string, unknown> = {
            console,
            setTimeout, clearTimeout, clearInterval,
            setInterval: () => 0,
            fetch: async (url: string | URL | Request) => {
                if (String(url).endsWith("/blog")) {
                    blogHits += 1;
                    return { ok: true, status: 200, json: async () => FEED };
                }
                return { ok: true, status: 200, json: async () => ({}) };
            },
            document: documentStub,
            window: { addEventListener() { }, innerWidth: 1440, innerHeight: 900 },
            location: { hash, pathname: "/__bili/", reload() { } },
            navigator: { language: "zh-CN" },
            localStorage: { getItem: () => null, setItem() { } },
        };
        vm.createContext(sandbox);
        vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 100));
        return { els: byId, blogHits, unhandled };
    } finally {
        process.removeListener("unhandledRejection", onRej);
    }
}

test("#/blog routes to the index and lists articles as links (owner repro: nav click did nothing)", async () => {
    const r = await runClient("#/blog");
    assert.equal(r.unhandled.length, 0, `client raised unhandled rejection: ${r.unhandled.join("; ")}`);
    assert.equal(r.blogHits, 1, "feed fetched exactly once for #/blog");
    const blog = r.els.get("page-blog");
    const overview = r.els.get("page-overview");
    assert.ok(blog && !blog.hidden, "blog section is shown");
    assert.ok(overview && overview.hidden, "overview section is hidden");
    const list = r.els.get("bl-list");
    assert.ok(list, "blog list host rendered");
    assert.ok(list!.innerHTML.includes('href="#/blog/demo"'), "index row links to the article sub-route");
    assert.ok(!list!.innerHTML.includes("post-body"), "index renders metadata only — no article bodies");
});

test("#/blog/<slug> renders that single article with a back link", async () => {
    const r = await runClient("#/blog/demo");
    assert.equal(r.unhandled.length, 0, `client raised unhandled rejection: ${r.unhandled.join("; ")}`);
    assert.equal(r.blogHits, 1, "feed fetched once for the article page");
    assert.ok(r.els.get("page-blog") && !r.els.get("page-blog")!.hidden, "article stays inside the blog view (nav active)");
    const list = r.els.get("bl-list")!;
    assert.ok(list.innerHTML.includes("post-body") && (list.innerHTML.includes("<p>hi</p>") || list.innerHTML.includes("\u4f60\u597d</p>")), "article body rendered (locale-twin aware)");
    assert.ok(list.innerHTML.includes('<a href="#/blog" class="bl-back">'), "back link to the index present");
});

test("unknown slug degrades to a back link without a crash", async () => {
    const r = await runClient("#/blog/nope");
    assert.equal(r.unhandled.length, 0, `client raised unhandled rejection: ${r.unhandled.join("; ")}`);
    const list = r.els.get("bl-list")!;
    assert.ok(list.innerHTML.includes('<a href="#/blog" class="bl-back">'), "back link present for unknown slug");
    assert.ok(!list.innerHTML.includes("post-body"), "no article body for an unknown slug");
});

test("default and other hashes do NOT activate the blog view or hit the blog endpoint", async () => {
    for (const hash of ["#/overview", "#/logs"]) {
        const r = await runClient(hash);
        assert.equal(r.unhandled.length, 0, `${hash} raised unhandled rejection`);
        assert.equal(r.blogHits, 0, `${hash} must not fetch the blog feed`);
        assert.ok(r.els.get("page-blog")!.hidden, `${hash} keeps the blog section hidden`);
    }
});
