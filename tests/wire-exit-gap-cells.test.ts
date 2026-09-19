import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on the very first 429 instead of the default 3 attempts with
// exponential backoff — the in-band-error tests want the failure immediately.
process.env.BILI_REPLAY_RETRY_MAX = "1";
// Shrink the preflight hold grace so a 1.5s-slow summarization call reliably
// outlives it (default is 30s — too slow for a test).
process.env.BILI_PREFLIGHT_HOLD_MS = "300";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { emitPreflightError } from "../src/stream-error.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";

// #588 gap cells for the exit-enumeration matrix (#608). Each test below fills
// a cell that no other test asserted before this file:
//
//   1. emitPreflightError unit shapes per protocol — proxy-stream-error.test.ts
//      pins emitStreamError only; the preflight emitter (incl. the retryable
//      asymmetry: openai carries it, the other two channels omit it) had none.
//   2. emitPreflightError client-gone robustness (same gap, write-throws mode).
//   3. non-stream + preflight failure AFTER the early 200 commit → JSON error
//      body under the committed 200 (preflight-hold's non-stream test is the
//      success path only).
//   4. non-stream + upstream 4xx AFTER the early commit → verbatim upstream
//      body under the committed 200 (no test asserted this routing at all).
//   5. repeated client aborts on proxy-openai-sse → upstream socket destroyed
//      AND the proxy-side idle timers converge to zero each round (wire-exit-
//      matrix asserts one-shot socket destruction; timer convergence across
//      repeat aborts was unasserted — and only observable via polling, since
//      cleanup lands after undici propagates the abort into the body stream).

const SLOW_MS = 1500;

type Protocol = "anthropic" | "openai" | "responses";
const PROTOCOLS: readonly Protocol[] = ["anthropic", "openai", "responses"];

interface FakeRes {
    res: http.ServerResponse;
    body(): string;
    endCount(): number;
}

function makeRes(failWrite = false): FakeRes {
    const chunks: string[] = [];
    let ends = 0;
    const res = {
        write(chunk: string): boolean {
            if (failWrite) throw new Error("socket hang up");
            chunks.push(String(chunk));
            return true;
        },
        end(chunk?: string): void {
            ends++;
            if (chunk !== undefined) chunks.push(String(chunk));
        },
    } as unknown as http.ServerResponse;
    return { res, body: () => chunks.join(""), endCount: () => ends };
}

async function waitFor(cond: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

test("gap 1: emitPreflightError — protocol-correct channel and payload, exactly one end", () => {
    for (const protocol of PROTOCOLS) {
        for (const retryable of [true, false]) {
            const fr = makeRes();
            emitPreflightError(fr.res, protocol, { message: "rate limited by upstream", retryable });
            const body = fr.body();
            assert.equal(fr.endCount(), 1, `${protocol}/retryable=${retryable}: exactly one res.end()`);
            assert.ok(body.includes('"code":"preflight_compress_failed"'), `${protocol}: structured code preserved`);
            assert.ok(body.includes("rate limited by upstream"), `${protocol}: cause named`);
            switch (protocol) {
                case "openai":
                    // Only the openai channel carries the full error object, retryable included.
                    assert.ok(body.includes(`"retryable":${retryable}`), "retryable flag passed through");
                    assert.ok(!body.includes("event: "), "openai errors ride data frames, not named events");
                    assert.ok(body.trimEnd().endsWith("data: [DONE]"), "[DONE] closes the stream after the error frame");
                    break;
                case "responses":
                    assert.ok(body.startsWith("event: error"), "Responses-API named error event");
                    assert.ok(!body.includes("retryable"), "minimal error event — retryable not part of the shape today");
                    break;
                case "anthropic":
                    // The SDK reads nested error.error.* off the named error event.
                    assert.ok(body.startsWith("event: error"), "Anthropic SDK error channel");
                    assert.ok(body.includes('"error":{"type":"server_error"'), "nested error object for the SDK");
                    assert.ok(!body.includes("retryable"), "minimal error event — retryable not part of the shape today");
                    break;
            }
        }
    }
});

test("gap 2: emitPreflightError — client gone mid-write still ends and never throws", () => {
    for (const protocol of PROTOCOLS) {
        assert.doesNotThrow(
            () => emitPreflightError(makeRes(true).res, protocol, { message: "y", retryable: true }),
            `${protocol}: emitPreflightError swallows write throw`,
        );
    }
});

// ---------------------------------------------------------------------------
// Integration cells: the #568 hold has already committed 200 early, so the
// status line can no longer carry the failure.
// ---------------------------------------------------------------------------

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. " +
    "Key decisions: chose the preflight approach over lossy truncation because the payload must stay coherent. " +
    "Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

function bigConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

type TimedResponse = {
    status: number;
    headers: http.IncomingHttpHeaders;
    tHeaderMs: number;
    body: string;
};

function timedPost(url: string, headers: Record<string, string>, body: string): Promise<TimedResponse> {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const req = http.request(url, { method: "POST", headers }, (res) => {
            const tHeaderMs = Date.now() - t0;
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    tHeaderMs,
                    body: Buffer.concat(chunks).toString("utf8"),
                });
            });
        });
        req.on("error", reject);
        req.end(body);
    });
}

/** Upstream whose summarization call (detected by shape: two messages, system
 *  first — the 32768 cap no longer identifies them since #987 clamps it to
 *  the window headroom) is slow; the forward call gets `forwardStatus`
 *  immediately. */
function startUpstream(forwardStatus: number, forwardBody: string, summaryFails: boolean): Promise<{ server: http.Server; port: number; forwards: () => number }> {
    let forwards = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { messages?: Array<{ role?: string }> } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const msgs = parsed.messages;
            if (Array.isArray(msgs) && msgs.length === 2 && msgs[0]?.role === "system") {
                setTimeout(() => {
                    if (summaryFails) {
                        res.writeHead(429, { "content-type": "application/json" });
                        res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
                    } else {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY_TEXT } }] }));
                    }
                }, SLOW_MS);
            } else {
                forwards++;
                res.writeHead(forwardStatus, { "content-type": "application/json" });
                res.end(forwardBody);
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, port: server.address().port, forwards: () => forwards });
        });
    });
}

async function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-small": { context: 10_000 } } } },
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
    } satisfies ProxyOptions);
    await once(proxy, "listening");
    return proxy;
}

test("gap 3: non-stream + preflight 429 after early commit → structured JSON error under the committed 200", async () => {
    const up = await startUpstream(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "must-not-forward" } }] }), true);
    const proxy = await startProxy(up.port);
    try {
        const r = await timedPost(
            `http://127.0.0.1:${proxy.address().port}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`,
            { "content-type": "application/json", "x-acp-session": "gap-json-429" },
            JSON.stringify({ model: "gpt-small", max_tokens: 1024, messages: bigConversation() }),
        );
        assert.equal(r.status, 200, "status was committed early and cannot become 503 anymore");
        assert.equal(r.headers["x-bili-preflight"], "compressing");
        assert.ok(r.tHeaderMs < SLOW_MS, `headers arrived before summarization finished (${r.tHeaderMs}ms)`);
        assert.ok(r.body.startsWith(" "), "whitespace keep-alive precedes the JSON body");
        const json = JSON.parse(r.body) as { error?: { code?: string; message?: string; retryable?: boolean } };
        assert.equal(json.error?.code, "preflight_compress_failed", "structured error body under the committed 200");
        assert.equal(json.error?.retryable, true);
        assert.equal(up.forwards(), 0, "the over-window payload was NOT forwarded");
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("gap 4: non-stream + upstream 400 after early commit → verbatim upstream body under the committed 200", async () => {
    const up = await startUpstream(400, JSON.stringify({ error: { message: "simulated gateway failure" } }), false);
    const proxy = await startProxy(up.port);
    try {
        const r = await timedPost(
            `http://127.0.0.1:${proxy.address().port}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`,
            { "content-type": "application/json", "x-acp-session": "gap-json-400" },
            JSON.stringify({ model: "gpt-small", max_tokens: 1024, messages: bigConversation() }),
        );
        assert.equal(r.status, 200, "the early commit survives the upstream 400");
        assert.equal(r.headers["x-bili-preflight"], "compressing");
        const json = JSON.parse(r.body) as { error?: { message?: string } };
        assert.equal(json.error?.message, "simulated gateway failure", "verbatim upstream error body under the committed 200");
        assert.equal(up.forwards(), 1);
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.server.close();
        await once(up.server, "close");
    }
});

test("gap 5: repeated client aborts on proxy-openai-sse → upstream destroyed, timers converge to zero each round", async () => {
    let closed = 0;
    const upstream = http.createServer((req, res) => {
        req.on("close", () => { closed++; });
        // Drain the body: with no 'data' consumer the kernel-augmented payload
        // (~11KB even for a one-word prompt) stalls on backpressure and the
        // forward never completes.
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] })}\n\n`);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const proxy = await startProxy(upstream.address().port);
    try {
        for (let round = 0; round < 3; round++) {
            const req = http.request(
                `http://127.0.0.1:${proxy.address().port}/bili/http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
                { method: "POST", headers: { "content-type": "application/json", "x-acp-session": `gap-storm-${round}` } },
            );
            req.on("response", (res) => {
                res.once("data", () => req.destroy());
            });
            req.on("error", () => {/* aborted read */});
            req.end(JSON.stringify({ model: "gpt-small", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }));
            // Cleanup is async on BOTH sides: the proxy clears its idle timer
            // once undici propagates the local abort into the body stream, and
            // the upstream socket-close event lands only after the RST arrives
            // (measured: timer live at t+0, gone well before 1s). Poll both
            // observables instead of asserting synchronously against either.
            await waitFor(
                () => _liveUpstreamTimersForTest() === 0 && closed >= round + 1,
                4000,
                `round ${round}: timers converge and upstream socket closes`,
            );
        }
        assert.ok(closed >= 3, `every aborted round destroyed its upstream socket (closed=${closed})`);
        assert.equal(_liveUpstreamTimersForTest(), 0, "no accumulated timers after the storm");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
