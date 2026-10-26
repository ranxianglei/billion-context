import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    captureInheritedProxyEnv,
    ensureProxyRunning,
    type SpawnChild,
    type SpawnFn,
} from "../src/launcher.ts";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { loadOptions } from "../src/config.ts";
import { resolveProxyDecision } from "../src/upstream-proxy.ts";

// Hermetic state dir — the proxy-starting marker (#707) must never touch the
// developer's real one.
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bili-1012-state-"));

function makeFakeChild(pid: number): SpawnChild {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
        pid,
        unref() {},
        kill() {
            return true;
        },
        on(event: string, listener: (...args: unknown[]) => void) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
            return this as unknown as SpawnChild;
        },
    } as unknown as SpawnChild;
}

function withSandboxEnv(mutate: (env: NodeJS.ProcessEnv) => void, run: () => void): void {
    const prev = { ...process.env };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-1012-home-"));
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_CACHE_HOME = path.join(home, ".cache");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
    try {
        mutate(process.env);
        run();
    } finally {
        process.env = prev;
    }
}

test("captureInheritedProxyEnv: forwards user proxy vars under BILI_INHERITED_* (upper wins, blanks skipped)", () => {
    const captured = captureInheritedProxyEnv({
        https_proxy: "http://127.0.0.1:7897",
        HTTP_PROXY: "http://upper:8080",
        http_proxy: "http://lower:8080",
        all_proxy: "   ",
    });
    assert.deepEqual(captured, {
        BILI_INHERITED_HTTPS_PROXY: "http://127.0.0.1:7897",
        BILI_INHERITED_HTTP_PROXY: "http://upper:8080",
    });
    assert.deepEqual(captureInheritedProxyEnv({}), {});
});

test("ensureProxyRunning: proxy child gets BILI_INHERITED_* but NOT the raw proxy vars (#1012)", async () => {
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    let spawned = false;
    const spawnImpl: SpawnFn = (_cmd, _args, options) => {
        spawned = true;
        spawnedEnv = options.env;
        return makeFakeChild(42422);
    };
    const instance = (launchToken: string): ProxyInstanceFile => ({
        origin: "http://127.0.0.1:42422",
        instanceId: "inst-1012",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 42422,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        launchToken,
    });
    // Windows env keys are CASE-INSENSITIVE: setting `no_proxy` then deleting
    // `NO_PROXY` would delete the SAME slot. Use the uppercase spellings
    // (capture prefers them anyway); the lowercase-vs-uppercase capture
    // semantics are covered platform-independently by the pure test above.
    const saved = ["https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"].map((k) => [k, process.env[k]] as const);
    for (const k of ["https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"]) delete process.env[k];
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
    process.env.NO_PROXY = "localhost,.corp";
    try {
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 42422, passthrough: false, debug: false },
            {
                spawnImpl,
                fetchImpl: async () => ({ ok: true }),
                readInstanceFile: () =>
                    spawned && spawnedEnv?.BILI_LAUNCH_TOKEN
                        ? instance(String(spawnedEnv.BILI_LAUNCH_TOKEN))
                        : undefined,
                sleep: () => Promise.resolve(),
            },
        );
        assert.ok(handle.origin.includes("42422"));
        assert.ok(spawnedEnv, "proxy child was spawned");
        // forwarded for aux egress...
        assert.equal(spawnedEnv.BILI_INHERITED_HTTPS_PROXY, "http://127.0.0.1:7897");
        assert.equal(spawnedEnv.BILI_INHERITED_NO_PROXY, "localhost,.corp");
        // ...while the strip still holds for the child itself (e1c6c92)
        assert.equal(spawnedEnv.https_proxy, undefined);
        assert.equal(spawnedEnv.HTTPS_PROXY, undefined);
        assert.equal(spawnedEnv.no_proxy, undefined);
    } finally {
        for (const key of ["https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"]) delete process.env[key];
        for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
    }
});

test("loadOptions: BILI_INHERITED_* fills auxProxyFallback only, own env tier still wins", () => {
    withSandboxEnv(() => {}, () => {
        const opts = loadOptions({
            ACP_PORT: "42422",
            BILI_INHERITED_HTTPS_PROXY: "http://127.0.0.1:7897",
            BILI_INHERITED_NO_PROXY: "localhost,.corp",
        });
        // model-egress fallback keeps the clean-env semantics (e1c6c92)
        assert.equal(opts.proxyFallback?.httpsProxy, undefined);
        assert.equal(opts.proxyFallback?.noProxy, undefined);
        // aux fallback carries the launcher-forwarded tier + shared guards
        assert.equal(opts.auxProxyFallback?.httpsProxy, "http://127.0.0.1:7897");
        assert.equal(opts.auxProxyFallback?.noProxy, "localhost,.corp");
        assert.equal(opts.auxProxyFallback?.biliPort, 42422);
    });

    withSandboxEnv((env) => {
        env.HTTPS_PROXY = "http://own-env:1";
    }, () => {
        // own env wins over inherited for the aux tier too (manual `bili start`
        // in a proxy shell keeps today's behavior; inherited is launcher-only)
        const opts = loadOptions({
            ACP_PORT: "42422",
            HTTPS_PROXY: "http://own-env:1",
            BILI_INHERITED_HTTPS_PROXY: "http://127.0.0.1:7897",
        });
        assert.equal(opts.proxyFallback?.httpsProxy, "http://own-env:1");
        assert.equal(opts.auxProxyFallback?.httpsProxy, "http://own-env:1");
    });
});

test("default config (unset mode) keeps the inherited aux tier reachable — explicitDirect trap (#1012 review)", () => {
    // default config: no proxy mode set anywhere → resolves to "direct" with
    // explicitDirect=true — the inherited aux tier must NOT be short-circuited
    withSandboxEnv(() => {}, () => {
        const opts = loadOptions({
            ACP_PORT: "42422",
            BILI_INHERITED_HTTPS_PROXY: "http://127.0.0.1:7897",
        });
        assert.equal(opts.proxy, "");
        assert.equal(opts.proxyFallback?.explicitDirect, true); // model path: default-direct unchanged
        assert.equal(opts.auxProxyFallback?.explicitDirect, false); // ← the trap
        const aux = resolveProxyDecision({}, opts.proxy, "https://chatgpt.com/backend-api/ps/mcp", opts.auxProxyFallback);
        assert.equal(aux.source, "HTTPS_PROXY");
        assert.equal(aux.proxy, "http://127.0.0.1:7897/");
        const model = resolveProxyDecision({}, opts.proxy, "https://chatgpt.com/backend-api/ps/mcp", opts.proxyFallback);
        assert.equal(model.source, "direct");
    });

    // EXPLICIT "direct" mode disables the inherited aux tier too
    withSandboxEnv(() => {}, () => {
        const opts = loadOptions({
            ACP_PORT: "42422",
            BILI_UPSTREAM_PROXY_MODE: "direct",
            BILI_INHERITED_HTTPS_PROXY: "http://127.0.0.1:7897",
        });
        const aux = resolveProxyDecision({}, opts.proxy, "https://chatgpt.com/backend-api/ps/mcp", opts.auxProxyFallback);
        assert.equal(aux.source, "direct");
    });
});

test("resolveProxyDecision: inherited tier routes blind-tunnel aux traffic, model path stays direct (#1012)", () => {
    const target = "https://chatgpt.com/backend-api/ps/mcp";
    const proxyFallback = { biliPort: 42422, systemProxy: { enabled: false } };
    const auxProxyFallback = {
        ...proxyFallback,
        httpsProxy: "http://127.0.0.1:7897",
    };

    // model-egress decision: empty env tier → direct (unchanged e1c6c92 path)
    assert.deepEqual(resolveProxyDecision({}, undefined, target, proxyFallback), { source: "direct" });

    // aux (blind-tunnel) decision: inherited user VPN applies
    // (parseHttpProxy normalizes to a trailing slash)
    assert.deepEqual(resolveProxyDecision({}, undefined, target, auxProxyFallback), {
        proxy: "http://127.0.0.1:7897/",
        source: "HTTPS_PROXY",
    });

    // explicit global config proxy still outranks the inherited tier
    const explicit = resolveProxyDecision({}, "http://explicit:3128", target, auxProxyFallback);
    assert.equal(explicit.proxy, "http://explicit:3128/");
    assert.equal(explicit.source, "global");

    // proxyMode "direct" wins over inherited aux traffic as well
    const direct = resolveProxyDecision({}, "", target, { ...auxProxyFallback, explicitDirect: true });
    assert.equal(direct.source, "direct");

    // a value pointing at bili's own port is dropped (loop guard), not used
    const loop = resolveProxyDecision({}, undefined, target, {
        ...proxyFallback,
        httpsProxy: "http://127.0.0.1:42422",
    });
    assert.equal(loop.source, "direct");
});
