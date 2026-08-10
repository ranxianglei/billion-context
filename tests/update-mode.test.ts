import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOptions, parseUpdateMode, type UpdateMode, type ProxyOptions } from "../src/config.ts";
import {
    checkLatestVersion,
    installUpdate,
    runScheduledUpdate,
    startAutoUpdate,
    stopAutoUpdate,
    getUpdateStatus,
    _resetUpdateForTest,
    type UpdateOptions,
} from "../src/update.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

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

/** Point XDG_CACHE_HOME at a fresh temp dir so update lock/throttle files never
 *  touch the developer's real cache. Restores on cleanup. */
function useTempCache(): { root: string; restore: () => void } {
    const root = path.join(tmpdir(), `bili-update-cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(root, { recursive: true });
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = root;
    return {
        root,
        restore: () => {
            if (prev === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = prev;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

function updateOpts(overrides: Partial<UpdateOptions> = {}): UpdateOptions {
    return {
        packageName: "billion-context",
        currentVersion: "0.0.1",
        mode: "auto",
        ...overrides,
    };
}

type FetchCall = { url: string; init?: RequestInit };
type StubResult = { ok: boolean; status?: number; statusText?: string; body?: unknown };
function stubFetch(
    results: Array<StubResult>,
    intercept: (url: string) => boolean = () => true,
): { calls: FetchCall[]; restore: () => void } {
    const original = globalThis.fetch;
    const calls: FetchCall[] = [];
    let index = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        // Let non-registry requests (e.g. the test's own fetch to the local Web
        // UI) go through untouched — only stub the update network egress.
        if (!intercept(url)) return original(input, init);
        calls.push({ url, init });
        const r = results[Math.min(index, results.length - 1)];
        index++;
        return new Response(r.ok ? JSON.stringify(r.body ?? {}) : String(r.body ?? "error"), {
            status: r.status ?? (r.ok ? 200 : 500),
            statusText: r.statusText ?? (r.ok ? "OK" : ""),
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
    return {
        calls,
        restore: () => { globalThis.fetch = original; },
    };
}

test("parseUpdateMode accepts only auto/check/manual", () => {
    assert.equal(parseUpdateMode("auto"), "auto");
    assert.equal(parseUpdateMode("check"), "check");
    assert.equal(parseUpdateMode("manual"), "manual");
    assert.equal(parseUpdateMode(undefined), "auto");
    assert.throws(() => parseUpdateMode("weekly"), /invalid update mode/);
});

test("legacy autoUpdate migrates: true→auto, false→manual", () => {
    // Isolate from the developer's real config file (which may set update.mode
    // via the Web UI) — config update.mode would win over the legacy env var.
    const root = path.join(tmpdir(), `bili-legacy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(root, { recursive: true });
    const file = path.join(root, "billion-context.json");
    writeFileSync(file, "{}\n", "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        const withTrue = loadOptions({ ACP_AUTO_UPDATE: "1" });
        assert.equal(withTrue.updateMode, "auto");
        const withFalse = loadOptions({ ACP_AUTO_UPDATE: "0" });
        assert.equal(withFalse.updateMode, "manual");
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prev;
        rmSync(root, { recursive: true, force: true });
    }
});

test("update mode precedence: BILI_UPDATE_MODE env > config update.mode > legacy autoUpdate", () => {
    const root = path.join(tmpdir(), `bili-update-mode-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(root, { recursive: true });
    const file = path.join(root, "billion-context.json");
    writeFileSync(file, '{"autoUpdate":false,"update":{"mode":"check"}}\n', "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        // env wins over config update.mode
        assert.equal(loadOptions({ BILI_UPDATE_MODE: "manual" }).updateMode, "manual");
        assert.equal(loadOptions({ BILI_UPDATE_MODE: "auto" }).updateMode, "auto");
        // config update.mode wins over legacy autoUpdate
        assert.equal(loadOptions({}).updateMode, "check");
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prev;
        rmSync(root, { recursive: true, force: true });
    }
});

test("manual mode: runScheduledUpdate makes no network request", async () => {
    const cache = useTempCache();
    const stub = stubFetch([{ ok: true, body: { version: "9.9.9" } }]);
    _resetUpdateForTest();
    try {
        await runScheduledUpdate(updateOpts({ mode: "manual" }));
        assert.equal(stub.calls.length, 0, "manual mode must never contact the registry");
        // startup of manual mode also schedules nothing
        startAutoUpdate(updateOpts({ mode: "manual" }));
        assert.equal(stub.calls.length, 0);
        assert.equal(getUpdateStatus().mode, "manual");
    } finally {
        stopAutoUpdate();
        stub.restore();
        cache.restore();
    }
});

test("check mode: reports but never installs", async () => {
    const cache = useTempCache();
    const stub = stubFetch([{ ok: true, body: { version: "9.9.9", dist: { tarball: "https://registry.npmjs.org/x.tgz" } } }]);
    _resetUpdateForTest();
    try {
        await runScheduledUpdate(updateOpts({ mode: "check" }), true);
        // Only the registry metadata request happened — no tarball download.
        assert.equal(stub.calls.length, 1);
        assert.match(stub.calls[0]!.url, /\/latest$/);
        const status = getUpdateStatus();
        assert.equal(status.latestVersion, "9.9.9");
        assert.equal(status.hasUpdate, true);
        assert.equal(status.installError, undefined, "check mode must never attempt install");
    } finally {
        stub.restore();
        cache.restore();
    }
});

test("auto mode: checks and attempts install (tarball download via proxy egress)", async () => {
    const cache = useTempCache();
    // First call: registry metadata (new version). Second: tarball download.
    const stub = stubFetch([
        { ok: true, body: { version: "9.9.9", dist: { tarball: "https://registry.npmjs.org/x.tgz" } } },
        { ok: false, status: 500, statusText: "Internal Server Error", body: "boom" }, // tarball fetch fails → install reports error, doesn't crash
    ]);
    _resetUpdateForTest();
    try {
        await runScheduledUpdate(updateOpts({ mode: "auto", proxyUrl: "http://127.0.0.1:9999" }), true);
        assert.equal(stub.calls.length, 2, "auto mode must fetch metadata AND attempt tarball install");
        // The tarball fetch must carry the upstream proxy dispatcher.
        assert.ok(stub.calls[1]!.init?.dispatcher, "tarball download must reuse the project ProxyAgent");
        const status = getUpdateStatus();
        assert.equal(status.installError, "tarball download failed: HTTP 500 Internal Server Error");
    } finally {
        stub.restore();
        cache.restore();
    }
});

test("manual mode explicit checkLatestVersion still works", async () => {
    const cache = useTempCache();
    const stub = stubFetch([{ ok: true, body: { version: "9.9.9" } }]);
    _resetUpdateForTest();
    try {
        const result = await checkLatestVersion(updateOpts({ mode: "manual" }));
        assert.equal(result?.latestVersion, "9.9.9");
        assert.equal(result?.hasUpdate, true);
    } finally {
        stub.restore();
        cache.restore();
    }
});

test("concurrent update lock prevents a second installer", async () => {
    const cache = useTempCache();
    _resetUpdateForTest();
    // Pre-create a lock file held by a LIVE process (ourselves) so the lock is
    // not stale — the second installer must back off.
    const lockDir = path.join(cache.root, "billion-context");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, ".update-lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf8");
    const stub = stubFetch([{ ok: true, body: { version: "9.9.9", dist: { tarball: "https://registry.npmjs.org/x.tgz" } } }]);
    try {
        const result = await installUpdate(updateOpts({ mode: "auto" }));
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /another process is updating/);
    } finally {
        stub.restore();
        cache.restore();
    }
});

test("Web UI: update status/check/install endpoints and three-state config", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const cache = useTempCache();
    const root = path.join(tmpdir(), `bili-update-web-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"update":{"mode":"manual"}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    // Only registry.npmjs.org is stubbed — the test's own fetches to the local
    // Web UI must pass through to the real server. Call order for registry
    // traffic: check-endpoint metadata, install-endpoint metadata, then the
    // tarball download (which fails → install reports an error, no crash).
    const metadata = { version: "9.9.9", dist: { tarball: "https://registry.npmjs.org/x.tgz" } };
    const stub = stubFetch(
        [{ ok: true, body: metadata }, { ok: true, body: metadata }, { ok: false, status: 500, statusText: "Internal Server Error", body: "boom" }],
        (url) => url.startsWith("https://registry.npmjs.org"),
    );
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 200_000,
        kernelConfig: (await import("acp-kernel")).defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        updateMode: "manual",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        // Three-state radios live in the settings page.
        const ui = await (await fetch(`${base}/__bili/`)).text();
        assert.match(ui, /主动压缩间隔/);
        assert.match(ui, /软件更新/);
        assert.match(ui, /name="update-mode"/);
        assert.match(ui, /value="check"/);
        assert.match(ui, /data-nudge="200000"/);

        // Status endpoint reflects mode + no background check in manual mode.
        const status = await (await fetch(`${base}/__bili/update/status`)).json() as { mode: string; currentVersion: string };
        assert.equal(status.mode, "manual");

        // Explicit check works in manual mode (user-triggered only).
        const checked = await (await fetch(`${base}/__bili/update/check`, { method: "POST" })).json() as { hasUpdate: boolean; latestVersion: string };
        assert.equal(checked.hasUpdate, true);
        assert.equal(checked.latestVersion, "9.9.9");

        // Install endpoint returns an error report (tarball download fails here).
        const install = await (await fetch(`${base}/__bili/update/install`, { method: "POST" })).json() as { ok: boolean; error: string };
        assert.equal(install.ok, false);
        assert.match(install.error ?? "", /tarball download failed/);

        // PUT updateMode switches the stored three-state config.
        const put = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ updateMode: "check" }),
        });
        assert.equal(put.status, 200);
        assert.equal(opts.updateMode, "check", "updateMode hot-reloaded onto opts");
        const readback = JSON.parse(readFileSync(biliConfig, "utf8"));
        assert.equal(readback.update.mode, "check");
    } finally {
        await close(proxy);
        stub.restore();
        cache.restore();
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        rmSync(root, { recursive: true, force: true });
    }
});

test("getUpdateStatus defaults when never started", () => {
    _resetUpdateForTest();
    const status = getUpdateStatus();
    assert.equal(status.mode, "manual");
    assert.equal(status.currentVersion, "dev");
    assert.equal(status.hasUpdate, undefined);
});
