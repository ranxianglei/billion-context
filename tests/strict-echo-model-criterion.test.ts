import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

// #1027: DeepSeek models behind a non-deepseek gateway never trip the
// host-only static strict-echo check, so every fresh session re-paid the
// reasoning_content 400 through the learn-on-failure flag alone. Regression
// arc: fresh session, gateway origin, model id matching /deepseek/i — the
// FIRST forwarded body must already carry the blank echo (no 400, no
// "learned" log), and the acp-loop re-request must carry it too.

interface Captured {
    level: string;
    msg: string;
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const CLIENT_MESSAGES = [
    { role: "user", content: "what is the weather" },
    { role: "assistant", content: "let me check", reasoning_content: "thinking about it" },
    { role: "user", content: "and tomorrow?" },
    { role: "assistant", content: "", tool_calls: [{ id: "tc-c1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "tc-c1", content: "sunny" },
    { role: "user", content: "great" },
];

function sseChunk(id: string, delta: Record<string, unknown>, finishReason?: string, usage?: Record<string, number>): string {
    const chunk: Record<string, unknown> = {
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-flash",
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };
    if (usage) chunk.usage = usage;
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function startHarness(handler: (bodyText: string, res: http.ServerResponse) => void) {
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => handler(b, res));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-flash": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await new Promise<void>((r) => proxy.on("listening", r));
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, upstream, proxyPort, upstreamPort };
}

async function postStreamChat(proxyPort: number, upstreamPort: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "semc-1" },
        body: JSON.stringify({
            model: "deepseek-flash",
            messages: CLIENT_MESSAGES,
            stream: true,
        }),
    });
}

function tcC1(bodyText: string): Record<string, unknown> | undefined {
    const body = JSON.parse(bodyText) as { messages: Record<string, unknown>[] };
    return body.messages.find((m) => Array.isArray(m.tool_calls) && (m.tool_calls as Record<string, unknown>[])[0]?.id === "tc-c1");
}

test("#1027: gateway-hosted deepseek model gets proactive strict-echo repair, no learning", async () => {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-semc-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    const seenBodies: string[] = [];
    let n = 0;
    const { proxy, upstream, proxyPort, upstreamPort } = await startHarness((bodyText, res) => {
        n += 1;
        seenBodies.push(bodyText);
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (n === 1) {
            res.write(sseChunk("c1", { role: "assistant" }));
            res.write(sseChunk("c1", { tool_calls: [{ index: 0, id: "tc-loop", type: "function", function: { name: "compress", arguments: "" } }] }));
            res.write(sseChunk("c1", { tool_calls: [{ index: 0, function: { arguments: "{\"content\":[]}" } }] }));
            res.write(sseChunk("c1", {}, "tool_calls"));
        } else {
            res.write(sseChunk("c2", { content: "done" }));
            res.write(sseChunk("c2", {}, "stop", { prompt_tokens: 10, completion_tokens: 2 }));
        }
        res.write("data: [DONE]\n\n");
        res.end();
    });
    try {
        const resp = await postStreamChat(proxyPort, upstreamPort);
        assert.equal(resp.status, 200);
        assert.match(resp.headers.get("content-type") ?? "", /text\/event-stream/);
        const sseText = await resp.text();
        assert.ok(sseText.includes("[DONE]"), "client must receive the completed stream");

        assert.ok(n >= 2, `expected main + loop re-request upstream hits, saw ${n}`);
        assert.equal(tcC1(seenBodies[0]!)!.reasoning_content, "", "main path must inject the blank echo proactively via the model criterion — no 400 first");
        assert.equal(tcC1(seenBodies[1]!)!.reasoning_content, "", "loop re-request must carry the blank echo");
        assert.ok(!captured.some((l) => l.msg.includes("learned strictReasoningEcho")), "fresh session must not fall back to learn-on-failure");
        assert.ok(captured.some((l) => l.msg.includes("injected blank reasoning_content")), "main-path injection must log its repair");
        assert.ok(captured.some((l) => l.msg.includes("[acp-loop]") && l.msg.includes("injected blank reasoning_content")), "loop-path injection must log its repair");
    } finally {
        await close(proxy);
        await close(upstream);
        setLogCapture(null);
        rmrf(stateDir);
    }
});
