// #4491 S4/S6 stakes: POST /__bili/plugin/render serves the outbound prefix
// from the server-owned transcript (unified storage), degrades honestly
// (gate off → 404 feature-off; unreadable/cold → 503), and never leaks the
// biliMsgIds channel upstream. Plus the lane-side half of S5: client msgids
// ride the turn payload, pin the canonical rows, and get re-stamped onto
// every assembled body.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { coreToAnthropic } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.js";
import { PLUGIN_RENDER_PATH } from "../src/plugin-render.js";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-prerender-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

interface Harness {
    proxyUrl: string;
    turn: (payload: Record<string, unknown>) => Promise<{ status: number; headers: Headers; body: unknown }>;
    render: (body: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>;
    probe: () => Promise<{ status: number; body: { ok?: boolean; enabled?: boolean; serverHistory?: boolean } }>;
    forwarded: Record<string, unknown>[];
    store: SessionStore;
    close: () => Promise<void>;
}

async function harness(gateOn: boolean): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    if (gateOn) process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1";
    else delete process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 100, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const CONV = "conv-render-1";
    const turn = async (payload: Record<string, unknown>) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV },
            body: JSON.stringify({ conversationId: CONV, path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, ...payload }),
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, headers: response.headers, body };
    };
    const render = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
        const response = await fetch(`${proxyUrl}${PLUGIN_RENDER_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", ...headers },
            body: JSON.stringify(body),
        });
        const parsed: unknown = await response.json().catch(() => null);
        return { status: response.status, body: parsed ?? {} };
    };
    const probe = async () => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, { method: "GET", headers: { "x-bili-plugin": "dsh" } });
        const body = (await response.json().catch(() => ({}))) as { ok?: boolean; enabled?: boolean; serverHistory?: boolean };
        return { status: response.status, body };
    };
    return {
        proxyUrl, turn, render, probe, forwarded, store,
        close: async () => {
            delete process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY;
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            store.closeQuietly();
            await new Promise<void>((resolve) => upstream.close(() => resolve()));
        },
    };
}

const userMsg = (n: number, text = "hello") => ({ role: "user", content: `${text} ${n}`.repeat(40) });
const assistantMsg = (n: number) => ({ role: "assistant", content: `model answer ${n}` });

/** The lane's post-response writeNow + raw-tail ingest is async — poll until
 *  the unified tail view reaches the expected size (or fail loudly). */
async function settle(h: Harness, conv: string, want: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
        const n = h.store.unifiedTailSeqs(conv)?.length ?? 0;
        if (n >= want) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`settle: unified tail view for ${conv} never reached ${want} rows`);
}

test("probe advertises serverHistory with the gate state (capability discovery)", async () => {
    const off = await harness(false);
    try {
        const p = await off.probe();
        assert.equal(p.status, 200);
        assert.equal(p.body.serverHistory, false, "default rollout 0% = capability hidden");
    } finally {
        await off.close();
    }
    const on = await harness(true);
    try {
        const p = await on.probe();
        assert.equal(p.status, 200);
        assert.equal(p.body.serverHistory, true, "gate on = capability advertised");
    } finally {
        await on.close();
    }
});

test("S6 degradation: gate off → 404 feature-off, no partial render", async () => {
    const h = await harness(false);
    try {
        const r = await h.render({ conversationId: "conv-render-1", untilSeq: 0 });
        assert.equal(r.status, 404);
        assert.equal((r.body as { ok?: boolean }).ok, false);
        assert.equal((r.body as { error?: string }).error, "feature-off");
    } finally {
        await h.close();
    }
});

test("render validation: agent header required; body fields strictly checked", async () => {
    const h = await harness(true);
    try {
        const noAgent = await fetch(`${h.proxyUrl}${PLUGIN_RENDER_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "c", untilSeq: 0 }) });
        assert.equal(noAgent.status, 400);
        for (const body of [{ untilSeq: 0 }, { conversationId: "", untilSeq: 0 }, { conversationId: "c" }, { conversationId: "c", untilSeq: -1 }, { conversationId: "c", untilSeq: 1_000_001 }, { conversationId: "c", untilSeq: "3" }]) {
            const r = await h.render(body);
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.equal((r.body as { ok?: boolean }).ok, false);
        }
    } finally {
        await h.close();
    }
});

test("render degradation: unknown conversation → 503 (transcript-empty), never an empty 200", async () => {
    const h = await harness(true);
    try {
        const r = await h.render({ conversationId: "never-existed", untilSeq: 5 });
        assert.equal(r.status, 503);
        assert.equal((r.body as { ok?: boolean }).ok, false);
    } finally {
        await h.close();
    }
});

test("S4 happy path: rendered prefix is the pure codec over the stored canonical rows", async () => {
    const h = await harness(true);
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userMsg(1)] });
        assert.equal(seed.status, 200);
        assert.equal(seed.headers.get("x-bili-applied-seq"), "1");
        const delta = await h.turn({ sinceSeq: 1, messages: [assistantMsg(1), userMsg(2, "second")] });
        assert.equal(delta.status, 200);
        assert.equal(delta.headers.get("x-bili-applied-seq"), "3");
        await settle(h, "conv-render-1", 3);

        const r = await h.render({ conversationId: "conv-render-1", untilSeq: 2 });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const out = r.body as { ok: boolean; appliedSeq: number; messages: { role: string; content: unknown }[] };
        assert.equal(out.ok, true);
        assert.equal(out.appliedSeq, 2);
        assert.deepEqual(out.messages.map((m) => m.role), ["user", "assistant"]);

        // Contract: the prefix is the PURE codec output over the stored
        // canonical rows (folds applied, anchors spliced). The pipeline's
        // later modifications of a live request (tag rendering, system
        // injection, mark computation) are orthogonal — they apply to the
        // spliced request exactly as they do to any plugin-lane traffic.
        const rows = h.store.unifiedTailViewRows("conv-render-1");
        assert.ok(rows && rows.length === 3);
        const expectedPrefix = coreToAnthropic(rows.slice(0, 2).map((r) => JSON.parse(r.content) as never));
        assert.deepEqual(out.messages, expectedPrefix);

        // untilSeq clamps to the view size; zero renders an empty prefix.
        const clamped = await h.render({ conversationId: "conv-render-1", untilSeq: 99 });
        assert.equal(clamped.status, 200);
        assert.equal((clamped.body as { appliedSeq: number }).appliedSeq, 3);
        const zero = await h.render({ conversationId: "conv-render-1", untilSeq: 0 });
        assert.equal(zero.status, 200);
        assert.deepEqual((zero.body as { messages: unknown[] }).messages, []);
    } finally {
        await h.close();
    }
});

test("S5 server half: msgids pin the canonical rows and never leak upstream", async () => {
    const h = await harness(true);
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userMsg(1)], msgIds: ["pin-c1"] });
        assert.equal(seed.status, 200, JSON.stringify(seed.body));
        assert.equal(seed.headers.get("x-bili-applied-seq"), "1");
        const delta = await h.turn({ sinceSeq: 1, messages: [assistantMsg(1), userMsg(2, "second")], msgIds: ["derived-a1", "pin-c2"] });
        assert.equal(delta.status, 200, JSON.stringify(delta.body));
        await settle(h, "conv-render-1", 3);

        // The rows carry the client ids as their identity.
        const rows = h.store.unifiedTailViewRows("conv-render-1");
        assert.ok(rows && rows.length === 3);
        const ids = rows.map((r) => r.msgId);
        assert.ok(ids.includes("pin-c1"), `row ids ${JSON.stringify(ids)} must include the pinned seed id`);
        assert.ok(ids.includes("pin-c2"), `row ids ${JSON.stringify(ids)} must include the pinned delta id`);

        // The channel is internal: biliMsgIds never reaches the real upstream
        // (the mock IS the upstream here — absence in its received bodies
        // proves the strip). The row identities above are the observable
        // proof of the full chain: client id → lane stamp → pipeline pin → row.
        for (const f of h.forwarded) assert.ok(!("biliMsgIds" in f), "biliMsgIds must never reach the upstream");
    } finally {
        await h.close();
    }
});

test("S5 guard rails: poison msgids hard-fail; count mismatch degrades silently", async () => {
    const h = await harness(true);
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userMsg(1)], msgIds: ["pin-a"] });
        assert.equal(seed.status, 200);
        // Reusing a canonical id in a later delta = identity collision → 400.
        const reuse = await h.turn({ sinceSeq: 1, messages: [assistantMsg(1)], msgIds: ["pin-a"] });
        assert.equal(reuse.status, 400);
        assert.match(JSON.stringify(reuse.body), /reuse an existing canonical id/);
        // A reserved-prefix id is kernel anchor namespace → 400.
        const reserved = await h.turn({ sinceSeq: 1, messages: [assistantMsg(1)], msgIds: ["acp_summary_x"] });
        assert.equal(reserved.status, 400);
        assert.match(JSON.stringify(reserved.body), /reserved-prefix/);
        // Count mismatch: the ids are IGNORED (warn), the turn still applies
        // with content-derived identities.
        const mismatch = await h.turn({ sinceSeq: 1, messages: [assistantMsg(1)], msgIds: ["only-one"] });
        assert.equal(mismatch.status, 200);
        assert.equal(mismatch.headers.get("x-bili-applied-seq"), "2");
    } finally {
        await h.close();
    }
});

/** #4732: seed 3 rows, then attach an active fold block covering the given
 *  row indices (by stored-row message id) to the warm in-memory session. */
async function seedFolded(h: Harness, coverIdx: number[], blockId: string): Promise<void> {
    const seed = await h.turn({ sinceSeq: 0, messages: [userMsg(1)] });
    assert.equal(seed.status, 200);
    const delta = await h.turn({ sinceSeq: 1, messages: [assistantMsg(1), userMsg(2, "second")] });
    assert.equal(delta.status, 200);
    await settle(h, "conv-render-1", 3);
    const rows = h.store.unifiedTailViewRows("conv-render-1");
    assert.ok(rows && rows.length === 3);
    const ids = rows.map((r) => (JSON.parse(r.content) as { id: string }).id);
    const session = peekSession("conv-render-1");
    assert.ok(session, "session must be warm after turns");
    session.state.blocks.push({
        blockId, runId: `r-${blockId}`, tier: 1, summary: `${blockId} summary`,
        directMessageIds: coverIdx.map((i) => ids[i]), effectiveMessageIds: coverIdx.map((i) => ids[i]),
        directBlockIds: [], compressedTokens: 100, createdAt: Date.now(),
        survivedCount: 1, generation: "young", active: true,
    });
}

interface WireMsg { role: string; content: unknown; }
function wireBlocks(m: WireMsg): { type?: string; text?: string }[] {
    return Array.isArray(m.content) ? m.content as { type?: string; text?: string }[] : [{ type: "text", text: String(m.content) }];
}

test("#4732 fold reaching the window tail keeps its acp_summary carrier (suppressed rows never render bare)", async () => {
    const h = await harness(true);
    try {
        // The ordinary post-compression state: the fold's last covered row IS
        // the transcript tail — nothing appended since the compress call.
        await seedFolded(h, [1, 2], "bTail");

        for (const untilSeq of [3, 2]) {
            const r = await h.render({ conversationId: "conv-render-1", untilSeq });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            const out = r.body as { ok: boolean; appliedSeq: number; messages: WireMsg[] };
            assert.equal(out.ok, true);
            assert.equal(out.appliedSeq, untilSeq);
            // Covered rows are suppressed but the carrier must ride at the window
            // tail: coreToAnthropic voices the system anchor as a user message
            // whose empty text block merges into the preceding user entry, so the
            // observable shape is one user message ending in the empty anchor block.
            assert.equal(out.messages.length, 1, JSON.stringify(out.messages));
            assert.equal(out.messages[0].role, "user");
            const blocks = wireBlocks(out.messages[0]);
            assert.equal(blocks.length, 2, `untilSeq=${untilSeq}: carrier missing — ${JSON.stringify(out.messages)}`);
            assert.deepEqual(blocks[blocks.length - 1], { type: "text", text: "" }, `untilSeq=${untilSeq}: trailing block must be the fold carrier`);
        }
    } finally {
        await h.close();
    }
});

test("#4732 negative direction: a fold NOT reaching the tail anchors mid-window as before", async () => {
    const h = await harness(true);
    try {
        await seedFolded(h, [0], "bMid");
        const r = await h.render({ conversationId: "conv-render-1", untilSeq: 3 });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const out = r.body as { ok: boolean; messages: WireMsg[] };
        assert.equal(out.ok, true);
        // Anchor first (before the assistant row), then the visible rows.
        assert.deepEqual(out.messages.map((m) => m.role), ["user", "assistant", "user"]);
        assert.deepEqual(wireBlocks(out.messages[0]), [{ type: "text", text: "" }]);
    } finally {
        await h.close();
    }
});
