import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function upstreamServer(status: number, onBody: (path: string, rawBody: string) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            onBody(req.url ?? "", Buffer.concat(chunks).toString("utf8"));
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    stop: () => Promise<void>;
    cleanup: () => void;
}

async function startProxy(upstream: http.Server): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-issue1284-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, "{}", "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        proxyFallback: { explicitDirect: true, globalSource: "direct" },
        auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmrf(root);
        },
    };
}

test("non-LLM endpoint ending in /messages claimed via the /bili/ tunnel → relayed verbatim, not rejected (#1284)", async () => {
    const seen: Array<{ path: string; body: string }> = [];
    const upstream = await upstreamServer(200, (p, b) => seen.push({ path: p, body: b }));
    const harness = await startProxy(upstream);
    try {
        const singleMessage = JSON.stringify({
            role: "user",
            parts: [{ type: "text", text: "remember: the deploy key rotates monthly" }],
            created_at: "2026-09-23T08:00:00Z",
            peer_id: "agent-main",
        });
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${harness.upstreamPort}/openviking/api/v1/sessions/sess-abc/messages`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: singleMessage,
        });
        assert.equal(res.status, 200, "a non-conversation body must not be vetoed by bili — the upstream owns its API contract");
        const body = (await res.json()) as Record<string, any>;
        assert.equal(body.ok, true);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].path, "/openviking/api/v1/sessions/sess-abc/messages");
        assert.equal(seen[0].body, singleMessage);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("non-LLM endpoint ending in /chat/completions claimed via the /bili/ tunnel → relayed verbatim (#1284)", async () => {
    const seen: Array<{ path: string; body: string }> = [];
    const upstream = await upstreamServer(200, (p, b) => seen.push({ path: p, body: b }));
    const harness = await startProxy(upstream);
    try {
        const body = JSON.stringify({ tool: "summarize", payload: { doc: "quarterly report" } });
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${harness.upstreamPort}/internal/tools/chat/completions`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
        assert.equal(res.status, 200);
        const parsed = (await res.json()) as Record<string, any>;
        assert.equal(parsed.ok, true);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].path, "/internal/tools/chat/completions");
        assert.equal(seen[0].body, body);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
