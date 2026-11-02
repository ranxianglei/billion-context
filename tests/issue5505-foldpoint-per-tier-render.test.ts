// #5505 sub-item A: the S4 plugin-render path must resolve the fold-point knob
// from the SAME source as steady turns — the session's last cascade-resolved
// Config stamp (#833) — not env + the global `compress` section alone. Before
// this, a provider/model-tier opt-OFF moved compress pairs on steady turns but
// left them put on the S4 render path, so the two layouts diverged for the same
// conversation. This pins the fix end-to-end through POST /__bili/plugin/render:
// with the flag resolving ON the still-visible compress pair is relocated to its
// fold point; with a per-tier opt-OFF stamped onto the session it stays put —
// i.e. the render follows the session-resolved flag, not the global default.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmrf } from "./tmp-rm.ts";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { getSession, storeEffectiveConfig, _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.js";
import { PLUGIN_RENDER_PATH } from "../src/plugin-render.js";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-fp-tier-"));
test.after(() => rmrf(testRoot));

const CONV = "conv-fp-tier";
const CALLID = "call_fold_point";

interface BlockLite { blockId: string; active: boolean; effectiveMessageIds: string[]; compressCallId: string; startRef: string; endRef: string; }

/** Flatten a render body into an ordered marker sequence: the compress pair's
 *  cores and the one post-fold survivor that brackets the insertion point. */
function tokenSeq(body: unknown): string[] {
    const msgs = ((body as { messages?: { content?: unknown }[] }).messages ?? []);
    const out: string[] = [];
    for (const m of msgs) {
        const arr = Array.isArray(m.content) ? (m.content as { type?: string; name?: string; text?: string }[]) : [];
        for (const b of arr) {
            if (b.type === "tool_use" && b.name === "compress") out.push("CALL");
            else if (b.type === "tool_result") out.push("RESULT");
            else if (b.type === "text" && typeof b.text === "string" && b.text.includes("gamma")) out.push("GAMMA");
        }
    }
    return out;
}

test("S4 render follows the session-resolved fold-point flag (per-tier opt-off consistency)", async () => {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1";
    // Ingest with the knob pinned OFF so the turn's own pipeline lays the pair
    // down "in place" (input order) and performs NO view relocation — otherwise
    // its debounce-settled relocation races our render and flips the baseline.
    process.env.BILI_COMPRESS_AT_FOLD_POINT = "off";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 15 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 100, output_tokens: 10 } })); });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: {}, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    try {
        const turn = async (sinceSeq: number, messages: unknown[]) => {
            const r = await fetch(`${proxyUrl}/__bili/plugin/turn`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV }, body: JSON.stringify({ conversationId: CONV, path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, sinceSeq, messages }) });
            return { status: r.status, applied: r.headers.get("x-bili-applied-seq"), body: await r.json().catch(() => null) };
        };
        const render = async () => {
            const r = await fetch(`${proxyUrl}${PLUGIN_RENDER_PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "dsh" }, body: JSON.stringify({ conversationId: CONV, untilSeq: 6 }) });
            return { status: r.status, body: await r.json().catch(() => null) };
        };

        // alpha/beta become the folded region; gamma is the first SURVIVOR after
        // the fold (its ref exceeds the block boundary); the compress pair sits
        // between gamma and delta so relocation has somewhere observable to move it.
        const r1 = await turn(0, [
            { role: "user", content: "alpha one" },
            { role: "user", content: "beta two" },
            { role: "user", content: "gamma three" },
            { role: "assistant", content: [{ type: "tool_use", id: CALLID, name: "compress", input: { ranges: [] } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: CALLID, content: "ok folded" }] },
            { role: "user", content: "delta four" },
        ]);
        assert.equal(r1.status, 200, JSON.stringify(r1.body));
        assert.equal(r1.applied, "6");

        let rows: ReturnType<typeof store.unifiedTailViewRows> | undefined;
        for (let i = 0; i < 300; i++) { rows = store.unifiedTailViewRows(CONV); if (rows && rows.length >= 6) break; await new Promise((r) => setTimeout(r, 20)); }
        assert.ok(rows && rows.length >= 6, "six canonical rows must settle");
        // Ingestion is done; drop the pin so the render gate resolves purely from
        // the session-resolved stamp (env undefined → resolveCompressAtFoldPoint
        // honors the stamped boolean). The stored layout is now stably "in place".
        delete process.env.BILI_COMPRESS_AT_FOLD_POINT;

        const session = getSession(CONV);
        // Incremental ingest stores canonical rows but does not assign refs (a
        // full steady-turn processTurn does). Populate byRaw the way assign-refs
        // would — monotonic by ledger position — so the render-time relocation
        // sees the same ref space a live session carries.
        for (const row of rows!) session.state.messageRefs.byRaw[row.msgId] = `m${String(row.seq + 1).padStart(5, "0")}`;
        const callRow = rows!.find((row) => (JSON.parse(row.content) as { contentType?: string; toolName?: string }).contentType === "tool-call" && (JSON.parse(row.content) as { toolName?: string }).toolName === "compress");
        assert.ok(callRow, "the compress tool-call row must round-trip as a visible tool-call");
        const callContent = JSON.parse(callRow!.content) as { toolCallId?: string };
        (session.state.blocks as unknown[]).push({ blockId: "b1", active: true, effectiveMessageIds: [rows![0]!.msgId, rows![1]!.msgId], compressCallId: callContent.toolCallId ?? CALLID, startRef: "m00001", endRef: "m00002" } satisfies BlockLite);

        // Flag resolves ON (what a steady turn against a default-on model stamps):
        // the pair must relocate to sit before the first post-fold survivor.
        storeEffectiveConfig(session, { ...defaultConfig(400000), compressAtFoldPoint: true });
        const on = await render();
        assert.equal(on.status, 200, JSON.stringify(on.body));
        const onSeq = tokenSeq(on.body);
        assert.ok(onSeq.includes("CALL") && onSeq.includes("RESULT") && onSeq.includes("GAMMA"), `fixture markers missing: ${onSeq}`);
        assert.ok(onSeq.indexOf("CALL") < onSeq.indexOf("GAMMA"), `flag-on must relocate the pair before the post-fold survivor: ${onSeq}`);
        assert.ok(onSeq.indexOf("CALL") < onSeq.indexOf("RESULT"), `pair integrity: call precedes result: ${onSeq}`);

        // Flag resolves OFF (what a steady turn against a per-tier opt-OFF model
        // stamps): the pair must stay put — the render honors the stamp instead
        // of falling back to the global default-on. This is the line the pre-fix
        // code got wrong.
        storeEffectiveConfig(session, { ...defaultConfig(400000), compressAtFoldPoint: false });
        const off = await render();
        assert.equal(off.status, 200, JSON.stringify(off.body));
        const offSeq = tokenSeq(off.body);
        assert.ok(offSeq.includes("CALL") && offSeq.includes("RESULT") && offSeq.includes("GAMMA"), `fixture markers missing: ${offSeq}`);
        assert.ok(offSeq.indexOf("GAMMA") < offSeq.indexOf("CALL"), `per-tier opt-off must leave the pair in place: ${offSeq}`);

        assert.notDeepEqual(onSeq, offSeq, "the two layouts must differ — relocation is the only variable between them");
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY;
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        store.closeQuietly();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
});
