import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { pinClientMessageMarks } from "../src/loop/cache-control.ts";

// #6861: `bili claude` rewrites mid-history on every request, collapsing the
// prefix cache (one request hit 8.7%, 119K tokens re-billed). Claude Code
// stamps a cache_control breakpoint on its last message (+ last assistant
// message) and MOVES it as the conversation grows (#2188); anthropicToCore
// harvests those controls into a per-request map that coreToAnthropic
// re-emits verbatim. Re-emitting only the current request's marks strips
// the breakpoint off the message that carried it last turn, so that
// message's bytes rewrite mid-history on the next request — a seam on EVERY
// request with no attribution (the seam detector fingerprints core messages,
// where the marks do not live). The fix pins client-managed breakpoints
// cumulatively (same discipline as bili's own marks, #1637): a marked
// message STAYS marked until it folds away. Proxy mode only — in plugin
// mode the host owns the rolling marks (opencode retouch channel, "no
// accumulation" contract); pinning there breaks the host's latest-only
// discipline (opencode-rolling-cache-marks).

const EPHEMERAL = { type: "ephemeral" } as const;

function session() {
    return { metadata: {} as Record<string, unknown> };
}

test("#6861 unit: a turn-1 client mark stays pinned when the client moves it on turn 2", () => {
    const s = session();
    const turn1 = pinClientMessageMarks(new Map([["msg-a", EPHEMERAL]]), new Set(["msg-a"]), s, 3);
    assert.equal(turn1.size, 1, "turn 1: only the client's own mark");
    assert.deepEqual(s.metadata["anthropicClientCacheMarks"], [{ id: "msg-a", control: EPHEMERAL }], "turn 1 mark recorded");

    // Turn 2: the client moved its breakpoint to msg-b; msg-a must stay marked.
    const turn2 = pinClientMessageMarks(new Map([["msg-b", EPHEMERAL]]), new Set(["msg-a", "msg-b"]), s, 3);
    assert.equal(turn2.size, 2, "turn 2: current + pinned");
    assert.deepEqual(turn2.get("msg-a"), EPHEMERAL, "turn-1 mark pinned back");
    assert.deepEqual(turn2.get("msg-b"), EPHEMERAL, "current mark always emitted");
});

test("#6861 unit: a pinned mark retires when its message folds away", () => {
    const s = session();
    pinClientMessageMarks(new Map([["msg-a", EPHEMERAL]]), new Set(["msg-a"]), s, 3);
    const after = pinClientMessageMarks(new Map([["msg-b", EPHEMERAL]]), new Set(["msg-b"]), s, 3);
    assert.equal(after.has("msg-a"), false, "folded message's mark retired");
    assert.equal(after.size, 1, "only the live mark remains");
});

test("#6861 unit: over budget, the NEWEST pinned-only marks are evicted first; current marks never drop", () => {
    const s = session();
    // Cap 1 with two live pinned marks and one current mark: the newest
    // pinned-only mark goes first, so any seam lands next to the tail.
    pinClientMessageMarks(new Map([["msg-a", EPHEMERAL]]), new Set(["msg-a", "msg-b", "msg-c"]), s, 3);
    pinClientMessageMarks(new Map([["msg-b", EPHEMERAL]]), new Set(["msg-a", "msg-b", "msg-c"]), s, 3);
    const merged = pinClientMessageMarks(new Map([["msg-c", EPHEMERAL]]), new Set(["msg-a", "msg-b", "msg-c"]), s, 1);
    assert.equal(merged.has("msg-c"), true, "current mark never dropped");
    assert.equal(merged.has("msg-a"), false, "newest pinned-only mark evicted first");
    assert.equal(merged.size, 1, "merged set fits the cap");
});

test("#6861 unit: BILI_NO_CACHE_CONTROL=1 clears stored pins and returns only current marks", () => {
    const prev = process.env.BILI_NO_CACHE_CONTROL;
    process.env.BILI_NO_CACHE_CONTROL = "1";
    try {
        const s = session();
        pinClientMessageMarks(new Map([["msg-a", EPHEMERAL]]), new Set(["msg-a"]), s, 3);
        const merged = pinClientMessageMarks(new Map([["msg-b", EPHEMERAL]]), new Set(["msg-a", "msg-b"]), s, 3);
        assert.equal(merged.has("msg-a"), false, "no pinning while disabled");
        assert.equal(merged.size, 1, "only the current mark");
        assert.equal(s.metadata["anthropicClientCacheMarks"], undefined, "stored pins cleared");
    } finally {
        if (prev === undefined) delete process.env.BILI_NO_CACHE_CONTROL;
        else process.env.BILI_NO_CACHE_CONTROL = prev;
    }
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
}

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
    proxyPort: number;
    portHint(): number;
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
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "l6861-model": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    let server: http.Server;
    try {
        server = await startServer(opts);
    } catch (error) {
        await close(upstream);
        throw error;
    }
    await listen(server);
    const proxyPort = (server.address() as { port: number }).port;
    return {
        proxyPort,
        portHint: () => upstreamPort,
        upstreamBodies,
        closeAll: async () => {
            await close(server);
            await close(upstream);
        },
    };
}

interface Msg {
    role: "user" | "assistant";
    content: string | { type: "text"; text: string; cache_control?: unknown }[];
}

async function postModel(rig: Rig, sessionId: string, messages: Msg[]): Promise<Response> {
    return fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.portHint()}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-affinity": sessionId },
        body: JSON.stringify({ model: "l6861-model", max_tokens: 8192, stream: true, messages }),
    });
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(pred(), `timeout waiting for ${what}`);
}

interface AnthropicBody {
    messages: { role: string; content: string | { type: string; text?: string; cache_control?: unknown }[] }[];
}

function markedIndexes(body: string): number[] {
    const parsed = JSON.parse(body) as AnthropicBody;
    const out: number[] = [];
    parsed.messages.forEach((m, i) => {
        if (Array.isArray(m.content) && m.content.some((b) => b.cache_control)) out.push(i);
    });
    return out;
}

test("#6861 e2e: the client's moving breakpoint stays pinned, so turn 1's messages serialize byte-identically on turn 2", async () => {
    const rig = await startRig();
    try {
        const sid = `sess-6861-${process.pid}`;
        // Turn 1: the client marks its last message (u1), as Claude Code does.
        const h1: Msg[] = [
            { role: "user", content: [{ type: "text", text: "u1", cache_control: { type: "ephemeral" } }] },
            { role: "assistant", content: "a1" },
        ];
        await postModel(rig, sid, h1);
        await waitFor(() => rig.upstreamBodies.length >= 1, "turn 1 forward");
        assert.deepEqual(markedIndexes(rig.upstreamBodies[0]), [0], "turn 1: only the client's mark");

        // Turn 2: the client moved its breakpoint to the new last message (u2)
        // and sends u1 unmarked. Without pinning, u1's bytes rewrite
        // mid-history; with pinning, u1 keeps its breakpoint and the
        // turn-1 prefix stays byte-stable.
        const h2: Msg[] = [
            { role: "user", content: "u1" },
            { role: "assistant", content: "a1" },
            { role: "user", content: [{ type: "text", text: "u2", cache_control: { type: "ephemeral" } }] },
        ];
        await postModel(rig, sid, h2);
        await waitFor(() => rig.upstreamBodies.length >= 2, "turn 2 forward");

        const b1 = JSON.parse(rig.upstreamBodies[0]) as AnthropicBody;
        const b2 = JSON.parse(rig.upstreamBodies[1]) as AnthropicBody;
        assert.deepEqual(markedIndexes(rig.upstreamBodies[1]), [0, 2], "turn 2: pinned turn-1 mark + current mark");
        assert.deepEqual(b2.messages[0], b1.messages[0], "turn-1 marked message byte-stable across turns (prefix-cache contract)");
        assert.deepEqual(b2.messages[1], b1.messages[1], "turn-1 tail message byte-stable across turns");
    } finally {
        await rig.closeAll();
    }
});
