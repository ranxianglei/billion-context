import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import vm from "node:vm";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import {
    recordUpstreamAlert,
    clearUpstreamAlertsForHost,
    getUpstreamAlerts,
    _resetUpstreamAlertsForTest,
    type UpstreamAlert,
} from "../src/upstream-alerts.ts";
import { assertPortDead } from "./port-race.ts";

// #1682: web UI surfaces active upstream-connection failures as a global banner.
// Three layers pinned here: the alert table itself (dedup / success-clear /
// bounded eviction / kind gating), the /__bili/overview payload (real request
// through the proxy against a dead, then recovered, upstream), and the rendered
// banner (real client IIFE in a VM, including dismiss-per-instance semantics).

process.env.BILI_PERSIST_ZSTD = "0";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

function netError(code: string, message = code): Error & { code?: string } {
    const e: Error & { code?: string } = new Error(message);
    e.code = code;
    return e;
}

function withClock<T>(fn: (advance: () => void) => T): T {
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
        return fn(() => { t += 1_000; });
    } finally {
        Date.now = realNow;
    }
}

test("alert table: repeat failure dedups on (kind, host), refreshes lastSeen/count only", () => {
    _resetUpstreamAlertsForTest();
    try {
        withClock((advance) => {
            recordUpstreamAlert("http://chatgpt.com/v1/messages", netError("UND_ERR_CONNECT_TIMEOUT"), false);
            advance();
            recordUpstreamAlert("http://chatgpt.com/v1/chat/completions", netError("UND_ERR_CONNECT_TIMEOUT"), false);
            const [a] = getUpstreamAlerts();
            assert.equal(a.kind, "connect-timeout");
            assert.equal(a.host, "chatgpt.com");
            assert.equal(a.count, 2);
            assert.equal(a.firstSeen, 1_000_000);
            assert.equal(a.lastSeen, 1_001_000);
            assert.ok(a.hint.length > 0);
        });
    } finally {
        _resetUpstreamAlertsForTest();
    }
});

test("alert table: every v1 kind enters, keyed by (kind, host)", () => {
    _resetUpstreamAlertsForTest();
    try {
        recordUpstreamAlert("http://h1.example.com/", netError("UND_ERR_CONNECT_TIMEOUT"), false);
        recordUpstreamAlert("http://h2.example.com/", netError("ECONNREFUSED"), false);
        recordUpstreamAlert("http://h3.example.com/", netError("ECONNRESET"), true);
        recordUpstreamAlert("http://h4.example.com/", netError("ECONNRESET"), false);
        recordUpstreamAlert("http://h5.example.com/", netError("ENOTFOUND"), false);
        recordUpstreamAlert("https://h6.example.com:8443/", netError("EPROTO"), false);
        const kinds = getUpstreamAlerts().map((a) => a.kind).sort();
        assert.deepEqual(kinds, ["connect-refused", "connect-timeout", "dns", "proxy-reset", "tls", "upstream-reset"]);
        const tls = getUpstreamAlerts().find((a) => a.kind === "tls");
        assert.equal(tls?.host, "h6.example.com:8443");
    } finally {
        _resetUpstreamAlertsForTest();
    }
});

test("alert table: non-alert kinds never enter (post-connect timeout, unknown)", () => {
    _resetUpstreamAlertsForTest();
    try {
        recordUpstreamAlert("http://x.example.com/", netError("ETIMEDOUT"), false);
        recordUpstreamAlert("http://x.example.com/", Object.assign(new Error("aborted"), { name: "AbortError" }), false);
        recordUpstreamAlert("http://x.example.com/", new Error("mystery"), false);
        assert.deepEqual(getUpstreamAlerts(), []);
    } finally {
        _resetUpstreamAlertsForTest();
    }
});

test("alert table: success clears every alert for that host only", () => {
    _resetUpstreamAlertsForTest();
    try {
        recordUpstreamAlert("http://a.example.com/", netError("ECONNREFUSED"), false);
        recordUpstreamAlert("http://a.example.com/", netError("ENOTFOUND"), false);
        recordUpstreamAlert("http://b.example.com/", netError("ECONNRESET"), false);
        clearUpstreamAlertsForHost("http://a.example.com/some/path");
        const [a] = getUpstreamAlerts();
        assert.equal(getUpstreamAlerts().length, 1);
        assert.equal(a.host, "b.example.com");
    } finally {
        _resetUpstreamAlertsForTest();
    }
});

test("alert table: bounded at 32 entries, evicts oldest lastSeen first", () => {
    _resetUpstreamAlertsForTest();
    try {
        withClock((advance) => {
            for (let i = 1; i <= 40; i++) {
                recordUpstreamAlert(`http://h${i}.example.com/`, netError("ECONNREFUSED"), false);
                advance();
            }
            const alerts = getUpstreamAlerts();
            assert.equal(alerts.length, 32);
            const hosts = new Set(alerts.map((a) => a.host));
            assert.ok(!hosts.has("h1.example.com"), "oldest evicted");
            assert.ok(!hosts.has("h8.example.com"));
            assert.ok(hosts.has("h9.example.com"));
            assert.ok(hosts.has("h40.example.com"));
        });
    } finally {
        _resetUpstreamAlertsForTest();
    }
});

test("alert table: unparseable URL falls back to raw string host; most-recently-seen sorts first", () => {
    _resetUpstreamAlertsForTest();
    try {
        recordUpstreamAlert("not-a-url", netError("ECONNREFUSED"), false);
        const raw = getUpstreamAlerts()[0];
        assert.equal(raw.host, "not-a-url");
        clearUpstreamAlertsForHost("not-a-url");
        assert.deepEqual(getUpstreamAlerts(), []);
        withClock((advance) => {
            recordUpstreamAlert("http://a.example.com/", netError("ENOTFOUND"), false);
            advance();
            recordUpstreamAlert("http://b.example.com/", netError("ENOTFOUND"), false);
            advance();
            recordUpstreamAlert("http://a.example.com/", netError("ENOTFOUND"), false);
            const order = getUpstreamAlerts().map((a) => a.host);
            assert.deepEqual(order, ["a.example.com", "b.example.com"]);
        });
    } finally {
        _resetUpstreamAlertsForTest();
    }
});

// --- API layer: real request through the proxy -------------------------------

async function startProxyFor(upstreamPort: number, registerRoute: boolean): Promise<{ proxy: http.Server; proxyPort: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        proxy: "",
        routes: registerRoute ? { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } } : {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
        proxyFallback: { explicitDirect: true, globalSource: "direct" },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, proxyPort };
}

function chatPost(proxyPort: number, upstreamPort: number, sessionId: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
    });
}

async function overviewAlerts(proxyPort: number): Promise<UpstreamAlert[]> {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/__bili/overview`);
    assert.equal(res.status, 200);
    const d = (await res.json()) as { alerts: UpstreamAlert[] };
    assert.ok(Array.isArray(d.alerts), "overview payload carries an alerts array");
    return d.alerts;
}

test("#1682: transport failure appears in /__bili/overview and clears on recovery", async () => {
    _resetUpstreamAlertsForTest();
    const deadPort = await freePort();
    const { proxy, proxyPort } = await startProxyFor(deadPort, true);
    try {
        // #2548/#1689: prove the freed port is actually dead right before the first
        // request dials it — a squatter would turn the expected connect-refused into
        // a live answer and drop the alert. A live "unhealthy" server can't stand in
        // for a refused port (hang = connect-timeout, 500 = a real response), so this
        // site uses assertPortDead rather than the zcode-native live-500 construction.
        await assertPortDead(deadPort, { label: "#1682 transport-failure dead upstream" });
        // 1) first failure → 5xx + exactly one alert with kind/host/hint
        const r1 = await chatPost(proxyPort, deadPort, "ep-alerts-1");
        assert.ok(r1.status >= 500, `expected 5xx on dead upstream, got ${r1.status}: ${(await r1.text()).slice(0, 200)}`);
        const a1 = await overviewAlerts(proxyPort);
        assert.equal(a1.length, 1);
        assert.equal(a1[0].kind, "connect-refused");
        assert.equal(a1[0].host, `127.0.0.1:${deadPort}`);
        assert.equal(a1[0].count, 1);
        assert.ok(typeof a1[0].hint === "string" && a1[0].hint.length > 0);
        assert.equal(a1[0].firstSeen, a1[0].lastSeen);

        // 2) second failure → same entry, count bumped, no stacking
        const r2 = await chatPost(proxyPort, deadPort, "ep-alerts-1");
        assert.ok(r2.status >= 500);
        await r2.arrayBuffer();
        const a2 = await overviewAlerts(proxyPort);
        assert.equal(a2.length, 1);
        assert.equal(a2[0].count, 2);
        assert.ok(a2[0].lastSeen >= a2[0].firstSeen);

        // 3) recovery: live upstream on the SAME port → next success clears
        const up = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test", object: "chat.completion", created: 0, model: "gpt-test",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
        up.listen(deadPort, "127.0.0.1");
        await once(up, "listening");
        try {
            const r3 = await chatPost(proxyPort, deadPort, "ep-alerts-1");
            assert.ok(r3.status < 500, `recovery request should pass through, got ${r3.status}`);
            await r3.arrayBuffer();
            assert.deepEqual(await overviewAlerts(proxyPort), []);
        } finally {
            await close(up);
        }
    } finally {
        await close(proxy);
        _resetUpstreamAlertsForTest();
    }
});

// --- Web UI layer: the real client IIFE renders the banner --------------------

interface El {
    tagName: string;
    innerHTML: string;
    textContent: string;
    value: string;
    hidden: boolean;
    style: Record<string, unknown>;
    dataset: Record<string, unknown>;
    className: string;
    title: string;
    children: El[];
    classList: { add(): void; remove(): void; contains(): boolean; toggle(): void };
    listeners: Record<string, Array<(...args: unknown[]) => void>>;
    addEventListener(type: string, fn: (...args: unknown[]) => void): void;
    removeEventListener(): void;
    appendChild(child: El): El;
    remove(): void;
    focus(): void;
    blur(): void;
    select(): void;
    click(): void;
    getAttribute(name: string): unknown;
    setAttribute(name: string, v: unknown): void;
    querySelector(): null;
    querySelectorAll(): never[];
    closest(): null;
    getContext(): null;
}

// Same surface as web-sessions.test.ts's makeDomStub, extended: listeners are
// captured and click() invokes them (dismiss button), appendChild serializes
// textContent (rows are built with textContent, not innerHTML), and clearing
// innerHTML removes children like a real DOM (re-render relies on this).
function makeEl(tag: string): El {
    let html = "";
    const raw: Record<string, unknown> = {
        tagName: tag.toUpperCase(),
        textContent: "",
        value: "",
        hidden: false,
        style: {},
        dataset: {},
        className: "",
        title: "",
        children: [] as El[],
        classList: { add() { }, remove() { }, contains() { return false; }, toggle() { } },
        listeners: {} as Record<string, Array<(...args: unknown[]) => void>>,
        addEventListener(type: string, fn: (...args: unknown[]) => void) {
            (raw.listeners as Record<string, Array<(...args: unknown[]) => void>>)[type] ??= [];
            (raw.listeners as Record<string, Array<(...args: unknown[]) => void>>)[type].push(fn);
        },
        removeEventListener() { },
        appendChild(child: El) {
            (raw.children as El[]).push(child);
            const t = child.tagName.toLowerCase();
            html += `<${t}>${child.textContent || child.innerHTML}</${t}>`;
            return child;
        },
        remove() { }, focus() { }, blur() { }, select() { },
        click() { for (const fn of (raw.listeners as Record<string, Array<(...args: unknown[]) => void>>)["click"] ?? []) fn(); },
        getAttribute(name: string) { return raw[name] ?? null; },
        setAttribute(name: string, v: unknown) { raw[name] = String(v); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        getContext() { return null; },
    };
    Object.defineProperty(raw, "innerHTML", {
        get: () => html,
        set: (v: string) => { html = v; if (v === "") (raw.children as El[]).length = 0; },
        enumerable: true,
    });
    return raw as unknown as El;
}

interface Harness {
    els: Map<string, El>;
}

async function runWebClient(base: string, hash: string, storage: Map<string, string>): Promise<Harness> {
    const byId = new Map<string, El>();
    const idEl = (id: string): El => { let e = byId.get(id); if (!e) { e = makeEl("div"); byId.set(id, e); } return e; };
    const documentStub = {
        hidden: false,
        body: makeEl("body"),
        documentElement: makeEl("html"),
        getElementById: (id: string) => idEl(id),
        createElement: (t: string) => makeEl(t),
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener() { },
        removeEventListener() { },
        execCommand() { return true; },
    };
    const sandbox: Record<string, unknown> = {
        console,
        setTimeout, clearTimeout, clearInterval,
        setInterval: () => 0,
        fetch: (url: string, opts?: unknown) => globalThis.fetch(new URL(url, base).toString(), opts as RequestInit | undefined),
        document: documentStub,
        window: { addEventListener() { }, innerWidth: 1440, innerHeight: 900 },
        location: { hash },
        navigator: { language: "en-US" },
        localStorage: {
            getItem: (k: string) => storage.get(k) ?? null,
            setItem: (k: string, v: string) => { storage.set(k, v); },
        },
    };
    vm.createContext(sandbox);
    vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
    return { els: byId };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

test("#1682: banner renders active alerts, dismisses per instance, hides on recovery", async () => {
    _resetUpstreamAlertsForTest();
    // Seed two connect-timeout failures against one host (count=2, stable firstSeen).
    recordUpstreamAlert("http://chatgpt.example.com/v1/messages", netError("UND_ERR_CONNECT_TIMEOUT"), false);
    recordUpstreamAlert("http://chatgpt.example.com/v1/messages", netError("UND_ERR_CONNECT_TIMEOUT"), false);
    const seeded = getUpstreamAlerts()[0];
    assert.equal(seeded.count, 2);

    const deadPort = await freePort();
    const { proxy, proxyPort } = await startProxyFor(deadPort, false);
    const base = `http://127.0.0.1:${proxyPort}`;
    const storage = new Map<string, string>();
    try {
        // 1) banner visible with title + one row (no stacking for one alert)
        //    the element is lazily created by renderAlertBanner, so its presence
        //    plus final hidden state means the first overview round-trip settled.
        const h1 = await runWebClient(base, "#/overview", storage);
        await waitFor(() => {
            const b = h1.els.get("alerts-banner");
            return !!b && b.hidden === false;
        }, "banner rendered visible");
        const banner = h1.els.get("alerts-banner");
        assert.ok(banner, "alerts-banner element exists");
        assert.equal(banner!.hidden, false);
        assert.equal(banner!.children.length, 2, "title + one row");
        const title = banner!.children[0];
        assert.equal(title.className, "banner-title");
        assert.equal(title.textContent, "⚠️ Upstream connection problems");
        const row = banner!.children[1];
        assert.equal(row.className, "alert-row");
        const msg = row.children[0];
        const btn = row.children[1];
        assert.match(msg.textContent, /Cannot reach chatgpt\.example\.com \(connect-timeout ×2, since \d{2}-\d{2} \d{2}:\d{2}\) — TCP handshake never completed/);
        assert.equal(btn.textContent, "Got it");
        assert.equal(btn.className, "btn sm alert-dismiss");

        // 2) dismiss stores the instance key (kind|host|firstSeen) and hides the banner
        btn.click();
        assert.equal(banner!.hidden, true, "banner hides after dismissing its only row");
        assert.equal(banner!.children.length, 0);
        const stored = JSON.parse(storage.get("bili-alert-dismissed") ?? "[]") as string[];
        assert.deepEqual(stored, [`connect-timeout|chatgpt.example.com|${seeded.firstSeen}`]);

        // 3) count growth on the SAME instance does not re-show it
        recordUpstreamAlert("http://chatgpt.example.com/v1/messages", netError("UND_ERR_CONNECT_TIMEOUT"), false);
        assert.equal(getUpstreamAlerts()[0].count, 3);
        const h2 = await runWebClient(base, "#/overview", storage);
        await waitFor(() => h2.els.has("alerts-banner"), "second overview poll");
        const banner2 = h2.els.get("alerts-banner");
        assert.equal(banner2!.hidden, true, "dismissed instance stays dismissed while count grows");
        assert.equal(banner2!.innerHTML, "");

        // 4) recovery (table emptied) → banner gone even though the dismiss list survives
        _resetUpstreamAlertsForTest();
        const h3 = await runWebClient(base, "#/overview", storage);
        await waitFor(() => h3.els.has("alerts-banner"), "third overview poll");
        assert.equal(h3.els.get("alerts-banner")!.hidden, true);
    } finally {
        await close(proxy);
        _resetUpstreamAlertsForTest();
    }
});
