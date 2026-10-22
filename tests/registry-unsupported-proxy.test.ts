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
    const cacheHome = await mkdtemp(path.join(tmpdir(), "bili-registry-test-"));
    const saved = {
        cache: process.env.XDG_CACHE_HOME,
        state: process.env.XDG_STATE_HOME,
        config: process.env.XDG_CONFIG_HOME,
    };
    // fetchFresh() reads the proxy env per call: clear it so the count is one
    // fetch per load (a live https_proxy would add the "via proxy" attempt and
    // make the assertion environment-dependent).
    const proxyKeys = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"] as const;
    const savedProxy = Object.fromEntries(proxyKeys.map((k) => [k, process.env[k]]));
    for (const key of proxyKeys) delete process.env[key];
    process.env.XDG_CACHE_HOME = cacheHome;
    process.env.XDG_STATE_HOME = cacheHome;
    process.env.XDG_CONFIG_HOME = cacheHome;

    let calls = 0;
    let reg: typeof import("../src/registry.ts") | undefined;
    try {
        // Import AFTER the env redirect: CACHE_FILE is resolved at module load,
        // so a warm developer cache cannot short-circuit the failure path.
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
        assert.equal(calls, 2, "the memo must be cleared after a rejection, not only after success");
    } finally {
        reg?._setRegistryFetchForTest(undefined);
        reg?._resetForTest();
        await rm(cacheHome, { recursive: true, force: true });
        for (const [key, value] of [
            ["XDG_CACHE_HOME", saved.cache],
            ["XDG_STATE_HOME", saved.state],
            ["XDG_CONFIG_HOME", saved.config],
        ] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        for (const key of proxyKeys) {
            const value = savedProxy[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
