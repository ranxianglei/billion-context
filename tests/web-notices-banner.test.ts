import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { WEB_CLIENT } from "../src/web/client.ts";

// #5548 P1: unified announcement renderer — drive the REAL WEB_CLIENT in a vm
// sandbox (same discipline as web-i18n.test.ts) with a fetch stub whose
// /overview carries notices records, then inspect the built DOM. The design
// invariant under test: external copy reaches the DOM via textContent only.

class HEl {
    tag: string;
    children: HEl[] = [];
    handlers: Record<string, (...a: unknown[]) => unknown> = {};
    className = "";
    textContent = "";
    innerHTML = "";
    hidden = false;
    disabled = false;
    value = "";
    title = "";
    href = "";
    target = "";
    rel = "";
    style: Record<string, string> = {};
    dataset: Record<string, unknown> = {};
    attrs: Record<string, string> = {};
    parentElement: HEl | null = null;
    classList: { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean };
    constructor(tag: string) {
        this.tag = tag;
        const set = new Set<string>();
        this.classList = {
            add: (...c) => c.forEach((x) => set.add(x)),
            remove: (...c) => c.forEach((x) => set.delete(x)),
            contains: (c) => set.has(c),
        };
    }
    get firstChild(): HEl | null { return this.children[0] ?? null; }
    appendChild(c: HEl): HEl { c.parentElement = this; this.children.push(c); return c; }
    prepend(c: HEl): HEl { c.parentElement = this; this.children.unshift(c); return c; }
    removeChild(c: HEl): void { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); c.parentElement = null; }
    replaceChildren(): void { this.children = []; }
    remove(): void { if (this.parentElement) this.parentElement.removeChild(this); }
    focus(): void { }
    click(): void { }
    addEventListener(t: string, f: (...a: unknown[]) => unknown): void { this.handlers[t] = f; }
    removeEventListener(): void { }
    setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
    getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
    querySelectorAll(): HEl[] { return []; }
    querySelector(): HEl | null { return null; }
    closest(): HEl | null { return null; }
    scrollIntoView(): void { }
}

const PCK_FIXTURE = {
    id: "pck-default-off", kind: "upgrade-advisory", tone: "warn",
    title: { "zh-CN": "PCK 标题", en: "PCK title" },
    desc: { "zh-CN": "PCK 描述", en: "PCK desc" },
    hint: { "zh-CN": "PCK 提示", en: "PCK hint" },
};
const WM_FIXTURE = {
    id: "wm-fastpath-intro", kind: "new-feature", tone: "ok",
    title: { "zh-CN": "WM 标题", en: "WM title" },
    desc: "WM 纯文本描述",
    hint: "WM 提示",
};

function makeSandbox(notices: unknown) {
    const calls: Array<{ url: string; opts: unknown }> = [];
    const byId = new Map<string, HEl>();
    const idEl = (id: string): HEl => { let e = byId.get(id); if (!e) { e = new HEl("div"); byId.set(id, e); } return e; };
    const documentStub = {
        hidden: false,
        documentElement: { lang: "" },
        body: new HEl("body"),
        getElementById: (id: string) => idEl(id),
        createElement: (tag: string) => new HEl(tag),
        createTextNode: (t: string) => ({ text: t }),
        createDocumentFragment: () => new HEl("#fragment"),
        querySelectorAll: () => [] as unknown[],
        querySelector: () => null,
        addEventListener() { }, removeEventListener() { },
        execCommand() { return true; },
        elementFromPoint: () => null,
    };
    const sandbox: Record<string, unknown> = {
        console,
        setTimeout, clearTimeout, clearInterval,
        setInterval: () => 0,
        fetch: async (url: unknown, opts?: unknown) => {
            calls.push({ url: String(url), opts });
            if (String(url).endsWith("/overview")) return { ok: true, status: 200, json: async () => ({ overview: {}, notices }) };
            return { ok: true, status: 200, json: async () => ({}) };
        },
        document: documentStub,
        window: { addEventListener() { }, innerWidth: 1440, innerHeight: 900 },
        location: { hash: "#/overview", pathname: "/__bili/", reload() { } },
        navigator: { language: "zh-CN" },
        localStorage: { getItem: () => null, setItem() { } },
    };
    vm.createContext(sandbox);
    return { sandbox, calls, byId };
}

async function runClient(notices: unknown): Promise<{ els: Map<string, HEl>; calls: Array<{ url: string; opts: unknown }> }> {
    const unhandled: unknown[] = [];
    const onRej = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onRej);
    const { sandbox, calls, byId } = makeSandbox(notices);
    try {
        vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(unhandled.length, 0, `client init raised unhandled rejection(s): ${unhandled.map((u) => String(u)).join("; ")}`);
        return { els: byId, calls };
    } finally {
        process.removeListener("unhandledRejection", onRej);
    }
}

const bannerTitle = (banner: HEl): HEl => {
    const t = banner.children.find((c) => c.className === "banner-title");
    assert.ok(t, `banner-title child present (children: ${banner.children.map((c) => c.className).join(",")})`);
    return t!;
};
const rowSpan = (banner: HEl): HEl => {
    const row = banner.children.find((c) => c.className === "alert-row");
    assert.ok(row, "alert-row child present");
    const span = row!.children.find((c) => c.tag === "span");
    assert.ok(span, "row span present");
    return span!;
};
const dismissBtn = (banner: HEl): HEl | undefined => {
    for (const c of banner.children) {
        const btn = c.children.find((x) => x.className.includes("notice-dismiss"));
        if (btn) return btn;
    }
    return undefined;
};

test("#5548 P1: overview notices render as banners with record copy (textContent-only)", async () => {
    const { els } = await runClient([PCK_FIXTURE, WM_FIXTURE]);
    const host = els.get("notices-banners");
    assert.ok(host, "notices-banners container exists");
    assert.equal(host!.children.length, 2);
    const [pck, wm] = host!.children;
    assert.equal(pck.className, "banner show warn");
    assert.equal(bannerTitle(pck).textContent, "PCK 标题");
    assert.equal(rowSpan(pck).textContent, "PCK 描述");
    const pckBtn = dismissBtn(pck)!;
    assert.ok(pckBtn, "persistent record gets a dismiss button");
    assert.equal(pckBtn.textContent, "我知道了");
    assert.ok(pckBtn.className.includes("notice-dismiss"));
    const wmHint = wm.children.find((c) => c.className === "dim small");
    assert.ok(wmHint, "hint block present");
    assert.equal(wmHint!.textContent, "WM 提示");
    assert.equal(wm.className, "banner show ok");
    assert.equal(bannerTitle(wm).textContent, "WM 标题");
    assert.equal(rowSpan(wm).textContent, "WM 纯文本描述", "plain-string copy passes through");
});

test("#5548 P1: dismiss mode — always renders no close button", async () => {
    const inc = { id: "incident-x", kind: "incident", tone: "warn", dismiss: "always", title: "事故通告", desc: "详情" };
    const { els } = await runClient([inc]);
    const banner = els.get("notices-banners")!.children[0];
    assert.equal(banner.className, "banner show warn");
    assert.equal(dismissBtn(banner), undefined, "always-mode record has no close button");
});

test("#5548 P1: cta button only when label AND url are both present", async () => {
    const withCta = { ...WM_FIXTURE, id: "cta-both", ctaLabel: "看文档", ctaUrl: "https://example.com/docs" };
    const urlOnly = { ...WM_FIXTURE, id: "cta-url-only", ctaUrl: "https://example.com/docs" };
    const { els } = await runClient([withCta, urlOnly]);
    const [a, b] = els.get("notices-banners")!.children;
    const linkA = a.children.flatMap((c) => c.children).find((x) => x.tag === "a");
    assert.ok(linkA, "label+url renders an anchor");
    assert.equal(linkA!.href, "https://example.com/docs");
    assert.equal(linkA!.target, "_blank");
    assert.equal(linkA!.rel, "noopener");
    assert.equal(linkA!.textContent, "看文档");
    const linkB = b.children.flatMap((c) => c.children).find((x) => x.tag === "a");
    assert.equal(linkB, undefined, "url without label renders nothing");
});

test("#5548 P1: more than five records overflow into the announcements list card", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, kind: "other", tone: "info", title: `公告 ${i}`, desc: `d${i}` }));
    const { els } = await runClient(many);
    const host = els.get("notices-banners")!;
    assert.equal(host.children.length, 5, "header shows at most five banners");
    const card = els.get("notice-list-card");
    const list = els.get("notice-list");
    assert.ok(card && !card.hidden, "overflow card visible");
    assert.equal(list!.children.length, 2, "remainder lands in the list");
    assert.equal(list!.children[0].className, "banner show info");
});

test("#5548 P1: empty notice list renders nothing and keeps the overflow card hidden", async () => {
    const { els } = await runClient([]);
    assert.equal(els.get("notices-banners")!.children.length, 0);
    assert.ok(els.get("notice-list-card")!.hidden, "overflow card stays hidden");
});

test("#5548 P1: locale object falls back zh-CN → en → any key", async () => {
    const frOnly = { id: "fr-only", kind: "other", title: { fr: "Bonjour" }, desc: { "zh-CN": "中文描述", en: "English desc" } };
    const { els } = await runClient([frOnly]);
    const banner = els.get("notices-banners")!.children[0];
    assert.equal(bannerTitle(banner).textContent, "Bonjour", "unknown locale falls back to any available key");
    assert.equal(rowSpan(banner).textContent, "中文描述", "zh-CN beats en when both exist (default locale zh-CN)");
});

test("#5548 P1: hostile copy stays inert text (XSS invariant)", async () => {
    const evil = { id: "evil", kind: "other", title: "<img src=x onerror=alert(1)>", desc: "<script>alert(2)</script>", hint: "<b>bold</b>" };
    const { els } = await runClient([evil]);
    const banner = els.get("notices-banners")!.children[0];
    assert.equal(bannerTitle(banner).textContent, "<img src=x onerror=alert(1)>");
    assert.equal(bannerTitle(banner).children.length, 0, "title element gained no children from markup");
    assert.equal(rowSpan(banner).children.length, 0);
    const hint = banner.children.find((c) => c.className === "dim small")!;
    assert.equal(hint.textContent, "<b>bold</b>");
    assert.equal(hint.children.length, 0);
});

test("#5548 P1: dismiss button posts the record id server-side and re-fetches", async () => {
    const { els, calls } = await runClient([PCK_FIXTURE]);
    const btn = dismissBtn(els.get("notices-banners")!.children[0])!;
    assert.ok(btn.handlers.click, "click handler bound");
    await btn.handlers.click();
    const call = calls.find((c) => c.url.endsWith("/__bili/notices/dismiss"));
    assert.ok(call, "dismiss POST issued");
    assert.equal(String((call!.opts as { method?: string }).method), "POST");
    const body = JSON.parse(String((call!.opts as { body?: string }).body)) as { id: string };
    assert.equal(body.id, "pck-default-off");
    const overviews = calls.filter((c) => c.url.endsWith("/overview")).length;
    assert.ok(overviews >= 2, "overview refetched after dismissal");
});
