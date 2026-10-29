// #5140 item 4: a non-retained plugin parent cold-restored in shadow mode loses
// its resident pluginSnapshot (the disk envelope never held it — the retention
// gate only writes it after a fork receipt), yet index.db still carries the
// independently recorded unfolded raw tail. Before the fix, GET
// /__bili/plugin/snapshot 409'd SNAPSHOT_UNAVAILABLE forever after a restart;
// now the fork path rebuilds that tail through its LOGICAL projection and serves
// it ONLY when it can be proved to be the session's complete ordered history.
//
// These are synthetic cold close/reopen HTTP inheritance tests: a fresh process
// (new store + proxy) opens the SAME isolated data root and must recover the
// already-stored source material without a fresh parent model call.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, listSessions } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
const testRoot = mkdtempSync(join(tmpdir(), "bili-issue5140-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = join(testRoot, key);

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

type Handle = {
    origin: string;
    upstreamUrl: string;
    dir: string;
    store: SessionStore;
    close(): Promise<void>;
};

/** One "process": a store bound to `dir` plus a proxy in front of a stubbed
 *  upstream. `mode` flips BILI_STORAGE_UNIFIED for the lifetime of this handle;
 *  passing an existing `dir` simulates a cold restore onto the same data root. */
async function harness(mode: "shadow" | "legacy", dir?: string): Promise<Handle> {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = mode;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-test", object: "chat.completion", created: 1, model: "claude-test", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const d = dir ?? mkdtempSync(join(testRoot, "store-"));
    const store = new SessionStore({ enabled: true, dir: d, debounceMs: 0 });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetPluginStateForTest();
    _setForTest({});
    resetToolRingForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [upstreamUrl]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    return {
        origin: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
        upstreamUrl,
        dir: d,
        store,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
            store.closeQuietly();
            if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevMode;
        },
    };
}

const PARENT = "parent-5140";
const CHILD = "child-5140";

function seedBody(): unknown {
    return { model: "claude-test", max_tokens: 1024, stream: false, messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "first original ".repeat(250) },
        { role: "assistant", content: "second original ".repeat(250) },
        { role: "user", content: "third original ".repeat(250) },
        { role: "assistant", content: "fourth original ".repeat(250) },
        { role: "user", content: "tail question" },
    ] };
}

type Snapshot = { ok?: boolean; status?: string; code?: string; sessionId?: string; parentRevision?: string; orderedMessages?: Array<{ rawId: string; ref: string | null; identityHash: string }> };

async function seedParent(h: Handle): Promise<void> {
    const seed = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": PARENT },
        body: JSON.stringify(seedBody()),
    });
    assert.equal(seed.status, 200, await seed.text());
}

async function getSnapshot(h: Handle, id: string): Promise<{ status: number; body: Snapshot }> {
    const r = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=${id}`);
    return { status: r.status, body: (await r.json()) as Snapshot };
}

test("#5140 shadow: non-retained parent forks from the intact unified raw tail after a cold restart", async () => {
    // Phase 1 — build a NON-retained parent on an isolated shadow data root.
    const h1 = await harness("shadow");
    const dir = h1.dir;
    let expectedCount = 0;
    let parentId = "";
    try {
        await seedParent(h1);
        const warm = await getSnapshot(h1, PARENT);
        assert.equal(warm.status, 200, JSON.stringify(warm.body));
        expectedCount = warm.body.orderedMessages!.length;
        parentId = warm.body.sessionId!;
        assert.ok(expectedCount >= 5, `multi-message history expected, got ${expectedCount}`);
        const warmSession = listSessions().find((s) => s.id === parentId)!;
        assert.equal(warmSession.metadata.publicForkReceipt, undefined, "parent was never forked (non-retained)");
        assert.equal(warmSession.metadata.publicSnapshotRetained, undefined, "parent not marked retained");
        assert.ok(warmSession.pluginSnapshot && warmSession.pluginSnapshot.length > 0, "warm parent holds its resident raw snapshot in memory");
        // Precondition: the shadow double-write recorded the full raw tail, aligned to the canonical ids.
        const seqs = h1.store.unifiedTailSeqs(parentId);
        assert.ok(seqs && seqs.length > 0, "index.db holds the raw tail (shadow double-write)");
        assert.equal(seqs!.length, warmSession.state.lastPassIds?.length, "unified tail length equals lastPassIds");
    } finally {
        await h1.close();
    }

    // Phase 2 — process death + cold restore onto the SAME data root.
    const h2 = await harness("shadow", dir);
    try {
        const cold = await getSnapshot(h2, PARENT);
        assert.equal(cold.status, 200, `cold snapshot must be served from the intact raw tail, got ${JSON.stringify(cold.body)}`);
        assert.equal(cold.body.orderedMessages!.length, expectedCount, "reconstructed tail covers the full history");
        const coldSession = listSessions().find((s) => s.id === cold.body.sessionId)!;
        assert.equal(coldSession.pluginSnapshot, undefined, "GET must not establish permanent raw retention");
        assert.equal(coldSession.metadata.publicSnapshotRetained, undefined, "GET must not mark the parent retained");

        const ordered = cold.body.orderedMessages!;
        const fork = await fetch(`${h2.origin}/__bili/plugin/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: 2, parentConversationId: PARENT, childConversationId: CHILD, parentRevision: cold.body.parentRevision, branchPoint: { messageCount: ordered.length, orderHash: hash(ordered) }, orderedMessages: ordered, idempotencyKey: `fork:${CHILD}` }),
        });
        assert.equal(fork.status, 201, await fork.text());
        const retained = listSessions().find((s) => s.id === cold.body.sessionId)!;
        assert.equal(retained.metadata.publicSnapshotRetained, true, "only a successful fork retains the verified parent source");
    } finally {
        await h2.close();
    }
});

test("#5140 shadow: an over-cap raw tail fails closed after a cold restart (no unbounded copy served)", async () => {
    const prevCap = process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES;
    const h1 = await harness("shadow");
    const dir = h1.dir;
    try {
        await seedParent(h1); // default cap: the warm parent keeps a valid resident snapshot
    } finally {
        await h1.close();
    }
    // Cap only in phase 2 so the warm parent stays uncapped: isolates the reconstruction cap gate.
    process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES = "1";
    try {
        const h2 = await harness("shadow", dir);
        try {
            const cold = await getSnapshot(h2, PARENT);
            assert.equal(cold.status, 409, `over-cap raw tail must fail closed, got ${JSON.stringify(cold.body)}`);
            assert.equal(cold.body.code, "SNAPSHOT_UNAVAILABLE");
        } finally {
            await h2.close();
        }
    } finally {
        if (prevCap === undefined) delete process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES; else process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES = prevCap;
    }
});

test("#5140 legacy: with no unified source the cold parent stays 409 (fail closed)", async () => {
    const h1 = await harness("legacy");
    const dir = h1.dir;
    try {
        await seedParent(h1);
    } finally {
        await h1.close();
    }
    const h2 = await harness("legacy", dir);
    try {
        const cold = await getSnapshot(h2, PARENT);
        assert.equal(cold.status, 409, `no unified store to reconstruct from, got ${JSON.stringify(cold.body)}`);
        assert.equal(cold.body.code, "SNAPSHOT_UNAVAILABLE");
    } finally {
        await h2.close();
    }
});
