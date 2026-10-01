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
import { recordBlindTunnel, getBlindTunnelStats, _resetBlindTunnelStatsForTest } from "../src/mitm.ts";
import { rmrf } from "./tmp-rm.ts";

/** #897: /__bili/health and /__bili/stats must expose the blind-tunnel counter
 *  (loopback-only admin endpoints), so an operator can see which CONNECT
 *  targets were relayed opaquely and never entered the compression pipeline. */

interface BlindTunnels {
    total: number;
    hosts: Record<string, number>;
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("health + stats expose blindTunnels counts with real hosts (#897)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-blind-stats-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    const prevData = process.env.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = tmpRoot;
    // MITM-enabled startup calls ensureRootCA(); isolate the CA dir so parallel
    // test files can't race on the shared real-profile dir on Windows.
    process.env.XDG_DATA_HOME = path.join(tmpRoot, "data");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetBlindTunnelStatsForTest();
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
        mitm: { enabled: true, domains: [] },
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;

        const emptyHealth = (await (await fetch(`http://127.0.0.1:${port}/__bili/health`)).json()) as { blindTunnels: BlindTunnels };
        assert.deepEqual(emptyHealth.blindTunnels, { total: 0, hosts: {} }, "fresh instance reports zero blind tunnels");

        recordBlindTunnel("copilot.tencent.com");
        recordBlindTunnel("copilot.tencent.com");
        recordBlindTunnel("relay.internal");

        const health = (await (await fetch(`http://127.0.0.1:${port}/__bili/health`)).json()) as { blindTunnels: BlindTunnels };
        assert.equal(health.blindTunnels.total, 3);
        assert.deepEqual(health.blindTunnels.hosts, { "copilot.tencent.com": 2, "relay.internal": 1 }, "real host names on the loopback-only endpoint");

        const stats = (await (await fetch(`http://127.0.0.1:${port}/__bili/stats`)).json()) as { sessions: unknown[]; blindTunnels: BlindTunnels };
        assert.ok(Array.isArray(stats.sessions), "sessions array still present");
        assert.equal(stats.blindTunnels.total, 3);
        assert.deepEqual(stats.blindTunnels.hosts, getBlindTunnelStats().hosts);
    } finally {
        if (proxy) {
            proxy.closeAllConnections?.();
            await close(proxy);
        }
        _resetBlindTunnelStatsForTest();
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        if (prevData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevData;
        rmrf(tmpRoot);
    }
});
