import { after, test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-inline-signal-cleanup-"));
const previous = new Map<string, string | undefined>();
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME"]) {
    previous.set(name, process.env[name]);
    process.env[name] = path.join(root, name);
}
const { getInlineEngine, INLINE_ORIGIN, _resetInlineEngineForTest } = await import("../src/inline-engine.ts");
const engine = await getInlineEngine();
const streams: http.ServerResponse[] = [];
const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
        streams.push(res);
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first");
    });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const rawUrl = `${INLINE_ORIGIN}/bili/http://127.0.0.1:${(upstream.address() as AddressInfo).port}/raw`;

after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const { flushConversations } = await import("../src/plugin.ts");
    const { flushAllSessions } = await import("../src/session.ts");
    flushConversations();
    await flushAllSessions();
    _resetInlineEngineForTest();
    for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
});

test("completed inline health responses detach caller abort listeners", async () => {
    const controller = new AbortController();
    try {
        const response = await engine.dispatch(`${INLINE_ORIGIN}/__bili/health`, { signal: controller.signal });
        assert.equal(response.status, 200);
        await response.text();
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally { controller.abort(); }
});

test("reusing a signal for completed requests retains only caller-owned listeners", async () => {
    const controller = new AbortController();
    const ownListener = (): void => {};
    controller.signal.addEventListener("abort", ownListener);
    try {
        for (let i = 0; i < 5; i++) {
            const response = await engine.dispatch(`${INLINE_ORIGIN}/__bili/health`, { signal: controller.signal });
            await response.text();
        }
        assert.deepEqual(getEventListeners(controller.signal, "abort"), [ownListener]);
    } finally { controller.abort(); }
});

test("completed inline error responses also detach the caller signal", async () => {
    const controller = new AbortController();
    try {
        const response = await engine.dispatch(`${INLINE_ORIGIN}/__bili/no-such-route`, { signal: controller.signal });
        assert.equal(response.status, 404);
        await response.text();
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally { controller.abort(); }
});

test("active streaming responses retain cancellation until the body finishes", async () => {
    const controller = new AbortController();
    try {
        const response = await engine.dispatch(rawUrl, { signal: controller.signal }, globalThis.fetch);
        const reader = response.body!.getReader();
        assert.equal(Buffer.from((await reader.read()).value!).toString(), "first");
        assert.equal(getEventListeners(controller.signal, "abort").length, 1);
        streams.at(-1)!.end("last");
        let tail = "";
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            tail += Buffer.from(chunk.value).toString();
        }
        assert.equal(tail, "last");
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally { controller.abort(); }
});

test("the active response still errors when its caller aborts", async () => {
    const controller = new AbortController();
    const response = await engine.dispatch(rawUrl, { signal: controller.signal }, globalThis.fetch);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await assert.rejects(reader.read(), /client aborted/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
