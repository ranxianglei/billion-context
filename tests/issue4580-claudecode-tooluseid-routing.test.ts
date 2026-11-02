// #4580: Claude Code Task subagents share ONE MCP shim process with their
// parent, so the shim's captured binding names the parent conversation while
// the subagent's traffic streams through a different proxy lane — its bili
// calls compressed the WRONG conversation (or died on the #2024/#4168
// witness 409). Claude Code ≥2.1.308 stamps every tools/call with the
// originating tool_use id at _meta["claudecode/toolUseId"]; this file pins
// the three layers of the fix:
//   1. recording — every response pipe that feeds the #1685 witness ring
//      also rings the tool_use id → session map (streaming anthropic/openai
//      chat, streaming responses, non-stream JSON for all protocols);
//   2. routing  — a tools/call POST whose toolCallId is known to the id ring
//      routes to the witnessing lane with host-stamped (#2024) authority,
//      skipping the witness-conflict 409 entirely; unknown/absent ids leave
//      the existing ladder untouched (fail-closed semantics unchanged);
//   3. shim     — mcp.ts forwards _meta["claudecode/toolUseId"] as body
//      toolCallId without touching any routing channel or the global
//      binding.
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/session.ts";

const { pipePluginChatWithStrip, pipePluginJson, pipePluginResponsesWithStrip, _resetPluginStateForTest, handlePluginTool } = await import("../src/plugin.ts");
const { recordToolUseId, lookupToolUseIdSession, resetToolRingForTest, _setToolRingClockForTest } = await import("../src/tool-ring.ts");
const { getSession } = await import("../src/session.ts");
const { createCore, defaultConfig } = await import("acp-kernel");
type PluginToolDeps = import("../src/plugin.ts").PluginToolDeps;

function makeSession(id: string): Session {
    return {
        id,
        protocol: "anthropic",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function anthropicToolUseTurn(id: string): string[] {
    return [
        sse("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant" } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "compress" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"startId":"m00001",' } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"endId":"m00009","summary":"4580 lane test"}' } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
        sse("message_stop", { type: "message_stop" }),
    ];
}

// ─────────────────── 1. recording: pipes ring the id → lane map ──────────────

describe("#4580 recording: response pipes ring tool_use ids per lane", () => {
    beforeEach(() => {
        resetToolRingForTest();
    });

    test("anthropic chat SSE: subagent lane's tool_use id maps to the lane session", async () => {
        await pipePluginChatWithStrip(streamOf(anthropicToolUseTurn("toolu_sub_1")), makeRes([]), "anthropic", makeSession("lane-sub"));
        assert.equal(lookupToolUseIdSession("toolu_sub_1"), "lane-sub");
    });

    test("openai chat SSE: tool_calls id maps to the lane session", async () => {
        const events = [
            `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_oai_1", type: "function", function: { name: "compress", arguments: '{"startId":"m00001","endId":"m00009","summary":"4580 lane test"}' } }] }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes([]), "openai", makeSession("lane-oai"));
        assert.equal(lookupToolUseIdSession("call_oai_1"), "lane-oai");
    });

    test("responses SSE: function_call item id maps to the lane session", async () => {
        const events = [
            sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
            sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", name: "compress", arguments: "" } }),
            sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"startId":"m00001","endId":"m00009","summary":"4580 lane test"}' }),
            sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", name: "compress", arguments: '{"startId":"m00001","endId":"m00009","summary":"4580 lane test"}' } }),
            sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed" } }),
        ];
        await pipePluginResponsesWithStrip(streamOf(events), makeRes([]), makeSession("lane-resp"));
        assert.equal(lookupToolUseIdSession("fc_1"), "lane-resp");
    });

    test("non-stream anthropic JSON: tool_use id maps to the lane session", async () => {
        const json = { content: [{ type: "tool_use", id: "toolu_json_1", name: "compress", input: { startId: "m00001", endId: "m00009", summary: "4580 lane test" } }] };
        await pipePluginJson(streamOf([JSON.stringify(json)]), makeRes([]), makeSession("lane-json"), "anthropic");
        assert.equal(lookupToolUseIdSession("toolu_json_1"), "lane-json");
    });

    test("two lanes, two ids: the parent's id and the subagent's id map apart", async () => {
        await pipePluginChatWithStrip(streamOf(anthropicToolUseTurn("toolu_parent")), makeRes([]), "anthropic", makeSession("lane-parent"));
        await pipePluginChatWithStrip(streamOf(anthropicToolUseTurn("toolu_sub_2")), makeRes([]), "anthropic", makeSession("lane-sub2"));
        assert.equal(lookupToolUseIdSession("toolu_parent"), "lane-parent");
        assert.equal(lookupToolUseIdSession("toolu_sub_2"), "lane-sub2");
    });

    test("TTL: an id older than ten minutes stops naming a lane", () => {
        let clock = 1_000_000;
        _setToolRingClockForTest(() => clock);
        try {
            recordToolUseId("toolu_old", "lane-old");
            clock += 10 * 60 * 1000 + 1;
            assert.equal(lookupToolUseIdSession("toolu_old"), undefined);
        } finally {
            _setToolRingClockForTest(undefined);
        }
    });

    test("malformed ids are ignored (never recorded, never resolved)", () => {
        recordToolUseId("", "lane-x");
        recordToolUseId("x".repeat(513), "lane-x");
        assert.equal(lookupToolUseIdSession(""), undefined);
        assert.equal(lookupToolUseIdSession("x".repeat(513)), undefined);
    });

    test("capacity eviction drops the least-recently-seen id, not the first-inserted", () => {
        // A re-record keeps its insertion slot but refreshes its timestamp —
        // the first-inserted id can be the FRESHEST entry, so eviction must
        // order by time, never by map position.
        let clock = 2_000_000;
        _setToolRingClockForTest(() => clock);
        try {
            const anchor = "toolu_anchor";
            recordToolUseId(anchor, "lane-anchor"); // slot 1
            clock += 1;
            for (let i = 0; i < 1023; i++) { // slots 2..1024 → exactly at cap
                recordToolUseId(`toolu_fill_${i}`, "lane-fill");
                clock += 1;
            }
            clock += 1000;
            recordToolUseId(anchor, "lane-anchor"); // re-record: newest by time, still slot 1
            recordToolUseId("toolu_newest", "lane-newest"); // overflows the cap → one eviction
            assert.equal(lookupToolUseIdSession(anchor), "lane-anchor", "re-recorded anchor survives: it is the newest by time");
            assert.equal(lookupToolUseIdSession("toolu_fill_0"), undefined, "true oldest entry (by time) is evicted");
            assert.equal(lookupToolUseIdSession("toolu_newest"), "lane-newest");
        } finally {
            _setToolRingClockForTest(undefined);
        }
    });
});

// ─────────────────── 2. routing: the id outranks a stale binding ─────────────

describe("#4580 routing: host-stamped toolCallId routes to the witnessing lane", () => {
    let deps: PluginToolDeps;
    let logs: string[];

    beforeEach(() => {
        _resetPluginStateForTest();
        resetToolRingForTest();
        logs = [];
        deps = { core: createCore(), config: defaultConfig(400_000), log: (_lvl: string, msg: string) => { logs.push(msg); } };
    });

    async function post(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
        let outBody = "";
        let status = 0;
        const res = {
            writeHead: (code: number) => { status = code; return undefined; },
            end: (chunk: unknown) => { outBody = String(chunk ?? ""); },
        } as unknown as import("node:http").ServerResponse;
        await handlePluginTool(JSON.stringify(body), res, deps);
        return { status, json: JSON.parse(outBody) as Record<string, unknown> };
    }

    function executedOn(): string[] {
        return logs.filter((m) => m.includes("executed via plugin")).map((m) => m.split("]")[0]?.slice(1) ?? "");
    }

    test("subagent call: stale parent binding + sub lane id → executes on the sub lane", async () => {
        const parent = getSession("t4580-parent");
        const sub = getSession("t4580-sub");
        parent.lastSeen = Date.now();
        sub.lastSeen = Date.now();
        // The shim's binding names the parent; the proxy witnessed this exact
        // tool_use in the SUB lane's stream (see the recording tests above).
        recordToolUseId("toolu_sub_route", sub.id);
        const r = await post({ conversationId: parent.id, tool: "acp_status", args: {}, toolCallId: "toolu_sub_route" });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [sub.id]);
        assert.ok(logs.some((m) => m.includes("routed by host call id (#4580)") && m.includes(sub.id)), "must log the id-routed lane");
    });

    test("id ring miss: identical POST without a known id keeps the legacy ladder (no silent fallback)", async () => {
        const parent = getSession("t4580-parent2");
        const sub = getSession("t4580-sub2");
        recordToolUseId("toolu_other", sub.id); // a DIFFERENT id — no hit
        const r = await post({ conversationId: parent.id, tool: "acp_status", args: {}, toolCallId: "toolu_never_seen" });
        // Legacy ladder: body id resolves the parent — unchanged behavior.
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [parent.id]);
        assert.ok(!logs.some((m) => m.includes("#4580")), "a ring miss must not claim id routing");
    });

    test("empty or oversized toolCallId: rejected as INVALID_REQUEST (parity with the existing validation)", async () => {
        const r1 = await post({ conversationId: "x", tool: "acp_status", args: {}, toolCallId: "" });
        assert.equal(r1.status, 400);
        assert.equal(r1.json.code, "INVALID_REQUEST");
        const r2 = await post({ conversationId: "x", tool: "acp_status", args: {}, toolCallId: "y".repeat(513) });
        assert.equal(r2.status, 400);
        assert.equal(r2.json.code, "INVALID_REQUEST");
    });

    test("id routing is not fooled by a witness conflict: hash ladder stays untouched for id-less calls", async () => {
        const parent = getSession("t4580-parent3");
        const sub = getSession("t4580-sub3");
        // Same (name, args) witnessed ONLY in the sub lane: an id-less POST
        // carrying the parent's id must keep failing closed with the #4168
        // 409 (single named witness), not execute anywhere.
        recordToolUseId("toolu_unused", sub.id);
        const { recordToolWitness } = await import("../src/tool-ring.ts");
        recordToolWitness(sub.id, "acp_status", {});
        const r = await post({ conversationId: parent.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 409);
        assert.equal(r.json.code, "TOOL_CONVERSATION_CONFLICT");
        assert.deepEqual(executedOn(), []);
    });
});

// ─────────────────── 3. shim: _meta → body toolCallId ────────────────────────

describe("#4580 shim: claudecode/toolUseId forwards as body toolCallId", () => {
    test("forwardTool carries the id next to the routing channel", async () => {
        const posts: Array<Record<string, unknown>> = [];
        const server = (await import("node:http")).createServer((req, res) => {
            let raw = "";
            req.on("data", (c) => { raw += c; });
            req.on("end", () => {
                posts.push(JSON.parse(raw) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: "done", outcome: "success" }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        process.env.BILI_MCP_PROXY = `http://127.0.0.1:${port}`;
        try {
            const { forwardTool: shimForward } = await import("../src/mcp.ts");
            const out = await shimForward("acp_status", {}, 2_000, "conv-bound-root", false, "toolu_fwd_1");
            assert.equal(out.failed, false);
            assert.equal(posts.length, 1);
            assert.equal(posts[0]?.toolCallId, "toolu_fwd_1");
            assert.equal(posts[0]?.conversationId, "conv-bound-root");
            assert.equal(posts[0]?.nativeCaller, undefined, "id forwarding alone must not claim native authority");
        } finally {
            delete process.env.BILI_MCP_PROXY;
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
