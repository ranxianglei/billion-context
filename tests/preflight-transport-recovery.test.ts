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
        server.closeIdleConnections?.();
        server.closeAllConnections();
        await closed;
    }
}

test("preflight retries a 200 summary body socket reset, applying only the complete retry", async () => {
    await withUpstream((res, attempt) => attempt === 1 ? disconnectBody(res) : success(res), async (url, attempts) => {
        const f = fixture(url);
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(result.fitsWindow, true, result.failure?.detail);
        // 3, not 2: #668 bounds every summary input to the chunk budget, so the
        // over-budget fixture message splits into two chunks — one request per chunk.
        assert.equal(attempts(), 3);
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
        // 3, not 2: see the bounded-chunk note in the body-reset test above.
        assert.equal(attempts(), 3);
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

test("preflight reports gzip decoding failure with its cause, skips the in-loop retry, but keeps it client-retryable", async () => {
    await withUpstream(res => {
        res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
        res.end("not gzip");
    }, async (url, attempts) => {
        const f = fixture(url);
        const result = await preflightCompress(f.deps, f.messages);
        assert.equal(attempts(), 1);
        // #1987: the call did not complete — no upstream verdict on the content — so the
        // client may still retry the turn even though bili does not loop on it here.
        assert.equal(result.failure?.retryable, true);
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

test("preflight never retries unknown or abort errors in-loop and does not echo sensitive exception text", async () => {
    const secret = "https://user:secret@example.invalid/?api_key=private-key";
    // #1987: an unknown transport death is still retryable FOR THE CLIENT (no upstream
    // verdict was rendered); an abort is not. In-loop, neither is retried.
    const cases: Array<[unknown, boolean | undefined]> = [
        [new TypeError(secret, { cause: new Error(secret) }), true],
        [Object.assign(new Error(secret, { cause: Object.assign(new Error(secret), { code: "ECONNRESET" }) }), { name: "AbortError" }), undefined],
    ];
    const originalFetch = globalThis.fetch;
    try {
        for (const [error, expectedRetryable] of cases) {
            let attempts = 0;
            globalThis.fetch = async () => { attempts++; throw error; };
            const f = fixture("http://127.0.0.1/unused");
            const result = await preflightCompress(f.deps, f.messages);
            assert.equal(attempts, 1);
            assert.equal(result.failure?.retryable, expectedRetryable);
            assert.match(result.failure?.detail ?? "", /summary request failed/);
            const visible = f.logs.join("\n") + result.failure?.detail;
            assert.doesNotMatch(visible, /secret|private-key|example\.invalid/);
            assert.equal(f.session.state.blocks.length, 0);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function netFailure(code: string, message: string): Error {
    return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

test("preflight retries connect-timeout and DNS summary failures within the budget (#1987 main-path parity)", async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const [code, label] of [["UND_ERR_CONNECT_TIMEOUT", "connect timeout"], ["ENOTFOUND", "DNS failure"]] as const) {
            let attempts = 0;
            globalThis.fetch = async () => { attempts++; throw netFailure(code, label); };
            const f = fixture("http://127.0.0.1/unused");
            const result = await preflightCompress(f.deps, f.messages);
            // The main model-request path replays exactly these kinds (#1453); the
            // summary path used to die on attempt 1 for them.
            assert.equal(attempts, 3, `${code}: full replay budget consumed`);
            assert.equal(result.failure?.kind, "upstream");
            assert.equal(result.failure?.retryable, true);
            assert.match(result.failure?.detail ?? "", new RegExp(`code=${code}`));
            assert.equal(f.session.state.blocks.length, 0);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("preflight marks TLS trust failures client-retryable without in-loop retry and names the CA remedy (#1987)", async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const [code, withHint] of [
            ["DEPTH_ZERO_SELF_SIGNED_CERT", true],
            ["CERT_HAS_EXPIRED", true],
            ["EPROTO", false],
        ] as Array<[string, boolean]>) {
            let attempts = 0;
            globalThis.fetch = async () => { attempts++; throw netFailure(code, `tls ${code}`); };
            const f = fixture("http://127.0.0.1/unused");
            const result = await preflightCompress(f.deps, f.messages);
            // A bad CA does not self-heal in the backoff window — no in-loop retry
            // (the main path treats tls kinds the same way) — but the turn itself
            // stays retryable once the operator fixes the CA.
            assert.equal(attempts, 1, `${code}: no in-loop retry`);
            assert.equal(result.failure?.kind, "upstream");
            assert.equal(result.failure?.retryable, true, `${code}: client-retryable`);
            if (withHint) {
                assert.match(result.failure?.detail ?? "", /NODE_EXTRA_CA_CERTS/);
                assert.match(result.failure?.detail ?? "", /security software/);
            } else {
                assert.doesNotMatch(result.failure?.detail ?? "", /NODE_EXTRA_CA_CERTS/);
            }
            assert.equal(f.session.state.blocks.length, 0);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});
