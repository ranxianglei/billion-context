import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { subagentNamespace } from "../src/responses.ts";
import { deriveMessageId } from "../src/message-id.ts";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("subagentNamespace: first-seen instructions anchor the identity; identical instructions reuse it", () => {
    const id = "ns-unit-a";
    assert.equal(subagentNamespace(id, "You are Codex, the main agent."), id);
    assert.equal(subagentNamespace(id, "You are Codex, the main agent."), id);
});

test("subagentNamespace: differing instructions map to a stable separate |sub: namespace", () => {
    const id = "ns-unit-b";
    assert.equal(subagentNamespace(id, "main prompt"), id);
    const sub = subagentNamespace(id, "guardian prompt");
    assert.match(sub, /^ns-unit-b\|sub:[0-9a-f]{16}$/);
    assert.equal(subagentNamespace(id, "guardian prompt"), sub, "same subagent instructions reuse the sub namespace");
    assert.notEqual(subagentNamespace(id, "reviewer prompt"), sub, "a different subagent gets its own namespace");
    assert.equal(subagentNamespace(id, "main prompt"), id, "main conversation keeps the anchored namespace");
});

test("subagentNamespace: absent or empty instructions never anchor or split", () => {
    const id = "ns-unit-c";
    assert.equal(subagentNamespace(id, undefined), id);
    assert.equal(subagentNamespace(id, "   "), id);
    assert.equal(subagentNamespace(id, "real prompt"), id);
});

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", { response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } } });
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

function textEvents(delta: string): string {
    return [
        sse("response.output_item.added", { item: { type: "message", id: "msg_1", role: "assistant", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta }),
        sse("response.output_item.done", { item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: delta }] }, output_index: 0 }),
    ].join("");
}

test("e2e #150: guardian subagent request bypasses the main session's compression state and keeps the verbatim authorization", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (bodies.length === 1) {
                const compressArgs = JSON.stringify({
                    content: [{ startId: REF_1, endId: REF_2, topic: "session setup", summary: "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK" }],
                });
                res.write(fcEvents(0, "call_c", "compress", compressArgs));
                res.write(completed(1600));
            } else if (bodies.length === 2) {
                res.write(textEvents("main round-2 answer"));
                res.write(completed(350_000));
            } else if (bodies.length === 3) {
                res.write(textEvents("APPROVED"));
                res.write(completed(120));
            } else {
                res.write(textEvents("main replay answer"));
                res.write(completed(350_000));
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-guard-e2e": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

    const SESSION_ID = "e2e-guard-sess";
    const AUTH_SENTENCE = "I approve running `rm -rf /tmp/cache` exactly as the model proposed, bound to approve_exec_1.";
    const MAIN_TURN_1 = `FILLER-A ${"x".repeat(6000)}`;
    const MAIN_TURN_2 = "FILLER-B acknowledged";
    const REF_1 = deriveMessageId("user", "text", MAIN_TURN_1);
    const REF_2 = deriveMessageId("assistant", "text", MAIN_TURN_2);
    const mainBody = {
        model: "gpt-guard-e2e",
        stream: true,
        session_id: SESSION_ID,
        instructions: "You are Codex, the main coding agent.",
        input: [
            { type: "message", role: "user", content: MAIN_TURN_1 },
            { type: "message", role: "assistant", content: MAIN_TURN_2 },
            { type: "message", role: "user", content: "run the deploy for service auth" },
            { type: "function_call", call_id: "call_deploy", name: "exec", arguments: JSON.stringify({ cmd: "./deploy.sh auth" }) },
            { type: "function_call_output", call_id: "call_deploy", output: "deployed rev 42" },
            { type: "message", role: "user", content: "now run the smoke tests" },
            { type: "message", role: "assistant", content: "smoke green" },
            { type: "message", role: "user", content: "continue" },
        ],
    };
    const guardianBody = {
        model: "gpt-guard-e2e",
        stream: true,
        session_id: SESSION_ID,
        instructions: "You are Guardian, the Codex approval reviewer. Evaluate the proposed action against the user authorization.",
        input: [
            { type: "message", role: "user", content: "Approval request: exec command proposed by the main agent." },
            { type: "message", role: "user", content: AUTH_SENTENCE },
            { type: "function_call", call_id: "approve_exec_1", name: "exec", arguments: JSON.stringify({ cmd: "rm -rf /tmp/cache" }) },
            { type: "function_call_output", call_id: "approve_exec_1", output: "(proposed)" },
        ],
    };

    try {
        const mainResp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mainBody) });
        assert.equal(mainResp.status, 200);
        await mainResp.text();

        const guardianResp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(guardianBody) });
        assert.equal(guardianResp.status, 200);
        const guardianOut = await guardianResp.text();
        assert.ok(guardianOut.includes("APPROVED"), "guardian round completes upstream");

        const replayResp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mainBody) });
        assert.equal(replayResp.status, 200);
        await replayResp.text();

        assert.equal(bodies.length, 4, "main original + main compress re-request + guardian passthrough + main replay (guardian triggers no extra round)");
        assert.ok(bodies[2].includes(AUTH_SENTENCE), "guardian request forwards the verbatim user authorization");
        assert.ok(bodies[2].includes("rm -rf /tmp/cache"), "guardian request forwards the bound exec command");
        assert.ok(!bodies[2].includes("FILLER"), "guardian request does not inherit the main conversation's history");
        assert.ok(!bodies[3].includes(AUTH_SENTENCE), "guardian content does not leak into the main namespace");

        const stats = await (await fetch(`http://127.0.0.1:${proxyPort}/__bili/stats`)).json();
        assert.equal(stats.sessions.length, 2, "main and subagent land in separate compression namespaces");
        assert.ok(stats.sessions.every((s: { label?: string }) => s.label === SESSION_ID), "both namespaces share the client session label");
        assert.notEqual(stats.sessions[0].id, stats.sessions[1].id);
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
