import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { proxyDispatcher, resetProxyCache } from "../src/upstream-proxy.ts";

// Regression: HTTPS_PROXY=socks5h://… is the default shape for v2rayN / Clash
// on Windows. The registry pre-warm handed that raw env value to
// proxyDispatcher, bypassing autoDetectProxy's scheme guard; undici's
// ProxyAgent constructor then threw "Invalid URL protocol" synchronously, the
// rejection escaped as an unhandledRejection, and the loader memoized it.
// Direct egress + the existing one-shot warning is the correct degradation —
// it is the same decision autoDetectProxy already makes for model traffic.

const XDG_KEYS = ["XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME"] as const;
const PROXY_KEYS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"] as const;

/** Redirect the XDG homes and clear every proxy env var so no warm developer
 *  cache or ambient proxy leaks into the loader under test. Returns the
 *  restore function (call it in finally). */
async function isolateLoaderEnv(): Promise<() => Promise<void>> {
    const cacheHome = await mkdtemp(path.join(tmpdir(), "bili-registry-test-"));
    const saved = [...XDG_KEYS, ...PROXY_KEYS].map((k) => [k, process.env[k]] as const);
    for (const key of PROXY_KEYS) delete process.env[key];
    for (const key of XDG_KEYS) process.env[key] = cacheHome;
    return async () => {
        await rm(cacheHome, { recursive: true, force: true });
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

test("proxyDispatcher degrades to direct for an unsupported proxy scheme", () => {
    resetProxyCache();
    for (const value of [
        "socks5h://127.0.0.1:10888",
        "socks5://127.0.0.1:10888",
        "socks4://127.0.0.1:1080",
        "ftp://127.0.0.1:21",
    ]) {
        assert.equal(proxyDispatcher(value), undefined, `${value} must degrade to direct`);
    }
    assert.ok(proxyDispatcher("http://127.0.0.1:10890"), "a supported origin still yields a dispatcher");
    assert.ok(proxyDispatcher("127.0.0.1:10890"), "a schemeless origin normalizes to http");
    resetProxyCache();
});

test("loadRegistry clears its memo after a failed load so the next call retries", async () => {
    // fetchFresh() reads the proxy env per call: isolateLoaderEnv clears it so
    // the count is one fetch per load (a live https_proxy would add the "via
    // proxy" attempt and make the assertion environment-dependent).
    const restore = await isolateLoaderEnv();
    let calls = 0;
    let reg: typeof import("../src/registry.ts") | undefined;
    try {
        // Import AFTER the env redirect: the cache path resolves against the
        // current XDG env at load time, so a warm developer cache cannot
        // short-circuit the failure path.
        reg = await import("../src/registry.ts");
        reg._resetForTest();
        reg._setRegistryFetchForTest(async () => {
            calls += 1;
            throw new Error("network down");
        });

        const first = await reg.loadRegistry();
        assert.ok(first, "a failed fetch still resolves through the bundled snapshot");
        assert.equal(calls, 1);

        const second = await reg.loadRegistry();
        assert.ok(second);
        assert.equal(calls, 2, "a failed load must not stick: the next call retries");
    } finally {
        reg?._setRegistryFetchForTest(undefined);
        reg?._resetForTest();
        await restore();
    }
});

// The user-visible regression pinned at the loader level: HTTPS_PROXY=socks5h://…
// (the v2rayN / Clash default on Windows) used to make loadRegistry() REJECT —
// undici's ProxyAgent constructor threw inside fetchFresh before its try/catch —
// surfacing at boot as an unhandledRejection from `void loadRegistry()` and
// poisoning the memoized promise for the process lifetime (every later call
// returned the same rejection even after the environment was fixed). With the
// scheme guard the load degrades to direct egress and RESOLVES (bundled snapshot
// when offline), and a second call still retries.
test("an unsupported proxy scheme neither rejects the loader nor poisons its memo", async () => {
    const restore = await isolateLoaderEnv();
    // The exact shape v2rayN / Clash write on Windows; fetchFresh() reads the
    // proxy env per call, and pre-fix code threw synchronously inside the async
    // loader for this value.
    process.env.https_proxy = "socks5h://127.0.0.1:10888";
    let calls = 0;
    let reg: typeof import("../src/registry.ts") | undefined;
    try {
        reg = await import("../src/registry.ts");
        reg._resetForTest();
        reg._setRegistryFetchForTest(async () => {
            calls += 1;
            throw new Error("network down");
        });

        // Pre-fix: rejected with InvalidArgumentError "Invalid URL protocol".
        const first = await reg.loadRegistry();
        assert.ok(first, "the load must resolve (bundled snapshot fallback), not reject");
        assert.equal(calls, 1);

        // Pre-fix: the memo held the rejected promise for the process lifetime.
        const second = await reg.loadRegistry();
        assert.ok(second);
        assert.equal(calls, 2, "a rejected load must not poison the memo");
    } finally {
        reg?._setRegistryFetchForTest(undefined);
        reg?._resetForTest();
        await restore();
    }
});
