import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES, MESSAGES, translate } from "../src/web/i18n.ts";
import { renderPage } from "../src/web/page.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { WEB_STYLES } from "../src/web/styles.ts";

const here = dirname(fileURLToPath(import.meta.url));
const han = /\p{Script=Han}/u;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("#1024: catalog parity — every key in every locale with matching placeholders", () => {
    const zhKeys = Object.keys(MESSAGES["zh-CN"]);
    assert.ok(zhKeys.length > 100, `expected a full catalog, got ${zhKeys.length} keys`);
    for (const locale of LOCALES) {
        for (const key of zhKeys) {
            assert.ok(key in MESSAGES[locale], `missing ${locale} value for "${key}"`);
            assert.equal(typeof MESSAGES[locale][key], "string");
        }
    }
    for (const key of zhKeys) {
        assert.deepEqual(placeholders(MESSAGES.en[key]), placeholders(MESSAGES["zh-CN"][key]), `placeholder mismatch for "${key}"`);
    }
});

test("#1024: no Chinese residue in English translations", () => {
    for (const [key, value] of Object.entries(MESSAGES.en)) {
        assert.ok(!han.test(value), `English value for "${key}" still contains Chinese: ${value}`);
    }
});

test("#1024: translate() interpolates vars and falls back to the key", () => {
    assert.equal(translate("en", "toast.connect_ok", { status: 204 }), "Connection successful, HTTP 204");
    assert.equal(translate("zh-CN", "toast.connect_ok", { status: 200 }), "连接成功，HTTP 200");
    assert.equal(translate("en", "does.not.exist"), "does.not.exist");
});

function collectRefs(): Set<string> {
    const pageSrc = readFileSync(join(here, "..", "src", "web", "page.ts"), "utf8");
    const clientSrc = readFileSync(join(here, "..", "src", "web", "client.ts"), "utf8");
    const refs = new Set<string>();
    for (const m of pageSrc.matchAll(/data-i18n(?:-ph|-title)?="([\w.]+)"/g)) refs.add(m[1]);
    for (const m of pageSrc.matchAll(/zh\("([\w.]+)"\)/g)) refs.add(m[1]);
    for (const m of clientSrc.matchAll(/\bt\("([\w.]+)"/g)) refs.add(m[1]);
    return refs;
}

test("#1024: every referenced key exists in both locales and no catalog key is dead", () => {
    const refs = collectRefs();
    assert.ok(refs.size > 100, `expected many i18n references, found ${refs.size}`);
    for (const key of refs) {
        assert.ok(key in MESSAGES["zh-CN"], `referenced key missing from zh catalog: ${key}`);
        assert.ok(key in MESSAGES.en, `referenced key missing from en catalog: ${key}`);
    }
    for (const key of Object.keys(MESSAGES["zh-CN"])) {
        assert.ok(refs.has(key), `catalog key never referenced anywhere: ${key}`);
    }
});

type El = { tag: string; attrs: Record<string, string>; children: Node[] };
type Text = { text: string };
type Node = El | Text;
const isEl = (node: Node): node is El => "tag" in node;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function parseHtml(html: string): Node[] {
    const root: Node[] = [];
    let pos = 0;
    function parseAttrs(raw: string): Record<string, string> {
        const attrs: Record<string, string> = {};
        for (const m of raw.matchAll(/([\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g)) {
            if (m[1]) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
        }
        return attrs;
    }
    function parseInto(target: Node[], stopTag: string): void {
        while (pos < html.length) {
            const lt = html.indexOf("<", pos);
            if (lt === -1) { target.push({ text: html.slice(pos) }); return; }
            if (lt > pos) target.push({ text: html.slice(pos, lt) });
            if (html.startsWith("<!--", lt)) { const end = html.indexOf("-->", lt); pos = end === -1 ? html.length : end + 3; continue; }
            if (html.startsWith("<!", lt)) { const end = html.indexOf(">", lt); pos = end === -1 ? html.length : end + 1; continue; }
            if (html.startsWith("</", lt)) {
                const end = html.indexOf(">", lt);
                const name = html.slice(lt + 2, end).trim();
                pos = end + 1;
                if (name === stopTag) return;
                continue;
            }
            const gt = html.indexOf(">", lt);
            const raw = html.slice(lt + 1, gt);
            const nameMatch = raw.match(/^([a-zA-Z][\w-]*)/);
            const name = nameMatch ? nameMatch[1].toLowerCase() : "";
            pos = gt + 1;
            if (!name || VOID_TAGS.has(name)) continue;
            if (name === "script" || name === "style") {
                const closeAt = html.indexOf(`</${name}`, pos);
                const body = closeAt === -1 ? "" : html.slice(pos, closeAt);
                pos = closeAt === -1 ? html.length : html.indexOf(">", closeAt) + 1;
                target.push({ tag: name, attrs: {}, children: [{ text: body }] });
                continue;
            }
            const el: El = { tag: name, attrs: parseAttrs(raw.slice(nameMatch![1].length)), children: [] };
            target.push(el);
            parseInto(el.children, name);
        }
    }
    parseInto(root, "");
    return root;
}

const fullText = (node: Node): string => (isEl(node) ? node.children.map(fullText).join("") : node.text);

function* walk(nodes: Node[], ancestors: El[]): Generator<[El, El[]]> {
    for (const node of nodes) {
        if (!isEl(node)) continue;
        if (node.tag === "script" || node.tag === "style") continue;
        yield [node, ancestors];
        yield* walk(node.children, [...ancestors, node]);
    }
}

test("#1024: rendered page — catalog is the single source of truth and every Chinese string is marked", () => {
    const html = renderPage("http://127.0.0.1:8787", "0.0.0-test");
    let marked = 0;
    for (const [el, ancestors] of walk(parseHtml(html), [])) {
        const mark = el.attrs["data-i18n"];
        if (mark) {
            marked++;
            assert.equal(fullText(el), translate("zh-CN", mark), `data-i18n="${mark}" drifted from catalog: ${fullText(el)}`);
        }
        if (el.attrs["data-i18n-title"]) {
            assert.equal(el.attrs["title"], translate("zh-CN", el.attrs["data-i18n-title"]), `title drifted for data-i18n-title="${el.attrs["data-i18n-title"]}"`);
        }
        if (el.attrs["data-i18n-ph"]) {
            assert.equal(el.attrs["placeholder"], translate("zh-CN", el.attrs["data-i18n-ph"]), `placeholder drifted for data-i18n-ph="${el.attrs["data-i18n-ph"]}"`);
        }
        for (const attr of ["title", "placeholder"] as const) {
            const value = el.attrs[attr];
            if (value && han.test(value)) {
                assert.ok(el.attrs[attr === "title" ? "data-i18n-title" : "data-i18n-ph"], `unmarked Chinese ${attr}: ${value}`);
            }
        }
        for (const child of el.children) {
            if (!isEl(child) && han.test(child.text)) {
                const covered = [el, ...ancestors].some((e) => e.attrs["data-i18n"] || e.attrs["data-i18n-title"] || e.attrs["data-i18n-ph"]);
                assert.ok(covered, `unmarked Chinese text node: ${child.text.trim().slice(0, 40)}`);
            }
        }
    }
    assert.ok(marked > 80, `expected many marked nodes, found ${marked}`);
    assert.ok(html.includes('id="language-toggle"'), "language toggle button present");
});

test("#2321: embed mode marks the body for chrome-less framing", () => {
    const plain = renderPage("http://127.0.0.1:8787", "0.0.0-test");
    assert.ok(!plain.includes('<body class="embed">'), "default page keeps its full chrome");
    const embedded = renderPage("http://127.0.0.1:8787", "0.0.0-test", true);
    assert.ok(embedded.includes('<body class="embed">'), "embed flag marks the body");
});

test("#2448: embed mode reuses the compact column set and drops standalone-page min-widths", () => {
    assert.ok(WEB_STYLES.includes(".embed .twide table.data, .embed .tproc table.data { min-width: 0; }"), "embed tables lose the standalone-page min-width");
    assert.ok(WEB_STYLES.includes(".embed table.data th:nth-child(n + 6), .embed table.data td:nth-child(n + 6) { display: none; }"), "embed tables reuse the ≤720px compact column set");
    assert.ok(WEB_STYLES.includes(".embed table.data th, .embed table.data td { padding-left: 5px; padding-right: 5px; }"), "embed cells tighten horizontal padding");
    assert.match(WEB_STYLES, /@media \(max-width: 720px\) [\s\S]*?table\.data th:nth-child\(n \+ 6\)/, "the mobile media query still owns the standalone-page compact rule");
});

test("#1024: embedded client parses and persists the language choice", () => {
    assert.doesNotThrow(() => new Function(WEB_CLIENT));
    assert.match(WEB_CLIENT, /bili-language/);
    assert.match(WEB_CLIENT, /language-toggle/);
    assert.match(WEB_CLIENT, /MESSAGES=/);
});

// #2321: the ?lang= pin is resolved inside the client IIFE — exercise the REAL
// WEB_CLIENT in a vm sandbox (deliberately without URLSearchParams/URL globals,
// the same constraint the upstream-alerts / web-sessions harnesses live under)
// and observe the resolved locale through document.documentElement.lang, which
// hydrate() sets synchronously at init.
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

async function runClient(search: string | undefined, navLang: string, stored: string | null): Promise<{ lang: string; els: Map<string, HarnessEl>; location: Record<string, unknown>; storageSet: Array<[string, string]> }> {
    const unhandled: unknown[] = [];
    const onRej = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onRej);
    try {
        const byId = new Map<string, HarnessEl>();
        const idEl = (id: string): HarnessEl => { let e = byId.get(id); if (!e) { e = mkHarnessEl(); byId.set(id, e); } return e; };
        const documentElement: { lang: string } = { lang: "" };
        const documentStub = {
            hidden: false,
            documentElement,
            body: mkHarnessEl(),
            getElementById: (id: string) => idEl(id),
            createElement: () => mkHarnessEl(),
            querySelectorAll: () => [] as unknown[],
            querySelector: () => null,
            addEventListener() { }, removeEventListener() { },
            execCommand() { return true; },
        };
        const storageSet: Array<[string, string]> = [];
        const sandbox: Record<string, unknown> = {
            console,
            setTimeout, clearTimeout, clearInterval,
            setInterval: () => 0,
            fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
            document: documentStub,
            window: { addEventListener() { }, innerWidth: 1440, innerHeight: 900 },
            location: search === undefined
                ? { hash: "#/overview", pathname: "/__bili/", reload() { } }
                : { hash: "#/overview", pathname: "/__bili/", search, reload() { } },
            navigator: { language: navLang },
            localStorage: { getItem: (k: string) => (k === "bili-language" ? stored : null), setItem: (k: string, v: string) => storageSet.push([k, v]) },
        };
        vm.createContext(sandbox);
        vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(unhandled.length, 0, `client init raised unhandled rejection(s): ${unhandled.map((u) => String(u)).join("; ")}`);
        return { lang: documentElement.lang, els: byId, location: sandbox.location as Record<string, unknown>, storageSet };
    } finally {
        process.removeListener("unhandledRejection", onRej);
    }
}

test("#2321: ?lang= pin outranks stored choice and browser default (real client)", async () => {
    assert.equal((await runClient("?embed=1&lang=en", "zh-CN", null)).lang, "en", "pin en beats zh navigator default");
    assert.equal((await runClient("?embed=1&lang=zh", "en-US", "en")).lang, "zh-CN", "pin zh beats both stored en and en navigator");
    assert.equal((await runClient(undefined, "en-US", null)).lang, "en", "no pin: en navigator still resolves en");
    assert.equal((await runClient(undefined, "zh-CN", "en")).lang, "en", "no pin: stored choice still beats navigator");
    assert.equal((await runClient(undefined, "zh-CN", null)).lang, "zh-CN", "no pin: nothing stored falls back to zh-CN");
});

test("#2321: language toggle drops the ?lang= pin so the manual choice sticks", async () => {
    const r = await runClient("?embed=1&lang=en", "zh-CN", null);
    assert.equal(r.lang, "en");
    const tog = r.els.get("language-toggle");
    assert.ok(tog, "language toggle rendered");
    assert.ok(tog!.handlers.click, "toggle has a click handler");
    tog!.handlers.click!();
    assert.deepEqual(r.storageSet, [["bili-language", "zh-CN"]], "manual choice persisted");
    assert.equal(r.location.href, "/__bili/?embed=1#/overview", "navigation keeps other params but strips the lang pin");
});
