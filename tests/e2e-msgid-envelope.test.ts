// #6539 hermetic e2e: a REAL bili server (startServer) + fake upstream.
// Proves the "record" half of the proposal end-to-end over the HTTP stack:
//   A. normal plugin lane  — a full-resend body carrying the `biliMsgIds`
//      envelope gets its host ids PINNED into the store: the plugin snapshot's
//      rawIds come back as the host ids (not content digests). The field never
//      reaches the upstream.
//   B. verbatim (bypass) lane — the SAME stamped body is scrubbed before the
//      forward, so biliMsgIds never reaches the upstream (the F1 review fix).
// No real agent is involved: the request is shaped exactly the way the dsh /
// pi / omp / opencode envelopes stamp it.
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

interface Captured { body: string; headers: Record<string, string | string[] | undefined>; url: string }

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textScript(): string[] {
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_probe_1", role: "assistant", usage: { input_tokens: 10 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: Captured[];
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => body += c);
        req.on("end", () => {
            captured.push({ body, headers: req.headers, url: req.url ?? "" });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(textScript().join(""));
            res.end();
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort, upstreamPort, captured,
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

const HOST_IDS = ["msg_host_a", "msg_host_b", "msg_host_c"];

async function sendStamped(h: Harness, conv: string, opts: { bypass?: boolean }): Promise<number> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-bili-plugin": "e2e-agent",
        "x-bili-plugin-conversation": conv,
        "x-acp-session": conv,
    };
    if (opts.bypass) headers["x-bili-plugin-bypass"] = "1";
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: "claude-test",
            max_tokens: 1024,
            stream: true,
            system: "You are a test assistant.",
            messages: [
                { role: "user", content: "hello" },
                { role: "assistant", content: "hi there" },
                { role: "user", content: "how are you" },
            ],
            // #6539 envelope: host-stable ids, CORE-aligned (anthropic has no
            // hoist — 3 messages = 3 cores).
            biliMsgIds: HOST_IDS,
        }),
    });
    // drain the SSE stream
    if (resp.body) { for await (const _ of resp.body) { /* drain */ } }
    return resp.status;
}

test("e2e msgid envelope A: normal plugin lane pins host ids + strips the field from the upstream", async () => {
    const h = await startHarness();
    try {
        const status = await sendStamped(h, "conv-pin-a", {});
        assert.equal(status, 200);

        // (1) the stamped field never reaches the upstream (prepare stripped it)
        assert.equal(h.captured.length, 1);
        const upstreamBody = h.captured[0]!.body;
        assert.ok(!upstreamBody.includes("biliMsgIds"), "upstream must not see biliMsgIds");
        assert.ok(!upstreamBody.includes("msg_host_a"), "upstream must not see the host ids");

        // (2) the store is PINNED: the plugin snapshot's rawIds are the host ids
        const snap = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/snapshot?conversationId=${encodeURIComponent("conv-pin-a")}`);
        assert.equal(snap.status, 200);
        const data = (await snap.json()) as Record<string, unknown>;
        assert.equal(data.ok, true);
        const msgs = (data.messages as Array<Record<string, unknown>>).map((m) => m.rawId);
        // The pin made EVERY host id stick (a content digest would be h_*, never
        // msg_host_*). A missing id means churn (the row was re-ingested as a
        // digest) — the exact bug this PR fixes.
        for (const id of HOST_IDS) {
            assert.ok(msgs.includes(id), `expected pinned host rawId "${id}", got: ${JSON.stringify(msgs)}`);
        }
    } finally {
        await h.close();
    }
});

test("e2e msgid envelope B: verbatim (bypass) lane scrubs the stamped field (F1)", async () => {
    const h = await startHarness();
    try {
        const status = await sendStamped(h, "conv-scrub-b", { bypass: true });
        assert.equal(status, 200);
        assert.equal(h.captured.length, 1);
        const upstreamBody = h.captured[0]!.body;
        assert.ok(!upstreamBody.includes("biliMsgIds"), "bypass lane must scrub biliMsgIds (F1)");
        assert.ok(!upstreamBody.includes("msg_host_a"), "bypass lane must not leak host ids");
    } finally {
        await h.close();
    }
});
