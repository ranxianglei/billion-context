import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, defaultConfig } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { markdownToHtml } from "../src/web/markdown.ts";
import { buildOverview, buildSessionDetail, buildSessionList, _resetDiskCacheForTest } from "../src/web/sessions-data.ts";

// Plain JSON session files so seeds and round-trips stay deterministic (#1080)
process.env.BILI_PERSIST_ZSTD = "0";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

interface Stats {
    requests: number;
    tokensSaved: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cacheSamples: number;
    lastInputTokens: number;
    contextTokens: number;
    retrieveCalls: number;
    retrieveHits: number;
    retrieveMisses: number;
    storedBytes: number;
    storeBytesSaved: number;
    compressCreditTokens: number;
}

function zeroStats(): Stats {
    return { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, compressCreditTokens: 0 };
}

function makeSession(id: string, meta: Session["meta"] = {}, patch: Partial<Stats> = {}, lastSeen = Date.now()): Session {
    return {
        id,
        meta,
        stats: { ...zeroStats(), ...patch },
        metadata: {},
        state: createInitialState(),
        createdAt: lastSeen,
        lastSeen,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

// Loaded sessions take lastSeen from the record's own savedAt (#404), so pin
// it in the raw file (plain JSON under BILI_PERSIST_ZSTD=0) for deterministic order.
function setSavedAt(dir: string, id: string, ts: number): void {
    const files = readdirSync(dir, { recursive: true }) as string[];
    for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(dir, f);
        const env = JSON.parse(readFileSync(p, "utf8")) as { id?: string; savedAt?: number; payload?: { savedAt?: number } };
        if (env.id === id && typeof env.payload?.savedAt === "number") {
            env.payload.savedAt = ts;
            env.savedAt = ts;
            writeFileSync(p, JSON.stringify(env), "utf8");
            return;
        }
    }
    assert.fail(`session file for ${id} not found under ${dir}`);
}

function withSessionsDir<T>(name: string, fn: (dir: string) => Promise<T>): void {
    test(name, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-web-sess-"));
        const prev = process.env.BILI_SESSIONS_DIR;
        process.env.BILI_SESSIONS_DIR = dir;
        try {
            await fn(dir);
        } finally {
            if (prev === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prev;
            _resetSessionsForTest();
            _resetDiskCacheForTest();
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

test("markdownToHtml escapes raw HTML and sanitizes unsafe URLs", () => {
    const img = markdownToHtml("<img src=x onerror=alert(1)>");
    assert.ok(!img.includes("<img"), "raw img tag must not survive");
    assert.ok(img.includes("&lt;img"), "tag must be escaped, not dropped silently");

    const js = markdownToHtml("[x](javascript:alert(1))");
    assert.ok(!js.includes("javascript:"), "javascript: URL must be stripped");

    const ok = markdownToHtml("[ok](https://example.com/a)");
    assert.ok(ok.includes('href="https://example.com/a"'), "http(s) links are kept");
});

test("markdownToHtml renders headings, lists, code and emphasis", () => {
    const md = "# T\n\n- a\n- b\n\n```\ncode < & \"q\"\n```\n\n**bold** and `inline`\n";
    const html = markdownToHtml(md);
    assert.match(html, /<h1>T<\/h1>/);
    assert.match(html, /<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
    assert.ok(html.includes("code &lt; &amp; &quot;q&quot;") || html.includes("code &lt; &amp;"), "fenced code content must be HTML-escaped");
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>inline<\/code>/);
});

withSessionsDir("buildSessionList merges the live pool with the disk store", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    const a = makeSession("disk-a", { protocol: "openai", label: "A" }, { requests: 3, inputTokens: 1000, cachedTokens: 400, tokensSaved: 55, contextTokens: 777 }, Date.now() - 3_600_000);
    await store.writeNow(a);
    setSavedAt(dir, "disk-a", Date.now() - 3_600_000);
    const b = makeSession("disk-b", { protocol: "anthropic" }, { requests: 1, inputTokens: 100, cachedTokens: 50, contextTokens: 90 }, Date.now() - 7_200_000);
    await store.writeNow(b);
    setSavedAt(dir, "disk-b", Date.now() - 7_200_000);

    _setStoreForTest(new SessionStore({ enabled: false }));
    const live = getSession("live-1", { protocol: "openai", label: "live-label" });
    live.stats.requests = 9;
    live.stats.inputTokens = 500;
    live.stats.cachedTokens = 250;
    live.stats.tokensSaved = 33;
    live.stats.contextTokens = 4242;
    live.lastSeen = Date.now();

    _resetDiskCacheForTest();
    const list = await buildSessionList();
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((s) => s.id), ["live-1", "disk-a", "disk-b"], "newest activity first");

    const lv = list[0];
    assert.equal(lv.live, true);
    assert.equal(lv.requests, 9);
    assert.equal(lv.contextTokens, 4242);
    assert.equal(lv.cacheHitPct, 50);
    assert.equal(lv.label, "live-label");

    assert.equal(list[1].live, false);
    assert.equal(list[1].label, "A");
    assert.equal(list[1].protocol, "openai");
    assert.equal(list[1].cacheHitPct, 40);
    assert.equal(list[1].title, undefined);

    const stale = makeSession("live-1", { protocol: "openai" }, { requests: 1, inputTokens: 10, contextTokens: 10 });
    await store.writeNow(stale);
    _resetDiskCacheForTest();
    const again = await buildSessionList();
    const lv2 = again.find((s) => s.id === "live-1");
    assert.ok(lv2);
    assert.equal(lv2.live, true, "live entry wins over its stale disk twin");
    assert.equal(lv2.requests, 9);
});

withSessionsDir("buildOverview aggregates totals, hit rate and per-protocol rows", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    await store.writeNow(makeSession("disk-a", { protocol: "openai" }, { requests: 3, inputTokens: 1000, cachedTokens: 400, tokensSaved: 55, contextTokens: 777 }));
    setSavedAt(dir, "disk-a", Date.now() - 3_600_000);
    await store.writeNow(makeSession("disk-b", { protocol: "anthropic" }, { requests: 1, inputTokens: 100, cachedTokens: 50, contextTokens: 90 }));
    setSavedAt(dir, "disk-b", Date.now() - 7_200_000);

    _setStoreForTest(new SessionStore({ enabled: false }));
    const live = getSession("live-1", { protocol: "openai" });
    live.stats.requests = 9;
    live.stats.inputTokens = 500;
    live.stats.cachedTokens = 250;
    live.stats.tokensSaved = 33;
    live.lastSeen = Date.now();

    const ov = await buildOverview();
    assert.equal(ov.sessions, 3);
    assert.equal(ov.live, 1);
    assert.equal(ov.requests, 13);
    assert.equal(ov.inputTokens, 1600);
    assert.equal(ov.cachedTokens, 700);
    assert.equal(ov.tokensSaved, 88);
    assert.equal(ov.hitPct, Math.round((700 / 1600) * 100));
    const openai = ov.byProtocol.find((r) => r.protocol === "openai");
    assert.ok(openai);
    assert.equal(openai.sessions, 2);
    assert.equal(openai.requests, 12);
    assert.equal(openai.inputTokens, 1500);
    assert.equal(ov.recent.length, 3);
    assert.equal(ov.recent[0].id, "live-1");
});

withSessionsDir("buildSessionDetail returns blocks, ledger and rendered handoff", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    const s = makeSession("det-1", { protocol: "openai", title: "Det Title" }, { requests: 2, inputTokens: 800, cachedTokens: 200, contextTokens: 300 });
    const block: CompressionBlock = {
        blockId: "b1",
        runId: "r1",
        tier: 1,
        topic: "Topic",
        summary: "Sum <text>",
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 1234,
        createdAt: Date.now(),
        survivedCount: 1,
        generation: "young",
        active: true,
    };
    s.state.blocks.push(block);
    await store.writeNow(s);

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("det-1");
    assert.ok(d);
    assert.equal(d.title, "Det Title");
    assert.equal(d.protocol, "openai");
    assert.equal(d.live, false);
    assert.equal(d.blockDetails.length, 1);
    assert.equal(d.blockDetails[0].blockId, "b1");
    assert.equal(d.blockDetails[0].compressedTokens, 1234);
    assert.equal(d.blockDetails[0].active, true);
    assert.ok(Array.isArray(d.ledger?.lines), "cache report lines array present");
    assert.equal(typeof d.handoffHtml, "string");
    assert.ok(d.handoffHtml.includes("Sum &lt;text&gt;"), "handoff markdown is HTML-escaped");
    assert.equal(await buildSessionDetail("nope"), null);
});

interface OverviewBody {
    overview: {
        sessions: number;
        live: number;
        requests: number;
        hitPct: number | null;
        byProtocol: Array<{ protocol: string; sessions: number }>;
        recent: Array<{ id: string }>;
    };
    version: string;
    stale: boolean;
    inFlight: number;
    blindTunnels: { total: number };
    passthrough: { enabled: boolean; source: string | null };
}

interface SessionsBody {
    sessions: Array<{ id: string; live: boolean }>;
}

interface DetailBody {
    id: string;
    live: boolean;
    blockDetails: unknown[];
    handoffHtml: string;
    ledger: { lines: unknown[] } | null;
}

test("web endpoints serve overview, session list and per-session detail", async () => {
    const root = path.join(tmpdir(), `bili-web-sess-ep-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    const prevSessions = process.env.BILI_SESSIONS_DIR;
    process.env.BILI_CONFIG_FILE = biliConfig;
    process.env.BILI_SESSIONS_DIR = root;

    const store = new SessionStore({ dir: root, debounceMs: 0, enabled: true });
    await store.writeNow(makeSession("ep-1", { protocol: "openai", label: "ep" }, { requests: 2, inputTokens: 800, cachedTokens: 200, contextTokens: 300 }));
    _resetDiskCacheForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const ovRes = await fetch(`${base}/__bili/overview`);
        assert.equal(ovRes.status, 200);
        const ov = (await ovRes.json()) as OverviewBody;
        assert.equal(ov.overview.sessions, 1);
        assert.equal(ov.overview.live, 0);
        assert.equal(ov.overview.requests, 2);
        assert.equal(ov.passthrough.enabled, false);
        assert.equal(ov.blindTunnels.total, 0);
        assert.ok(ov.version.length > 0);

        const sesRes = await fetch(`${base}/__bili/sessions`);
        assert.equal(sesRes.status, 200);
        const ses = (await sesRes.json()) as SessionsBody;
        assert.equal(ses.sessions.length, 1);
        assert.equal(ses.sessions[0].id, "ep-1");
        assert.equal(ses.sessions[0].live, false);

        const detRes = await fetch(`${base}/__bili/sessions/ep-1/detail`);
        assert.equal(detRes.status, 200);
        const det = (await detRes.json()) as DetailBody;
        assert.equal(det.id, "ep-1");
        assert.equal(det.live, false);
        assert.equal(typeof det.handoffHtml, "string");
        assert.ok(Array.isArray(det.ledger?.lines));

        const missRes = await fetch(`${base}/__bili/sessions/nope/detail`);
        assert.equal(missRes.status, 404);
        const miss = (await missRes.json()) as { error: string };
        assert.match(miss.error, /unknown session/);
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        if (prevSessions === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevSessions;
        await close(proxy);
        _resetDiskCacheForTest();
        rmSync(root, { recursive: true, force: true });
    }
});
