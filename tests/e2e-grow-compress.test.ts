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

const TURNS = 120;
const LIVE_BYTES_THRESHOLD = 24 * 1024;
const CHARS_PER_TOKEN = 4;
const MSG_TOKENS = 100;

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
    return `user turn ${i}: ${filler.repeat((MSG_TOKENS * CHARS_PER_TOKEN) / 46 | 0)}`;
}

function assistantText(i: number): string {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
    return `assistant reply ${i}: ${filler.repeat((MSG_TOKENS * CHARS_PER_TOKEN) / 50 | 0)}`;
}

type RelayState = {
    upstreamReqs: { bytes: number; msgs: number; body: string }[];
    compressCalls: number;
    lastDemandBytes: number;
    sinceDemand: number;
    failedCompressions: number;
};

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

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
                                                name: "compress",
                                                arguments: JSON.stringify({
                                                    content: [{ startId: from, endId: to, topic: "grow compress e2e", summary: `summary of the compressed middle segment: turns covered by this range discussed incremental context growth, message stuffing, and compression behavior; key results were recorded at each checkpoint and the conversation continued with per-turn overhead measurements and periodic compression cycles. ${from}..${to}` }],
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
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

type Item = { type: "message"; role: string; content: Array<{ type: string; text: string }> };

test("grow-and-compress keeps upstream context bounded while client history grows", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressCalls: 0, lastDemandBytes: Infinity, sinceDemand: 99, failedCompressions: 0 };
    const relay = startMockChatRelay(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const bridge = await startChatRelay({ upstream: `http://127.0.0.1:${relayPort}/v1/chat/completions` });
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${bridge.port}`]: { models: { "gpt-test": { context: 1_000_000 } }, compressProtocol: "marker" } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 800,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
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
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${bridge.port}/v1/responses`;

    const history: Item[] = [];
    let nonEmptyReplies = 0;
    try {
        for (let i = 1; i <= TURNS; i++) {
            history.push({ type: "message", role: "user", content: [{ type: "input_text", text: userText(i) }] });
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "grow-compress-1" },
                body: JSON.stringify({ model: "gpt-test", stream: true, instructions: "grow compress", input: history }),
                duplex: "half",
            } as RequestInit);
            if (!res.ok) assert.fail(`turn ${i}: HTTP ${res.status}: ${await res.text()}`);
            let raw = "";
            for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
            let reply = "";
            for (const block of raw.split("\n\n")) {
                let event = "";
                let data: { delta?: string } | undefined;
                for (const line of block.split("\n")) {
                    if (line.startsWith("event:")) event = line.slice(6).trim();
                    if (line.startsWith("data:")) {
                        try {
                            data = JSON.parse(line.slice(5).trim()) as { delta?: string };
                        } catch {
                            data = undefined;
                        }
                    }
                }
                if (event === "response.output_text.delta" && data?.delta) reply += data.delta;
            }
            if (reply) nonEmptyReplies++;
            else if (state.upstreamReqs[state.upstreamReqs.length - 1]?.body.includes("compress") === false) assert.fail(`turn ${i}: empty reply without pending compress round-trip`);
            history.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] });
        }

        const clientBytes = Buffer.byteLength(JSON.stringify({ model: "gpt-test", stream: true, instructions: "grow compress", input: history }));
        const maxUpstreamBytes = Math.max(...state.upstreamReqs.map((r) => r.bytes));
        const maxLiveMsgs = Math.max(...state.upstreamReqs.map((r) => r.msgs));
        assert.ok(state.compressCalls >= 2, `expected >= 2 compress cycles, got ${state.compressCalls}`);
        assert.equal(state.failedCompressions, 0, "compress tool calls must not fail");
        assert.equal(nonEmptyReplies, TURNS, `every turn must produce a reply (${nonEmptyReplies}/${TURNS})`);
        assert.ok(maxUpstreamBytes < LIVE_BYTES_THRESHOLD * 2, `upstream body must stay bounded (max ${maxUpstreamBytes}B vs threshold ${LIVE_BYTES_THRESHOLD}B)`);
        assert.ok(maxLiveMsgs < TURNS, `upstream live message count must stay well below client history (max ${maxLiveMsgs} vs ${TURNS} turns)`);
        assert.ok(clientBytes > maxUpstreamBytes * 2, `client history (${clientBytes}B) should far exceed max upstream body (${maxUpstreamBytes}B) after compression cycles`);
    } finally {
        await close(proxy);
        await bridge.close();
        await close(relay);
    }
});
