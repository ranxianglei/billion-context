// #3128: an over-limit RAW body used to destroy the socket before the 413 was
// written, so clients met ECONNRESET instead of a structured error. These are
// real-HTTP regressions: the client must be able to READ the 413 (stage
// receive, limit + observed bytes) and upstream must stay untouched.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { restartForceCloseOf, startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { MAX_REQUEST_BYTES } from "../src/request-body-budget.ts";

const isolation = mkdtempSync(join(tmpdir(), "bili-receive-413-"));
process.env.XDG_STATE_HOME = join(isolation, "state");
process.env.XDG_DATA_HOME = join(isolation, "data");
process.env.XDG_CACHE_HOME = join(isolation, "cache");
process.env.XDG_CONFIG_HOME = join(isolation, "config");
test.after(() => rmSync(isolation, { recursive: true, force: true }));

async function fixture(run: (base: string, calls: Buffer[]) => Promise<void>): Promise<void> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const calls: Buffer[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            calls.push(Buffer.concat(chunks));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };

    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}`;
    try { await run(base, calls); }
    finally {
        // The 413'd connection can still sit in the #1982 post-response linger
        // arm (peer close signal never comes after an aborted upload), so the
        // sanctioned force-close seam cuts through it before close() is awaited.
        restartForceCloseOf(proxy)?.();
        proxy.closeAllConnections(); upstream.closeAllConnections();
        await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    }
}

test("raw body over the receive limit: client reads a structured 413 (stage receive) and upstream stays untouched", async () => {
    await fixture(async (base, calls) => {
        const oversized = Buffer.alloc(MAX_REQUEST_BYTES + 1024 * 1024, 65);
        const r = await fetch(`${base}/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "session-id": "receive-limit" },
            body: new Uint8Array(oversized),
        });
        assert.equal(r.status, 413, "the over-limit response must be READABLE by the client, not an ECONNRESET");
        assert.equal(r.headers.get("connection"), "close", "residual unread body ⇒ the connection must not be reused");
        const error = await r.json() as { error: { type: string; stage: string; message: string; limitBytes?: number; seenBytes?: number } };
        assert.equal(error.error.type, "request_too_large");
        assert.equal(error.error.stage, "receive");
        assert.equal(error.error.limitBytes, MAX_REQUEST_BYTES);
        assert.ok(typeof error.error.seenBytes === "number" && error.error.seenBytes > MAX_REQUEST_BYTES, "seenBytes reports the observed count at the crossing");
        assert.match(error.error.message, /exceeds/);
        assert.equal(calls.length, 0, "the oversized request must never reach the upstream");
    });
});

test("a normal small request still proxies after the budget is enforced", async () => {
    await fixture(async (base, calls) => {
        const body = JSON.stringify({ model: "gpt-5", stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
        const r = await fetch(`${base}/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "session-id": "small-after-limit" },
            body,
        });
        assert.equal(r.status, 200);
        assert.equal(calls.length, 1);
    });
});
