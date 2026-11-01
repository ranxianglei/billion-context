import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import type { Prepared } from "../src/server.ts";
import { forward } from "../src/server/relay.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

const OVERFLOW = JSON.stringify({ error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" } });
const RETRY_REJECTION = JSON.stringify({ error: { type: "invalid_request_error", message: "refold retry rejected" } });
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

for (const scenario of ["success", "refold", "declined", "throwing", "rejected"] as const) {
    test(`request input release boundary: ${scenario}`, { timeout: 10_000 }, async t => {
        const url = "http://request-lifetime.test/responses";
        const session = getSession(`input-lifetime-${randomUUID()}`);
        const core = createCore();
        const config = defaultConfig(200_000);
        const messages: CoreMessage[] = [{ id: "m1", role: "user", contentType: "text", text: "Continue." }];
        const body = JSON.stringify({ model: "test-model", stream: true, input: [{ role: "user", content: "Continue." }] });
        const prepared: Prepared = {
            body, session, processedMessages: messages, originalMessages: messages,
            protocol: "responses", stream: true, compressInjected: false,
        };
        const opts: ProxyOptions = {
            host: "127.0.0.1", port: 0, upstream: url, routes: {},
            proxy: "", proxyMode: "direct", proxySource: "direct",
            modelContextLimit: 200_000, kernelConfig: config,
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" }, compat: { roles: {} },
            streamErrorShape: "protocol", sessionHeader: "x-acp-session",
            log: false, debug: false, passthrough: false, passthroughSource: null,
            autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
            advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
        };
        const released = deferred<void>();
        const completed = deferred<void>();
        const trace: string[] = [];
        let releaseCount = 0;
        let forwardCompleted = false;
        let upstreamCalls = 0;
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const nativeFetch = globalThis.fetch;
        t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
            upstreamCalls++;
            trace.push(`fetch:${upstreamCalls}`);
            assert.equal(releaseCount, 0, "inbound reconstruction must remain available until the retry is accepted");
            if (scenario !== "success" && upstreamCalls === 1) {
                return new Response(OVERFLOW, { status: 400, headers: { "content-type": "application/json" } });
            }
            assert.equal(init?.body, upstreamCalls === 1 ? body : `${body} `, "the accepted request keeps its outgoing bytes");
            if (scenario === "rejected") {
                return new Response(RETRY_REJECTION, { status: 422, headers: { "content-type": "application/json" } });
            }
            return new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } }), {
                headers: { "content-type": "text/event-stream" },
            });
        });
        const server = http.createServer((req, res) => {
            req.resume();
            req.url = url;
            void forward(req, res, opts, body, prepared, core, config, () => {}, undefined, "input-lifetime",
                undefined,
                async () => {
                    trace.push("refold");
                    assert.equal(releaseCount, 0, "the refold callback still owns original input");
                    if (scenario === "declined") return null;
                    if (scenario === "throwing") throw new Error("cannot refold");
                    return { body: `${body} `, prepared: { ...prepared, body: `${body} ` } };
                },
                undefined,
                () => { releaseCount++; trace.push("release"); released.resolve(); },
            ).then(() => { forwardCompleted = true; completed.resolve(); }, error => { res.destroy(); completed.reject(error); });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const client = nativeFetch(`http://127.0.0.1:${address.port}`, { method: "POST", body });
        // Attach rejection handlers immediately; cleanup can abort either side.
        void client.catch(() => {});
        void completed.promise.catch(() => {});
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            if (scenario === "success" || scenario === "refold") {
                await Promise.race([
                    released.promise,
                    completed.promise.then(() => assert.fail("forward finished before input release")),
                    new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("input retained while accepted response stream is pending")), 5000); }),
                ]);
                assert.equal(forwardCompleted, false);
                assert.equal(releaseCount, 1);
                assert.ok(streamController, "upstream stream remains pending at the release boundary");
                streamController.enqueue(new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] } })}\n\n`));
                streamController.close();
                streamController = undefined;
            }
            const response = await client;
            const responseText = await response.text();
            await completed.promise;
            assert.equal(releaseCount, 1, "release runs exactly once, including error responses");
            if (scenario === "declined" || scenario === "throwing") {
                assert.equal(response.status, 400);
                assert.equal(responseText, OVERFLOW);
            } else if (scenario === "rejected") {
                assert.equal(response.status, 422);
                assert.equal(responseText, RETRY_REJECTION);
            } else {
                assert.equal(response.status, 200);
                assert.ok(responseText.includes("done"));
            }
            const expectsRetry = scenario === "refold" || scenario === "rejected";
            assert.equal(upstreamCalls, expectsRetry ? 2 : 1);
            assert.deepEqual(trace, scenario === "success" ? ["fetch:1", "release"]
                : expectsRetry ? ["fetch:1", "refold", "fetch:2", "release"]
                : ["fetch:1", "refold", "release"]);
        } finally {
            if (deadline) clearTimeout(deadline);
            streamController?.close();
            const closed = once(server, "close");
            server.close();
            server.closeAllConnections();
            await closed;
            await completed.promise.catch(() => {});
            assert.equal(_liveUpstreamTimersForTest(), 0);
            _resetFetchUtilForTest();
        }
    });
}
