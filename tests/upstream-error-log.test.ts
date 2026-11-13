import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { activeThrottleHolds, _resetUpstreamThrottleForTest, noteUpstreamThrottle429 } from "../src/upstream-throttle.ts";

/** #2 field report: a relay answered 400 "请求参数无效" for 34 minutes and
 *  bili.log carried zero trace, because non-2xx upstream responses were
 *  piped through verbatim without logging. The proxy must now warn with
 *  status + request-id + body snippet while still passing the body through
 *  byte-for-byte. */

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface Captured {
    level: string;
    msg: string;
}

async function startProxyWith(
    upstream: http.Server,
    models: Record<string, { context: number }> = { "gpt-test": { context: 400_000 } },
    protocol?: "anthropic",
): Promise<{ proxy: http.Server; proxyPort: number; upstreamPort: number; captured: Captured[] }> {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models, ...(protocol === undefined ? {} : { protocol }) },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, proxyPort, upstreamPort, captured };
}

async function postChat(
    proxyPort: number,
    upstreamPort: number,
    model = "gpt-test",
    sessionId = "upstream-error-log-1",
    authorization?: string,
): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-acp-session": sessionId,
            ...(authorization === undefined ? {} : { authorization }),
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
}

test("non-2xx upstream: body passes through verbatim and proxy logs warn with status, request-id, snippet (#2)", async () => {
    const errorBody = JSON.stringify({ error: { message: "请求参数无效，请检查请求格式和参数 (request id: 202608190253469928499778268d9d6MaylrIZ3)" } });
    const upstream = http.createServer((req, res) => {
        res.writeHead(400, { "content-type": "application/json", "x-request-id": "202608190253469928499778268d9d6MaylrIZ3" });
        res.end(errorBody);
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await postChat(proxyPort, upstreamPort);
        assert.equal(resp.status, 400);
        assert.equal(await resp.text(), errorBody);
        const warn = captured.find((c) => c.level === "warn" && c.msg.includes("← upstream 400"));
        assert.ok(warn, `expected warn log, got: ${captured.map((c) => c.msg).join(" | ")}`);
        assert.match(warn.msg, /请求参数无效/);
        assert.match(warn.msg, /request-id=202608190253469928499778268d9d6MaylrIZ3/);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});

test("non-2xx upstream: chunked body streams through fully and is logged", async () => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.write("part1-");
        res.write("part2");
        res.end();
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await postChat(proxyPort, upstreamPort);
        assert.equal(resp.status, 500);
        assert.equal(await resp.text(), "part1-part2");
        const warn = captured.find((c) => c.level === "warn" && c.msg.includes("← upstream 500"));
        assert.ok(warn, `expected warn log, got: ${captured.map((c) => c.msg).join(" | ")}`);
        assert.match(warn.msg, /part1-part2/);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});

test("non-2xx upstream: oversized body passes through fully; snippet is capped and marked truncated", async () => {
    const chunk = "x".repeat(2048);
    const upstream = http.createServer((req, res) => {
        res.writeHead(429, { "content-type": "text/plain" });
        for (let i = 0; i < 100; i++) res.write(chunk);
        res.end();
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await postChat(proxyPort, upstreamPort);
        assert.equal(resp.status, 429);
        const body = await resp.text();
        assert.equal(body.length, 2048 * 100);
        const warn = captured.find((c) => c.level === "warn" && c.msg.includes("← upstream 429"));
        assert.ok(warn, `expected warn log, got: ${captured.map((c) => c.msg).join(" | ")}`);
        assert.ok(warn.msg.length < 1000, "snippet must be capped");
        assert.match(warn.msg, /…$/);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});

test("KeyRing model 429 throttles only the matching model; keyring_all_limited remains account-wide", async () => {
    const previousThrottle = {
        BILI_THROTTLE_429: process.env.BILI_THROTTLE_429,
        BILI_THROTTLE_429_MAX_CONSECUTIVE: process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE,
        BILI_THROTTLE_429_BASE_DELAY_MS: process.env.BILI_THROTTLE_429_BASE_DELAY_MS,
        BILI_THROTTLE_429_MAX_DELAY_MS: process.env.BILI_THROTTLE_429_MAX_DELAY_MS,
    };
    process.env.BILI_THROTTLE_429 = "1";
    process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE = "5";
    process.env.BILI_THROTTLE_429_BASE_DELAY_MS = "1000";
    process.env.BILI_THROTTLE_429_MAX_DELAY_MS = "8000";
    _resetUpstreamThrottleForTest();
    const seenModels: string[] = [];
    const modelError = JSON.stringify({
        error: { code: "keyring_model_temporarily_unavailable", model: "model-a", message: "model unavailable" },
    });
    const accountError = JSON.stringify({
        error: { code: "keyring_all_limited", model: "monthly", message: "all keys are limited" },
    });
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const model = parsed && typeof parsed === "object" && "model" in parsed && typeof parsed.model === "string"
                ? parsed.model
                : "";
            seenModels.push(model);
            if (model === "model-a" || model === "monthly") {
                res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
                res.end(model === "model-a" ? modelError : accountError);
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                model,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            }));
        });
    });
    const models = {
        "model-a": { context: 400_000 },
        "model-b": { context: 400_000 },
        monthly: { context: 400_000 },
    };
    let proxy: http.Server | undefined;
    try {
        const rig = await startProxyWith(upstream, models);
        proxy = rig.proxy;
        const auth = "Bearer integration-key";

        const modelLimited = await postChat(rig.proxyPort, rig.upstreamPort, "model-a", "scope-model-a", auth);
        assert.equal(modelLimited.status, 429);
        assert.equal(await modelLimited.text(), modelError, "the upstream KeyRing error remains transparent");

        const otherModel = await postChat(rig.proxyPort, rig.upstreamPort, "model-b", "scope-model-b", auth);
        assert.equal(otherModel.status, 200, "a model-local refusal must not throttle another model on this credential");
        await otherModel.text();
        assert.deepEqual(seenModels, ["model-a", "model-b"]);
        assert.equal(activeThrottleHolds().length, 1);
        assert.equal(activeThrottleHolds()[0].model, "model-a");

        const modelRetry = await postChat(rig.proxyPort, rig.upstreamPort, "model-a", "scope-model-a-retry", auth);
        assert.equal(modelRetry.status, 429);
        const localModelHold = JSON.parse(await modelRetry.text()).error;
        assert.equal(localModelHold.code, "bili_throttle_hold");
        assert.equal(localModelHold.scope, "model", "local 429 includes an explicit model-scope marker for a chained relay");
        assert.equal(localModelHold.model, "model-a");
        assert.deepEqual(seenModels, ["model-a", "model-b"], "a repeat for the limited model is held without egress");

        _resetUpstreamThrottleForTest();
        const accountLimited = await postChat(rig.proxyPort, rig.upstreamPort, "monthly", "scope-monthly", auth);
        assert.equal(accountLimited.status, 429);
        assert.equal(await accountLimited.text(), accountError);
        const otherBlocked = await postChat(rig.proxyPort, rig.upstreamPort, "model-b", "scope-monthly-other", auth);
        assert.equal(otherBlocked.status, 429, "keyring_all_limited remains a host+credential hold");
        assert.equal(JSON.parse(await otherBlocked.text()).error.code, "bili_throttle_hold");
        assert.deepEqual(seenModels, ["model-a", "model-b", "monthly"], "account quota blocks every model before egress");
        assert.equal(activeThrottleHolds()[0].model, undefined);
    } finally {
        _resetUpstreamThrottleForTest();
        setLogCapture(null);
        if (proxy !== undefined) await close(proxy);
        await close(upstream);
        for (const [key, value] of Object.entries(previousThrottle)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test("v1internal outer model stays model-scoped after its request envelope is unwrapped", async () => {
    const previousThrottle = {
        BILI_THROTTLE_429: process.env.BILI_THROTTLE_429,
        BILI_THROTTLE_429_MAX_CONSECUTIVE: process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE,
        BILI_THROTTLE_429_BASE_DELAY_MS: process.env.BILI_THROTTLE_429_BASE_DELAY_MS,
        BILI_THROTTLE_429_MAX_DELAY_MS: process.env.BILI_THROTTLE_429_MAX_DELAY_MS,
    };
    process.env.BILI_THROTTLE_429 = "1";
    process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE = "5";
    process.env.BILI_THROTTLE_429_BASE_DELAY_MS = "1000";
    process.env.BILI_THROTTLE_429_MAX_DELAY_MS = "8000";
    _resetUpstreamThrottleForTest();
    const seenModels: string[] = [];
    const modelError = JSON.stringify({
        error: { code: "keyring_model_temporarily_unavailable", model: "model-a", message: "model unavailable" },
    });
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
            const model = typeof parsed.model === "string" ? parsed.model : "";
            seenModels.push(model);
            if (model === "model-a") {
                res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
                res.end(modelError);
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            }));
        });
    });
    let proxy: http.Server | undefined;
    try {
        const rig = await startProxyWith(upstream, {
            "model-a": { context: 400_000 },
            "model-b": { context: 400_000 },
        });
        proxy = rig.proxy;
        const convId = "3f9c1a6e-4b2d-4e8a-9c1f-2d5e8b7a6c4d";
        const postV1Internal = (model: string, sessionId: string) => fetch(
            `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1internal:generateContent`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-acp-session": sessionId,
                    authorization: "Bearer v1-throttle-key",
                },
                body: JSON.stringify({
                    project: "aicode-consumers",
                    requestId: `agent/${convId}`,
                    model,
                    userAgent: "antigravity",
                    requestType: "agent",
                    request: {
                        contents: [{ role: "user", parts: [{ text: "hi" }] }],
                        systemInstruction: { parts: [{ text: `<user_information>\nConversation ID: ${convId}\n</user_information>` }] },
                        generationConfig: { maxOutputTokens: 32 },
                        sessionId: 1,
                    },
                }),
            },
        );

        const limited = await postV1Internal("model-a", "v1-throttle-a");
        assert.equal(limited.status, 429);
        await limited.text();
        const other = await postV1Internal("model-b", "v1-throttle-b");
        assert.equal(other.status, 200, "the v1internal outer model must survive unwrapping as the throttle scope");
        await other.text();
        assert.deepEqual(seenModels, ["model-a", "model-b"]);
        assert.equal(activeThrottleHolds().length, 1);
        assert.equal(activeThrottleHolds()[0].model, "model-a");
    } finally {
        _resetUpstreamThrottleForTest();
        setLogCapture(null);
        if (proxy !== undefined) await close(proxy);
        await close(upstream);
        for (const [key, value] of Object.entries(previousThrottle)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test("Bili local model hold marker remains model-scoped when received by a chained relay", async () => {
    const previousThrottle = {
        BILI_THROTTLE_429: process.env.BILI_THROTTLE_429,
        BILI_THROTTLE_429_MAX_CONSECUTIVE: process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE,
        BILI_THROTTLE_429_BASE_DELAY_MS: process.env.BILI_THROTTLE_429_BASE_DELAY_MS,
        BILI_THROTTLE_429_MAX_DELAY_MS: process.env.BILI_THROTTLE_429_MAX_DELAY_MS,
    };
    process.env.BILI_THROTTLE_429 = "1";
    process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE = "5";
    process.env.BILI_THROTTLE_429_BASE_DELAY_MS = "1000";
    process.env.BILI_THROTTLE_429_MAX_DELAY_MS = "8000";
    _resetUpstreamThrottleForTest();
    const seenModels: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
            const model = typeof parsed.model === "string" ? parsed.model : "";
            seenModels.push(model);
            if (model === "model-a") {
                res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
                res.end(JSON.stringify({
                    error: { type: "rate_limit_error", code: "bili_throttle_hold", scope: "model", model, message: "model-a is locally held by the prior relay" },
                }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-chain",
                object: "chat.completion",
                model,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            }));
        });
    });
    let proxy: http.Server | undefined;
    try {
        const rig = await startProxyWith(upstream, {
            "model-a": { context: 400_000 },
            "model-b": { context: 400_000 },
        });
        proxy = rig.proxy;
        const first = await postChat(rig.proxyPort, rig.upstreamPort, "model-a", "chain-model-a", "Bearer chain-key");
        assert.equal(first.status, 429);
        assert.equal(JSON.parse(await first.text()).error.code, "bili_throttle_hold");

        const otherModel = await postChat(rig.proxyPort, rig.upstreamPort, "model-b", "chain-model-b", "Bearer chain-key");
        assert.equal(otherModel.status, 200, "a chained model-local hold must not become an account-wide hold");
        await otherModel.text();
        assert.deepEqual(seenModels, ["model-a", "model-b"]);
        assert.equal(activeThrottleHolds().length, 1);
        assert.equal(activeThrottleHolds()[0].model, "model-a");
    } finally {
        _resetUpstreamThrottleForTest();
        setLogCapture(null);
        if (proxy !== undefined) await close(proxy);
        await close(upstream);
        for (const [key, value] of Object.entries(previousThrottle)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test("passthrough model extraction covers large JSON and model-bearing URL paths", async () => {
    const previousThrottle = {
        BILI_THROTTLE_429: process.env.BILI_THROTTLE_429,
        BILI_THROTTLE_429_MAX_CONSECUTIVE: process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE,
        BILI_THROTTLE_429_BASE_DELAY_MS: process.env.BILI_THROTTLE_429_BASE_DELAY_MS,
        BILI_THROTTLE_429_MAX_DELAY_MS: process.env.BILI_THROTTLE_429_MAX_DELAY_MS,
    };
    process.env.BILI_THROTTLE_429 = "1";
    process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE = "5";
    process.env.BILI_THROTTLE_429_BASE_DELAY_MS = "1000";
    process.env.BILI_THROTTLE_429_MAX_DELAY_MS = "8000";
    _resetUpstreamThrottleForTest();
    const seenModels: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(text) as { model?: unknown };
            const pathModel = /\/models\/([^:?]+):/.exec(req.url ?? "")?.[1];
            const model = typeof parsed.model === "string" ? parsed.model : pathModel ?? "";
            seenModels.push(model);
            if (model.endsWith("-a")) {
                res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
                res.end(JSON.stringify({
                    error: { code: "keyring_model_temporarily_unavailable", model, message: "model unavailable" },
                }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "ok", model }));
        });
    });
    let proxy: http.Server | undefined;
    try {
        const rig = await startProxyWith(upstream);
        proxy = rig.proxy;
        const pathLimited = await fetch(
            `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1beta/models/path-a:generateContent`,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
                body: JSON.stringify({ contents: [] }),
            },
        );
        assert.equal(pathLimited.status, 429);
        await pathLimited.text();
        const pathOther = await fetch(
            `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1beta/models/path-b:generateContent`,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
                body: JSON.stringify({ contents: [] }),
            },
        );
        assert.equal(pathOther.status, 200, "Gemini model path remains the throttle key on verbatim passthrough");
        await pathOther.text();
        assert.deepEqual(seenModels, ["path-a", "path-b"]);

        _resetUpstreamThrottleForTest();
        const largeLimited = await fetch(
            `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/other`,
            {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer large-key" },
                body: JSON.stringify({ payload: "x".repeat(20 * 1024), model: "large-a" }),
            },
        );
        assert.equal(largeLimited.status, 429);
        await largeLimited.text();
        const largeOther = await fetch(
            `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/other`,
            {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer large-key" },
                body: JSON.stringify({ payload: "x".repeat(20 * 1024), model: "large-b" }),
            },
        );
        assert.equal(largeOther.status, 200, "a >16KiB passthrough body retains its request model scope");
        await largeOther.text();
        assert.deepEqual(seenModels, ["path-a", "path-b", "large-a", "large-b"]);
        assert.equal(activeThrottleHolds().length, 1);
        assert.equal(activeThrottleHolds()[0].model, "large-a");
    } finally {
        _resetUpstreamThrottleForTest();
        setLogCapture(null);
        if (proxy !== undefined) await close(proxy);
        await close(upstream);
        for (const [key, value] of Object.entries(previousThrottle)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
test("Anthropic-on-Vertex passthrough keeps the raw model-path throttle scope", async () => {
    const previousThrottle = {
        BILI_THROTTLE_429: process.env.BILI_THROTTLE_429,
        BILI_THROTTLE_429_MAX_CONSECUTIVE: process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE,
        BILI_THROTTLE_429_BASE_DELAY_MS: process.env.BILI_THROTTLE_429_BASE_DELAY_MS,
        BILI_THROTTLE_429_MAX_DELAY_MS: process.env.BILI_THROTTLE_429_MAX_DELAY_MS,
    };
    process.env.BILI_THROTTLE_429 = "1";
    process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE = "5";
    process.env.BILI_THROTTLE_429_BASE_DELAY_MS = "1000";
    process.env.BILI_THROTTLE_429_MAX_DELAY_MS = "8000";
    _resetUpstreamThrottleForTest();
    const limitedModel = "claude-path@2025-01-01";
    const otherModel = "claude-path-b@2025-01-01";
    const seenModels: string[] = [];
    const upstream = http.createServer((req, res) => {
        const encodedModel = /\/publishers\/anthropic\/models\/([^/:?]+):/.exec(req.url ?? "")?.[1] ?? "";
        const model = decodeURIComponent(encodedModel);
        seenModels.push(model);
        if (model === limitedModel) {
            res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
            res.end(JSON.stringify({
                error: { code: "keyring_model_temporarily_unavailable", model, message: "model unavailable" },
            }));
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "message", model, content: [], stop_reason: "end_turn" }));
    });
    let proxy: http.Server | undefined;
    try {
        const rig = await startProxyWith(upstream, { "gpt-test": { context: 400_000 } }, "anthropic");
        proxy = rig.proxy;
        const first = await fetch(
            `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/projects/p/locations/us/publishers/anthropic/models/${encodeURIComponent(limitedModel)}:rawPredict`,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-passthrough": "1", authorization: "Bearer vertex-key" },
                body: JSON.stringify({ anthropic_version: "2023-06-01", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
            },
        );
        assert.equal(first.status, 429);
        await first.text();
        const second = await fetch(
            `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/projects/p/locations/us/publishers/anthropic/models/${encodeURIComponent(otherModel)}:rawPredict`,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-passthrough": "1", authorization: "Bearer vertex-key" },
                body: JSON.stringify({ anthropic_version: "2023-06-01", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
            },
        );
        assert.equal(second.status, 200, "a different Vertex path model remains eligible");
        await second.text();
        assert.deepEqual(seenModels, [limitedModel, otherModel]);
        assert.equal(activeThrottleHolds().length, 1);
        assert.equal(activeThrottleHolds()[0].model, limitedModel);
    } finally {
        _resetUpstreamThrottleForTest();
        setLogCapture(null);
        if (proxy !== undefined) await close(proxy);
        await close(upstream);
        for (const [key, value] of Object.entries(previousThrottle)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test("an aborted relay probe releases only its owned token while preserving the model hold", { timeout: 5_000 }, async () => {
    const previousThrottle = {
        BILI_THROTTLE_429: process.env.BILI_THROTTLE_429,
        BILI_THROTTLE_429_MAX_CONSECUTIVE: process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE,
        BILI_THROTTLE_429_BASE_DELAY_MS: process.env.BILI_THROTTLE_429_BASE_DELAY_MS,
        BILI_THROTTLE_429_MAX_DELAY_MS: process.env.BILI_THROTTLE_429_MAX_DELAY_MS,
    };
    process.env.BILI_THROTTLE_429 = "1";
    process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE = "5";
    process.env.BILI_THROTTLE_429_BASE_DELAY_MS = "1000";
    process.env.BILI_THROTTLE_429_MAX_DELAY_MS = "8000";
    _resetUpstreamThrottleForTest();
    const firstStarted = Promise.withResolvers<void>();
    const firstResponseClosed = Promise.withResolvers<void>();
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
        upstreamHits++;
        const first = (req.url ?? "").includes("probe=first");
        req.on("end", () => {
            if (first) {
                res.once("close", () => firstResponseClosed.resolve());
                firstStarted.resolve();
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
        });
        req.resume();
    });
    let proxy: http.Server | undefined;
    const controller = new AbortController();
    let firstRequest: Promise<Response> | undefined;
    try {
        const rig = await startProxyWith(upstream, { "cancel-model": { context: 400_000 } });
        proxy = rig.proxy;
        const upstreamUrl = `http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const authorization = "Bearer cancel-probe-key";
        noteUpstreamThrottle429(upstreamUrl, { authorization }, null, Date.now() - 60_000, "cancel-model");
        firstRequest = fetch(
            `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions?probe=first`,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "cancelled-probe-first", authorization },
                body: JSON.stringify({ model: "cancel-model", messages: [{ role: "user", content: "hi" }] }),
                signal: controller.signal,
            },
        );
        await firstStarted.promise;
        controller.abort();
        await assert.rejects(firstRequest, (error: unknown) => error instanceof Error, "client cancellation aborts its relay request");
        await firstResponseClosed.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(activeThrottleHolds().some((hold) => hold.model === "cancel-model"), "cancelling a probe preserves its model hold");

        const second = await fetch(
            `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions?probe=second`,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "cancelled-probe-second", authorization },
                body: JSON.stringify({ model: "cancel-model", messages: [{ role: "user", content: "hi" }] }),
            },
        );
        assert.equal(second.status, 200, "the next same-model request can claim a new probe after cancellation");
        await second.text();
        assert.equal(upstreamHits, 2, "the cancelled probe and subsequent admitted request each reach upstream once");
        assert.equal(activeThrottleHolds().length, 0, "the successful owner clears the matching model hold");
    } finally {
        controller.abort();
        if (firstRequest !== undefined) await firstRequest.catch(() => undefined);
        _resetUpstreamThrottleForTest();
        setLogCapture(null);
        if (proxy !== undefined) {
            proxy.closeAllConnections();
            await close(proxy);
        }
        if (upstream.listening) {
            upstream.closeAllConnections();
            await close(upstream);
        }
        for (const [key, value] of Object.entries(previousThrottle)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
