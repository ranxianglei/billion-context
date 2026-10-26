import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createInitialState } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { buildStatusPanel } from "acp-kernel/panel";
import { startServer } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { BUILD_COMMIT } from "../src/version.ts";
import { fetchProxyVersion } from "../src/agent/shared.ts";
import { EXTERNAL_SUMMARY_CALL_ID_PREFIX, isExternalSummaryBlock } from "../src/external-summary-marker.ts";

// Marker surfaces for externally-summarized blocks + version surfaces that
// must carry the build commit. Three layers, one contract:
//   1. kernel panel "⚡ext" (StatusPanelInput.externalBlockIds, display-only),
//   2. /acp panel header + fetchProxyVersion commit suffix,
//   3. isExternalSummaryBlock predicate (compressCallId prefix, display-only).

function makeBlock(blockId: string, compressCallId?: string): CompressionBlock {
    return {
        blockId,
        runId: "r1",
        tier: 1,
        topic: `topic ${blockId}`,
        summary: "summary text",
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 1200,
        createdAt: Date.now(),
        survivedCount: 1,
        generation: "young",
        active: true,
        ...(compressCallId !== undefined ? { compressCallId } : {}),
    };
}

test("isExternalSummaryBlock matches only the external-summary call-id prefix", () => {
    assert.equal(EXTERNAL_SUMMARY_CALL_ID_PREFIX, "external-summary-");
    assert.equal(isExternalSummaryBlock({ compressCallId: `${EXTERNAL_SUMMARY_CALL_ID_PREFIX}${"a".repeat(36)}` }), true);
    assert.equal(isExternalSummaryBlock({ compressCallId: "toolu_01ABC" }), false, "model-issued call ids are not external");
    assert.equal(isExternalSummaryBlock({}), false, "preflight blocks carry no call id");
});

test("buildStatusPanel marks external blocks with ⚡ext only when passed", () => {
    const state = createInitialState();
    state.blocks.push(makeBlock("b1", `${EXTERNAL_SUMMARY_CALL_ID_PREFIX}00000000-0000-0000-0000-000000000001`));
    state.blocks.push(makeBlock("b2", "toolu_01XYZ"));
    const base = {
        version: "billion-context@0.1.189 (test)",
        tokenCount: 100000,
        systemPromptTokens: 0,
        state,
        nudge: undefined,
        modelContextLimit: 200000,
    } as const;
    const withMarker = buildStatusPanel({ ...base, externalBlockIds: new Set(["b1"]) });
    const b1Line = withMarker.split("\n").find((l) => l.includes("[b1]"));
    const b2Line = withMarker.split("\n").find((l) => l.includes("[b2]"));
    assert.ok(b1Line, "b1 line rendered");
    assert.match(b1Line!, /⚡ext/);
    assert.ok(b2Line, "b2 line rendered");
    assert.doesNotMatch(b2Line!, /⚡ext/);
    // Omitting the set must render identically to pre-marker output (no stray text).
    const plain = buildStatusPanel(base);
    const plainB1 = plain.split("\n").find((l) => l.includes("[b1]"))!;
    assert.doesNotMatch(plainB1, /⚡ext/);
});

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            res.write(sse("message_start", { type: "message_start", message: { id: "msg_ext", role: "assistant", usage: { input_tokens: 55 } } }));
            res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
            res.write(sse("message_stop", { type: "message_stop" }));
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
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
    } as unknown as ProxyOptions);
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

test("panel header and fetchProxyVersion both surface the build commit", async () => {
    const h = await startHarness();
    try {
        const conv = "ext-badge-commit";
        await sendTurn(h, conv);
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/status?conversationId=${conv}`);
        assert.equal(resp.status, 200);
        const status = (await resp.json()) as { ok: boolean; panel?: string };
        assert.equal(status.ok, true);
        assert.ok(typeof status.panel === "string" && status.panel.length > 0, "panel rendered");
        // The header line must carry version AND commit, matching /__bili/status
        // and `--version`. BUILD_COMMIT is "unknown" only in exotic envs without
        // git or dist build-info — tolerate that instead of failing there.
        assert.match(status.panel!, /billion-context@\d+\.\d+\.\d+/);
        if (BUILD_COMMIT !== "unknown") {
            assert.match(status.panel!, new RegExp(`billion-context@\\d+\\.\\d+\\.\\d+ \\(${BUILD_COMMIT}\\)`), "panel header includes the build commit");
        }
        // fetchProxyVersion feeds armed-idle notices across pi/dsh/opencode —
        // it must return "version (commit)" from the same manifest contract.
        const version = await fetchProxyVersion(`http://127.0.0.1:${h.proxyPort}`);
        assert.ok(version, "version probe answered");
        if (BUILD_COMMIT !== "unknown") {
            assert.match(version!, new RegExp(`\\(${BUILD_COMMIT}\\)$`));
        }
    } finally {
        await h.close();
    }
});
