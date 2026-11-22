import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { HOSTID_BODY_FIELD } from "../src/hostid-channel.js";

// #2938 Tier 1 — per-wire ingress contract for the host-stable tool-unit id
// side channel: the field must NEVER reach an upstream on any wire, in any
// state (valid / malformed / miscounted / no-marker), while the request itself
// keeps processing normally (honest degrade, not rejection of traffic).

type Captured = { url: string; body: string };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const IDS4 = ["u-1", "u-2", "u-3", "u-4"];

function openaiBody(): Record<string, unknown> {
    return {
        model: "gpt-test",
        messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
            { role: "assistant", content: null, tool_calls: [
                { id: "c1", type: "function", function: { name: "Bash", arguments: '{"cmd":"ls"}' } },
                { id: "c2", type: "function", function: { name: "Read", arguments: '{"path":"a"}' } },
            ] },
            { role: "tool", tool_call_id: "c1", content: "out1" },
            { role: "tool", tool_call_id: "c2", content: "out2" },
            { role: "assistant", content: "done" },
        ],
    };
}

function anthropicBody(): Record<string, unknown> {
    return {
        model: "claude-test",
        messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: [
                { type: "tool_use", id: "c1", name: "Bash", input: { cmd: "ls" } },
                { type: "tool_use", id: "c2", name: "Read", input: { path: "a" } },
            ] },
            { role: "user", content: [
                { type: "tool_result", tool_use_id: "c1", content: "out1" },
                { type: "tool_result", tool_use_id: "c2", content: "out2" },
            ] },
            { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
    };
}

function responsesBody(): Record<string, unknown> {
    return {
        model: "gpt-test",
        input: [
            { type: "message", role: "user", content: "hi" },
            { type: "function_call", call_id: "c1", name: "Bash", arguments: '{"cmd":"ls"}' },
            { type: "function_call_output", call_id: "c1", output: "out1" },
            { type: "function_call", call_id: "c2", name: "Read", arguments: '{"path":"a"}' },
            { type: "function_call_output", call_id: "c2", output: "out2" },
        ],
    };
}

function googleBody(): Record<string, unknown> {
    return {
        contents: [
            { role: "user", parts: [{ text: "hi" }] },
            { role: "model", parts: [{ functionCall: { name: "Bash", args: { cmd: "ls" } } }, { functionCall: { name: "Read", args: { path: "a" } } }] },
            { role: "user", parts: [{ functionResponse: { name: "Bash", response: { output: "out1" } } }] },
            { role: "user", parts: [{ functionResponse: { name: "Read", response: { output: "out2" } } }] },
        ],
    };
}

test("hostid ingress contract: field never reaches upstream on any wire, any state", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
            const url = req.url ?? "";
            res.setHeader("content-type", "application/json");
            if (url.includes("/v1/messages")) {
                res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
            } else if (url.includes("/responses")) {
                res.end(JSON.stringify({ id: "resp_1", object: "response", status: "completed", model: "gpt-test", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }));
            } else if (url.includes(":generateContent")) {
                res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
            } else {
                res.end(JSON.stringify({ id: "chatcmpl_1", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upPort}`]: { models: { "gpt-test": { context: 400_000 }, "claude-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const pPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${pPort}/bili/http://127.0.0.1:${upPort}`;

    try {
        const cases: { name: string; path: string; body: Record<string, unknown>; field?: unknown; marker?: boolean }[] = [
            { name: "openai valid", path: "/v1/chat/completions", body: openaiBody(), field: IDS4, marker: true },
            { name: "anthropic valid", path: "/v1/messages", body: anthropicBody(), field: IDS4, marker: true },
            { name: "responses valid", path: "/v1/responses", body: responsesBody(), field: IDS4, marker: true },
            { name: "google valid", path: "/v1beta/models/gpt-test:generateContent", body: googleBody(), field: IDS4, marker: true },
            { name: "openai malformed", path: "/v1/chat/completions", body: openaiBody(), field: "not-an-array", marker: true },
            { name: "openai miscount", path: "/v1/chat/completions", body: openaiBody(), field: ["u-1", "u-2", "u-3"], marker: true },
            { name: "openai over-cap", path: "/v1/chat/completions", body: openaiBody(), field: Array.from({ length: 10_001 }, (_, i) => `x${i}`), marker: true },
            { name: "openai no-marker", path: "/v1/chat/completions", body: openaiBody(), field: IDS4, marker: false },
            { name: "openai absent", path: "/v1/chat/completions", body: openaiBody(), marker: true },
        ];

        let n = 0;
        for (const c of cases) {
            n += 1;
            const body: Record<string, unknown> = { ...c.body };
            if (c.field !== undefined) body[HOSTID_BODY_FIELD] = c.field;
            const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": `hostid-${n}` };
            if (c.marker !== false) headers["x-bili-plugin"] = "dsh";
            const resp = await fetch(`${base}${c.path}`, { method: "POST", headers, body: JSON.stringify(body) });
            assert.ok(resp.status < 500, `${c.name}: proxy status ${resp.status}`);
            await resp.arrayBuffer();
        }

        assert.equal(captured.length, cases.length, "every case must have reached the upstream");
        cases.forEach((c, i) => {
            const cap = captured[i]!;
            assert.ok(!cap.body.includes(HOSTID_BODY_FIELD), `${c.name}: side-channel field leaked to upstream`);
            assert.ok(!cap.body.includes("u-1"), `${c.name}: channel payload leaked to upstream`);
        });

        // The valid cases must still be well-formed model requests: original
        // conversation intact apart from the stripped private field.
        const first = JSON.parse(captured[0]!.body) as { messages?: unknown[] };
        assert.equal(first.messages?.length, 6, "openai conversation must survive stripping byte-for-content");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
