import assert from "node:assert";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, beginStreamKeepalive, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #1647 regression: upstream-caused streaming silence must not kill the
// client-side undici bodyTimeout (default 300s). The rewriter/strip pipes
// swallow upstream comment pings (`: ping`, llama.cpp-style), so before the
// fix ZERO bytes reached the client during prefill and the client died at
// ~303s while leg 2 survived. beginStreamKeepalive emits `: bili-keepalive`
// comment lines while the socket sees no growth.

const KEEPALIVE_LINE = ": bili-keepalive";

function openaiChunk(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

const CHUNK_BASE = { id: "chatcmpl_k", object: "chat.completion.chunk", created: 1, model: "gpt-test" };

interface Harness {
    proxyPort: number;
    close(): Promise<void>;
}

// Mimics llama.cpp-flashnext: immediate headers + first chunk, then comment
// pings every 50ms ("prefill"), real completion after silenceMs.
async function startUpstream(mode: "slow" | "fast", silenceMs: number): Promise<{ port: number; server: http.Server }> {
    const srv = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            const first = openaiChunk({ ...CHUNK_BASE, choices: [{ index: 0, delta: { role: "assistant", content: "hel" }, finish_reason: null }] });
            const last = openaiChunk({ ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            res.write(first);
            if (mode === "fast") {
                res.write(last);
                res.write("data: [DONE]\n\n");
                res.end();
                return;
            }
            const pingIv = setInterval(() => {
                try { res.write(": ping\n\n"); } catch { clearInterval(pingIv); }
            }, 50);
            setTimeout(() => {
                clearInterval(pingIv);
                try {
                    res.write(last);
                    res.write("data: [DONE]\n\n");
                    res.end();
                } catch { /* client gone */ }
            }, silenceMs);
        });
    });
    srv.listen(0, "127.0.0.1");
    await once(srv, "listening");
    return { port: srv.address().port, server: srv };
}

async function startHarness(upstreamPort: number): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        promptCache: { routing: "auto" },
        compress: { injectTool: false, injectNudge: false },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        proxyPort: proxy.address().port,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
        },
    };
}

async function readStream(url: string, sessionId: string): Promise<{ status: number; raw: string }> {
    const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        // max_tokens > 200 so this takes the normal conversation path, not the
        // #388 side-request fast path (title-gen class) — matches the issue's
        // real-turn scenario.
        body: JSON.stringify({ model: "gpt-test", max_tokens: 4096, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    let raw = "";
    for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
    return { status: resp.status, raw };
}

const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

test("#1647 slow prefill: keep-alive comments hold the client through ping-only silence", async () => {
    process.env.BILI_STREAM_KEEPALIVE_MS = "300";
    const up = await startUpstream("slow", 1000);
    const h = await startHarness(up.port);
    try {
        const { status, raw } = await readStream(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`, "keepalive-slow");
        assert.equal(status, 200);
        // The strip pipe swallows upstream pings — they must NOT leak to the
        // client, which makes the keep-alive the only byte source in the gap.
        assert.equal(raw.includes(": ping"), false, "upstream pings leaked through the strip pipe:\n" + raw);
        const kept = countOccurrences(raw, KEEPALIVE_LINE);
        assert.ok(kept >= 1, `no keep-alive comments were sent during the ${1000}ms silence:\n` + raw);
        assert.ok(kept <= 30, `keep-alives spamming (${kept} in ~1s)`);
        // Stream integrity: both data events + terminator survive intact.
        assert.ok(raw.includes('"hel"'), "first delta lost:\n" + raw);
        assert.ok(raw.includes('"finish_reason":"stop"'), "final chunk lost:\n" + raw);
        assert.ok(raw.includes("[DONE]"), "[DONE] missing:\n" + raw);
    } finally {
        delete process.env.BILI_STREAM_KEEPALIVE_MS;
        up.server.closeAllConnections?.();
        up.server.close();
        await once(up.server, "close");
        await h.close();
    }
});

test("#1647 fast stream: no spurious keep-alive injection", async () => {
    process.env.BILI_STREAM_KEEPALIVE_MS = "300";
    const up = await startUpstream("fast", 0);
    const h = await startHarness(up.port);
    try {
        const { status, raw } = await readStream(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`, "keepalive-fast");
        assert.equal(status, 200);
        assert.ok(raw.includes('"hel"'));
        assert.ok(raw.includes("[DONE]"));
        assert.equal(countOccurrences(raw, KEEPALIVE_LINE), 0, "healthy fast stream received injected keep-alives:\n" + raw);
    } finally {
        delete process.env.BILI_STREAM_KEEPALIVE_MS;
        up.server.closeAllConnections?.();
        up.server.close();
        await once(up.server, "close");
        await h.close();
    }
});

test("#1647 BILI_STREAM_KEEPALIVE_MS=0 disables the hold", async () => {
    process.env.BILI_STREAM_KEEPALIVE_MS = "0";
    const up = await startUpstream("slow", 500);
    const h = await startHarness(up.port);
    try {
        const { status, raw } = await readStream(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`, "keepalive-off");
        assert.equal(status, 200);
        assert.ok(raw.includes("[DONE]"));
        assert.equal(countOccurrences(raw, KEEPALIVE_LINE), 0, "hold should be disabled with 0:\n" + raw);
    } finally {
        delete process.env.BILI_STREAM_KEEPALIVE_MS;
        up.server.closeAllConnections?.();
        up.server.close();
        await once(up.server, "close");
        await h.close();
    }
});

// Unit-drive beginStreamKeepalive against a stub res. The processed pipes in
// server.ts are all event-aligned (they re-emit whole `data: ...\n\n` events),
// but raw forwarders exist on armed lanes (reasoning-guard.ts pipeThroughRaw
// passthrough) and upstream can flush a partial SSE line then stall mid-line.
// A keep-alive comment spliced there would corrupt the client's JSON; the
// guard must hold fire until the stream returns to a line boundary.
function makeStubRes(): { res: Record<string, unknown>; chunks: string[] } {
    const chunks: string[] = [];
    let written = 0;
    const res = new EventEmitter() as unknown as Record<string, unknown>;
    res.destroyed = false;
    res.writableEnded = false;
    res.socket = {
        get bytesWritten(): number { return written; },
    };
    res.write = (chunk: string | Buffer | Uint8Array): boolean => {
        const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        chunks.push(s);
        written += Buffer.byteLength(s);
        return true;
    };
    return { res, chunks };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));


test("#1647 line-boundary guard: keep-alive never splices into a partial SSE line", async () => {
    process.env.BILI_STREAM_KEEPALIVE_MS = "60";
    const { res, chunks } = makeStubRes();
    beginStreamKeepalive(res as unknown as import("node:http").ServerResponse, "unit-boundary", () => {});
    try {
        // Partial `data:` line lands on the wire (no trailing \n\n), then the
        // upstream stalls — several keep-alive intervals must pass silently.
        (res.write as (c: string) => boolean)(`data: {"choices":[{"delta":{"content":"hel`);
        await sleep(250);
        const midLine = chunks.join("");
        assert.equal(
            countOccurrences(midLine, KEEPALIVE_LINE), 0,
            "keep-alive comment spliced into a partial SSE line:\n" + midLine,
        );

        // Line completes — stream is back at a boundary. The very next idle
        // interval may fire the keep-alive; it must never appear mid-line.
        (res.write as (c: string) => boolean)(`lo"}}]}\n\n`);
        await sleep(250);
        const after = chunks.join("");
        assert.ok(
            countOccurrences(after, KEEPALIVE_LINE) >= 1,
            "keep-alive never fired once the stream returned to a line boundary:\n" + after,
        );
        assert.ok(
            after.includes(`data: {"choices":[{"delta":{"content":"hello"}}]}\n\n`),
            "data line was not forwarded byte-intact:\n" + after,
        );
        // Every keep-alive comment must sit at a line start: the chunk before
        // it always ends with \n\n or the comment opens the body.
        for (let i = 0; i < chunks.length; i++) {
            if (chunks[i].startsWith(KEEPALIVE_LINE)) {
                const prev = chunks[i - 1];
                assert.ok(
                    prev === undefined || prev.endsWith("\n\n"),
                    `keep-alive chunk #${i} not preceded by a line boundary:\n` + JSON.stringify(chunks),
                );
            }
        }
    } finally {
        delete process.env.BILI_STREAM_KEEPALIVE_MS;
        (res as unknown as { emit(e: string): boolean }).emit("close");
    }
});
