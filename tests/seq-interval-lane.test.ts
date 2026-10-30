// #4316 PR2/3 host stakes: the seq-stamp transport end to end. The kernel
// suites (kernel/tests/seq-interval-coverage.test.ts) pin that a fold over
// stamped messages records ledger intervals and that coverage then survives
// id churn; this file pins the HOST half — stamps must survive the synthetic
// wire round-trip (lane canonical → coreToAnthropic body → pipeline parse →
// re-stamped at prepare), a fold executed through the plugin tool endpoint
// must write the interval into the unified blocks table, and the next turn's
// outbound must suppress the covered originals.
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
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";

const testRoot = mkdtempSync(join(tmpdir(), "seq-lane-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const SUMMARY = "fold of the first four seeded messages covering alpha through bravo payloads as one bounded interval on the unified ledger";

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
            if (n === 2) {
                // the model answers with a compress tool call; the plugin-lane
                // client relays it to POST /__bili/plugin/tool (the dsh flow).
                res.end(JSON.stringify({
                    id: "msg_fold",
                    role: "assistant",
                    content: [{ type: "tool_use", id: "call_fold", name: "compress", input: { content: [{ startId: "m00001", endId: "m00004", topic: "seed", summary: SUMMARY }] } }],
                    stop_reason: "tool_calls",
                    usage: { input_tokens: 10000, output_tokens: 10 },
                }));
            } else {
                res.end(JSON.stringify({ id: `msg_${n}`, role: "assistant", content: [{ type: "text", text: `answer ${n}` }], stop_reason: "end_turn", usage: { input_tokens: 10000, output_tokens: 10 } }));
            }
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
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-seq-1" },
            body: JSON.stringify({ conversationId: "conv-seq-1", sinceSeq: t.sinceSeq, ...(t.resync ? { resync: true } : {}), ...(t.msgIds !== undefined ? { msgIds: t.msgIds } : {}), path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: t.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
    };
    const callTool = async (tool: string, args: unknown) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh" },
            body: JSON.stringify({ conversationId: "conv-seq-1", tool, args }),
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

const big = (text: string) => text.repeat(600);
const umsg = (text: string) => ({ role: "user", content: [{ type: "text", text: big(text) }] });
const amsg = (text: string) => ({ role: "assistant", content: [{ type: "text", text: big(text) }] });
const smallUser = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

test("seq interval lane flow: stamps ride the body, fold records the interval, outbound suppresses the originals", async () => {
    const h = await harness();
    try {
        // seed: 8 stamped rows under client ids
        const seed = await h.turn({
            sinceSeq: 0, resync: true,
            msgIds: ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5", "a5", "u6", "a6"],
            messages: [umsg("alpha"), amsg("bravo"), umsg("charlie"), amsg("delta"), umsg("echo"), amsg("foxtrot"), umsg("golf"), amsg("hotel"), umsg("india"), amsg("juliet"), umsg("kilo"), amsg("lima")],
        });
        assert.equal(seed.status, 200, `seed status: ${JSON.stringify(seed.body)}`);
        const rows = h.rows();
        assert.equal(rows.length, 12, "seed lands twelve rows");
        assert.deepEqual(rows.map((r) => r.msgId), ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5", "a5", "u6", "a6"], "rows carry the pinned client ids");

        // the internal transport must never leak upstream
        const seedBody = h.forwarded[0] as Record<string, unknown>;
        assert.equal(seedBody.biliMsgIds, undefined, "biliMsgIds stripped before the upstream");
        assert.equal(seedBody.biliLedgerSeqs, undefined, "biliLedgerSeqs stripped before the upstream");

        // turn 2: the upstream answers with a compress tool call (raw JSON
        // passes through the plugin lane — the client relays it).
        const foldTurn = await h.turn({ sinceSeq: 12, msgIds: ["u7"], messages: [umsg("fold please")] });
        assert.equal(foldTurn.status, 200, `fold turn status: ${JSON.stringify(foldTurn.body)}`);
        const foldBody = foldTurn.body as { content?: { type?: string; name?: string }[] };
        assert.equal(foldBody.content?.[0]?.name, "compress", "the tool_use reaches the client (dsh relays it to the tool endpoint)");

        // the client executes the tool server-side: refs m00002..m00004 are
        // the ledger-direct refs (stamps 2..4). The range stays clear of the
        // first-user pin (m00001 always rides) and of the recent-token zone
        // (preserveRecentTokens=5000 protects the last ~7 rows), so the fold
        // records exactly rows 1..3 as its interval.
        const call = await h.callTool("compress", { content: [{ startId: "m00002", endId: "m00004", topic: "seed", summary: SUMMARY }] });
        assert.equal(call.status, 200, `tool call status: ${JSON.stringify(call.body)}`);
        const callBody = call.body as { ok?: boolean; outcome?: string; blocksCreated?: number; result?: string };
        assert.equal(callBody.ok, true);
        assert.equal(callBody.outcome, "applied", `fold outcome: ${JSON.stringify(callBody)}`);
        assert.equal(callBody.blocksCreated, 1);

        // turn 3: the client echoes the tool exchange and continues. The next
        // turn's wrap-up also flushes the fold into the unified store.
        const echoAssistant = { role: "assistant", content: [{ type: "tool_use", id: "call_fold", name: "compress", input: { content: [{ startId: "m00002", endId: "m00004", topic: "seed", summary: SUMMARY }] } }] };
        const echoUser = { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fold", content: "folded" }] };
        const after = await h.turn({ sinceSeq: 13, msgIds: ["a7", "u8", "u9"], messages: [echoAssistant, echoUser, smallUser("after fold")] });
        assert.equal(after.status, 200, `post-fold turn status: ${JSON.stringify(after.body)}`);

        // the unified blocks table must carry BOTH interval forms:
        // row-space bounds (0-based store seqs, from the ingest-side mapping)
        // and the kernel payload's ledger-space bounds (1-based stamps).
        await h.settle();
        const blocks = h.blockRows();
        assert.equal(blocks.length, 1, `one block recorded: ${JSON.stringify(blocks.map((b) => b.blockId))}`);
        assert.equal(blocks[0]!.startSeq, 1, "store row bounds start at the second covered row (0-based)");
        assert.equal(blocks[0]!.endSeq, 3, "store row bounds end at the fourth covered row (0-based)");
        const payload = JSON.parse(blocks[0]!.payloadJson) as { startSeq?: number; endSeq?: number };
        assert.equal(payload.startSeq, 2, "kernel payload bounds start at the second ledger stamp (1-based)");
        assert.equal(payload.endSeq, 4, "kernel payload bounds end at the fourth ledger stamp (1-based)");

        // the outbound body must serve the summary anchor plus the uncovered
        // tail — the covered originals are suppressed (interval coverage).
        const last = h.forwarded.at(-1) as Record<string, unknown>;
        const lastText = JSON.stringify(last);
        assert.ok(lastText.includes("fold of the first four"), "the echoed compress tool call carries the summary on the wire (#1567 carrier contract — the in-place acp_summary anchor is deliberately stripped for plugin tool folds)");
        assert.ok(lastText.includes("after fold"), "the new tail is served");
        assert.ok(lastText.includes("alpha".repeat(5)), "the first user message rides the wire (first-user pin, DESIGN.md §8.1)");
        assert.ok(!lastText.includes("bravo".repeat(5)), "covered originals (bravo) suppressed from the outbound");
        assert.ok(!lastText.includes("charlie".repeat(5)), "covered originals (charlie) suppressed from the outbound");
        assert.ok(!lastText.includes("delta".repeat(5)), "covered originals (delta) suppressed from the outbound");
        assert.ok(lastText.includes("echo".repeat(5)), "uncovered row (echo) stays visible");
        assert.ok(lastText.includes("lima".repeat(5)), "uncovered tail (lima) survives");
    } finally {
        await h.close();
    }
});
