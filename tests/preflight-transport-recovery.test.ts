import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

process.env.NODE_ENV = "test";
process.env.BILI_REPLAY_RETRY_MAX = "3";
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "SUMMARY: keep the task goal, exact acceptance criteria and next step; the repeated fixture output is disposable.";
const PARTIAL = "PARTIAL_SUMMARY_MUST_NOT_BE_APPLIED";

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0, "each attempt releases its upstream idle timer");
    _resetFetchUtilForTest();
    process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
});

function fixture(url: string, signal?: AbortSignal) {
    const logs: string[] = [];
    const session = getSession(`transport-${randomUUID()}`);
    session.metadata.preflightStreamSummary = true;
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(4000) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    const deps: PreflightDeps = {
        core: createCore(), session,
        config: defaultConfig(6000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
        prompts: defaultPrompts, protocol: "responses", url,
        headers: {}, model: "test-model", signal,
        log: (_level, message) => { logs.push(message); },
    };
    return { deps, messages, logs, session };
}

function success(res: http.ServerResponse) {
    const event = { type: "response.completed", response: { status: "completed", output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: SUMMARY }] },
    ] } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(event)}\n\n`);
}

function disconnectBody(res: http.ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: PARTIAL })}\n\n`);
    setTimeout(() => res.destroy(), 20);
}

async function withUpstream(handler: (res: http.ServerResponse, attempt: number) => void,
    run: (url: string, attempts: () => number) => Promise<void>) {
    let count = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => handler(res, ++count));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
        await run(`http://127.0.0.1:${address.port}/responses`, () => count);
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
    }
}

test("preflight retries a 200 summary body socket reset, applying only the complete retry", async () => {
    await withUpstream((res, attempt) => attempt === 1 ? disconnectBody(res) : success(res), async (url, attempts) => {
        const f = fixture(url);
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(result.fitsWindow, true, result.failure?.detail);
        assert.equal(attempts(), 2);
        assert.equal(result.compressedRanges, 1);
        const blocks = JSON.stringify(f.session.state.blocks);
        assert.ok(blocks.includes(SUMMARY));
        assert.ok(!blocks.includes(PARTIAL));
        assert.match(f.logs.join("\n"), /body.*UND_ERR_SOCKET/);
    });
});

test("preflight retries a socket reset before summary headers", async () => {
    await withUpstream((res, attempt) => attempt === 1 ? res.destroy() : success(res), async (url, attempts) => {
        const f = fixture(url);
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(result.fitsWindow, true, result.failure?.detail);
        assert.equal(attempts(), 2);
        assert.match(f.logs.join("\n"), /request.*UND_ERR_SOCKET/);
    });
});

test("preflight shares one attempt budget across HTTP 503 and body transport failures", async () => {
    await withUpstream((res, attempt) => {
        if (attempt === 1) res.writeHead(503).end("temporary unavailable");
        else disconnectBody(res);
    }, async (url, attempts) => {
        const f = fixture(url);
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(attempts(), 3);
        assert.equal(result.fitsWindow, false);
        assert.equal(result.failure?.kind, "upstream");
        assert.equal(result.failure?.retryable, true);
        assert.match(result.failure?.detail ?? "", /body.*UND_ERR_SOCKET/);
        assert.equal(f.session.state.blocks.length, 0);
    });
});

test("preflight reports gzip decoding failure with its cause and does not retry it", async () => {
    await withUpstream(res => {
        res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
        res.end("not gzip");
    }, async (url, attempts) => {
        const f = fixture(url);
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(attempts(), 1);
        assert.equal(result.failure?.retryable, undefined);
        assert.match(result.failure?.detail ?? "", /body.*Z_DATA_ERROR/);
        assert.equal(f.session.state.blocks.length, 0);
    });
});

test("preflight respects client cancellation during summary body reading", async () => {
    const controller = new AbortController();
    await withUpstream(res => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: ");
        setTimeout(() => controller.abort(), 20);
    }, async (url, attempts) => {
        const f = fixture(url, controller.signal);
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(attempts(), 1);
        assert.equal(result.failure?.kind, "aborted");
        assert.equal(result.failure?.retryable, undefined);
        assert.equal(f.session.state.blocks.length, 0);
    });
});

test("preflight cancellation during HTTP backoff does not make another request", async () => {
    process.env.BILI_REPLAY_RETRY_BASE_MS = "1000";
    const controller = new AbortController();
    await withUpstream(res => {
        res.writeHead(503).end("temporary unavailable");
    }, async (url, attempts) => {
        const f = fixture(url, controller.signal);
        f.deps.log = (_level, message) => {
            f.logs.push(message);
            if (message.includes("retrying")) {
                assert.equal(_liveUpstreamTimersForTest(), 0, "timer is cleared before retry backoff");
                controller.abort();
            }
        };
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(attempts(), 1);
        assert.equal(result.failure?.kind, "aborted");
        assert.equal(f.session.state.blocks.length, 0);
    });
});

test("preflight never retries unknown or abort errors and does not echo sensitive exception text", async () => {
    const secret = "https://user:secret@example.invalid/?api_key=private-key";
    const errors = [
        new TypeError(secret, { cause: new Error(secret) }),
        Object.assign(new Error(secret, { cause: Object.assign(new Error(secret), { code: "ECONNRESET" }) }), { name: "AbortError" }),
    ];
    const originalFetch = globalThis.fetch;
    try {
        for (const error of errors) {
            let attempts = 0;
            globalThis.fetch = async () => { attempts++; throw error; };
            const f = fixture("http://127.0.0.1/unused");
            const result = await preflightCompress(f.deps, f.messages);
            assert.equal(attempts, 1);
            assert.equal(result.failure?.retryable, undefined);
            assert.match(result.failure?.detail ?? "", /summary request failed/);
            const visible = f.logs.join("\n") + result.failure?.detail;
            assert.doesNotMatch(visible, /secret|private-key|example\.invalid/);
            assert.equal(f.session.state.blocks.length, 0);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});
