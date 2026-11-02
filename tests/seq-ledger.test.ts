// #4316 layer 3 — the server ledger IS the numbering.
//
// Contract staked (打桩):
//
//  S1  block coverage carries its ledger interval: planIngest fills
//      start_seq/end_seq with the min/max unified-store seq of the covered
//      messages (pre-layer-3 rows carried 0/0 placeholders). Id-independent
//      coverage bounds — byte churn can never invalidate them.
//
//  S2  snapshot-render prefix rows are numbered BY THE LEDGER: the <acp> ref
//      of every store-served message equals indexToRef(rowSeq + 1) (store
//      seqs are 0-based, the ref display space is 1-based). The kernel
//      counter path stops being the numbering authority for served views —
//      the number is assigned once at ingest and is structurally immune to
//      client-side byte churn (#4316: model switch / re-stamp / re-encode
//      re-mints every content-hash id today and kills the model's numbers).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "shadow";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-seq-ledger-")), "no-config.json");
process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";

import { defaultConfig, createInitialState } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";

const SUMMARY = "SEQ-LEDGER-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

test("S1: block coverage carries its ledger interval (start_seq/end_seq)", () => {
    const session: LegacySessionLike = {
        id: "seq-bounds-1",
        createdAt: 1,
        lastSeen: 2,
        meta: { label: "seq-bounds-1", protocol: "openai", upstreamOrigin: "http://upstream" },
        stats: { requests: 1 } as LegacySessionLike["stats"],
        metadata: {},
        state: {
            ...createInitialState(),
            messageRefs: { byRaw: {}, byRef: {} },
            blocks: [
                {
                    blockId: "b1",
                    runId: "r1",
                    tier: 1 as const,
                    summary: SUMMARY,
                    directMessageIds: ["m3", "m4", "m5"],
                    effectiveMessageIds: ["m2", "m3", "m4", "m5", "m6"],
                    directBlockIds: [],
                    compressedTokens: 500,
                    createdAt: 3,
                    survivedCount: 0,
                    generation: "young",
                    active: true,
                },
            ],
        },
        blockContents: new Map([["b1", { one: null, full: { text: SUMMARY, count: 5 } }]]),
        lastMessages: Array.from({ length: 10 }, (_, i) => ({ id: `m${i + 1}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `MSG_${i + 1}_BODY_`.repeat(40) })),
        lastMessagesFolded: false,
    };
    const plan = planIngest(session);
    // Coverage m2..m6 must resolve to the ledger positions of those exact
    // messages — the plan's own seq assignment is the ground truth.
    const seqOf: Record<string, number> = {};
    for (const row of plan.messages) seqOf[row.msgId] = row.seq;
    assert.notEqual(seqOf["m2"], undefined, "m2 has a log row");
    assert.notEqual(seqOf["m6"], undefined, "m6 has a log row");
    assert.ok(seqOf["m2"] < seqOf["m6"], "seqs are ordered");
    const b1 = plan.blocks.find((b) => b.blockId === "b1");
    assert.ok(b1, "block row present");
    assert.equal(b1.startSeq, seqOf["m2"], "start_seq = min covered ledger seq");
    assert.equal(b1.endSeq, seqOf["m6"], "end_seq = max covered ledger seq");
    // Ghost-only coverage (no rows) keeps the unknown-bounds shape.
    const ghost: LegacySessionLike = {
        ...session,
        id: "seq-bounds-ghost",
        state: {
            ...session.state,
            blocks: [{ ...(session.state.blocks[0] ?? ({} as never)), blockId: "bG", effectiveMessageIds: ["ghost-1"], directMessageIds: ["ghost-1"] }],
        },
    };
    const planG = planIngest(ghost);
    const bG = planG.blocks.find((b) => b.blockId === "bG");
    assert.ok(bG);
    assert.equal(bG.startSeq, -1, "no covered rows resolve → unknown bounds");
    assert.equal(bG.endSeq, -1);
});

// ---------------------------------------------------------------------------
// S2: snapshot-render prefix refs == ledger positions. Harness mirrors
// tests/snapshot-render.test.ts (fake upstream, real server + shadow store).

function conversation(): Array<{ role: string; content: string }> {
    const out: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 23; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} payload follows. ` + `WORK_${i}_content_`.repeat(88) });
    }
    return out;
}

interface Harness {
    bodies: string[];
    sessionOf: (label: string) => { id: string; state: { messageRefs: { byRaw: Record<string, string> }; blocks: Array<{ active: boolean }> } } | undefined;
    url: string;
    proxy: http.Server;
    upstream: http.Server;
    store: SessionStore;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const root = mkdtempSync(path.join(tmpdir(), "seq-ledger-e2e-"));
    const store = new SessionStore({ enabled: true, dir: path.join(root, "sessions"), debounceMs: 0 });
    _setStoreForTest(store);
    let n = 0;
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            n += 1;
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            if (n === 1) {
                res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00008", topic: "setup", summary: SUMMARY }] }) } }] } }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
            } else if (n === 2) {
                res.write(`data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "done compressing" }, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            } else {
                res.write(`data: ${JSON.stringify({ id: "c3", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `ok ${n}` }, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ id: "c3", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 15000,
        kernelConfig: defaultConfig(15000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions;
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    try {
        await fn({ bodies, sessionOf: (label) => listSessions().find((s) => s.meta.label === label) as never, url: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, proxy, upstream, store });
    } finally {
        delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
        (proxy as http.Server).closeAllConnections?.();
        await new Promise<void>((r) => proxy.close(() => r()));
        (upstream as http.Server).closeAllConnections?.();
        await new Promise<void>((r) => upstream.close(() => r()));
        await store.closeQuietly();
        _resetSessionsForTest();
        rmrf(root);
    }
}

async function turn(h: Harness, label: string, messages: Array<{ role: string; content: string }>, history: Array<{ role: string; content: string }> | null): Promise<{ status: number; body: string; idx: number }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const data = JSON.stringify({ model: "gpt-test", messages, stream: true });
    const req = http.request(h.url, { method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)), "x-acp-session": label } }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end(data);
    const r = await promise;
    await new Promise((r2) => setTimeout(r2, 120)); // debounceMs=0 write+ingest lands
    return { ...r, idx: h.bodies.length - 1 };
}

function refOf(s: string): number {
    const m = /<acp tokens="\d+" type="text"(?:\s[^<>]*)?>m(\d{5})<\/acp>/.exec(s);
    return m ? Number(m[1]) : 0;
}

test("S2: snapshot-render prefix refs equal the ledger positions (ref = indexToRef(seq+1))", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, "seq-ledger-1", history, history);
        assert.equal(r1.status, 200, r1.body);
        const r2 = await turn(h, "seq-ledger-1", [...history, { role: "user", content: "TAIL_TURN_TWO_ASKS_FOR_A_SUMMARY. " + "TAIL_A_".repeat(80) }], history);
        assert.equal(r2.status, 200, r2.body);
        assert.ok(h.sessionOf("seq-ledger-1")!.state.blocks.some((b: { active: boolean }) => b.active), "block armed");
        // settle: the ingest of turn 2's view must land before the D view build
        const t0 = Date.now();
        for (;;) {
            try {
                const rows = getStore().unifiedTailViewRows("seq-ledger-1");
                if (rows !== null && rows.length > 0) break;
            } catch { /* not yet */ }
            if (Date.now() - t0 > 5000) throw new Error("settleRows: store tail view never appeared");
            await new Promise((r) => setTimeout(r, 50));
        }
        const r3 = await turn(h, "seq-ledger-1", [...history, { role: "user", content: "TAIL_TURN_TWO_ASKS_FOR_A_SUMMARY. " + "TAIL_A_".repeat(80) }, { role: "user", content: "TAIL_TURN_THREE_FOLLOWS_UP. " + "TAIL_B_".repeat(80) }], null);
        assert.equal(r3.status, 200, r3.body);
        const out3 = h.bodies[r3.idx] ?? "";
        const refsOf = (body: string): string[] => {
            const all = JSON.parse(body).messages as Array<{ role?: unknown; content?: unknown }>;
            return all
                .filter((m) => m.role !== "system" && typeof m.content === "string")
                .map((m) => (m.content as string).match(/<acp tokens="\d+" type="text"(?:\s[^<>]*)?>m\d{5}<\/acp>/)?.[0] ?? "")
                .filter((s) => s.length > 0);
        };
        const refs3 = refsOf(out3);
        assert.ok(refs3.length >= 8, `prefix messages carry acp refs (got ${refs3.length})`);

        // The seed-upgrade scenario (#3658/#3752 class): every message id is
        // re-minted on identical content. The D view serves the store rows —
        // the ref SET (the model's live citations) must be unchanged.
        const { __setMessageIdSaltForTests } = await import("acp-kernel/wire");
        __setMessageIdSaltForTests("upgrade-v2");
        try {
            const churnHistory = history.map((m, i) => ({ ...m, content: m.content + (i < 10 ? " " : "") }));
            const r4 = await turn(h, "seq-ledger-1", [...churnHistory, { role: "user", content: "TAIL_TURN_TWO_ASKS_FOR_A_SUMMARY. " + "TAIL_A_".repeat(80) }, { role: "user", content: "TAIL_TURN_THREE_FOLLOWS_UP. " + "TAIL_B_".repeat(80) }, { role: "user", content: "TAIL_TURN_FOUR_AFTER_CHURN. " + "TAIL_C_".repeat(80) }], null);
            assert.equal(r4.status, 200, r4.body);
            const refs4 = refsOf(h.bodies[r4.idx] ?? "");
            const prefix3 = refs3.slice(0, Math.min(refs3.length, refs4.length));
            const prefix4 = refs4.slice(0, prefix3.length);
            assert.deepEqual(prefix4, prefix3, "model-visible ref set is unchanged across a full id re-mint (ledger numbering)");
        } finally {
            __setMessageIdSaltForTests(undefined as never);
        }
    });
});

// Kernel seam, pinned directly: a store-served message that stamps its
// ledger position takes the ref that IS that position — even when the
// counter would have issued something else, and even at map-rebuild time.
test("S3: assignRefs honors ledgerSeq (ref = direct display of the ledger position)", async () => {
    const { assignRefs } = await import("acp-kernel");
    const base = {
        byRaw: { known: "m00003" },
        byRef: { m00003: "known" },
    };
    const res = assignRefs(
        [
            { id: "known", role: "user", contentType: "text", text: "already numbered" },
            { id: "fresh-ledger", role: "user", contentType: "text", text: "row seq 76 → display m00077", ledgerSeq: 77 },
            { id: "fresh-counter", role: "user", contentType: "text", text: "no stamp → counter path" },
        ],
        { existing: base, nextIndex: 1 },
    );
    assert.equal(res.map.byRaw["known"], "m00003", "known id keeps its ref");
    assert.equal(res.map.byRaw["fresh-ledger"], "m00077", "ledgerSeq 77 → m00077 directly");
    // The stamp advanced the cursor past 77, so the next counter allocation
    // can never collide with a future ledger stamp — it takes 78.
    assert.equal(res.map.byRaw["fresh-counter"], "m00078", "unstamped message takes the counter path, past the stamp");
    assert.ok(res.nextIndex > 77, "cursor advanced past the ledger stamp so future counter refs never collide");
    // Cold-rebuild shape: empty map, stamps arriving OUT OF ORDER — each row
    // must claim its own ledger number directly (order-independent), and the
    // cursor must land past the highest stamp so a later counter allocation
    // cannot collide. This is the case the stamp exists for: no prior map to
    // borrow numbers from, so the ledger IS the numbering authority.
    const cold = assignRefs(
        [
            { id: "row-a", role: "user", contentType: "text", text: "stored at seq 4", ledgerSeq: 5 },
            { id: "row-b", role: "user", contentType: "text", text: "stored at seq 8", ledgerSeq: 9 },
            { id: "row-c", role: "user", contentType: "text", text: "stored at seq 1", ledgerSeq: 2 },
        ],
        { existing: { byRaw: {}, byRef: {} }, nextIndex: 1 },
    );
    assert.equal(cold.map.byRaw["row-a"], "m00005", "out-of-order stamp claims its own number");
    assert.equal(cold.map.byRaw["row-b"], "m00009");
    assert.equal(cold.map.byRaw["row-c"], "m00002", "lower stamp below the cursor still claims its slot");
    assert.ok(cold.nextIndex >= 10, "cursor advanced past the highest stamp");
});
