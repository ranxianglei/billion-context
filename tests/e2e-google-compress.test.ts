import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { listSessions } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// Gemini native wire end-to-end: the client replays a growing `contents` array
// against `/v1beta/models/<model>:streamGenerateContent?alt=sse`, the mock
// upstream demands compression through a `functionCall` part, and the proxy must
// (a) recognize the wire, (b) inject the ACP tool declarations, (c) execute the
// compress call server-side, and (d) forward a FOLDED, bounded payload while the
// client history keeps growing.
const TURNS = 60;
const LIVE_BYTES_THRESHOLD = 24 * 1024;
const CHARS_PER_TOKEN = 4;
const MSG_TOKENS = 120;
const SUMMARY_TEXT = "summary of the compressed middle segment: the conversation grew turn by turn while the proxy folded the middle of the history into this block";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
}

function userText(i: number): string {
    const filler = "the quick brown fox jumps over the lazy dog. ";
    return `user turn ${i}: ${filler.repeat((MSG_TOKENS * CHARS_PER_TOKEN) / 46 | 0)}`;
}

function assistantText(i: number): string {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
    return `assistant reply ${i}: ${filler.repeat((MSG_TOKENS * CHARS_PER_TOKEN) / 50 | 0)}`;
}

type GooglePart = { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name: string; args?: unknown; id?: string } };

function googleFrame(parts: GooglePart[], finishReason?: string, usage?: Record<string, number>): string {
    const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
    if (finishReason) candidate.finishReason = finishReason;
    const frame: Record<string, unknown> = { candidates: [candidate], modelVersion: "gemini-test" };
    if (usage) frame.usageMetadata = usage;
    return `data: ${JSON.stringify(frame)}\n\n`;
}

const USAGE = { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 1050 };

type RelayState = {
    upstreamReqs: { bytes: number; contents: number; body: string }[];
    compressCalls: number;
    failedCompressions: number;
    lastDemandBytes: number;
    sinceDemand: number;
    toolsInjected: number;
    systemForwarded: number;
    foldedReqs: number;
    shapeViolations: string[];
};

/** Narrows parsed JSON to an object for checked member access. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Gemini's request contract, to the depth the wire can violate it. The real
 *  API answers a violation with a generic `400 INVALID_ARGUMENT`, so the mock
 *  has to be the strict one: a nameless or mismatched `functionResponse`, an
 *  empty `parts` array, a repeated role, or a signature on a user part all
 *  make the whole request unusable — exactly what a lenient mock hides. */
function geminiShapeViolations(body: string): string[] {
    const problems: string[] = [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return ["body is not JSON"];
    }
    const root = asRecord(parsed);
    const contents = root && Array.isArray(root.contents) ? root.contents : undefined;
    if (!contents) return ["contents is not an array"];
    const callNames = new Set<string>();
    let previousRole: string | undefined;
    contents.forEach((entry, i) => {
        const content = asRecord(entry);
        if (!content) {
            problems.push(`content[${i}] is not an object`);
            return;
        }
        const role = typeof content.role === "string" ? content.role : "";
        if (role !== "user" && role !== "model") problems.push(`content[${i}] role=${JSON.stringify(content.role)}`);
        if (role === previousRole) problems.push(`content[${i}] repeats role ${role} — Gemini needs alternating roles`);
        previousRole = role;
        const parts = Array.isArray(content.parts) ? content.parts : undefined;
        if (!parts) {
            problems.push(`content[${i}] has no parts array`);
            return;
        }
        if (parts.length === 0) problems.push(`content[${i}] has an empty parts array`);
        parts.forEach((entry2, j) => {
            const part = asRecord(entry2);
            if (!part) {
                problems.push(`content[${i}].parts[${j}] is not an object`);
                return;
            }
            const payloads = ["text", "inlineData", "fileData", "functionCall", "functionResponse"].filter((k) => k in part);
            if (payloads.length === 0) problems.push(`content[${i}].parts[${j}] carries no payload`);
            if (part.thoughtSignature !== undefined && role !== "model") problems.push(`content[${i}].parts[${j}] carries a thoughtSignature on a ${role} part`);
            const call = asRecord(part.functionCall);
            if (call) {
                if (typeof call.name !== "string" || call.name.length === 0) problems.push(`content[${i}].parts[${j}] functionCall without a name`);
                else callNames.add(call.name);
            }
            const response = asRecord(part.functionResponse);
            if (response) {
                if (typeof response.name !== "string" || response.name.length === 0) problems.push(`content[${i}].parts[${j}] functionResponse without a name`);
                else if (!callNames.has(response.name)) problems.push(`content[${i}].parts[${j}] functionResponse name=${response.name} answers no call (calls seen: ${[...callNames].join(",") || "none"})`);
                if (asRecord(response.response) === undefined) problems.push(`content[${i}].parts[${j}] functionResponse.response is not an object`);
            }
        });
    });
    return problems;
}

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

/** Mock Gemini upstream: SSE frames in the real shape, demanding a `compress`
 *  function call whenever the replayed payload has grown past the threshold. */
function startMockGemini(state: RelayState, threshold: number = LIVE_BYTES_THRESHOLD): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const bytes = Buffer.byteLength(body);
            let contents = 0;
            try {
                const parsed = JSON.parse(body) as { contents?: unknown[] };
                contents = Array.isArray(parsed.contents) ? parsed.contents.length : 0;
            } catch {
                contents = 0;
            }
            for (const problem of geminiShapeViolations(body)) state.shapeViolations.push(`req ${state.upstreamReqs.length + 1}: ${problem}`);
            if (body.includes("Compression FAILED")) state.failedCompressions++;
            if (body.includes('"functionDeclarations"') && body.includes('"compress"')) state.toolsInjected++;
            if (body.includes("you are a test assistant")) state.systemForwarded++;
            if (body.includes(SUMMARY_TEXT)) state.foldedReqs++;
            state.upstreamReqs.push({ bytes, contents, body });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const refIds = parseRefIds(body);
            state.sinceDemand++;
            const noShrinkAfterDemand = state.sinceDemand <= 2 && bytes >= state.lastDemandBytes * 0.9;
            const shouldCompress = bytes > threshold && refIds.length >= 12 && !noShrinkAfterDemand;
            if (shouldCompress) {
                state.lastDemandBytes = bytes;
                state.sinceDemand = 0;
                state.compressCalls++;
                const callId = `fc_compress_${state.compressCalls}`;
                res.write(
                    googleFrame([
                        {
                            functionCall: {
                                id: callId,
                                name: "compress",
                                args: {
                                    content: [
                                        {
                                            startId: refIds[2]!,
                                            endId: refIds[refIds.length - 10]!,
                                            topic: "google grow compress e2e",
                                            summary: `${SUMMARY_TEXT} — ${refIds[2]!}..${refIds[refIds.length - 10]!}`,
                                        },
                                    ],
                                },
                            },
                        },
                    ]),
                );
                res.write(googleFrame([], "STOP", USAGE));
            } else {
                res.write(googleFrame([{ text: assistantText(state.upstreamReqs.length) }]));
                res.write(googleFrame([], "STOP", USAGE));
            }
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

/** Client-side view of the Gemini SSE stream: text parts plus the terminal marker
 *  the omp client requires (it throws when a stream ends without a finishReason). */
function readGoogleStream(raw: string): { text: string; finishReasons: string[]; toolCalls: string[] } {
    let text = "";
    const finishReasons: string[] = [];
    const toolCalls: string[] = [];
    for (const block of raw.split("\n\n")) {
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev: { candidates?: { content?: { parts?: GooglePart[] }; finishReason?: string }[] };
        try {
            ev = JSON.parse(line.slice(5).trim()) as typeof ev;
        } catch {
            continue;
        }
        for (const cand of ev.candidates ?? []) {
            for (const part of cand.content?.parts ?? []) {
                if (typeof part.text === "string" && part.thought !== true) text += part.text;
            }
            for (const part of cand.content?.parts ?? []) {
                if (part.functionCall?.name) toolCalls.push(part.functionCall.name);
            }
            if (typeof cand.finishReason === "string") finishReasons.push(cand.finishReason);
        }
    }
    return { text, finishReasons, toolCalls };
}

function proxyOptions(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gemini-test": { context: 1_000_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 800,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
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
}

type TurnResult = { text: string; finishReasons: string[] };

/** Drives TURNS turns of a growing Gemini conversation against the proxy. */
async function runConversation(url: string, headers: Record<string, string>, state: RelayState): Promise<{ clientBytes: number; replies: TurnResult[] }> {
    const contents: { role: string; parts: GooglePart[] }[] = [];
    const replies: TurnResult[] = [];
    for (let i = 1; i <= TURNS; i++) {
        contents.push({ role: "user", parts: [{ text: userText(i) }] });
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: "you are a test assistant" }] }, generationConfig: { maxOutputTokens: 4096 } }),
        });
        if (!res.ok) assert.fail(`turn ${i}: HTTP ${res.status}: ${await res.text()}`);
        let raw = "";
        for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
        const view = readGoogleStream(raw);
        replies.push({ text: view.text, finishReasons: view.finishReasons });
        contents.push({ role: "model", parts: [{ text: view.text }] });
    }
    return { clientBytes: Buffer.byteLength(JSON.stringify({ contents })), replies };
}

test("e2e google: session-identified Gemini stream compresses and keeps the upstream payload bounded", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressCalls: 0, failedCompressions: 0, lastDemandBytes: Infinity, sinceDemand: 99, toolsInjected: 0, systemForwarded: 0, foldedReqs: 0, shapeViolations: [] };
    const upstream = startMockGemini(state);
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`;

    try {
        const { clientBytes, replies } = await runConversation(url, { "x-acp-session": "google-grow-1" }, state);
        const maxUpstreamBytes = Math.max(...state.upstreamReqs.map((r) => r.bytes));
        const maxContents = Math.max(...state.upstreamReqs.map((r) => r.contents));

        // A compress cycle costs an extra upstream round-trip (the model answers
        // the compress call, the proxy re-requests), so the count sits above TURNS.
        assert.ok(state.upstreamReqs.length >= TURNS, `expected at least one upstream request per turn, got ${state.upstreamReqs.length}`);
        assert.ok(state.upstreamReqs.length < TURNS * 2, `compress rounds must not spiral (${state.upstreamReqs.length} requests for ${TURNS} turns)`);
        assert.equal(state.failedCompressions, 0, "compress tool calls must not fail");
        assert.equal(state.shapeViolations.length, 0, `every rebuilt Gemini request must satisfy the API contract: ${state.shapeViolations.slice(0, 4).join(" | ")}`);
        assert.equal(state.toolsInjected, state.upstreamReqs.length, "the ACP tool declarations must be injected on every request");
        assert.equal(state.systemForwarded, state.upstreamReqs.length, "the client's systemInstruction must survive every rebuild");
        assert.ok(state.compressCalls >= 2, `expected >= 2 compress cycles, got ${state.compressCalls}`);
        assert.ok(state.foldedReqs >= 1, "the folded summary must reach the upstream on a later turn");
        for (const [i, reply] of replies.entries()) {
            assert.ok(reply.text.length > 0, `turn ${i + 1}: the model reply must not be empty`);
            assert.ok(reply.finishReasons.includes("STOP"), `turn ${i + 1}: the client must see a finishReason (omp throws without one)`);
        }
        assert.ok(maxUpstreamBytes < LIVE_BYTES_THRESHOLD * 2, `upstream body must stay bounded (max ${maxUpstreamBytes}B vs threshold ${LIVE_BYTES_THRESHOLD}B)`);
        assert.ok(maxContents < TURNS, `upstream contents must stay below the client history (max ${maxContents} vs ${TURNS} turns)`);
        assert.ok(clientBytes > maxUpstreamBytes * 2, `client history (${clientBytes}B) should far exceed the max upstream body (${maxUpstreamBytes}B)`);
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("e2e google: an anonymous Gemini client (no headers, omp's shape) attaches by prefix affinity and still compresses", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressCalls: 0, failedCompressions: 0, lastDemandBytes: Infinity, sinceDemand: 99, toolsInjected: 0, systemForwarded: 0, foldedReqs: 0, shapeViolations: [] };
    const upstream = startMockGemini(state);
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`;

    try {
        const { replies } = await runConversation(url, {}, state);
        assert.ok(state.upstreamReqs.length >= TURNS && state.upstreamReqs.length < TURNS * 2, `request count must reflect the compress rounds (${state.upstreamReqs.length} for ${TURNS} turns)`);
        assert.equal(state.failedCompressions, 0, "compress tool calls must not fail");
        assert.equal(state.shapeViolations.length, 0, `every rebuilt Gemini request must satisfy the API contract: ${state.shapeViolations.slice(0, 4).join(" | ")}`);
        assert.ok(state.compressCalls >= 2, `expected >= 2 compress cycles without any client identity signal, got ${state.compressCalls}`);
        for (const [i, reply] of replies.entries()) {
            assert.ok(reply.text.length > 0, `turn ${i + 1}: the model reply must not be empty`);
            assert.ok(reply.finishReasons.includes("STOP"), `turn ${i + 1}: the client must see a finishReason`);
        }
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

const PLUGIN_TURNS = 8;

test("e2e google: plugin mode (omp) keeps the agent's tool call, credits usage and ends the stream cleanly", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressCalls: 0, failedCompressions: 0, lastDemandBytes: Infinity, sinceDemand: 99, toolsInjected: 0, systemForwarded: 0, foldedReqs: 0, shapeViolations: [] };
    const upstream = startMockGemini(state, 2 * 1024);
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`;

    const headers = { "x-bili-plugin": "omp", "x-bili-plugin-conversation": "omp-gemini-1" };
    const contents: { role: string; parts: GooglePart[] }[] = [];
    try {
        for (let i = 1; i <= PLUGIN_TURNS; i++) {
            contents.push({ role: "user", parts: [{ text: userText(i) }] });
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 4096 } }),
            });
            if (!res.ok) assert.fail(`turn ${i}: HTTP ${res.status}: ${await res.text()}`);
            let raw = "";
            for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
            const view = readGoogleStream(raw);
            // #721 contract on the Gemini wire: a stream that delivered its
            // finishReason must NOT be reported to the agent as truncated.
            assert.ok(!raw.includes("upstream stream truncated"), `turn ${i}: no spurious truncation signal`);
            assert.ok(!/"error"\s*:/.test(raw), `turn ${i}: no in-band error frame`);
            assert.ok(view.finishReasons.includes("STOP"), `turn ${i}: terminal finishReason must reach the agent`);
            if (view.toolCalls.includes("compress")) {
                // plugin mode: the agent owns compression, so the proxy must hand
                // the call through instead of executing it.
                state.compressCalls++;
                assert.ok(!state.upstreamReqs.some((r) => r.body.includes(SUMMARY_TEXT)), "the proxy must not fold a plugin-owned tool call");
            }
            contents.push({ role: "model", parts: [{ text: view.text }] });
        }

        assert.ok(state.compressCalls >= 1, "the agent's compress call must reach the client");
        // Plugin mode suppresses wire tool injection: the agent registered the
        // ACP tools host-side, so the upstream never sees them.
        assert.equal(state.toolsInjected, 0, "plugin mode must not inject ACP tools into the wire body");
        assert.equal(state.failedCompressions, 0, "no compress failure marker");
        assert.equal(state.shapeViolations.length, 0, `plugin-mode bodies must satisfy the API contract too: ${state.shapeViolations.slice(0, 4).join(" | ")}`);
        // Usage sniffing is what keeps lastInputTokens (and therefore the nudge)
        // alive on this wire: the mock always reports promptTokenCount=1000.
        const googleSession = listSessions().find((s) => s.meta.protocol === "google");
        assert.ok(googleSession, "a google session must exist");
        assert.equal(googleSession.stats.lastInputTokens, 1000, "usageMetadata must be credited to the session");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});


test("e2e google: a non-streaming generateContent turn stays JSON, passes the reply through and rebuilds the request", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const calls: { body: string }[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            calls.push({ body: Buffer.concat(chunks).toString("utf8") });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                candidates: [{ content: { role: "model", parts: [{ text: "non-streaming reply" }] }, finishReason: "STOP", index: 0 }],
                usageMetadata: USAGE,
                modelVersion: "gemini-test",
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:generateContent`;

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "google-nonstream-1" },
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: userText(1) }] }],
                systemInstruction: { parts: [{ text: "you are a test assistant" }] },
                generationConfig: { maxOutputTokens: 4096 },
            }),
        });
        assert.ok(res.headers.get("content-type")?.includes("application/json"), "a non-streaming Gemini turn must stay JSON");
        const body = (await res.json()) as { candidates?: { content?: { parts?: GooglePart[] }; finishReason?: string }[] };
        assert.equal(body.candidates?.[0]?.content?.parts?.[0]?.text, "non-streaming reply", "the reply must pass through unchanged");
        assert.equal(body.candidates?.[0]?.finishReason, "STOP", "the finishReason must survive the rewrite");
        assert.equal(calls.length, 1, "exactly one upstream request");
        assert.ok(calls[0]!.body.includes("you are a test assistant"), "the client systemInstruction must survive the rebuild");
        assert.ok(calls[0]!.body.includes('"functionDeclarations"') && calls[0]!.body.includes('"compress"'), "the ACP tools must be injected on the non-streaming path");
        const session = listSessions().find((s) => s.meta.protocol === "google");
        assert.ok(session, "a google session must exist");
        assert.equal(session.stats.lastInputTokens, 1000, "usageMetadata must be credited on the non-streaming path");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
