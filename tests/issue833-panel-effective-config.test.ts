import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";

// #833: the /__bili/plugin/status Nudge line (and the plugin tool API) rendered
// under the base kernelConfig — which carries NO file/provider/model compress
// settings — so the panel showed kernel defaults (threshold 50000 / floor 22500)
// regardless of configured nudgeGrowthTokens. It must reflect the last resolved
// per-request config instead.

interface HarnessOpts {
    globalCompress?: Record<string, unknown>;
    routeCompress?: Record<string, unknown>;
}

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startHarness(opts: HarnessOpts): Promise<Harness> {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: "msg_833", role: "assistant", usage: { input_tokens: 55 } } }));
            res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
            res.write(anthropicSse("message_stop", { type: "message_stop" }));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } }, ...(opts.routeCompress ? { compress: opts.routeCompress } : {}) } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, ...(opts.globalCompress ?? {}) },
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        proxyPort,
        upstreamPort,
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

async function sendTurn(h: Harness, conversationId: string): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "pi-plugin/0.0.1",
            "x-bili-plugin-conversation": conversationId,
        },
        body: JSON.stringify({
            model: "claude-test",
            max_tokens: 1024,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
        }),
    });
    assert.equal(resp.status, 200);
    for await (const _chunk of resp.body!) { /* drain */ }
}

async function fetchPanel(h: Harness, conversationId: string): Promise<string> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/status?conversationId=${conversationId}`);
    assert.equal(resp.status, 200);
    const status = (await resp.json()) as { ok: boolean; panel?: string };
    assert.equal(status.ok, true);
    assert.ok(typeof status.panel === "string" && status.panel.length > 0, "panel rendered");
    return status.panel!;
}

test("#833 status panel Nudge line reflects globally configured nudgeGrowthTokens", async () => {
    const h = await startHarness({ globalCompress: { nudgeGrowthTokens: 90_000 } });
    try {
        const conv = "issue833-global";
        await sendTurn(h, conv);
        const panel = await fetchPanel(h, conv);
        assert.match(panel, /^Nudge: idle — .*/m);
        // 90000 → fixed growth band; floor = max(2e4, 0.45 × 90000) = 40500.
        assert.match(panel, /< threshold 90000; growth -?\d+ < floor 40500/);
        assert.doesNotMatch(panel, /threshold 50000/);
        assert.doesNotMatch(panel, /floor 22500/);
    } finally {
        await h.close();
    }
});

test("#833 status panel Nudge line reflects provider-level nudgeGrowthTokens (beats global)", async () => {
    const h = await startHarness({
        globalCompress: { nudgeGrowthTokens: 90_000 },
        routeCompress: { nudgeGrowthTokens: 75_000 },
    });
    try {
        const conv = "issue833-provider";
        await sendTurn(h, conv);
        const panel = await fetchPanel(h, conv);
        assert.match(panel, /^Nudge: idle — .*/m);
        // 75000 → floor = max(2e4, 0.45 × 75000) = 33750.
        assert.match(panel, /< threshold 75000; growth -?\d+ < floor 33750/);
        assert.doesNotMatch(panel, /threshold 90000/);
        assert.doesNotMatch(panel, /threshold 50000/);
    } finally {
        await h.close();
    }
});

test("#833 plugin tool API (acp_status) renders under the session's resolved config", async () => {
    const h = await startHarness({ globalCompress: { nudgeGrowthTokens: 90_000 } });
    try {
        const conv = "issue833-tool";
        await sendTurn(h, conv);
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: "acp_status", args: {} }),
        });
        assert.equal(resp.status, 200);
        const body = (await resp.json()) as { ok: boolean; result?: string };
        assert.equal(body.ok, true);
        assert.ok(typeof body.result === "string" && body.result.length > 0, "tool result rendered");
        assert.match(body.result!, /Nudge: idle —/);
        assert.match(body.result!, /threshold 90000/);
        assert.match(body.result!, /floor 40500/);
        assert.doesNotMatch(body.result!, /threshold 50000/);
    } finally {
        await h.close();
    }
});
