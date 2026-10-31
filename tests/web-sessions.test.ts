import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, defaultConfig } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { VERSION } from "../src/version.ts";
import type { Session } from "../src/session.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { markdownToHtml } from "../src/web/markdown.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { buildOverview, buildSessionDetail, buildSessionList, buildSessionPage, hiddenEmptyCount, _resetDiskCacheForTest, _diskScanStatsForTest } from "../src/web/sessions-data.ts";
import vm from "node:vm";
import { rmrf } from "./tmp-rm.ts";

// Plain JSON session files so seeds and round-trips stay deterministic (#1080)
process.env.BILI_PERSIST_ZSTD = "0";

// #2671 hermeticity: this suite builds SessionStores against real tmp dirs
// and asserts on directory contents (foreign-content alarms, #1937/#2180
// staleness). A developer machine with storage.unified=full in its real
// billion-context.json would open sidecars inside those tmp dirs — index.db
// then looks like FOREIGN content and the alarm tests drift. Pin both
// storage tiers to a hermetic baseline.
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-web-sess-hermetic-")),
    "no-config.json",
);
// Absent everywhere now resolves to the shadow DEFAULT (#2815 rollout flip);
// this suite needs the explicit legacy baseline — per-test legs override it.
process.env.BILI_STORAGE_UNIFIED = "legacy";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
    rangeRestores: number;
    wholeBlockRestores?: number;
    wholeBlockRestoresPreciseAvailable?: number;
}

function zeroStats(): Stats {
    return { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, compressCreditTokens: 0, rangeRestores: 0, wholeBlockRestores: 0, wholeBlockRestoresPreciseAvailable: 0 };
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
        pendingRetrievals: [],
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
            rmrf(dir);
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

withSessionsDir("hostTitle round-trips through persistence and wins display precedence (#2322)", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    await store.writeNow(makeSession("ht-2322", { protocol: "openai", title: "derived first message", hostTitle: "Named by host" }, { requests: 2, inputTokens: 10, contextTokens: 9 }));
    setSavedAt(dir, "ht-2322", Date.now() - 60_000);

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const row = (await buildSessionList()).find((s) => s.id === "ht-2322");
    assert.equal(row?.title, "Named by host", "disk-scanned record restores hostTitle from the file");

    await store.writeNow(makeSession("plain-2322", { protocol: "openai", title: "derived only" }, { requests: 1, inputTokens: 5, contextTokens: 4 }));
    setSavedAt(dir, "plain-2322", Date.now() - 120_000);
    _resetDiskCacheForTest();
    const plain = (await buildSessionList()).find((s) => s.id === "plain-2322");
    assert.equal(plain?.title, "derived only", "no hostTitle → derived title unchanged");
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

withSessionsDir("tokensSaved derives from active blocks when the stat is dead (#2734)", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    const mk = (blockId: string, compressedTokens: number, active: boolean): CompressionBlock => ({
        blockId,
        runId: "r1",
        tier: 1,
        topic: "T",
        summary: "S",
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens,
        createdAt: Date.now(),
        survivedCount: 1,
        generation: "young",
        active,
    });
    const s = makeSession("det-save", { protocol: "openai" }, { requests: 1, tokensSaved: 0, contextTokens: 100 });
    s.state.blocks.push(mk("b1", 1000, true), mk("b2", 500, true), mk("b3", 9999, false));
    await store.writeNow(s);
    // A larger legacy accumulated stat must never regress by the derivation.
    const s2 = makeSession("det-save-old", { protocol: "openai" }, { requests: 1, tokensSaved: 9999, contextTokens: 100 });
    s2.state.blocks.push(mk("b1", 100, true));
    await store.writeNow(s2);

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("det-save");
    assert.ok(d);
    assert.equal(d.tokensSaved, 1500, "dead stat 0 → derived from active blocks only");
    const row = (await buildSessionList()).find((x) => x.id === "det-save");
    assert.equal(row?.tokensSaved, 1500, "list rows derive the same value (disk scan path)");
    const d2 = await buildSessionDetail("det-save-old");
    assert.equal(d2?.tokensSaved, 9999, "larger legacy stat wins (floor)");
});

withSessionsDir("session detail exposes decompress usage counters (#3671 direction 4)", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    const s = makeSession("det-dec", { protocol: "openai", title: "Dec" }, { requests: 5, wholeBlockRestores: 26, wholeBlockRestoresPreciseAvailable: 9, rangeRestores: 3 });
    await store.writeNow(s);
    const z = makeSession("det-dec-zero", { protocol: "openai" });
    await store.writeNow(z);

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("det-dec");
    assert.ok(d);
    assert.equal(d.wholeBlockRestores, 26);
    assert.equal(d.wholeBlockRestoresPreciseAvailable, 9);
    assert.equal(d.rangeRestores, 3);
    const dz = await buildSessionDetail("det-dec-zero");
    assert.ok(dz);
    assert.equal(dz.wholeBlockRestores, 0, "no restores → explicit zero, not absent");
    assert.equal(dz.wholeBlockRestoresPreciseAvailable, 0);
    assert.equal(dz.rangeRestores, 0);
});

withSessionsDir("credited tokensSaved survives full deactivation (#4700)", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    const mk = (blockId: string, compressedTokens: number, active: boolean): CompressionBlock => ({
        blockId,
        runId: "r1",
        tier: 1,
        topic: "T",
        summary: "S",
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens,
        createdAt: Date.now(),
        survivedCount: 1,
        generation: "young",
        active,
    });
    // Post-#4700 state: the tool-driven folds credited the lifetime total
    // (12789+8214 shape from the issue), then a client-side /compact
    // deactivated every block. The column must keep showing the total.
    const s = makeSession("det-save-4700", { protocol: "anthropic" }, { requests: 107, tokensSaved: 21003, contextTokens: 100 });
    s.state.blocks.push(mk("b1", 12789, false), mk("b2", 8214, false));
    await store.writeNow(s);

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("det-save-4700");
    assert.ok(d);
    assert.equal(d.tokensSaved, 21003, "counter floor keeps SAVED alive when every block is inactive");
    const row = (await buildSessionList()).find((x) => x.id === "det-save-4700");
    assert.equal(row?.tokensSaved, 21003, "list rows derive the same value");
});

withSessionsDir("session detail surfaces the per-file storage-mode stamp (#2671)", async (dir) => {
    const saved: Array<string | undefined> = [process.env.BILI_STORAGE_UNIFIED, process.env.BILI_ENCRYPTION_KEY];
    const setEnv = (unified: string | undefined, key: string | undefined) => {
        if (unified === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = unified;
        if (key === undefined) delete process.env.BILI_ENCRYPTION_KEY; else process.env.BILI_ENCRYPTION_KEY = key;
    };
    // #3818/#3135-3: the stamp reflects what the STORE INSTANCE actually
    // managed to open (liveStorageStamp), not the knob value at write time —
    // so each leg builds its own store AFTER pinning the env. The
    // stamp-plumbing leg pins shadow explicitly (absent everywhere now
    // defaults to FULL and is asserted in tests/storage-full-flip.test.ts ①).
    try {
        setEnv("shadow", undefined);
        let leg = new SessionStore({ dir, debounceMs: 0, enabled: true });
        await leg.writeNow(makeSession("sm-default", { protocol: "openai" }));
        leg.closeQuietly();
        // full → full stamp
        setEnv("full", undefined);
        leg = new SessionStore({ dir, debounceMs: 0, enabled: true });
        await leg.writeNow(makeSession("sm-full", { protocol: "openai" }));
        leg.closeQuietly();
        // full requested but encryption blocks the sidecar → honest legacy stamp
        setEnv("full", "00".repeat(32));
        leg = new SessionStore({ dir, debounceMs: 0, enabled: true });
        await leg.writeNow(makeSession("sm-blocked", { protocol: "openai" }));
        leg.closeQuietly();
    } finally {
        setEnv(saved[0], saved[1]);
    }

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    assert.equal((await buildSessionDetail("sm-default"))?.storageMode, "shadow", "explicit shadow stamps shadow");
    assert.equal((await buildSessionDetail("sm-full"))?.storageMode, "full");
    // #3818: per-leg stores mean the blocked leg's file is genuinely
    // ENCRYPTED (full + key at write time) — read it back with the key.
    // Reset the disk cache: the keyless reads above may have cached the
    // unreadable encrypted file as a miss.
    process.env.BILI_ENCRYPTION_KEY = "00".repeat(32);
    try {
        _resetDiskCacheForTest();
        assert.equal((await buildSessionDetail("sm-blocked"))?.storageMode, "legacy", "blocked-by-encryption writes no db copy → stamps legacy");
    } finally {
        if (saved[1] === undefined) delete process.env.BILI_ENCRYPTION_KEY; else process.env.BILI_ENCRYPTION_KEY = saved[1]!;
    }
});

withSessionsDir("#3093: live (never-persisted) sessions carry the provenance stamps", async (_dir) => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    // Suite baseline pins BILI_STORAGE_UNIFIED=legacy against an empty config file.
    const live = getSession("live-stamp", { protocol: "openai" });
    assert.equal(live.metadata["storageMode"], "legacy");
    assert.equal(live.metadata["biliVersion"], VERSION);
    const d = await buildSessionDetail("live-stamp");
    assert.ok(d && d.live, "detail resolves the resident session without touching disk");
    assert.equal(d.storageMode, "legacy", "live detail shows the real mode instead of the frontend legacy fallback");
    assert.equal(d.biliVersion, VERSION);
});

withSessionsDir("buildSessionDetail flags externally-summarized blocks", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    const s = makeSession("det-ext", { protocol: "anthropic", title: "Ext" });
    const seed = (): CompressionBlock => ({
        blockId: "b",
        runId: "r1",
        tier: 1,
        topic: "Topic",
        summary: "Sum",
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 900,
        createdAt: Date.now(),
        survivedCount: 1,
        generation: "young",
        active: true,
    });
    const extBlock: CompressionBlock = { ...seed(), blockId: "b-ext", compressCallId: "external-summary-00000000-0000-0000-0000-000000000000" };
    const modelBlock: CompressionBlock = { ...seed(), blockId: "b-model", compressCallId: "toolu_01ABC" };
    s.state.blocks.push(extBlock, modelBlock);
    await store.writeNow(s);

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("det-ext");
    assert.ok(d);
    assert.equal(d.blockDetails.length, 2);
    const ext = d.blockDetails.find((b) => b.blockId === "b-ext");
    const model = d.blockDetails.find((b) => b.blockId === "b-model");
    assert.ok(ext && model, "both blocks present");
    assert.equal(ext!.external, true, "external-summary block flagged");
    assert.equal(model!.external, undefined, "model-summarized block is not flagged");
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

    const opts: ProxyOptions = {
        port: 0,
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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
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
        rmrf(root);
    }
});

test("/__bili/stats rows carry decompress usage counters (#3671 direction 4)", async () => {
    const root = path.join(tmpdir(), `bili-web-sess-dec-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    const prevSessions = process.env.BILI_SESSIONS_DIR;
    process.env.BILI_CONFIG_FILE = biliConfig;
    process.env.BILI_SESSIONS_DIR = root;

    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0,
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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    try {
        const s = getSession("dec-live", { protocol: "openai" });
        s.stats.wholeBlockRestores = 26;
        s.stats.wholeBlockRestoresPreciseAvailable = 9;
        s.stats.rangeRestores = 3;
        s.state.blocks.push({ blockId: "b1", runId: "r1", tier: 1, topic: "T", summary: "S", directMessageIds: [], effectiveMessageIds: [], directBlockIds: [], compressedTokens: 100, createdAt: Date.now(), survivedCount: 1, generation: "young", active: true });
        const res = await fetch(`http://127.0.0.1:${port}/__bili/stats`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { sessions: Array<{ id: string; wholeBlockRestores?: number; wholeBlockRestoresPreciseAvailable?: number; rangeRestores?: number; blocks?: number }> };
        const row = body.sessions.find((x) => x.id === "dec-live");
        assert.ok(row, "live session row present");
        assert.equal(row!.wholeBlockRestores, 26);
        assert.equal(row!.wholeBlockRestoresPreciseAvailable, 9);
        assert.equal(row!.rangeRestores, 3);
        assert.equal(row!.blocks, 1, "fold-count denominator rides the same row");
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        if (prevSessions === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevSessions;
        await close(proxy);
        _resetSessionsForTest();
        _resetDiskCacheForTest();
        rmrf(root);
    }
});

// #1535: the model-switch column must not break table rendering — header/colgroup/row cells/
// empty-state colspan stay aligned, and the REAL client IIFE executed against the live
// endpoints renders exactly 13 cells per session row with the switch cell populated.

interface DomEl {
    tagName: string;
    innerHTML: string;
    textContent: string;
    value: string;
    hidden: boolean;
    style: Record<string, unknown>;
    dataset: Record<string, unknown>;
    className: string;
    title: string;
    children: unknown[];
    disabled: boolean;
    classList: { add(): void; remove(): void; contains(): boolean; toggle(): void };
    addEventListener(type: string, fn: (ev?: unknown) => void): void;
    removeEventListener(): void;
    dispatch(type: string): Promise<void>;
    appendChild(child: { tagName: string; innerHTML: string }): unknown;
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

function makeDomStub(tag: string): DomEl {
    const listeners = new Map<string, Array<(ev?: unknown) => void>>();
    const el = {
        tagName: tag.toUpperCase(),
        innerHTML: "",
        textContent: "",
        value: "",
        hidden: false,
        style: {},
        dataset: {},
        className: "",
        title: "",
        children: [] as unknown[],
        disabled: false,
        classList: { add() { }, remove() { }, contains() { return false; }, toggle() { } },
        addEventListener(type: string, fn: (ev?: unknown) => void) {
            const list = listeners.get(type) ?? [];
            list.push(fn);
            listeners.set(type, list);
        },
        removeEventListener() { },
        async dispatch(type: string) {
            for (const fn of [...(listeners.get(type) ?? [])]) await fn();
        },
        appendChild(child: { tagName: string; innerHTML: string }) {
            el.children.push(child);
            const t = child.tagName.toLowerCase();
            el.innerHTML += `<${t}>${child.innerHTML}</${t}>`;
            return child;
        },
        remove() { }, focus() { }, blur() { }, select() { }, click() { el.dispatch("click"); },
        getAttribute(name: string) { return (el as unknown as Record<string, unknown>)[name] ?? null; },
        setAttribute(name: string, v: unknown) { (el as unknown as Record<string, unknown>)[name] = String(v); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        getContext() { return null; },
    };
    return el as DomEl;
}

async function runWebClient(
    base: string,
    hash: string,
    requests: string[] = [],
    fetcher: (url: string, opts?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<Map<string, DomEl>> {
    const byId = new Map<string, DomEl>();
    const idEl = (id: string) => { let e = byId.get(id); if (!e) { e = makeDomStub("div"); byId.set(id, e); } return e; };
    const documentStub = {
        hidden: false,
        body: makeDomStub("body"),
        documentElement: makeDomStub("html"),
        getElementById: (id: string) => idEl(id),
        createElement: (t: string) => makeDomStub(t),
        createDocumentFragment: () => makeDomStub("fragment"),
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
        fetch: (url: string, opts?: unknown) => {
            const target = new URL(url, base).toString();
            requests.push(target);
            return fetcher(target, opts as RequestInit | undefined);
        },
        document: documentStub,
        window: { addEventListener() { }, innerWidth: 1440, innerHeight: 900 },
        location: { hash },
        navigator: { language: "en-US" },
        localStorage: { getItem: () => null, setItem() { } },
    };
    vm.createContext(sandbox);
    vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
    return byId;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(message);
}

test("#1535: web UI stays aligned with the model-switch column", async () => {
    const root = path.join(tmpdir(), `bili-web-sess-ui-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    const prevSessions = process.env.BILI_SESSIONS_DIR;
    process.env.BILI_CONFIG_FILE = biliConfig;
    process.env.BILI_SESSIONS_DIR = root;

    const store = new SessionStore({ dir: root, debounceMs: 0, enabled: true });
    const T0 = Date.parse("2026-09-28T09:00:00Z");
    const sw = makeSession("sw-1", { protocol: "openai" }, { requests: 4, inputTokens: 12000, cachedTokens: 2000, contextTokens: 9000 });
    sw.metadata = {
        clientHint: "Codex Desktop/0.163.0-alpha.10.2 (Windows 10.0.26300; x86_64; unknown (Codex Desktop; 26.1013.31256))",
        lastModel: "model-b",
        cacheLedger: {
            v: 1, lastBlockId: null, consumedFoldSeq: 0, sampleSeq: 2, foldSeqCounter: 0, folds: [],
            lines: [
                { seq: 1, at: T0, input: 10000, cached: 9000, output: 0, hitPct: 90, missed: 1000, nc: 1000, cr: 0, tr: 0, foldSeq: 0, model: "model-a" },
                { seq: 2, at: T0 + 60_000, input: 12000, cached: 2000, output: 0, hitPct: 17, missed: 10000, nc: 2000, cr: 0, tr: 8000, foldSeq: 0, model: "model-b", sw: 1 },
            ],
            agg: { requests: 2, input: 22000, cached: 11000, output: 0, nc: 3000, cr: 0, tr: 8000, switches: 1, switchMissed: 8000 },
        },
    };
    await store.writeNow(sw);
    await store.writeNow(makeSession("plain-1", { protocol: "openai" }, { requests: 3, inputTokens: 1000, cachedTokens: 500, contextTokens: 800 }));
    _resetDiskCacheForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const opts: ProxyOptions = {
        port: 0,
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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
        // 1) data path: switch fields present only when switches actually happened
        const sesRes = await fetch(`${base}/__bili/sessions`);
        assert.equal(sesRes.status, 200);
        const ses = (await sesRes.json()) as { sessions: Array<Record<string, unknown>> };
        const swRow = ses.sessions.find((s) => s.id === "sw-1");
        assert.ok(swRow, "switching session listed");
        assert.equal(swRow!.modelSwitches, 1);
        assert.equal(swRow!.switchMissedTokens, 8000);
        const plainRow = ses.sessions.find((s) => s.id === "plain-1");
        assert.ok(plainRow, "plain session listed");
        assert.ok(!("modelSwitches" in plainRow!), "no switches => field omitted, not zero");
        assert.ok(!("switchMissedTokens" in plainRow!));

        // 2) served page: both session tables align at 13 columns (header == colgroup)
        const page = await (await fetch(`${base}/__bili/`)).text();
        for (const tbodyId of ["recent-body", "sessions-body"]) {
            const idx = page.indexOf(`id="${tbodyId}"`);
            assert.ok(idx > 0, `table ${tbodyId} present`);
            const seg = page.slice(page.lastIndexOf("<table", idx), page.indexOf("</table>", idx));
            const cols = (seg.match(/<col[\s>]/g) ?? []).length;
            const ths = (seg.match(/<th[\s>]/g) ?? []).length;
            assert.equal(ths, 13, `${tbodyId}: 13 headers`);
            assert.equal(cols, 13, `${tbodyId}: colgroup matches headers`);
        }
        assert.equal((WEB_CLIENT.match(/colspan="13"/g) ?? []).length, 2, "both empty states span all 13 columns");
        assert.ok(!WEB_CLIENT.includes('colspan="12"'), "no stale 12-column empty state left behind");

        // 3) execute the real client IIFE against the live endpoints (en locale)
        const els = await runWebClient(base, "#/sessions");
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !(els.get("sessions-body")?.innerHTML ?? "").includes("<td")) {
            await new Promise((r) => setTimeout(r, 25));
        }
        const html = els.get("sessions-body")?.innerHTML ?? "";
        const rows = html.split("</tr>").filter((r) => r.includes("<td"));
        assert.equal(rows.length, 2, `both sessions rendered, got ${rows.length}`);
        for (const r of rows) assert.equal((r.match(/<td/g) ?? []).length, 13, "row has exactly 13 cells");
        const swHtml = rows.find((r) => r.includes("sw-1"));
        assert.ok(swHtml, "switching session row rendered");
        assert.ok(swHtml!.includes('class="client-cell"'), "客户端单元格保留限宽样式入口");
        assert.match(swHtml!, /class="mono small clip w-client" title="Codex Desktop\/0\.163\.0-alpha\.10\.2 \(Windows 10\.0\.26300;/, "长客户端名称使用单行省略样式");
        assert.ok(swHtml!.includes('title="' + sw.metadata.clientHint + '"'), "悬浮提示保留完整客户端名称");
        assert.match(page, /\.w-client \{[^}]*max-width: 100%/, "客户端名称宽度不超出所在列");
        assert.match(swHtml!, /1 · 8\.0K/, "switch cell shows count · dropped tokens");
        assert.ok(swHtml!.includes('title="Mid-session model switches'), "switch cell carries the attribution tooltip");
        const plainHtml = rows.find((r) => r.includes("plain-1"));
        assert.ok(plainHtml, "plain session row rendered");
        assert.ok(!plainHtml!.includes("8.0K"), "plain session shows no switch data");
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        if (prevSessions === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevSessions;
        await close(proxy);
        _resetDiskCacheForTest();
        rmrf(root);
    }
});

// #1937: the bounded disk summary index — steady-state scans cost zero decodes,
// detail decodes exactly one file without re-scanning, and list/overview peak
// memory no longer scales with total corpus bytes (decode counters are the
// structural proof; see _diskScanStatsForTest).

function bloat(s: Session): Session {
    s.state.blocks.push({
        tier: 1, blockId: `blk-${s.id}`, summary: "x".repeat(256 * 1024), compressedTokens: 100,
        createdAt: Date.now(), active: true,
    } as unknown as CompressionBlock);
    return s;
}

withSessionsDir("#1937: warm scans decode zero files; detail decodes only its own file", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    for (let i = 0; i < 5; i++) {
        await store.writeNow(bloat(makeSession(`bulk-${i}`, { protocol: "openai" }, { requests: 2, inputTokens: 100, cachedTokens: 40, contextTokens: 50 })));
    }
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();

    const first = await buildSessionList();
    assert.equal(first.length, 5);
    const cold = _diskScanStatsForTest();
    assert.equal(cold.files, 5);
    assert.ok(cold.decodedTotal >= 5, "cold scan decodes every file");

    await buildSessionList();
    await buildOverview();
    assert.equal(_diskScanStatsForTest().decodedTotal, cold.decodedTotal, "warm list + overview re-decode nothing");

    const grown = bloat(makeSession("bulk-0", { protocol: "openai" }, { requests: 3, inputTokens: 200, cachedTokens: 80, contextTokens: 60 }));
    await store.writeNow(grown);
    await buildSessionList();
    assert.equal(_diskScanStatsForTest().decodedTotal, cold.decodedTotal + 1, "only the changed file re-decodes");

    const d0 = _diskScanStatsForTest();
    const det = await buildSessionDetail("bulk-1");
    assert.ok(det && det.id === "bulk-1" && !det.live);
    assert.equal(det.blockDetails.length, 1, "detail carries the big block");
    const afterDet = _diskScanStatsForTest();
    assert.equal(afterDet.detailDecodes, d0.detailDecodes + 1, "detail performs exactly one lazy decode");
    assert.equal(afterDet.decodedTotal, d0.decodedTotal, "…and never re-scans the directory for it");

    const live = getSession("det-live", { protocol: "openai" });
    live.stats.requests = 2;
    const d1 = _diskScanStatsForTest();
    const ld = await buildSessionDetail("det-live");
    assert.ok(ld && ld.live);
    const afterLive = _diskScanStatsForTest();
    assert.equal(afterLive.detailDecodes, d1.detailDecodes, "live detail never touches disk");
    assert.equal(afterLive.decodedTotal, d1.decodedTotal);

    const d2 = _diskScanStatsForTest();
    assert.equal(await buildSessionDetail("does-not-exist"), null);
    const afterUnknown = _diskScanStatsForTest();
    assert.equal(afterUnknown.decodedTotal, d2.decodedTotal, "unknown id decodes nothing");
    assert.equal(afterUnknown.detailDecodes, d2.detailDecodes);
});

withSessionsDir("#1937: corrupt and content-store files never block or poison the endpoints", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    await store.writeNow(makeSession("ok-1", { protocol: "openai" }, { requests: 2, inputTokens: 10, cachedTokens: 5, contextTokens: 9 }));
    const jsonFiles = readdirSync(dir, { recursive: true }) as string[];
    const okFile = jsonFiles.find((f) => f.endsWith(".json") && !f.endsWith(".content-store.json"))!;
    writeFileSync(path.join(dir, path.dirname(okFile), "junk.json"), "{not json at all", "utf8");
    writeFileSync(path.join(dir, path.dirname(okFile), "twin.content-store.json"), JSON.stringify({ version: 1, payload: { env: { blob: "x".repeat(64 * 1024) } } }), "utf8");

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const list = await buildSessionList();
    assert.deepEqual(list.map((s) => s.id), ["ok-1"], "valid session still served next to garbage");
    const st = _diskScanStatsForTest();
    assert.equal(st.files, 1);
    assert.equal(st.decodedTotal, 2, "junk + valid decoded; content-store excluded by name before any decode");
});

withSessionsDir("#1937 review: .tmp- mid-name (host label) stays indexed — kernel walkJsonFiles parity", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    await store.writeNow(makeSession("host-tmp", { protocol: "openai", upstreamOrigin: "https://api.tmp-x.example/v1" }, { requests: 2, inputTokens: 10, contextTokens: 9 }));
    const files = readdirSync(dir, { recursive: true }) as string[];
    const f = files.find((x) => x.endsWith(".json") && !x.endsWith(".content-store.json"))!;
    assert.ok(f.includes(".tmp-") && !f.startsWith(".tmp-"), "fixture name contains .tmp- mid-string only");
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const list = await buildSessionList();
    assert.deepEqual(list.map((s) => s.id), ["host-tmp"], "kernel loads this file at boot, so the index must too");
    const det = await buildSessionDetail("host-tmp");
    assert.ok(det && det.id === "host-tmp", "detail resolves the same file instead of 404ing");
});

withSessionsDir("#1937/#2180: vanished dir serves stale snapshot; explicit missing dir rejects loudly", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    await store.writeNow(makeSession("seed-1", { protocol: "openai" }, { requests: 2, inputTokens: 10, contextTokens: 9 }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    assert.equal((await buildSessionList()).length, 1);

    rmrf(dir);
    const again = await buildSessionList();
    assert.deepEqual(again.map((s) => s.id), ["seed-1"], "stale snapshot survives a vanished dir instead of emptying");

    process.env.BILI_SESSIONS_DIR = path.join(dir, "gone-subdir");
    _resetDiskCacheForTest();
    await assert.rejects(buildSessionList(), "no prior snapshot → reject (→ HTTP 500), never silent empty");
});

// #2180: pristine default layout (BILI_SESSIONS_DIR unset AND the XDG data
// root absent or holding only bili's own infra dirs — #2260(F)) must resolve
// to an EMPTY index, not the loud rejection above — withSessionsDir can't
// express that (it always sets the env var), so these drive XDG_DATA_HOME
// directly.

function withPristineEnv<T>(name: string, fn: (xdg: string) => Promise<T>): void {
    test(name, async () => {
        const root = mkdtempSync(path.join(tmpdir(), "bili-web-pristine-"));
        const xdg = path.join(root, "xdg");
        mkdirSync(xdg);
        const prevEnv = process.env.BILI_SESSIONS_DIR;
        const prevXdg = process.env.XDG_DATA_HOME;
        delete process.env.BILI_SESSIONS_DIR;
        process.env.XDG_DATA_HOME = xdg;
        try {
            await fn(xdg);
        } finally {
            if (prevEnv === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevEnv;
            if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
            _resetSessionsForTest();
            _resetDiskCacheForTest();
            rmrf(root);
        }
    });
}

withPristineEnv("#2180: fresh install (data root never created) serves empty data, not 500", async (xdg) => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    assert.deepEqual(await buildSessionList(), [], "pristine default layout resolves to an empty list");
    assert.equal((await buildOverview()).sessions, 0, "overview aggregates zero sessions instead of 500ing");
    assert.equal(await buildSessionDetail("never-existed"), null, "detail 404s instead of 500ing");

    const sessDir = path.join(xdg, "billion-context", "sessions");
    const store = new SessionStore({ dir: sessDir, debounceMs: 0, enabled: true });
    await store.writeNow(makeSession("first-1", { protocol: "openai" }, { requests: 2, inputTokens: 10, contextTokens: 9 }));
    _resetDiskCacheForTest();
    assert.deepEqual((await buildSessionList()).map((s) => s.id), ["first-1"], "first persisted session creates the dir and shows up");
});

withPristineEnv("#2180/#1937: data root holding FOREIGN content stays loud", async (xdg) => {
    mkdirSync(path.join(xdg, "billion-context"), { recursive: true });
    writeFileSync(path.join(xdg, "billion-context", "stray-file.json"), "{}");
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    await assert.rejects(buildSessionList(), "non-infra content under the data root must reject loudly (#1937)");
});

// #2260(F): the reported repro — ensureRootCA() creates <data>/ca at proxy
// start, so a fresh install's first web load found a data root WITHOUT its
// sessions subdir and 500'd until the first session was persisted.
withPristineEnv("#2260(F): fresh install after proxy start (data root holds only ca/) serves empty data, not 500", async (xdg) => {
    mkdirSync(path.join(xdg, "billion-context", "ca"), { recursive: true });
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    assert.deepEqual(await buildSessionList(), [], "ca/ alone is bili infra — pristine, empty list");
    assert.equal((await buildOverview()).sessions, 0, "overview aggregates zero sessions instead of 500ing");
});

withPristineEnv("#2180/#1937: data root deleted AFTER sessions existed serves stale snapshot, not empty", async (xdg) => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const sessDir = path.join(xdg, "billion-context", "sessions");
    const store = new SessionStore({ dir: sessDir, debounceMs: 0, enabled: true });
    await store.writeNow(makeSession("seed-1", { protocol: "openai" }, { requests: 2, inputTokens: 10, contextTokens: 9 }));
    _resetDiskCacheForTest();
    assert.deepEqual((await buildSessionList()).map((s) => s.id), ["seed-1"], "session indexed while the data root exists");
    rmrf(path.join(xdg, "billion-context"));
    assert.deepEqual(
        (await buildSessionList()).map((s) => s.id),
        ["seed-1"],
        "#1937: a vanished data root that once held sessions serves the stale index, never an empty one");
});

withSessionsDir("#1937: /__bili/sessions supports server-side paging & search", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    for (let i = 0; i < 120; i++) {
        const label = i % 2 === 0 ? `Alpha ${i}` : `Beta ${i}`;
        await store.writeNow(makeSession(`pg-${i}`, { protocol: "openai", label }, { requests: 2, inputTokens: 10, cachedTokens: 4, contextTokens: 5 }));
    }
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    setRegistryForTest({});

    const opts: ProxyOptions = {
        port: 0,
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
    const port = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
        const j = async (u: string): Promise<{ sessions: Array<Record<string, unknown>>; total?: number; page?: number; pageSize?: number }> =>
            (await (await fetch(base + u)).json()) as { sessions: Array<Record<string, unknown>>; total?: number; page?: number; pageSize?: number };

        const np = await j("/__bili/sessions");
        assert.equal(np.sessions.length, 120, "no-param request keeps the full list (back-compat)");
        assert.equal(np.total, 120, "additive total present on the legacy shape");

        const p1 = await j("/__bili/sessions?page=1&pageSize=50");
        assert.equal(p1.sessions.length, 50);
        assert.equal(p1.page, 1);
        assert.equal(p1.pageSize, 50);
        assert.equal(p1.total, 120);
        const p3 = await j("/__bili/sessions?page=3&pageSize=50");
        assert.equal(p3.sessions.length, 20, "last page is the remainder");
        const seen = new Set([...p1.sessions, ...p3.sessions].map((s) => s.id));
        assert.equal(seen.size, 70, "pages are disjoint");

        const q1 = await j("/__bili/sessions?q=alpha&pageSize=50&page=1");
        assert.equal(q1.total, 60, "search is server-side (half the corpus matches)");
        assert.equal(q1.sessions.length, 50);
        const q2 = await j("/__bili/sessions?q=alpha&pageSize=50&page=2");
        assert.equal(q2.sessions.length, 10);

        const oob = await j("/__bili/sessions?page=99&pageSize=50");
        assert.equal(oob.sessions.length, 0, "out-of-range page → empty, not an error");
        assert.equal(oob.total, 120);

        const clamped = await j("/__bili/sessions?page=1&pageSize=99999");
        assert.equal(clamped.pageSize, 200, "pageSize clamped to the server cap");
        assert.equal(clamped.sessions.length, 120);
    } finally {
        await close(proxy);
    }
});

withSessionsDir("session filters compose before paging and drive the real client controls", async (dir) => {
    _resetSessionsForTest();
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    for (let i = 0; i < 60; i++) {
        const dsh = i < 20;
        const codex = i >= 20 && i < 40;
        const meta: Session["meta"] = dsh
            ? { protocol: "openai", label: `Dsh ${i}` }
            : codex
                ? { protocol: "anthropic", label: `Codex ${i}` }
                : { label: `Legacy ${i}` };
        const session = makeSession(`filter-${i}`, meta, { requests: 2, inputTokens: 10, cachedTokens: 4, contextTokens: 5 });
        if (dsh) session.metadata = { pluginAgent: "dsh" };
        if (codex) session.metadata = { clientHint: "codex" };
        await store.writeNow(session);
    }
    _setStoreForTest(new SessionStore({ enabled: false }));
    const live = getSession("live-codex", { protocol: "anthropic", label: "Live Codex" });
    live.metadata = { clientHint: "codex" };
    live.stats.requests = 3;
    live.stats.inputTokens = 30;
    live.stats.cachedTokens = 12;
    live.stats.contextTokens = 9;
    live.lastSeen = Date.now() + 1;
    _resetDiskCacheForTest();
    setRegistryForTest({});

    const opts: ProxyOptions = {
        port: 0,
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
    const port = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
        const j = async (u: string): Promise<{
            sessions: Array<Record<string, unknown>>;
            total: number;
            unfilteredTotal: number;
            protocols: string[];
            clients: string[];
            page: number;
            pageSize: number;
        }> => (await (await fetch(base + u)).json()) as {
            sessions: Array<Record<string, unknown>>;
            total: number;
            unfilteredTotal: number;
            protocols: string[];
            clients: string[];
            page: number;
            pageSize: number;
        };

        const all = await j("/__bili/sessions?page=1&pageSize=50");
        assert.equal(all.total, 61);
        assert.equal(all.unfilteredTotal, 61);
        assert.deepEqual(all.protocols, ["anthropic", "openai", "unknown"]);
        assert.deepEqual(all.clients, ["codex", "dsh"]);
        assert.equal(all.sessions.length, 50);
        const second = await j("/__bili/sessions?page=2&pageSize=50");
        assert.equal(second.sessions.length, 11);

        const combined = await j("/__bili/sessions?protocol=OPENAI&client=DSH&state=history&q=dsh%201&page=1&pageSize=50");
        assert.equal(combined.total, 11, "all filters compose, including case-insensitive protocol/client matching");
        assert.equal(combined.unfilteredTotal, 61, "the unfiltered total stays available for the filtered-count label");
        assert.ok(combined.sessions.every((s) => String(s.id).startsWith("filter-")), "history excludes the resident live session");
        assert.ok(combined.sessions.every((s) => s.protocol === "openai" && s.clientHint === "dsh"));

        const liveOnly = await j("/__bili/sessions?client=codex&state=live&page=1&pageSize=50");
        assert.deepEqual(liveOnly.sessions.map((s) => s.id), ["live-codex"]);
        const history = await j("/__bili/sessions?state=history&page=1&pageSize=50");
        assert.equal(history.total, 60);
        const ignoredState = await j("/__bili/sessions?state=unknown&page=1&pageSize=50");
        assert.equal(ignoredState.total, 61, "unknown state is ignored rather than filtering everything out");

        const requests: string[] = [];
        const els = await runWebClient(base, "#/sessions", requests);
        await waitFor(() => els.get("ses-count")?.textContent === "61 sessions", "initial session page did not render");
        assert.equal(els.get("ses-prev")?.disabled, true);
        assert.equal(els.get("ses-next")?.disabled, false);
        assert.equal(els.get("ses-page-label")?.textContent, "Page 1 of 2");
        const protocolOptions = els.get("ses-protocol")?.children[0] as DomEl | undefined;
        const clientOptions = els.get("ses-client")?.children[0] as DomEl | undefined;
        assert.deepEqual((protocolOptions?.children ?? []).map((c) => (c as DomEl).value), ["", "anthropic", "openai", "unknown"]);
        assert.deepEqual((clientOptions?.children ?? []).map((c) => (c as DomEl).value), ["", "codex", "dsh"]);

        els.get("ses-next")!.dispatch("click");
        await waitFor(() => els.get("ses-page-label")?.textContent === "Page 2 of 2", "next-page click did not advance the list");
        assert.equal(els.get("ses-prev")?.disabled, false);
        assert.equal(els.get("ses-next")?.disabled, true);
        const page2 = new URL(requests.at(-1)!);
        assert.equal(page2.searchParams.get("page"), "2");
        assert.equal(page2.searchParams.get("pageSize"), "50");

        els.get("ses-protocol")!.value = "openai";
        els.get("ses-client")!.value = "dsh";
        els.get("ses-state")!.value = "history";
        els.get("ses-state")!.dispatch("change");
        await waitFor(() => els.get("ses-count")?.textContent === "20 / 61 sessions", "combined filter did not return to page one");
        const filteredUrl = new URL(requests.at(-1)!);
        assert.equal(filteredUrl.searchParams.get("page"), "1");
        assert.equal(filteredUrl.searchParams.get("protocol"), "openai");
        assert.equal(filteredUrl.searchParams.get("client"), "dsh");
        assert.equal(filteredUrl.searchParams.get("state"), "history");

        els.get("ses-search")!.value = "Dsh 1";
        els.get("ses-search")!.dispatch("input");
        await waitFor(() => els.get("ses-count")?.textContent === "11 / 61 sessions", "debounced search did not compose with filters");
        assert.equal(new URL(requests.at(-1)!).searchParams.get("q"), "Dsh 1");

        els.get("ses-reset-filters")!.dispatch("click");
        await waitFor(() => els.get("ses-count")?.textContent === "61 sessions", "reset did not restore the unfiltered list");
        const resetUrl = new URL(requests.at(-1)!);
        for (const key of ["q", "protocol", "client", "state"]) assert.equal(resetUrl.searchParams.has(key), false, `${key} must be cleared`);
        assert.equal(els.get("ses-search")?.value, "");
        assert.equal(els.get("ses-protocol")?.value, "");
        assert.equal(els.get("ses-client")?.value, "");
        assert.equal(els.get("ses-state")?.value, "");
    } finally {
        await close(proxy);
    }
});

test("会话列表忽略过期筛选响应，并在总页数缩减后返回有效页", async () => {
    const requests: string[] = [];
    let releaseSlow: (response: Response) => void = () => {};
    const slow = new Promise<Response>((resolve) => { releaseSlow = resolve; });
    let shrink = false;
    const pageData = (page: number, total: number) => ({
        sessions: [],
        total,
        unfilteredTotal: 61,
        protocols: ["anthropic", "openai"],
        clients: [],
        page,
        pageSize: 50,
    });
    const fetcher = async (url: string): Promise<Response> => {
        const query = new URL(url).searchParams;
        const page = Number(query.get("page") || 1);
        if (query.get("protocol") === "openai") return slow;
        if (query.get("protocol") === "anthropic") return Response.json(pageData(page, 7));
        return Response.json(pageData(page, shrink ? 1 : 61));
    };
    try {
        const els = await runWebClient("http://session-ui.test", "#/sessions", requests, fetcher);
        const protocol = els.get("ses-protocol")!;
        protocol.value = "openai";
        const staleRefresh = protocol.dispatch("change");
        protocol.value = "anthropic";
        await protocol.dispatch("change");
        assert.equal(els.get("ses-count")?.textContent, "7 / 61 sessions");
        releaseSlow(Response.json(pageData(1, 20)));
        await staleRefresh;
        assert.equal(els.get("ses-count")?.textContent, "7 / 61 sessions", "较晚返回的旧筛选响应不能覆盖当前结果");

        await els.get("ses-reset-filters")!.dispatch("click");
        await els.get("ses-next")!.dispatch("click");
        assert.equal(els.get("ses-page-label")?.textContent, "Page 2 of 2");
        shrink = true;
        await els.get("ses-refresh")!.dispatch("click");
        assert.equal(els.get("ses-page-label")?.textContent, "Page 1 of 1", "刷新后页数缩减时重新加载有效页");
        assert.deepEqual(requests.slice(-2).map((url) => new URL(url).searchParams.get("page")), ["2", "1"]);
        assert.equal(els.get("ses-prev")?.disabled, true);
        assert.equal(els.get("ses-next")?.disabled, true);
    } finally {
        releaseSlow(Response.json(pageData(1, 20)));
    }
});

test("#1937: buildSessionPage filters stubs first so hiddenEmpty keeps its meaning", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-web-sess-page-"));
    const prev = process.env.BILI_SESSIONS_DIR;
    process.env.BILI_SESSIONS_DIR = dir;
    try {
        const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
        // 60 visible sessions + 4 startup stubs (requests<=1, zero ctx/blocks/ledger).
        for (let i = 0; i < 60; i++) {
            await store.writeNow(makeSession(`vis-${i}`, { protocol: "openai", label: `V${i}` }, { requests: 2, inputTokens: 10, contextTokens: 5 }));
        }
        for (let i = 0; i < 4; i++) {
            await store.writeNow(makeSession(`stub-${i}`, { protocol: "openai" }));
        }
        _setStoreForTest(new SessionStore({ enabled: false }));
        _resetDiskCacheForTest();
        const page = await buildSessionPage({ pageSize: 25, page: 1 });
        assert.equal(page.total, 60, "stubs excluded from total");
        assert.equal(page.sessions.length, 25);
        const last = await buildSessionPage({ pageSize: 25, page: 3 });
        assert.equal(last.sessions.length, 10);
        const ids = new Set([...page.sessions, ...last.sessions].map((s) => s.id));
        for (const id of ids) assert.ok(!id.startsWith("stub-"), "stub sessions never surface in pages");
        assert.equal(hiddenEmptyCount(), 4);
    } finally {
        if (prev === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prev;
        _resetSessionsForTest();
        _resetDiskCacheForTest();
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// #2960 R2.2: unified-first web surfaces (full mode)
// ---------------------------------------------------------------------------

/** Flip the suite's legacy baseline to full for one body and restore after —
 *  _resetDiskCacheForTest() re-creates the disk-store singleton (mode is
 *  resolved at construction), so each leg sees its own engine honestly. */
function withFullMode<T>(name: string, fn: (dir: string) => Promise<T>): void {
    withSessionsDir(name, async (dir) => {
        const prev = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = "full";
        try {
            await fn(dir);
        } finally {
            if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prev;
        }
    });
}

const mkBlock = (blockId: string, compressedTokens: number, active: boolean, topic = "T"): CompressionBlock => ({
    blockId,
    runId: "r1",
    tier: 1,
    topic,
    summary: "S",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens,
    createdAt: Date.now(),
    survivedCount: 1,
    generation: "young",
    active,
});

withSessionsDir("R2.2 parity: full-mode list from the unified index matches the legacy file walk", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true }); // legacy (suite baseline)
    const s = makeSession("r22-parity", { protocol: "openai", title: "Parity Title", label: "r22-parity" }, { requests: 4, inputTokens: 1000, cachedTokens: 250, outputTokens: 80, tokensSaved: 999, contextTokens: 600 });
    s.state.blocks.push(mkBlock("b1", 1000, true, "First topic"), mkBlock("b2", 500, true), mkBlock("b3", 9999, false));
    await store.writeNow(s);
    store.closeQuietly();

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const legacyList = await buildSessionList();
    assert.equal(legacyList.length, 1, "legacy walk baseline");
    const legacyRow = legacyList[0];

    // Flip to full: the same corpus is organically imported on first open and
    // the list must come from the unified index with identical summary fields.
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const importer = new SessionStore({ dir, debounceMs: 0, enabled: true });
        // boot() is the real first-open reconciliation path (loadSync by bare id
        // cannot compose an origin-less file path — protocol/host come from opts).
        const booted = await importer.boot();
        assert.ok(booted.has("r22-parity"), "organic import on first boot");
        importer.closeQuietly();
        _resetDiskCacheForTest();
        const fullList = await buildSessionList();
        assert.equal(fullList.length, 1, "unified list row count");
        const row = fullList[0];
        // Field-for-field parity with the file-walk row (the synthetic-blocks
        // trick must reproduce count, tokensSaved floor and firstBlockHint).
        assert.equal(row.id, legacyRow.id);
        assert.equal(row.title, legacyRow.title);
        assert.equal(row.label, legacyRow.label);
        assert.equal(row.protocol, legacyRow.protocol);
        assert.equal(row.upstreamOrigin, legacyRow.upstreamOrigin);
        assert.equal(row.live, legacyRow.live);
        assert.equal(row.requests, legacyRow.requests);
        assert.equal(row.contextTokens, legacyRow.contextTokens);
        assert.equal(row.tokensSaved, legacyRow.tokensSaved, "tokensSaved: stats floor + active-block sum parity");
        assert.equal(row.inputTokens, legacyRow.inputTokens);
        assert.equal(row.cachedTokens, legacyRow.cachedTokens);
        assert.equal(row.outputTokens, legacyRow.outputTokens);
        assert.equal(row.cacheHitPct, legacyRow.cacheHitPct);
        assert.equal(row.blocks, legacyRow.blocks, "ALL-blocks count parity (active + retired)");
        assert.equal(row.firstBlockHint, legacyRow.firstBlockHint, "first block lead parity");
        assert.equal(row.lastSeen, legacyRow.lastSeen, "lastSeen = updated_at vs savedAt parity");
    } finally {
        process.env.BILI_STORAGE_UNIFIED = "legacy";
    }
});

withFullMode("R2.2 file-less rows: web list and detail survive a vanished legacy JSON", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    const s = makeSession("r22-fileless", { protocol: "openai", title: "Fileless" }, { requests: 2, inputTokens: 500, cachedTokens: 100, contextTokens: 300 });
    s.state.blocks.push(mkBlock("b1", 2500, true, "Only topic"));
    await store.writeNow(s);
    store.closeQuietly();

    // The JSON twin disappears (hand-deleted / Phase-3 future): the index row
    // alone must keep the session listed AND renderable.
    const { rmSync } = await import("node:fs");
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
        if (typeof f === "string" && f.endsWith(".json")) {
            try { rmSync(path.join(dir, f), { force: true }); } catch { /* gone */ }
        }
    }
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();

    const list = await buildSessionList();
    const row = list.find((x) => x.id === "r22-fileless");
    assert.ok(row, "index row stays listed with no legacy file");
    assert.equal(row.blocks, 1);
    assert.equal(row.tokensSaved, 2500);
    assert.equal(row.firstBlockHint, "Only topic");

    const detail = await buildSessionDetail("r22-fileless");
    assert.ok(detail, "detail renders from the unified row alone");
    assert.equal(detail.title, "Fileless");
    assert.equal(detail.blockDetails.length, 1);
    assert.equal(detail.blockDetails[0].blockId, "b1");
    assert.equal(detail.blockDetails[0].compressedTokens, 2500);
});
