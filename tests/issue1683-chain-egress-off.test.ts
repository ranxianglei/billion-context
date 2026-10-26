import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer, BILI_HOP_HEADER } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { evaluateChain, stampOutbound } from "../src/chain-checkpoint.ts";

/** #1683 (+ follow-up): the `<bili-chain …/>` checkpoint carrier is model-visible
 *  (trailing user message on openai/responses, trailing text part on
 *  anthropic/google), so models read it as phantom user input and burn tokens
 *  commenting on it. Fix: BOTH body-marker heuristics are OFF by default —
 *  egress stamping behind the `chainEgressStamp` opt-in (env BILI_CHAIN_STAMP)
 *  and inbound body-content detection behind `chainContentDetection` (env
 *  BILI_CHAIN_CONTENT); by default ONLY the x-bili-hop header drives chain
 *  recognition, since scanning the body can false-positive on CCR/file-introduced
 *  text and model-echoed tags. These tests pin the contract:
 *  - default opts → a processed outbound carries NO carrier (openai + google);
 *  - `chainEgressStamp: true` → the self-verifying stamp is restored;
 *  - body-detection ENABLED → a valid external checkpoint forwards byte-identical;
 *  - body-detection OFF (new default) → a foreign body-carrier is processed, not
 *    passed through; the x-bili-hop header alone still forces passthrough. */

const L = "\x3c";
const R = "\x3e";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const MODEL = "gpt-test";

function makeOpts(port: number, upstream: string, overrides: Partial<ProxyOptions> = {}): ProxyOptions {
    return {
        port,
        host: "127.0.0.1",
        upstream,
        routes: { [upstream]: { models: { [MODEL]: { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        proxyFallback: { explicitDirect: true, globalSource: "direct" },
        auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        logFile: "off",
        mitm: { enabled: false, domains: [] },
        ...overrides,
    };
}

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: string };

function makeUpstream(captured: Captured[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push({ url: req.url ?? "", headers: req.headers, body });
            res.writeHead(200, { "content-type": "application/json" });
            if ((req.url ?? "").includes(":generateContent")) {
                res.end(JSON.stringify({
                    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
                }));
                return;
            }
            res.end(JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
}

interface Rig {
    port: number;
    logs: { level: string; msg: string }[];
    captured: Captured[];
}

async function withRig(fn: (rig: Rig) => Promise<void>, overrides: Partial<ProxyOptions> = {}): Promise<void> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const srv = await startServer(makeOpts(0, llmUrl, overrides));
    await listen(srv);
    try {
        await fn({ port: (srv.address() as { port: number }).port, logs, captured });
    } finally {
        setLogCapture(null);
        srv.closeAllConnections?.();
        await close(srv);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
}

const OPENAI_BODY = {
    model: MODEL,
    stream: false,
    messages: [
        { role: "system", content: "You are a test assistant." },
        { role: "user", content: "hello world" },
    ],
};

test("#1683: default opts → processed openai outbound carries NO <bili-chain/> carrier", async () => {
    await withRig(async ({ port, captured }) => {
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue1683-openai-default" },
            body: JSON.stringify(OPENAI_BODY),
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        // Was genuinely processed (kernel ran, compress tool injected) — so the
        // absence below is meaningful, not a skipped passthrough.
        assert.ok(captured[0]!.body.includes('"compress"'), "request was processed by the kernel");
        assert.ok(!captured[0]!.body.includes(L + "bili-chain "), "no model-visible chain carrier by default (#1683)");
        assert.equal(evaluateChain(JSON.parse(captured[0]!.body), "openai").verdict, "none");
    });
});

test("#1683: default opts → processed google outbound carries NO <bili-chain/> part", async () => {
    await withRig(async ({ port, captured }) => {
        const url = `http://127.0.0.1:${port}/v1beta/models/${MODEL}:generateContent`;
        const resp = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue1683-google-default" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello world" }] }] }),
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.ok(!captured[0]!.body.includes(L + "bili-chain "), "no model-visible chain carrier by default (#1683)");
        assert.equal(evaluateChain(JSON.parse(captured[0]!.body), "google").verdict, "none");
    });
});

test("#1683: chainEgressStamp:true → the self-verifying stamp is restored on egress", async () => {
    await withRig(async ({ port, captured }) => {
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue1683-openai-on" },
            body: JSON.stringify(OPENAI_BODY),
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.equal(evaluateChain(JSON.parse(captured[0]!.body), "openai").verdict, "valid", "opt-in restores a valid self-verifying stamp");
    }, { chainEgressStamp: true });
});

test("#1683: body-detection enabled → a valid external checkpoint forwards byte-identical (first-processor-wins)", async () => {
    await withRig(async ({ port, captured }) => {
        const sentJson = JSON.stringify(stampOutbound(OPENAI_BODY, "openai", "external-bili", Date.now() - 5_000)!);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue1683-inbound-passthrough" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.body, sentJson, "decoupling preserves verbatim interop forward");
    }, { chainContentDetection: true });
});

test("#1683 follow-up: body-detection OFF (new default) → a foreign body-carrier is processed, not passed through", async () => {
    await withRig(async ({ port, captured }) => {
        const sentJson = JSON.stringify(stampOutbound(OPENAI_BODY, "openai", "external-bili", Date.now() - 5_000)!);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue1683-body-off" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.ok(captured[0]!.body.includes('"compress"'), "kernel ran — the foreign body-carrier did NOT trigger a chain passthrough (body-detection off by default)");
        assert.notEqual(captured[0]!.body, sentJson, "not forwarded verbatim");
    }, { chainContentDetection: false });
});

test("#1683 follow-up: x-bili-hop header alone still forces byte-identical passthrough with body-detection off", async () => {
    await withRig(async ({ port, captured }) => {
        const sentJson = JSON.stringify(OPENAI_BODY);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue1683-hop-only", [BILI_HOP_HEADER]: "external-bili" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.body, sentJson, "the x-bili-hop header drives recognition independently of body scanning");
    }, { chainContentDetection: false });
});
