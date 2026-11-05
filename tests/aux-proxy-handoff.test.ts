import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

/** The launcher hands a proxy-less `bili claude` child the egress THIS instance
 *  resolves for aux requests, read off /__bili/health. These tests pin the wire
 *  field: which tiers feed it, and that an explicitly-direct configuration (or a
 *  proxy whose scheme cannot be honoured) reports nothing rather than a guess. */

// #2941: registration completes after the bind, so "listening" is not readiness.
async function waitReady(port: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(500) })).status === 200) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`proxy on port ${port} did not become ready`);
}

interface HealthWire {
    auxProxy: string | null;
    auxProxySource: string | null;
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function healthOf(patch: Partial<ProxyOptions>): Promise<HealthWire> {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-aux-handoff-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    const prevData = process.env.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.XDG_DATA_HOME = path.join(tmpRoot, "data");
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
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        ...patch,
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        await waitReady(port);
        return (await (await fetch(`http://127.0.0.1:${port}/__bili/health`)).json()) as HealthWire;
    } finally {
        if (proxy) {
            proxy.closeAllConnections?.();
            await close(proxy);
        }
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        if (prevData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevData;
        rmrf(tmpRoot);
    }
}

test("health reports the aux proxy an inherited shell proxy resolves to (#1012 tier)", async () => {
    // No target, so the resolver walks the https candidate chain: httpsProxy wins.
    const health = await healthOf({ auxProxyFallback: { httpsProxy: "http://aux.local:3128", httpProxy: "http://aux.local:8080" } });
    assert.equal(health.auxProxy, "http://aux.local:3128/", "resolver normalises to a bare origin");
    assert.equal(health.auxProxySource, "HTTPS_PROXY");
});

test("health reports the config-tier proxy when the inherited tier is empty", async () => {
    // bili's own global proxy (file config `upstreamProxy`) outranks the env
    // tier, and the aux resolver sees it through the same `proxy` field.
    const health = await healthOf({ proxy: "http://config.local:3128", proxyMode: "manual", proxySource: "config", auxProxyFallback: { globalSource: "config" } });
    assert.equal(health.auxProxy, "http://config.local:3128/", "resolver normalises to a bare origin");
    assert.equal(health.auxProxySource, "config");
});

test("health reports no aux proxy when the configuration is explicitly direct", async () => {
    // explicitDirect short-circuits BEFORE the env tier: a user who chose
    // "direct" must not get a shell proxy handed back to their child.
    const health = await healthOf({ auxProxyFallback: { explicitDirect: true, httpsProxy: "http://aux.local:3128" } });
    assert.equal(health.auxProxy, null);
    assert.equal(health.auxProxySource, "direct");
});

test("health drops an unsupported proxy scheme instead of handing it to a child", async () => {
    // Only http(s) origins work: a SOCKS URL would break npm/git in the child.
    const health = await healthOf({ auxProxyFallback: { allProxy: "socks5://127.0.0.1:1080" } });
    assert.equal(health.auxProxy, null);
});
