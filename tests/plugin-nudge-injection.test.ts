import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #451 regression: 0.1.69 gated all three nudge injection sites by !pluginMode
// on the premise that "in plugin mode the agent owns compression". The agent
// plugins (pi/omp) are pure protocol clients with NO nudge channel of their
// own, so suppressing the proxy-side nudge left plugin-mode sessions with no
// proactive trigger — only preflight at the hard limit. The nudge is an
// ephemeral trailing USER message (not persisted, never enters the agent's
// re-sent history), so injecting it in plugin mode is safe. Observable: the
// forwarded payload carries the nudge as a final user message when armed.

function okJson(promptTokens: number): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
    });
}

// 29-message history shaped so the OVER-LIMIT nudge is viable: a long text far
// outside the protected recent zone (so compressible ranges exist) plus filler
// that pushes the tail past preserveRecentMessages/preserveRecentTokens.
function turn2Messages(): Record<string, unknown>[] {
    const longText = "y".repeat(20_000);
    const filler: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 1; i <= 12; i++) {
        filler.push({ role: "user", content: `q${i} ` + "f".repeat(997) });
        filler.push({ role: "assistant", content: `a${i} ` + "e".repeat(997) });
    }
    return [
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
        { role: "assistant", content: longText },
        ...filler,
        { role: "user", content: "now summarize" },
    ];
}

async function forwardedTurn2Length(sessionId: string, extraHeaders: Record<string, string>): Promise<number> {
    const received: unknown[][] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            received.push(body.messages ?? []);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(50_000));
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
        // Operator-declared window (never floored) so 50k/64k = 78% trips the
        // OVER-LIMIT nudge deterministically.
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-v4-flash": { context: 64_000 } } } },
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
    const proxyPort = proxy.address().port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": sessionId, ...extraHeaders };

        // Turn 1 teaches the session its real context size (50k via usage report).
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        // Turn 2: 78% of the declared window arms the nudge. Forwarded payload =
        // 29 client msgs + 1 leading compress system message [+ 1 nudge].
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, messages: turn2Messages() }),
        });
        assert.equal(r2.status, 200);
        await r2.text();

        assert.equal(received.length, 2, "both turns reached the upstream");
        return (received[1] ?? []).length;
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
}

test("#451 control: nudge injected in PROXY mode when armed", async () => {
    const len = await forwardedTurn2Length("nudge-ctrl", {});
    assert.equal(len, 31, "proxy mode appends the nudge as a trailing user message at 78% of 64k");
});

test("#451: nudge ALSO injected in PLUGIN mode when armed (regression)", async () => {
    const len = await forwardedTurn2Length("nudge-plugin", { "x-bili-plugin": "omp" });
    assert.equal(len, 31, "plugin mode must append the nudge too — before the fix the !pluginMode gate suppressed it and this would be 30");
});
