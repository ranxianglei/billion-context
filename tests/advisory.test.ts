import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
    parseAdvisoryDoc,
    matchAdvisories,
    resolveAdvisoryUrl,
    runAdvisoryCheck,
    getAdvisoryState,
    _resetAdvisoryWatcherForTest,
    advisoryDeferring,
    cannotResolveTarget,
    type AdvisoryEntry,
} from "../src/advisory.ts";
import { checkForUpdate, _resetAdvisoryRefusalWarnsForTest } from "../src/update.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

interface Fixture {
    root: string;
    installDir: string;
    cacheDir: string;
    makeTarball(files: Record<string, string>): { tgz: Buffer; integrity: string };
}

/** A running install at 1.2.3 plus a scratch cache dir, like a real host. */
function makeFixture(): Fixture {
    const root = mkdtempSync(path.join(tmpdir(), "bc-advisory-test-"));
    const installDir = path.join(root, "install");
    const cacheDir = path.join(root, "cache");
    mkdirSync(path.join(installDir, "dist"), { recursive: true });
    writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({ name: "billion-context", version: "1.2.3", type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(installDir, "dist", "index.js"), "export const loaded = '1.2.3';\n");
    return {
        root,
        installDir,
        cacheDir,
        makeTarball(files) {
            const src = path.join(root, "pkg");
            mkdirSync(path.join(src, "package"), { recursive: true });
            for (const [rel, body] of Object.entries(files)) {
                const dest = path.join(src, "package", rel);
                mkdirSync(path.dirname(dest), { recursive: true });
                writeFileSync(dest, body);
            }
            const tgzPath = path.join(root, "pkg.tgz");
            tar.c({ cwd: src, file: tgzPath, gzip: true, sync: true }, ["package"]);
            const tgz = readFileSync(tgzPath);
            return { tgz, integrity: integrityField(tgz) };
        },
    };
}

function pkgJson(version: string): string {
    return JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } });
}

function advisoryDoc(entries: AdvisoryEntry[]): Record<string, unknown> {
    return { name: "billion-context-advisories", version: "0.0.2", billionContextAdvisories: { schema: 1, updated: "2026-09-27", advisories: entries } };
}

/** Route global fetch by URL regex; every unmatched URL fails loudly. Returns the fetch count. */
async function withFetch(routes: Array<{ match: RegExp; body: unknown }>, fn: () => Promise<void>): Promise<number> {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((url: string | URL | Request) => {
        calls++;
        const u = String(url);
        for (const route of routes) {
            if (route.match.test(u)) {
                return Promise.resolve(new Response(typeof route.body === "string" || route.body instanceof Buffer ? route.body : JSON.stringify(route.body)));
            }
        }
        return Promise.reject(new Error(`unexpected fetch: ${u}`));
    }) as unknown as typeof fetch;
    try {
        await fn();
    } finally {
        globalThis.fetch = original;
    }
    return calls;
}

test("parseAdvisoryDoc: valid document extracts entries", () => {
    const r = parseAdvisoryDoc(
        advisoryDoc([
            { id: "bc-2026-001", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: "breaks retries", publishedAt: "2026-09-27T00:00:00Z" },
        ]),
    );
    assert.equal(r.error, undefined);
    assert.deepEqual(r.entries, [{ id: "bc-2026-001", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: "breaks retries", publishedAt: "2026-09-27T00:00:00Z" }]);
});

test("parseAdvisoryDoc: empty advisories list is clean (not an error)", () => {
    const r = parseAdvisoryDoc(advisoryDoc([]));
    assert.equal(r.error, undefined);
    assert.deepEqual(r.entries, []);
});

test("parseAdvisoryDoc: rejects wrong shape, wrong schema, missing field", () => {
    assert.match(parseAdvisoryDoc(["nope"]).error ?? "", /not a JSON object/);
    assert.match(parseAdvisoryDoc(null).error ?? "", /not a JSON object/);
    assert.match(parseAdvisoryDoc({}).error ?? "", /missing billionContextAdvisories/);
    assert.match(parseAdvisoryDoc({ billionContextAdvisories: { schema: 2, advisories: [] } }).error ?? "", /unsupported schema 2/);
    assert.match(parseAdvisoryDoc({ billionContextAdvisories: { schema: 1 } }).error ?? "", /advisories field is not an array/);
});

test("parseAdvisoryDoc: skips malformed entries, errors when none survive", () => {
    const good = { id: "ok-1", affected: ">=1.0.0", target: "1.0.1", reason: "r" };
    const bad = [
        { affected: ">=1.0.0", target: "1.0.1", reason: "r" },
        { id: "x", target: "1.0.1", reason: "r" },
        { id: "x", affected: ">=1.0.0", target: "not-a-version", reason: "r" },
        { id: "x", affected: ">=1.0.0", target: "1.0.1" },
        "garbage",
    ];
    const mixed = parseAdvisoryDoc(advisoryDoc([...bad, good]));
    assert.equal(mixed.error, undefined);
    assert.deepEqual(mixed.entries, [good]);
    const allBad = parseAdvisoryDoc(advisoryDoc(bad));
    assert.match(allBad.error ?? "", /no valid advisories/);
});

test("matchAdvisories: range, prerelease inclusion, fail-open on garbage", () => {
    const entries: AdvisoryEntry[] = [{ id: "a", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: "r" }];
    assert.equal(matchAdvisories(entries, "0.1.156").length, 1);
    assert.equal(matchAdvisories(entries, "0.1.156-dev.1").length, 1, "prerelease matches its release base's range");
    assert.equal(matchAdvisories(entries, "0.1.154").length, 0);
    assert.equal(matchAdvisories(entries, "0.1.158").length, 0);
    assert.equal(matchAdvisories([{ id: "b", affected: "definitely-not-a-range", target: "1.0.0", reason: "r" }], "1.0.1").length, 0, "invalid range fails open");
    assert.deepEqual(matchAdvisories(entries, "not-a-version"), []);
});

test("resolveAdvisoryUrl: explicit override wins, default is the companion package", () => {
    assert.equal(resolveAdvisoryUrl("  https://example.test/feed.json "), "https://example.test/feed.json");
    assert.ok(resolveAdvisoryUrl(undefined).endsWith("/billion-context-advisories/latest"));
    assert.ok(resolveAdvisoryUrl("   ").endsWith("/billion-context-advisories/latest"));
});

test("runAdvisoryCheck: forces the target version onto an affected install", { timeout: 30_000 }, async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    try {
        const { tgz, integrity } = fx.makeTarball({ "package.json": pkgJson("1.2.9"), "dist/index.js": "export const loaded = '1.2.9';\n" });
        const doc = advisoryDoc([{ id: "bc-test-001", affected: ">=1.2.0 <1.2.5", target: "1.2.9", reason: "corrupts tool-call arguments" }]);
        await withFetch(
            [
                { match: /billion-context-advisories/, body: doc },
                { match: /\/billion-context\/1\.2\.9$/, body: { dist: { tarball: "https://registry.test/pkg-1.2.9.tgz", integrity } } },
                { match: /pkg-1\.2\.9\.tgz/, body: tgz },
            ],
            async () => {
                await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/billion-context-advisories/latest", installDir: fx.installDir }, true);
            },
        );
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.9");
        assert.equal(readFileSync(path.join(fx.installDir, "dist", "index.js"), "utf-8"), "export const loaded = '1.2.9';\n");
        const st = getAdvisoryState();
        assert.equal(st.active, undefined, "banner clears once the target version is clean");
        assert.equal(st.lastError, undefined);
    } finally {
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        rmrf(fx.root);
    }
});

test("runAdvisoryCheck: rollback semantics — target OLDER than the current version", { timeout: 30_000 }, async () => {
    const fx = makeFixture();
    writeFileSync(path.join(fx.installDir, "package.json"), pkgJson("1.2.9"));
    writeFileSync(path.join(fx.installDir, "dist", "index.js"), "export const loaded = '1.2.9';\n");
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    try {
        const { tgz, integrity } = fx.makeTarball({ "package.json": pkgJson("1.2.4"), "dist/index.js": "export const loaded = '1.2.4';\n" });
        const doc = advisoryDoc([{ id: "bc-test-002", affected: ">=1.2.5 <1.3.0", target: "1.2.4", reason: "regression in 1.2.5+" }]);
        await withFetch(
            [
                { match: /billion-context-advisories/, body: doc },
                { match: /\/billion-context\/1\.2\.4$/, body: { dist: { tarball: "https://registry.test/pkg-1.2.4.tgz", integrity } } },
                { match: /pkg-1\.2\.4\.tgz/, body: tgz },
            ],
            async () => {
                await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.9", advisoryUrl: "https://registry.test/billion-context-advisories/latest", installDir: fx.installDir }, true);
            },
        );
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.4");
        assert.equal(getAdvisoryState().active, undefined);
    } finally {
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        rmrf(fx.root);
    }
});

test("runAdvisoryCheck: refuses a source checkout, stays active with the reason", { timeout: 30_000 }, async () => {
    const fx = makeFixture();
    mkdirSync(path.join(fx.installDir, ".git"), { recursive: true });
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    try {
        const doc = advisoryDoc([{ id: "bc-test-003", affected: ">=1.2.0", target: "1.2.9", reason: "r" }]);
        await withFetch([{ match: /billion-context-advisories/, body: doc }], async () => {
            await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/billion-context-advisories/latest", installDir: fx.installDir }, true);
        });
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.3", "checkout untouched");
        const st = getAdvisoryState();
        assert.equal(st.active?.id, "bc-test-003", "stays active so the warning persists until the user upgrades");
        assert.match(st.lastError ?? "", /source checkout/);
    } finally {
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        rmrf(fx.root);
    }
});

test("runAdvisoryCheck: misconfigured advisory (target == current) fails loudly, no install churn, warns once per process", async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    _resetAdvisoryRefusalWarnsForTest();
    const warns: string[] = [];
    try {
        setLogCapture((_level, msg) => { warns.push(msg); });
        const doc = advisoryDoc([{ id: "bc-test-004", affected: ">=1.2.0", target: "1.2.3", reason: "r" }]);
        for (let i = 0; i < 2; i++) {
            const calls = await withFetch([{ match: /billion-context-advisories/, body: doc }], async () => {
                await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/billion-context-advisories/latest", installDir: fx.installDir }, true);
            });
            assert.equal(calls, 1, "only the advisory document was fetched");
        }
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.3");
        assert.match(getAdvisoryState().lastError ?? "", /misconfigured advisory/);
        assert.equal(warns.filter((m) => m.includes("misconfigured advisory")).length, 1, "persistent misconfiguration must log once, not every cycle");
    } finally {
        setLogCapture(null);
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        _resetAdvisoryRefusalWarnsForTest();
        rmrf(fx.root);
    }
});

test("runAdvisoryCheck: unresolvable target (owner typo) — install untouched, banner targetFailed, deferral released, warns once", async () => {
    // F1/F2 (review): the target version does not exist on the registry.
    // The fail-safe guard (update.ts "cannot resolve") must fire, the install
    // must stay untouched, the state must mark the target failed for the web
    // banner (@latest fallback), and — critically — advisoryDeferring() must
    // go FALSE so the normal self-update loop is not stalled forever.
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    _resetAdvisoryRefusalWarnsForTest();
    const warns: string[] = [];
    try {
        setLogCapture((_level, msg) => { warns.push(msg); });
        const doc = advisoryDoc([{ id: "bc-test-009", affected: ">=1.2.0", target: "9.9.9", reason: "escape-hatch version unpublished (typo)" }]);
        for (let i = 0; i < 2; i++) {
            // No /billion-context/9.9.9 version-doc route: the registry has no such version.
            await withFetch([{ match: /billion-context-advisories/, body: doc }], async () => {
                await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/billion-context-advisories/latest", installDir: fx.installDir }, true);
            });
        }
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.3", "install untouched when the target cannot be resolved");
        const st = getAdvisoryState();
        assert.ok(st.active, "advisory stays visible (banner) — the affected version is still affected");
        assert.match(st.lastError ?? "", /cannot resolve 9\.9\.9 on the registry/, "fail-safe reason recorded");
        assert.equal(cannotResolveTarget(st.lastError), true);
        assert.equal(advisoryDeferring(), false, "normal self-update loop must NOT be deferred by an uninstallable target (#1196 wedge class)");
        assert.equal(warns.filter((m) => m.includes("cannot resolve 9.9.9")).length, 1, "warned once per process across cycles");
    } finally {
        setLogCapture(null);
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        _resetAdvisoryRefusalWarnsForTest();
        rmrf(fx.root);
    }
});

test("runAdvisoryCheck: refuses host-managed (pnpm store) installs in place, warns once per process", async () => {
    const fx = makeFixture();
    // pnpm virtual-store layout: .../.pnpm/billion-context@1.2.3/node_modules/billion-context
    const pnpmDir = path.join(fx.root, "store", ".pnpm", "billion-context@1.2.3", "node_modules", "billion-context");
    mkdirSync(path.join(pnpmDir, "dist"), { recursive: true });
    writeFileSync(path.join(pnpmDir, "package.json"), pkgJson("1.2.3"));
    writeFileSync(path.join(pnpmDir, "dist", "index.js"), "export const loaded = '1.2.3';\n");
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    _resetAdvisoryRefusalWarnsForTest();
    const warns: string[] = [];
    try {
        setLogCapture((_level, msg) => { warns.push(msg); });
        const doc = advisoryDoc([{ id: "bc-test-006", affected: ">=1.2.0", target: "1.2.9", reason: "r" }]);
        for (let i = 0; i < 2; i++) {
            await withFetch([{ match: /billion-context-advisories/, body: doc }], async () => {
                await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/billion-context-advisories/latest", installDir: pnpmDir }, true);
            });
        }
        assert.equal(JSON.parse(readFileSync(path.join(pnpmDir, "package.json"), "utf-8")).version, "1.2.3", "host-managed copy must stay untouched (#991)");
        const st = getAdvisoryState();
        assert.equal(st.active?.id, "bc-test-006", "stays active so the warning persists until the owner lane upgrades");
        assert.match(st.lastError ?? "", /managed/);
        assert.equal(warns.filter((m) => m.includes("no in-place overwrite")).length, 1, "persistent refusal must log once, not every cycle");
    } finally {
        setLogCapture(null);
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        _resetAdvisoryRefusalWarnsForTest();
        rmrf(fx.root);
    }
});

test("runAdvisoryCheck: unreachable source fails open (warn, never throw)", async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    try {
        const original = globalThis.fetch;
        globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
        await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/billion-context-advisories/latest", installDir: fx.installDir }, true);
        globalThis.fetch = original;
        assert.match(getAdvisoryState().lastError ?? "", /ECONNREFUSED/);
        assert.equal(getAdvisoryState().active, undefined);
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.3");
    } finally {
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        rmrf(fx.root);
    }
});

test("runAdvisoryCheck: malformed document is ignored, not fatal", async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    try {
        await withFetch([{ match: /billion-context-advisories/, body: { schema: 99, advisories: "nope" } }], async () => {
            await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/billion-context-advisories/latest", installDir: fx.installDir }, true);
        });
        assert.match(getAdvisoryState().lastError ?? "", /missing billionContextAdvisories|malformed|unsupported/);
        assert.equal(getAdvisoryState().active, undefined);
    } finally {
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        rmrf(fx.root);
    }
});

test("runAdvisoryCheck: unthrottled second run skips (cadence respected)", async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    try {
        const doc = advisoryDoc([]);
        let calls = 0;
        const original = globalThis.fetch;
        globalThis.fetch = (() => {
            calls++;
            return Promise.resolve(new Response(JSON.stringify(doc)));
        }) as unknown as typeof fetch;
        await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/x", installDir: fx.installDir }, false);
        await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/x", installDir: fx.installDir }, false);
        globalThis.fetch = original;
        assert.equal(calls, 1, "second non-forced run within the interval must be a no-op");
    } finally {
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        rmrf(fx.root);
    }
});

test("checkForUpdate: defers to an active advisory instead of fighting it", async () => {
    const fx = makeFixture();
    mkdirSync(path.join(fx.installDir, ".git"), { recursive: true });
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    _resetAdvisoryWatcherForTest();
    try {
        const doc = advisoryDoc([{ id: "bc-test-005", affected: ">=1.2.0", target: "1.2.9", reason: "r" }]);
        await withFetch([{ match: /billion-context-advisories/, body: doc }], async () => {
            await runAdvisoryCheck({ packageName: "billion-context", currentVersion: "1.2.3", advisoryUrl: "https://registry.test/billion-context-advisories/latest", installDir: fx.installDir }, true);
        });
        assert.notEqual(getAdvisoryState().active, undefined, "precondition: advisory is active");
        const lines: string[] = [];
        setLogCapture((_level, msg) => { lines.push(msg); });
        try {
            const calls = await withFetch([], async () => {
                await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: true, advisoryActive: () => getAdvisoryState().active !== undefined }, false);
            });
            assert.equal(calls, 0, "normal loop must not touch the registry while the advisory owns the install");
        } finally {
            setLogCapture(null);
        }
        assert.ok(lines.some((l) => l.includes("deferring to the advisory loop")), `must log the deferral decision itself, got: ${JSON.stringify(lines)}`);
    } finally {
        delete process.env.XDG_CACHE_HOME;
        _resetAdvisoryWatcherForTest();
        rmrf(fx.root);
    }
});
