// #920: proxy-side changes — (a) x-bili-plugin-bypass raw passthrough,
// (b) proxy-mode tool injection DROPS client tools whose names bili owns.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
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
}

async function startHarness(injectTool: boolean): Promise<{ proxyPort: number; upstreamPort: number; captured: Captured[]; close(): Promise<void> }> {
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl_920",
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
    const upstreamPort = (upstream.address() as { port: number }).port;
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
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        captured,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

const DCP_COMPRESS_TOOL = { type: "function", function: { name: "compress", description: "DCP legacy compress definition", parameters: { type: "object" } } };
const MY_TOOL = { type: "function", function: { name: "my_tool", description: "user tool", parameters: { type: "object" } } };

test("#920: x-bili-plugin-bypass forwards the body byte-identical, no injection", async () => {
    const h = await startHarness(true);
    try {
        const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], tools: [DCP_COMPRESS_TOOL] });
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "bypass-sess", "x-bili-plugin-bypass": "1" },
            body,
        });
        assert.equal(resp.status, 200);
        const text = await resp.text();
        assert.ok(text.includes("chat.completion"));
        assert.equal(h.captured.length, 1);
        // byte-identical: no tool injection, no re-serialization of the body
        assert.equal(h.captured[0].body, body);
    } finally {
        await h.close();
    }
});

test("#920: bypass works for unparseable bodies too (raw path, pre-JSON.parse)", async () => {
    const h = await startHarness(true);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-bypass": "1" },
            body: "not-json-at-all",
        });
        assert.equal(resp.status, 200);
        assert.equal(h.captured.length, 1);
        assert.equal(h.captured[0].body, "not-json-at-all");
    } finally {
        await h.close();
    }
});

test("#920: proxy mode drops same-named client tools — one definition per name upstream", async () => {
    const h = await startHarness(true);
    try {
        const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], tools: [DCP_COMPRESS_TOOL, MY_TOOL] });
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "drop-sess" },
            body,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(h.captured.length, 1);
        const sent = JSON.parse(h.captured[0].body) as { tools?: Array<{ type?: string; function?: { name?: string; description?: string } }> };
        const names = (sent.tools ?? []).map((t) => t.function?.name).filter((n): n is string => typeof n === "string");
        const compressCount = names.filter((n) => n === "compress").length;
        assert.equal(compressCount, 1, "exactly one compress definition upstream");
        const compressDef = (sent.tools ?? []).find((t) => t.function?.name === "compress");
        assert.notEqual(compressDef?.function?.description, "DCP legacy compress definition", "client DCP definition must be replaced by bili's");
        assert.ok(names.includes("my_tool"), "unrelated client tools are preserved");
        assert.ok(names.includes("decompress"), "other ACP tools still injected");
        // negative control: no duplicate names at all
        assert.equal(new Set(names).size, names.length, "no duplicate tool names upstream");
    } finally {
        await h.close();
    }
});
