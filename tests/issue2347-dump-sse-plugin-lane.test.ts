// #2347: dumpSse was dead on every non-injected lane — the tee sat INSIDE the
// useRewriter branch of src/server.ts, so plugin mode (compressInjected=false
// ⇒ useRewriter=false) and non-injected proxy turns produced zero -raw.sse
// files even with dumpSse configured. The fix hoists one tee above the branch
// split (after resolveFakeCompletion replaces responseBody). These tests pin:
//   A  plugin-mode streaming turn dumps the raw upstream bytes
//   B  non-injected proxy streaming turn dumps them too
//   C  injected proxy turn still dumps EXACTLY once (old tee removed cleanly)
//   D  dumpSse unset ⇒ no files (default-off unchanged)
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

process.env.NODE_ENV = "test";
const root = mkdtempSync(join(tmpdir(), "bili-issue2347-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;

const SSE_BODY =
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";

interface Harness { origin: string; upstreamUrl: string; close: () => Promise<void>; }

const CLOSE_TIMEOUT_MS = 5_000;
// #3731: bound the teardown 'close' await. Under Windows runner-pool load a delayed
// or lost 'close' makes `await once(server,"close")` a handle-less dangling await that
// drains the event loop, so node --test aborts the WHOLE file and records every sibling
// subtest as cancelledByParent with ZERO assertion failures. The live timer keeps the
// loop alive so the promise always settles; per-test/--test-timeout do NOT rescue this
// (node:test's timer is unref'd). closeAllConnections already freed every socket.
const settledClose = (srv: http.Server): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); });
    return Promise.race([once(srv, "close"), timeout]).then(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
};

async function harness(opts: { dumpDir?: string; injectTool: boolean }): Promise<Harness> {
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(SSE_BODY);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "gpt-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: opts.injectTool, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] }, ...(opts.dumpDir ? { dumpSse: opts.dumpDir } : {}) } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;
    return {
        origin, upstreamUrl,
        close: async () => {
            store.cancelAll();
            const closed = Promise.all([settledClose(proxy), settledClose(upstream)]);
            proxy.close(); proxy.closeIdleConnections?.(); proxy.closeAllConnections?.();
            upstream.close(); upstream.closeIdleConnections?.(); upstream.closeAllConnections?.();
            await closed;
        },
    };
}

async function sendTurn(h: Harness, plugin: boolean, conv: string): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conv };
    if (plugin) {
        headers["x-bili-plugin"] = "test-agent";
        headers["x-bili-plugin-conversation"] = conv;
    }
    const r = await fetch(`${h.origin}/bili/${h.upstreamUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "gpt-test", stream: true, max_tokens: 1024, messages: [{ role: "user", content: "say hello" }] }) });
    assert.equal(r.status, 200);
    assert(r.body);
    const wire = await r.text();
    assert(wire.includes('"finish_reason":"stop"'), "client saw the terminal frame");
}

async function waitForDump(dir: string, expected: string, conv: string): Promise<string> {
    const deadline = Date.now() + 8000;
    for (;;) {
        const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith("-raw.sse")) : [];
        assert.ok(files.length <= 1, `expected at most one raw dump, got ${files.join(", ")}`);
        if (files.length === 1) {
            const content = readFileSync(join(dir, files[0]), "utf8");
            if (content === expected) return files[0];
        }
        if (Date.now() > deadline) throw new Error(`dump never matched the upstream bytes; dir=${JSON.stringify(existsSync(dir) ? readdirSync(dir) : null)}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

test("#2347 A: plugin-mode streaming turn dumps the raw upstream SSE (previously zero files)", { timeout: 20000 }, async () => {
    const dir = join(root, "raw-a");
    const h = await harness({ dumpDir: dir, injectTool: true });
    try {
        await sendTurn(h, true, "conv-a");
        const name = await waitForDump(dir, SSE_BODY, "conv-a");
        assert(name.includes("conv-a"), `filename carries the sanitized session id: ${name}`);
    } finally { await h.close(); }
});

test("#2347 B: non-injected proxy streaming turn dumps the raw upstream SSE", { timeout: 20000 }, async () => {
    const dir = join(root, "raw-b");
    const h = await harness({ dumpDir: dir, injectTool: false });
    try {
        await sendTurn(h, false, "conv-b");
        const name = await waitForDump(dir, SSE_BODY, "conv-b");
        assert(name.includes("conv-b"), `filename carries the sanitized session id: ${name}`);
    } finally { await h.close(); }
});

test("#2347 C: injected proxy turn still dumps exactly once (no double tee after removal)", { timeout: 20000 }, async () => {
    const dir = join(root, "raw-c");
    const h = await harness({ dumpDir: dir, injectTool: true });
    try {
        await sendTurn(h, false, "conv-c");
        const name = await waitForDump(dir, SSE_BODY, "conv-c");
        assert(name.includes("conv-c"));
    } finally { await h.close(); }
});

test("#2347 D: dumpSse unset writes nothing (default-off unchanged)", { timeout: 20000 }, async () => {
    const dir = join(root, "raw-d");
    const h = await harness({ injectTool: true });
    try {
        await sendTurn(h, true, "conv-d");
        assert(!existsSync(dir), "no dump dir created when dumpSse is unset");
    } finally { await h.close(); }
});
