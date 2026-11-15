// #4601: two defects on the codex Responses-WebSocket failure path, verified in the field
// (bili 0.1.206, codex-tui 0.164.0, 17.5 MB un-intercepted compaction, close 1009):
//  (a) a pipeline failure was answered with the HTTP proxy-failure body whose `error` is a
//      STRING; the WS-lane error contract is { type, status, error: { code?, message?,
//      headers? } } (codex parse_wrapped_websocket_error_event), a string fails that
//      deserialization, and codex waited out its 5-minute idle timeout x retries instead
//      of failing fast;
//  (b) the 1009 oversize diagnostic measured sentBytes only for string bodies — a
//      verbatim-passthrough (Buffer) body reported "0.0 MiB" plus the false
//      "no sheddable images" reason although no shedding was ever attempted.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { formatMiB } from "../src/egress-shed.ts";
import { buildProxyFailureResponse } from "../src/upstream-fail.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";

type Item = Record<string, unknown>;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4601-home-"));
process.env.XDG_STATE_HOME = testHome;
process.env.XDG_DATA_HOME = testHome;
process.env.XDG_CACHE_HOME = testHome;

const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

interface F4601 {
    sid: string;
    turnFrames: string[];
    peer: WebSocket;
    proxy: http.Server;
    upstream: http.Server;
    wss: WebSocketServer;
    frame: (input: Item[], extra?: Item) => string;
    awaitErrorFrame: () => Promise<Item>;
    close: () => Promise<void>;
}

/** Full codex-lane fixture whose mock upstream answers probes with a terminal pair and
 *  rejects every real turn with close 1009 BEFORE any event — the gateway size verdict. */
async function fixture(passthrough: boolean): Promise<F4601> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4601-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const turnFrames: string[] = [];
    const upstream = http.createServer((req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", peer => {
        peer.on("message", raw => {
            const request = JSON.parse(raw.toString()) as Item;
            if (Array.isArray(request.input) && request.input.length === 0 && request.generate === false) {
                peer.send(JSON.stringify({ type: "response.created", response: { id: "resp_probe", status: "in_progress", output: [] } }));
                peer.send(JSON.stringify({ type: "response.completed", response: { id: "resp_probe", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 } } }));
                return;
            }
            turnFrames.push(raw.toString());
            peer.close(1009, "Message Too Big");
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const config = defaultConfig(200000);
    config.preserveRecentTokens = 0;
    const opts: ProxyOptions = { host: "127.0.0.1", port: 0, upstream: upstreamOrigin, routes: {}, modelContextLimit: 200000, kernelConfig: config, compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, logFile: path.join(tmp, "bili.log"), debug: false, passthrough, autoUpdate: false, mitm: { enabled: false, domains: [] } };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const sid = `codex-thread-4601-${randomUUID()}`;
    const peer = new WebSocket(`${proxyOrigin.replace(/^http/, "ws")}/bili/${upstreamOrigin}/v1/responses`, { headers: { authorization: "Bearer fake-credential", "session-id": sid, "thread-id": sid, "openai-beta": "responses_websockets=2026-02-06", "user-agent": "codex_exec/0.164.0" } });
    await once(peer, "open");
    peer.on("error", () => {});
    const frame = (input: Item[], extra: Item = {}): string => JSON.stringify({ type: "response.create", model: "gpt-5.2", instructions: "You are Codex", store: false, stream: true, prompt_cache_key: sid, tools: [], input, client_metadata: { session_id: sid, thread_id: sid }, ...extra });
    const awaitErrorFrame = (): Promise<Item> => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for the error frame — #4601 regression: the client would sit out its ${5 * 60}s idle timeout`)), 15000);
        const onClose = (): void => { clearTimeout(timer); reject(new Error("WS client closed before the error frame")); };
        const onMessage = (raw: WebSocket.RawData): void => {
            const event = JSON.parse(raw.toString()) as Item;
            if (event.type === "error") {
                clearTimeout(timer);
                peer.off("message", onMessage);
                peer.off("close", onClose);
                resolve(event);
            }
        };
        peer.on("message", onMessage);
        peer.once("close", onClose);
    });
    return {
        sid, turnFrames, peer, proxy, upstream, wss, frame, awaitErrorFrame,
        close: async () => {
            peer.terminate();
            for (const client of wss.clients) client.terminate();
            await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
            wss.close();
        },
    };
}

// ~0.3 MiB of padding: large enough that formatMiB (one decimal) cannot round the real
// size back to "0.0", yet small enough (in TOKENS) to stay under the 200 K test window —
// a multi-megabyte frame would die in the preflight compression marathon (#preflight
// fail-fast) and never reach the upstream 1009 this suite pins.
const PADDED_TEXT = "4601-filler ".repeat(25_000);

test("#4601 WS failure frame: a pipeline 1009 answers an object-form error frame the client can parse", { timeout: 30000 }, async () => {
    const f = await fixture(false);
    try {
        f.peer.send(f.frame([user(PADDED_TEXT)]));
        const error = await f.awaitErrorFrame();
        assert.equal(error.type, "error");
        // The core regression: `error` must be an OBJECT (codex WrappedWebsocketError),
        // never a string — a string fails deserialization and the frame is ignored.
        assert.equal(typeof error.error, "object", `error must be an object, got ${typeof error.error}: ${JSON.stringify(error.error)?.slice(0, 200)}`);
        assert.ok(error.error !== null && !Array.isArray(error.error));
        assert.equal(typeof (error.error as Item).code, "string");
        assert.equal((error.error as Item).code, "proxy_failure");
        const message = String((error.error as Item).message);
        assert.match(message, /WS upstream rejected/);
        assert.match(message, /close 1009/);
        // Anchor on "rejected the": the trailing budget clause legitimately contains
        // "10.0 MiB" (the default wsOutboundBytes), so a bare /0\.0 MiB/ would false-positive.
        assert.doesNotMatch(message, /rejected the 0\.0 MiB/, "a megabyte-scale frame must not report 0.0 MiB");
        assert.equal(typeof error.status, "number");
        assert.ok((error.status as number) >= 400, `status must be a 4xx/5xx verdict, got ${JSON.stringify(error.status)}`);
        // Fail-fast proof: the frame arrived well inside the 15 s guard above —
        // codex's own idle timeout is 300 s, so anything under the guard fails fast.
    } finally { await f.close(); }
});

test("#4601 WS 1009 diagnostic: a verbatim-passthrough body reports its real size, not 0.0 MiB", { timeout: 30000 }, async () => {
    const f = await fixture(true);
    try {
        const payload = f.frame([user(PADDED_TEXT)]);
        f.peer.send(payload);
        const error = await f.awaitErrorFrame();
        const message = String((error.error as Item).message);
        const sentBytes = Buffer.byteLength(f.turnFrames[0] ?? "");
        assert.ok(sentBytes > 0, "the mock upstream must have seen the fat frame");
        assert.ok(message.includes(`${formatMiB(sentBytes)} MiB`), `diagnostic must name the real frame size (${formatMiB(sentBytes)} MiB), got: ${message.slice(0, 300)}`);
        assert.doesNotMatch(message, /rejected the 0\.0 MiB/, "the pre-fix defect: a Buffer body reported 0.0 MiB");
        // Honest reason: shedding needs a JSON wire body and was never attempted on a
        // verbatim passthrough — claiming "no sheddable images" lies about work not done.
        assert.match(message, /not a JSON wire body/);
        assert.doesNotMatch(message, /no sheddable images/);
    } finally { await f.close(); }
});

test("#4601 gates: HTTP lanes keep the string-error contract; WS admission frames keep their shape", { timeout: 30000 }, async () => {
    // Negative direction 1: the normalization lives at the WS conversion point ONLY —
    // buildProxyFailureResponse keeps the string `error` every HTTP client renders.
    const { status, body } = buildProxyFailureResponse("boom", new Error("boom"));
    assert.ok(status >= 400 && status < 600);
    const parsed = JSON.parse(body) as Item;
    assert.equal(typeof parsed.error, "string", "HTTP contract: error stays a string");
    assert.equal(parsed.detail, "boom");
    // Negative direction 2: bili's own admission errorFrame (already understood by codex)
    // is untouched by the end() normalization.
    const f = await fixture(true);
    try {
        f.peer.send(f.frame([user("nope")], { stream: false }));
        const error = await f.awaitErrorFrame();
        assert.equal(typeof error.error, "object");
        assert.equal((error.error as Item).code, "invalid_request");
    } finally { await f.close(); }
});
