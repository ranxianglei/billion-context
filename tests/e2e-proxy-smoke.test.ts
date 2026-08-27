import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

type Captured = { url: string; body: Buffer };

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

const DELAY_MS = 40;

test("e2e proxy smoke: compress tool-call -> re-request -> round-2 streams in real-time", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", async () => {
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks) });
            if (captured.length === 1) {
                res.writeHead(200, {
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                });
                const compressArgs = JSON.stringify({
                    content: [
                        {
                            startId: "m00001",
                            endId: "m00002",
                            topic: "smoke",
                            summary: "smoke test summary",
                        },
                    ],
                });
                res.write(
                    sseLine({
                        id: "r1",
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
                                            id: "call_smoke",
                                            type: "function",
                                            function: { name: "compress", arguments: compressArgs },
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                );
                res.write(
                    sseLine({
                        id: "r1",
                        object: "chat.completion.chunk",
                        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                    }),
                );
                res.write("data: [DONE]\n\n");
                res.end();
                return;
            }
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
            });
            const writeContent = (content: string): void => {
                res.write(
                    sseLine({
                        id: "r2",
                        object: "chat.completion.chunk",
                        choices: [{ index: 0, delta: { content } }],
                    }),
                );
            };
            writeContent("Hello");
            await new Promise((r) => setTimeout(r, DELAY_MS));
            writeContent(" world");
            await new Promise((r) => setTimeout(r, DELAY_MS));
            writeContent("!");
            await new Promise((r) => setTimeout(r, DELAY_MS));
            res.write(
                sseLine({
                    id: "r2",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                }),
            );
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
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

    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const big = "x".repeat(3000);
    const body = {
        model: "gpt-test",
        stream: true,
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: big },
            { role: "user", content: big },
        ],
    };

    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "proxy-smoke-e2e" },
            body: JSON.stringify(body),
        });
        assert.equal(resp.status, 200);
        assert.ok(resp.body, "proxy returned a response body");

        const arrivals: { t: number; text: string }[] = [];
        for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
            arrivals.push({ t: Date.now(), text: Buffer.from(chunk).toString("utf8") });
        }

        assert.ok(captured.length >= 2, `expected >= 2 upstream requests (re-request), got ${captured.length}`);

        const full = arrivals.map((a) => a.text).join("");
        assert.ok(full.includes("Hello"), 'round-2 text "Hello" missing from client stream');
        assert.ok(full.includes("world"), 'round-2 text "world" missing from client stream');
        assert.ok(full.includes("!"), 'round-2 text "!" missing from client stream');

        const contentChunks = arrivals.filter((a) => a.text.includes('"content":"'));
        assert.ok(
            contentChunks.length >= 3,
            `expected >= 3 round-2 content chunks, got ${contentChunks.length}`,
        );
        const first = contentChunks[0]!.t;
        const last = contentChunks[contentChunks.length - 1]!.t;
        const span = last - first;
        assert.ok(
            span >= 50,
            `round-2 text was buffered, not streamed (span=${span}ms across ${contentChunks.length} chunks)`,
        );
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
