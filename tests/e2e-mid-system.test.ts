import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// Regression for #355: a multi-segment compress whose segments are separated
// by an uncovered user message made the kernel render a compressed summary
// (role:"system") mid-conversation on the OpenAI wire; strict OpenAI-compatible
// backends (sglang: "System message must be at the beginning") then reject
// EVERY subsequent request for that provider with 400.
//
// Repro shape, driven through the REAL proxy (startServer) against a mock
// upstream that captures every forwarded body:
//   compress #1: single segment anchored at the conversation head (m00001–m00020)
//                → summary lands in the leading system prefix (always safe).
//   compress #2: TWO segments (m00016–m00018 + m00020–m00022) with m00019, a
//                USER message, uncovered between them → both blocks' anchors
//                sit after an uncovered user message → mid-conversation system
//                on the wire before the fix.
//
// Range choices are load-bearing: the kernel NEVER folds the first user
// message (rebuildMessages preserves firstUserIndex), so after compress #1
// refs[0] is still m00001; and the protected zone (preserveRecentTokens)
// excludes the last ~11 visible messages from compression at any point, so
// compress #2 must fire once enough NEW messages have accumulated past the
// zone (refs.length >= 25 ⇒ zone starts at m00029, ranges end at m00022).
// The assertion is sglang's exact validation: in every upstream request, all
// system/developer messages must form a contiguous leading prefix.

const TURN_COUNT = 23;

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function userText(i: number): string {
    return `user turn ${i}: ${"the quick brown fox jumps over the lazy dog. ".repeat(12)}`;
}

// Refs attached to CONVERSATION messages only (index 0 is the injected
// compress-prompt system message, which contains literal <acp> tag EXAMPLES
// in its prose and would pollute a whole-body scan).
function parseMessageRefIds(sent: { messages: Array<{ role: string; content?: unknown }> }): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    for (let i = 1; i < sent.messages.length; i++) {
        const c = typeof sent.messages[i]!.content === "string" ? sent.messages[i]!.content : JSON.stringify(sent.messages[i]!.content ?? "");
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(c)) !== null) ids.push(m[1]!);
    }
    return ids;
}

function compressArgs(ranges: Array<{ startId: string; endId: string; summary: string }>): string {
    return JSON.stringify({ content: ranges.map((r) => ({ startId: r.startId, endId: r.endId, topic: "mid-system e2e", summary: r.summary })) });
}

function chatJson(message: Record<string, unknown>, finishReason: string): string {
    return JSON.stringify({
        id: "r1",
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
    });
}

test("e2e #355: multi-segment compress never puts a system message mid-conversation on the OpenAI wire", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const captured: string[] = [];
    let didCompress1 = false;
    let didCompress2 = false;

    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            const refs = parseMessageRefIds(JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> });
            res.writeHead(200, { "content-type": "application/json" });
            if (!didCompress1 && refs.length >= 25 && refs[0] === "m00001") {
                didCompress1 = true;
                res.end(chatJson(
                    { role: "assistant", content: "", tool_calls: [{ id: "call_c1", type: "function", function: { name: "compress", arguments: compressArgs([{ startId: "m00001", endId: "m00020", summary: "SUMMARY-ONE-MARKER head-anchored single segment" }]) } }] },
                    "tool_calls",
                ));
                return;
            }
            if (didCompress1 && !didCompress2 && refs.length >= 25) {
                didCompress2 = true;
                res.end(chatJson(
                    {
                        role: "assistant",
                        content: "",
                        tool_calls: [{
                            id: "call_c2",
                            type: "function",
                            function: {
                                name: "compress",
                                arguments: compressArgs([
                                    { startId: "m00016", endId: "m00018", summary: "SUMMARY-TWO-A-MARKER first segment, anchored after preserved first user m00001" },
                                    { startId: "m00020", endId: "m00022", summary: "SUMMARY-TWO-B-MARKER second segment, anchored after uncovered user m00019" },
                                ]),
                            },
                        }],
                    },
                    "tool_calls",
                ));
                return;
            }
            res.end(chatJson({ role: "assistant", content: `assistant reply ${captured.length}` }, "stop"));
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
        kernelConfig: defaultConfig(400_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 800,
            compress: { minCompressRange: 1, maxSummaryLength: 20000, minSummaryLength: 1 },
        }),
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
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;

    const history: Array<{ role: string; content: string }> = [];
    try {
        for (let i = 1; i <= TURN_COUNT; i++) {
            history.push({ role: "user", content: userText(i) });
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "mid-system-e2e" },
                body: JSON.stringify({ model: "gpt-test", stream: false, messages: history }),
            });
            if (!res.ok) assert.fail(`turn ${i}: HTTP ${res.status}: ${await res.text()}`);
            const json = (await res.json()) as { choices: Array<{ message: { content?: string } }> };
            const content = json.choices[0]?.message?.content ?? "";
            assert.ok(!content.includes("Compression FAILED"), `turn ${i}: compress tool call failed: ${content}`);
            history.push({ role: "assistant", content });
        }

        assert.ok(didCompress1, "mock upstream never fired compress #1 (head-anchored) — ref layout unexpected");
        assert.ok(didCompress2, "mock upstream never fired compress #2 (two segments, user msg between) — ref layout unexpected");
        assert.equal(captured.length, TURN_COUNT, `expected ${TURN_COUNT} upstream requests, got ${captured.length}`);

        for (let i = 0; i < captured.length; i++) {
            const sent = JSON.parse(captured[i]!) as { messages: Array<{ role: string; content?: unknown }> };
            let firstNonSystem = -1;
            for (let j = 0; j < sent.messages.length; j++) {
                const r = sent.messages[j]!.role;
                if (r !== "system" && r !== "developer") { firstNonSystem = j; break; }
            }
            if (firstNonSystem === -1) continue;
            for (let j = firstNonSystem; j < sent.messages.length; j++) {
                const r = sent.messages[j]!.role;
                assert.ok(
                    r !== "system" && r !== "developer",
                    `upstream request ${i + 1}: role "${r}" at index ${j} AFTER the leading system prefix — sglang would 400 "System message must be at the beginning"`,
                );
            }
        }

        const last = JSON.parse(captured[captured.length - 1]!) as { messages: Array<{ role: string; content?: unknown }> };
        const leadingSystems = last.messages
            .filter((m) => m.role === "system" || m.role === "developer")
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join("\n");
        assert.ok(leadingSystems.includes("SUMMARY-ONE-MARKER"), "head-anchored summary missing from the leading system prefix");
        assert.ok(leadingSystems.includes("SUMMARY-TWO-A-MARKER"), "first mid segment summary missing from the leading system prefix");
        assert.ok(leadingSystems.includes("SUMMARY-TWO-B-MARKER"), "second mid segment summary (the #355 offender) missing from the leading system prefix");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
