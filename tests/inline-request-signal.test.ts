import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

interface Fixture {
    started: ReturnType<typeof deferred>;
    closed: ReturnType<typeof deferred>;
    response?: http.ServerResponse;
    stream?: boolean;
}
const pending = new Map<string, Fixture>();
let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
        upstreamHits++;
        const fixture = pending.get(req.url ?? "");
        if (!fixture) { res.end("complete"); return; }
        fixture.response = res;
        res.once("close", fixture.closed.resolve);
        if (fixture.stream) {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            res.write("first");
        }
        fixture.started.resolve();
    });
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
const ie = await import("../src/inline-engine.ts");

after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const { flushAllSessions } = await import("../src/session.ts");
    await flushAllSessions();
    ie._resetInlineEngineForTest();
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("inline cancellation did not settle")), 3000);
            }),
        ]);
    } finally { clearTimeout(timer); }
}

for (const explicitUndefined of [false, true]) {
    test(`Request.signal cancels before headers (${explicitUndefined ? "undefined signal override" : "omitted init"})`, { timeout: 30_000 }, async () => {
        const engine = await ie.getInlineEngine();
        const endpoint = `/pending-${explicitUndefined}`;
        const fixture: Fixture = { started: deferred(), closed: deferred() };
        pending.set(endpoint, fixture);
        const controller = new AbortController();
        const reason = new Error("request caller cancelled");
        const request = new Request(`${ie.INLINE_ORIGIN}/bili/${origin}${endpoint}`, { signal: controller.signal });
        const call = engine.dispatch(request, explicitUndefined ? { signal: undefined } : undefined, globalThis.fetch);
        try {
            await bounded(fixture.started.promise);
            controller.abort(reason);
            await assert.rejects(bounded(call), (error: unknown) => error === reason);
            await bounded(fixture.closed.promise);
        } finally {
            fixture.response?.end("released");
            await call.then((response) => response.text(), () => {}).catch(() => {});
            pending.delete(endpoint);
        }
    });
}

test("Request.signal aborts a committed body and closes the live upstream", { timeout: 30_000 }, async () => {
    const engine = await ie.getInlineEngine();
    const endpoint = "/stream";
    const fixture: Fixture = { started: deferred(), closed: deferred(), stream: true };
    pending.set(endpoint, fixture);
    const controller = new AbortController();
    const request = new Request(`${ie.INLINE_ORIGIN}/bili/${origin}${endpoint}`, { signal: controller.signal });
    const response = await bounded(engine.dispatch(request, {}, globalThis.fetch));
    const reader = response.body!.getReader();
    let read: ReturnType<typeof reader.read> | undefined;
    try {
        assert.equal(new TextDecoder().decode((await bounded(reader.read())).value), "first");
        controller.abort();
        read = reader.read();
        await assert.rejects(bounded(read), /abort/i);
        await bounded(fixture.closed.promise);
    } finally {
        fixture.response?.end();
        await read?.catch(() => {});
        reader.releaseLock();
        pending.delete(endpoint);
    }
});

test("a pre-aborted Request never reaches the upstream", { timeout: 30_000 }, async () => {
    const engine = await ie.getInlineEngine();
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    const request = new Request(`${ie.INLINE_ORIGIN}/bili/${origin}/ok`, { signal: controller.signal });
    const before = upstreamHits;
    await assert.rejects(engine.dispatch(request, undefined, globalThis.fetch), (error: unknown) => error === reason);
    assert.equal(upstreamHits, before);
});

for (const override of ["signal", "null"] as const) {
    test(`init.signal=${override} overrides an aborted Request signal`, { timeout: 30_000 }, async () => {
        const engine = await ie.getInlineEngine();
        const controller = new AbortController();
        controller.abort();
        const request = new Request(`${ie.INLINE_ORIGIN}/bili/${origin}/ok`, { signal: controller.signal });
        const init = { signal: override === "null" ? null : new AbortController().signal };
        const response = await engine.dispatch(request, init, globalThis.fetch);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "complete");
    });
}
