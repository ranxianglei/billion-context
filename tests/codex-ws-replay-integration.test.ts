import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";

type Item = Record<string, unknown>;
const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

for (const { renderTags, client } of [
    { renderTags: false, client: "codex" },
    { renderTags: true, client: "codex" },
    { renderTags: false, client: "generic" },
    { renderTags: false, client: "plugin" },
] as const) test(`WS replay compatibility: ${client}, ACP tags ${renderTags ? "on" : "off"}`, { timeout: 30000 }, async () => {
    const originalRenderNone = process.env.ACP_RENDER_NONE;
    process.env.ACP_RENDER_NONE = renderTags ? "" : "1";
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-replay-"));
    const capture = path.join(tmp, "capture.jsonl");
    const plugin = path.join(tmp, "capture.mjs");
    fs.writeFileSync(plugin, `import fs from 'node:fs'; export default { transform(ctx) { fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({stage:ctx.stage, body:JSON.parse(ctx.body.toString())})+'\\n'); } };`);
    const upstreamFrames: Item[] = [];
    let sequence = 0;
    const upstream = http.createServer((_req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", peer => peer.on("message", raw => {
        const frame = JSON.parse(raw.toString()) as Item;
        upstreamFrames.push(frame);
        const n = ++sequence;
        const turn = `turn-${n}`;
        const item: Item = {
            type: "message", id: `msg_test_${n}`, metadata: { turn_id: turn },
            internal_chat_message_metadata_passthrough: { content_token_count: 48, create_time: 1795117760.5 + n, turn_id: turn },
            role: "assistant", status: "completed", content: [{ type: "output_text", text: `answer-${n}`, annotations: [], logprobs: [] }], phase: "commentary",
        };
        const response = { id: `resp_${n}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 4, total_tokens: 104 } };
        peer.send(JSON.stringify({ type: "response.created", response: { id: response.id, status: "in_progress", output: [] } }));
        peer.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
        peer.send(JSON.stringify({ type: "response.completed", response }));
    }));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const config = defaultConfig(200000);
    const opts: ProxyOptions = {
        host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1", routes: {}, modelContextLimit: 200000,
        kernelConfig: config, compress: { injectTool: false, injectNudge: false }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        egressTransforms: [{ id: "capture", module: plugin, enabled: true, priority: undefined, match: undefined, order: 0 }],
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const sid = `replay-test-${randomUUID()}`;
    const peers: WebSocket[] = [];
    const connect = async (): Promise<WebSocket> => {
        const peer = new WebSocket(`ws://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
            headers: {
                "session-id": sid,
                "user-agent": client === "generic" ? "other-client/1.0" : "codex_exec/0.169.1",
                originator: "codex_exec",
                ...(client === "plugin" ? { "x-bili-plugin": "pi" } : {}),
            },
        });
        peers.push(peer);
        await once(peer, "open");
        return peer;
    };
    const request = (input: Item[], previous?: string): Item => ({
        type: "response.create", model: "gpt-5.2", instructions: "test", store: false, stream: true,
        prompt_cache_key: sid, input, ...(previous ? { previous_response_id: previous } : {}),
    });
    const exchange = (peer: WebSocket, frame: Item): Promise<Item> => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { peer.off("message", onMessage); reject(new Error("exchange timed out")); }, 10000);
        const onMessage = (raw: WebSocket.RawData): void => {
            const event = JSON.parse(raw.toString()) as Item;
            if (event.type === "error" || event.type === "response.failed") {
                clearTimeout(timer); peer.off("message", onMessage); reject(new Error(JSON.stringify(event)));
            } else if (event.type === "response.completed") {
                clearTimeout(timer); peer.off("message", onMessage); resolve(event.response as Item);
            }
        };
        peer.on("message", onMessage);
        peer.send(JSON.stringify(frame));
    });
    const replay = (item: Item): Item => {
        const metadata = item.internal_chat_message_metadata_passthrough as Item;
        return { type: "message", status: item.status, id: item.id, role: item.role, content: item.content, phase: item.phase,
            internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id, create_time: metadata.create_time, content_item_kinds: ["unknown"] } };
    };
    try {
        const peer = await connect();
        const first = await exchange(peer, request([user("one")]));
        const firstOutput = (first.output as Item[])[0];
        assert.deepEqual(firstOutput.metadata, { turn_id: "turn-1" });
        assert.equal((firstOutput.internal_chat_message_metadata_passthrough as Item).content_token_count, 48);
        const second = await exchange(peer, request([user("two")], String(first.id)));
        const secondOutput = (second.output as Item[])[0];
        peer.close();
        await once(peer, "close");
        const reconnected = await connect();
        await exchange(reconnected, request([user("one"), replay(firstOutput), user("two"), replay(secondOutput), user("three")]));
        const captures = fs.readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line) as { body: Item });
        assert.equal(captures.length, 3);
        const find = (n: number): Item => {
            const item = (captures[n].body.input as Item[]).find(value => value.id === "msg_test_1");
            assert.ok(item);
            return item;
        };
        if (client !== "codex") {
            // A Codex-shaped route alone is insufficient: non-Codex hosts and
            // explicitly declared plugin lanes must retain their own metadata.
            assert.notEqual(JSON.stringify(find(1)), JSON.stringify(find(2)));
            assert.deepEqual(find(1).metadata, { turn_id: "turn-1" });
            assert.equal((find(1).internal_chat_message_metadata_passthrough as Item).content_token_count, 48);
            assert.deepEqual((find(2).internal_chat_message_metadata_passthrough as Item).content_item_kinds, ["unknown"]);
            return;
        }
        assert.equal(JSON.stringify(find(1)), JSON.stringify(find(2)));
        assert.equal(find(1).metadata, undefined);
        assert.equal((find(1).internal_chat_message_metadata_passthrough as Item).content_token_count, undefined);
        // Tags change the actual prompt, so a full upstream resend is required.
        // When there is no such change, metadata drift alone permits a delta.
        if (renderTags) {
            assert.equal(upstreamFrames[1].previous_response_id, undefined);
            assert.ok(JSON.stringify(upstreamFrames[1].input).includes("<acp "));
        } else {
            assert.equal(upstreamFrames[1].previous_response_id, "resp_1");
            assert.equal((upstreamFrames[1].input as unknown[]).length, 1);
        }
        assert.equal(upstreamFrames[2].previous_response_id, undefined);
    } finally {
        for (const peer of peers) peer.terminate();
        for (const peer of wss.clients) peer.terminate();
        await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
        wss.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        if (originalRenderNone === undefined) delete process.env.ACP_RENDER_NONE;
        else process.env.ACP_RENDER_NONE = originalRenderNone;
    }
});
