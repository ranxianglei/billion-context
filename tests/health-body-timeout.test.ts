import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { probeLiveness } from "../src/liveness.ts";

async function withServer(handler: http.RequestListener, run: (origin: string) => Promise<void>): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test("a health body stalled after successful headers is busy", { timeout: 5_000 }, async () => {
    let requested = false;
    await withServer((_req, res) => {
        requested = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        res.write('{"ok":');
    }, async (origin) => {
        const verdict = await probeLiveness(origin, 500);
        assert.equal(requested, true);
        assert.equal(verdict.state, "busy");
        assert.match(verdict.detail!, /after TCP connect/);
    });
});

test("a complete healthy payload remains alive", async () => {
    await withServer((_req, res) => res.end('{"ok":true}'), async (origin) => {
        assert.equal((await probeLiveness(origin, 1_000)).state, "alive");
    });
});

test("a complete malformed payload remains dead", async () => {
    await withServer((_req, res) => res.end("not JSON"), async (origin) => {
        const verdict = await probeLiveness(origin, 1_000);
        assert.equal(verdict.state, "dead");
        assert.match(verdict.detail!, /non-JSON/);
    });
});
