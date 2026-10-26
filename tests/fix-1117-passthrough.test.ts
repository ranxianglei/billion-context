// #1117: proxy-side passthrough — x-bili-passthrough marks an unattributed
// in-process caller (native fetch patch routed branch) whose URL already
// points at the proxy via the settings overlay. Such requests relay
// byte-untouched: no session, no injection, no guard, and the internal
// marker never leaks upstream.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

interface Captured {
    url: string;
    body: string;
    passthroughHeader: string | undefined;
}

async function startHarness(injectTool: boolean): Promise<{ proxyPort: number; upstreamPort: number; captured: Captured[]; close(): Promise<void> }> {
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), passthroughHeader: req.headers["x-bili-passthrough"] as string | undefined });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl_1117",
                object: "chat.completion",
                created: 1,
                model: "gpt-test",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        promptCache: { routing: "auto" },
        compress: { injectTool, injectNudge: false },
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
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        proxyPort: (proxy.address() as AddressInfo).port,
        upstreamPort,
        captured,
        async close() {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

test("#1117: x-bili-passthrough forwards the body byte-identical, no injection, marker stripped", async () => {
    const h = await startHarness(true);
    try {
        const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "my_tool", description: "user tool", parameters: { type: "object" } } }] });
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
            body,
        });
        assert.equal(resp.status, 200);
        const text = await resp.text();
        assert.ok(text.includes("chat.completion"));
        assert.equal(h.captured.length, 1);
        // byte-identical: no ACP tool injection, no re-serialization
        assert.equal(h.captured[0].body, body);
        // the internal marker must never reach the real upstream
        assert.equal(h.captured[0].passthroughHeader, undefined);
    } finally {
        await h.close();
    }
});

test("#1117: passthrough works for unparseable bodies (raw path, pre-JSON.parse)", async () => {
    const h = await startHarness(true);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
            body: "not-json-at-all",
        });
        assert.equal(resp.status, 200);
        assert.equal(h.captured.length, 1);
        assert.equal(h.captured[0].body, "not-json-at-all");
    } finally {
        await h.close();
    }
});

test("#1117: negative control — the same request WITHOUT the marker gets the pipeline (injection visible)", async () => {
    const h = await startHarness(true);
    try {
        const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(h.captured.length, 1);
        const sent = JSON.parse(h.captured[0].body) as { tools?: Array<{ function?: { name?: string } }> };
        const names = (sent.tools ?? []).map((t) => t.function?.name).filter((n): n is string => typeof n === "string");
        assert.ok(names.includes("compress"), "unmarked request rides the pipeline (ACP surface injected)");
        assert.equal(h.captured[0].passthroughHeader, undefined);
    } finally {
        await h.close();
    }
});
