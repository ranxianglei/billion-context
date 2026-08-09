import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { createInitialState, defaultConfig } from "acp-kernel";
import { startServer, isChatGptCodexUpstream, isCodexResponsesLite, shouldInjectPromptCacheKey, resolvePromptCacheKey } from "../src/server.ts";
import { listSessions } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: Buffer };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("Codex official transport preserves OAuth headers, decodes bodies, and rebases after compact", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
            if (req.url?.includes("fail=1")) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "compact failed" }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    const sessionId = "019fdc81-a420-7a00-bbd1-0a64e3eb772c";
    const requestBody = {
        model: "gpt-5",
        stream: false,
        instructions: "keep native Codex instructions",
        additional_tools: [{ type: "custom", name: "apply_patch", vendor: { keep: true } }],
        tools: [{ type: "custom", name: "shell", format: { type: "grammar", syntax: "lark" } }],
        input: [
            { type: "additional_tools", tools: [{ type: "custom", name: "exec" }] },
            { type: "reasoning", id: "r1", encrypted_content: "ciphertext" },
            { type: "message", id: "m1", status: "completed", role: "user", content: [
                { type: "input_text", text: "hello" },
                { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "high" },
            ] },
        ],
    };
    try {
        const first = await fetch(`${base}/responses`, {
            method: "POST",
            headers: {
                authorization: "Bearer AbCdEf",
                "chatgpt-account-id": "account-123",
                "session-id": sessionId,
                "x-openai-internal-codex-responses-lite": "1",
                "content-encoding": "gzip",
                "content-type": "application/json",
            },
            body: gzipSync(Buffer.from(JSON.stringify(requestBody))),
        });
        assert.equal(first.status, 200);
        await first.arrayBuffer();
        assert.equal(captured[0].url, "/responses");
        assert.equal(captured[0].headers.authorization, "Bearer AbCdEf");
        assert.equal(captured[0].headers["chatgpt-account-id"], "account-123");
        assert.equal(captured[0].headers["content-encoding"], undefined);
        assert.equal(captured[0].headers["session-id"], sessionId);
        assert.equal(captured[0].headers["x-session-id"], undefined);
        const forwarded = JSON.parse(captured[0].body.toString("utf8")) as {
            input: Array<Record<string, unknown>>;
            prompt_cache_key?: string;
            instructions: string;
            additional_tools: unknown[];
            tools: unknown[];
        };
        assert.deepEqual(forwarded.input.map((item) => item.type), ["additional_tools", "message", "reasoning", "message"]);
        assert.match(String(forwarded.input[1].content), /acp_compress/);
        assert.equal(forwarded.input[2].encrypted_content, "ciphertext");
        assert.equal((forwarded.input[3].content as Array<Record<string, unknown>>)[1].type, "input_image");
        assert.equal(forwarded.prompt_cache_key, undefined);
        assert.equal(forwarded.instructions, requestBody.instructions);
        assert.deepEqual(forwarded.additional_tools, requestBody.additional_tools);
        assert.deepEqual(forwarded.tools, requestBody.tools);

        const session = listSessions().find((candidate) => candidate.meta.label === sessionId);
        assert.ok(session);
        session.state.nextBlockId = 7;
        session.blockContents.set("b1", { one: { text: "one", count: 1 }, full: { text: "full", count: 1 } });
        const compact = await fetch(`${base}/responses/compact`, {
            method: "POST",
            headers: {
                authorization: "Bearer AbCdEf",
                "chatgpt-account-id": "account-123",
                "session-id": sessionId,
                "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-5" }),
        });
        assert.equal(compact.status, 200);
        await compact.arrayBuffer();
        assert.equal(captured[1].url, "/responses/compact");
        assert.deepEqual(JSON.parse(captured[1].body.toString("utf8")), { model: "gpt-5" });
        assert.equal(session.state.nextBlockId, 7);
        assert.equal(session.blockContents.size, 1);
        assert.equal((session.metadata.nativeCompactionBoundary as Record<string, unknown>).pendingRebase, true);

        const afterCompact = await fetch(`${base}/responses`, {
            method: "POST",
            headers: {
                authorization: "Bearer AbCdEf",
                "chatgpt-account-id": "account-123",
                "session-id": sessionId,
                "x-openai-internal-codex-responses-lite": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(requestBody),
        });
        assert.equal(afterCompact.status, 200);
        await afterCompact.arrayBuffer();
        assert.equal(session.state.nextBlockId, createInitialState().nextBlockId);
        assert.equal(session.blockContents.size, 0);
        assert.equal((session.metadata.nativeCompactionBoundary as Record<string, unknown>).pendingRebase, false);

        session.state.nextBlockId = 8;
        const failedCompact = await fetch(`${base}/responses/compact?fail=1`, {
            method: "POST",
            headers: { authorization: "Bearer AbCdEf", "session-id": sessionId, "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5" }),
        });
        assert.equal(failedCompact.status, 500);
        await failedCompact.arrayBuffer();
        assert.equal(session.state.nextBlockId, 8);
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("Codex official profile uses text protocol and prompt-cache auto stays native", () => {
    assert.equal(isChatGptCodexUpstream("https://chatgpt.com"), true);
    assert.equal(shouldInjectPromptCacheKey("auto", "https://chatgpt.com"), false);
    assert.equal(shouldInjectPromptCacheKey("auto", "https://api.openai.com"), true);
    assert.equal(shouldInjectPromptCacheKey("enabled", "https://strict.example"), true);
    assert.equal(shouldInjectPromptCacheKey("disabled", "https://api.openai.com"), false);
    const identity = { value: "real-session", source: "body-session", clientProvided: true } as const;
    assert.equal(resolvePromptCacheKey("explicit-key", identity, "enabled", "https://api.openai.com"), "explicit-key");
    assert.equal(resolvePromptCacheKey(undefined, identity, "auto", "https://api.openai.com"), "real-session");
    assert.equal(resolvePromptCacheKey(undefined, { ...identity, clientProvided: false }, "enabled", "https://api.openai.com"), undefined);
    assert.equal(isCodexResponsesLite({ "x-openai-internal-codex-responses-lite": "1" }, { input: [] }), true);
    assert.equal(isCodexResponsesLite({}, { input: [], additional_tools: [] }), true);
    assert.equal(isCodexResponsesLite({}, { input: [{ type: "additional_tools", tools: [] }] }), true);
    assert.equal(isCodexResponsesLite({}, { input: [] }), false);
});
