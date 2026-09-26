import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { _setStoreForTest, SessionStore } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #1295: a model endpoint on a custom path (/alpha/generate) that speaks the
// commandcode CLI wire — nested CLI envelope request, bare JSONL event-stream
// response — must be routed into the compression pipeline when declared via
// modelEndpointPatterns, instead of being relayed byte-for-byte.

const MODEL = "cc-go-1";

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    forwards: Array<{ url: string; raw: string }>;
    proxy: http.Server;
    upstream: http.Server;
}

async function startRig(): Promise<Rig> {
    const forwards: Array<{ url: string; raw: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            forwards.push({ url: req.url ?? "", raw });
            res.writeHead(200, { "content-type": "application/json" });
            // Play the commandcode backend: a real streaming conversation
            // envelope gets a JSONL answer; anything else is echoed back so
            // verbatim-relay assertions can compare bytes.
            let conv = false;
            try {
                const e = JSON.parse(raw) as any;
                conv = !!e?.params && e.params.stream === true && Array.isArray(e.params.messages) && e.params.messages.length > 0;
            } catch { /* not json */ }
            if (conv) {
                res.end([
                    '{"type":"text-delta","text":"hi"}',
                    '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":11,"outputTokens":4,"inputTokenDetails":{"cacheReadTokens":2}}}',
                ].join("\n") + "\n");
            } else {
                res.end(raw + "\n");
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelEndpoints: [{ match: `http://127.0.0.1:${upstreamPort}/alpha/generate`, wire: "commandcode" }],
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: proxy.address().port, upstreamPort, forwards, proxy, upstream };
}

const envelope = (overrides: Record<string, unknown> = {}, messages: unknown[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }]) => ({
    config: { provider: "commandcode" },
    threadId: "th-test",
    params: { model: MODEL, stream: true, messages, ...overrides },
});

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("#1295: declared commandcode endpoint — envelope unwrapped upstream, JSONL back down", async () => {
    const rig = await startRig();
    try {
        const body = JSON.stringify(envelope());
        const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/alpha/generate`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "cc-sess" },
            body,
        });
        assert.equal(r.status, 200);
        const text = await r.text();
        const lines = text.split("\n").filter(Boolean);
        assert.ok(lines.every((l) => !l.startsWith("data:")), "response must stay bare JSONL, never SSE");
        const evts = lines.map((l) => JSON.parse(l));
        assert.equal(evts[evts.length - 1].type, "finish", `response was: ${text}`);

        const fwd = rig.forwards.at(-1)!;
        assert.ok(fwd.url.startsWith("/alpha/generate"));
        const up = JSON.parse(fwd.raw);
        assert.ok(up.params && typeof up.params === "object", "final boundary must be the rewrapped CLI envelope");
        assert.equal(up.params.model, MODEL);
        assert.equal(up.params.stream, true);
        assert.ok(Array.isArray(up.params.messages) && up.params.messages.length > 0);
        assert.deepEqual(up.config, { provider: "commandcode" }, "rest keys survive the round trip");
        assert.equal(up.threadId, "th-test");
        assert.ok(Array.isArray(up.params.tools) && up.params.tools.length > 0, "proxy tools ride inside the envelope");
        for (const t of up.params.tools as Array<Record<string, unknown>>) {
            assert.equal(t.type, "function");
            assert.ok("input_schema" in t, "tools must be CC-shaped (input_schema)");
        }
    } finally {
        await closeRig(rig);
    }
});

test("#1295: declared endpoint with a non-conversation body relays byte-for-byte", async () => {
    const rig = await startRig();
    try {
        const body = JSON.stringify({ params: { model: MODEL, stream: true, messages: [] } });
        const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/alpha/generate`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "cc-relay" },
            body,
        });
        assert.equal(r.status, 200);
        const text = await r.text();
        const fwd = rig.forwards.at(-1)!;
        assert.equal(fwd.raw, body, "unconvertible body must reach upstream untouched");
        assert.ok(text.startsWith(body), "and the upstream reply passes through unmodified");
    } finally {
        await closeRig(rig);
    }
});

test("#1295: declared endpoint with a non-streaming envelope demotes to verbatim relay (WC-6)", async () => {
    const rig = await startRig();
    try {
        const body = JSON.stringify(envelope({ stream: false }));
        const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/alpha/generate`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "cc-nostream" },
            body,
        });
        assert.equal(r.status, 200);
        await r.text();
        const fwd = rig.forwards.at(-1)!;
        assert.equal(fwd.raw, body, "non-streaming envelopes are out of scope v1 — relayed verbatim");
    } finally {
        await closeRig(rig);
    }
});

test("#1295: declaration drives classification for known families (declared → pipeline, undeclared → relay)", async () => {
    const forwards: string[] = [];
    const sse = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":555,"completion_tokens":7}}\n\n',
        "data: [DONE]\n\n",
    ].join("");
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            forwards.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(sse);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelEndpoints: [{ match: `http://127.0.0.1:${upstreamPort}/custom/complete`, wire: "openai" }],
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    try {
        const body = JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] });
        const r1 = await fetch(`http://127.0.0.1:${proxy.address().port}/bili/http://127.0.0.1:${upstreamPort}/custom/complete`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "declared-openai" },
            body,
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = listSessions().find((s) => s.id === "declared-openai");
        assert.equal(s1?.stats.lastInputTokens, 555, "declared path enters the pipeline (usage accounted)");

        const r2 = await fetch(`http://127.0.0.1:${proxy.address().port}/bili/http://127.0.0.1:${upstreamPort}/other/path`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "undeclared-path" },
            body,
        });
        assert.equal(r2.status, 200);
        await r2.text();
        const s2 = listSessions().find((s) => s.id === "undeclared-path");
        assert.ok(!s2 || s2.stats.lastInputTokens === undefined, "undeclared path is relayed, never classified");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
