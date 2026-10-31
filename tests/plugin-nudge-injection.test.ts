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

const openaiTools = (names: string[]) => names.map((name) => ({ type: "function", function: { name, description: "d", parameters: { type: "object", properties: {} } } }));

async function forwardedTurn2(sessionId: string, extraHeaders: Record<string, string>, toolNames?: string[]): Promise<{ count: number; messages: Record<string, unknown>[] }> {
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
    const upstreamPort = (upstream.address() as { port: number }).port;

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
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": sessionId, ...extraHeaders };

        // Turn 1 teaches the session its real context size (50k via usage report).
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, ...(toolNames ? { tools: openaiTools(toolNames) } : {}), messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        // Turn 2: 78% of the declared window arms the nudge. Forwarded payload =
        // 29 client msgs + 1 leading compress system message [+ 1 nudge].
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, ...(toolNames ? { tools: openaiTools(toolNames) } : {}), messages: turn2Messages() }),
        });
        assert.equal(r2.status, 200);
        await r2.text();

        assert.equal(received.length, 2, "both turns reached the upstream");
        const msgs = (received[1] ?? []) as Record<string, unknown>[];
        return { count: msgs.length, messages: msgs };
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
}

test("#451 control: nudge injected in PROXY mode when armed", async () => {
    const { count } = await forwardedTurn2("nudge-ctrl", {});
    assert.equal(count, 31, "proxy mode appends the nudge as a trailing user message at 78% of 64k");
});

test("#451: nudge ALSO injected in PLUGIN mode when armed (regression)", async () => {
    // #4998: reachability is now observed per request — a healthy plugin round
    // declares its tools on the wire; the host tool keeps the body off #1897's
    // bili-only side-request demotion.
    const { count } = await forwardedTurn2("nudge-plugin", { "x-bili-plugin": "omp" }, ["compress", "read_file"]);
    assert.equal(count, 31, "plugin mode must append the nudge too — before the fix the !pluginMode gate suppressed it and this would be 30");
});

// #3177: DSH registers bili's ACP tools host-scope, invisible to its preset agent
// (0 of 3939 request headers carried them), so model-driven compression is
// structurally unreachable there. The proxy must drop the whole model-side compress
// surface for DSH plugin sessions — otherwise the standing prompt + nudge tell the
// model to call a tool it can never reach ("unknown tool \"compress\""). #4998 made
// reachability purely observational, so the differential below pins DECLARED vs
// UNDECLARED on the wire: a healthy tools-declared omp round keeps the surface,
// a toolless dsh round drops it.
test("#3177: DSH plugin session drops the compress nudge (regression)", async () => {
    const { count, messages } = await forwardedTurn2("dsh-nudge", { "x-bili-plugin": "dsh" });
    assert.equal(count, 30, "DSH drops the nudge — a healthy (tools-declared) omp plugin session is 31, pre-fix DSH was 31 too");
    const last = messages[messages.length - 1];
    assert.ok(String(last?.["content"]).includes("now summarize"), "the client's own final turn is last — no nudge user message appended after it");
});

test("#3177: DSH plugin session also drops the standing compress system prompt (regression)", async () => {
    const omp = await forwardedTurn2("dsh-sys-omp", { "x-bili-plugin": "omp" }, ["compress", "read_file"]);
    const dsh = await forwardedTurn2("dsh-sys-dsh", { "x-bili-plugin": "dsh" });
    const ompSys = String((omp.messages[0] ?? {})["content"] ?? "");
    const dshSys = String((dsh.messages[0] ?? {})["content"] ?? "");
    assert.ok(ompSys.includes("ACP TAGS"), "control: omp keeps the standing compress prompt (carries the ACP tag guidance)");
    // The full standing prompt (philosophy + how-to + tool surface) is far larger than
    // the tags-only fallback DSH falls back to — so DSH's leading system block shrinks.
    assert.ok(ompSys.length - dshSys.length > 300, `omp system ${ompSys.length}B vs dsh ${dshSys.length}B — DSH must drop the standing compress prompt`);
});
