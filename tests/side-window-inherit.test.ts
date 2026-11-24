// Clients mint child conversation ids for work that runs on the parent's own
// route+model: omp opens idle-recap ephemeral turns as
// `<sessionId>:side:<snowflake>` and subagents as `<sessionId>:sub:<id>`, and
// registers runtime-info only under the parent uuid. The window ladder looked
// the id up literally, so the child missed the parent's report and fell to the
// registry peek — where a tier-gated family is capped at the built-in standard
// 200K without tier evidence (#1321). A 1M-window host therefore sized its own
// recap turns at 200K, and preflight rewrote/aborted a request the client had
// every right to send.
//
// Fix: pluginRuntimeInfoForConversation strips a client-minted child suffix and
// resolves the nearest reporting ancestor, keeping the model-equality gate at
// whichever level answers.

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
import { listSessions } from "../src/session.ts";
import { _resetPluginStateForTest, recordPluginRuntimeInfo } from "../src/plugin.ts";

const MODEL = "claude-opus-5-5"; // 200K standard; models.dev advertises 1M
const ONE_M = 1_000_000;
const PARENT = "01a16993-6110-7152-a930-ed7e8b180820";

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
}

async function startRig(): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetPluginStateForTest();
    // models.dev advertises the MAX tier — the same shape that gets capped at
    // the built-in standard window when no tier evidence rides the request.
    setRegistryForTest({ [`anthropic/${MODEL}`]: { limit: { context: ONE_M } } });
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxyPort, upstreamPort, proxy, upstream };
}

function url(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

/** Sends one request under `sessionId` and returns the effective window the
 *  proxy budgeted for that session. */
async function effectiveWindow(rig: Rig, sessionId: string, model = MODEL): Promise<number | undefined> {
    const r = await fetch(url(rig), {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(r.status, 200);
    await r.text();
    const limit = listSessions()[0]?.metadata.effectiveContextLimit;
    return typeof limit === "number" ? limit : undefined;
}

function reportParent(conversationId = PARENT, model = MODEL): void {
    recordPluginRuntimeInfo({ agent: "omp", model, contextWindow: ONE_M, maxOutput: 128_000, conversationId, source: "client-config", ts: 1 });
}

test("e2e: the parent's own request keeps the reported 1M window", async () => {
    const rig = await startRig();
    try {
        reportParent();
        assert.equal(await effectiveWindow(rig, PARENT), ONE_M);
    } finally {
        await closeRig(rig);
    }
});

test("e2e: a `:side:` ephemeral turn inherits the parent's 1M window, not the 200K cap", async () => {
    const rig = await startRig();
    try {
        reportParent();
        assert.equal(await effectiveWindow(rig, `${PARENT}:side:15b3f37086a59857`), ONE_M, "pre-fix: 200_000 via the registry/#1321 cap");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: `:side:conversation:` and `:sub:` children inherit too", async () => {
    const rig = await startRig();
    try {
        reportParent();
        assert.equal(await effectiveWindow(rig, `${PARENT}:side:conversation:0f3d`), ONE_M);
        assert.equal(await effectiveWindow(rig, `${PARENT}:sub:agent-7`), ONE_M);
    } finally {
        await closeRig(rig);
    }
});

test("e2e: the model gate holds at the parent — a child on another model is not sized by it", async () => {
    const rig = await startRig();
    try {
        reportParent(PARENT, "claude-sonnet-4-5");
        assert.equal(await effectiveWindow(rig, `${PARENT}:side:15b3f37086a59857`), 200_000, "stale window from a different model must not be inherited");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: an unknown parent still falls back to the capped registry window", async () => {
    const rig = await startRig();
    try {
        reportParent();
        assert.equal(await effectiveWindow(rig, "no-such-parent:side:abc"), 200_000);
        assert.equal(await effectiveWindow(rig, `${PARENT}2:side:abc`), 200_000, "no accidental prefix match");
    } finally {
        await closeRig(rig);
    }
});
