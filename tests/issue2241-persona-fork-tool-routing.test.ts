// #2241: dsh mid-session model switch changes the MAIN lane's system text, so
// the persona fingerprint forks THAT LANE onto `<id>|sub:<fp>` while the host
// keeps stamping the bare id on every tool call (dsh-native reads its own
// session id — it cannot know the proxy-invented suffix). Tool routing then
// executed against the frozen parent anchor ("husk") and every compress was
// refused ("every ref is unknown"). Regression: a host-stamped bare id must
// follow its LIVE persona fork — witness ring first (exact emitter), persisted
// conversations map second (restart variant, strictly-fresher child only),
// lane-gated to dsh (Claude Code subagents reuse the `|sub:` key shape, #970).
// #2024 semantics for GENUINE cross-session conflicts stay untouched.
//
// Upstream responses are SSE-framed chat.completion.chunk streams — the shape
// real dsh traffic uses (LLM clients always stream), and the only wire whose
// tool_calls deltas feed the outbound witness ring (pipePluginChatWithStrip).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { after } from "node:test";
import type { ProxyOptions } from "../src/config.ts";

// XDG env BEFORE importing the server (e2e-plugin-grow-compress pattern):
// loadConversations() at boot must not read the developer's production
// plugin-conversations.json — live entries would pollute the registry-variant
// scan that this suite exercises.
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-issue2241-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { _resetPluginStateForTest, resolveConversation } = await import("../src/plugin.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { getSession, peekSession, _resetSessionsForTest } = await import("../src/session.ts");
const { resetToolRingForTest } = await import("../src/tool-ring.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "claude-sonnet-4-5";
const MAIN_SYSTEM = "You are DeepSeek Harness, the main coding agent.\nWorkspace: /tmp.";
const SWITCHED_SYSTEM = "You are DeepSeek Harness, the main coding agent.\nWorkspace: /tmp.\nModel profile: switched.";

const forkKey = (conv: string, system: string): string =>
    `${conv}|sub:${createHash("sha256").update(system, "utf8").digest("hex").slice(0, 16)}`;

const SUMMARY = "The conversation establishes the workspace layout, the build pipeline steps, and the agreed rollout order across services, preserving every original decision for later decompression.";

const USAGE = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };

const sseFrames = (...frames: Record<string, unknown>[]): string =>
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";

const chunk = (choice: Record<string, unknown>, usage?: Record<string, number>): Record<string, unknown> => ({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [choice],
    ...(usage ? { usage } : {}),
});

/** Plain assistant answer on the SSE wire. */
const okSse = (): string => sseFrames(
    chunk({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }),
    chunk({ index: 0, delta: { content: "ok" }, finish_reason: null }),
    chunk({ index: 0, delta: {}, finish_reason: "stop" }, USAGE),
);

/** Model-emitted tool call, split into argument FRAGMENTS across frames so the
 *  accumulation path (delta.tool_calls[].function.arguments) is exercised. */
const toolCallSse = (name: string, args: unknown): string => {
    const argStr = JSON.stringify(args);
    const mid = Math.floor(argStr.length / 2);
    return sseFrames(
        chunk({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }),
        chunk({ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }] }, finish_reason: null }),
        chunk({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(0, mid) } }] }, finish_reason: null }),
        chunk({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(mid) } }] }, finish_reason: null }),
        chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }, USAGE),
    );
};

type Rig = {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    /** Prepend the next upstream response bodies (FIFO); empty queue → plain ok. */
    enqueue: (...bodies: string[]) => void;
};

async function startRig(): Promise<Rig> {
    const queue: string[] = [];
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(queue.shift() ?? okSse());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false },
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
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        upstreamPort,
        proxy,
        upstream,
        enqueue: (...bodies) => { queue.push(...bodies); },
    };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

/** Main-lane turn under the dsh persona headers. `system` selects the lane:
 *  MAIN_SYSTEM rides the raw key (anchor), SWITCHED_SYSTEM forks onto |sub:. */
async function mainTurn(rig: Rig, conv: string, system: string, n: number): Promise<void> {
    const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 64_000,
            stream: true,
            messages: [
                { role: "system", content: system },
                ...Array.from({ length: n }, (_, i): { role: string; content: string } => ({
                    role: i % 2 === 0 ? "user" : "assistant",
                    content: `msg-${i + 1}-` + "z".repeat(6000),
                })),
            ],
        }),
    });
    assert.equal(res.status, 200, "main-lane turn accepted");
    await res.text();
}

type ToolResponse = { ok?: boolean; result?: string; error?: string; code?: string; conversationId?: string };

async function callTool(rig: Rig, payload: Record<string, unknown>): Promise<{ status: number; json: ToolResponse }> {
    const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    return { status: res.status, json: await res.json() as ToolResponse };
}

const compressArgs = (startId: string, endId: string) => ({ content: [{ startId, endId, summary: SUMMARY }] });

/** Anchor the raw key (12 msgs → refs m00001–m00012), then switch the main
 *  lane's system so it forks (20 msgs → fork refs m00001–m00020). Refs ≥ m00013
 *  exist ONLY in the fork — success-vs-"unknown ref" is the routing oracle,
 *  and m00013–m00015 sits outside the kernel's protected zone (last 5 + most
 *  recent user message) so a correctly-routed compress can actually succeed. */
async function anchorThenSwitch(rig: Rig, conv: string): Promise<string> {
    await mainTurn(rig, conv, MAIN_SYSTEM, 12);
    await mainTurn(rig, conv, SWITCHED_SYSTEM, 20);
    const fork = forkKey(conv, SWITCHED_SYSTEM);
    assert.ok(peekSession(conv), "parent session exists under the raw key");
    assert.ok(peekSession(fork), "switched main lane forked onto its |sub: session");
    assert.ok(Object.keys(peekSession(fork)!.state.messageRefs.byRaw).length >= 20, "fork holds the full switched history");
    return fork;
}

test("#2241 witness variant: host-stamped bare id follows the forked live lane (incident repro)", async () => {
    const rig = await startRig();
    const CONV = "dshp2241-witness";
    try {
        // The SWITCHED lane's model answers with a compress tool call — the
        // proxy witnesses it under the FORK session (the incident's 9/9 calls).
        // FIFO: the anchor turn consumes the plain ok, the switch turn the call.
        rig.enqueue(okSse(), toolCallSse("compress", compressArgs("m00013", "m00015")));
        const fork = await anchorThenSwitch(rig, CONV);

        // Host stamps the BARE id (it cannot know the suffix). Before the fix
        // this honored the native caller over the witness and executed against
        // the 12-ref husk → "every ref is unknown". Now it follows the fork.
        const r = await callTool(rig, { conversationId: CONV, tool: "compress", args: compressArgs("m00013", "m00015"), nativeCaller: true });
        assert.equal(r.status, 200, `tool call routed (${r.json.error ?? ""})`);
        assert.equal(r.json.ok, true, `compress succeeded on the live lane: ${r.json.result?.slice(0, 200) ?? ""}`);
        assert.doesNotMatch(r.json.result ?? "", /FAILED/, "no 'every ref is unknown' failure");
        assert.equal(r.json.conversationId, CONV, "response echoes the host's own id");
        assert.equal(peekSession(fork)?.state.blocks.length, 1, "block landed in the FORKED session");
        assert.equal(getSession(CONV)?.state.blocks.length, 0, "husk untouched");
    } finally {
        await closeRig(rig);
    }
});

test("#2241 registry variant: no witness (proxy restart) — strictly-fresher fork wins via conversations map", async () => {
    const rig = await startRig();
    const CONV = "dshp2241-registry";
    try {
        const fork = await anchorThenSwitch(rig, CONV);
        assert.equal(resolveConversation(CONV)?.entry?.sessionId, getSession(CONV).id, "raw key still bound to the parent");
        assert.equal(resolveConversation(fork)?.entry?.sessionId, peekSession(fork)?.id, "fork bound under its suffixed key (#970 discipline)");

        // No tool_calls anywhere → empty witness ring (the restart shape).
        // Fork-only refs prove where the call landed.
        const r = await callTool(rig, { conversationId: CONV, tool: "compress", args: compressArgs("m00013", "m00015"), nativeCaller: true });
        assert.equal(r.status, 200, `tool call routed (${r.json.error ?? ""})`);
        assert.equal(r.json.ok, true, `compress succeeded: ${r.json.result?.slice(0, 200) ?? ""}`);
        assert.equal(peekSession(fork)?.state.blocks.length, 1, "block landed in the forked session");
        assert.equal(getSession(CONV)?.state.blocks.length, 0, "husk untouched");
    } finally {
        await closeRig(rig);
    }
});

test("#2241 stale child: parent re-anchored (model switched back) — NO reroute, parent stays authoritative", async () => {
    const rig = await startRig();
    const CONV = "dshp2241-stale";
    try {
        const fork = await anchorThenSwitch(rig, CONV);
        // Switch BACK to the anchored system: the raw key is alive again and
        // fresher than the child — a bare-id tool call belongs to the parent.
        await mainTurn(rig, CONV, MAIN_SYSTEM, 16);

        const r = await callTool(rig, { conversationId: CONV, tool: "compress", args: compressArgs("m00001", "m00002"), nativeCaller: true });
        assert.equal(r.status, 200, `tool call routed (${r.json.error ?? ""})`);
        assert.equal(r.json.ok, true, `compress succeeded: ${r.json.result?.slice(0, 200) ?? ""}`);
        assert.equal(getSession(CONV)?.state.blocks.length, 1, "block landed in the PARENT (re-anchored) session");
        assert.equal(peekSession(fork)?.state.blocks.length, 0, "stale fork untouched");
    } finally {
        await closeRig(rig);
    }
});

test("#2241 lane gate: a non-dsh parent with |sub: children keeps #2024 semantics (no reroute)", async () => {
    const rig = await startRig();
    const CONV = "dshp2241-gate";
    try {
        const fork = await anchorThenSwitch(rig, CONV);
        // Same state shape as Claude Code subagents (bare parent + |sub: child)
        // but the lane is NOT dsh: the reroute must refuse to fire.
        getSession(CONV).metadata.pluginAgent = "test-agent";

        const r = await callTool(rig, { conversationId: CONV, tool: "compress", args: compressArgs("m00013", "m00015"), nativeCaller: true });
        assert.equal(r.status, 200, "executed against the stamped session (legacy path)");
        assert.match(r.json.result ?? "", /FAILED|unknown/, "fork-only refs fail on the parent — proving no reroute happened");
        assert.equal(peekSession(fork)?.state.blocks.length, 0, "fork untouched");
    } finally {
        await closeRig(rig);
    }
});

test("#2241 non-native callers: conflicting witness still fails closed with 409 (unchanged #2024)", async () => {
    const rig = await startRig();
    const CONV = "dshp2241-conflict";
    try {
        rig.enqueue(okSse(), toolCallSse("compress", compressArgs("m00013", "m00015")));
        await anchorThenSwitch(rig, CONV);

        const r = await callTool(rig, { conversationId: CONV, tool: "compress", args: compressArgs("m00013", "m00015") });
        assert.equal(r.status, 409, "model-transcribed ids never yield to a witness");
        assert.equal(r.json.code, "TOOL_CONVERSATION_CONFLICT");
    } finally {
        await closeRig(rig);
    }
});
