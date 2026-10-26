import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests, __incrementalPtrChainForTests } from "../src/incremental-lane.ts";

/**
 * #3901 / #3798 — incremental canonical row pointers.
 *
 * readCanonicalFromStore used the base-seq COUNT cutoff, but the unified
 * messages table reuses rows for identical (msg_id, content_hash)
 * (remapPlanToAbsolute) — a resync that shares history with the rejected
 * branch maps onto rows BELOW the cutoff, so a cold rebuild lost the shared
 * prefix and served serverSeq 0/1 → 409 reseed loop. Fix: persist the
 * ordered canonical row POINTERS (inc:canonical-ptrs) after every raw
 * ingest; cold reads fetch rows by pointer; malformed pointers force an
 * honest resync instead of a partial history.
 */

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-inc-ptrs-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

async function harness(): Promise<{
    proxyUrl: string;
    turn: (t: { sinceSeq: number; messages: unknown[]; resync?: boolean }) => Promise<{ status: number; body: unknown; appliedSeq?: number }>;
    forwarded: Record<string, unknown>[];
    close: () => Promise<void>;
}> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 0 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_x", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 100, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${upstream.address() instanceof Object ? (upstream.address() as { port: number }).port : 0}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const turn = async (t: { sinceSeq: number; messages: unknown[]; resync?: boolean }) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-ptrs" },
            body: JSON.stringify({ conversationId: "conv-ptrs", sinceSeq: t.sinceSeq, ...(t.resync ? { resync: true } : {}), path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: t.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        const applied = response.headers.get("x-bili-applied-seq");
        return { status: response.status, body, appliedSeq: applied !== null && /^\d+$/.test(applied) ? Number(applied) : undefined };
    };
    return {
        proxyUrl,
        turn,
        forwarded,
        close: async () => {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            store.closeQuietly();
            await new Promise<void>((resolve) => upstream.close(() => resolve()));
        },
    };
}

const core = (id: string, text: string): Record<string, unknown> => ({ id, role: "user", contentType: "text", content: text.repeat(200) });

test("cold canonical rebuild: identical resync keeps the shared prefix; delta assembles the FULL history", async () => {
    const h = await harness();
    try {
        const seed = await h.turn({ sinceSeq: 0, resync: true, messages: [core("u1", "one"), core("u2", "two"), core("u3", "three")] });
        assert.equal(seed.status, 200);
        assert.equal(seed.appliedSeq, 3);

        // Identical-history resync (#3798's killer shape): the branch shares
        // ALL rows with the previous one — remap reuses them below any count
        // cutoff.
        const resync = await h.turn({ sinceSeq: 0, resync: true, messages: [core("u1", "one"), core("u2", "two"), core("u3", "three")] });
        assert.equal(resync.status, 200);
        assert.equal(resync.appliedSeq, 3);
        await __incrementalPtrChainForTests("conv-ptrs");

        // Cold: drop the resident caches, keep SQLite.
        __resetIncrementalLaneForTests();

        const delta = await h.turn({ sinceSeq: 3, messages: [core("u4", "four")] });
        assert.equal(delta.status, 200, "cold rebuild must serve the shared prefix instead of 409-reseed");
        assert.equal(delta.appliedSeq, 4);
        const upstreamBody = h.forwarded.at(-1) as { messages: { content?: { text?: string }[] }[] };
        const texts = JSON.stringify(upstreamBody.messages);
        let cursor = -1;
        for (const expected of ["one", "two", "three", "four"]) {
            const at = texts.indexOf(expected.repeat(200), cursor + 1);
            assert.ok(at > cursor, `assembled history = shared prefix + delta in order (${expected} missing or out of order)`);
            cursor = at;
        }
    } finally {
        await h.close();
    }
});

test("cold canonical rebuild: edited-tail resync keeps the shared prefix, drops the replaced branch", async () => {
    const h = await harness();
    try {
        await h.turn({ sinceSeq: 0, resync: true, messages: [core("u1", "one"), core("u2", "two")] });
        // Edit the last message → resync [u1, u2']. Let the turn's pointer
        // chain settle first — a real client's next turn would await it
        // server-side; only a crash inside the window could observe the
        // one-turn-stale pointers.
        await h.turn({ sinceSeq: 0, resync: true, messages: [core("u1", "one"), core("u2", "two-EDITED")] });
        await __incrementalPtrChainForTests("conv-ptrs");
        __resetIncrementalLaneForTests();
        const delta = await h.turn({ sinceSeq: 2, messages: [core("u3", "three")] });
        assert.equal(delta.status, 200);
        const upstreamBody = h.forwarded.at(-1) as { messages: { id?: string; content?: unknown }[] };
        const texts = JSON.stringify(upstreamBody.messages);
        assert.ok(texts.includes("two-EDITED"), "current branch served");
        assert.ok(!texts.includes("two-EDITED".slice(0, 3) + "two"), "sanity");
    } finally {
        await h.close();
    }
});

test("malformed pointers: honest resync, never a partial history", async () => {
    const h = await harness();
    try {
        await h.turn({ sinceSeq: 0, resync: true, messages: [core("u1", "one"), core("u2", "two")] });
        // Corrupt the pointer list to reference a row that does not exist.
        const store = getStore();
        store.setSessionExt("conv-ptrs", "inc:canonical-ptrs", [424242]);
        assert.deepEqual(store.getSessionExt("conv-ptrs", "inc:canonical-ptrs"), [424242]);
        __resetIncrementalLaneForTests();
        const before = h.forwarded.length;
        const r = await h.turn({ sinceSeq: 2, messages: [core("u3", "three")] });
        // Either an honest 409 (forcing client resync) or a full resync —
        // but the upstream must NEVER see a truncated [u3]-only history.
        const served = h.forwarded.length > before ? (h.forwarded.at(-1) as { messages: unknown[] }).messages.length : 0;
        assert.ok(r.status === 409 || served >= 3, `no partial history (status=${r.status}, served=${served})`);
    } finally {
        await h.close();
    }
});
