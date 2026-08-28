import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer, BILI_HOP_HEADER } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

/** #300: chained bili instances (A forward → B) must not double-process.
 *  A stamps x-bili-hop on processed forwards; B, seeing a foreign marker,
 *  skips ALL processing and passes the request through verbatim (logging a
 *  prominent warn). Two tests: (1) B in isolation with a foreign marker —
 *  proves B rewrites nothing; (2) the full A→B chain — proves single-layer
 *  processing end to end. */

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const MODEL = "gpt-test";

function makeOpts(port: number, upstream: string): ProxyOptions {
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
        autoUpdate: false,
        logFile: "off",
        mitm: { enabled: false, domains: [] },
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

function chainWarnings(logs: { level: string; msg: string }[]): { level: string; msg: string }[] {
    return logs.filter((l) => l.level === "warn" && l.msg.includes("[chain]") && l.msg.includes(BILI_HOP_HEADER));
}

test("#300: inbound foreign x-bili-hop → B passes through WITHOUT processing", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const B = await startServer(makeOpts(0, llmUrl));
    await listen(B);
    const bPort = (B.address() as { port: number }).port;

    const otherMarker = randomUUID();
    const bodyJson = JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: "hello world" },
        ],
    });

    try {
        const resp = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-acp-session": "chain-isolated",
                [BILI_HOP_HEADER]: otherMarker,
            },
            body: bodyJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();

        // B detected the chain and logged a prominent warn naming the upstream instance.
        const warns = chainWarnings(logs);
        assert.equal(warns.length, 1, `expected exactly one chain warning, got ${warns.length}: ${JSON.stringify(warns)}`);
        assert.ok(warns[0]!.msg.includes(otherMarker), "chain warning should name the upstream instance marker");

        // B forwarded the request to the LLM exactly once…
        assert.equal(captured.length, 1, `expected exactly one LLM request, got ${captured.length}`);
        const atLlm = captured[0]!;
        // …with the body BYTE-IDENTICAL (B did not run the pipeline: no tag/tool
        // injection, no re-serialization).
        assert.equal(atLlm.body, bodyJson, "body must reach the LLM byte-identical (B must not rewrite it)");
        const parsed = JSON.parse(atLlm.body) as { tools?: unknown[] };
        assert.ok(!parsed.tools || parsed.tools.length === 0, "B must not inject tools");
        assert.ok(!atLlm.body.includes("\x3cacp "), "B must not inject acp tags");
        // The foreign marker propagated through B unchanged (B did not re-stamp it).
        assert.equal(atLlm.headers[BILI_HOP_HEADER], otherMarker, "foreign marker must propagate through B unchanged");
    } finally {
        setLogCapture(null);
        B.closeAllConnections?.();
        await close(B);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#300: A→B chain → single-layer processing, B warns + passes through", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const B = await startServer(makeOpts(0, llmUrl));
    await listen(B);
    const bUrl = `http://127.0.0.1:${(B.address() as { port: number }).port}`;

    const A = await startServer(makeOpts(0, bUrl));
    await listen(A);
    const aPort = (A.address() as { port: number }).port;

    const body = {
        model: MODEL,
        stream: false,
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: "hello world" },
        ],
    };

    try {
        // Client → A via zero-config /bili/<B-url>/… so A's upstream is B.
        const resp = await fetch(`http://127.0.0.1:${aPort}/bili/${bUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-e2e" },
            body: JSON.stringify(body),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        // B saw A's marker and warned (exactly once — only B is chained here).
        const warns = chainWarnings(logs);
        assert.equal(warns.length, 1, `expected exactly one chain warning (from B), got ${warns.length}: ${JSON.stringify(warns)}`);

        // The request reached the LLM exactly once (no duplicated processing hop).
        assert.equal(captured.length, 1, `expected exactly one LLM request, got ${captured.length}`);
        const atLlm = captured[0]!;
        // A processed + stamped the request (marker present ⇒ A ran the pipeline).
        const markerAtLlm = atLlm.headers[BILI_HOP_HEADER];
        assert.ok(markerAtLlm, "A's x-bili-hop marker must reach the LLM (A processed the request)");
        // B passed A's marker through verbatim (did NOT re-stamp with its own id)
        // — i.e. the marker B warned about is the same one that reached the LLM.
        assert.ok(warns[0]!.msg.includes(markerAtLlm as string),
            "B's chain warning must name the same marker that reached the LLM (A's, not B's)");
    } finally {
        setLogCapture(null);
        A.closeAllConnections?.();
        await close(A);
        B.closeAllConnections?.();
        await close(B);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});
