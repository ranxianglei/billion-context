// #4817/#4804: the anchor-miss recovery must fire through the REAL dispatch
// pipeline. The unit test pins the WS session's 400 branch with a stubbed
// dispatch that rethrows directly; production funnels the anchored render's
// SnapshotAnchorFallbackError through server.ts's dispatch catch, which used
// to swallow it into a generic 503 — unreachable recovery, checkpoint
// retained, client retried the same deterministic miss forever. The catch now
// rethrows for the request the WS session stamped (WS_ANCHORED_REQ_PROP).
//
// The miss path itself stays unit-pinned (issue4804-ws-delta-anchor.test.ts):
// driving a deterministic seam miss through the REAL pipeline needs a
// side-lane primitive the harness does not have yet — a second WS peer under
// the same session id appends transcript rows that the main peer's snapshot
// view never observes (per-connection session contexts), and between-turns
// folds land only inside the NEXT dispatch, after the seam check. Harness
// gap recorded in the #4817 PR thread; this file pins the happy path
// end-to-end: the delta continuation anchors through the real dispatch and
// completes without any error frame.
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
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { validateCodexResponsesWsCreate } from "./wire-contract-fakes.ts";
import type { ProxyOptions } from "../src/config.ts";

type Item = Record<string, unknown>;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4817-miss-home-"));
process.env.XDG_STATE_HOME = testHome;
process.env.XDG_DATA_HOME = testHome;
process.env.XDG_CACHE_HOME = testHome;
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_PERSIST_DEBOUNCE_MS = "0";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(testHome, "no-such-bili-config.json");
process.env.BILI_ROLLOUT_WS_DELTA_CONTINUATION = "1";

const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

async function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4817-miss-"));
    _setStoreForTest(new SessionStore({ enabled: true, debounceMs: 0 }));
    setRegistryForTest({});
    const rows: Array<{ request: Item }> = [];
    let serial = 0;
    const upstream = http.createServer((req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (peer) => {
        peer.on("error", () => {});
        peer.on("message", (raw) => {
            const request = JSON.parse(raw.toString()) as Item;
            const violations = validateCodexResponsesWsCreate(request);
            if (violations.length) { peer.send(JSON.stringify({ type: "error", status: 400, error: { code: "invalid_request", message: violations.join("; ") } })); return; }
            rows.push({ request });
            const id = `resp_miss_${++serial}`;
            const send = (type: string, fields: Item): void => peer.send(JSON.stringify({ type, ...fields }));
            if (Array.isArray(request.input) && request.input.length === 0) {
                send("response.created", { response: { id, status: "in_progress", output: [] } });
                send("response.completed", { response: { id, status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 } } });
                return;
            }
            const item: Item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `ok-${serial}` }] };
            send("response.created", { response: { id, status: "in_progress", output: [] } });
            send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
            send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: `ok-${serial}` });
            send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: `ok-${serial}` });
            send("response.output_item.done", { output_index: 0, item });
            send("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 } } });
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const config = defaultConfig(200000);
    config.preserveRecentTokens = 0;
    const opts: ProxyOptions = { host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1", routes: {}, modelContextLimit: 200000, kernelConfig: config, compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, logFile: path.join(tmp, "bili.log"), debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const sid = `codex-thread-${randomUUID()}`;
    const openPeer = async (): Promise<WebSocket> => {
        const client = new WebSocket(`${proxyOrigin.replace(/^http/, "ws")}/bili/${upstreamOrigin}/v1/responses`, { headers: { authorization: "Bearer fake-credential", "session-id": sid, "thread-id": sid, "openai-beta": "responses_websockets=2026-02-06", "user-agent": "codex_exec/0.147.0 (Ubuntu 24.4.0; x86_64) gnome-terminal (codex_exec; 0.147.0)", originator: "codex_exec" } });
        await once(client, "open");
        client.on("error", () => {});
        return client;
    };
    const frame = (input: Item[], extra: Item = {}): string => JSON.stringify({ type: "response.create", model: "gpt-5.2", instructions: "You are Codex", store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: sid, reasoning: { effort: "medium", summary: "auto" }, text: { verbosity: "low" }, tools: [], input, client_metadata: { session_id: sid, thread_id: sid }, ...extra });
    async function exchange(payload: string, client: WebSocket): Promise<Item[]> {
        client.send(payload);
        return new Promise((resolve, reject) => {
            const events: Item[] = [];
            const cleanup = (): void => { clearTimeout(timer); client.off("message", onMessage); client.off("close", onClose); };
            const timer = setTimeout(() => { cleanup(); reject(new Error("WS turn timed out")); }, 15000);
            const onClose = (): void => { cleanup(); reject(new Error("WS client closed")); };
            const onMessage = (raw: WebSocket.RawData): void => {
                const event = JSON.parse(raw.toString()) as Item;
                events.push(event);
                if (["response.completed", "response.failed", "response.incomplete", "error"].includes(String(event.type))) {
                    cleanup();
                    resolve(events);
                }
            };
            client.on("message", onMessage);
            client.once("close", onClose);
        });
    }
    const peer = await openPeer();
    const probe = (client: WebSocket = peer): Promise<Item[]> => exchange(frame([], { generate: false }), client);
    const turn = (input: Item[], client: WebSocket = peer): Promise<Item[]> => exchange(frame(input), client);
    const continueTurn = (previousResponseId: string, input: Item[], client: WebSocket = peer): Promise<Item[]> => exchange(frame(input, { previous_response_id: previousResponseId }), client);
    return { rows, sid, proxy, peer, turn, probe, continueTurn, openPeer, close: async () => {
        peer.terminate();
        for (const client of wss.clients) client.terminate();
        await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
        wss.close();
    } };
}

const completed = (events: Item[]): Item => {
    const event = events.find(e => e.type === "response.completed");
    assert.ok(event, JSON.stringify(events));
    return event.response as Item;
};

const errorEvent = (events: Item[]): Item | undefined => events.find(e => e.type === "error");

async function awaitTranscriptRows(sid: string, min: number): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
        if ((getStore().unifiedTailSeqs(sid)?.length ?? 0) >= min) return;
        if (Date.now() >= deadline) throw new Error("unified transcript never settled for the anchored probe");
        await new Promise(r => setTimeout(r, 20));
    }
}

test("#4817 e2e happy path: an unpolluted delta continuation anchors and completes without any error frame", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        const first = completed(await f.turn([user("m1-first-turn-marker")]));
        const firstId = String(first.id);
        await awaitTranscriptRows(f.sid, 1);
        const events = await f.continueTurn(firstId, [user("m2-delta-tail-marker")]);
        assert.ok(!errorEvent(events), `no error frame expected on the happy path, got: ${JSON.stringify(errorEvent(events))}`);
        assert.equal(completed(events).status, "completed");
    } finally { await f.close(); }
});

