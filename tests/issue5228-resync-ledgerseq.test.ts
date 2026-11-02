// #5228 (found reviewing #5156): #5156 made the lane ALWAYS project
// biliLedgerSeqs for an unstamped canonical tail, starting from 1 when
// nothing is stamped yet ("the first resync's rows settle in message order").
// That projection is exact only for a FRESH table. On a resync onto a
// NON-empty unified table (divergent edit / cold-rebuild reseed — the append-
// only table keeps the previous branch's rows below the new branch), the new
// tail's real store seqs start ABOVE the old branch, so the projected 1..N
// stamps are wrong for every message past the shared prefix. A live message
// whose projected stamp falls inside an existing active fold's seq interval
// is then pruned from the outbound wire by the seq-coverage channel even
// though it was never folded.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";

const testRoot = mkdtempSync(join(tmpdir(), "resync-seq-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const SUMMARY = "fold of the middle of branch A covering four seeded messages as one bounded interval on the unified ledger";

interface Harness {
    turn: (t: { sinceSeq: number; messages: unknown[]; msgIds?: string[]; resync?: boolean }) => Promise<{ status: number; body: unknown }>;
    callTool: (tool: string, args: unknown) => Promise<{ status: number; body: unknown }>;
    forwarded: Record<string, unknown>[];
    blockRows: () => { blockId: string; startSeq: number; endSeq: number; payloadJson: string }[];
    rows: () => { seq: number; msgId: string }[];
    settle: () => Promise<void>;
    close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1";
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 15 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    let n = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            n++;
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: `msg_${n}`, role: "assistant", content: [{ type: "text", text: `answer ${n}` }], stop_reason: "end_turn", usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const turn = async (t: { sinceSeq: number; messages: unknown[]; msgIds?: string[]; resync?: boolean }) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-resync-seq" },
            body: JSON.stringify({ conversationId: "conv-resync-seq", sinceSeq: t.sinceSeq, ...(t.resync ? { resync: true } : {}), ...(t.msgIds !== undefined ? { msgIds: t.msgIds } : {}), path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: t.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
    };
    const callTool = async (tool: string, args: unknown) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh" },
            body: JSON.stringify({ conversationId: "conv-resync-seq", tool, args }),
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
    };
    const dbPath = join(dir, "sessions", "index.db");
    const sessionSql = "(SELECT session_id FROM messages WHERE msg_id = 'u1' LIMIT 1)";
    const rows = (): { seq: number; msgId: string }[] => {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const raw = db.prepare(`SELECT seq, msg_id FROM messages WHERE session_id = ${sessionSql} ORDER BY seq`).all() as unknown as { seq: number; msg_id: string }[];
            return raw.map((r) => ({ seq: r.seq, msgId: r.msg_id }));
        } finally {
            db.close();
        }
    };
    const blockRows = (): { blockId: string; startSeq: number; endSeq: number; payloadJson: string }[] => {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const raw = db.prepare(`SELECT block_id, start_seq, end_seq, payload_json FROM blocks WHERE session_id = ${sessionSql} ORDER BY ord`).all() as unknown as { block_id: string; start_seq: number; end_seq: number; payload_json: string }[];
            return raw.map((r) => ({ blockId: r.block_id, startSeq: r.start_seq, endSeq: r.end_seq, payloadJson: r.payload_json }));
        } finally {
            db.close();
        }
    };
    return { turn, callTool, forwarded, rows, blockRows, settle: async () => { await new Promise((resolve) => setTimeout(resolve, 60)); }, close: async () => { await new Promise<void>((resolve) => proxy.close(() => resolve())); store.closeQuietly(); await new Promise<void>((resolve) => upstream.close(() => resolve())); } };
}

// Poll until the seed's canonical pointers are durably recorded — the wrap-up
// chain floats the pointer recording behind the ack (#5155), so a fixed sleep
// races under parallel load.
async function waitPtrs(expected: number): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
        const v = getStore().getSessionExt("conv-resync-seq", "inc:canonical-ptrs");
        if (Array.isArray(v) && v.length >= expected) return;
        if (Date.now() > deadline) throw new Error(`canonical pointers stalled at ${JSON.stringify(v)} (expected >= ${expected})`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const big = (text: string) => text.repeat(600);
const umsg = (text: string) => ({ role: "user", content: [{ type: "text", text: big(text) }] });
const amsg = (text: string) => ({ role: "assistant", content: [{ type: "text", text: big(text) }] });

test("resync onto a non-empty table must not prune live messages via projected stamps", async () => {
    const h = await harness();
    try {
        // Branch A: 16 seeded messages, fold m00004..m00007 (a ledger interval
        // in the MIDDLE of the history, clear of the recent-token zone that
        // protects the last ~7 rows), then continue so the fold settles.
        const seed = await h.turn({
            sinceSeq: 0, resync: true,
            msgIds: ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5", "a5", "u6", "a6", "u7", "a7", "u8", "a8"],
            messages: [umsg("alpha"), amsg("bravo"), umsg("charlie"), amsg("delta"), umsg("echo"), amsg("foxtrot"), umsg("golf"), amsg("hotel"), umsg("india"), amsg("juliet"), umsg("kilo"), amsg("lima"), umsg("mike"), amsg("november"), umsg("oscar"), amsg("papa")],
        });
        assert.equal(seed.status, 200, `seed status: ${JSON.stringify(seed.body)}`);
        // Real pointers must land before the NEXT model turn or that turn's
        // body carries no seq stamps — and compress reads the remembered
        // plugin messages of the last model turn, so an unstamped predecessor
        // yields an id-based fold with no seq interval. A model compress call
        // always follows a full round trip, far past the 15 ms flush here.
        await waitPtrs(16);
        const warmup = await h.turn({ sinceSeq: 16, msgIds: ["u17"], messages: [umsg("after seed")] });
        assert.equal(warmup.status, 200, `warmup status: ${JSON.stringify(warmup.body)}`);
        const call = await h.callTool("compress", { content: [{ startId: "m00004", endId: "m00007", topic: "branchA", summary: SUMMARY }] });
        assert.equal((call.body as { ok?: boolean }).ok, true, `fold status: ${JSON.stringify(call.body)}`);
        const cont = await h.turn({ sinceSeq: 17, msgIds: ["u18"], messages: [umsg("after fold")] });
        assert.equal(cont.status, 200, `continue status: ${JSON.stringify(cont.body)}`);
        await h.settle();
        const blocksA = h.blockRows();
        assert.equal(blocksA.length, 1, `one branch-A block expected: ${JSON.stringify(blocksA.map((b) => b.blockId))}`);
        const payloadA = JSON.parse(blocksA[0]!.payloadJson) as { startSeq?: number; endSeq?: number };
        assert.deepEqual([payloadA.startSeq, payloadA.endSeq], [4, 7], "branch-A fold records the middle-of-history interval");
        const rowsA = h.rows();
        assert.ok(rowsA.length >= 13, `branch A settled ${rowsA.length} rows`);

        // Divergent resync sharing only u1/a1/u2: the new tail b4/b5/b6 appends
        // ABOVE branch A's rows in the append-only table. The lane projects
        // stamps [1,2,3,4,5,6] for the whole history — the new tail's stamps
        // 4..6 collide with the live fold interval [4,7] although b4/b5/b6
        // were never folded and their real ledger positions are far higher.
        const resynced = await h.turn({
            sinceSeq: 0, resync: true,
            msgIds: ["u1", "a1", "u2", "b4", "b5", "b6"],
            messages: [umsg("alpha"), amsg("bravo"), umsg("charlie"), amsg("bravo-NEW"), umsg("charlie-NEW"), amsg("delta-NEW")],
        });
        assert.equal(resynced.status, 200, `resync status: ${JSON.stringify(resynced.body)}`);
        const wire = JSON.stringify(h.forwarded.at(-1)!);
        // The bug: with the from-1 projection, b4/b5/b6 carry stamps 4..6,
        // inside the branch-A fold's live interval [4,7] — the seq-coverage
        // channel prunes all three and stands the stale summary anchor in
        // their place. Correct behavior: every live message rides, and the
        // now-orphaned fold (its covered refs left the client's view) swallows
        // nothing.
        assert.ok(wire.includes("bravo-NEW".repeat(5)), "the new branch's live message b4 must ride the wire");
        assert.ok(wire.includes("charlie-NEW".repeat(5)), "the new branch's live message b5 must ride the wire");
        assert.ok(wire.includes("delta-NEW".repeat(5)), "the new branch's live message b6 must ride the wire");
        assert.ok(!wire.includes(SUMMARY), "the orphaned branch-A fold must not stand in for live new-branch messages");

        await h.settle();
        const rowsB = h.rows();
        const b4row = rowsB.find((r) => r.msgId === "b4");
        assert.ok(b4row !== undefined, "b4 row settled");
        assert.ok(b4row!.seq >= rowsA.length, `b4 landed above the branch-A rows (seq ${b4row!.seq}, prior rows ${rowsA.length}) — proving the projected stamp 4 could not be its real position`);
    } finally {
        await h.close();
    }
});
