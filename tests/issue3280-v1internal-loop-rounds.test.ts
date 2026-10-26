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

// #3280: when the compress loop re-requests upstream (round 2+), that request
// goes out through wireTransform (enveloped for the CloudCode/Antigravity
// /v1internal dialect), so the reply comes back enveloped too — every SSE
// frame nests candidates under .response. Before this fix only round 1's body
// was unwrapped (relay.ts), so parseStream saw zero candidates on every
// round-2+ frame and finished the turn empty right after the round-1 marker.
// These tests pin the full loop: round-1 proxy tool call → round-2+ content,
// plus the non-streaming JSON lane.

const CONV_ID = "3f9c1a6e-4b2d-4e8a-9c1f-2d5e8b7a6c4d";
const MODEL = "gemini-4-argon-high";
const INNER_SESSION_ID = -3750763034362895579;

type Call = { path: string; raw: string };

function sse(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

function gcr(text: string): Record<string, unknown> {
    return {
        candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
    };
}

function envelope(resp: Record<string, unknown>): Record<string, unknown> {
    return { response: resp, traceId: "trace-xyz", metadata: {} };
}

function longContents(): { role: string; parts: { text: string }[] }[] {
    const out: { role: string; parts: { text: string }[] }[] = [];
    for (let i = 0; i < 6; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: `Turn ${i}: ` + "marker".repeat(40) }] });
    }
    return out;
}

function systemInstruction(convId?: string): Record<string, unknown> {
    const head = "<user_information>\nCurrent Date: 2026-10-14\nOperating System: Windows 11\n";
    const tail = convId ? `\nConversation ID: ${convId}\n</user_information>` : "\n</user_information>";
    return { parts: [{ text: head + tail }] };
}

function v1Request(opts: { convId?: string }): Record<string, unknown> {
    return {
        project: "aicode-consumers",
        requestId: `agent/${CONV_ID}`,
        model: MODEL,
        userAgent: "antigravity",
        requestType: "agent",
        request: {
            contents: longContents(),
            systemInstruction: systemInstruction(opts.convId),
            generationConfig: { maxOutputTokens: 4096 },
            sessionId: INNER_SESSION_ID,
        },
    };
}

function makeUpstream(calls: Call[], modelHandlers: ((res: http.ServerResponse) => void)[]): http.Server {
    let n = 0;
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const path = req.url ?? "";
            calls.push({ path, raw });
            if (path.includes(":streamGenerateContent") || path.includes(":generateContent")) {
                const handler = modelHandlers[Math.min(n, modelHandlers.length - 1)];
                n += 1;
                handler(res);
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ userInfo: { uid: 1 } }));
            }
        });
    });
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
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
}

async function drive(proxyPort: number, upstreamPort: number, path: string, body: unknown): Promise<{ status: number; text: string }> {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: resp.status, text: await resp.text() };
}

function ssePayloads(text: string): unknown[] {
    const out: unknown[] = [];
    for (const chunk of text.split("\n\n")) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        try { out.push(JSON.parse(payload)); } catch { /* non-JSON keepalive */ }
    }
    return out;
}

test("#3280 A: round-2+ of the compress loop reads the standard shape and reaches the client", async () => {
    const calls: Call[] = [];
    // Round 1: the model calls the acp_status proxy tool. Round 2+: the final
    // answer. Both arrive inside the CloudCode response envelope.
    const upstream = makeUpstream(calls, [
        (res) => {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(sse(envelope({
                candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { name: "acp_status", args: {} } }] }, finishReason: "STOP" }],
            })));
            res.end();
        },
        (res) => {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(sse(envelope(gcr("Final answer after status."))));
            res.end();
        },
    ]);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ convId: CONV_ID }));
        assert.equal(status, 200, `loop turn must succeed, got HTTP ${status}: ${text.slice(0, 300)}`);

        // The loop actually issued a round-2 re-request (round 1 ended on the
        // proxy tool call), and that re-request went out re-enveloped.
        assert.ok(calls.length >= 2, `expected the loop to re-request upstream, saw ${calls.length} call(s)`);
        const round2 = JSON.parse(calls[1].raw) as Record<string, unknown>;
        assert.equal(round2.project, "aicode-consumers", "round-2 egress re-wrapped into the outer envelope");
        assert.equal(round2.requestType, "agent", "round-2 egress keeps the envelope meta");
        const inner = round2.request as Record<string, unknown>;
        assert.ok(Array.isArray(inner.contents) && (inner.contents as unknown[]).length > 0, "round-2 inner carries the rebuilt contents");
        assert.equal(inner.sessionId, INNER_SESSION_ID, "round-2 rebuild preserves the inner sessionId across loop rounds");
        assert.equal(inner.request, undefined, "round-2 rebuild must not double-nest the envelope into the inner request");

        // Every client frame keeps the {"response":...} envelope Antigravity
        // requires — including bili's synthesized acp_status visibility marker.
        const frames = ssePayloads(text);
        assert.ok(frames.length >= 2, `expected marker + round-2 frames, got ${frames.length}: ${text.slice(0, 300)}`);
        for (const f of frames) {
            assert.ok((f as Record<string, unknown>).response !== undefined, "client frame re-wrapped in {response}");
        }
        assert.match(text, /acp_status result/, "round-1 visibility marker reached the client");
        assert.match(text, /Final answer after status\./, "round-2+ content reached the client (the #3280 regression)");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#3280 B: the non-streaming generateContent lane parses the enveloped reply", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, [
        (res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(envelope(gcr("json lane answer"))));
        },
    ]);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:generateContent", v1Request({ convId: CONV_ID }));
        assert.equal(status, 200, `generateContent turn must succeed, got HTTP ${status}: ${text.slice(0, 300)}`);
        const parsed = JSON.parse(text) as Record<string, unknown>;
        assert.ok(parsed.response !== undefined, `client JSON must be enveloped, got: ${text.slice(0, 200)}`);
        const resp = parsed.response as Record<string, unknown>;
        const candidates = resp.candidates as Array<Record<string, unknown>>;
        assert.ok(Array.isArray(candidates) && candidates.length === 1, "standard GenerateContentResponse shape under the envelope");
        const parts = (candidates[0].content as Record<string, unknown>).parts as Array<Record<string, unknown>>;
        assert.equal(parts[0].text, "json lane answer");
    } finally {
        proxy.close(); upstream.close();
    }
});
