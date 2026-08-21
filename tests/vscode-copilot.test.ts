import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeOpts(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-v4-flash": { context: 64_000 } } },
        },
        modelContextLimit: 64_000,
        kernelConfig: defaultConfig(64_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
}

function parseSseEvents(raw: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
            out.push(JSON.parse(payload) as Record<string, unknown>);
        } catch {
            continue;
        }
    }
    return out;
}

test("vscode-copilot #177 (1): OpenAI streaming final chunk carries total_tokens", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                "x-request-id": "upstream-req-123",
            });
            const base = { id: "chatcmpl-up-1", object: "chat.completion.chunk", created: 1755678900, model: "deepseek-v4-flash" };
            const w = (o: Record<string, unknown>): void => { res.write(sseLine(o)); };
            w({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, reasoning_content: "" } }] });
            await new Promise((r) => setTimeout(r, 20));
            w({ ...base, choices: [{ index: 0, delta: { reasoning_content: "Let me think." } }] });
            await new Promise((r) => setTimeout(r, 20));
            w({ ...base, choices: [{ index: 0, delta: { content: "Hello" } }] });
            await new Promise((r) => setTimeout(r, 20));
            w({ ...base, choices: [{ index: 0, delta: { content: " world" } }] });
            await new Promise((r) => setTimeout(r, 20));
            w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            w({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startServer(makeOpts(upstreamPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;

    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer fake-key",
            },
            body: JSON.stringify({
                model: "deepseek-v4-flash",
                messages: [
                    { role: "system", content: "You are a test assistant." },
                    { role: "user", content: "Say hello" },
                ],
                stream: true,
                stream_options: { include_usage: true },
                max_completion_tokens: 4096,
            }),
        });
        assert.equal(resp.status, 200);
        assert.ok(resp.body, "proxy returned a response body");

        let full = "";
        for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
            full += Buffer.from(chunk).toString("utf8");
        }

        const events = parseSseEvents(full);
        const usageEvents = events.filter((e) => e.usage && typeof e.usage === "object");
        assert.ok(usageEvents.length >= 1, `expected a usage event in the stream, got ${events.length} events total`);
        const usage = usageEvents[usageEvents.length - 1]!.usage as Record<string, unknown>;
        assert.equal(usage.prompt_tokens, 100, "prompt_tokens preserved");
        assert.equal(usage.completion_tokens, 50, "completion_tokens preserved");
        // vscode isApiUsage() requires total_tokens to be a number; without it
        // the usage chunk is misread as a completion and
        // `solution.requestId.headerRequestId` throws (issue #177).
        assert.equal(typeof usage.total_tokens, "number", "total_tokens must be a number");
        assert.equal(usage.total_tokens, 150, "total_tokens = prompt + completion");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("vscode-copilot #177 (2): client cancel aborts upstream and frees the session lock", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let reqCount = 0;
    let upstreamAborted = false;
    const abortSeen = new Promise<boolean>((resolve) => {
        const iv = setInterval(() => { if (upstreamAborted) { clearInterval(iv); resolve(true); } }, 10);
        setTimeout(() => { clearInterval(iv); resolve(upstreamAborted); }, 5000);
    });

    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            reqCount += 1;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
            });
            const base = { id: "chatcmpl-up-1", object: "chat.completion.chunk", created: 1755678900, model: "deepseek-v4-flash" };
            res.write(sseLine({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null } }] }));
            res.write(sseLine({ ...base, choices: [{ index: 0, delta: { content: "Hello" } }] }));
            if (reqCount === 1) {
                // Hold the stream open (no res.end); socket close while unended = abort.
                const socket = res.socket;
                if (socket) {
                    socket.on("close", () => {
                        if (!res.writableEnded) upstreamAborted = true;
                    });
                }
                return;
            }
            res.write(sseLine({ ...base, choices: [{ index: 0, delta: { content: " world" } }] }));
            res.write(sseLine({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            res.write(sseLine({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startServer(makeOpts(upstreamPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const sessionHeader = { "x-acp-session": "vscode-cancel-test" };
    const body = {
        model: "deepseek-v4-flash",
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: "Say hello" },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 4096,
    };

    try {
        const clientAbort = new AbortController();
        const resp = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer fake-key", ...sessionHeader },
            body: JSON.stringify(body),
            signal: clientAbort.signal,
        });
        assert.equal(resp.status, 200);
        assert.ok(resp.body, "proxy returned a response body");

        const reader = resp.body as unknown as AsyncIterable<Uint8Array>;
        let gotSome = false;
        for await (const chunk of reader) {
            gotSome = Buffer.from(chunk).toString("utf8").length > 0;
            if (gotSome) break;
        }
        clientAbort.abort();

        const aborted = await abortSeen;
        assert.ok(aborted, "upstream fetch was not aborted after client cancel");

        const second = await Promise.race([
            (async () => {
                const r2 = await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "application/json", authorization: "Bearer fake-key", ...sessionHeader },
                    body: JSON.stringify(body),
                });
                assert.equal(r2.status, 200);
                let text = "";
                for await (const chunk of r2.body as unknown as AsyncIterable<Uint8Array>) {
                    text += Buffer.from(chunk).toString("utf8");
                }
                return text;
            })(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("second request on same session hung (session lock not freed)")), 4000)),
        ]);
        assert.ok(second.includes("world"), "second request streamed its content");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
