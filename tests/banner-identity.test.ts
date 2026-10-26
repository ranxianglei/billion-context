import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture, closeLogger } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

// #2864①: the startup banner must self-identify its writer — pid plus the
// instance id (the same token the instance registry prints) — so that N
// banners on one port are attributable to N distinct short-lived processes
// instead of 24 indistinguishable duplicates.

interface Captured { level: string; msg: string }

async function startBare(opts: Partial<ProxyOptions>, captured: Captured[]): Promise<{ proxy: http.Server; dir: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-banner-"));
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const base: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        chainContentDetection: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
        logFile: path.join(dir, "bili.log"),
        ...opts,
    };
    const proxy = await startServer(base);
    await once(proxy, "listening");
    return { proxy, dir };
}

test("banner carries pid + instance id and fires exactly once per listen", async () => {
    const captured: Captured[] = [];
    let dir: string | undefined;
    let proxy: http.Server | undefined;
    try {
        const started = await startBare({}, captured);
        proxy = started.proxy;
        dir = started.dir;
        const port = (proxy.address() as { port: number }).port;
        // #2941: registration now completes AFTER the bind (post-bind ownership
        // check), so "listening" no longer implies the banner is logged yet — poll for it.
        const t0 = Date.now();
        while (!captured.some((c) => c.msg.includes("listening on")) && Date.now() - t0 < 10_000) {
            await new Promise((r) => setTimeout(r, 25));
        }
        const banners = captured.filter((c) => c.msg.includes("listening on"));
        assert.equal(banners.length, 1, "one banner per successful listen");
        assert.match(banners[0]!.msg, new RegExp(`^acp-proxy v[\\d.]+ \\(pid ${process.pid}, id [0-9a-f]{8}\\) listening on http://127\\.0\\.0\\.1:${port}`));
        assert.ok(banners[0]!.msg.includes("web UI:"), "rest of the banner line is unchanged");
    } finally {
        // best-effort close on EVERY path — an assertion failure above must not
        // leak the server handle (it would pin this process's event loop forever).
        if (proxy !== undefined) {
            const p = proxy;
            await new Promise<void>((resolve) => p.close(() => resolve()));
        }
        setLogCapture(null);
        closeLogger();
        if (dir) rmrf(dir);
    }
});
