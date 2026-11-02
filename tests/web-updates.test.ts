import { after } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
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
// #4791: point the remote update policy at the in-process mock registry so the
// check-only tests' policy fetch is a deterministic local 404 (fail-open), not
// a real network call.
const prevPolicyUrl = process.env.BILI_UPDATE_POLICY_URL;
process.env.BILI_UPDATE_POLICY_URL = "https://registry.test/policy.json";
after(() => {
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prevCache;
    if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
    if (prevPolicyUrl === undefined) delete process.env.BILI_UPDATE_POLICY_URL; else process.env.BILI_UPDATE_POLICY_URL = prevPolicyUrl;
});

// #3719 phase 2: web 更新/Updates tab actions. The guard tests land every
// updater invocation on a deterministic local guard (unwired process, bad
// input, or the source-checkout refusal); the #4791 check-only section swaps
// globalThis.fetch for an in-process mock registry (restored per test). Either
// way these tests make zero real network calls. The panel's own buttons live
// behind the same DNS-rebinding gate as every other /__bili/ route; that is
// asserted against a real startServer below.
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { VERSION } = await import("../src/version.ts");
const { _setReleaseNotesStateForTest, _resetReleaseNotesWatcherForTest } = await import("../src/update-notes.ts");
const ua = await import("../src/server/update-actions.ts");
const { forceInstallVersion, getLastInstall, readDiskVersion, lastUpdateCheckTime, _resetLastInstallForTest } = await import("../src/update.ts");
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

// ---- #4791: "Check now" is check-only — full gate ladder, zero installs ----
// The mock registry is an in-process Map behind a swapped globalThis.fetch
// (restored per test); the policy URL answers a deterministic local 404
// (fail-open), so even these success-path tests make zero real network calls.

interface RegistryStubState {
    latest?: string;
    tarballs: Map<string, Buffer>;
    hits: Record<string, number>;
}

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

/** A real npm-layout tarball (package/ prefix) for one version — enough
 *  structure to pass verifyEntries' declared-main check on the install path. */
function makeNpmTgz(version: string): Buffer {
    const srcRoot = path.join(root, `pkg-src-${version}`);
    const pkgDir = path.join(srcRoot, "package");
    mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js" }, null, 2)}\n`, "utf8");
    writeFileSync(path.join(pkgDir, "dist", "index.js"), `export const loaded = '${version}';\n`, "utf8");
    const tgzPath = path.join(srcRoot, `bc-${version}.tgz`);
    tar.c({ cwd: srcRoot, file: tgzPath, gzip: true, sync: true }, ["package"]);
    return readFileSync(tgzPath);
}

function stubRegistryFetch(state: RegistryStubState): () => void {
    const prev = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
        const u = String(input);
        if (u.endsWith("/policy.json")) {
            return Promise.resolve(new Response(JSON.stringify({ error: "no remote policy in this test" }), { status: 404, headers: { "content-type": "application/json" } }));
        }
        if (u.endsWith("/billion-context/latest")) {
            state.hits.latest = (state.hits.latest ?? 0) + 1;
            if (!state.latest) {
                return Promise.resolve(new Response(JSON.stringify({ name: "billion-context" }), { status: 200, headers: { "content-type": "application/json" } }));
            }
            const tgz = state.tarballs.get(state.latest);
            return Promise.resolve(new Response(JSON.stringify({
                name: "billion-context",
                version: state.latest,
                dist: { tarball: `https://registry.test/bc-${state.latest}.tgz`, ...(tgz !== undefined ? { integrity: integrityField(tgz) } : {}) },
            }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        const tgzMatch = u.match(/\/bc-(.+)\.tgz$/);
        if (tgzMatch) {
            const key = `tarball:${tgzMatch[1]}`;
            state.hits[key] = (state.hits[key] ?? 0) + 1;
            const buf = state.tarballs.get(tgzMatch[1]);
            if (buf === undefined) return Promise.resolve(new Response("unknown tarball", { status: 404 }));
            return Promise.resolve(new Response(buf));
        }
        const verMatch = u.match(/\/billion-context\/(\d[\d.]*)$/);
        const verTgz = verMatch ? state.tarballs.get(verMatch[1]) : undefined;
        if (verTgz !== undefined) {
            const key = `doc:${verMatch![1]}`;
            state.hits[key] = (state.hits[key] ?? 0) + 1;
            return Promise.resolve(new Response(JSON.stringify({
                name: "billion-context",
                version: verMatch![1],
                dist: { tarball: `https://registry.test/bc-${verMatch![1]}.tgz`, integrity: integrityField(verTgz) },
            }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${u}`));
    }) as typeof globalThis.fetch;
    return () => { globalThis.fetch = prev; };
}

test("web panel Check now is check-only: gate ladder runs, nothing downloads or installs (#4791)", async () => {
    const fixture = makeFixture("0.9.300");
    const state: RegistryStubState = { latest: "0.9.400", tarballs: new Map([["0.9.400", makeNpmTgz("0.9.400")]]), hits: {} };
    const restore = stubRegistryFetch(state);
    try {
        ua._resetUpdateActionsForTest();
        // autoUpdate:false is exactly the reported setup — the old force=true
        // wiring sailed past every gate and installed anyway.
        ua.registerUpdateActions({ packageName: "billion-context", currentVersion: VERSION, autoUpdate: false, installDir: fixture });
        const r = await ua.triggerManualCheck();
        assert.equal(r.ok, true);
        assert.equal(r.status, "update-available");
        assert.equal(r.latest, "0.9.400");
        assert.equal(r.candidate, "0.9.400");
        assert.equal(state.hits["tarball:0.9.400"] ?? 0, 0, "check-only must never fetch the tarball");
        assert.equal(await readDiskVersion(fixture), "0.9.300", "check-only must never install — on-disk version untouched");
        assert.ok(await lastUpdateCheckTime(), "the last-checked marker still refreshes — that is what the button promises");
    } finally {
        restore();
        ua._resetUpdateActionsForTest();
    }
});

test("web panel Check now reports an advisory-blocked version instead of installing it (#4791/#1588)", async () => {
    const fixture = makeFixture("0.9.300");
    const state: RegistryStubState = { latest: "0.9.400", tarballs: new Map([["0.9.400", makeNpmTgz("0.9.400")]]), hits: {} };
    const restore = stubRegistryFetch(state);
    try {
        ua._resetUpdateActionsForTest();
        ua.registerUpdateActions({ packageName: "billion-context", currentVersion: VERSION, autoUpdate: false, installDir: fixture, advisoryBlocksVersion: (v) => v === "0.9.400" });
        const r = await ua.triggerManualCheck();
        assert.equal(r.ok, true);
        assert.equal(r.status, "blocked-advisory");
        assert.equal(r.latest, "0.9.400");
        assert.equal(state.hits["tarball:0.9.400"] ?? 0, 0);
        assert.equal(await readDiskVersion(fixture), "0.9.300");
    } finally {
        restore();
        ua._resetUpdateActionsForTest();
    }
});

test("web panel Check now reports up-to-date when dist-tag equals the on-disk version (#4791)", async () => {
    const fixture = makeFixture("0.9.400");
    const state: RegistryStubState = { latest: "0.9.400", tarballs: new Map([["0.9.400", makeNpmTgz("0.9.400")]]), hits: {} };
    const restore = stubRegistryFetch(state);
    try {
        ua._resetUpdateActionsForTest();
        ua.registerUpdateActions({ packageName: "billion-context", currentVersion: VERSION, autoUpdate: false, installDir: fixture });
        const r = await ua.triggerManualCheck();
        assert.equal(r.ok, true);
        assert.equal(r.status, "up-to-date");
        assert.equal(r.latest, "0.9.400");
        assert.equal(state.hits["tarball:0.9.400"] ?? 0, 0);
        assert.equal(await readDiskVersion(fixture), "0.9.400");
    } finally {
        restore();
        ua._resetUpdateActionsForTest();
    }
});

test("web panel Check now defers to an active advisory without racing it (#4791/#1481)", async () => {
    const fixture = makeFixture("0.9.300");
    const state: RegistryStubState = { latest: "0.9.400", tarballs: new Map([["0.9.400", makeNpmTgz("0.9.400")]]), hits: {} };
    const restore = stubRegistryFetch(state);
    try {
        ua._resetUpdateActionsForTest();
        ua.registerUpdateActions({ packageName: "billion-context", currentVersion: VERSION, autoUpdate: false, installDir: fixture, advisoryActive: () => true });
        const r = await ua.triggerManualCheck();
        assert.equal(r.ok, true);
        assert.equal(r.status, "deferred-advisory");
        assert.equal(state.hits.latest ?? 0, 0, "deferral happens before any registry fetch");
    } finally {
        restore();
        ua._resetUpdateActionsForTest();
    }
});

test("panel installs attribute manual-web; advisory callers keep the legacy label (#4791)", async () => {
    const fixture = makeFixture("0.9.300");
    const state: RegistryStubState = { latest: "0.9.400", tarballs: new Map([["0.9.400", makeNpmTgz("0.9.400")]]), hits: {} };
    const restore = stubRegistryFetch(state);
    await _resetLastInstallForTest();
    try {
        const opts = { packageName: "billion-context", currentVersion: "0.9.300", autoUpdate: false, installDir: fixture };
        const panel = await forceInstallVersion("0.9.400", fixture, opts, "web-panel", "manual-web");
        assert.equal(panel.ok, true);
        const rec = await getLastInstall();
        assert.equal(rec?.source, "manual-web", "a user-initiated panel install must not be misfiled under an advisory id");
        assert.equal(rec?.version, "0.9.400");
        assert.equal(await readDiskVersion(fixture), "0.9.400");
        await _resetLastInstallForTest();
        const fixture2 = makeFixture("0.9.300");
        const adv = await forceInstallVersion("0.9.400", fixture2, { ...opts, installDir: fixture2 }, "adv-test");
        assert.equal(adv.ok, true);
        assert.equal((await getLastInstall())?.source, "advisory:adv-test", "advisory callers omitting the explicit source keep the legacy label");
    } finally {
        restore();
        await _resetLastInstallForTest();
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
