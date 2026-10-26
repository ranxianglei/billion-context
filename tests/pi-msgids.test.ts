// #4491 pi host wiring: the pi extension carries the session's stable message
// ids on incremental lane turns (`msgIds`, parallel to the lane body's
// messages) so the server canonical (and the unified rows) carry the CLIENT's
// identity instead of content-derived hashes. Stakes:
//   ① a turn whose messages all resolve ids ships msgIds aligned with the
//      delta messages (seed AND delta), and the lane accepts them (200);
//   ② all-or-nothing — one unresolvable message and the WHOLE field is left
//      off (the lane falls back to content-derived ids, never a guess);
//   ③ resync turns (edit / branch divergence) carry msgIds over the full
//      history;
//   ④ a delta message that flattens to >1 core message (multi-block content)
//      omits msgIds — the lane pins ids 1:1 onto FLATTENED core messages and
//      hard-fails (400) on a count mismatch, so the host must not offer ids
//      it cannot align to that contract;
//   ⑤ tool turns: a tool_use assistant message + its single tool_result match
//      by tool-call id and pin their entry ids.
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
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";
import { __resetIncrementalClientForTests } from "../src/agent/incremental-client.ts";
import { __resetPiIncrementalOriginalsForTests } from "../src/agent/pi.ts";
import { createBiliPlugin } from "../src/agent/pi.ts";

process.env.NODE_ENV = "test";
process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
const testRoot = mkdtempSync(join(tmpdir(), "bili-pimsgids-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

function makeFakePi() {
    const events = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    const tools: unknown[] = [];
    return {
        events,
        tools,
        on: (event: string, handler: (event: never, ctx: never) => unknown) => {
            const list = events.get(event) ?? [];
            list.push(handler as (event: unknown, ctx: unknown) => unknown);
            events.set(event, list);
        },
        registerTool: (tool: unknown) => { tools.push(tool); },
        registerCommand: () => {},
        registerProvider: () => {},
        getSessionName: () => "test",
        fireAsync: async (name: string, event: unknown, ctx: unknown) => {
            const list = events.get(name) ?? [];
            let last: unknown;
            for (const h of list) last = await h(event, ctx);
            return last;
        },
    };
}

type LaneBody = { conversationId?: string; sinceSeq?: number; resync?: boolean; messages?: Array<{ role?: string; content?: unknown }>; msgIds?: string[]; system?: unknown };

type Harness = {
    proxyUrl: string;
    baseUrl: string;
    pi: ReturnType<typeof makeFakePi>;
    ctx: { sessionManager: { getSessionId: () => string; getBranch: () => unknown }; model: { id: string; contextWindow: number; api: string; baseUrl: string }; cwd: string };
    setBranch: (entries: unknown[]) => void;
    /** Stamp headers, swap the payload through the extension, POST it to the
     *  lane and deliver the ack. Returns the swapped lane body + result. */
    turn: (payload: Record<string, unknown>) => Promise<{ body: LaneBody; status: number; seq: number | undefined }>;
    close: () => Promise<void>;
};

async function withHarness(branch: unknown[], fn: (h: Harness) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    __resetIncrementalClientForTests();
    __resetPiIncrementalOriginalsForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    let currentBranch = branch;
    const ctx = {
        sessionManager: { getSessionId: () => "conv-pi-msgids", getBranch: () => currentBranch.slice() },
        model: { id: "claude-test", contextWindow: 400000, api: "anthropic", baseUrl: `${proxyUrl}/bili/${upstreamUrl}/v1` },
        cwd: dir,
    };
    const turn = async (payload: Record<string, unknown>) => {
        const headers: Record<string, string> = {};
        await pi.fireAsync("before_provider_headers", { headers }, ctx);
        const body = await pi.fireAsync("before_provider_request", { payload }, ctx) as LaneBody;
        const res = await fetch(`${ctx.model.baseUrl}/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
        const seqHeader = res.headers.get("x-bili-applied-seq");
        const ackHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => { ackHeaders[k] = v; });
        await res.text();
        await pi.fireAsync("after_provider_response", { status: res.status, headers: ackHeaders }, ctx);
        return { body, status: res.status, seq: seqHeader !== null && /^\d+$/.test(seqHeader) ? Number(seqHeader) : undefined };
    };
    try {
        await pi.fireAsync("session_start", {}, ctx);
        const deadline = Date.now() + 15000;
        while (pi.tools.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        assert.ok(pi.tools.length >= 2, `tools registered: ${pi.tools.length}`);
        await fn({ proxyUrl, baseUrl: `${ctx.model.baseUrl}/messages`, pi, ctx, setBranch: (entries) => { currentBranch = entries; }, turn, close: async () => undefined });
    } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        store.closeQuietly();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
}

// Session-entry shapes (pi SessionMessageEntry: {type:"message", id, parentId,
// timestamp, message}) with the AgentMessage payload the walker reads.
const entry = (id: string, message: Record<string, unknown>): Record<string, unknown> => ({ type: "message", id, parentId: null, timestamp: "2026-10-24T00:00:00.000Z", message });
const userMsg = (content: string): Record<string, unknown> => ({ role: "user", content, timestamp: 1 });
const assistantMsg = (blocks: unknown[]): Record<string, unknown> => ({ role: "assistant", content: blocks, api: "anthropic", provider: "anthropic", model: "claude-test", stopReason: "stop", timestamp: 1 });
const toolResultMsg = (toolCallId: string, text: string): Record<string, unknown> => ({ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 1 });

const PAYLOAD = (messages: unknown[]): Record<string, unknown> => ({ model: "claude-test", max_tokens: 1024, system: "be brief", messages });

test("pi msgids: seed and delta turns carry msgIds aligned with the delta messages", async () => {
    const hello = "hello".repeat(50);
    await withHarness([entry("e1", userMsg(hello))], async (h) => {
        // turn 1: seed — the full history rides the lane body with its ids.
        const t1 = await h.turn(PAYLOAD([{ role: "user", content: hello }]));
        assert.equal(t1.status, 200, "the lane accepts the pinned seed");
        assert.equal(t1.seq, 1);
        assert.deepEqual(t1.body.msgIds, ["e1"], "seed msgIds = the branch entry ids");
        assert.equal(t1.body.messages?.length, 1);
        assert.equal(t1.body.msgIds?.length, t1.body.messages?.length, "msgIds parallel to messages");

        // turn 2: the branch grew the assistant reply + the next user turn.
        h.setBranch([
            entry("e1", userMsg(hello)),
            entry("e2", assistantMsg([{ type: "text", text: "answer" }])),
            entry("e3", userMsg("next".repeat(50))),
        ]);
        const t2 = await h.turn(PAYLOAD([
            { role: "user", content: hello },
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
            { role: "user", content: "next".repeat(50) },
        ]));
        assert.equal(t2.status, 200, "the lane accepts the pinned delta");
        assert.equal(t2.body.sinceSeq, 1, "turn 2 is a delta");
        assert.equal(t2.body.messages?.length, 2, "delta ships only the suffix");
        assert.deepEqual(t2.body.messages?.map((m) => m.role), ["assistant", "user"]);
        assert.deepEqual(t2.body.msgIds, ["e2", "e3"], "delta msgIds = the suffix entry ids, aligned with messages");
        assert.equal(t2.body.msgIds?.length, t2.body.messages?.length, "msgIds parallel to messages");
    });
});

test("pi msgids: one unresolvable message omits the whole field (all-or-nothing)", async () => {
    const hello = "hello".repeat(50);
    // The branch holds an entry only for the first message — the assistant
    // reply and the follow-up have no entries (e.g. messages injected outside
    // the session, or a shape the walker cannot prove). No partial pinning.
    await withHarness([entry("e1", userMsg(hello))], async (h) => {
        const t = await h.turn(PAYLOAD([
            { role: "user", content: hello },
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
            { role: "user", content: "next".repeat(50) },
        ]));
        assert.ok(!("msgIds" in t.body), "no msgIds when any message has no provable id");
        assert.equal(t.status, 200, "the turn itself still works — content-derived ids");
        assert.equal(t.seq, 3, "seed applied the full history");
    });
});

test("pi msgids: a resync turn carries msgIds over the full diverged history", async () => {
    const hello = "hello".repeat(50);
    await withHarness([entry("e1", userMsg(hello))], async (h) => {
        const t1 = await h.turn(PAYLOAD([{ role: "user", content: hello }]));
        assert.equal(t1.status, 200);

        // The client edited the head / rewound the tree: a fresh branch whose
        // prefix no longer matches the acked one → the plan re-seeds with
        // resync:true and the FULL history — ids ride along.
        const edited = "hello-edited".repeat(50);
        h.setBranch([
            entry("f1", userMsg(edited)),
            entry("f2", assistantMsg([{ type: "text", text: "answer2" }])),
            entry("f3", userMsg("next".repeat(50))),
        ]);
        const t2 = await h.turn(PAYLOAD([
            { role: "user", content: edited },
            { role: "assistant", content: [{ type: "text", text: "answer2" }] },
            { role: "user", content: "next".repeat(50) },
        ]));
        assert.equal(t2.status, 200, "resync with ids must not be refused");
        assert.equal(t2.body.resync, true, "diverged prefix forces a resync");
        assert.equal(t2.body.messages?.length, 3, "resync ships the full history");
        assert.deepEqual(t2.body.msgIds, ["f1", "f2", "f3"], "resync msgIds cover the whole branch");
        assert.equal(t2.body.msgIds?.length, t2.body.messages?.length, "msgIds parallel to messages");
    });
});

test("pi msgids: a multi-block delta message omits msgIds (flatten contract, no 400)", async () => {
    const hello = "hello".repeat(50);
    await withHarness([entry("e1", userMsg(hello))], async (h) => {
        const t1 = await h.turn(PAYLOAD([{ role: "user", content: hello }]));
        assert.equal(t1.status, 200);

        // Assistant reply says something AND calls a tool: the wire assistant
        // message carries 2 blocks, which the lane flattens into 2 core
        // messages — an id array parallel to the WIRE messages would 400
        // (msgid length-mismatch), so the field must be withheld entirely.
        h.setBranch([
            entry("e1", userMsg(hello)),
            entry("e2", assistantMsg([{ type: "text", text: "checking" }, { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } }])),
            entry("e3", userMsg("next".repeat(50))),
        ]);
        const t2 = await h.turn(PAYLOAD([
            { role: "user", content: hello },
            { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }] },
            { role: "user", content: "next".repeat(50) },
        ]));
        assert.ok(!("msgIds" in t2.body), "multi-block delta message → no msgIds (degrade, never a 400)");
        assert.equal(t2.status, 200, "the turn still applies via content-derived ids");
        assert.equal(t2.seq, 4, "2-block assistant + user flatten to 3 core messages past the seed");
    });
});

test("pi msgids: tool turns pin tool_use and tool_result entry ids by call id", async () => {
    const hello = "hello".repeat(50);
    await withHarness([entry("e1", userMsg(hello))], async (h) => {
        const t1 = await h.turn(PAYLOAD([{ role: "user", content: hello }]));
        assert.equal(t1.status, 200);

        h.setBranch([
            entry("e1", userMsg(hello)),
            entry("e2", assistantMsg([{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } }])),
            entry("e3", toolResultMsg("t1", "file-a\nfile-b")),
            entry("e4", userMsg("next".repeat(50))),
        ]);
        const t2 = await h.turn(PAYLOAD([
            { role: "user", content: hello },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file-a\nfile-b" }] },
            { role: "user", content: "next".repeat(50) },
        ]));
        assert.equal(t2.status, 200, "the lane accepts the pinned tool delta");
        assert.deepEqual(t2.body.msgIds, ["e2", "e3", "e4"], "tool_use + tool_result + follow-up pin their entry ids");
        assert.equal(t2.body.msgIds?.length, t2.body.messages?.length, "msgIds parallel to messages");
    });
});
