import { after, test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-inline-request-init-"));
const previous = new Map<string, string | undefined>();
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME"]) {
    previous.set(name, process.env[name]);
    process.env[name] = path.join(root, name);
}
const { getInlineEngine, INLINE_ORIGIN, _resetInlineEngineForTest } = await import("../src/inline-engine.ts");
const engine = await getInlineEngine();
let hits = 0;
const streamResponses: http.ServerResponse[] = [];
const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
        hits++;
        if (req.url === "/signal-stream") {
            streamResponses.push(res);
            res.writeHead(200, { "content-type": "text/plain" });
            res.write("first");
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
const target = `${INLINE_ORIGIN}/bili/http://127.0.0.1:${(upstream.address() as AddressInfo).port}/echo`;
const streamTarget = target.replace(/\/echo$/, "/signal-stream");
after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    _resetInlineEngineForTest();
    for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
});

interface Echo { method: string; headers: Record<string, string | undefined>; body: string }
async function dispatch(input: string | URL | Request, init?: RequestInit): Promise<Echo> {
    const response = await engine.dispatch(input, init, globalThis.fetch);
    assert.equal(response.status, 200);
    return await response.json() as Echo;
}
function original(): Request {
    return new Request(target, { method: "POST", headers: { authorization: "Bearer original", "x-original": "old", "content-type": "application/custom" }, body: "original" });
}

const headerCases: [string, NonNullable<RequestInit["headers"]>][] = [
    ["empty object", {}],
    ["object", { "x-replacement": "new" }],
    ["Headers", new Headers({ "x-replacement": "new" })],
    ["tuples", [["x-replacement", "new"]]],
];
for (const [name, headers] of headerCases) {
    test(`RequestInit headers replace Request headers (${name})`, async () => {
        const result = await dispatch(original(), { headers });
        assert.equal(result.headers.authorization, undefined);
        assert.equal(result.headers["x-original"], undefined);
        assert.equal(result.headers["content-type"], undefined);
        assert.equal(result.headers["x-replacement"], new Headers(headers).get("x-replacement") ?? undefined);
        assert.equal(result.body, "original");
    });
}

for (const body of [undefined, null]) {
    test(`a ${body} body override inherits the Request body`, async () => {
        const input = original();
        const result = await dispatch(input, { body });
        assert.equal(result.body, "original");
        assert.equal(result.headers.authorization, "Bearer original");
        assert.equal(input.bodyUsed, true);
    });
}

for (const body of ["replacement", ""]) {
    test(`an explicit ${body ? "nonempty" : "empty"} body override does not consume the original`, async () => {
        const input = original();
        const result = await dispatch(input, { body });
        assert.equal(result.body, body);
        assert.equal(await input.text(), "original");
    });
}

test("a body override does not wait for an unused original stream", { timeout: 10_000 }, async () => {
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) { finish = () => controller.close(); } });
    const input = new Request(target, { method: "POST", body, duplex: "half" } as RequestInit);
    const request = dispatch(input, { body: "replacement" });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; finish(); }, 1000);
    try {
        assert.equal((await request).body, "replacement");
        assert.equal(timedOut, false, "the overridden body must never delay dispatch");
        assert.equal(input.bodyUsed, false);
    } finally {
        clearTimeout(timeout);
        if (!timedOut) finish();
    }
});

test("a consumed Request body fails before any upstream call", async () => {
    const input = original();
    await input.text();
    const before = hits;
    await assert.rejects(dispatch(input), TypeError);
    assert.equal(hits, before);
});

test("a failing Request body propagates its error without sending an empty request", async () => {
    const failure = new Error("source stream failed");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
    const input = new Request(target, { method: "POST", body, duplex: "half" } as RequestInit);
    const before = hits;
    await assert.rejects(dispatch(input), error => error === failure);
    assert.equal(hits, before);
});

test("explicit body replacement permits a previously consumed Request", async () => {
    const input = original();
    await input.text();
    assert.equal((await dispatch(input, { body: "replacement" })).body, "replacement");
});

test("string and URL inputs retain fetch body encoding and inferred content types", async () => {
    for (const input of [target, new URL(target)]) {
        const text = await dispatch(input, { method: "POST", body: "hello" });
        assert.equal(text.body, "hello");
        assert.equal(text.headers["content-type"], "text/plain;charset=UTF-8");
        const form = await dispatch(input, { method: "POST", body: new URLSearchParams({ query: "中文 & hello" }) });
        assert.equal(form.body, "query=%E4%B8%AD%E6%96%87+%26+hello");
        assert.equal(form.headers["content-type"], "application/x-www-form-urlencoded;charset=UTF-8");
    }
});

test("FormData receives the matching multipart boundary", async () => {
    const form = new FormData();
    form.set("prompt", "hello");
    form.set("file", new Blob(["content"], { type: "text/plain" }), "notes.txt");
    const result = await dispatch(target, { method: "POST", body: form });
    const boundary = result.headers["content-type"]?.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
    assert.ok(boundary);
    assert.ok(result.body.startsWith(`--${boundary}\r\n`));
    assert.ok(result.body.includes('name="file"; filename="notes.txt"'));
    assert.ok(result.body.includes("content\r\n"));
});

test("GET body validation rejects before reaching the upstream", async () => {
    const before = hits;
    await assert.rejects(dispatch(target, { method: "GET", body: "invalid" }), TypeError);
    assert.equal(hits, before);
});

async function openStream(input: string | URL | Request, init?: RequestInit) {
    const response = await engine.dispatch(input, init, globalThis.fetch);
    const reader = response.body!.getReader();
    assert.equal(Buffer.from((await reader.read()).value!).toString(), "first");
    return { reader, source: streamResponses.at(-1)! };
}

async function finishStream(stream: Awaited<ReturnType<typeof openStream>>): Promise<void> {
    stream.source.end("last");
    let tail = "";
    for (;;) {
        const chunk = await stream.reader.read();
        if (chunk.done) break;
        tail += Buffer.from(chunk.value).toString();
    }
    assert.equal(tail, "last");
}

async function closeStream(stream: Awaited<ReturnType<typeof openStream>>): Promise<void> {
    if (!stream.source.writableEnded) stream.source.end();
    await stream.reader.cancel().catch(() => {});
}

for (const kind of ["string", "URL"] as const) {
    test(`normalizing a ${kind} input leaves cancellation with the dispatcher`, async () => {
        const controller = new AbortController();
        const ownListener = (): void => {};
        controller.signal.addEventListener("abort", ownListener);
        const stream = await openStream(kind === "string" ? streamTarget : new URL(streamTarget), { signal: controller.signal });
        try {
            assert.equal(getEventListeners(controller.signal, "abort").length, 2, "only the caller and dispatcher own listeners");
            await finishStream(stream);
            assert.deepEqual(getEventListeners(controller.signal, "abort"), [ownListener]);
        } finally {
            controller.abort();
            await closeStream(stream);
        }
    });
}

test("normalizing a Request does not retain a dependency on its signal", async () => {
    const controller = new AbortController();
    const input = new Request(streamTarget, { signal: controller.signal });
    const before = getEventListeners(input.signal, "abort");
    const stream = await openStream(input);
    try {
        // Request-only dispatch signal inheritance is a separate transport
        // concern; the temporary body/header normalizer must not own it.
        await finishStream(stream);
        assert.deepEqual(getEventListeners(input.signal, "abort"), before);
    } finally {
        controller.abort();
        await closeStream(stream);
    }
});

test("an explicit init signal owns cancellation instead of the Request signal", async () => {
    const original = new AbortController();
    const replacement = new AbortController();
    const input = new Request(streamTarget, { signal: original.signal });
    const stream = await openStream(input, { signal: replacement.signal });
    try {
        assert.equal(getEventListeners(input.signal, "abort").length, 0);
        assert.equal(getEventListeners(replacement.signal, "abort").length, 1);
        original.abort(new Error("original request cancelled"));
        assert.equal(replacement.signal.aborted, false);
        replacement.abort(new Error("effective signal cancelled"));
        await assert.rejects(stream.reader.read(), /client aborted/);
        assert.equal(getEventListeners(replacement.signal, "abort").length, 0);
    } finally {
        original.abort();
        replacement.abort();
        await closeStream(stream);
    }
});

test("an explicit null signal keeps an aborted Request override independent", async () => {
    const original = new AbortController();
    const input = new Request(streamTarget, { signal: original.signal });
    original.abort(new Error("overridden request cancellation"));
    const stream = await openStream(input, { signal: null });
    try {
        await finishStream(stream);
        assert.equal(getEventListeners(input.signal, "abort").length, 0);
    } finally { await closeStream(stream); }
});

test("a body read failure does not retain the init signal before dispatch starts", async () => {
    const controller = new AbortController();
    const failure = new Error("normalization body failed");
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.error(failure); } });
    const before = hits;
    try {
        await assert.rejects(dispatch(target, { method: "POST", body, duplex: "half", signal: controller.signal } as RequestInit), error => error === failure);
        assert.equal(hits, before);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally { controller.abort(); }
});

for (const kind of ["inherited", "non-enumerable"] as const) {
    test(`RequestInit keeps ${kind} body, method, and header members`, async () => {
        const fields: RequestInit = { method: "POST", body: "dictionary body", headers: { "x-dictionary": kind } };
        const init: RequestInit = kind === "inherited"
            ? Object.create(fields) as RequestInit
            : Object.create(null, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]))) as RequestInit;
        const result = await dispatch(target, init);
        assert.equal(result.method, "POST");
        assert.equal(result.body, "dictionary body");
        assert.equal(result.headers["x-dictionary"], kind);
    });
}
