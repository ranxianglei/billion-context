// #2780: two backend defects in remote-proxy retrieval:
//   1. A retrieval-only native caller hitting /__bili/plugin/tool triggered the
//      evidence-based plugin-mode flip (pluginAgent="mcp"), which suppressed the
//      proxy's own compression tooling even though the adapter registered only
//      acp_retrieve. Retrieval alone is not evidence of owning the compression
//      tools, so it must not claim ownership.
//   2. Large exported originals were delivered as a pointer to a GLOBAL
//      <stateDir>/retrieve/<ref>.txt; identical refs across sessions collide on
//      that path (and a remote caller cannot read it at all). The exact original
//      now rides back inline as an additive `retrievalExport` response field,
//      captured under the session lock, while the framed pointer text stays put.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { listSessions } from "../src/session.ts";
import { ccrEnabled, contentStoreOf, retrieveToolName } from "../src/store.ts";

// ~10k tokens: comfortably past the 4000-token export threshold, so acp_retrieve
// takes the EXPORT branch (file pointer + snapshot) rather than inline framing.
const BIG_A = "ALPHA-ORIGINAL " + "line of build output ".repeat(1900);
const BIG_B = "BETA-ORIGINAL " + "line of build output ".repeat(1900);

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textScript(): string {
    return anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        anthropicSse("message_stop", { type: "message_stop" });
}

interface Rig {
    proxyUrl: (path: string) => string;
    modelUrl: () => string;
    upstreamBodies: string[];
    closeAll(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(textScript());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    // Base-level CCR enabled so WIRE-mode (non-plugin) sessions arm it per
    // request — the exact remote-proxy posture #2780 targets. minToolTokens low
    // enough that the oversized result below is stored immediately.
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "l162-model": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: false, ccr: { enabled: true, minToolTokens: 50 } },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyUrl: (path) => `http://127.0.0.1:${proxyPort}${path}`,
        modelUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        upstreamBodies,
        closeAll: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > 5000) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

// Wire mode: NO x-bili-plugin header, so the session starts UNBOUND (no
// pluginAgent) — the remote-proxy posture #2780 is about. max_tokens high enough
// to clear the side-request guard so the kernel actually processes+stores.
async function postModel(rig: Rig, conversationId: string, messages: unknown[]): Promise<Response> {
    return fetch(rig.modelUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": conversationId },
        body: JSON.stringify({ model: "l162-model", max_tokens: 64_000, stream: true, messages }),
    });
}

function bigMsgs(bigText: string): unknown[] {
    return [
        { role: "user", content: [{ type: "text", text: "run a big build" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "npm run build" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: bigText }] },
    ];
}

async function toolCall(rig: Rig, conversationId: string, tool: string, args: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await fetch(rig.proxyUrl("/__bili/plugin/tool"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, tool, args }),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function statusOf(rig: Rig, conversationId: string): Promise<{ ok?: boolean; pluginAgent?: string }> {
    const res = await fetch(rig.proxyUrl(`/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`));
    return (await res.json()) as { ok?: boolean; pluginAgent?: string };
}

function toolNames(body: string): string[] {
    const parsed = JSON.parse(body) as { tools?: { name?: string }[] };
    return (parsed.tools ?? []).map((t) => t.name ?? "");
}

// Each startRig installs a fresh store, so "a session id not seen before the
// post" unambiguously identifies the session that post created.
function newestSession(before: Set<string>) {
    return listSessions().find((s) => !before.has(s.id));
}

test("#2780 retrieval-only call does NOT claim plugin ownership; proxy tooling continues", async () => {
    const rig = await startRig();
    try {
        // Turn 1 (wire mode): oversized tool result stored + placeholdered; the
        // ephemeral compress tool is injected onto the wire.
        await postModel(rig, "conv-r", bigMsgs(BIG_A));
        await waitFor(() => rig.upstreamBodies.length >= 1, "first forward");
        const f1 = rig.upstreamBodies[0]!;
        assert.ok(toolNames(f1).includes("compress"), "wire request carries the ephemeral compress tool");
        assert.ok(f1.includes("[acp-stored"), "oversized tool result stored + placeholdered");

        const armed = listSessions().filter((s) => ccrEnabled(s));
        assert.equal(armed.length, 1, "exactly one CCR-armed session");
        const sess = armed[0]!;
        const ref = Object.keys(contentStoreOf(sess).byRef)[0];
        assert.ok(ref, "oversized tool result stored under a ref");
        assert.equal(retrieveToolName(sess), "acp_retrieve");

        // Retrieval-only call through the REAL plugin-tool endpoint (native caller).
        const r = await toolCall(rig, "conv-r", "acp_retrieve", { ref });
        assert.equal(r.status, 200, `retrieve succeeded: ${JSON.stringify(r.data)}`);
        assert.equal(r.data.ok, true);

        // THE FIX: retrieval alone must NOT bind the session to plugin mode.
        const st = await statusOf(rig, "conv-r");
        assert.notEqual(st.pluginAgent, "mcp", "retrieval-only call must not claim full plugin ownership (#2780)");

        // Turn 2: the proxy KEEPS injecting its own compression tooling.
        await postModel(rig, "conv-r", bigMsgs(BIG_A));
        await waitFor(() => rig.upstreamBodies.length >= 2, "second forward");
        const f2 = rig.upstreamBodies[1]!;
        assert.ok(toolNames(f2).includes("compress"), "proxy compression tooling continues after a retrieval-only call (#2780)");
    } finally {
        await rig.closeAll();
    }
});

test("#2780 control: a NON-retrieval successful tool still flips to plugin mode (#760b preserved)", async () => {
    const rig = await startRig();
    try {
        await postModel(rig, "conv-s", [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
        await waitFor(() => rig.upstreamBodies.length >= 1, "first forward");
        const r = await toolCall(rig, "conv-s", "acp_status", {});
        assert.equal(r.status, 200, `status call succeeded: ${JSON.stringify(r.data)}`);
        const st = await statusOf(rig, "conv-s");
        assert.equal(st.pluginAgent, "mcp", "non-retrieval successful tool still flips to plugin mode (#760b)");
    } finally {
        await rig.closeAll();
    }
});

test("#2780 concurrent distinct originals with identical refs each ride back inline", async () => {
    const rig = await startRig();
    try {
        assert.notEqual(BIG_A, BIG_B, "sanity: the two originals differ");

        const beforeA = new Set(listSessions().map((s) => s.id));
        await postModel(rig, "conv-a", bigMsgs(BIG_A));
        await waitFor(() => listSessions().length > beforeA.size, "session A created");
        const sessA = newestSession(beforeA)!;

        const beforeB = new Set(listSessions().map((s) => s.id));
        await postModel(rig, "conv-b", bigMsgs(BIG_B));
        await waitFor(() => listSessions().length > beforeB.size, "session B created");
        const sessB = newestSession(beforeB)!;

        assert.ok(ccrEnabled(sessA) && ccrEnabled(sessB), "both sessions CCR-armed");
        const refA = Object.keys(contentStoreOf(sessA).byRef)[0];
        const refB = Object.keys(contentStoreOf(sessB).byRef)[0];
        assert.ok(refA && refB, "both originals stored under a ref");
        assert.equal(refA, refB, "identical message structure yields identical refs — the collision precondition");

        // Concurrently retrieve the SAME ref number from two sessions holding
        // DIFFERENT originals. Each caller must receive its OWN exact original
        // regardless of the shared global export-file path.
        const [ra, rb] = await Promise.all([
            toolCall(rig, "conv-a", "acp_retrieve", { ref: refA }),
            toolCall(rig, "conv-b", "acp_retrieve", { ref: refB }),
        ]);
        assert.equal(ra.status, 200, `retrieve A: ${JSON.stringify(ra.data)}`);
        assert.equal(rb.status, 200, `retrieve B: ${JSON.stringify(rb.data)}`);

        const expA = ra.data.retrievalExport as { path?: string; text?: string } | undefined;
        const expB = rb.data.retrievalExport as { path?: string; text?: string } | undefined;
        assert.ok(expA, "response A carries the additive retrievalExport snapshot");
        assert.ok(expB, "response B carries the additive retrievalExport snapshot");
        assert.equal(expA!.text, BIG_A, "caller A receives its OWN exact original despite the shared ref/file");
        assert.equal(expB!.text, BIG_B, "caller B receives its OWN exact original despite the shared ref/file");

        // Framed tool-result text is unchanged: still a short pointer naming the
        // ref, never the inlined original.
        assert.match(String(ra.data.result), new RegExp(`acp-retrieved #${refA}`), "framed pointer intact for A");
        assert.match(String(rb.data.result), new RegExp(`acp-retrieved #${refB}`), "framed pointer intact for B");
        assert.ok(!String(ra.data.result).includes(BIG_A.slice(0, 200)), "pointer does not inline the original");
    } finally {
        await rig.closeAll();
    }
});
