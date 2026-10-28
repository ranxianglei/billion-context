// #4732: plugin render — a fold whose coverage reaches the END of the render
// window (pos === -1 in the anchor scan) used to drop its acp_summary anchor
// entirely while STILL suppressing the covered rows: the rendered prefix
// silently lost the whole fold with nothing in its place. The anchor must
// land at the tail and flush after the merge loop.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { rmrf } from "./tmp-rm.ts";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.js";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-pr-tail-"));
test.after(() => rmrf(testRoot));

const userMsg = (n: number, text = "hello") => ({ role: "user", content: `${text} ${n}`.repeat(40) });
const assistantMsg = (n: number) => ({ role: "assistant", content: `model answer ${n}` });
const CONV = "conv-tail-anchor";

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 100, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: {}, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once0(proxy);
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const turn = async (payload: Record<string, unknown>) => {
        payload = { conversationId: CONV, path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, ...payload };
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV },
            body: JSON.stringify(payload),
        });
        return { status: response.status, body: await response.json().catch(() => ({})), headers: response.headers };
    };
    const render = async (body: Record<string, unknown>) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/render`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh" },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const settle = async (want: number) => {
        for (let i = 0; i < 50; i++) {
            const rows = store.unifiedTailViewRows(CONV);
            if (rows && rows.length >= want) return rows;
            await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`rows never reached ${want}`);
    };
    return { turn, render, settle, store, close: async () => { store.closeQuietly(); await new Promise<void>((resolve) => proxy.close(() => resolve())); await new Promise<void>((resolve) => upstream.close(() => resolve())); } };
}

function once0(server: { once: (e: string, cb: () => void) => void }): Promise<void> {
    return new Promise((resolve) => server.once("listening", resolve));
}


function plantBlock(conv: string, coveredIds: string[]): void {
    const session = getSession(conv);
    (session.state.blocks as unknown[]).push({ blockId: "b_tail", active: true, effectiveMessageIds: coveredIds });
}

function textBlocks(body: unknown): string[] {
    const msgs = (body as { messages: { role: string; content: unknown }[] }).messages ?? [];
    const out: string[] = [];
    for (const m of msgs) {
        if (Array.isArray(m.content)) {
            for (const b of m.content as { type?: string; text?: string }[]) if (b.type === "text") out.push(b.text ?? "");
        } else if (typeof m.content === "string") out.push(m.content);
    }
    return out;
}

test("#4732: a fold covering the window's last rows keeps its anchor at the tail", async () => {
    const h = await harness();
    try {
        { const r = await h.turn({ conversationId: CONV, sinceSeq: 0, messages: [userMsg(1)] }); assert.equal(r.status, 200); }
        { const r = await h.turn({ conversationId: CONV, sinceSeq: 1, messages: [assistantMsg(1), userMsg(2, "second")] }); assert.equal(r.status, 200); }
        const rows = await h.settle(3);
        assert.equal(rows.length, 3);

        // Fold covers ONLY the first two rows: anchor lands mid-window (the
        // pre-existing working branch — must not regress). Anchors are
        // placeholder system rows that the wire codec merges into the
        // neighboring user turn as an empty text block; the corpus texts are
        // never empty, so empty text blocks ARE anchors here.
        plantBlock(CONV, [rows[0]!.msgId, rows[1]!.msgId]);
        const mid = await h.render({ conversationId: CONV, untilSeq: 3 });
        assert.equal(mid.status, 200, JSON.stringify(mid.body));
        const midTexts = textBlocks(mid.body);
        assert.equal(midTexts.filter((t) => t === "").length, 1, "mid-window anchor present");
        assert.equal(midTexts.filter((t) => t.includes("second 2")).length, 1, "the uncovered tail row survives");
        assert.equal(midTexts.filter((t) => t.includes("hello 1")).length, 0, "covered rows suppressed");

        // Fold covers ALL rows (anchor scan finds no row after maxCover):
        // the anchor must land at the tail, not vanish.
        const session = getSession(CONV);
        (session.state.blocks as unknown[]).push({ blockId: "b_full", active: true, effectiveMessageIds: [rows[0]!.msgId, rows[1]!.msgId, rows[2]!.msgId] });
        const tail = await h.render({ conversationId: CONV, untilSeq: 3 });
        assert.equal(tail.status, 200, JSON.stringify(tail.body));
        const tailTexts = textBlocks(tail.body);
        assert.equal(tailTexts.length, 2, "two blocks → two anchors, all covered rows suppressed");
        assert.equal(tailTexts.filter((t) => t === "").length, 2, "BOTH anchors survive — including the tail-reaching one");
        assert.ok(!tailTexts.some((t) => t !== ""), "no raw rows leak through the full coverage");
    } finally {
        await h.close();
    }
});
