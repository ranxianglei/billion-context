import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import test from "node:test";
import { Pool } from "undici";
import { fetchWithTimeout } from "../src/fetch-util.js";
import { runReasoningGuard, type SseSink } from "../src/reasoning-guard.js";

class Sink extends EventEmitter implements SseSink {
    headersSent = false;
    writableEnded = false;
    frames: string[] = [];
    writeHead() { this.headersSent = true; }
    write(chunk: string | Uint8Array) { this.frames.push(Buffer.from(chunk).toString()); return true; }
    end() { this.writableEnded = true; }
}

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const encoder = new TextEncoder();
const originalBody = JSON.stringify({ model: "fixture-model", input: [{ role: "user", content: "retain this input" }], stream: true });
const terminal = (type = "response.completed", tokens = 0) => ({ type, response: { id: "fixture-response", status: type.slice(9), output: [], usage: { input_tokens: 10, output_tokens: tokens, output_tokens_details: { reasoning_tokens: tokens } } } });
const firstRound = frame({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "fixture-reasoning" } })
    + frame({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "fixture-reasoning", encrypted_content: "fixture-encrypted" } })
    + frame(terminal("response.completed", 516));

async function run(body: ReadableStream<Uint8Array>, res = new Sink()) {
    await runReasoningGuard({ firstResponse: new Response(body), clearFirstTimer() {}, upstreamUrl: "http://127.0.0.1:1", reqHeaders: {}, originalBody,
        signal: new AbortController().signal, res, config: { enabled: true, maxContinue: 0 }, log() {} });
    return res;
}

for (const type of ["response.completed", "response.failed", "response.incomplete"]) {
    test(`releases an open round body after ${type} without changing the terminal event`, async () => {
        let cancelled = 0;
        const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(frame(terminal(type)))); }, cancel() { cancelled++; } });
        const sink = await run(stream);
        assert.equal(cancelled, 1);
        assert.equal(stream.locked, false);
        assert.equal(JSON.parse(sink.frames.at(-1)!.slice(6)).type, type);
    });
}

test("body cancellation cannot delay a completed response or reject its fold", { timeout: 2000 }, async () => {
    for (const cancel of [() => new Promise<void>(() => {}), () => Promise.reject(new Error("fixture cancellation rejected"))]) {
        const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(frame(terminal()))); }, cancel });
        const sink = await run(stream);
        assert.equal(sink.writableEnded, true);
        assert.equal(stream.locked, false);
    }
});

test("ordinary upstream EOF still produces the existing incomplete terminal", async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.close(); }, cancel() { cancelled++; } });
    const sink = await run(stream);
    assert.equal(cancelled, 0);
    assert.equal(JSON.parse(sink.frames.at(-1)!.slice(6)).response.incomplete_details.reason, "upstream_eof");
});

test("a continuation can reuse a one-connection HTTP pool after the first terminal keeps its body open", async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            requests.push(body);
            res.writeHead(200, { "content-type": "text/event-stream" });
            if (requests.length === 1) res.write(firstRound);
            else res.end(frame(terminal("response.completed", 10)));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const pool = new Pool(origin, { connections: 1, pipelining: 1 });
    const abort = new AbortController();
    const fuse = setTimeout(() => abort.abort(new Error("fixture deadline")), 5000);
    let clearFirst = () => {};
    try {
        const first = await fetchWithTimeout(origin, { method: "POST", body: originalBody, dispatcher: pool }, 3000, abort.signal);
        clearFirst = first.clearTimer;
        const sink = new Sink();
        await runReasoningGuard({ firstResponse: first.response, clearFirstTimer: first.clearTimer, upstreamUrl: origin, reqHeaders: {}, dispatcher: pool,
            originalBody, signal: abort.signal, res: sink, config: { enabled: true }, log() {} });
        assert.equal(requests.length, 2, "the completed first body must release its pool slot before the next round");
        assert.match(requests[1], /retain this input/);
        assert.match(requests[1], /fixture-encrypted/);
        assert.equal(JSON.parse(sink.frames.at(-1)!.slice(6)).type, "response.completed");
    } finally {
        clearTimeout(fuse);
        abort.abort();
        clearFirst();
        await pool.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
