// #4985: pi-inline batched output — the dispatcher used to await the WHOLE
// pipeline (last relayed byte) before handing the caller its Response, so an
// interactive host could not see a single token until generation finished.
// Deterministic liveness proof: the mock upstream HOLDS THE STREAM OPEN after
// the first delta until the caller demonstrably receives it. If the dispatcher
// buffers the full response first, the gate never opens, the mock stalls out,
// and `stalled` flips true — the assertion below names the bug.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Hermetic storage BEFORE anything store-touching loads (same pattern as
// pi-inline.test.ts): sessions under XDG_DATA_HOME, routing table under
// XDG_STATE_HOME, config template under XDG_CONFIG_HOME.
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-inline-stream-state-"));
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-inline-stream-data-"));
const CONFIG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-inline-stream-config-"));
const PREV_STATE = process.env.XDG_STATE_HOME;
const PREV_DATA = process.env.XDG_DATA_HOME;
const PREV_CONFIG = process.env.XDG_CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
process.env.XDG_DATA_HOME = DATA_ROOT;
process.env.XDG_CONFIG_HOME = CONFIG_ROOT;
after(async () => {
    try {
        const { flushConversations } = await import("../src/plugin.ts");
        const { flushAllSessions } = await import("../src/session.ts");
        flushConversations();
        await flushAllSessions();
    } catch { /* engine never booted in this run */ }
    if (PREV_STATE === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_STATE;
    if (PREV_DATA === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = PREV_DATA;
    if (PREV_CONFIG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = PREV_CONFIG;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    fs.rmSync(CONFIG_ROOT, { recursive: true, force: true });
});

const STALL_MS = 8000;
const hits: string[] = [];
let callerSawTok1 = false;
let stalled = false;

function sse(name: string, data: unknown): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        hits.push(`${req.method} ${req.url}`);
        if (req.url !== "/v1/messages") {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(sse("message_start", {
            type: "message_start",
            message: {
                id: "msg_1", type: "message", role: "assistant", model: "test-model",
                content: [], stop_reason: null, stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 1 },
            },
        }));
        res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tok-1" } }));
        // Liveness gate: keep generating ONLY once the caller has provably
        // received tok-1. A dispatcher that awaits the full pipeline can never
        // get the caller to this point — the mock stalls and ends instead.
        const startedAt = Date.now();
        const timer = setInterval(() => {
            if (res.destroyed) { clearInterval(timer); return; }
            if (callerSawTok1) {
                clearInterval(timer);
                res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tok-2" } }));
                res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tok-3" } }));
                res.write(sse("message_stop", { type: "message_stop" }));
                res.end();
            } else if (Date.now() - startedAt > STALL_MS) {
                stalled = true;
                clearInterval(timer);
                res.end();
            }
        }, 50);
    });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
after(() => {
    upstream.closeAllConnections();
    upstream.close();
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<never>((_, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
            t.unref?.();
        }),
    ]);
}

test("#4985 inline streaming: caller receives tokens WHILE upstream is still generating", { timeout: 120_000 }, async () => {
    const ie = await import("../src/inline-engine.ts");
    const engine = await withTimeout(ie.getInlineEngine(), 60_000, "engine boot");
    const before = hits.length;
    // Real model lane (max_tokens > 200), streaming SSE.
    const r = await withTimeout(
        engine.dispatch(
            `${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-bili-plugin": "pi",
                    "x-bili-plugin-conversation": "inline-stream-session-1",
                },
                body: JSON.stringify({ model: "test-model", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
            },
            globalThis.fetch,
        ),
        30_000,
        "model dispatch",
    );
    assert.equal(r.status, 200);
    assert.ok(r.body, "streaming response must carry a body stream");
    // Read until tok-1 surfaces (tolerates arbitrary chunk framing), then
    // release the upstream gate.
    const reader = r.body.getReader();
    let head = "";
    for (let i = 0; i < 200 && !head.includes("tok-1"); i++) {
        const ch = await withTimeout(reader.read(), 30_000, "read head");
        if (ch.done) break;
        head += Buffer.from(ch.value).toString("utf8");
    }
    assert.ok(head.includes("tok-1"), `tok-1 never reached the caller: ${head.slice(0, 300)}`);
    callerSawTok1 = true;
    let tail = "";
    for (;;) {
        const ch = await withTimeout(reader.read(), 30_000, "read tail");
        if (ch.done) break;
        tail += Buffer.from(ch.value).toString("utf8");
    }
    assert.equal(stalled, false, "upstream had to stall waiting for the caller — the dispatcher buffered the entire response before handing over the Response (#4985)");
    const all = head + tail;
    const i1 = all.indexOf("tok-1");
    const i2 = all.indexOf("tok-2");
    const i3 = all.indexOf("tok-3");
    assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, `tokens missing or out of order: ${all.slice(0, 400)}`);
    // loop safety: exactly ONE upstream round trip
    assert.deepEqual(hits.slice(before), ["POST /v1/messages"]);
});
