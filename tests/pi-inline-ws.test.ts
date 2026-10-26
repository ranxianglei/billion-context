import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import {
    _resetForTest,
    installNativeWebSocketIntercept,
} from "../src/agent/native-ws-intercept.ts";
import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import { startInlineWsBridge } from "../src/inline-ws.ts";
import { currentFetchTransport } from "../src/fetch-transport.ts";

// #3278 follow-up: the inline lane's codex Responses WebSocket coverage.
// Inline mode freezes a never-dialable pseudo-origin for HTTP, so the WS
// wrapper must rewrite to the engine's loopback bridge instead. Exercised
// end to end in-process, zero network beyond 127.0.0.1:
//   A  wsOrigin promise (bridge booting) → construction defers, then routes
//      through the loopback bridge: claim (session-id), envelope dispatch,
//      session-wrapped WS transport egress to a fake upstream, SSE back,
//      frames re-framed to the client.
//   B  plain HTTP against the bridge port → 426 (upgrades only).
//   C  wsOrigin settling undefined → DIRECT degrade (warned once).
// Run: node --import tsx --test tests/pi-inline-ws.test.ts

const TMO = 20_000;
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
}

interface Frame {
    type: string;
    [key: string]: unknown;
}

/** Minimal fake codex upstream: one Responses exchange per connection. */
function startFakeUpstream(): Promise<{ url: string; close: () => Promise<void>; seen: Frame[] }> {
    return new Promise(resolve => {
        const seen: Frame[] = [];
        const server = http.createServer((_req, res) => {
            res.writeHead(404);
            res.end();
        });
        const wss = new WebSocketServer({ server });
        wss.on("connection", ws => {
            ws.on("message", (data: Buffer) => {
                let frame: Frame;
                try {
                    frame = JSON.parse(data.toString("utf8")) as Frame;
                } catch {
                    return;
                }
                seen.push(frame);
                if (frame.type !== "response.create") return;
                ws.send(JSON.stringify({ type: "response.created", response: { id: "resp_inline_ws" } }));
                ws.send(JSON.stringify({ type: "response.output_text.delta", delta: "hello from ws upstream" }));
                ws.send(JSON.stringify({
                    type: "response.completed",
                    response: { id: "resp_inline_ws", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello from ws upstream" }] }] },
                }));
            });
        });
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };
            resolve({
                url: `http://127.0.0.1:${port}/v1/responses`,
                close: () => new Promise(r => wss.close(() => server.close(() => r()))),
                seen,
            });
        });
        server.unref();
    });
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function savedDescriptor(): PropertyDescriptor | undefined {
    return Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
}

function restoreDescriptor(descriptor: PropertyDescriptor | undefined): void {
    if (descriptor === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket;
    else Object.defineProperty(globalThis, "WebSocket", descriptor);
}

test("inline WS: deferred wsOrigin routes codex Responses through the loopback bridge end to end", async (t) => {
    const upstream = await startFakeUpstream();
    const logs: string[] = [];
    const log = (level: string, message: string): void => {
        logs.push(`${level} ${message}`);
    };
    // The bridge's dispatch stands in for the pipeline: the ambient
    // transport (installed by the WS session around dispatch) IS the
    // session's WS-backed fetch — using it here is the whole point.
    const envelopes: string[] = [];
    const bridge = await startInlineWsBridge({
        dispatchHttp: async (req, res) => {
            envelopes.push(`${req.method} ${req.url}`);
            const upstreamUrl = (req.url ?? "").replace(/^\/bili\//, "");
            const body = await readBody(req);
            const transport = currentFetchTransport() ?? ((url: string, options: { method?: string; headers?: Record<string, string>; body?: string }) => fetch(url, options));
            const response = await transport(upstreamUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
            res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/event-stream" });
            if (response.body !== null) {
                const reader = response.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(Buffer.from(value));
                }
            } else {
                res.write(await response.text());
            }
            res.end();
        },
        log,
    });
    t.after(() => void bridge.close().then(() => upstream.close()));

    const descriptor = savedDescriptor();
    _resetForTest();
    // Real WS client base (headers-capable, like the codex CLI's own).
    Object.defineProperty(globalThis, "WebSocket", { value: WsClient, configurable: true, writable: true });
    try {
        const state: NativeInterceptState = {
            origin: "http://billion-context.inline",
            ready: Promise.resolve("http://billion-context.inline"),
            // Bridge still "booting" at construction time → deferral path.
            wsOrigin: Promise.resolve(bridge.origin),
        };
        installNativeWebSocketIntercept(state);

        const client = new globalThis.WebSocket(
            `ws://${new URL(upstream.url).host}/v1/responses`,
            { headers: { "session-id": "conv-inline-ws-1" } },
        ) as unknown as InstanceType<typeof WsClient>;
        client.addEventListener("error", () => { /* surfaced via the done promise */ });
        const frames: Frame[] = [];
        const decode = (data: unknown): string => {
            if (typeof data === "string") return data;
            if (data instanceof Buffer) return data.toString("utf8");
            if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
            if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
            return String(data);
        };
        const done = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timeout waiting for response.completed; frames=${JSON.stringify(frames)}`)), TMO);
            client.addEventListener("open", () => {
                client.send(JSON.stringify({
                    type: "response.create",
                    model: "gpt-test",
                    instructions: "You are a test.",
                    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
                    stream: true,
                }));
            });
            client.addEventListener("message", (event: unknown) => {
                try {
                    frames.push(JSON.parse(decode((event as { data?: unknown }).data)) as Frame);
                } catch {
                    return;
                }
                if (frames.at(-1)?.type === "response.completed") {
                    clearTimeout(timer);
                    resolve();
                }
            });
            client.addEventListener("error", () => {
                clearTimeout(timer);
                reject(new Error(`client errored; frames=${JSON.stringify(frames)}`));
            });
        });
        await withTimeout(done, TMO, "response.completed frame");

        // The model turn reached the fake upstream as a codex WS frame with
        // the conversation input preserved…
        assert.equal(upstream.seen.length, 1);
        assert.equal(upstream.seen[0].type, "response.create");
        assert.equal((upstream.seen[0].input as unknown[]).length, 1);
        // …the envelope was dispatched into the (stub) pipeline…
        assert.deepEqual(envelopes, [`POST /bili/${upstream.url}`]);
        // …and the client saw the full event sequence re-framed.
        assert.deepEqual(frames.map(f => f.type), ["response.created", "response.output_text.delta", "response.completed"]);
        assert.match(JSON.stringify(frames.at(-1)), /hello from ws upstream/);
        client.close();
    } finally {
        restoreDescriptor(descriptor);
        _resetForTest();
    }
});

test("inline WS: plain HTTP against the bridge port is refused with 426", async (t) => {
    const bridge = await startInlineWsBridge({
        dispatchHttp: async () => {
            throw new Error("plain HTTP must never reach dispatch");
        },
        log: () => {},
    });
    t.after(() => void bridge.close());
    const response = await fetch(`${bridge.origin}/anything`);
    assert.equal(response.status, 426);
    assert.match(await response.text(), /WebSocket upgrade required/);
});

test("inline WS: wsOrigin settling undefined degrades the codex lane DIRECT (warned once)", async () => {
    const descriptor = savedDescriptor();
    _resetForTest();
    const constructed: string[] = [];
    // Spy base: records the URL it was constructed with, never connects.
    class SpyWebSocket extends WsClient {
        constructor(url: string) {
            super(url);
            constructed.push(url);
        }
    }
    Object.defineProperty(globalThis, "WebSocket", { value: SpyWebSocket, configurable: true, writable: true });
    try {
        const state: NativeInterceptState = {
            origin: "http://billion-context.inline",
            ready: Promise.resolve("http://billion-context.inline"),
            wsOrigin: Promise.resolve(undefined), // bridge failed to boot
        };
        installNativeWebSocketIntercept(state);
        const target = "ws://127.0.0.1:49999/v1/responses";
        const spy = new globalThis.WebSocket(target, { headers: { "session-id": "conv-2" } }) as unknown as InstanceType<typeof WsClient>;
        spy.addEventListener("error", () => { /* expected: refused DIRECT connect */ });
        await new Promise(r => setTimeout(r, 200));
        // Constructed at the ORIGINAL url = DIRECT (uncompressed), exactly one.
        assert.deepEqual(constructed, [target]);
    } finally {
        restoreDescriptor(descriptor);
        _resetForTest();
    }
});

test("inline WS: planNativePi accepts the widened truthy/falsy BILI_PI_INLINE set", async () => {
    const { planNativePi } = await import("../src/agent/pi-native.ts");
    assert.equal(planNativePi({ BILI_PI_INLINE: "on" }).mode, "inline");
    assert.equal(planNativePi({ BILI_PI_INLINE: "yes" }).mode, "inline");
    assert.equal(planNativePi({ BILI_PI_INLINE: "TRUE" }).mode, "inline");
    assert.equal(planNativePi({ BILI_PI_INLINE: "no" }).mode, "spawn");
    assert.equal(planNativePi({ BILI_PI_INLINE: "off" }).mode, "spawn");
    // file config still honored when env unset, overridden when env off
    assert.equal(planNativePi({}, true).mode, "inline");
    assert.equal(planNativePi({ BILI_PI_INLINE: "false" }, true).mode, "spawn");
    // #4687: no signals at all = the spawned server (default flip reverted;
    // inline is opt-in only); explicit file opt-out also plans the server
    assert.equal(planNativePi({}).mode, "spawn");
    assert.equal(planNativePi({}, undefined).mode, "spawn");
    assert.equal(planNativePi({}, false).mode, "spawn");
});
