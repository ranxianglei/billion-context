import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { fetchWithTimeout } from "../src/fetch-util.ts";

function listen(server: http.Server, port: number = 0): Promise<void> {
    server.listen(port, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    return chunks;
}

test("idle timeout: a healthy stream longer than the timeout is NOT aborted (#437)", async () => {
    // 8 chunks at 100ms intervals = ~800ms total, which EXCEEDS the 500ms
    // timeout. A total timer would abort at 500ms (mid-stream); the idle timer
    // re-arms on each chunk (100ms << 500ms) so the full stream completes.
    const timeoutMs = 500;
    const intervalMs = 100;
    const totalChunks = 8;
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        let sent = 0;
        const t = setInterval(() => {
            sent += 1;
            res.write(`chunk-${sent}\n`);
            if (sent >= totalChunks) {
                clearInterval(t);
                res.end();
            }
        }, intervalMs);
        req.on("close", () => clearInterval(t));
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const started = Date.now();
        const result = await fetchWithTimeout(`http://127.0.0.1:${port}/stream`, {}, timeoutMs);
        const chunks = await readAll(result.response.body as ReadableStream<Uint8Array>);
        result.clearTimer();
        const elapsed = Date.now() - started;
        assert.equal(chunks.length, totalChunks);
        assert.equal(
            Buffer.concat(chunks).toString("utf8"),
            "chunk-1\nchunk-2\nchunk-3\nchunk-4\nchunk-5\nchunk-6\nchunk-7\nchunk-8\n",
        );
        assert.ok(elapsed >= timeoutMs, `expected the stream to outlive the timeout (>= ${timeoutMs}ms), got ${elapsed}ms`);
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
    }
});

test("idle timeout: a stuck stream (no further chunks) IS still aborted (#437)", async () => {
    // Sends headers + 1 chunk, then goes silent and never ends. The idle timer
    // re-arms on that single chunk and, with no further chunks, fires at the
    // timeout → abort. Because the server never ends, the only way the read
    // loop terminates is via that abort, so we read-until-error and assert it
    // threw (and that a chunk actually arrived before the stall).
    const timeoutMs = 300;
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write("chunk-1\n");
        // never ends — simulates a stalled upstream
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const result = await fetchWithTimeout(`http://127.0.0.1:${port}/stuck`, {}, timeoutMs);
        const reader = (result.response.body as ReadableStream<Uint8Array>).getReader();
        let threw = false;
        let gotData = false;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.length > 0) gotData = true;
            }
        } catch {
            threw = true;
        } finally {
            result.clearTimer();
        }
        assert.ok(gotData, "expected at least one chunk to arrive before the stall");
        assert.ok(threw, "expected the stuck stream to be aborted by the idle timeout");
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
    }
});

test("wrapped body preserves status + headers (identical shape for callers)", async () => {
    const upstream = http.createServer((_req, res) => {
        res.writeHead(201, { "content-type": "application/json", "x-bili-test": "abc123" });
        res.end('{"ok":true}');
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const result = await fetchWithTimeout(`http://127.0.0.1:${port}/json`, {});
        assert.equal(result.response.status, 201);
        assert.equal(result.response.ok, true);
        assert.equal(result.response.headers.get("content-type"), "application/json");
        assert.equal(result.response.headers.get("x-bili-test"), "abc123");
        assert.equal(await result.response.text(), '{"ok":true}');
        result.clearTimer();
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
    }
});
