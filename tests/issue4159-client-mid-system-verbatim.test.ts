import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// Regression for #4159 (openai-chat lane of the #4166 family): DSH-style
// hosts send REAL mid-conversation system messages (tool_addition blocks
// activating new tools). Two host-side rewrites used to corrupt them:
//   1. src/util.ts systemToUser re-voiced EVERY system/developer message to
//      user — DeepSeek then 400s "tool_addition blocks can only be in system
//      messages" on every subsequent request of the session;
//   2. the kernel codec flattened structured system content to plain text
//      (silent block loss — fixed kernel-side by the rawOpenaiMessage sidecar,
//      #4166 commit 1).
//
// Contract under #4166: a client-origin mid system message is DATA. It rides
// the wire VERBATIM — same role, same position, same bytes — in every request.
// Only bili's OWN summary carriers are re-voiced to user (see
// e2e-mid-system.test.ts — that contract is unchanged and still enforced
// there). A strict single-system backend rejecting the client's own mid
// system is the client's shape honestly forwarded, not something bili may
// silently rewrite (escape hatch: compat.roles).

const TOOL_ADDITION_JSON = JSON.stringify({
    type: "tool_addition",
    tools: [{ type: "function", function: { name: "web_search", description: "search the web" } }],
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function chatJson(content: string): string {
    return JSON.stringify({
        id: "r1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
    });
}

test("e2e #4159: client mid-history system message rides the openai wire verbatim (no re-voice, no drop)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const captured: string[] = [];

    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(chatJson(`assistant reply ${captured.length}`));
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
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;

    // DSH shape: system head, conversation, then a MID system message
    // declaring a newly activated tool (tool_addition), then more turns —
    // resent in full every request (chat wire full-history resend).
    const history: Array<{ role: string; content: unknown }> = [
        { role: "system", content: "You are DSH, the desktop shell host." },
        { role: "user", content: "find the kernel repo" },
        { role: "assistant", content: "looking…" },
        {
            role: "system",
            content: [
                { type: "text", text: `New tools activated for this conversation: ${TOOL_ADDITION_JSON}` },
            ],
        },
    ];

    try {
        for (let turn = 1; turn <= 3; turn++) {
            history.push({ role: "user", content: `turn ${turn}: keep going` });
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "issue4159-verbatim" },
                body: JSON.stringify({ model: "gpt-test", stream: false, messages: history }),
            });
            if (!res.ok) assert.fail(`turn ${turn}: HTTP ${res.status}: ${await res.text()}`);
            const json = (await res.json()) as { choices: Array<{ message: { content?: string } }> };
            history.push({ role: "assistant", content: json.choices[0]?.message?.content ?? "" });
        }

        assert.equal(captured.length, 3, `expected 3 upstream requests, got ${captured.length}`);
        for (let i = 0; i < captured.length; i++) {
            const sent = JSON.parse(captured[i]!) as { messages: Array<{ role: string; content?: unknown }> };
            const matches = sent.messages.filter((m) => {
                const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
                return c.includes("tool_addition");
            });
            assert.equal(matches.length, 1, `upstream request ${i + 1}: tool_addition must appear exactly once`);
            const mid = matches[0]!;
            assert.equal(mid.role, "system", `upstream request ${i + 1}: the client's mid system message was re-voiced to "${mid.role}" — DeepSeek would 400 "tool_addition blocks can only be in system messages" (#4159)`);
            // Byte-verbatim: the structured content block survives round-trip.
            const parts = Array.isArray(mid.content) ? mid.content : [mid.content];
            const text = parts.map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? "")).join("");
            assert.ok(text.includes(TOOL_ADDITION_JSON), `upstream request ${i + 1}: tool_addition JSON payload mutated or dropped`);
            // Position: after the first user turn (mid-history), before the tail.
            const idx = sent.messages.indexOf(mid);
            assert.ok(idx > 1 && idx < sent.messages.length - 1, `upstream request ${i + 1}: mid system message moved to index ${idx}`);
        }
        // Byte-stability across turns: the mid system message's serialized form
        // never changes (prefix-cache friendly).
        const form = (body: string): string => {
            const sent = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
            const mid = sent.messages.find((m) => {
                const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
                return c.includes("tool_addition");
            });
            return JSON.stringify(mid);
        };
        assert.equal(form(captured[0]!), form(captured[1]!), "mid system message bytes drifted between requests 1 and 2");
        assert.equal(form(captured[1]!), form(captured[2]!), "mid system message bytes drifted between requests 2 and 3");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
