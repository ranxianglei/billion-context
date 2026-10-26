import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// [#3272/#3266] The codex host rejects bili-injected tools at its tool router and
// records a synthetic "unsupported call" entry in its own resent history — so an
// armed CCR on that host would declare acp_retrieve (unroutable by the host) AND
// placeholderize oversized tool results the model can never retrieve back (silent
// loss). Same mechanism as the removed image_full restore channel (#3266/#3270). These tests pin the gate at
// the policy-stamping site on the native-tool responses wire: a codex client gets
// CCR disarmed (no acp_retrieve declaration, oversized tool result stays verbatim);
// a non-codex client on the same wire keeps CCR armed (regression guard against
// over-disarming). Mirrors the harness in tests/store-marker-gate.test.ts (#1097).
const PLACEHOLDER_MARK = "[acp-stored #";
const BIG_OUTPUT = "big-output-line-0123456789abcdef\n".repeat(512);
const CODEX_UA = "codex_cli_rs/0.50.0";
const GENERIC_UA = "generic-agent/1.0.0";

interface Harness {
    proxyPort: number;
    upstreamUrl: string;
    captured: string[];
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_ccr3272", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ dir: path.join(os.tmpdir(), `bili-store-ccr3272-${Math.random().toString(36).slice(2)}`), debounceMs: 0 }));
    setRegistryForTest({});
    const route: Record<string, unknown> = { models: { "gpt-test": { context: 400_000 } } };
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: route } as ProxyOptions["routes"],
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        promptCache: { routing: "auto" },
        compress: { injectTool: true, injectNudge: false, ccr: { enabled: true, minToolTokens: 500 } },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
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

async function sendBigToolResult(h: Harness, sessionId: string, userAgent: string): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/${h.upstreamUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId, "user-agent": userAgent },
        body: JSON.stringify({
            model: "gpt-test",
            stream: false,
            session_id: sessionId,
            instructions: "s",
            input: [
                { type: "message", role: "user", content: [{ type: "input_text", text: "run the big script" }] },
                { type: "function_call", name: "shell", arguments: "{\"cmd\":\"gen\"}", call_id: "call_big" },
                { type: "function_call_output", call_id: "call_big", output: BIG_OUTPUT },
            ],
        }),
    });
    const text = await resp.text();
    assert.equal(resp.status, 200, `request failed: ${text.slice(0, 300)}`);
}

test("#3272: codex client on the native responses wire — CCR disarmed, no acp_retrieve declaration and the oversized tool result stays verbatim", async () => {
    const h = await startHarness();
    try {
        await sendBigToolResult(h, "ccr3272-codex", CODEX_UA);
        assert.equal(h.captured.length, 1, `expected exactly one upstream request, got ${h.captured.length}`);
        const body = h.captured[0]!;
        assert.ok(!body.includes("acp_retrieve"), "acp_retrieve must not be declared or referenced for a codex client (the host cannot route it)");
        assert.ok(!body.includes(PLACEHOLDER_MARK), "the codex lane must not carry a store placeholder the model could never retrieve back");
        const line = "big-output-line-0123456789abcdef";
        assert.ok(body.includes(`${line}\\n${line}`), "original tool result must stay verbatim when ccr is disarmed on the codex lane");
    } finally {
        await h.close();
    }
});

test("#3272 control: non-codex client on the same native responses wire — CCR still arms (placeholder + acp_retrieve)", async () => {
    const h = await startHarness();
    try {
        await sendBigToolResult(h, "ccr3272-control", GENERIC_UA);
        assert.equal(h.captured.length, 1, `expected exactly one upstream request, got ${h.captured.length}`);
        const body = h.captured[0]!;
        assert.ok(body.includes('"name":"acp_retrieve"'), "acp_retrieve tool declaration missing on the non-codex native-tool wire (over-disarm regression)");
        assert.ok(body.includes(PLACEHOLDER_MARK), `non-codex native-tool wire must carry the kernel store placeholder: ${body.slice(0, 400)}`);
    } finally {
        await h.close();
    }
});
