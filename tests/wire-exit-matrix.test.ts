import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { existsSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.BILI_REPLAY_RETRY_MAX = "1";
process.env.BILI_PREFLIGHT_HOLD_MS = "300";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { EXIT_CONCERNS, WIRE_EXITS, type ExitConcernId } from "../src/exit-matrix.ts";

// #588 exit-enumeration matrix. Two layers:
//
// 1. META: the registry (src/exit-matrix.ts) is exhaustive over exits x
//    concerns and every `coveredBy` file exists on disk — renaming or
//    deleting a covering test breaks the matrix here, and adding a wire
//    exit without registry rows already fails typecheck.
// 2. BEHAVIOR: per-cell scenarios for the cells that had NO coverage before
//    this file: proxy-side client-abort propagation on all four proxy
//    exits, and the openai-chat in-band preflight error (the other in-band
//    cells were covered by tests/preflight-hold.test.ts).

const SLOW_MS = 1500;

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a debugging session. " +
    "Key decisions: chose the preflight approach. Files touched: src/a.ts:10. Outcome: fixed.";

function anthropicSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000 } } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function openaiSsePartial(): string {
    return `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] })}\n\n`;
}

function responsesSsePartial(): string {
    return `event: response.created\ndata: ${JSON.stringify({ response: { id: "r1", status: "in_progress" } })}\n\n`;
}

function bigConversation(turns = 12): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < turns; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

function bigResponsesInput(): Array<{ type: string; role: string; content: string }> {
    const input: Array<{ type: string; role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(290) });
    }
    return input;
}

type UpstreamMode = "hang-openai" | "hang-anthropic" | "hang-responses" | "hang-json" | "slow-summary-fwd-429" | "slow-summary-429";

function startUpstream(mode: UpstreamMode): Promise<{ server: http.Server; port: number; socketsClosed: () => number; requests: () => number }> {
    let closed = 0;
    let requests = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("close", () => {
            closed++;
        });
        req.on("end", () => {
            requests++;
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; messages?: unknown[] } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const isSummary = !parsed.stream;
            if (mode === "slow-summary-fwd-429" || mode === "slow-summary-429") {
                if (isSummary && mode === "slow-summary-429") {
                    // Fail the summarization itself AFTER the hold grace so the
                    // early 200 is already committed (→ emitPreflightError path).
                    setTimeout(() => {
                        res.writeHead(429, { "content-type": "application/json" });
                        res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
                    }, SLOW_MS);
                    return;
                }
                if (isSummary) {
                    setTimeout(() => {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({ id: "sum", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 } }));
                    }, SLOW_MS);
                    return;
                }
                // The post-preflight FORWARD fails fast — after the early commit
                // (→ emitStreamError mid-stream path).
                res.writeHead(429, { "content-type": "text/event-stream" });
                res.end(`data: ${JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } })}\n\ndata: [DONE]\n\n`);
                return;
            }
            // hang-* modes: commit headers + one partial chunk, then never end.
            // The proxy MUST destroy this socket when its client aborts.
            if (mode === "hang-openai") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(openaiSsePartial());
            } else if (mode === "hang-anthropic") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(anthropicSse().split("event: content_block_delta")[0]!);
            } else if (mode === "hang-responses") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(responsesSsePartial());
            } else {
                // hang-json: nothing at all — headers withheld.
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, port: server.address().port, socketsClosed: () => closed, requests: () => requests });
        });
    });
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "m-test": { context: 10_000 } } } },
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
    } as ProxyOptions);
}

/** Opens a request, waits for the first body byte (or headers for JSON),
 *  then destroys the client socket — simulating a user hitting Ctrl-C. */
function abortAfterFirstByte(url: string, headers: Record<string, string>, body: string): Promise<"header" | "first-byte"> {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: "POST", headers }, (res) => {
            res.once("data", () => {
                req.destroy();
                resolve("first-byte");
            });
            // hang-json never sends a body — abort on headers after a beat.
            res.once("end", () => resolve("header"));
        });
        req.on("error", (e: NodeJS.ErrnoException) => {
            if (e.code === "ECONNRESET") resolve("first-byte");
            else reject(e);
        });
        setTimeout(() => {
            req.destroy();
            resolve("header");
        }, 400).unref();
        req.end(body);
    });
}

test("matrix meta: every concern table is exhaustive and every coveredBy test file exists", () => {
    const concernIds = Object.keys(EXIT_CONCERNS) as ExitConcernId[];
    assert.ok(concernIds.length >= 3);
    for (const concern of concernIds) {
        const table = EXIT_CONCERNS[concern] as Record<string, { implementer: unknown[]; contract: string; coveredBy: string[] }>;
        assert.deepEqual(
            Object.keys(table).sort(),
            [...WIRE_EXITS].sort(),
            `${concern} must enumerate exactly WIRE_EXITS (a new exit needs a row here — and typecheck enforces it)`,
        );
        for (const [exitId, cell] of Object.entries(table)) {
            assert.ok(cell.implementer.length > 0, `${concern}/${exitId}: implementer refs are live imports, not strings`);
            assert.ok(cell.contract.length > 20, `${concern}/${exitId}: contract must state the cell's observable behavior`);
            for (const f of cell.coveredBy) {
                assert.ok(existsSync(f), `${concern}/${exitId}: coveredBy "${f}" does not exist — coverage reference went stale`);
            }
        }
    }
});

test("abort x proxy-openai-sse: client abort mid-stream destroys the upstream request", async () => {
    const up = await startUpstream("hang-openai");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`;
        const outcome = await abortAfterFirstByte(url, { "content-type": "application/json", "x-acp-session": "mx-abort-oai" }, JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }));
        assert.ok(outcome === "first-byte" || outcome === "header");
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(up.socketsClosed() >= 1, `upstream socket(s) must be destroyed after the client abort (closed=${up.socketsClosed()})`);
        assert.equal(up.requests(), 1, "exactly one upstream request");
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("abort x proxy-anthropic-sse: client abort mid-stream destroys the upstream request", async () => {
    const up = await startUpstream("hang-anthropic");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/messages`;
        await abortAfterFirstByte(url, { "content-type": "application/json", "x-acp-session": "mx-abort-ant" }, JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }));
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(up.socketsClosed() >= 1, `upstream socket(s) destroyed after client abort (closed=${up.socketsClosed()})`);
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("abort x proxy-responses-sse: client abort mid-stream destroys the upstream request", async () => {
    const up = await startUpstream("hang-responses");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/responses`;
        await abortAfterFirstByte(url, { "content-type": "application/json", "x-acp-session": "mx-abort-resp" }, JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, instructions: "You are a test agent.", input: [{ type: "message", role: "user", content: "hi" }] }));
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(up.socketsClosed() >= 1, `upstream socket(s) destroyed after client abort (closed=${up.socketsClosed()})`);
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("abort x proxy-json: client abort while the JSON is buffering destroys the upstream request", async () => {
    const up = await startUpstream("hang-json");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`;
        await abortAfterFirstByte(url, { "content-type": "application/json", "x-acp-session": "mx-abort-json" }, JSON.stringify({ model: "m-test", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }));
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(up.socketsClosed() >= 1, `upstream socket(s) destroyed after client abort (closed=${up.socketsClosed()})`);
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("error-delivery x proxy-openai-sse: upstream 429 AFTER the early 200 commit arrives in-band as a top-level error frame + [DONE]", async () => {
    const up = await startUpstream("slow-summary-fwd-429");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // ~13k-token history vs 10k window → preflight; the summary call is
        // slow (outlives the 300ms hold grace) and the FORWARD after it hits
        // 429 — both after the early 200 commit, so the error must arrive
        // in-band on the openai wire.
        const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; tHeaderMs: number; body: string }>((resolve, reject) => {
            const t0 = Date.now();
            const req = http.request(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "mx-inband-oai" } }, (res) => {
                const tHeaderMs = Date.now() - t0;
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, tHeaderMs, body: Buffer.concat(chunks).toString("utf8") }));
            });
            req.on("error", reject);
            req.end(JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: bigConversation() }));
        });
        assert.equal(r.status, 200, "early commit owns the status line");
        assert.equal(String(r.headers["content-type"]), "text/event-stream");
        assert.ok(r.tHeaderMs < SLOW_MS, `headers committed before the slow preflight finished (${r.tHeaderMs}ms)`);
        assert.ok(r.body.includes(": bili-preflight"), "keep-alive comment present");
        // Post-commit upstream failure goes through emitStreamError: openai
        // shape = top-level error frame + [DONE]. #1455: the legacy
        // error-delta + finish_reason looked like a successful completion and
        // silenced client retry — it is now opt-out only.
        assert.ok(r.body.includes("upstream HTTP 429"), `in-band error frame carries the upstream status body=${r.body.slice(-600)}`);
        assert.ok(r.body.includes('"code":"stream_error"'), "error frame carries the stream_error code");
        assert.ok(!r.body.includes('"finish_reason"'), "no fabricated completion after the failure");
        assert.ok(r.body.includes("data: [DONE]"), "stream terminates with [DONE]");
        assert.ok(!r.body.includes('"choices":[{"index":0,"message"'), "no fabricated model content after the failure");
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("error-delivery x proxy-openai-sse: preflight failure after the early commit arrives in-band as a top-level error + [DONE]", async () => {
    const up = await startUpstream("slow-summary-429");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; tHeaderMs: number; body: string }>((resolve, reject) => {
            const t0 = Date.now();
            const req = http.request(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "mx-inband-oai2" } }, (res) => {
                const tHeaderMs = Date.now() - t0;
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, tHeaderMs, body: Buffer.concat(chunks).toString("utf8") }));
            });
            req.on("error", reject);
            req.end(JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: bigConversation() }));
        });
        assert.equal(r.status, 200, "early commit owns the status line");
        assert.equal(String(r.headers["content-type"]), "text/event-stream");
        assert.ok(r.tHeaderMs < SLOW_MS, `headers committed before the slow summarization failed (${r.tHeaderMs}ms)`);
        assert.ok(r.body.includes(": bili-preflight"), "keep-alive comment present");
        // Post-commit PREFLIGHT failure goes through emitPreflightError: openai
        // shape = top-level {error} object + [DONE] (no choices framing).
        assert.ok(r.body.includes('"error"'), "top-level in-band error object present");
        assert.ok(r.body.includes("data: [DONE]"), "stream terminates with [DONE]");
        assert.ok(!r.body.includes('"choices"'), "no model content fabricated after the failure");
        assert.equal(up.requests(), 1, "the failed preflight means no forward happened");
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});
