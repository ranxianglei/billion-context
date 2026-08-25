import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// Render-tag pieces are assembled from hex escapes so no literal tag sequence
// appears in this file's source.
const LT = "\x3c";
const GT = "\x3e";
const TAG = (id: string, tokens = 177) => `${LT}acp tokens="${tokens}" type="text"${GT}${id}${LT}/acp${GT}`;
const OPEN_MARK = `${LT}acp `;
const CLOSE_MARK = `${LT}/acp${GT}`;

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: { body: string }[];
    close(): Promise<void>;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function startHarness(scripts: string[][]): Promise<Harness> {
    const captured: { body: string }[] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ body: Buffer.concat(chunks).toString() });
            res.writeHead(200, { "content-type": "text/event-stream" });
            const script = scripts[Math.min(call, scripts.length - 1)]!;
            call += 1;
            for (const line of script) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    return (async () => {
        await once(upstream, "listening");
        const upstreamPort = upstream.address().port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const proxy = await startServer({
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
            modelContextLimit: 400_000,
            kernelConfig: defaultConfig(400_000),
            compress: { injectTool: true, injectNudge: true },
            sessionHeader: "x-acp-session",
            log: false,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        } as ProxyOptions);
        await once(proxy, "listening");
        const proxyPort = proxy.address().port;
        return {
            proxyPort,
            upstreamPort,
            captured,
            close: async () => {
                proxy.close();
                await once(proxy, "close");
                upstream.close();
                await once(upstream, "close");
            },
        };
    })();
}

async function callAnthropic(h: Harness, session: string, messages: Array<{ role: string; content: string }>): Promise<string> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, system: "You are a test assistant.", messages }),
    });
    assert.equal(resp.status, 200);
    let raw = "";
    for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
    return raw;
}

function clientText(raw: string): string {
    return [...raw.matchAll(/"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => JSON.parse(`"${m[1]}"`) as string)
        .join("");
}

function compressRound1Script(): string[] {
    const compressArgs = JSON.stringify({ startId: "m00001", endId: "m00002", topic: "e2e 206", summary: "tag echo e2e compress round trip covering twelve historical detail messages about fruit" });
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_206_1", role: "assistant", usage: { input_tokens: 55 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_206_1", name: "compress", input: {} } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: compressArgs.slice(0, 20) } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: compressArgs.slice(20) } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

// The "deliberately misbehaving model": after compression the upstream sees
// render tags in its prompt, so it imitates them in visible output — split
// across deltas at awkward boundaries, exactly like the #206 reports.
function tagEchoScript(): string[] {
    const full = `好的，总结如下 ${TAG("m00155")}${TAG("m00155", 44)}${TAG("m00156", 33)}另外 5 < 6 成立${TAG("m00157")}完毕`;
    const splitAt = [7, 20, 26, 41, 48, 60];
    const parts: string[] = [];
    let prev = 0;
    for (const s of splitAt) {
        parts.push(full.slice(prev, s));
        prev = s;
    }
    parts.push(full.slice(prev));
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_206_2", role: "assistant", usage: { input_tokens: 20, cache_read_input_tokens: 5 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ...parts.map((p) => anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

test("e2e #206: round-2 text after compress deliberately echoes render tags — client stream stays clean", async () => {
    const h = await startHarness([compressRound1Script(), tagEchoScript()]);
    try {
        const raw = await callAnthropic(h, "e2e-206-round2", [
            ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `historical detail ${i}. ${"x".repeat(6000)}` })),
            { role: "user", content: "please compress the conversation now" },
        ]);
        assert.ok(h.captured.length >= 2, `expected >= 2 upstream requests, got ${h.captured.length}`);
        assert.ok(clientText(raw).includes("Compressed m00001–m00002"), "compress did not succeed in round 1");
        assert.equal(raw.includes(OPEN_MARK), false, "client stream leaked a render open tag");
        assert.equal(raw.includes(CLOSE_MARK), false, "client stream leaked a render close tag");
        assert.ok(clientText(raw).endsWith("好的，总结如下 另外 5 < 6 成立完毕"), `unexpected client text: ${JSON.stringify(clientText(raw))}`);
        assert.ok(raw.includes("message_stop"));
    } finally {
        await h.close();
    }
});

test("e2e #206: next-turn replay in same session — echoed tags stripped, prose intact", async () => {
    const done = [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_206_3", role: "assistant", usage: { input_tokens: 20 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done after compress" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
    const h = await startHarness([compressRound1Script(), done, tagEchoScript()]);
    try {
        await callAnthropic(h, "e2e-206-turn2", [
            ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `historical detail ${i}. ${"x".repeat(6000)}` })),
            { role: "user", content: "please compress the conversation now" },
        ]);
        const callsAfterTurn1 = h.captured.length;
        const raw = await callAnthropic(h, "e2e-206-turn2", [{ role: "user", content: "continue" }]);
        assert.ok(h.captured.length > callsAfterTurn1, "turn-2 request never reached upstream");
        assert.equal(raw.includes(OPEN_MARK), false, "turn-2 client stream leaked a render open tag");
        assert.equal(raw.includes(CLOSE_MARK), false, "turn-2 client stream leaked a render close tag");
        assert.ok(clientText(raw).endsWith("好的，总结如下 另外 5 < 6 成立完毕"), `unexpected turn-2 client text: ${JSON.stringify(clientText(raw))}`);
    } finally {
        await h.close();
    }
});
