// #3813 regression: the Responses lane must honor the #2645 probe-and-remember
// ablation memory, exactly like the OpenAI chat lane. Before this fix the
// Responses adapter forwarded `prompt_cache_key` verbatim even after an
// egress origin+model was A/B-confirmed to reject it — every turn re-paid a
// 400 + probe retry the client never saw (final 200). Gate discipline (#3617):
// both directions are asserted — dropped when ablated, forwarded when clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { startServer } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _resetPckProbeForTest, recordPckAblation } from "../src/pck-probe.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { Server } from "node:http";

interface Captured {
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
}

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: Captured[];
    close(): Promise<void>;
}

async function startHarness(routes: ProxyOptions["routes"] | undefined): Promise<Harness> {
    const captured: Captured[] = [];
    // Non-streaming Responses reply: the proxy relays bytes verbatim, so this
    // completed envelope suffices to reach prepare and capture the OUTGOING body.
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let body: Record<string, unknown> = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            captured.push({ headers: req.headers, body });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy: Server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes ?? {},
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    });
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

function responsesBody(promptCacheKey?: string): Record<string, unknown> {
    const b: Record<string, unknown> = {
        model: "gpt-5",
        input: "hello " + Math.random(),
    };
    if (promptCacheKey !== undefined) b.prompt_cache_key = promptCacheKey;
    return b;
}

test("#3813: Responses lane drops prompt_cache_key once the egress origin+model is A/B-ablated", async () => {
    _resetPckProbeForTest();
    const h = await startHarness(undefined);
    try {
        // Seed the #2645 memory for THIS upstream + model: proven to reject the key.
        recordPckAblation({ origin: `http://127.0.0.1:${h.upstreamPort}/v1`, model: "gpt-5", sessionId: "s-ablate", statusWithKey: 400, errSnippet: "prompt_cache_key not supported" });
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/responses`;
        const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(responsesBody("pck-resp-own")) });
        assert.equal(r.status, 200);
        await r.text();
        const [a] = h.captured;
        assert.ok(a, "request reached the upstream");
        assert.equal(a.body.prompt_cache_key, undefined, "ablated pair must NOT forward prompt_cache_key on the Responses wire");
    } finally {
        await h.close();
    }
});

test("#3813 negative: clean origin+model still forwards the client's prompt_cache_key on the Responses lane", async () => {
    _resetPckProbeForTest();
    const h = await startHarness(undefined);
    try {
        // Ablate a DIFFERENT model on the same origin: gpt-5 stays clean, so its
        // client-supplied key must pass through verbatim (gate must not over-fire).
        recordPckAblation({ origin: `http://127.0.0.1:${h.upstreamPort}/v1`, model: "nim-hostile", sessionId: "s-other", statusWithKey: 400, errSnippet: "bad" });
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/responses`;
        const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(responsesBody("pck-resp-own")) });
        assert.equal(r.status, 200);
        await r.text();
        const [a] = h.captured;
        assert.ok(a, "request reached the upstream");
        assert.equal(a.body.prompt_cache_key, "pck-resp-own", "clean pair must forward the client's prompt_cache_key unchanged");
    } finally {
        await h.close();
    }
});
