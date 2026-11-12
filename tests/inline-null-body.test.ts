import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
        const status = Number(req.url?.slice(1));
        res.writeHead(status, { "content-type": "text/plain", "x-inline-test": "preserved" });
        res.end(status === 200 || status === 201 ? "upstream content" : undefined);
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

for (const status of [204, 205, 304]) {
    test(`inline HTTP ${status} has a null Response body`, { timeout: 30_000 }, async () => {
        const engine = await ie.getInlineEngine();
        const response = await engine.dispatch(`${ie.INLINE_ORIGIN}/bili/${origin}/${status}`, {}, globalThis.fetch);
        assert.equal(response.status, status);
        assert.equal(response.body, null);
        assert.equal(await response.text(), "");
        assert.equal(response.headers.get("x-inline-test"), "preserved");
    });
}

test("inline HEAD has a null body even when the status allows a GET body", { timeout: 30_000 }, async () => {
    const engine = await ie.getInlineEngine();
    const response = await engine.dispatch(`${ie.INLINE_ORIGIN}/bili/${origin}/200`, { method: "HEAD" }, globalThis.fetch);
    assert.equal(response.status, 200);
    assert.equal(response.body, null);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("x-inline-test"), "preserved");
});

for (const status of [200, 201]) {
    test(`inline GET ${status} keeps its readable response content`, { timeout: 30_000 }, async () => {
        const engine = await ie.getInlineEngine();
        const response = await engine.dispatch(`${ie.INLINE_ORIGIN}/bili/${origin}/${status}`, {}, globalThis.fetch);
        assert.equal(response.status, status);
        assert.ok(response.body);
        assert.equal(await response.text(), "upstream content");
    });
}
