import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

// #762 e2e: a client-originated (main-path) 400 whose body mentions
// reasoning_content must (a) be persisted when BILI_DUMP_4XX=1, (b) learn
// strictReasoningEcho on the session — the loop-only learner never sees these
// — and (c) make the NEXT request forward a normalized body where every
// assistant tool-call message carries a reasoning_content field. The relay
// origin (127.0.0.1) does NOT match the static /deepseek/i gate, so this
// exercises the learned-flag path end to end.

interface Captured {
    level: string;
    msg: string;
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const ERROR_BODY = JSON.stringify({
    error: { message: "The 'reasoning_content' in the thinking mode must be passed back to the API" },
});

// Thinking-session history: two assistant turns carry real reasoning, one
// tool-call turn lacks the field entirely — the residual split of #762.
const CLIENT_MESSAGES = [
    { role: "user", content: "what is the weather" },
    { role: "assistant", content: "let me check", reasoning_content: "thinking about weather" },
    { role: "user", content: "now search for it" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: "{\"q\":\"weather\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "sunny" },
    { role: "assistant", content: "it is sunny", reasoning_content: "wrapping up" },
];

async function startHarness(captured: Captured[], onUpstreamRequest: (bodyText: string, res: http.ServerResponse) => void): Promise<{ proxy: http.Server; upstream: http.Server; proxyPort: number; upstreamPort: number }> {
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => onUpstreamRequest(data, res));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, upstream, proxyPort, upstreamPort };
}

async function postChat(proxyPort: number, upstreamPort: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "re400-1" },
        body: JSON.stringify({ model: "gpt-test", messages: CLIENT_MESSAGES }),
    });
}

test("#762: main-path 400 learns strict-echo, next request is normalized, rejected body is persisted", async () => {
    const captured: Captured[] = [];
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-re400-dump-"));
    const seenBodies: string[] = [];
    let n = 0;
    try {
        process.env.BILI_DUMP_4XX = "1";
        process.env.ACP_DUMP_DIR = dumpDir;
        const { proxy, upstream, proxyPort, upstreamPort } = await startHarness(captured, (bodyText, res) => {
            seenBodies.push(bodyText);
            n++;
            if (n === 1) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(ERROR_BODY);
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "x", object: "chat.completion", created: 1, model: "gpt-test",
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
                }));
            }
        });
        try {
            const resp1 = await postChat(proxyPort, upstreamPort);
            assert.equal(resp1.status, 400);
            assert.equal(await resp1.text(), ERROR_BODY);

            const resp2 = await postChat(proxyPort, upstreamPort);
            assert.equal(resp2.status, 200);
            await resp2.text();

            assert.equal(seenBodies.length, 2);

            // (a) the FIRST forwarded body carried the split (field absent) —
            //     the relay origin does not match the static gate pre-learning.
            const first = JSON.parse(seenBodies[0]!) as { model: string; messages: Record<string, unknown>[] };
            assert.equal(first.model, "gpt-test");
            const firstTc = first.messages.find((m) => Array.isArray(m.tool_calls));
            assert.ok(firstTc, "expected a tool-call message in the first forwarded body");
            assert.ok(!("reasoning_content" in firstTc!), "first forwarded body must show the absent field (pre-learning)");

            // (b) the main-path learner fired for the client-originated 400.
            const learned = captured.find((c) => c.level === "warn" && c.msg.includes("learned strictReasoningEcho"));
            assert.ok(learned, `expected main-path learn-on-400 log, got: ${captured.map((c) => c.msg).join(" | ")}`);

            // (c) the SECOND forwarded body is normalized: the tool-call
            //     message now carries a blank echo.
            const second = JSON.parse(seenBodies[1]!) as { messages: Record<string, unknown>[] };
            const secondTc = second.messages.find((m) => Array.isArray(m.tool_calls));
            assert.ok(secondTc, "expected a tool-call message in the second forwarded body");
            assert.equal(secondTc!.reasoning_content, "");
            const injected = captured.find((c) => c.msg.includes("injected blank reasoning_content on 1 assistant tool-call message"));
            assert.ok(injected, `expected normalization log, got: ${captured.map((c) => c.msg).join(" | ")}`);

            // (d) the sentinel fired exactly once (request 1, pre-repair) and
            //     stayed silent on the normalized request 2.
            const violations = captured.filter((c) => c.msg.includes("reasoning-pair-violated"));
            assert.equal(violations.length, 1);

            // (e) the rejected body was persisted, byte-faithful enough to
            //     explain the rejection: same split as the wire body above.
            const files = fs.readdirSync(dumpDir).filter((f) => f.startsWith("err-"));
            assert.equal(files.length, 1, `expected exactly one 4xx dump, got: ${files.join(", ")}`);
            assert.match(files[0]!, /^err-\d+-re400-1-400\.json$/);
            const dumped = JSON.parse(fs.readFileSync(path.join(dumpDir, files[0]!), "utf8")) as { model: string; messages: Record<string, unknown>[] };
            assert.equal(dumped.model, "gpt-test");
            assert.equal(dumped.messages.length, 6);
            const dumpedTc = dumped.messages.find((m) => Array.isArray(m.tool_calls));
            assert.ok(!("reasoning_content" in dumpedTc!), "dump must show the exact rejected projection (absent field)");
        } finally {
            await close(proxy);
            await close(upstream);
        }
    } finally {
        delete process.env.BILI_DUMP_4XX;
        delete process.env.ACP_DUMP_DIR;
        setLogCapture(null);
        fs.rmSync(dumpDir, { recursive: true, force: true });
    }
});

test("#762: dump stays off by default even on 4xx", async () => {
    const captured: Captured[] = [];
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-re400-off-"));
    delete process.env.BILI_DUMP_4XX;
    try {
        process.env.ACP_DUMP_DIR = dumpDir;
        const { proxy, upstream, proxyPort, upstreamPort } = await startHarness(captured, (_bodyText, res) => {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(ERROR_BODY);
        });
        try {
            const resp = await postChat(proxyPort, upstreamPort);
            assert.equal(resp.status, 400);
            await resp.text();
            assert.deepEqual(fs.readdirSync(dumpDir).filter((f) => f.startsWith("err-")), []);
        } finally {
            await close(proxy);
            await close(upstream);
        }
    } finally {
        delete process.env.ACP_DUMP_DIR;
        setLogCapture(null);
        fs.rmSync(dumpDir, { recursive: true, force: true });
    }
});
