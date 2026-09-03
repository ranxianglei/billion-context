import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

test("server: preferred port taken + handshake file → OS-port fallback, origin+pid reported (#401)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const blockerAddr = blocker.address();
    const stolenPort = typeof blockerAddr === "object" && blockerAddr ? blockerAddr.port : 0;

    const handshakeFile = path.join(os.tmpdir(), `bili-handshake-test-${process.pid}-${Date.now()}.json`);
    try {
        const upstream = http.createServer((_req, res) => {
            res.writeHead(200);
            res.end("ok");
        });
        await new Promise<void>((resolve, reject) => {
            upstream.once("error", reject);
            upstream.listen(0, "127.0.0.1", () => resolve());
        });
        const upstreamPort = (upstream.address() as { port: number }).port;

        const opts: ProxyOptions = {
            port: stolenPort,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: {
                [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
            },
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
            handshakeFile,
        };
        const proxy = await startServer(opts);
        const t0 = Date.now();
        while (!fs.existsSync(handshakeFile)) {
            assert.ok(Date.now() - t0 < 5000, "handshake file published after fallback bind");
            await new Promise((r) => setTimeout(r, 10));
        }
        const actualPort = (proxy.address() as { port: number }).port;
        assert.notEqual(actualPort, stolenPort, "fell back to an OS-assigned port");

        const info = JSON.parse(fs.readFileSync(handshakeFile, "utf8")) as { origin: string; pid?: number };
        assert.equal(info.origin, `http://127.0.0.1:${actualPort}`);
        assert.equal(info.pid, process.pid);

        const health = await fetch(`http://127.0.0.1:${actualPort}/__bili/health`);
        assert.equal(health.status, 200);

        await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
        upstream.close();
    } finally {
        fs.rmSync(handshakeFile, { force: true });
        blocker.close();
    }
});
