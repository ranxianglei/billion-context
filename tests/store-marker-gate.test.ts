import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { buildStoredPlaceholder, defaultConfig, RETRIEVE_TOOL_NAME } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// [#1097] The kernel content store must never emit a placeholder the model
// cannot retrieve. The responses text/marker protocol declares only the
// readonly ACP tools (no native tool channel for the retrieve tool), so an
// armed store there would silently lose oversized tool results. These tests
// pin the gate at the policy-stamping site: marker protocol → no placeholder,
// original stays verbatim; native tool protocol → placeholder + retrieve tool
// declaration, in the kernel's [acp-stored format.
const PLACEHOLDER_MARK = "[acp-stored #";
const BIG_OUTPUT = "big-output-line-0123456789abcdef\n".repeat(512);

interface Harness {
    proxyPort: number;
    upstreamUrl: string;
    captured: string[];
    close(): Promise<void>;
}

async function startHarness(marker: boolean): Promise<Harness> {
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_gate", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ dir: path.join(os.tmpdir(), `bili-store-gate-${marker ? "marker" : "native"}-${Math.random().toString(36).slice(2)}`), debounceMs: 0 }));
    setRegistryForTest({});
    const route: Record<string, unknown> = { models: { "gpt-test": { context: 400_000 } } };
    if (marker) route.compressProtocol = "marker";
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

async function sendBigToolResult(h: Harness, sessionId: string): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/${h.upstreamUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
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

test("#1097: marker-protocol responses wire — ccr disarmed, oversized tool result stays verbatim (no unretrievable placeholder)", async () => {
    const h = await startHarness(true);
    try {
        await sendBigToolResult(h, "store-gate-marker");
        assert.equal(h.captured.length, 1, `expected exactly one upstream request, got ${h.captured.length}`);
        const body = h.captured[0]!;
        assert.ok(!body.includes(PLACEHOLDER_MARK), "marker-protocol wire must not carry a store placeholder");
        assert.ok(!body.includes("acp_retrieve"), "acp_retrieve must not be declared or referenced on the marker-protocol wire");
        const line = "big-output-line-0123456789abcdef";
        assert.ok(body.includes(`${line}\\n${line}`), "original tool result must stay verbatim when ccr is disarmed");
        assert.ok(body.length > BIG_OUTPUT.length, "full tool result payload missing from the outbound body");
    } finally {
        await h.close();
    }
});

test("#1097: native-tool responses wire — ccr armed, kernel placeholder emitted and acp_retrieve declared (control)", async () => {
    const h = await startHarness(false);
    try {
        await sendBigToolResult(h, "store-gate-control");
        assert.equal(h.captured.length, 1, `expected exactly one upstream request, got ${h.captured.length}`);
        const body = h.captured[0]!;
        assert.ok(body.includes(PLACEHOLDER_MARK), `native-tool wire must carry the kernel store placeholder: ${body.slice(0, 400)}`);
        assert.ok(body.includes('"name":"acp_retrieve"'), "acp_retrieve tool declaration missing on the native-tool wire");
        // the placeholder must teach retrieval in the kernel format
        const ref = body.match(/\[acp-stored #(m\d+)/)?.[1];
        assert.ok(ref, "placeholder must cite an mNNNNN ref");
        assert.ok(body.includes(`${RETRIEVE_TOOL_NAME}(\\"${ref}\\")`), `placeholder must show the retrieve call for ${ref}`);
    } finally {
        await h.close();
    }
});

test("#1097: kernel placeholder format reference — buildStoredPlaceholder renders the shape the gate asserts on", () => {
    const text = buildStoredPlaceholder({ ref: "m00423", kind: "shell output", tokens: 4213, head: "gen", command: "gen", retrieveToolName: RETRIEVE_TOOL_NAME });
    assert.ok(text.startsWith("\u{1F4E6} [acp-stored #m00423"), text);
    assert.ok(text.includes("4,213 tok"));
    assert.ok(text.includes(`${RETRIEVE_TOOL_NAME}("m00423")`));
});
