import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig, createInitialState } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { isStructuredOutputCall, isSideRequest, resolveSideLane } from "../src/server/side-request.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";

// #5073: on the Hermes lane a child process (the Hindsight memory daemon, other
// memory plugins, evaluators, terminal scripts) inherits the host's HTTP_PROXY /
// HTTPS_PROXY env vars and sends TOOLLESS chat completions that ask for STRUCTURED
// output (response_format json_object/json_schema). Pre-fix those were classified
// as main turns, so bili's proxy-mode injection put the six ACP tools next to
// response_format — a strict backend (PolyStrata) rejects that pair outright with
// HTTP 400 ("structured response_format with tools/MCP is not supported") and the
// caller fails every call. Post-fix the structural shape rides the #388 verbatim
// side passthrough: nothing injected, the backend sees the clean toolless body it
// sent, and its budget never seeds the main session's output-budget high-water.
//
// The no-tools veto is load-bearing: any action surface marks an agent turn, and
// the #546 rule keeps every tool-carrying request a main turn (control A below).

const MODEL = "qwopus3.6-35b-a3b-coder-mtp-q4_k_m";
const SESSION = "hermes-hindsight-side-sess";
// Hindsight's fact-extraction calls carry a large output budget (64000 in the
// report); main-turn real usage sits HIGH (160K, below the 200K window) so a
// side sample far below it can only matter if it leaks into the baseline.
const SIDE_MAX_TOKENS = 64_000;
const MAIN_INPUT_TOKENS = 160_000;
const SIDE_INPUT_TOKENS = 90_000;

function structuredBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: MODEL,
        stream: true,
        max_tokens: SIDE_MAX_TOKENS,
        messages: [{ role: "system", content: "extract" }, { role: "user", content: "hi" }],
        response_format: { type: "json_object" },
        ...over,
    };
}

test("isStructuredOutputCall: positives — both documented carriers, toolless", () => {
    // OpenAI chat-completions carrier: top-level response_format { type }.
    assert.equal(isStructuredOutputCall(structuredBody()), true, "response_format json_object");
    assert.equal(isStructuredOutputCall(structuredBody({ response_format: { type: "json_schema", json_schema: { name: "facts" } } })), true, "response_format json_schema");
    assert.equal(isStructuredOutputCall(structuredBody({ tools: [] })), true, "empty tools array is still toolless");
    // Responses-wire carrier: text.format { type }.
    assert.equal(isStructuredOutputCall({ model: MODEL, text: { format: { type: "json_object" } }, input: [{ role: "user", content: "hi" }] }), true, "responses text.format json_object");
    assert.equal(isStructuredOutputCall({ model: MODEL, text: { format: { type: "json_schema", schema: {} } }, input: [{ role: "user", content: "hi" }] }), true, "responses text.format json_schema");
});

test("isStructuredOutputCall: negatives — every veto keeps the request on the main pipeline", () => {
    assert.equal(isStructuredOutputCall(null), false, "null body");
    assert.equal(isStructuredOutputCall({}), false, "empty body");
    // Any action surface marks an agent turn, not a one-shot utility call.
    assert.equal(isStructuredOutputCall(structuredBody({ tools: [{ type: "function", function: { name: "get_weather" } }] })), false, "a client tool vetoes (the #546 rule owns it)");
    assert.equal(isStructuredOutputCall(structuredBody({ tools: [{ name: "compress", description: "c", input_schema: { type: "object", properties: {} } }] })), false, "a leaked bili/compress tool vetoes");
    // Only the two documented carriers with the two structured types match.
    assert.equal(isStructuredOutputCall(structuredBody({ response_format: "json_object" })), false, "legacy bare-string response_format never matches");
    assert.equal(isStructuredOutputCall(structuredBody({ response_format: { type: "text" } })), false, "non-structured type (text) does not match");
    assert.equal(isStructuredOutputCall(structuredBody({ response_format: null })), false, "null response_format does not match");
    assert.equal(isStructuredOutputCall(structuredBody({ response_format: {} })), false, "response_format object without a string type does not match");
    // Gemini's carrier is deliberately out of scope (no strict backend rejects
    // tools + generationConfig.responseMimeType) — matching it would demote turns.
    assert.equal(isStructuredOutputCall({ model: MODEL, generationConfig: { responseMimeType: "application/json" }, contents: [{ role: "user", parts: [{ text: "hi" }] }] }), false, "Gemini generationConfig.responseMimeType never matches");
    // Responses-wire negatives.
    assert.equal(isStructuredOutputCall({ model: MODEL, text: { format: { type: "text" } }, input: [{ role: "user", content: "hi" }] }), false, "responses text.format with a non-structured type does not match");
    assert.equal(isStructuredOutputCall({ model: MODEL, text: { format: "json_object" }, input: [{ role: "user", content: "hi" }] }), false, "responses text.format as a bare string does not match");
    assert.equal(isStructuredOutputCall({ model: MODEL, text: "json_object", input: [{ role: "user", content: "hi" }] }), false, "text itself is not an object");
    assert.equal(isStructuredOutputCall({ model: MODEL, text: { format: { type: "json_object" } } }), true, "responses carrier needs no top-level message array");
});

test("isSideRequest: the structured shape is a side request; intent and #546 still outrank it", () => {
    const body = structuredBody();
    assert.equal(isSideRequest(body), true, "a toolless structured-output request is a side request despite its large budget");
    assert.equal(isSideRequest(body, "main"), false, "explicit main intent vetoes the structure");
    assert.equal(isSideRequest(body, "title"), true, "declared side agent stays side");
    // The old rules are untouched for everything the structure does not claim.
    assert.equal(isSideRequest({ max_tokens: 100 }), true, "tiny-budget heuristic intact");
    assert.equal(isSideRequest({ max_tokens: 1024 }), false, "a toolless NON-structured large-budget request stays a main turn (scoping proof)");
    assert.equal(isSideRequest(structuredBody({ tools: [{ name: "compress" }] })), false, "#546 veto intact: a tool-carrying structured request stays a main turn");
});

test("resolveSideLane: the #5073 label names the structured-output shape in the log line", () => {
    assert.equal(
        resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "openai", stripApplied: false, sideIntent: true, requestAgent: undefined, sideLabel: "structured-output utility call (#5073)" }).reason,
        "structured-output utility call (#5073)",
    );
    // Without a label the historical reason strings stay byte-stable.
    assert.equal(
        resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "openai", stripApplied: false, sideIntent: true, requestAgent: undefined }).reason,
        "max_tokens<=200",
    );
});

function mainConversation(n: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Main message ${i} ${"z".repeat(500)}` });
    }
    return msgs;
}

function openaiSse(inputTokens: number): string {
    const base = { id: "chatcmpl-5073", object: "chat.completion.chunk", created: 1, model: MODEL };
    return (
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: 3, total_tokens: inputTokens + 3 } })}\n\n` +
        `data: [DONE]\n\n`
    );
}

/** A request carrying a structured-output carrier (the side-request signature). */
function isStructuredShape(b: Record<string, unknown>): boolean {
    const rf = b.response_format;
    if (rf !== null && typeof rf === "object" && typeof (rf as { type?: unknown }).type === "string") return true;
    const text = b.text;
    if (text !== null && typeof text === "object" && typeof ((text as { format?: unknown }).format ?? {}) === "object") return true;
    return false;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    /** Last request body received by the upstream (for wire assertions). */
    lastBody: Record<string, unknown> | null;
    /** Total requests received by the upstream. */
    upstreamHits: number;
}

async function startRig(): Promise<Rig> {
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: null as unknown as http.Server, upstream: null as unknown as http.Server, lastBody: null, upstreamHits: 0 };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            rig.lastBody = parsed;
            rig.upstreamHits++;
            // Structured (side) requests report a TINY context; main requests a
            // large one. The proxy must NOT capture the side request's usage.
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(openaiSse(isStructuredShape(parsed) ? SIDE_INPUT_TOKENS : MAIN_INPUT_TOKENS));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        proxy: "",
        proxyFallback: { explicitDirect: true, globalSource: "direct" },
        auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    rig.proxy = proxy; rig.upstream = upstream; rig.proxyPort = proxyPort; rig.upstreamPort = upstreamPort;
    return rig;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

test("e2e: a toolless structured-output request rides the side passthrough — verbatim forward, no injection, no high-water poison (#5073)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // Main turn 1: a normal turn whose REAL usage lands at 160K (high, below
        // the 200K window) → the nudge baseline the side sample would poison.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = getSession(SESSION);
        assert.ok(s1, "session exists after the main request");
        assert.notEqual(JSON.stringify(s1.state), JSON.stringify(createInitialState()), "main request must mutate kernel state");
        assert.equal(s1.stats.lastInputTokens, MAIN_INPUT_TOKENS, "main usage captured as the nudge baseline");
        assert.equal(s1.metadata.outputBudgetHighWater, 1024, "high-water learned from the healthy main turn");

        const stateAfterMain = JSON.stringify(s1.state);
        const statsAfterMain = JSON.stringify(s1.stats);
        const snapshotAfterMain = JSON.stringify(s1.lastMessages);
        const requestsAfterMain = s1.stats.requests;
        const nudgeRefAfterMain = s1.state.nudge.lastPerMessageNudgeTokens;

        // The Hindsight fact-extraction shape on the SAME session key: toolless +
        // response_format json_object + a large budget. Pre-fix this was a main
        // turn (tools injected next to response_format → strict backend 400).
        const body = structuredBody();
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r2.status, 200);
        await r2.text();

        // Verbatim forward: response_format/messages/budget untouched, NOTHING
        // injected — the backend sees the clean toolless body it sent.
        const fwd = rig.lastBody;
        assert.ok(fwd, "upstream received the structured request");
        assert.deepEqual(fwd!.response_format, body.response_format, "response_format forwarded verbatim");
        assert.deepEqual(fwd!.messages, body.messages, "messages forwarded verbatim (no prompt/render tags injected)");
        assert.equal(fwd!.max_tokens, SIDE_MAX_TOKENS, "utility-call budget must NOT be mutated by restoreOutputBudget");
        assert.equal(fwd!.tools, undefined, "no bili ACP tools injected next to response_format (the reported 400)");

        // Kernel state, stats, snapshot, counter and high-water all untouched.
        const s2 = getSession(SESSION);
        assert.ok(s2, "session still exists after the structured request");
        assert.equal(JSON.stringify(s2.state), stateAfterMain, "structured request must NOT mutate kernel state");
        assert.equal(s2.state.nudge.lastPerMessageNudgeTokens, nudgeRefAfterMain, "nudge reference untouched by the structured usage sample");
        assert.equal(JSON.stringify(s2.stats), statsAfterMain, "structured request must NOT mutate stats");
        assert.equal(s2.stats.lastInputTokens, MAIN_INPUT_TOKENS, "the structured request's 90K usage must NOT replace the main 160K baseline");
        assert.equal(JSON.stringify(s2.lastMessages), snapshotAfterMain, "structured request must NOT clobber the message snapshot");
        assert.equal(s2.stats.requests, requestsAfterMain, "structured request must NOT increment the main request counter");
        assert.equal(s2.metadata.outputBudgetHighWater, 1024, "the structured request's 64K budget must NOT seed the high-water");

        // Main turn 2: the pipeline still works after the structured request.
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(9) }) });
        assert.equal(r3.status, 200);
        await r3.text();
        const s3 = getSession(SESSION);
        assert.ok(s3.stats.requests > requestsAfterMain, "main turn 2 increments the request counter");
        assert.notEqual(JSON.stringify(s3.state), stateAfterMain, "main turn 2 advances kernel state");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: a TOOL-CARRYING structured request stays a main turn — #546 veto holds, injection still happens (#5073 control A)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": `${SESSION}-control-a` };

        // An agent turn that happens to ask for structured output: it carries its
        // own action surface, so the #546 rule keeps it a main turn (isStructured
        // OutputCall's no-tools gate vetoes it) and bili still injects its tools.
        const body: Record<string, unknown> = {
            model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(3),
            tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
            response_format: { type: "json_object" },
        };
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const s = getSession(`${SESSION}-control-a`);
        assert.ok(s, "session exists after the control request");
        assert.ok(s.stats.requests >= 1, "a tool-carrying structured request must go through the pipeline, not the side passthrough");
        assert.notEqual(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state must advance for the control request");
        const fwd = rig.lastBody;
        assert.ok(fwd, "upstream received the control request");
        // Sent exactly ONE client tool; a verbatim side forward would echo back
        // exactly one. More than one proves the #546 rule kept it a main turn and
        // bili appended its ACP tools on top of the client's action surface.
        assert.ok(Array.isArray(fwd!.tools) && fwd!.tools.length > 1, "#546 veto holds: a tool-carrying structured request stays a main turn and bili still injects its ACP tools");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: a toolless NON-structured large-budget request stays a main turn — scoping proof, injection still happens (#5073 control B)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": `${SESSION}-control-b` };

        // Same large budget as the Hindsight call but WITHOUT a structured-output
        // carrier: the fix must NOT demote this — it is not the reported shape,
        // and injecting tools into a plain completion is harmless (no 400 pair).
        const body: Record<string, unknown> = { model: MODEL, max_tokens: SIDE_MAX_TOKENS, stream: true, messages: mainConversation(3) };
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const s = getSession(`${SESSION}-control-b`);
        assert.ok(s, "session exists after the control request");
        assert.ok(s.stats.requests >= 1, "a toolless NON-structured large-budget request must go through the pipeline, not the side passthrough (the fix is scoped to structured output)");
        const fwd = rig.lastBody;
        assert.ok(fwd, "upstream received the control request");
        // Sent NO tools; a verbatim side forward would leave the tools key absent.
        // A populated tools array proves this plain completion stayed a main turn
        // (the fix is scoped to structured output only, not all toolless requests).
        assert.ok(Array.isArray(fwd!.tools) && fwd!.tools.length >= 1, "proxy-mode tool injection is unchanged for a plain completion (no tools sent → bili ACP tools present)");
    } finally {
        await closeRig(rig);
    }
});
