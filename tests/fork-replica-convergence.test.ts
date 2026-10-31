import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

// #2960 ② hermeticity: plain-JSON codec + pinned config + legacy baseline;
// the convergence legs below flip BILI_STORAGE_UNIFIED explicitly.
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "bili-fkcv-hermetic-")), "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";
// 60s idle-reap: the sync UnifiedStore work below blocks the event loop past
// the 5s default under load -> the in-process proxy reaps the client's pooled
// socket mid-test -> stale-socket 'fetch failed' (windows/node22, PR #5008 CI).
process.env.BILI_KEEP_ALIVE_TIMEOUT_MS = "60000";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const testRoot = mkdtempSync(join(tmpdir(), "bili-fkcv-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

async function harness(persist: boolean) {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: persist, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(req.url?.endsWith("/chat/completions")
                ? { id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }
                : { id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const request = async (path: string, body?: unknown) => {
        const r = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() as Record<string, unknown> };
    };
    const messages = [
        { role: "user", content: "first original ".repeat(250) },
        { role: "assistant", content: "second original ".repeat(250) },
        { role: "user", content: "tail original" },
    ];
    const seed = async (conversationId: string) => {
        const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": conversationId }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }) });
        assert.equal(r.status, 200);
        await r.text();
    };
    return { request, seed, messages, dir, store, upstreamUrl, origin, close: async () => { store.closeQuietly(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

test("fork receipts cut pinned fork_base checkpoints that survive session deletion (#2960 ②)", async () => {
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const h = await harness(true);
    try {
        await h.seed("parent");
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
        const parentSessionId = snapshot.body.sessionId as string;
        const ordered = snapshot.body.orderedMessages as { rawId: string; ref: string; identityHash: string }[];
        const request = { protocolVersion: 1, parentConversationId: "parent", childConversationId: "child", parentRevision: snapshot.body.parentRevision, branchPoint: { messageCount: 2, orderHash: hash(ordered.slice(0, 2)) }, orderedMessages: ordered.slice(0, 2), idempotencyKey: "fkcv-1" };
        const fork = await h.request("/__bili/plugin/fork", request);
        assert.equal(fork.status, 201, JSON.stringify(fork.body));

        // ① Both sides of the fork mint cut pinned fork_base checkpoints:
        //    the child (receipt) and the retained parent.
        const db = UnifiedStore.open(join(h.dir, "sessions", "index.db"));
        let childBase: { cpId: string } | null = null;
        let parentBase: { cpId: string } | null = null;
        try {
            for (const id of [parentSessionId, fork.body.sessionId as string]) {
                const rows = db.listCheckpoints(id).filter((cp) => cp.kind === "fork_base");
                assert.equal(rows.length, 1, `expected one fork_base checkpoint for ${id}`);
                assert.equal(rows[0]!.pinned, 1, `fork_base for ${id} must be pinned`);
                assert.ok(rows[0]!.cp_id.startsWith("cp-"), JSON.stringify(rows[0]));
                if (id === parentSessionId) parentBase = { cpId: rows[0]!.cp_id };
                else childBase = { cpId: rows[0]!.cp_id };
            }
        } finally {
            db.close();
        }

        // ② Pinned fork_base survives session deletion (deleteSession sweeps
        //    only unpinned checkpoints). The child keeps working after its
        //    parent row is gone — inheritance is self-contained.
        const db2 = UnifiedStore.open(join(h.dir, "sessions", "index.db"));
        try {
            db2.deleteSession(parentSessionId);
            assert.equal(db2.listCheckpoints(parentSessionId).filter((cp) => cp.kind === "fork_base").length, 1, "pinned fork_base must survive deleteSession");
        } finally {
            db2.close();
        }
        const childSnapshot = await h.request("/__bili/plugin/snapshot?conversationId=child");
        assert.equal(childSnapshot.status, 200, JSON.stringify(childSnapshot.body));
        assert.equal((childSnapshot.body.orderedMessages as unknown[]).length, 2);

        // ③ The parent's fork substrate resurrects from the pinned checkpoint
        //    via the replicas API — a fresh session id serving the identical
        //    ordered snapshot (Phase 3 envelope-drop substrate).
        assert.ok(parentBase, "parent fork_base missing");
        const reborn = await h.store.restoreReplica(parentBase!.cpId, { sessionId: parentSessionId + "-reborn" });
        assert.equal(reborn.restoredFrom, parentSessionId);
        const rebornSnapshot = await h.request(`/__bili/plugin/snapshot?conversationId=${reborn.sessionId}`);
        assert.equal(rebornSnapshot.status, 200, JSON.stringify(rebornSnapshot.body));
        assert.deepEqual(rebornSnapshot.body.orderedMessages, ordered, "resurrected snapshot must match the original ordered prefix");
        assert.notEqual(rebornSnapshot.body.sessionId, parentSessionId);

        // The child is unaffected by the resurrection (independent lineage).
        const childAgain = await h.request("/__bili/plugin/snapshot?conversationId=child");
        assert.equal(childAgain.status, 200);
    } finally {
        await h.close();
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
    }
});

test("fork_base checkpoints are not cut without the unified store (#2960 ② control)", async () => {
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    const h = await harness(true);
    try {
        await h.seed("parent2");
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent2");
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
        const ordered = snapshot.body.orderedMessages as { rawId: string; ref: string; identityHash: string }[];
        const request = { protocolVersion: 1, parentConversationId: "parent2", childConversationId: "child2", parentRevision: snapshot.body.parentRevision, branchPoint: { messageCount: 2, orderHash: hash(ordered.slice(0, 2)) }, orderedMessages: ordered.slice(0, 2), idempotencyKey: "fkcv-2" };
        assert.equal((await h.request("/__bili/plugin/fork", request)).status, 201);
        // legacy mode: no index.db at all — the envelope blobs remain the
        // only fork substrate (rollback contract). Existence probe only —
        // opening the path would create the file and defeat the claim.
        assert.ok(!existsSync(join(h.dir, "sessions", "index.db")), "legacy mode must not create a unified index");
    } finally {
        await h.close();
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
    }
});
