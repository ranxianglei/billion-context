import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";

// Regression for #1204: prepareGoogle omitted storeEffectiveRules, so a
// google-wire session never recorded its resolved rules block and the plugin
// tool API fell back to the base Config — rejecting acp_rule when rules were
// enabled at provider level only.

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

function googleFrame(parts: Array<{ text?: string }>, finishReason?: string): string {
    const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
    if (finishReason) candidate.finishReason = finishReason;
    return `data: ${JSON.stringify({ candidates: [candidate], modelVersion: "gemini-test" })}\n\n`;
}

async function startHarness(routeCompress?: Record<string, unknown>): Promise<Harness> {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(googleFrame([{ text: "ok" }]));
            res.write(googleFrame([], "STOP"));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    // Provider/route-level ONLY: the pre-fix bug requires the base Config to
    // lack a rules block (base-level rules would not reproduce it).
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gemini-test": { context: 1_000_000 } }, ...(routeCompress ? { compress: routeCompress } : {}) } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
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
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        proxyPort,
        upstreamPort,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

async function sendGoogleTurn(h: Harness, conversationId: string): Promise<void> {
    const url = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "omp",
            "x-bili-plugin-conversation": conversationId,
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: { maxOutputTokens: 4096 } }),
    });
    assert.equal(res.status, 200, `google turn failed: ${res.status}`);
    await res.text();
}

async function callRuleTool(h: Harness, conversationId: string): Promise<{ status: number; body: { ok?: boolean; error?: string; result?: string } }> {
    const res = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, tool: "acp_rule", args: {} }),
    });
    return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; result?: string } };
}

test("#1204 google wire + provider-level rules: plugin tool acp_rule is accepted", async () => {
    const h = await startHarness({ rules: true });
    try {
        const conv = "issue1204-rules-on";
        await sendGoogleTurn(h, conv);
        const { status, body } = await callRuleTool(h, conv);
        assert.equal(status, 200, `acp_rule must be accepted (got ${status}: ${JSON.stringify(body)})`);
        assert.equal(body.ok, true);
        assert.equal(body.result, "No rules recorded.");
    } finally {
        await h.close();
    }
});

test("#1204 google wire + rules explicitly disabled: plugin tool acp_rule stays gated", async () => {
    const h = await startHarness({ rules: false });
    try {
        const conv = "issue1204-rules-off";
        await sendGoogleTurn(h, conv);
        const { status, body } = await callRuleTool(h, conv);
        assert.equal(status, 200, `acp_rule must stay gated (got ${status}: ${JSON.stringify(body)})`);
        assert.match(body.result ?? "", /is explicitly disabled on this bili proxy \(compress\.rules: false\)/);
    } finally {
        await h.close();
    }
});
