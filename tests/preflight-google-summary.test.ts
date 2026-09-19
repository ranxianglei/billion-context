import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// The Gemini wire breaks the #626 assumption that a summary call can be made
// non-streaming: the summarization request is posted to the client's own URL,
// `…:streamGenerateContent?alt=sse`, which answers SSE whatever the request
// says (the Gemini payload has no `stream` field to turn it off). A preflight
// on an over-window session therefore must parse an SSE summary reply that it
// never asked to be streamed — otherwise the summary reads as empty, the
// per-request call budget is burned and the turn fail-fasts with "context
// exceeds the model window" (observed on a 1.39M-token resumed session).

const SUMMARY_TEXT =
    "GEMINI SUMMARY: the segment held a deterministic load-growth payload across a dozen turns; every raw marker is derivable from the seed and none carries unique state, so the folded view loses nothing of value for continued work.";

type Call = { summary: boolean; raw: string };

function sse(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

function geminiText(text: string, thought = false): unknown {
    return {
        candidates: [
            {
                index: 0,
                content: { role: "model", parts: [{ text, ...(thought ? { thought: true } : {}) }] },
                finishReason: "STOP",
            },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
    };
}

// A Gemini upstream: the summary call and the forwarded call both arrive at
// `:streamGenerateContent` and both are answered the way Google answers —
// SSE, with no regard for any stream flag. The summary call is recognised by
// the summarization instruction in its body.
function makeGeminiUpstream(calls: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            calls.push({ summary: isSummary, raw });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (isSummary) {
                // Thinking first, then the summary text — the extractor must
                // take the text part and skip the reasoning part.
                res.write(sse(geminiText("let me compress this segment", true)));
                res.write(sse(geminiText(SUMMARY_TEXT.slice(0, 40))));
                res.write(sse(geminiText(SUMMARY_TEXT.slice(40))));
            } else {
                res.write(sse(geminiText("forwarded to the model")));
            }
            res.end();
        });
    });
}

function longGeminiContents() {
    const contents: { role: string; parts: { text: string }[] }[] = [];
    for (let i = 0; i < 12; i++) {
        contents.push({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) }] });
    }
    return contents;
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gemini-test": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

async function driveGeminiPreflight(proxyPort: number, upstreamPort: number, session: string, path = "streamGenerateContent?alt=sse"): Promise<{ status: number; body: string }> {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ contents: longGeminiContents(), systemInstruction: { parts: [{ text: "You are a test assistant." }] }, generationConfig: { maxOutputTokens: 4096 } }),
    });
    return { status: resp.status, body: await resp.text() };
}

test("e2e preflight (#829): a Gemini summary reply that streams although the call was not streamed is still read", async () => {
    const calls: Call[] = [];
    const upstream = makeGeminiUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const { status, body } = await driveGeminiPreflight(proxyPort, upstreamPort, "pf-google-1");
        assert.equal(status, 200, `an over-window Gemini turn must be compressed and forwarded, not fail-fasted (got HTTP ${status}: ${body.slice(0, 300)})`);

        const summaries = calls.filter((c) => c.summary);
        assert.ok(summaries.length >= 1, "preflight must have asked Gemini for a summary");

        // The preflight request shape is Gemini's: contents + systemInstruction,
        // never the responses `instructions`/`input` pair.
        const first: unknown = JSON.parse(summaries[0]!.raw);
        assert.ok(first !== null && typeof first === "object" && "contents" in first && Array.isArray(first.contents), "the summary call carries Gemini contents");
        assert.equal(first !== null && typeof first === "object" && "instructions" in first, false, "no responses-shaped instructions leak into a Gemini call");

        // The turn reached the model: a real Gemini completion came back.
        assert.ok(body.includes("forwarded to the model"), `the forwarded model reply must reach the client, got: ${body.slice(0, 300)}`);
        assert.ok(body.includes("STOP"), "the client sees a terminated Gemini stream");

        // The fold applied: the rebuilt payload carries the summary text in
        // place of at least one raw range.
        const forwarded = calls.filter((c) => !c.summary).map((c) => c.raw);
        assert.ok(forwarded.length >= 1, "the rebuilt payload was forwarded");
        assert.ok(forwarded.some((r) => r.includes(SUMMARY_TEXT.slice(0, 40))), "the summary replaced a raw range in the forwarded payload");
        const markers = forwarded.reduce((n, r) => n + (r.match(/MARKER_\d+_content_/g) ?? []).length, 0);
        assert.ok(markers < 12 * 250, `the folded payload must drop raw marker text, still carried ${markers}`);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e preflight (#829): the JSON summary of a non-streaming Gemini call is read too", async () => {
    const calls: Call[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            calls.push({ summary: isSummary, raw });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(geminiText(isSummary ? SUMMARY_TEXT : "forwarded to the model")));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const { status, body } = await driveGeminiPreflight(proxyPort, upstreamPort, "pf-google-json", "generateContent");
        assert.equal(status, 200, `the JSON-summary shape must compress as well (got HTTP ${status}: ${body.slice(0, 300)})`);
        assert.ok(calls.filter((c) => c.summary).length >= 1, "a summary was requested");
        assert.ok(body.includes("forwarded to the model"), `the model reply reached the client, got: ${body.slice(0, 300)}`);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
