import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import type { ProxyOptions } from "../src/config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { anonymousIdentitySummary, listSessions, type Session } from "../src/session.js";

// #4776: honest accounting for identity-less clients. splitSessions on
// /__bili/status is the #2165 stolen-anchor canary (shared id base + |sub:
// child) and structurally blind to anonymous prefix-affinity forks — every
// pfa-* fork owns a unique id. anonymousIdentity reports what bili actually
// knows from session metadata instead.

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-anon-id-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const mk = (id: string, apa?: unknown): Session =>
    ({ id, lastSeen: 0, createdAt: 0, stats: { requests: 1 }, metadata: apa === undefined ? {} : { anonymousPrefixAffinity: apa } }) as unknown as Session;

test("(A) anonymousIdentitySummary counts identity-less sessions by birth reason", () => {
    assert.deepEqual(anonymousIdentitySummary([mk("A"), mk("B")]), { total: 0, forkBorn: 0, truncatedBorn: 0 }, "identified or unstamped sessions never count");
    const mixed = anonymousIdentitySummary([
        mk("pfa-1", { depth: 1, tailHash: "t1", via: "new" }),
        mk("pfa-2", { depth: 3, tailHash: "t2", via: "new", lineage: { parents: ["pfa-1"], reason: "forked", sharedPrefix: 3 } }),
        mk("pfa-3", { depth: 2, tailHash: "t3", via: "new", lineage: { parents: ["pfa-1"], reason: "truncated" } }),
        mk("pfa-4", { depth: 5, tailHash: "t4", via: "prefix" }),
        mk("identified-client"),
    ]);
    assert.deepEqual(mixed, { total: 4, forkBorn: 1, truncatedBorn: 1 });
});

test("(B) /__bili/status exposes anonymousIdentity for anonymous traffic while splitSessions stays silent", async () => {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    const upstream = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const server = http.createServer((req, res) => {
            req.resume();
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); } }));
    });
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    try {
        const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
        // anonymous OpenAI lane: NO conversation-id headers of any kind (#4776 WorkBuddy shape)
        const r1 = await fetch(`${origin}/bili/${upstream.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-test", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200, await r1.text());
        assert.ok(listSessions().some((s) => s.id.startsWith("pfa-")), "an identity-less client mints a pfa-* session");

        const status = (await (await fetch(`${origin}/__bili/status`)).json()) as { splitSessions?: unknown[]; anonymousIdentity?: { total: number; forkBorn: number; truncatedBorn: number } };
        assert.ok(status.anonymousIdentity, "anonymousIdentity is present on /__bili/status");
        assert.ok(status.anonymousIdentity!.total >= 1, `at least the minted pfa session is counted (got ${JSON.stringify(status.anonymousIdentity)})`);
        assert.equal(status.anonymousIdentity!.forkBorn, 0);
        assert.equal(status.anonymousIdentity!.truncatedBorn, 0);
        assert.deepEqual(status.splitSessions, [], "the #2165 shared-base canary stays silent for unique-id pfa forks — that is why the separate count exists");
    } finally {
        store.cancelAll();
        proxy.close();
        await upstream.close();
        await new Promise((r2) => setTimeout(r2, 50));
    }
});
