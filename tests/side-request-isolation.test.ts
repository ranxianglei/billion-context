import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig, createInitialState, defaultCountTokens } from "acp-kernel";
import { startServer, type ProxyOptions, isSideRequest, outputBudgetField, restoreOutputBudget, sideRequestGuard } from "../src/server.ts";
import { estimateRawBodyTokens } from "../src/preflight.ts";
import { inspectContextOverflow } from "../src/util.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";

// #388: side requests (title-gen / small utility calls) share the main session
// key but must not touch kernel state. The proxy routes them as pure passthrough
// (no processTurn / snapshot / usage capture) so the main session's view, nudge
// baseline and per-block survivedCount are driven ONLY by main requests.

test("isSideRequest: tiny output budget across protocol field names", () => {
    assert.equal(isSideRequest({ max_tokens: 100 }), true);
    assert.equal(isSideRequest({ max_tokens: 200 }), true, "boundary 200 is a side request");
    assert.equal(isSideRequest({ max_tokens: 201 }), false, "201 is NOT a side request");
    assert.equal(isSideRequest({ max_completion_tokens: 150 }), true, "openai max_completion_tokens");
    assert.equal(isSideRequest({ max_output_tokens: 50 }), true, "responses max_output_tokens");
    assert.equal(isSideRequest({ max_tokens: 8192 }), false, "normal budget is not a side request");
    assert.equal(isSideRequest({}), false, "no budget → not a side request");
    assert.equal(isSideRequest(null), false, "null body");
    assert.equal(isSideRequest(undefined), false, "undefined body");
    assert.equal(isSideRequest("not-an-object"), false, "non-object body");
    assert.equal(isSideRequest({ max_tokens: 0 }), false, "zero budget");
    assert.equal(isSideRequest({ max_tokens: -5 }), false, "negative budget");
    assert.equal(isSideRequest({ max_tokens: "100" }), false, "string budget is not a number");
    assert.equal(isSideRequest({ max_tokens: 100, tools: [{ name: "compress" }] }), false, "#546: tool-carrying request is a MAIN turn even with a starved budget");
    assert.equal(isSideRequest({ max_tokens: 100, tools: [] }), true, "empty tools array does not rescue a tiny budget");
    assert.equal(isSideRequest({ max_output_tokens: 16, tools: [{ type: "function", function: { name: "f" } }] }), false, "#546: responses wire, starved budget + tools → main");
});

const noopLog = (): void => {};

function metaSession(id: string): { id: string; metadata: Record<string, unknown> } {
    return { id, metadata: {} };
}

test("outputBudgetField: first positive numeric field wins (#546)", () => {
    assert.equal(outputBudgetField({ max_tokens: 5 }), "max_tokens");
    assert.equal(outputBudgetField({ max_completion_tokens: 5 }), "max_completion_tokens");
    assert.equal(outputBudgetField({ max_output_tokens: 5 }), "max_output_tokens");
    assert.equal(outputBudgetField({ max_tokens: 0, max_completion_tokens: 7 }), "max_completion_tokens", "zero/negative fields skipped");
    assert.equal(outputBudgetField({ max_tokens: "16" }), null, "string budget ignored");
    assert.equal(outputBudgetField({}), null);
    assert.equal(outputBudgetField(null), null);
});

test("restoreOutputBudget: high-water learning + starved-budget restore (#546)", () => {
    const s = metaSession("hw");
    // Healthy request → learns the high-water (last non-starved value wins).
    restoreOutputBudget({ max_tokens: 32768 }, s, noopLog);
    assert.equal(s.metadata.outputBudgetHighWater, 32768);
    // Starved main request (tools present) → restored to the high-water.
    const starved = { max_tokens: 16, tools: [{ name: "compress" }] } as { max_tokens: number; tools: unknown[] };
    restoreOutputBudget(starved, s, noopLog);
    assert.equal(starved.max_tokens, 32768, "starved budget restored to high-water");
    // No high-water yet + starved + tools → nothing to restore to, untouched.
    const fresh = metaSession("fresh");
    const noWater = { max_tokens: 16, tools: [{ name: "compress" }] };
    restoreOutputBudget(noWater, fresh, noopLog);
    assert.equal(noWater.max_tokens, 16);
    // Side request (tiny budget, NO tools) → never touched, stays a side req.
    const side = { max_tokens: 100 };
    restoreOutputBudget(side, s, noopLog);
    assert.equal(side.max_tokens, 100, "side request budget must not be restored");
    assert.equal(isSideRequest(side), true);
    // High-water re-learns downward on a new healthy budget (config change).
    restoreOutputBudget({ max_tokens: 8000 }, s, noopLog);
    assert.equal(s.metadata.outputBudgetHighWater, 8000, "last non-starved value wins");
    const starved2 = { max_tokens: 200, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(starved2, s, noopLog);
    assert.equal(starved2.max_tokens, 8000, "boundary 200 restored too (isSideRequest would misfire without tools)");
    // Field-name fidelity: restore writes the SAME field the client used.
    const s2 = metaSession("hw2");
    restoreOutputBudget({ max_output_tokens: 32689 }, s2, noopLog);
    const responsesStarved = { max_output_tokens: 1, tools: [{ type: "function" }] } as { max_output_tokens: number };
    restoreOutputBudget(responsesStarved, s2, noopLog);
    assert.equal(responsesStarved.max_output_tokens, 32689, "responses field restored on the same field");
});

const MODEL = "claude-sonnet-4-5";
const SESSION = "side-iso-sess";
const MAIN_INPUT_TOKENS = 50_000;
const SIDE_INPUT_TOKENS = 56;

test("estimateRawBodyTokens: counts string leaves, skips binary-carrying keys (#554)", () => {
    const txt = "z".repeat(800);
    const body = { model: MODEL, max_tokens: 100, messages: [{ role: "user", content: txt }] };
    assert.equal(
        estimateRawBodyTokens(body),
        defaultCountTokens(MODEL) + defaultCountTokens("user") + defaultCountTokens(txt),
        "every counted string leaf goes through the CJK-aware estimator",
    );
    // Binary-carrying fields are excluded (image-tokens charges them separately).
    const data = "A".repeat(8000);
    const imgBody = { model: MODEL, max_tokens: 100, messages: [{ role: "user", content: [
        { type: "text", text: txt },
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
    ] }] };
    assert.equal(
        estimateRawBodyTokens(imgBody),
        defaultCountTokens(MODEL) + defaultCountTokens("user")
        + defaultCountTokens("text") + defaultCountTokens(txt)
        + defaultCountTokens("image") + defaultCountTokens("base64") + defaultCountTokens("image/png"),
        "data field excluded, structural strings still counted",
    );
    assert.equal(estimateRawBodyTokens({ url: "http://x/y".repeat(1000) }), 0, "url field excluded");
    assert.equal(estimateRawBodyTokens({ b64_json: "A".repeat(10_000) }), 0, "b64_json field excluded");
    assert.equal(estimateRawBodyTokens(null), 0, "null body");
    assert.equal(estimateRawBodyTokens(42), 0, "non-object body");
    // CJK must not be undercounted by the chars/4 fast path.
    assert.ok(estimateRawBodyTokens({ content: "汉".repeat(100) }) >= 100, "CJK counted per-char");
});

test("inspectContextOverflow: exceed_context_size_error pattern + (A / B > W) window parse (#554)", () => {
    const llama = JSON.stringify({ error: { message: "exceed_context_size_error (198,277 / 198,661 > 150,528)" } });
    const hit = inspectContextOverflow(400, llama);
    assert.equal(hit.isOverflow, true, "llama.cpp-family marker recognized");
    assert.equal(hit.window, 150_528, "window is the limit after '>' inside the parens, not A or B");
    assert.equal(inspectContextOverflow(200, llama).isOverflow, false, "status gate: 200 is not an overflow");
    assert.equal(inspectContextOverflow(418, llama).isOverflow, false, "status gate: only 400/413 count");
    // Existing markers still work (regression).
    assert.equal(inspectContextOverflow(400, JSON.stringify({ error: { message: "context_length_exceeded" } })).isOverflow, true);
    const openai = inspectContextOverflow(400, JSON.stringify({ error: { message: "maximum context length is 131072 tokens" } }));
    assert.equal(openai.isOverflow, true);
    assert.equal(openai.window, 131_072);
});

test("sideRequestGuard: raw-body fit against resolved ∩ learned window minus output headroom (#554)", () => {
    const txt = "z".repeat(8000);
    const body = { model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: txt }] };
    const est = estimateRawBodyTokens(body);
    assert.ok(est > 0);
    assert.equal(sideRequestGuard(body, "anthropic", 0, undefined).blocked, false, "unknown window → forward as before");
    assert.equal(sideRequestGuard(body, "anthropic", est + 1, undefined).blocked, false, "fits");
    assert.equal(sideRequestGuard(body, "anthropic", est, undefined).blocked, true, "boundary: estimate == limit blocks");
    assert.equal(sideRequestGuard(body, "anthropic", 1_000_000, est - 1).blocked, true, "learned smaller → blocks");
    assert.equal(sideRequestGuard(body, "anthropic", est + 1, 1_000_000).blocked, false, "learned larger than resolved is ignored");
    // OpenAI wire: the output budget counts against the window → headroom reserved.
    const oa = { model: MODEL, max_completion_tokens: 2_000, stream: true, messages: [{ role: "user", content: txt }] };
    const oaEst = estimateRawBodyTokens(oa);
    const g = sideRequestGuard(oa, "openai", oaEst + 2_000, undefined);
    assert.equal(g.limit, oaEst, "limit reduced by max_completion_tokens");
    assert.equal(g.blocked, true, "boundary after reservation blocks");
    assert.equal(sideRequestGuard(oa, "openai", oaEst + 2_001, undefined).blocked, false);
    // Image tokens count toward the estimate.
    const imgBody = { model: MODEL, max_tokens: 100, messages: [{ role: "user", content: [
        { type: "text", text: "z".repeat(4000) },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(8000) } },
    ] }] };
    const imgEst = estimateRawBodyTokens(imgBody) + Math.ceil(8000 / 4);
    assert.equal(sideRequestGuard(imgBody, "anthropic", imgEst, undefined).blocked, true, "image cost included at boundary");
});

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function mainConversation(n: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Main message ${i} ${"z".repeat(500)}` });
    }
    return msgs;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    /** When set, served verbatim for side requests (max_tokens<=200) instead
     *  of the generated okSse stream. */
    sideScript: string | null;
    /** Last request body received by the upstream (for wire assertions). */
    lastBody: Record<string, unknown> | null;
    /** Total requests received by the upstream (hit-count assertions). */
    upstreamHits: number;
    /** When set, side requests get this status + JSON body instead of okSse. */
    sideErrorStatus: number | null;
    sideErrorBody: string | null;
}

// modelContextLimit alone is NOT enough to shrink the effective window: per-
// request resolution re-resolves it from the registry/static table (claude-
// sonnet-4-5 → 200k) unless the operator explicitly tunes
// compress.modelContextLimit, which outranks everything (#344). The rig exposes
// both so tests can pin the exact window the guard sees.
async function startRig(opts?: { modelContextLimit?: number; compressModelContextLimit?: number }): Promise<Rig> {
    const modelContextLimit = opts?.modelContextLimit ?? 200_000;
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: null as unknown as http.Server, upstream: null as unknown as http.Server, sideScript: null, lastBody: null, upstreamHits: 0, sideErrorStatus: null, sideErrorBody: null };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { max_tokens?: number } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            rig.lastBody = parsed as Record<string, unknown>;
            rig.upstreamHits++;
            // Side requests (tiny max_tokens) report a TINY context; main requests
            // report a large one. The proxy must NOT capture the side request's
            // usage — that is exactly the pollution this regression guards.
            const isSide = typeof parsed.max_tokens === "number" && parsed.max_tokens <= 200;
            if (isSide && rig.sideErrorStatus !== null) {
                res.writeHead(rig.sideErrorStatus, { "content-type": "application/json" });
                res.end(rig.sideErrorBody ?? "{}");
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(isSide && rig.sideScript ? rig.sideScript : okSse(isSide ? SIDE_INPUT_TOKENS : MAIN_INPUT_TOKENS));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port as number;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit,
        kernelConfig: defaultConfig(modelContextLimit),
        compress: { injectTool: true, injectNudge: true, ...(opts?.compressModelContextLimit !== undefined ? { modelContextLimit: opts.compressModelContextLimit } : {}) },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port as number;
    rig.proxy = proxy; rig.upstream = upstream; rig.proxyPort = proxyPort; rig.upstreamPort = upstreamPort;
    return rig;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("e2e: side request response still gets render-tag stripping (#460 contract)", async () => {
    const LT = "\x3c";
    const GT = "\x3e";
    const OPEN_MARK = `${LT}acp `;
    const CLOSE_MARK = `${LT}/acp${GT}`;
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };
        // Main request first so the session has a real view.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        await r1.text();
        const stateAfterMain = JSON.stringify(getSession(SESSION).state);
        // Side request whose stream echoes a render tag (a model echoing the
        // compressed history into a title). The strip pipes must still run for
        // side requests — kernel state untouched, response hygiene intact.
        const tagged = `title: ${LT}acp tokens="12" type="text"${GT}m00009${LT}/acp${GT}ok`;
        const sse =
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: SIDE_INPUT_TOKENS } } })}\n\n` +
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tagged } })}\n\n` +
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
        rig.sideScript = sse;
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "Generate a short title." }] }) });
        assert.equal(r2.status, 200);
        let raw = "";
        for await (const chunk of r2.body) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(raw.includes(OPEN_MARK), false, "side-request stream leaked a render open tag");
        assert.equal(raw.includes(CLOSE_MARK), false, "side-request stream leaked a render close tag");
        assert.equal(JSON.stringify(getSession(SESSION).state), stateAfterMain, "tag-strip pipe must not touch kernel state (session stays off)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: anthropic side request (title-gen) leaves main session kernel state untouched", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // Main request 1: a normal turn (large max_tokens) → kernel state mutates.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();

        const s1 = getSession(SESSION);
        assert.ok(s1, "session exists after the main request");
        assert.notEqual(JSON.stringify(s1.state), JSON.stringify(createInitialState()), "main request must mutate kernel state");
        assert.ok(Object.keys(s1.state.messageRefs.byRaw).length > 0, "refs assigned to the main messages");
        assert.equal(s1.stats.lastInputTokens, MAIN_INPUT_TOKENS, "main request usage captured as the nudge baseline");
        assert.ok(s1.lastMessages && s1.lastMessages.length > 0, "message snapshot set to the main request view");

        const stateAfterMain1 = JSON.stringify(s1.state);
        const statsAfterMain1 = JSON.stringify(s1.stats);
        const snapshotAfterMain1 = JSON.stringify(s1.lastMessages);
        const requestsAfterMain1 = s1.stats.requests;

        // Side request: title-gen (tiny max_tokens) on the SAME session key.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "Generate a short title for this conversation." }] }) });
        assert.equal(r2.status, 200);
        await r2.text();

        const s2 = getSession(SESSION);
        assert.ok(s2, "session still exists after the side request");
        assert.equal(JSON.stringify(s2.state), stateAfterMain1, "side request must NOT mutate kernel state (refs / survivedCount / nudge baseline)");
        assert.equal(JSON.stringify(s2.stats), statsAfterMain1, "side request must NOT mutate stats");
        assert.equal(JSON.stringify(s2.lastMessages), snapshotAfterMain1, "side request must NOT clobber the message snapshot (bili export view)");
        assert.equal(s2.stats.lastInputTokens, MAIN_INPUT_TOKENS, "side request's tiny usage must NOT overwrite the main nudge baseline");
        assert.equal(s2.stats.requests, requestsAfterMain1, "side request must NOT increment the main request counter");

        // Main request 2: a normal turn again → kernel state advances (monotonic).
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(9) }) });
        assert.equal(r3.status, 200);
        await r3.text();

        const s3 = getSession(SESSION);
        assert.ok(s3, "session exists after main request 2");
        assert.notEqual(JSON.stringify(s3.state), stateAfterMain1, "main request 2 must advance kernel state (driven only by main requests)");
        assert.ok(s3.stats.requests > requestsAfterMain1, "main request 2 increments the request counter");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: starved tool-carrying main request re-enters pipeline at restored budget (#546)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };
        const tools = [{ name: "compress", description: "compress", input_schema: { type: "object", properties: {} } }];

        // Healthy main turn WITH tools: teaches the session its output budget.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, tools, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = getSession(SESSION);
        const requestsAfterMain1 = s1.stats.requests;
        assert.equal(s1.metadata.outputBudgetHighWater, 1024, "high-water learned from the healthy main turn");

        // Death-spiral turn: the client shrank the budget to 16 tokens off its
        // raw-history estimate. The request still carries tools → it is a MAIN
        // turn: the pipeline must run (no side passthrough) and the budget must
        // reach the upstream restored to the high-water.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 16, stream: true, tools, messages: mainConversation(9) }) });
        assert.equal(r2.status, 200);
        await r2.text();
        const s2 = getSession(SESSION);
        assert.ok(s2.stats.requests > requestsAfterMain1, "starved main turn must go through the pipeline, not side passthrough");
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 1024, "upstream received the restored budget (#546)");

        // A real side request (no tools, tiny budget) on the same session stays
        // a pure passthrough: budget NOT restored, kernel untouched.
        const stateBeforeSide = JSON.stringify(s2.state);
        const statsBeforeSide = JSON.stringify(s2.stats);
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "short title" }] }) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 100, "side request budget untouched");
        const s3 = getSession(SESSION);
        assert.equal(JSON.stringify(s3.state), stateBeforeSide, "side request left kernel state untouched");
        assert.equal(JSON.stringify(s3.stats), statsBeforeSide, "side request left stats untouched");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: oversized side request is blocked locally (413), never reaches the upstream (#554)", async () => {
    const rig = await startRig({ modelContextLimit: 4_000, compressModelContextLimit: 4_000 });
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // ~40 × ~130 tokens ≈ 5k+ > 4_000 window → guaranteed upstream 400 if forwarded.
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: mainConversation(40) }) });
        assert.equal(r.status, 413);
        const j = (await r.json()) as { error: { type: string; code: string; retryable: boolean; message: string } };
        assert.equal(j.error.type, "server_error");
        assert.equal(j.error.code, "side_request_payload_too_large");
        assert.equal(j.error.retryable, false);
        assert.match(j.error.message, /NOT forwarded/);
        assert.equal(rig.upstreamHits, 0, "oversized side request must NOT reach the upstream");

        // A fitting side request on the same rig still passes through verbatim.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "Generate a short title." }] }) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(rig.upstreamHits, 1, "fitting side request reaches the upstream");
        assert.equal(rig.lastBody?.max_tokens, 100, "body untouched (verbatim passthrough preserved)");

        const s = getSession(SESSION);
        assert.ok(s, "session row exists (created before the gate)");
        assert.equal(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state untouched by side requests (blocked or not)");
        assert.equal(s.stats.requests, 0, "side requests do not count as main requests");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: overflow 400 on a side request learns the real window; next one is blocked locally (#554)", async () => {
    const rig = await startRig(); // 200_000 configured window
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // ~1200 × ~130 ≈ 155k tokens: below the 200k configured window (so the
        // first attempt forwards) but above the real 150,528 window the upstream
        // reports in its overflow marker.
        const big = mainConversation(1200);
        rig.sideErrorStatus = 400;
        rig.sideErrorBody = JSON.stringify({ error: { message: "exceed_context_size_error (198,277 / 198,661 > 150,528)" } });

        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r1.status, 400, "first overflow surfaces to the client");
        await r1.text();
        const s1 = getSession(SESSION);
        assert.ok(s1);
        assert.equal((s1.metadata.learnedContextLimits as Record<string, number>)[MODEL], 150_528, "real window learned from the overflow marker");
        assert.equal(s1.stats.lastInputTokens, 150_528, "emergency shrink armed at the learned window");

        // Identical second request: now blocked locally — no second upstream hit.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r2.status, 413);
        const j = (await r2.json()) as { error: { code: string } };
        assert.equal(j.error.code, "side_request_payload_too_large");
        assert.equal(rig.upstreamHits, 1, "second oversized side request must NOT reach the upstream again");
        assert.equal(JSON.stringify(getSession(SESSION).state), JSON.stringify(createInitialState()), "kernel state untouched throughout");
    } finally {
        await closeRig(rig);
    }
});
