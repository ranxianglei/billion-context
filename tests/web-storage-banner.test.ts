// #3040 web surface: SQLite unified storage degrades to legacy-only through
// several fail-open paths (#2825 contract): engine ladder exhausted,
// self-download blocked in cooldown, 3-strike sidecar disable. (A corrupt
// index.db is NO LONGER one of them since #3959: it self-heals by quarantine
// instead of pinning the machine legacy-only forever.) The proxy keeps
// running on JSON — correct — but until now
// the condition was only visible as one-time log lines, so environments that
// cannot run SQLite were never learned about before the upcoming full-mode
// default flip. These tests pin the wire contract the web banner reads:
//   1. PARITY (#2152 lesson): /__bili/status and /__bili/overview share one
//      storageStatusWire() payload — byte-identical on both surfaces.
//   2. degraded=true iff a unified mode was requested AND not intentionally
//      opted out (BILI_ENCRYPTION_KEY) AND the sidecar carries no data;
//      explicit legacy or a healthy sidecar → false (banner stays hidden).
//   3. the generic diagnostics endpoint (/__bili/diagnostics?topic=…) serves
//      a copyable blob + a prefilled GitHub issues/new URL whose body decodes
//      back to the exact blob — the reusable "copy error → file issue"
//      facility ("以后错误都这样"); unknown topics fall back to the base blob.
//   4. the page ships the banner element and the client references it plus
//      the localized copy keys and the diagnostics endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { probeBuiltinSqlite, probeHostBetterSqlite3, setPreferredSqliteEngineForTests, setSqliteEnginesUnavailableForTests } from "../src/storage/driver.ts";
import { _resetStorageRuntimeStatusForTest, recordEngineBootstrap } from "../src/storage/runtime-status.ts";
import { renderPage } from "../src/web/page.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { VERSION } from "../src/version.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";

const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME", "BILI_STORAGE_UNIFIED", "BILI_ENCRYPTION_KEY"] as const;
type EnvSnap = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function saveEnv(): EnvSnap {
    const snap: EnvSnap = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    return snap;
}

function restoreEnv(snap: EnvSnap): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

/** Point every bili path at the temp base: sessions dir (existing), an ABSENT
 *  config file (no file-tier knob values), cache + state roots (bootstrap
 *  failure marker, log tail) — nothing outside this test can leak into the
 *  status or the diagnostics blob. */
function isolate(base: string): void {
    mkdirSync(path.join(base, "sessions"), { recursive: true });
    process.env.BILI_SESSIONS_DIR = path.join(base, "sessions");
    process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
    process.env.XDG_CACHE_HOME = path.join(base, "cache");
    process.env.XDG_STATE_HOME = path.join(base, "state");
}

function resetSeams(): void {
    setSqliteEnginesUnavailableForTests(false);
    setPreferredSqliteEngineForTests(null);
    _resetStorageRuntimeStatusForTest();
}

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

interface StorageWire {
    requested: string;
    effective: string;
    degraded: boolean;
    intentionalOptOut: boolean;
    reason: string | null;
    engine: { name: string; source: string } | null;
    bootstrap: string | null;
    bootstrapFailure: unknown;
    cooldownRemainingMs: number | null;
    sidecarDisabled: boolean;
}

interface DiagnosticsWire {
    blob: string;
    title: string;
    url: string;
}

async function fetchJson<T>(port: number, p: string): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    assert.equal(res.status, 200, `${p} answers 200`);
    return (await res.json()) as T;
}

function makeOpts(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
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
    };
}

test("#3040 forced none-engine: status+overview report degraded; diagnostics blob + prefilled issue link", async () => {
    const snap = saveEnv();
    const base = mkdtempSync(path.join(tmpdir(), "bili-storage-banner-"));
    // Hoisted so the finally can release the sidecar's SQLite handle via
    // closeQuietly() before rmrf — Windows can't delete a dir while index.db is open.
    let store: SessionStore | null = null;
    try {
        isolate(base);
        resetSeams();
        delete process.env.BILI_STORAGE_UNIFIED;
        delete process.env.BILI_ENCRYPTION_KEY;
        setSqliteEnginesUnavailableForTests(true);
        recordEngineBootstrap({ status: "failed", detail: "ECONNREFUSED registry.npmjs.org" });
        store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        _setStoreForTest(store);
        const upstreamPort = await freePort();
        const proxy = await startServer(makeOpts(upstreamPort));
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        try {
            const s = await fetchJson<{ storage: StorageWire }>(port, "/__bili/status");
            const o = await fetchJson<{ storage: StorageWire }>(port, "/__bili/overview");
            assert.equal(o.storage.requested, "full", "default requested mode is full (#3818 flip)");
            assert.equal(o.storage.effective, "legacy");
            assert.equal(o.storage.degraded, true);
            assert.equal(o.storage.intentionalOptOut, false);
            assert.ok(typeof o.storage.reason === "string" && o.storage.reason.length > 0, "degrade reason present");
            assert.match(o.storage.reason ?? "", /no SQLite engine available/);
            assert.equal(o.storage.engine, null);
            assert.equal(o.storage.sidecarDisabled, false);
            assert.deepEqual(o.storage, s.storage, "status/overview storage parity (one shared helper)");

            const d = await fetchJson<DiagnosticsWire>(port, "/__bili/diagnostics?topic=storage-legacy-only");
            assert.ok(d.blob.includes(`bili version: ${VERSION}`), "blob carries the bili version");
            assert.ok(d.blob.includes(`node: ${process.version}`), "blob carries the node version");
            assert.ok(d.blob.includes(`platform: ${process.platform} ${process.arch}`), "blob carries platform/arch");
            assert.ok(d.blob.includes("os: "), "blob carries the OS line");
            assert.ok(d.blob.includes("requested mode: full"));
            assert.ok(d.blob.includes("effective mode: legacy"));
            assert.ok(d.blob.includes("degrade reason:"), "blob carries the degrade reason");
            assert.ok(d.blob.includes("engine bootstrap: failed"), "blob carries the ladder outcome");
            assert.ok(d.blob.includes("BILI_STORAGE_UNIFIED: (unset)"), "blob carries the raw knob values");
            assert.ok(d.blob.includes("sessions on disk:"), "blob carries the session count");
            assert.ok(d.title.startsWith("SQLite unified storage degraded to legacy-only"), "title names the condition");
            assert.ok(d.title.includes(`${process.platform}-${process.arch}`), "title carries the environment");
            assert.ok(d.url.startsWith("https://github.com/ranxianglei/billion-context/issues/new?title="), "url targets issues/new");
            const u = new URL(d.url);
            assert.equal(u.searchParams.get("body"), d.blob, "issue body decodes back to the exact blob");
            assert.ok((u.searchParams.get("title") ?? "").includes(VERSION), "issue title encodes the same environment facts");

            const d2 = await fetchJson<DiagnosticsWire>(port, "/__bili/diagnostics?topic=some-future-topic");
            assert.ok(d2.blob.includes("some-future-topic (no topic-specific section registered)"), "unknown topics degrade to the base blob");
            assert.equal(new URL(d2.url).searchParams.get("body"), d2.blob, "generic facility encodes any topic's blob");

            const html = renderPage(`http://127.0.0.1:${port}`, VERSION);
            assert.ok(html.includes('id="storage-degraded-banner"'), "page carries the banner div");
            assert.ok(WEB_CLIENT.includes('"storage-degraded-banner"'), "client targets the banner element");
            assert.ok(WEB_CLIENT.includes('t("sys.storage_degraded_title")'), "client uses the localized title");
            assert.ok(WEB_CLIENT.includes('t("sys.storage_degraded"'), "client composes the localized sentence with {reason}");
            assert.ok(WEB_CLIENT.includes('t("sys.report_copy")'), "client offers the copy button");
            assert.ok(WEB_CLIENT.includes('t("sys.report_issue")'), "client offers the GitHub button");
            assert.ok(WEB_CLIENT.includes('API_ROOT + "/diagnostics?topic="'), "buttons wire to the generic diagnostics endpoint (through the #3373 API root)");
            // the overview poll re-renders the banner every 5s while degraded: the
            // diagnostics fetch must be cached per topic, and a failed fetch must
            // toast once — otherwise every poll re-hits the endpoint (full blob
            // rebuild: listSessions + whole-file log reads) and re-toasts.
            assert.ok(WEB_CLIENT.includes("diagCache"), "diagnostics fetch is cached per topic (5s re-render must not re-fetch)");
            assert.ok(WEB_CLIENT.includes("diagToastedOnce"), "a failed diagnostics fetch toasts once, not on every poll");
            // the reason is error-derived text flowing into innerHTML → must be escaped
            const escRe = /escapeHtml\(t\("sys\.storage_degraded", \{ reason: sg\.reason \|\| "" \}\)\)/;
            assert.ok(escRe.test(WEB_CLIENT), "degrade reason is HTML-escaped before innerHTML");
        } finally {
            await close(proxy);
        }
    } finally {
        resetSeams();
        store?.closeQuietly();
        rmrf(base);
        restoreEnv(snap);
    }
});

test("#3040 healthy sidecar and explicit legacy: no degraded flag (banner stays hidden)", { skip: !(probeBuiltinSqlite() || probeHostBetterSqlite3()) && "no SQLite engine available on this host" }, async () => {
    const snap = saveEnv();
    const base = mkdtempSync(path.join(tmpdir(), "bili-storage-banner-"));
    let store: SessionStore | null = null;
    let legacyStore: SessionStore | null = null;
    try {
        isolate(base);
        resetSeams();
        delete process.env.BILI_STORAGE_UNIFIED;
        delete process.env.BILI_ENCRYPTION_KEY;
        store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        _setStoreForTest(store);
        const upstreamPort = await freePort();
        const proxy = await startServer(makeOpts(upstreamPort));
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        try {
            // healthy default full (#3818 flip): sidecar opened, nothing to warn about
            let o = await fetchJson<{ storage: StorageWire }>(port, "/__bili/overview");
            assert.equal(o.storage.requested, "full");
            assert.equal(o.storage.effective, "full");
            assert.equal(o.storage.degraded, false, "healthy full does not warn");
            assert.equal(o.storage.intentionalOptOut, false);
            assert.equal(o.storage.reason, null);
            assert.ok(o.storage.engine && o.storage.engine.name.length > 0 && o.storage.engine.source.length > 0, "engine reported when the sidecar is live");

            // explicit opt-out to legacy: requested === effective by choice
            resetSeams();
            process.env.BILI_STORAGE_UNIFIED = "0";
            const legacyDir = path.join(base, "sessions-legacy");
            mkdirSync(legacyDir, { recursive: true });
            legacyStore = new SessionStore({ dir: legacyDir, enabled: false });
            _setStoreForTest(legacyStore);
            o = await fetchJson<{ storage: StorageWire }>(port, "/__bili/overview");
            assert.equal(o.storage.requested, "legacy");
            assert.equal(o.storage.effective, "legacy");
            assert.equal(o.storage.degraded, false, "explicit legacy never warns");
            assert.equal(o.storage.engine, null);
        } finally {
            await close(proxy);
        }
    } finally {
        resetSeams();
        store?.closeQuietly();
        legacyStore?.closeQuietly();
        rmrf(base);
        restoreEnv(snap);
    }
});

test("#3040 BILI_ENCRYPTION_KEY opt-out is intentional: reported, never warned", async () => {
    const snap = saveEnv();
    const base = mkdtempSync(path.join(tmpdir(), "bili-storage-banner-"));
    let store: SessionStore | null = null;
    try {
        isolate(base);
        resetSeams();
        process.env.BILI_STORAGE_UNIFIED = "1";
        process.env.BILI_ENCRYPTION_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
        store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        _setStoreForTest(store);
        const upstreamPort = await freePort();
        const proxy = await startServer(makeOpts(upstreamPort));
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        try {
            const o = await fetchJson<{ storage: StorageWire }>(port, "/__bili/overview");
            assert.equal(o.storage.requested, "shadow");
            assert.equal(o.storage.effective, "legacy");
            assert.equal(o.storage.intentionalOptOut, true, "encryption block is reported as intentional");
            assert.equal(o.storage.degraded, false, "intentional opt-out must NOT raise the warning");
            assert.equal(o.storage.reason, null);
        } finally {
            await close(proxy);
        }
    } finally {
        resetSeams();
        store?.closeQuietly();
        rmrf(base);
        restoreEnv(snap);
    }
});

test("#3040 corrupt index.db (guard #2771): self-heals by quarantine — no permanent legacy pin, no banner (#3959)", { skip: !(probeBuiltinSqlite() || probeHostBetterSqlite3()) && "no SQLite engine available on this host" }, async () => {
    const snap = saveEnv();
    const base = mkdtempSync(path.join(tmpdir(), "bili-storage-banner-"));
    let store: SessionStore | null = null;
    try {
        isolate(base);
        resetSeams();
        delete process.env.BILI_STORAGE_UNIFIED;
        delete process.env.BILI_ENCRYPTION_KEY;
        const dir = process.env.BILI_SESSIONS_DIR!;
        const corruptBytes = Buffer.from("this is definitely not a sqlite database file".repeat(8));
        writeFileSync(path.join(dir, "index.db"), corruptBytes);
        store = new SessionStore({ dir, enabled: true });
        _setStoreForTest(store);
        const upstreamPort = await freePort();
        const proxy = await startServer(makeOpts(upstreamPort));
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        try {
            const o = await fetchJson<{ storage: StorageWire }>(port, "/__bili/overview");
            assert.equal(o.storage.requested, "full");
            assert.equal(o.storage.effective, "full", "self-heal recovers full mode instead of pinning legacy-only (#3959)");
            assert.equal(o.storage.degraded, false, "quarantine + fresh open must NOT raise the warning");
            assert.equal(o.storage.intentionalOptOut, false);
            assert.equal(o.storage.reason, null);
            assert.ok(o.storage.engine, "the fresh index reports a live engine");
            // Forensics contract: the dead file is renamed aside, never deleted.
            const quarantined = readdirSync(dir).filter((n) => n.startsWith("index.db.corrupt-"));
            assert.equal(quarantined.length, 1, "exactly one quarantine copy beside the fresh index");
            assert.deepEqual(readFileSync(path.join(dir, quarantined[0])), corruptBytes, "quarantine preserves the exact corrupt bytes");
        } finally {
            await close(proxy);
        }
    } finally {
        resetSeams();
        store?.closeQuietly();
        rmrf(base);
        restoreEnv(snap);
    }
});

// #3235: the compression-conflict banner rides the same generic #3040 facility
// ("以后错误都这样") — the conflict-banner topic must serve the ledger summary
// in the copyable blob with a prefilled GitHub issues/new URL, so a user hit by
// the banner can report the exact evidence in two clicks without pasting logs.
test("#3235 conflict-banner diagnostics topic serves the ledger summary + prefilled issue URL", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "web-conflict-topic-"));
    const snap = saveEnv();
    let proxy: http.Server | undefined;
    try {
        isolate(base);
        const upstreamPort = await freePort();
        proxy = await startServer(makeOpts(upstreamPort));
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;

        const d = await fetchJson<DiagnosticsWire>(port, "/__bili/diagnostics?topic=conflict-banner");
        assert.ok(d.title.startsWith("Compression conflict banner"), "title names the topic");
        assert.ok(d.blob.includes("--- compression conflict ledger ---"), "blob carries the ledger section");
        assert.ok(d.blob.includes("banner policy (#3235)"), "blob documents the alarm rule for reporters");
        assert.ok(d.url.startsWith("https://github.com/ranxianglei/billion-context/issues/new?title="), "url targets issues/new");
        const u = new URL(d.url);
        assert.equal(u.searchParams.get("body"), d.blob, "issue body decodes back to the exact blob");
        assert.ok((u.searchParams.get("title") ?? "").includes(VERSION), "issue title encodes the version");
    } finally {
        if (proxy) await close(proxy);
        restoreEnv(snap);
        rmrf(base);
    }
});
