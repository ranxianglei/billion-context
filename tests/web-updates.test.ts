import { after } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";

// Import-time constants in src/update.ts (THROTTLE_FILE & friends) bind
// cacheDir() at MODULE LOAD — point the cache + config file at a test tmp dir
// BEFORE any bili module is imported (precedent: tests/affinity-crosswire-fold.test.ts).
const root = path.join(tmpdir(), `bili-web-updates-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
const prevCache = process.env.XDG_CACHE_HOME;
const prevConfig = process.env.BILI_CONFIG_FILE;
process.env.XDG_CACHE_HOME = path.join(root, "cache");
const biliConfig = path.join(root, "billion-context.json");
writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
process.env.BILI_CONFIG_FILE = biliConfig;
after(() => {
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prevCache;
    if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
});

// #3719 phase 2: web 更新/Updates tab actions. Nothing in here fakes a registry
// SUCCESS path — every updater invocation below lands on a deterministic local
// guard (unwired process, bad input, or the source-checkout refusal) so the
// tests make zero network calls. The panel's own buttons live behind the same
// DNS-rebinding gate as every other /__bili/ route; that is asserted against a
// real startServer below.
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { VERSION } = await import("../src/version.ts");
const { _setReleaseNotesStateForTest, _resetReleaseNotesWatcherForTest } = await import("../src/update-notes.ts");
const ua = await import("../src/server/update-actions.ts");
const { rmrf } = await import("./tmp-rm.ts");

/** Fresh fixture "install" — a plain dir whose package.json pins a version
 *  strictly newer than this checkout, so pendingRestart flips deterministically. */
function makeFixture(version: string): string {
    const dir = path.join(root, `fixture-${version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "billion-context", version }, null, 2)}\n`, "utf8");
    return dir;
}

test("unwired process: every action degrades to a plain error string, never throws (#3719)", async () => {
    ua._resetUpdateActionsForTest();
    assert.equal(ua.updateActionsAvailable(), false);
    const c = await ua.triggerManualCheck();
    assert.deepEqual(c, { ok: false, error: "self-update not wired in this process" });
    // Availability is checked before input validation — same string either way.
    const i = await ua.installVersionAction("0.9.999");
    assert.deepEqual(i, { ok: false, error: "self-update not wired in this process" });
    const s = await ua.updateStateSnapshot(VERSION);
    assert.equal(s.running, VERSION);
    assert.equal(s.checking, false);
    assert.equal(s.installing, false);
});

test("installVersionAction rejects non-semver shapes before touching the updater (#3719)", async () => {
    const fixture = makeFixture("0.9.400");
    try {
        ua._resetUpdateActionsForTest();
        ua.registerUpdateActions({ packageName: "billion-context", currentVersion: VERSION, autoUpdate: false, installDir: fixture });
        assert.equal(ua.updateActionsAvailable(), true);
        const shell = await ua.installVersionAction("1.0.0; rm -rf /");
        assert.equal(shell.ok, false);
        assert.match(shell.error ?? "", /version shape rejected/);
        const empty = await ua.installVersionAction("");
        assert.equal(empty.ok, false);
        assert.match(empty.error ?? "", /version shape rejected/);
    } finally {
        ua._resetUpdateActionsForTest();
    }
});

test("updateStateSnapshot maps span notices + on-disk view, no registry access (#3719)", async () => {
    const fixture = makeFixture("0.9.400");
    try {
        ua._resetUpdateActionsForTest();
        _resetReleaseNotesWatcherForTest();
        _setReleaseNotesStateForTest({
            entries: [
                { version: "0.1.500", tier: "critical", summary: "fix crash", date: "2026-10-21" },
                { version: "0.2.0", tier: "routine", summary: "misc" },
            ],
            diskVersion: "0.9.400",
        });
        ua.registerUpdateActions({ packageName: "billion-context", currentVersion: VERSION, autoUpdate: false, installDir: fixture });
        const snap = await ua.updateStateSnapshot(VERSION);
        assert.equal(snap.running, VERSION);
        // Disk read from the fixture package.json wins over the watcher view.
        assert.equal(snap.disk, "0.9.400");
        assert.equal(snap.pendingRestart, true, "disk strictly newer than running → restart pending");
        assert.equal(snap.critical, true);
        assert.equal(snap.notices.length, 2, "span stays oldest→newest");
        assert.deepEqual(snap.notices[0], { version: "0.1.500", tier: "critical", summary: "fix crash", date: "2026-10-21" });
        assert.deepEqual(snap.notices[1], { version: "0.2.0", tier: "routine", summary: "misc" });
        // Fresh cache dir ⇒ no throttle marker yet ⇒ field omitted entirely
        // (JSON drops it) instead of carrying null.
        assert.ok(!("lastCheckAt" in snap), "no last-check marker written yet → field absent");
        assert.equal(snap.checking, false);
        assert.equal(snap.installing, false);
    } finally {
        ua._resetUpdateActionsForTest();
        _resetReleaseNotesWatcherForTest();
    }
});

test("concurrent checks and installs each collapse to one in-flight run (#3719)", async () => {
    // installDir = THIS checkout: a git working tree. The forced check writes
    // its throttle marker and then hits the source-checkout guard (#580) — a
    // deterministic early return BEFORE any registry fetch, so eight stacked
    // checks still make zero network calls. Install takes the same guard in
    // forceInstallVersion after its local reads.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    try {
        ua._resetUpdateActionsForTest();
        ua.registerUpdateActions({ packageName: "billion-context", currentVersion: VERSION, autoUpdate: false, installDir: repoRoot });
        const checks = await Promise.all(Array.from({ length: 8 }, () => ua.triggerManualCheck()));
        assert.ok(checks.every((r) => r.ok), `every caller must see a clean run or an already-flag, got ${JSON.stringify(checks)}`);
        assert.equal(checks.filter((r) => r.already).length, 7, "seven of eight concurrent callers must hit the dedupe branch");
        const installs = await Promise.all([ua.installVersionAction("9.9.9"), ua.installVersionAction("9.9.9")]);
        assert.equal(installs[0].ok, false);
        assert.match(installs[0].error ?? "", /source checkout/, "first run reaches the updater's git-tree refusal, not the network");
        assert.deepEqual(installs[1], { ok: true, already: true }, "second concurrent install must not stack");
    } finally {
        ua._resetUpdateActionsForTest();
    }
});

test("admin routes: state surfaces notices; install enforces charset/auth gates (#3719)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    ua._resetUpdateActionsForTest(); // unwired process: actions answer the plain string
    _resetReleaseNotesWatcherForTest();
    _setReleaseNotesStateForTest({
        entries: [{ version: "0.1.500", tier: "critical", summary: "security fix", date: "2026-10-21" }],
        diskVersion: "0.9.400",
    });
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
    if (!proxy.listening) await new Promise<void>((resolve) => proxy.once("listening", () => resolve()));
    const port = (proxy.address() as { port: number }).port;
    const trustedHost = `127.0.0.1:${port}`;
    const spoofedHeaders: Record<string, string> = { host: `evil.com:${port}`, origin: `http://evil.com:${port}` };
    function call(
        method: "GET" | "POST",
        urlPath: string,
        headers: Record<string, string>,
        body?: string,
    ): Promise<{ status: number; json: unknown }> {
        const { promise, resolve, reject } = Promise.withResolvers<{ status: number; json: unknown }>();
        const req = http.request(
            { host: "127.0.0.1", port, path: urlPath, method, headers },
            (res) => {
                let raw = "";
                res.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
                res.on("end", () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }));
            },
        );
        req.once("error", reject);
        req.end(body);
        return promise;
    }
    try {
        // Read path: pushed notices flow straight into the state endpoint.
        const state = await call("GET", "/__bili/update/state", { host: trustedHost });
        assert.equal(state.status, 200);
        const st = state.json as {
            running?: string; pendingRestart?: boolean; critical?: boolean;
            notices?: Array<{ version: string; tier: string; summary: string; date?: string }>;
        };
        assert.equal(st.running, VERSION);
        assert.equal(st.pendingRestart, true);
        assert.equal(st.critical, true);
        assert.deepEqual(st.notices, [{ version: "0.1.500", tier: "critical", summary: "security fix", date: "2026-10-21" }]);
        // Same DNS-rebinding defense as every other /__bili/ route.
        const stateSpoofed = await call("GET", "/__bili/update/state", spoofedHeaders);
        assert.equal(stateSpoofed.status, 403, "rebound attacker domain must be rejected on the state route too");
        // Write path: shell-metacharacter versions die at the door with 400 —
        // the panel only ever sees plain semver characters past this line.
        const shell = await call("POST", "/__bili/update/install", { host: trustedHost, "content-type": "application/json" }, JSON.stringify({ version: "1.0.0; rm -rf /" }));
        assert.equal(shell.status, 400);
        assert.match(JSON.stringify(shell.json), /plain semver characters/);
        // Malformed JSON mirrors the other POSTs' 400 shape.
        const malformed = await call("POST", "/__bili/update/install", { host: trustedHost, "content-type": "application/json" }, "{nope");
        assert.equal(malformed.status, 400);
        assert.match(JSON.stringify(malformed.json), /expected JSON body/);
        // Unwired execution answers 200 with the plain string (panel shows it).
        const unwiredInstall = await call("POST", "/__bili/update/install", { host: trustedHost, "content-type": "application/json" }, JSON.stringify({ version: "0.1.203" }));
        assert.equal(unwiredInstall.status, 200);
        assert.deepEqual(unwiredInstall.json, { ok: false, error: "self-update not wired in this process" });
        const unwiredCheck = await call("POST", "/__bili/update/check", { host: trustedHost, "content-type": "application/json" }, "{}");
        assert.equal(unwiredCheck.status, 200);
        assert.deepEqual(unwiredCheck.json, { ok: false, error: "self-update not wired in this process" });
        // The gate precedes validation: spoofed Origin → 403 even with a valid body.
        const spoofedPost = await call("POST", "/__bili/update/install", { ...spoofedHeaders, "content-type": "application/json" }, JSON.stringify({ version: "0.1.203" }));
        assert.equal(spoofedPost.status, 403, "gate must fire before body parsing");
    } finally {
        proxy.closeAllConnections?.();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        _resetReleaseNotesWatcherForTest();
        try { rmrf(root); } catch { /* best-effort */ }
    }
});
