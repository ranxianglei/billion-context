// #3769 CI flake root cause: a bare-id loadSync over a pooled-path record
// (openai/<host>_<hash>.json) hydrated ONLY through the unified index row —
// the disk fallback walked files solely for async network backends, so any
// index miss on the sqlite path (fresh store over an existing dir, row still
// in an in-flight chain) surfaced as "record hydrates before the upgrade
// turn" failing intermittently. The envelope walk is now seeded for ANY
// unified mode; this test pins the disk fallback deterministically by
// deleting index.db while the pooled envelope stays on disk.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
// Full-mode story by design (header: records hydrate ONLY through the unified
// index row) — pin it so the CI runner's legacy storage baseline preload
// cannot flip the lane (explicit env beats the preload's ??=).
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-pool-hermetic-")), "no-config.json");

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

const LABEL = "pool3769";

type M = Record<string, unknown>;

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

test("bare-id loadSync hydrates a pooled envelope when the unified index misses (#3769 flake)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-pool-store-"));
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok 1" } }] }));
        res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        res.write("data: [DONE]\n\n");
        res.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upPort = (upstream.address() as { port: number }).port;

    const stores: SessionStore[] = [];
    try {
        const store1 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        stores.push(store1);
        _setStoreForTest(store1);
        _resetSessionsForTest();
        setRegistryForTest({});
        const proxy = await startServer({
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upPort}`]: { models: { "gpt-test": { context: 15_000 } } } },
            modelContextLimit: 15_000,
            kernelConfig: defaultConfig(15_000),
            compress: { injectTool: true, injectNudge: true },
            sessionHeader: "x-acp-session",
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
        } as unknown as ProxyOptions);
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upPort}/v1/chat/completions`;

        const hist: M[] = [
            { role: "user", content: "pool hydration one" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "pool hydration two POOL_TAIL_MARKER" },
        ];
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": LABEL }, body: JSON.stringify({ model: "gpt-test", messages: hist, stream: true }) });
        assert.equal(r.status, 200);

        const s1 = listSessions().find((x) => x.meta.label === LABEL);
        assert.ok(s1, "session exists");
        assert.ok(store1.flushSync(s1!), "record commits");
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close").catch(() => undefined);

        // The pooled envelope must exist at a namespaced path (protocol dir
        // + host-prefixed hash file) — that shape is what the bare three
        // livePaths in loadEnvelope can never see.
        const pooled = readdirSync(path.join(dir, "openai"));
        assert.equal(pooled.filter((f) => f.endsWith(".json") && !f.endsWith(".content-store.json")).length, 1, "pooled envelope present");

        // Simulate the index miss: drop index.db entirely (plus sqlite
        // sidecars) while the envelope stays on disk. Close store1 FIRST:
        // Windows refuses to unlink a file its sqlite handle still holds
        // (EBUSY) — same discipline as the plugin-fork cold restores.
        store1.closeQuietly();
        for (const side of ["index.db", "index.db-wal", "index.db-shm"]) {
            rmSync(path.join(dir, side), { force: true });
        }

        // Fresh store over the same dir: bare-id load MUST hydrate from the
        // pooled envelope via the walked disk fallback, not return null.
        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        stores.push(store2);
        _setStoreForTest(store2);
        _resetSessionsForTest();
        const hydrated = store2.loadSync(LABEL);
        assert.ok(hydrated, "bare-id loadSync hydrates the pooled envelope without the index");
        assert.ok(hydrated!.state.messageRefs && Object.keys(hydrated!.state.messageRefs.byRaw).length > 0, "hydrated state carries refs");
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
        for (const s of stores) s.closeQuietly();
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close").catch(() => undefined);
        _resetSessionsForTest();
        setRegistryForTest({});
        await rmrf(dir);
    }
});
