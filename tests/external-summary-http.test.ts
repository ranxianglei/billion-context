import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { ExternalSummaryExecutor, type SummaryWork } from "../src/external-summary.ts";
import { createSummaryHttpCandidate, _setSummaryRetryDelayForTest, _summaryRetryDelaysForTest, type SummaryHttpTarget } from "../src/external-summary-http.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";
import { setLogCapture } from "../src/logger.ts";
import type { PreflightProtocol } from "../src/preflight.ts";

process.env.NODE_ENV = "test";
const work: SummaryWork = { content: "Prior evidence and decisions", reference: "Read-only current task", instructions: "Preserve unfinished objectives" };
const budget = { totalTimeoutMs: 4000, targetTimeoutMs: 1500, maxSummaryBytes: 2048 };
const summary = "Retained decisions, evidence, constraints and unfinished objectives.";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

afterEach(() => {
    _setSummaryRetryDelayForTest(null);
    setLogCapture(null);
    assert.equal(_liveUpstreamTimersForTest(), 0);
});

function completion(protocol: PreflightProtocol, text = summary): object {
    if (protocol === "responses") return { status: "completed", output_text: text };
    if (protocol === "anthropic") return { stop_reason: "end_turn", content: [{ type: "text", text }] };
    if (protocol === "openai") return { choices: [{ message: { content: text }, finish_reason: "stop" }] };
    return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] };
}

function streamCompletion(protocol: PreflightProtocol): string {
    if (protocol === "responses") return frame({ type: "response.output_text.delta", delta: summary }) + frame({ type: "response.completed", response: completion(protocol) });
    if (protocol === "anthropic") return frame({ type: "content_block_delta", delta: { type: "text_delta", text: summary } }) + frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + frame({ type: "message_stop" });
    if (protocol === "openai") return frame({ choices: [{ delta: { content: summary }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
    return frame(completion(protocol));
}

async function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>) => void, run: (url: string) => Promise<void>): Promise<void> {
    const server = http.createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            handler(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        })().catch(() => { res.writeHead(500); res.end(); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try { await run(`http://127.0.0.1:${address.port}`); }
    finally {
        await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
}

function target(url: string, protocol: PreflightProtocol = "responses", stream = false): SummaryHttpTarget {
    return { url, protocol, model: "external-test-model", headers: { authorization: "Bearer test-summary-key" }, stream };
}

for (const protocol of ["responses", "anthropic", "openai", "google"] as const) {
    for (const streaming of [false, true]) {
        test(`external summary HTTP: ${protocol} ${streaming ? "SSE" : "JSON"} uses the target's own model, headers and read-only reference`, async () => {
            let captured: { body: Record<string, unknown>; headers: http.IncomingHttpHeaders } | undefined;
            await upstream((req, res, body) => {
                captured = { body, headers: req.headers };
                res.setHeader("content-type", streaming ? "text/event-stream" : "application/json");
                res.end(streaming ? streamCompletion(protocol).replace(/\n/g, "\r\n") : JSON.stringify(completion(protocol)));
            }, async (url) => {
                const headers = { authorization: "Bearer test-summary-key" };
                const candidate = createSummaryHttpCandidate({ ...target(url, protocol, streaming), headers }, 4096);
                headers.authorization = "Bearer mutated-key";
                const result = await new ExternalSummaryExecutor(1).execute(work, [candidate], budget);
                assert.equal(result.status, "success");
                if (result.status === "success") assert.equal(result.summary, summary);
            });
            assert.ok(captured);
            assert.equal(captured.headers.authorization, "Bearer test-summary-key");
            assert.equal(captured.headers["x-bili-access-token"], undefined);
            assert.equal(captured.headers["x-session-id"], undefined);
            assert.equal(captured.headers["content-type"], "application/json");
            if (protocol !== "google") assert.equal(captured.body.model, "external-test-model");
            else assert.equal(captured.body.model, undefined);
            if (protocol === "responses") assert.equal(captured.body.store, false);
            if (protocol === "anthropic") assert.equal(captured.headers["anthropic-version"], "2023-06-01");
            const wire = JSON.stringify(captured.body);
            assert.ok(wire.includes(work.content));
            assert.ok(wire.includes(work.reference ?? ""));
            assert.ok(wire.includes("reference is read-only context"));
        });
    }
}

for (const protocol of ["responses", "anthropic", "openai", "google"] as const) {
    for (const [label, ending] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]] as const) {
        for (const complete of [true, false]) {
            test(`external summary HTTP: ${protocol} ${complete ? "accepts complete" : "rejects unterminated"} ${label} SSE`, async () => {
                const stream = streamCompletion(protocol);
                const body = (complete ? stream : stream.slice(0, -1)).replace(/\n/g, ending);
                await upstream((_req, res) => {
                    res.setHeader("content-type", "text/event-stream");
                    res.end(body);
                }, async (url) => {
                    const candidate = createSummaryHttpCandidate(target(url, protocol, true), 4096);
                    if (complete) assert.equal(await candidate.summarize(work, AbortSignal.timeout(4000)), summary);
                    else await assert.rejects(candidate.summarize(work, AbortSignal.timeout(4000)), { message: "External summary response did not complete" });
                });
            });
        }
    }
}

for (const status of [400, 401, 403]) {
    test(`external summary HTTP: ${status} fails fast to the backup without leaking errors`, async () => {
        const paths: string[] = [];
        _setSummaryRetryDelayForTest(0);
        await upstream((req, res) => {
            paths.push(req.url ?? "");
            res.writeHead(req.url === "/primary" ? status : 200);
            res.end(req.url === "/primary" ? "private-error test-summary-key" : JSON.stringify(completion("responses")));
        }, async (url) => {
            const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(`${url}/primary`), 4096), createSummaryHttpCandidate(target(`${url}/backup`), 4096)], budget);
            assert.equal(result.status, "success");
            if (result.status === "success") assert.equal(result.targetIndex, 1);
            assert.equal(JSON.stringify(result).includes("private-error"), false);
            assert.equal(JSON.stringify(result).includes("test-summary-key"), false);
        });
        assert.deepEqual(paths, ["/primary", "/backup"]);
        assert.deepEqual(_summaryRetryDelaysForTest(), []);
    });
}

for (const status of [429, 500, 503]) {
    test(`external summary HTTP: transient ${status} retries twice then switches to the backup without leaking errors`, async () => {
        const paths: string[] = [];
        const lines: string[] = [];
        _setSummaryRetryDelayForTest(0);
        setLogCapture((_level, msg) => lines.push(msg));
        await upstream((req, res) => {
            paths.push(req.url ?? "");
            res.writeHead(req.url === "/primary" ? status : 200);
            res.end(req.url === "/primary" ? "private-error test-summary-key" : JSON.stringify(completion("responses")));
        }, async (url) => {
            const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(`${url}/primary`), 4096), createSummaryHttpCandidate(target(`${url}/backup`), 4096)], budget);
            assert.equal(result.status, "success");
            if (result.status === "success") assert.equal(result.targetIndex, 1);
            // #3488: results stay leak-free while the LOCAL log carries the
            // per-attempt status + truncated body.
            assert.equal(JSON.stringify(result).includes("private-error"), false);
            assert.equal(JSON.stringify(result).includes("test-summary-key"), false);
            assert.equal(lines.filter((line) => line.includes(`rejected: HTTP ${status}`)).length, 3);
            assert.ok(lines.some((line) => line.includes(`rejected: HTTP ${status}`) && line.includes("private-error")));
        });
        assert.deepEqual(paths, ["/primary", "/primary", "/primary", "/backup"]);
        assert.deepEqual(_summaryRetryDelaysForTest(), [1000, 2000]);
    });
}

test("external summary HTTP: a transient 429 with Retry-After recovers on the second dispatch", async () => {
    let hits = 0;
    _setSummaryRetryDelayForTest(0);
    await upstream((_req, res) => {
        hits++;
        // "7" deliberately differs from the attempt-1 backoff fallback (1000 ms)
        // so this assertion proves the header value won, not the backoff default.
        if (hits === 1) { res.writeHead(429, { "retry-after": "7" }); res.end("rate limited"); return; }
        res.end(JSON.stringify(completion("responses")));
    }, async (url) => {
        const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(url), 4096)], budget);
        assert.equal(result.status, "success");
        if (result.status === "success") assert.equal(result.targetIndex, 0);
    });
    assert.equal(hits, 2);
    assert.deepEqual(_summaryRetryDelaysForTest(), [7000]);
});

test("external summary HTTP: a hostile Retry-After is capped so it cannot eat the attempt budget", async () => {
    let hits = 0;
    _setSummaryRetryDelayForTest(0);
    await upstream((_req, res) => {
        hits++;
        if (hits === 1) { res.writeHead(429, { "retry-after": "999" }); res.end("rate limited"); return; }
        res.end(JSON.stringify(completion("responses")));
    }, async (url) => {
        const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(url), 4096)], budget);
        assert.equal(result.status, "success");
    });
    assert.equal(hits, 2);
    assert.deepEqual(_summaryRetryDelaysForTest(), [15000]);
});

test("external summary HTTP: a risk-control 403 body retries like a rate limit", async () => {
    let hits = 0;
    _setSummaryRetryDelayForTest(0);
    await upstream((_req, res) => {
        hits++;
        if (hits < 3) { res.writeHead(403); res.end('{"code":3007,"msg":"captcha verify failed"}'); return; }
        res.end(JSON.stringify(completion("responses")));
    }, async (url) => {
        const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(url), 4096)], budget);
        assert.equal(result.status, "success");
    });
    assert.equal(hits, 3);
});

test("external summary HTTP: a pre-response socket death retries then recovers", async () => {
    let hits = 0;
    _setSummaryRetryDelayForTest(0);
    await upstream((_req, res) => {
        hits++;
        if (hits === 1) { res.destroy(); return; }
        res.end(JSON.stringify(completion("responses")));
    }, async (url) => {
        const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(url), 4096)], budget);
        assert.equal(result.status, "success");
    });
    assert.equal(hits, 2);
});

test("external summary HTTP: an exhausted transient chain logs every attempt and fails closed", async () => {
    const lines: string[] = [];
    _setSummaryRetryDelayForTest(0);
    setLogCapture((_level, msg) => lines.push(msg));
    await upstream((_req, res) => { res.writeHead(503); res.end("upstream unavailable"); }, async (url) => {
        const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(url), 4096)], budget);
        assert.equal(result.status, "failed");
        assert.deepEqual(result.attempts, [{ targetIndex: 0, outcome: "error" }]);
    });
    assert.equal(lines.filter((line) => line.includes("rejected: HTTP 503")).length, 3);
});

for (const protocol of ["responses", "anthropic", "openai", "google"] as const) {
    test(`external summary HTTP: ${protocol} rejects partial JSON rather than folding a truncated summary`, async () => {
        const body = completion(protocol) as Record<string, unknown>;
        if (protocol === "responses") body.status = "incomplete";
        if (protocol === "anthropic") body.stop_reason = "max_tokens";
        if (protocol === "openai") body.choices = [{ message: { content: summary }, finish_reason: "length" }];
        if (protocol === "google") body.candidates = [{ content: { parts: [{ text: summary }] }, finishReason: "MAX_TOKENS" }];
        await upstream((_req, res) => res.end(JSON.stringify(body)), async (url) => {
            const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(url, protocol), 4096)], budget);
            assert.equal(result.status, "failed");
            assert.deepEqual(result.attempts, [{ targetIndex: 0, outcome: "error" }]);
        });
    });
}

for (const body of ["", "<html>Gateway error</html>", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n", streamCompletion("responses").trimEnd(), streamCompletion("responses") + frame({ type: "error", error: { message: "late error" } }), JSON.stringify(completion("responses", " "))]) {
    test(`external summary HTTP: rejects empty/malformed/incomplete content (${body.length} bytes)`, async () => {
        await upstream((_req, res) => res.end(body), async (url) => {
            const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(url), 4096)], budget);
            assert.equal(result.status, "failed");
        });
    });
}

test("external summary HTTP: response byte cap and invalid UTF-8 fail closed", async () => {
    for (const response of [Buffer.from(JSON.stringify(completion("responses", "x".repeat(4096)))), Buffer.from([0xff])]) {
        await upstream((_req, res) => res.end(response), async (url) => {
            const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(url), 512)], budget);
            assert.equal(result.status, "failed");
        });
    }
});

test("external summary HTTP: a stalled response is cancelled before the backup acquires capacity", async () => {
    const paths: string[] = [];
    await upstream((req, res) => {
        paths.push(req.url ?? "");
        if (req.url === "/primary") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(frame({ type: "response.output_text.delta", delta: "partial" }));
        } else res.end(JSON.stringify(completion("responses")));
    }, async (url) => {
        const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(`${url}/primary`), 4096), createSummaryHttpCandidate(target(`${url}/backup`), 4096)], { ...budget, targetTimeoutMs: 150 });
        assert.equal(result.status, "success");
        assert.deepEqual(result.attempts, [{ targetIndex: 0, outcome: "timeout" }, { targetIndex: 1, outcome: "success" }]);
    });
    assert.deepEqual(paths, ["/primary", "/backup"]);
});

for (const protocol of ["responses", "anthropic", "openai", "google"] as const) {
    test(`external summary HTTP: ${protocol} refuses tool calls even if accompanied by text`, async () => {
        const body = completion(protocol) as Record<string, unknown>;
        if (protocol === "responses") body.output = [{ type: "function_call", name: "unexpected" }];
        if (protocol === "anthropic") body.content = [{ type: "text", text: summary }, { type: "tool_use", name: "unexpected" }];
        if (protocol === "openai") body.choices = [{ message: { content: summary, tool_calls: [{ type: "function" }] }, finish_reason: "stop" }];
        if (protocol === "google") body.candidates = [{ content: { parts: [{ text: summary }, { functionCall: { name: "unexpected" } }] }, finishReason: "STOP" }];
        await upstream((_req, res) => res.end(JSON.stringify(body)), async (url) => {
            const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(url, protocol), 4096)], budget);
            assert.equal(result.status, "failed");
        });
    });
}

test("external summary HTTP: redirect is not followed or given credentials", async () => {
    const paths: string[] = [];
    await upstream((req, res) => {
        paths.push(req.url ?? "");
        res.writeHead(307, { location: "/credential-sink" });
        res.end();
    }, async (url) => {
        const result = await new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(target(`${url}/primary`), 4096)], budget);
        assert.equal(result.status, "failed");
    });
    assert.deepEqual(paths, ["/primary"]);
});

test("external summary HTTP: abort closes an active response and suppresses the backup", async () => {
    const controller = new AbortController();
    let calls = 0;
    await upstream((_req, res) => {
        calls++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "response.output_text.delta", delta: "partial" }));
        controller.abort();
    }, async (url) => {
        const candidate = createSummaryHttpCandidate(target(url), 4096);
        const result = await new ExternalSummaryExecutor(1).execute(work, [candidate, candidate], budget, controller.signal);
        assert.equal(result.status, "cancelled");
    });
    assert.equal(calls, 1);
});

test("external summary HTTP: pre-aborted signal dispatches nothing and invalid endpoints/budgets are rejected", async () => {
    let calls = 0;
    await upstream((_req, res) => { calls++; res.end(); }, async (url) => {
        const candidate = createSummaryHttpCandidate(target(url), 4096);
        await assert.rejects(candidate.summarize(work, AbortSignal.abort()));
        for (const endpoint of ["file:///private", "https://user:password@example.com/", `${url}/#fragment`]) assert.throws(() => createSummaryHttpCandidate(target(endpoint), 4096));
        assert.throws(() => createSummaryHttpCandidate(target("invalid test-summary-key"), 4096), { message: "Invalid external summary endpoint" });
        assert.throws(() => createSummaryHttpCandidate({ ...target(url), headers: { authorization: "test-summary-key\ninvalid" } }, 4096), { message: "Invalid external summary headers" });
        for (const limit of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => createSummaryHttpCandidate(target(url), limit));
        assert.throws(() => createSummaryHttpCandidate({ ...target(url), contextWindow: -1 }, 4096));
    });
    assert.equal(calls, 0);
});

test("external summary HTTP batch: concurrent callers share a cross-protocol chain without mixing content or credentials", async () => {
    const paths: string[] = [];
    await upstream((req, res, body) => {
        paths.push(req.url ?? "");
        assert.equal(req.headers["x-session-id"], undefined);
        assert.equal(req.headers["x-bili-access-token"], undefined);
        if (req.url === "/primary") {
            assert.equal(body.model, "primary-model");
            assert.equal(req.headers.authorization, "Bearer primary-test-key");
            res.writeHead(401);
            res.end("private primary error");
            return;
        }
        assert.equal(req.url, "/backup");
        assert.equal(body.model, "backup-model");
        assert.equal(req.headers.authorization, "Bearer backup-test-key");
        assert.ok(Array.isArray(body.messages));
        const user = body.messages.find((message: Record<string, unknown>) => message.role === "user") as Record<string, unknown>;
        assert.equal(typeof user.content, "string");
        const source = JSON.parse(user.content as string) as Record<string, unknown>;
        res.end(JSON.stringify(completion("openai", JSON.stringify(source))));
    }, async (url) => {
        const executor = new ExternalSummaryExecutor(2);
        const candidates = [
            createSummaryHttpCandidate({ ...target(`${url}/primary`), model: "primary-model", headers: { authorization: "Bearer primary-test-key" } }, 4096),
            createSummaryHttpCandidate({ ...target(`${url}/backup`, "openai"), model: "backup-model", headers: { authorization: "Bearer backup-test-key" } }, 4096),
            createSummaryHttpCandidate(target(`${url}/unused`), 4096),
        ];
        const callers = ["client-A", "client-B"];
        const results = await Promise.all(callers.map((caller) => executor.executeBatch([0, 1].map((range) => ({
            ...work, content: `${caller} range ${range}`, reference: `${caller} current task`,
        })), candidates, budget)));
        for (const [callerIndex, result] of results.entries()) {
            assert.equal(result.status, "finished");
            for (const [rangeIndex, range] of result.results.entries()) {
                assert.equal(range.status, "success");
                if (range.status !== "success") assert.fail("backup must generate each range");
                assert.equal(range.targetIndex, 1);
                assert.deepEqual(JSON.parse(range.summary), {
                    content: `${callers[callerIndex]} range ${rangeIndex}`, reference: `${callers[callerIndex]} current task`,
                });
            }
        }
    });
    assert.equal(paths.filter((path) => path === "/primary").length, 4);
    assert.equal(paths.filter((path) => path === "/backup").length, 4);
    assert.equal(paths.length, 8);
});

test("external summary HTTP batch: a shared deadline aborts a real stalled response and skips later ranges", async () => {
    let calls = 0;
    await upstream((_req, res) => {
        calls++;
        if (calls === 1) res.end(JSON.stringify(completion("responses")));
        else { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": still working\n\n"); }
    }, async (url) => {
        const candidate = createSummaryHttpCandidate(target(url), 4096);
        const result = await new ExternalSummaryExecutor(1).executeBatch([work, work, work], [candidate], { ...budget, totalTimeoutMs: 300 });
        assert.equal(result.status, "deadline");
        assert.deepEqual(result.results.map((range) => range.status), ["success", "deadline"]);
    });
    assert.equal(calls, 2);
});
