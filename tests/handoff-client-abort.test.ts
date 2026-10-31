import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";

// #4247 followup: agents that close the socket the instant they hold the
// terminal frame (pi does) used to lose the reply entirely — the handoff save
// was gated on the client socket still being writable. These tests pin the
// rule: a completed upstream turn is persisted even when the client is gone.

function sse(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

function roleChunk(): string {
    return sse({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }], usage: { prompt_tokens: 55, completion_tokens: 0, total_tokens: 55 } });
}

function textChunk(text: string): string {
    return sse({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

function terminalChunk(reason = "stop"): string {
    return sse({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

/** Upstream that writes `head` and then holds the stream open — the real
 *  slow-model shape: the client has its terminal frame while the connection
 *  is still alive. */
async function startHarness(head: string[], opts: { hold?: boolean; doneAfterMs?: number } = {}): Promise<Harness> {
    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const line of head) res.write(line);
            if (opts.doneAfterMs !== undefined) {
                // [DONE] lands after the client has had time to hang up, so the
                // pipe's write of that frame hits a dead socket.
                setTimeout(() => { if (!res.destroyed) res.write("data: [DONE]\n\n"); if (!res.destroyed) res.end(); }, opts.doneAfterMs);
            } else if (!opts.hold) res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeAllConnections?.();
            await once(upstream, "close");
        },
    };
}

function request(h: Harness, conv: string, body: Record<string, unknown>): http.ClientRequest {
    return http.request({
        host: "127.0.0.1",
        port: h.proxyPort,
        path: `/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`,
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv },
    });
}

async function handoffMd(h: Harness, label: string): Promise<string> {
    const stats = (await (await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/stats`)).json()) as { sessions: Array<{ id: string; label?: string }> };
    const id = stats.sessions.find((s) => s.label === label)?.id;
    assert.ok(id, `session ${label} not registered`);
    const detail = (await (await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/sessions/${id}/detail`)).json()) as { handoffMd: string };
    return detail.handoffMd;
}

function payload(stream: boolean): Record<string, unknown> {
    return {
        model: "gpt-test",
        max_tokens: 1024,
        stream,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read_file", description: "r", parameters: { type: "object", properties: {} } } }],
    };
}

test("keeps the reply when the client closes right after the terminal frame", async () => {
    // Upstream delivers the whole turn and then holds the connection open, so
    // the pipe is still reading when the client hangs up — the shape pi leaves.
    const h = await startHarness([roleChunk(), textChunk("final answer"), terminalChunk(), "data: [DONE]\n\n"], { hold: true });
    try {
        const req = request(h, "handoff-abort-after-terminal", payload(true));
        let seen = "";
        req.on("response", (res) => {
            res.on("data", (c: Buffer) => {
                seen += c.toString("utf8");
                if (seen.includes("data: [DONE]") && !req.destroyed) {
                    req.destroy();
                    res.destroy();
                }
            });
        });
        req.on("error", () => {});
        req.end(JSON.stringify(payload(true)));
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !seen.includes("data: [DONE]")) await new Promise((r) => setTimeout(r, 25));
        assert.match(seen, /final answer/);
        await new Promise((r) => setTimeout(r, 500));
        // give the store/render a beat — the metadata write itself is synchronous
        const md = await handoffMd(h, "handoff-abort-after-terminal");
        assert.match(md, /### assistant/);
        assert.match(md, /final answer/);
    } finally {
        await h.close();
    }
});

test("does not persist a reply the upstream never terminated", async () => {
    const h = await startHarness([roleChunk(), textChunk("half an ans")]);
    try {
        const req = request(h, "handoff-abort-mid-stream", payload(true));
        let seen = "";
        req.on("response", (res) => {
            res.on("data", (c: Buffer) => {
                seen += c.toString("utf8");
                if (seen.includes("half an ans") && !req.destroyed) {
                    req.destroy();
                    res.destroy();
                }
            });
        });
        req.on("error", () => {});
        req.end(JSON.stringify(payload(true)));
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !seen.includes("half an ans")) await new Promise((r) => setTimeout(r, 25));
        await new Promise((r) => setTimeout(r, 500));
        const md = await handoffMd(h, "handoff-abort-mid-stream");
        assert.doesNotMatch(md, /half an ans/);
    } finally {
        await h.close();
    }
});
