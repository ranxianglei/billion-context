import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { INLINE_ORIGIN, _resetInlineEngineForTest, _setEngineFactoryForTest } from "../src/inline-engine.ts";
import { installInlineTransport, _resetInlineTransportForTest } from "../src/agent/pi-inline.ts";
import { resetFetchChainForTest } from "../src/agent/fetch-chain/index.ts";

const originalFetch = globalThis.fetch;
let hits = 0;
const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
        hits++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
const target = `${INLINE_ORIGIN}/bili/http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/messages?api-version=test`;
beforeEach(() => {
    resetFetchChainForTest();
    _resetInlineTransportForTest();
    _resetInlineEngineForTest();
    _setEngineFactoryForTest(async () => { throw new Error("engine could not start"); });
    installInlineTransport();
});
afterEach(() => {
    _resetInlineTransportForTest();
    resetFetchChainForTest();
    _setEngineFactoryForTest(undefined);
    _resetInlineEngineForTest();
    globalThis.fetch = originalFetch;
});
after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
});

interface Echo { method: string; url: string; headers: Record<string, string | undefined>; body: string }
async function echo(input: string | URL | Request, init?: RequestInit): Promise<Echo> {
    const response = await fetch(input, init);
    assert.equal(response.status, 200);
    return await response.json() as Echo;
}
function request(): Request {
    return new Request(target, { method: "POST", headers: { authorization: "Bearer caller", "content-type": "application/json" }, body: '{"text":"中文🙂"}' });
}

test("direct fallback preserves a Request's method, headers, body and target query", async () => {
    const result = await echo(request());
    assert.equal(result.method, "POST");
    assert.equal(result.headers.authorization, "Bearer caller");
    assert.equal(result.headers["content-type"], "application/json");
    assert.equal(result.body, '{"text":"中文🙂"}');
    assert.equal(result.url, "/v1/messages?api-version=test");
});

test("direct fallback applies RequestInit overrides with native precedence", async () => {
    const result = await echo(request(), { method: "PUT", headers: { "x-new": "new" }, body: "replacement" });
    assert.equal(result.method, "PUT");
    assert.equal(result.headers.authorization, undefined);
    assert.equal(result.headers["x-new"], "new");
    assert.equal(result.body, "replacement");
});

for (const body of [null, undefined]) {
    test(`direct fallback inherits the Request body when init.body is ${body}`, async () => {
        const result = await echo(request(), { body });
        assert.equal(result.method, "POST");
        assert.equal(result.body, '{"text":"中文🙂"}');
    });
}

test("direct fallback retains a Request-backed stream", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("part one "));
        controller.enqueue(new TextEncoder().encode("第二部分"));
        controller.close();
    } });
    const input = new Request(target, { method: "POST", body, duplex: "half" } as RequestInit);
    assert.equal((await echo(input)).body, "part one 第二部分");
});

test("direct fallback preserves GET Request headers", async () => {
    const result = await echo(new Request(target, { headers: { authorization: "Bearer caller" } }));
    assert.equal(result.method, "GET");
    assert.equal(result.headers.authorization, "Bearer caller");
});

test("FormData overrides keep the serialized boundary and POST method", async () => {
    const form = new FormData();
    form.set("message", "replacement");
    const result = await echo(request(), { headers: {}, body: form });
    assert.equal(result.method, "POST");
    const boundary = result.headers["content-type"]?.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
    assert.ok(boundary);
    assert.ok(result.body.startsWith(`--${boundary}\r\n`));
    assert.ok(result.body.includes("replacement\r\n"));
});

test("direct fallback retains host-specific transport options", async () => {
    resetFetchChainForTest();
    _resetInlineTransportForTest();
    const transportContext = {};
    let retained: unknown;
    globalThis.fetch = async (input, init) => {
        retained = (init as RequestInit & { transportContext?: unknown })?.transportContext;
        const effective = new Request(input, init);
        assert.equal(effective.method, "POST");
        assert.equal(await effective.text(), "replacement");
        return new Response("ok");
    };
    installInlineTransport();
    const init: RequestInit & { transportContext: object } = { body: "replacement", transportContext };
    assert.equal(await (await fetch(request(), init)).text(), "ok");
    assert.equal(retained, transportContext);
});

test("direct fallback does not replay an already consumed Request as an empty GET", async () => {
    const input = request();
    await input.text();
    const before = hits;
    await assert.rejects(fetch(input), TypeError);
    assert.equal(hits, before);
});

test("an explicit replacement body can still be sent after the original was consumed", async () => {
    const input = request();
    await input.text();
    const result = await echo(input, { body: "replacement" });
    assert.equal(result.method, "POST");
    assert.equal(result.headers.authorization, "Bearer caller");
    assert.equal(result.body, "replacement");
});

test("direct fallback preserves Request cancellation when startup fails", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    const input = new Request(target, { signal: controller.signal });
    const before = hits;
    await assert.rejects(fetch(input), error => error === reason);
    assert.equal(hits, before);
});

for (const input of [target, new URL(target)]) {
    test(`direct fallback keeps ${typeof input === "string" ? "string" : "URL"} input init fields`, async () => {
        const result = await echo(input, { method: "POST", headers: { "x-new": "new" }, body: "control" });
        assert.equal(result.method, "POST");
        assert.equal(result.headers["x-new"], "new");
        assert.equal(result.body, "control");
    });
}
