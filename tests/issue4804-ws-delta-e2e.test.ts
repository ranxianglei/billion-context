// #4804 root fix, end-to-end: a Codex Responses WS client that continues with
// previous_response_id must NOT force bili to reconstruct the full history —
// the delta rides the unified transcript (server-rendered prefix + echoed
// previous output + new tail) and the upstream row proves the conversation
// stayed complete. The real client shape is the ~37 KiB delta frame captured
// in the #4804 thread; the legacy full-replay path stays the lossless
// fallback (unknown checkpoint id → 400 → client resends everything).
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
import { peekSession } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { validateCodexResponsesWsCreate } from "./wire-contract-fakes.ts";

type Item = Record<string, unknown>;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4804-delta-home-"));
process.env.XDG_STATE_HOME = testHome;
process.env.XDG_DATA_HOME = testHome;
process.env.XDG_CACHE_HOME = testHome;
// Delta continuation needs unified reads (#4804); flush immediately so the
// transcript probe can settle without sleeping on the debounce.
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_PERSIST_DEBOUNCE_MS = "0";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(testHome, "no-such-bili-config.json");
process.env.BILI_ROLLOUT_WS_DELTA_CONTINUATION = "1";

const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

async function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4804-delta-"));
    _setStoreForTest(new SessionStore({ enabled: true, debounceMs: 0 }));
    setRegistryForTest({});
    const rows: Array<{ request: Item; headers: http.IncomingHttpHeaders }> = [];
    let serial = 0;
    const upstream = http.createServer((req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (peer, req) => { peer.on("error", e => console.error("[FAKE-UPSTREAM-PEER-ERR]", e.message)); peer.on("message", raw => {
        const request = JSON.parse(raw.toString()) as Item;
        const violations = validateCodexResponsesWsCreate(request);
        if (violations.length) { peer.send(JSON.stringify({ type: "error", status: 400, error: { code: "invalid_request", message: violations.join("; ") } })); return; }
        rows.push({ request, headers: req.headers });
        const id = `resp_delta_${++serial}`;
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
    }); });
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
    const openPeer = async () => {
        const client = new WebSocket(`${proxyOrigin.replace(/^http/, "ws")}/bili/${upstreamOrigin}/v1/responses`, { headers: { authorization: "Bearer fake-credential", "session-id": sid, "thread-id": sid, "openai-beta": "responses_websockets=2026-02-06", "user-agent": "codex_exec/0.147.0 (Ubuntu 24.4.0; x86_64) gnome-terminal (codex_exec; 0.147.0)", originator: "codex_exec" } });
        await once(client, "open");
        return client;
    };
    const frame = (input: Item[], extra: Item = {}): string => JSON.stringify({ type: "response.create", model: "gpt-5.2", instructions: "You are Codex", store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: sid, reasoning: { effort: "medium", summary: "auto" }, text: { verbosity: "low" }, tools: [], input, client_metadata: { session_id: sid, thread_id: sid }, ...extra });
    async function exchange(payload: string, client: WebSocket): Promise<Item[]> {
        client.send(payload);
        return new Promise((resolve, reject) => {
            const events: Item[] = [];
            const cleanup = (): void => { clearTimeout(timer); client.off("message", onMessage); client.off("close", onClose); };
            const timer = setTimeout(() => { cleanup(); reject(new Error("WS turn timed out")); }, 10000);
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
    // Codex opens every connection with a prewarm probe first (#3073 ordering).
    const probe = (client: WebSocket = peer): Promise<Item[]> => exchange(frame([], { generate: false }), client);
    const turn = (input: Item[], client: WebSocket = peer): Promise<Item[]> => exchange(frame(input), client);
    const continueTurn = (previousResponseId: string, input: Item[], client: WebSocket = peer): Promise<Item[]> => exchange(frame(input, { previous_response_id: previousResponseId }), client);
    const peer = await openPeer();
    peer.on("error", e => console.error("[TEST-CLIENT-ERR]", e.message));
    return { rows, sid, proxy, peer, turn, probe, frame, continueTurn, openPeer, close: async () => {
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

// The pipeline prepends its injected prompt head and may reshape item
// contents (string vs part arrays), so exact-array assertions are brittle.
// Pin the CONVERSATION MARKERS instead: present and in conversation order in
// the serialized outbound row — the property the delta lane must preserve.
function orderedIn(request: Item, ...needles: string[]): boolean {
    const s = JSON.stringify(request);
    let from = 0;
    for (const needle of needles) {
        const idx = s.indexOf(needle, from);
        if (idx < 0) return false;
        from = idx + needle.length;
    }
    return true;
}

test("#4804: a small previous_response_id continuation keeps the full conversation without resending it", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        const first = completed(await f.turn([user("m1-first-turn-marker")]));
        assert.equal(first.status, "completed");
        const firstId = String(first.id);
        // Wait for the unified transcript to hold turn 1's request rows (the
        // delta lane probes it before rendering the prefix).
        const deadline = Date.now() + 5000;
        for (;;) {
            if ((getStore().unifiedTailSeqs(f.sid)?.length ?? 0) > 0) break;
            if (Date.now() >= deadline) throw new Error("unified transcript never settled for the delta probe");
            await new Promise(r => setTimeout(r, 20));
        }
        // The client sends ONLY the new tail plus the checkpoint id — this is
        // the ~37 KiB delta shape captured from the real codex client.
        completed(await f.continueTurn(firstId, [user("m2-delta-tail-marker")]));
        assert.equal(f.rows.length, 3);
        // Legacy control: turn 1 went upstream without the delta tail.
        assert.ok(orderedIn(f.rows[1]!, "m1-first-turn-marker"));
        assert.ok(!JSON.stringify(f.rows[1]!.request).includes("m2-delta-tail-marker"));
        // Root fix: the upstream row for the delta turn carries the
        // server-rendered prefix (turn 1's input), the echoed previous output
        // (ok-2: the probe consumed serial 1), and the new tail — in order —
        // although the client resent none of it.
        assert.ok(orderedIn(f.rows[2]!, "m1-first-turn-marker", "ok-2", "m2-delta-tail-marker"));
        const session = peekSession(f.sid);
        assert.ok(session);
        assert.equal(session.stats.requests, 2);
    } finally { await f.close(); }
});

test("#4804: an unknown checkpoint id gets the standard 400 and the full replay recovers losslessly", { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.probe();
        completed(await f.turn([user("m1-recovery-turn")]));
        const refused = await f.continueTurn("resp_never_existed", [user("m2-after-miss")]);
        const errorEvent = refused.find(e => e.type === "error");
        assert.ok(errorEvent, JSON.stringify(refused));
        assert.equal(errorEvent.status, 400);
        assert.equal((errorEvent.error as Item)?.code, "previous_response_not_found");
        // The client's standard recovery: resend the whole conversation.
        const recovered = completed(await f.turn([user("m1-recovery-turn"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "replayed-ok" }] }, user("m2-after-miss")]));
        assert.equal(recovered.status, "completed");
        assert.ok(orderedIn(f.rows[f.rows.length - 1]!, "m1-recovery-turn", "replayed-ok", "m2-after-miss"));
    } finally { await f.close(); }
});
