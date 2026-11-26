import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
    _resetForTest,
    installNativeFetchIntercept,
    replaceRequestPayload,
    replaceRequestTarget,
    withRestoredBody,
} from "../src/agent/native-intercept.ts";

for (const lane of ["rewrite", "routed", "self"] as const) {
    test(`header stamping retains Request cancellation on the ${lane} path`, { timeout: 10_000 }, async () => {
        const saved = globalThis.fetch;
        let response: http.ServerResponse | undefined;
        const arrived = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const server = http.createServer((req, res) => {
            response = res;
            assert.equal(req.headers["x-bili-plugin"], "dsh");
            req.resume();
            req.once("end", () => arrived.resolve());
            res.once("close", () => closed.resolve());
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const url = lane === "self" ? `${origin}/v1/messages`
            : lane === "routed" ? `${origin}/bili/http://upstream.invalid/v1/messages`
                : "http://upstream.invalid/v1/messages";
        const controller = new AbortController();
        const reason = new Error("caller cancelled this generation");
        try {
            _resetForTest();
            installNativeFetchIntercept({
                origin,
                ready: Promise.resolve(origin),
                headersFor: () => ({ "x-bili-plugin": "dsh" }),
            });
            const pending = fetch(new Request(url, { method: "POST", body: "{}", signal: controller.signal }));
            const result = pending.then(value => ({ value }), error => ({ error }));
            await arrived.promise;
            controller.abort(reason);
            response!.end("request was not cancelled");
            const settled = await result;
            assert.ok("error" in settled, "the caller's abort must reject the actual HTTP request");
            assert.equal(settled.error, reason);
            await closed.promise;
        } finally {
            _resetForTest();
            globalThis.fetch = saved;
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
}

for (const operation of ["payload", "restore", "target"] as const) {
    for (const alreadyAborted of [false, true]) {
        test(`${operation} replacement retains ${alreadyAborted ? "pre-existing" : "later"} Request cancellation`, () => {
            const controller = new AbortController();
            const reason = new Error("cancelled");
            if (alreadyAborted) controller.abort(reason);
            const original = new Request("http://upstream.invalid/v1/messages", {
                method: "POST", body: "original", signal: controller.signal,
            });
            let replacement: Request;
            if (operation === "restore") {
                const pair = withRestoredBody(original, undefined, "restored");
                replacement = new Request(pair.input, pair.init);
            } else {
                const event = { request: original };
                if (operation === "payload") replaceRequestPayload(event, "delta");
                else replaceRequestTarget(event, "http://proxy.invalid/v1/messages");
                replacement = event.request;
            }
            if (!alreadyAborted) controller.abort(reason);
            assert.equal(replacement.signal.aborted, true);
            assert.equal(replacement.signal.reason, reason);
        });
    }
}

for (const override of [null, "replacement"] as const) {
    test(`restored bodies retain the ${override} init.signal override`, async () => {
        const original = new AbortController();
        const replacement = new AbortController();
        const request = new Request("http://upstream.invalid/v1/messages", {
            method: "POST", body: "delta", signal: original.signal,
        });
        const pair = withRestoredBody(request, { signal: override === null ? null : replacement.signal }, "restored");
        const effective = new Request(pair.input, pair.init);
        original.abort(new Error("ignored original"));
        assert.equal(effective.signal.aborted, false);
        assert.equal(await effective.text(), "restored");
        if (override === "replacement") {
            const reason = new Error("effective cancellation");
            replacement.abort(reason);
            assert.equal(effective.signal.reason, reason);
        }
    });
}

test("target replacement's streamed-body fallback retains caller cancellation", () => {
    const controller = new AbortController();
    const event: { request: unknown } = {
        request: {
            method: "POST",
            headers: new Headers({ "content-type": "application/json" }),
            body: new ReadableStream<Uint8Array>({ start(stream) { stream.close(); } }),
            signal: controller.signal,
        },
    };
    replaceRequestTarget(event, "http://proxy.invalid/v1/messages");
    assert.ok(event.request instanceof Request);
    const reason = new Error("cancel streamed request");
    controller.abort(reason);
    assert.equal(event.request.signal.reason, reason);
});
