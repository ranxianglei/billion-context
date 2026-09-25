import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerWatcherDefault, type WatcherRegistration } from "../src/launcher.ts";

/** #1322: the attach path used to swallow the daemon-proxy 409 silently, so a
 *  claude-native session riding a manually-started proxy got zero signal that
 *  the "lives and dies with the session" contract was void. The registration
 *  seam must now report its outcome so host-native bootstraps can surface it. */

function stubWatcher(status: number): Promise<{ origin: string; close: () => Promise<void>; body: (req: http.IncomingMessage) => Promise<string> }> {
    let lastBody = "";
    const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/__bili/watcher") {
            let b = "";
            req.on("data", (c) => (b += c));
            req.on("end", () => {
                lastBody = b;
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(status === 200 ? { ok: true, watchers: 1 } : { ok: false, error: "stub" }));
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as AddressInfo).port;
            resolve({
                origin: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(() => r())),
                body: async () => lastBody,
            });
        });
    });
}

test("registerWatcherDefault: maps HTTP outcomes to ok / refused / failed (#1322)", async () => {
    const ok = await stubWatcher(200);
    try {
        assert.equal(await registerWatcherDefault(ok.origin, 4242), "ok");
        assert.equal(await ok.body(), JSON.stringify({ pid: 4242 }), "posts the owner pid as the body");
    } finally {
        await ok.close();
    }

    const refused = await stubWatcher(409);
    try {
        // A daemon proxy (no BILI_PARENT_PID) refuses — that is the #1322 case.
        assert.equal(await registerWatcherDefault(refused.origin, 4242), "refused");
    } finally {
        await refused.close();
    }

    const err500 = await stubWatcher(500);
    try {
        assert.equal(await registerWatcherDefault(err500.origin, 4242), "failed");
    } finally {
        await err500.close();
    }

    // Connection failure (nothing listening) degrades to "failed", never throws.
    const dead: WatcherRegistration = await registerWatcherDefault("http://127.0.0.1:1", 4242);
    assert.equal(dead, "failed");
});
