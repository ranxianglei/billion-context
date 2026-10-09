// E2E: plugin-lane grow-and-compress — the codex/MCP reality, sediment of the
// 2026-09-30 verification session. tests/e2e-grow-compress.test.ts covers the
// KERNEL-lane in-band protocol (compressProtocol:"marker": the proxy itself
// interprets the model's tool call and forges the client reply). Real MCP
// hosts (codex, claude-code, any stdio MCP client) work differently:
//
//   1. the model streams a function_call (here named mcp__bili__compress —
//      the host-prefixed name codex puts on the wire);
//   2. the proxy RECORDS that outbound tool_use as a routing witness
//      (#1685) and forwards the call to the client untouched;
//   3. the host executes it through the MCP shim → POST /__bili/plugin/tool
//      — in this test ALWAYS id-less, so with a second active conversation
//      the only possible route is the witness ring (rung 1); arbitration
//      (rung 3) would refuse-to-guess (rung 4) and the test fails loudly;
//   4. the host echoes function_call + function_call_output back and the
//      next model request carries the FOLDED wire: the summary block lands
//      once, upstream bytes stay bounded while client history keeps growing.
//
// This is "actually seeing compression" on the plugin lane: the fold is
// executed by the real kernel through the real plugin tool endpoint, and
// its effect is asserted on the upstream wire bytes.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { after } from "node:test";
import type { ProxyOptions } from "../src/config.ts";

// XDG env BEFORE importing the server (auto-restart.test.ts pattern):
// loadConversations() at boot must not read the developer's production
// plugin-conversations.json — live sessions would count as fresh
// conversations and break the witness-only routing premise of this test.
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-plugin-grow-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { resetToolRingForTest } = await import("../src/tool-ring.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { setLogCapture } = await import("../src/logger.ts");
const { startChatRelay } = await import("./e2e/chat-relay.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

const TURNS = 120;
const LIVE_BYTES_THRESHOLD = 24 * 1024;
const CHARS_PER_TOKEN = 4;
const MSG_TOKENS = 100;
const CONV_A = "plugin-grow-a";
const CONV_B = "plugin-grow-b"; // second fresh conversation: makes rung-3 arbitration impossible, so every id-less tool POST MUST route by witness

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function userText(i: number): string {
    const filler = "the quick brown fox jumps over the lazy dog. ";
    return `user turn ${i}: ${filler.repeat(((MSG_TOKENS * CHARS_PER_TOKEN) / 46) | 0)}`;
}

function assistantText(i: number): string {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
    return `assistant reply ${i}: ${filler.repeat(((MSG_TOKENS * CHARS_PER_TOKEN) / 50) | 0)}`;
}

type RelayState = {
    upstreamReqs: { bytes: number; msgs: number; body: string }[];
    compressCalls: number;
    lastDemandBytes: number;
    sinceDemand: number;
    failedCompressions: number;
    /** Text body each text-turn emitted, in request order — lets the host
     *  side assert the client received EXACTLY one copy (#1778: a false
     *  retryEmptyTurn would stream the filler twice). */
    texts: string[];
};

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

/** Fake model behind the chat bridge: emits a codex-style MCP compress
 *  function call once the wire grows past the threshold, exactly like a
 *  nudged model would. */
function startMockChatRelay(state: RelayState): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const bytes = Buffer.byteLength(body);
            let liveMsgs = 0;
            try {
                const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
                for (const m of parsed.messages ?? []) {
                    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
                    if (c.length > 60) liveMsgs++;
                }
            } catch {
                liveMsgs = 0;
            }
            if (body.includes("Compression FAILED")) state.failedCompressions++;
            state.upstreamReqs.push({ bytes, msgs: liveMsgs, body });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const refIds = parseRefIds(body);
            state.sinceDemand++;
            const noShrinkAfterDemand = state.sinceDemand <= 2 && bytes >= state.lastDemandBytes * 0.9;
            const shouldCompress = bytes > LIVE_BYTES_THRESHOLD && refIds.length >= 12 && !noShrinkAfterDemand;
            if (shouldCompress) {
                state.lastDemandBytes = bytes;
                state.sinceDemand = 0;
                state.compressCalls++;
                const from = refIds[2]!;
                const to = refIds[refIds.length - 10]!;
                res.write(
                    sseLine({
                        id: "g1",
                        object: "chat.completion.chunk",
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    role: "assistant",
                                    content: null,
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: `call_compress_${state.compressCalls}`,
                                            type: "function",
                                            function: {
                                                name: "mcp__bili__compress",
                                                arguments: JSON.stringify({
                                                    topic: "plugin grow compress e2e",
                                                    content: [
                                                        {
                                                            startId: from,
                                                            endId: to,
                                                            topic: "plugin grow compress e2e",
                                                            summary: `plugin-lane summary of the folded middle segment: turns discussed incremental context growth, message stuffing and compression behavior on the MCP/plugin lane; key results were recorded at each checkpoint. ${from}..${to}`,
                                                        },
                                                    ],
                                                }),
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                );
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } }));
            } else {
                const text = assistantText(state.upstreamReqs.length);
                // #1778: plain-prose turns carry reasoning_content, arming the
                // pre-fix hazard — sawReasoning + fast-path text that never
                // entered visibleTextChars made retryEmptyTurn re-issue the
                // request and duplicate the already-delivered reply.
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: `pondering turn ${state.upstreamReqs.length} before answering` } }] }));
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] }));
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
                state.texts.push(text);
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

type StreamResult = { text: string; fnCall: { callId: string; name: string; arguments: string } | null };

/** Client-side responses-SSE parser: collects output_text deltas AND the
 *  function_call item (added → arguments.delta/.done), the two shapes a
 *  codex host consumes from the stream. */
async function readResponsesStream(res: Response): Promise<StreamResult> {
    let raw = "";
    for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
    let text = "";
    let fnCall: StreamResult["fnCall"] = null;
    let fnArgs = "";
    for (const block of raw.split("\n\n")) {
        let event = "";
        let data: Record<string, unknown> | undefined;
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) {
                try {
                    data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
                } catch {
                    data = undefined;
                }
            }
        }
        if (!data) continue;
        if (event === "response.output_text.delta" && typeof data.delta === "string") text += data.delta;
        if (event === "response.output_item.added") {
            const item = data.item as { type?: string; call_id?: string; name?: string } | undefined;
            if (item?.type === "function_call") {
                fnCall = { callId: item.call_id ?? "", name: item.name ?? "", arguments: "" };
                fnArgs = "";
            }
        }
        if (event === "response.function_call_arguments.delta" && typeof data.delta === "string") fnArgs += data.delta;
        if (event === "response.function_call_arguments.done" && typeof data.arguments === "string" && fnCall) fnCall.arguments = data.arguments;
    }
    if (fnCall && !fnCall.arguments) fnCall.arguments = fnArgs;
    return { text, fnCall };
}

type HistoryItem = Record<string, unknown>;

test("plugin-lane grow-and-compress: MCP host loop folds via /__bili/plugin/tool and keeps upstream bounded", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    resetToolRingForTest();
    const state: RelayState = { upstreamReqs: [], compressCalls: 0, lastDemandBytes: Infinity, sinceDemand: 99, failedCompressions: 0, texts: [] };
    // #1778: capture warn-level lines for the whole run — with the fast-path
    // accounting fix, NO turn may end flagged as degenerate (every turn here
    // delivers prose or a tool call), and the one-shot empty-turn retry must
    // never fire (would duplicate already-delivered text).
    const capturedWarns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") capturedWarns.push(msg); });
    const relay = startMockChatRelay(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const bridge = await startChatRelay({ upstream: `http://127.0.0.1:${relayPort}/v1/chat/completions` });
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${bridge.port}`]: { models: { "gpt-test": { context: 1_000_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 800,
            compress: { minCompressRange: 250, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${bridge.port}/v1/responses`;

    async function modelRequest(conv: string, input: HistoryItem[]): Promise<StreamResult> {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-bili-plugin": "codex-e2e",
                "x-bili-plugin-conversation": conv,
                "x-bili-plugin-model": "gpt-test",
            },
            body: JSON.stringify({
                model: "gpt-test",
                stream: true,
                instructions: "plugin grow compress",
                input,
                tools: [
                    {
                        type: "function",
                        name: "mcp__bili__compress",
                        description: "Replace consumed conversation ranges with summaries.",
                        parameters: { type: "object", properties: { topic: { type: "string" }, content: { type: "array" } }, required: ["content"] },
                    },
                ],
            }),
            duplex: "half",
        } as RequestInit);
        if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
        return readResponsesStream(res);
    }

    try {
        // Prime a SECOND fresh conversation first: from here on, rung-3
        // arbitration is impossible (2 active) and every id-less tool POST
        // below can ONLY route via the outbound tool_use witness (rung 1) —
        // if the witness recording breaks, the POST answers rung-4's loud
        // 400 and this test fails with it.
        {
            const prime = await modelRequest(CONV_B, [{ type: "message", role: "user", content: [{ type: "input_text", text: "second conversation, just staying active" }] }]);
            assert.ok(prime.text.length > 0, "priming turn must answer");
            state.texts.length = 0; // the main loop's exact-text ledger starts after the prime
        }

        const history: HistoryItem[] = [];
        let textReplies = 0;
        let pluginToolCalls = 0;
        let witnessRoutes = 0; // counted behaviorally: 200 on an id-less POST with 2 active convs
        const toolResults: string[] = [];
        for (let i = 1; i <= TURNS; i++) {
            history.push({ type: "message", role: "user", content: [{ type: "input_text", text: userText(i) }] });
            const out = await modelRequest(CONV_A, history);
            if (out.fnCall) {
                // Host executes the MCP tool: id-less POST — witness must route.
                assert.equal(out.fnCall.name, "mcp__bili__compress", "unexpected tool name");
                const toolRes = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ tool: "compress", args: JSON.parse(out.fnCall.arguments) as Record<string, unknown> }),
                });
                const toolJson = (await toolRes.json()) as { ok?: boolean; error?: string; result?: string; conversationId?: string };
                assert.ok(toolRes.status === 200 && toolJson.ok === true, `plugin tool execution failed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);
                // No body id was sent and two conversations are active, so a
                // 200 here can only mean witness routing (rung 1). Which
                // conversation it routed to is proven behaviorally below:
                // the fold must land on CONV_A's wire (postFoldBodies) — a
                // misroute to CONV_B would leave A's wire unfolded.
                pluginToolCalls++;
                witnessRoutes++;
                toolResults.push(toolJson.result ?? "");
                history.push({ type: "function_call", call_id: out.fnCall.callId, name: out.fnCall.name, arguments: out.fnCall.arguments });
                history.push({ type: "function_call_output", call_id: out.fnCall.callId, output: toolJson.result ?? "compressed" });
            } else {
                assert.ok(out.text.length > 0, `turn ${i}: empty reply without a pending tool round-trip`);
                // exactly ONE copy of the filler: a false retryEmptyTurn
                // (#1778) would append a second, duplicated stream.
                assert.equal(out.text, state.texts.shift() ?? "", `turn ${i}: client must receive exactly the one reply the relay emitted`);
                textReplies++;
                history.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: out.text }] });
            }
        }

        const clientBytes = Buffer.byteLength(JSON.stringify(history));
        const maxUpstreamBytes = Math.max(...state.upstreamReqs.map((r) => r.bytes));
        const maxLiveMsgs = Math.max(...state.upstreamReqs.map((r) => r.msgs));
        // The fold actually happened, through the plugin tool endpoint, and
        // its effect is visible on the upstream wire:
        assert.ok(pluginToolCalls >= 2, `expected >= 2 plugin-lane compress cycles, got ${pluginToolCalls}`);
        assert.ok(witnessRoutes === pluginToolCalls, "every id-less compress POST must route by witness (2 conversations active)");
        assert.equal(state.failedCompressions, 0, "compress tool calls must not fail");
        assert.equal(textReplies + pluginToolCalls, TURNS, `every turn must resolve (text ${textReplies} + tool ${pluginToolCalls} vs ${TURNS})`);
        const postFoldBodies = state.upstreamReqs.filter((r) => r.body.includes("[Compressed conversation section]"));
        assert.ok(postFoldBodies.length >= pluginToolCalls, "folded summary blocks must appear on the upstream wire after each cycle");
        assert.ok(postFoldBodies.some((r) => r.body.includes("plugin-lane summary of the folded middle segment")), "our own summary text must land on the wire");
        assert.ok(maxUpstreamBytes < LIVE_BYTES_THRESHOLD * 2, `upstream body must stay bounded (max ${maxUpstreamBytes}B vs threshold ${LIVE_BYTES_THRESHOLD}B)`);
        assert.ok(maxLiveMsgs < TURNS, `upstream live message count must stay well below client history (max ${maxLiveMsgs} vs ${TURNS} turns)`);
        assert.ok(clientBytes > maxUpstreamBytes * 2, `client history (${clientBytes}B) should far exceed max upstream body (${maxUpstreamBytes}B) after compression cycles`);
        const degenerateWarns = capturedWarns.filter((w) => w.includes("degenerate-turn") && w.includes("plugin-passthrough-responses"));
        assert.equal(degenerateWarns.length, 0, `no false degenerate-turn warn may fire for turns that delivered prose (#1778): ${JSON.stringify(degenerateWarns.slice(0, 2))}`);
        assert.equal(capturedWarns.filter((w) => w.includes("degenerate terminal turn") && w.includes("retrying once")).length, 0, "the one-shot empty-turn retry must not fire for turns that delivered prose (#1778)");
    } finally {
        setLogCapture(null);
        await close(proxy);
        await bridge.close();
        await close(relay);
    }
});
