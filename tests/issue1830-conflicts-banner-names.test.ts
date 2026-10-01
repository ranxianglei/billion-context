import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { WEB_CLIENT } from "../src/web/client.ts";

// #1830: banner must NAME which third-party plugin conflicted (not just counts).
// Runs the real client IIFE against a stubbed /__bili/overview conflicts payload.

interface DomStub {
    innerHTML: string;
    textContent: string;
    hidden: boolean;
    style: Record<string, unknown>;
    dataset: Record<string, unknown>;
    className: string;
    title: string;
    children: unknown[];
    classList: { add(): void; remove(): void; contains(): boolean; toggle(): void };
    addEventListener(): void;
    removeEventListener(): void;
    appendChild(c: DomStub): DomStub;
    remove(): void; focus(): void; blur(): void; select(): void; click(): void;
    getAttribute(n: string): unknown;
    setAttribute(n: string, v: unknown): void;
    querySelector(): null;
    querySelectorAll(): never[];
    closest(): null;
    getContext(): null;
}

function makeDomStub(tag: string): DomStub {
    const el = {
        tagName: tag.toUpperCase(),
        innerHTML: "", textContent: "", value: "", hidden: false,
        style: {}, dataset: {}, className: "", title: "", children: [] as unknown[],
        classList: { add() { }, remove() { }, contains() { return false; }, toggle() { } },
        addEventListener() { }, removeEventListener() { },
        appendChild(child: DomStub) { el.children.push(child); return child; },
        remove() { }, focus() { }, blur() { }, select() { }, click() { },
        getAttribute() { return null; }, setAttribute() { },
        querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; }, getContext() { return null; },
    };
    return el as DomStub;
}

async function renderOverview(overview: unknown): Promise<Map<string, DomStub>> {
    const byId = new Map<string, DomStub>();
    const idEl = (id: string): DomStub => { let e = byId.get(id); if (!e) { e = makeDomStub("div"); byId.set(id, e); } return e; };
    const documentStub = {
        hidden: false,
        body: makeDomStub("body"),
        documentElement: makeDomStub("html"),
        getElementById: (id: string) => idEl(id),
        createElement: (t: string) => makeDomStub(t),
        querySelectorAll: () => [] as unknown[],
        querySelector: () => null,
        addEventListener() { }, removeEventListener() { }, execCommand() { return true; },
    };
    const sandbox: Record<string, unknown> = {
        console,
        setTimeout, clearTimeout, clearInterval,
        setInterval: () => 0,
        URL,
        fetch: async (url: string) => {
            const payload = String(url).includes("/__bili/overview") ? overview : {};
            return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
        },
        document: documentStub,
        window: { addEventListener() { }, innerWidth: 1440, innerHeight: 900 },
        location: { hash: "#/overview" },
        navigator: { language: "en-US" },
        localStorage: { getItem: () => null, setItem() { } },
    };
    vm.createContext(sandbox);
    vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
    const deadline = Date.now() + 2500;
    for (;;) {
        if ((byId.get("conflicts-banner")?.innerHTML ?? "").length > 0 || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 20));
    return byId;
}

const tp = (detail: string, n = 1) => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, at: 1, kind: "third-party-plugin", detail }));

test("#1830: banner names each conflicting third-party plugin, weighted, source stripped", async () => {
    const overview = {
        overview: { sessions: 23, live: 0 }, version: "0.1.99", diskVersion: "0.1.99", stale: false, autoRestartOnUpdate: false, inFlight: 0, blindTunnels: { total: 0 }, passthrough: { enabled: false, source: null }, alerts: [],
        conflicts: {
            sessions: 23, events: 40, kinds: { "third-party-plugin": 40 },
            latest: [
                ...tp("pi: npm:context-forge (npm) [suspected]", 17),
                ...tp("opencode: opencode-acp@latest (npm)", 4),
                ...tp("pi: npm:billion-context-pi (npm)"),
                ...tp("omp: npm:context-forger (npm) [suspected]"),
            ],
        },
    };
    const els = await renderOverview(overview);
    const html = els.get("conflicts-banner")?.innerHTML ?? "";
    assert.ok(html.length > 0, `banner rendered, got: ${html}`);
    assert.match(html, /event\(s\) in 23 session\(s\)/);
    assert.match(html, /third-party-plugin×40/);
    assert.ok(html.includes("pi: npm:context-forge [suspected]×17"), `heaviest name weighted: ${html}`);
    assert.ok(html.includes("opencode: opencode-acp@latest×4"), `second name weighted: ${html}`);
    assert.ok(html.includes("pi: npm:billion-context-pi ·"), `weight-1 omits ×N: ${html}`);
    assert.ok(html.includes("omp: npm:context-forger [suspected])"), `last name before close paren: ${html}`);
    assert.ok(!html.includes("(npm)"), `source token stripped: ${html}`);
    assert.ok(html.indexOf("context-forge [suspected]×17") < html.indexOf("opencode-acp@latest×4"), "sorted heaviest-first");
    assert.match(html, /<span class="mono"> \(40 event\(s\) in 23 session\(s\): third-party-plugin×40 — pi: npm:context-forge \[suspected\]×17 · opencode: opencode-acp@latest×4 · pi: npm:billion-context-pi · omp: npm:context-forger \[suspected\]\)<\/span>/, `exact data-line format: ${html}`);
});

test("#1830: no third-party events => kinds only, no named tail appended", async () => {
    const overview = {
        overview: { sessions: 2, live: 0 }, version: "0.1.99", diskVersion: "0.1.99", stale: false, autoRestartOnUpdate: false, inFlight: 0, blindTunnels: { total: 0 }, passthrough: { enabled: false, source: null }, alerts: [],
        conflicts: {
            sessions: 2, events: 5, kinds: { "orphan-reap": 3, "unannounced-rewrite": 2 },
            latest: [
                { sessionId: "a", at: 1, kind: "orphan-reap", detail: "3 block(s) deactivated: m00001, m00002" },
                { sessionId: "b", at: 1, kind: "unannounced-rewrite", detail: "2/5 incoming message(s) carry pre-turn refs of 3 known" },
            ],
        },
    };
    const els = await renderOverview(overview);
    const html = els.get("conflicts-banner")?.innerHTML ?? "";
    assert.ok(html.length > 0, `banner rendered, got: ${html}`);
    assert.ok(html.includes("orphan-reap×3"), `kinds aggregate present: ${html}`);
    assert.ok(html.includes("unannounced-rewrite×2"), `kinds aggregate present: ${html}`);
    assert.match(html, /<span class="mono"> \(5 event\(s\) in 2 session\(s\): orphan-reap×3, unannounced-rewrite×2\)<\/span>/, `data line is kinds-only, no named tail: ${html}`);
});

test("#1830: plugin names are HTML-escaped (no XSS via innerHTML)", async () => {
    const overview = {
        overview: { sessions: 1, live: 0 }, version: "0.1.99", diskVersion: "0.1.99", stale: false, autoRestartOnUpdate: false, inFlight: 0, blindTunnels: { total: 0 }, passthrough: { enabled: false, source: null }, alerts: [],
        conflicts: {
            sessions: 1, events: 1, kinds: { "third-party-plugin": 1 },
            latest: [{ sessionId: "x", at: 1, kind: "third-party-plugin", detail: 'pi: <img src=x onerror=alert(1)> (npm)' }],
        },
    };
    const els = await renderOverview(overview);
    const html = els.get("conflicts-banner")?.innerHTML ?? "";
    assert.ok(html.includes("&lt;img"), `name escaped: ${html}`);
    assert.ok(!html.includes("<img"), `no raw markup injected: ${html}`);
});
