import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startChatRelay } from "./e2e/chat-relay.ts";

type Captured = { url: string; body: string };

type ChatRelayScript = (requestIndex: number) => string[];

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

const DELAY_MS = 80;

function startMockChatRelay(script: ChatRelayScript, captured: Captured[]): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", async () => {
            const index = captured.length;
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            for (const line of script(index)) {
                if (line === "[WAIT]") {
                    await new Promise((r) => setTimeout(r, DELAY_MS));
                    continue;
                }
                res.write(line);
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

function textScript(): string[] {
    return [
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }),
        "[WAIT]",
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: " world" } }] }),
        "[WAIT]",
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "!" } }] }),
        "[WAIT]",
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    ];
}

function namespacedToolScript(): string[] {
    return [
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
                                id: "call_ns_1",
                                type: "function",
                                function: { name: "agents.spawn_agent", arguments: JSON.stringify({ task: "demo" }) },
                            },
                        ],
                    },
                },
            ],
        }),
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
    ];
}

function reasoningScript(): string[] {
    return [
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking hard" } }] }),
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning_content: " about the answer" } }] }),
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Final answer" } }] }),
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4 } }),
    ];
}

function compressScript(): string[] {
    return [
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
                                id: "call_compress",
                                type: "function",
                                function: {
                                    name: "compress",
                                    arguments: JSON.stringify({
                                        content: [{ startId: "m00001", endId: "m00002", topic: "e2e", summary: "e2e summary" }],
                                    }),
                                },
                            },
                        ],
                    },
                },
            ],
        }),
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 2 } }),
    ];
}

function roundTwoTextScript(): string[] {
    return [
        sseLine({ id: "g2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Done after compress" } }] }),
        "[WAIT]",
        sseLine({ id: "g2", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 6, completion_tokens: 3 } }),
    ];
}

type Harness = {
    proxyPort: number;
    bridgePort: number;
    captured: Captured[];
    cleanup(): Promise<void>;
};

async function startHarness(script: ChatRelayScript, marker: boolean): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: Captured[] = [];
    const relay = startMockChatRelay(script, captured);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const bridge = await startChatRelay({ upstream: `http://127.0.0.1:${relayPort}/v1/chat/completions` });
    const route: Record<string, unknown> = { models: { "gpt-test": { context: 400_000 } } };
    if (marker) route.compressProtocol = "marker";
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${bridge.port}`]: route } as ProxyOptions["routes"],
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
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
    return {
        proxyPort,
        bridgePort: bridge.port,
        captured,
        cleanup: async () => {
            await close(proxy);
            await bridge.close();
            await close(relay);
        },
    };
}

type ClientEvent = { event: string; data?: Record<string, unknown> };

function parseSse(raw: string): ClientEvent[] {
    const events: ClientEvent[] = [];
    for (const block of raw.split("\n\n")) {
        let event = "";
        let data: Record<string, unknown> | undefined;
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) {
                const payload = line.slice(5).trim();
                try {
                    data = JSON.parse(payload) as Record<string, unknown>;
                } catch {
                    data = undefined;
                }
            }
        }
        if (event) events.push({ event, data });
    }
    return events;
}

async function callResponses(h: Harness, input: unknown[], tools?: unknown[]): Promise<{ raw: string; events: ClientEvent[]; arrivals: { t: number; text: string }[] }> {
    const url = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.bridgePort}/v1/responses`;
    const body: Record<string, unknown> = {
        model: "gpt-test",
        stream: true,
        instructions: "You are a test assistant.",
        input,
        session_id: "e2e-responses-chat-relay",
    };
    if (tools) body.tools = tools;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    assert.equal(resp.status, 200);
    const arrivals: { t: number; text: string }[] = [];
    let raw = "";
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
        const text = Buffer.from(chunk).toString("utf8");
        arrivals.push({ t: Date.now(), text });
        raw += text;
    }
    return { raw, events: parseSse(raw), arrivals };
}

const USER_INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }];

test("e2e chat relay: responses text streams through bili with incremental deltas (native protocol)", async () => {
    const h = await startHarness((i) => (i === 0 ? textScript() : roundTwoTextScript()), false);
    try {
        const { events, arrivals } = await callResponses(h, USER_INPUT);
        const deltas = events.filter((e) => e.event === "response.output_text.delta");
        assert.ok(deltas.length >= 3, `expected >= 3 output_text.delta events, got ${deltas.length}`);
        const joined = deltas.map((d) => String(d.data?.delta ?? "")).join("");
        assert.ok(joined.includes("Hello") && joined.includes("world") && joined.includes("!"), `text missing: ${joined}`);
        assert.ok(events.some((e) => e.event === "response.completed"), "response.completed missing");
        const contentChunks = arrivals.filter((a) => a.text.includes("output_text.delta"));
        const span = contentChunks[contentChunks.length - 1]!.t - contentChunks[0]!.t;
        assert.ok(span >= 50, `deltas buffered, not streamed (span=${span}ms)`);
        const chatRelayReq = JSON.parse(h.captured[0]!.body) as { messages: Array<{ role: string; content?: string }>; tools?: Array<{ type: string; function: { name: string } }> };
        const systemMsg = chatRelayReq.messages.find((m) => m.role === "system");
        assert.ok(systemMsg, `instructions not lifted to system/developer message: ${JSON.stringify(chatRelayReq.messages.map((m) => m.role))}`);
        assert.match(systemMsg?.content ?? "", /test assistant/);
        assert.ok(
            (chatRelayReq.tools ?? []).some((t) => t.type === "function" && t.function.name === "compress"),
            `bili-injected compress tool not converted to nested chat format: ${JSON.stringify(chatRelayReq.tools)}`,
        );
    } finally {
        await h.cleanup();
    }
});

test("e2e chat relay: marker protocol coalesces text into one delta and rebuilds message lifecycle (by design)", async () => {
    const h = await startHarness((i) => (i === 0 ? textScript() : roundTwoTextScript()), true);
    try {
        const { events } = await callResponses(h, USER_INPUT);
        const deltas = events.filter((e) => e.event === "response.output_text.delta");
        assert.equal(deltas.length, 1, `marker protocol should coalesce text into 1 delta, got ${deltas.length}`);
        assert.equal(String(deltas[0]?.data?.delta ?? ""), "Hello world!");
        const added = events.find((e) => e.event === "response.output_item.added");
        assert.ok(added, "rebuilt output_item.added missing");
        const done = events.find((e) => e.event === "response.output_item.done");
        assert.ok(done, "rebuilt output_item.done missing");
        const itemId = String((added?.data?.item as Record<string, unknown> | undefined)?.id ?? "");
        assert.ok(itemId.startsWith("msg-proxy-"), `expected bili-rebuilt msg-proxy- item id, got ${itemId}`);
        for (const e of ["response.output_text.done", "response.content_part.added", "response.content_part.done", "response.completed"]) {
            assert.ok(events.some((x) => x.event === e), `${e} missing`);
        }
    } finally {
        await h.cleanup();
    }
});

test("e2e chat relay: namespaced function_call passes through raw with stable item id (issue #143 regression, marker protocol)", async () => {
    const h = await startHarness((i) => (i === 0 ? namespacedToolScript() : textScript()), true);
    try {
        const { events } = await callResponses(h, USER_INPUT, [
            { type: "function", name: "agents.spawn_agent", description: "spawn", parameters: { type: "object", properties: {} } },
        ]);
        const added = events.find((e) => e.event === "response.output_item.added" && String((e.data?.item as Record<string, unknown> | undefined)?.type) === "function_call");
        assert.ok(added, "output_item.added for function_call missing from client stream");
        const addedItem = added!.data!.item as Record<string, unknown>;
        assert.equal(addedItem.name, "agents.spawn_agent");
        assert.ok(typeof addedItem.id === "string" && (addedItem.id as string).length > 0, "original function_call item id missing");
        const done = events.find((e) => e.event === "response.output_item.done" && String((e.data?.item as Record<string, unknown> | undefined)?.type) === "function_call");
        assert.ok(done, "output_item.done for function_call missing");
        assert.equal((done!.data!.item as Record<string, unknown>).id, addedItem.id, "added/done item id mismatch");
        assert.ok(events.some((e) => e.event === "response.function_call_arguments.delta"), "arguments delta missing");
        assert.ok(!events.some((e) => JSON.stringify(e).includes("fc-proxy-")), "reconstructed fc-proxy- id leaked into client stream");
        const completed = events.find((e) => e.event === "response.completed");
        const output = (completed?.data?.response as Record<string, unknown> | undefined)?.output;
        assert.ok(
            Array.isArray(output) && output.some((item) => (item as Record<string, unknown>).name === "agents.spawn_agent"),
            "completed.output missing namespaced function_call",
        );
    } finally {
        await h.cleanup();
    }
});

test("e2e chat relay: reasoning item lifecycle preserved end-to-end (issue #94 regression, marker protocol)", async () => {
    const h = await startHarness((i) => (i === 0 ? reasoningScript() : textScript()), true);
    try {
        const { events } = await callResponses(h, USER_INPUT);
        const added = events.find((e) => e.event === "response.output_item.added" && String((e.data?.item as Record<string, unknown> | undefined)?.type) === "reasoning");
        assert.ok(added, "reasoning output_item.added missing from client stream");
        const done = events.find((e) => e.event === "response.output_item.done" && String((e.data?.item as Record<string, unknown> | undefined)?.type) === "reasoning");
        assert.ok(done, "reasoning output_item.done missing from client stream");
        const deltas = events.filter((e) => e.event === "response.output_text.delta");
        assert.ok(deltas.some((d) => String(d.data?.delta ?? "").includes("Final answer")), "assistant text after reasoning missing");
    } finally {
        await h.cleanup();
    }
});

test("e2e chat relay: compress tool-call round-trip on responses path (marker protocol)", async () => {
    const h = await startHarness((i) => (i === 0 ? compressScript() : roundTwoTextScript()), true);
    const big = "y".repeat(2000);
    try {
        const { events } = await callResponses(h, [
            { type: "message", role: "user", content: [{ type: "input_text", text: big }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: big }] },
        ]);
        assert.ok(h.captured.length >= 2, `expected >= 2 upstream requests (compress re-request), got ${h.captured.length}`);
        const second = JSON.parse(h.captured[1]!.body) as { messages: Array<{ role: string; tool_call_id?: string }> };
        assert.ok(
            second.messages.some((m) => m.role === "tool"),
            "compress function_call_output not delivered to upstream as tool message",
        );
        const deltas = events.filter((e) => e.event === "response.output_text.delta");
        assert.ok(deltas.some((d) => String(d.data?.delta ?? "").includes("Done after compress")), "round-2 text missing from client stream");
        assert.ok(
            !events.some((e) => e.event === "response.output_item.added" && String((e.data?.item as Record<string, unknown> | undefined)?.name) === "compress"),
            "intercepted compress call leaked to client",
        );
    } finally {
        await h.cleanup();
    }
});

test("e2e chat relay: namespaced function_call passthrough also works in native responses protocol", async () => {
    const h = await startHarness((i) => (i === 0 ? namespacedToolScript() : textScript()), false);
    try {
        const { events } = await callResponses(h, USER_INPUT, [
            { type: "function", name: "agents.spawn_agent", description: "spawn", parameters: { type: "object", properties: {} } },
        ]);
        const added = events.find((e) => e.event === "response.output_item.added" && String((e.data?.item as Record<string, unknown> | undefined)?.type) === "function_call");
        assert.ok(added, "output_item.added for function_call missing (native protocol)");
        assert.equal((added!.data!.item as Record<string, unknown>).name, "agents.spawn_agent");
        assert.ok(!events.some((e) => JSON.stringify(e).includes("fc-proxy-")), "fc-proxy- id leaked (native protocol)");
    } finally {
        await h.cleanup();
    }
});

test("e2e chat relay: text before tool_call keeps full text in message lifecycle (regression: closeMessage lost accumulated text)", async () => {
    const mixedScript: string[] = [
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Thinking out " } }] }),
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "loud, now calling." } }] }),
        sseLine({
            id: "g1",
            object: "chat.completion.chunk",
            choices: [
                {
                    index: 0,
                    delta: {
                        content: null,
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_mixed_1",
                                type: "function",
                                function: { name: "agents.spawn_agent", arguments: JSON.stringify({ task: "demo" }) },
                            },
                        ],
                    },
                },
            ],
        }),
        sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ];
    const h = await startHarness((i) => (i === 0 ? mixedScript : textScript()), true);
    try {
        const { events } = await callResponses(h, USER_INPUT, [
            { type: "function", name: "agents.spawn_agent", description: "spawn", parameters: { type: "object", properties: {} } },
        ]);
        const deltas = events.filter((e) => e.event === "response.output_text.delta");
        assert.ok(deltas.length >= 1, "text deltas missing before tool_call");
        assert.equal(deltas.map((d) => String(d.data?.delta ?? "")).join(""), "Thinking out loud, now calling.");
        const textDone = events.find((e) => e.event === "response.output_text.done");
        assert.ok(textDone, "output_text.done missing for text-before-tool_call message");
        assert.equal(String(textDone!.data?.text ?? ""), "Thinking out loud, now calling.");
        const msgDone = events.find((e) => e.event === "response.output_item.done" && String((e.data?.item as Record<string, unknown> | undefined)?.type) === "message");
        assert.ok(msgDone, "message output_item.done missing before function_call");
        const completed = events.find((e) => e.event === "response.completed");
        const output = (completed?.data?.response as Record<string, unknown> | undefined)?.output as Array<Record<string, unknown>> | undefined;
        assert.ok(Array.isArray(output), "completed.output missing");
        const msgItem = output?.find((item) => item.type === "message");
        assert.ok(msgItem, "completed.output missing message item");
        const text = (msgItem?.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === "output_text")?.text;
        assert.equal(text, "Thinking out loud, now calling.");
        assert.ok(output?.some((item) => item.type === "function_call" && item.name === "agents.spawn_agent"), "completed.output missing function_call item");
    } finally {
        await h.cleanup();
    }
});
