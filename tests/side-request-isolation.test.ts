import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig, createInitialState, defaultCountTokens } from "acp-kernel";
import { startServer, type ProxyOptions, isSideRequest, outputBudgetField, restoreOutputBudget, sideRequestGuard } from "../src/server.ts";
import { estimateRawBodyTokens } from "../src/preflight.ts";
import { inspectContextOverflow } from "../src/util.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

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

test("isSideRequest: host-declared side-request agent outranks the token-budget heuristic (#1699)", () => {
    // opencode v2 title-gen carries NO max_tokens (options {} for kind==="title"),
    // so the budget path can never see it. Declaring the persona by intent fixes
    // the misclassification without touching any request that omits max_tokens.
    const noBudget = { messages: [{ role: "user", content: "Generate a short title." }] };
    assert.equal(isSideRequest(noBudget, "title"), true, "#1699: no-budget title request is a side req by intent");
    assert.equal(isSideRequest(noBudget), false, "same body WITHOUT the agent id stays non-side (no regression)");
    // Intent outranks even the #546 tool-carrying main-turn guard (title-gen never
    // carries tools; if it did, the host's explicit declaration wins).
    assert.equal(isSideRequest({ max_tokens: 100, tools: [{ name: "compress" }] }, "title"), true, "#1699: intent beats the tools heuristic");
    // A MAIN persona is never a side request — real turns keep compression.
    assert.equal(isSideRequest({ max_tokens: 5000 }, "build"), false, "main persona with a normal budget is not a side req");
    assert.equal(isSideRequest({}, "build"), false, "main persona without a budget is not a side req");
    // An unknown persona id is inert — falls back to the token-budget heuristic.
    assert.equal(isSideRequest({}, "unknown-persona"), false, "unknown persona does not grant side status");
    assert.equal(isSideRequest({ max_tokens: 100 }, "unknown-persona"), true, "unknown persona still honors a tiny budget");
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

test("restoreOutputBudget: configured-output-limit floor for poisoned or missing high-water (#1665)", () => {
    // Death spiral: the client decays through small positive values before
    // starving completely — the water mark ends up holding a death rattle.
    const s = metaSession("poison");
    restoreOutputBudget({ max_tokens: 384000 }, s, noopLog);
    restoreOutputBudget({ max_tokens: 680 }, s, noopLog);
    restoreOutputBudget({ max_tokens: 234 }, s, noopLog);
    assert.equal(s.metadata.outputBudgetHighWater, 234, "last non-starved value wins (decay tracked)");
    const starved = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(starved, s, noopLog, 384000);
    assert.equal(starved.max_tokens, 384000, "death-rattle water mark floored by the configured output limit");
    // A healthy water mark above the floor keeps winning (client intent beats declaration).
    const s2 = metaSession("healthy");
    restoreOutputBudget({ max_tokens: 500000 }, s2, noopLog);
    const starved2 = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(starved2, s2, noopLog, 384000);
    assert.equal(starved2.max_tokens, 500000, "water mark above the floor untouched");
    // Born-dead session: the first request bili ever sees is already starved.
    const s3 = metaSession("borndead");
    const bornDead = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(bornDead, s3, noopLog, 32768);
    assert.equal(bornDead.max_tokens, 32768, "missing water mark falls back to the configured limit");
    // No configured limit → old behavior: nothing to restore to.
    const s4 = metaSession("nofloor");
    const noFloor = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(noFloor, s4, noopLog);
    assert.equal(noFloor.max_tokens, 1, "undefined configured limit leaves the request untouched");
    // A limit at/below the side threshold is not a usable floor.
    const s5 = metaSession("tinyfloor");
    restoreOutputBudget({ max_tokens: 234 }, s5, noopLog);
    const tinyFloor = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(tinyFloor, s5, noopLog, 200);
    assert.equal(tinyFloor.max_tokens, 234, "limit <= 200 cannot floor");
    // Side requests (no tools) never receive the floor.
    const side = { max_tokens: 100 } as { max_tokens: number };
    restoreOutputBudget(side, s3, noopLog, 32768);
    assert.equal(side.max_tokens, 100, "side request untouched even with a floor available");
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
    assert.equal(estimateRawBodyTokens({ file_data: "data:application/pdf;base64,".padEnd(10_000, "A") }), 0, "file_data data-URL excluded");
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

test("sideRequestGuard: raw-body fit against declared ∩ armed window minus output headroom (#554)", () => {
    const txt = "z".repeat(8000);
    const body = { model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: txt }] };
    const est = estimateRawBodyTokens(body);
    assert.ok(est > 0);
    assert.equal(sideRequestGuard(body, "anthropic", 0, undefined, 1).blocked, false, "unknown window → forward as before");
    assert.equal(sideRequestGuard(body, "anthropic", est + 1, undefined, 1).blocked, false, "fits");
    assert.equal(sideRequestGuard(body, "anthropic", Math.floor(est / 1.15), undefined, 1).blocked, true, "boundary: estimate == limit x 1.15 blocks");
    assert.equal(sideRequestGuard(body, "anthropic", Math.floor(est / 1.10), undefined, 1).blocked, false, "within the 15% estimator tolerance → forward");
    assert.equal(sideRequestGuard(body, "anthropic", 1_000_000, undefined, 1, Math.floor(est / 1.15)).blocked, true, "armed smaller (beyond tolerance) → blocks");
    assert.equal(sideRequestGuard(body, "anthropic", est + 1, undefined, 1, 1_000_000).blocked, false, "armed larger than declared is ignored");
    // OpenAI wire: the output budget counts against the window → headroom reserved.
    const oa = { model: MODEL, max_completion_tokens: 2_000, stream: true, messages: [{ role: "user", content: txt }] };
    const oaEst = estimateRawBodyTokens(oa);
    const oaLimit = Math.floor(oaEst / 1.15);
    const g = sideRequestGuard(oa, "openai", oaLimit + 2_000, undefined, 1);
    assert.equal(g.limit, oaLimit, "limit reduced by max_completion_tokens");
    assert.equal(g.blocked, true, "boundary after reservation (with tolerance) blocks");
    assert.equal(sideRequestGuard(oa, "openai", oaEst + 2_001, undefined, 1).blocked, false);
    // Image tokens count toward the estimate.
    const imgBody = { model: MODEL, max_tokens: 100, messages: [{ role: "user", content: [
        { type: "text", text: "z".repeat(4000) },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(8000) } },
    ] }] };
    const imgEst = estimateRawBodyTokens(imgBody) + Math.ceil(8000 / 4);
    assert.equal(sideRequestGuard(imgBody, "anthropic", Math.floor(imgEst / 1.15), undefined, 1).blocked, true, "image cost included at boundary");
    // CJK estimator bias: defaultCountTokens counts CJK per-char (~1.6x real),
    // so a CJK-heavy payload estimated at ~110% of the window must forward —
    // the upstream's real overflow 400 arms the evidence that blocks re-sends.
    const cjkBody = { model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "汉".repeat(4000) }] };
    const cjkEst = estimateRawBodyTokens(cjkBody);
    assert.ok(cjkEst >= 4000, "CJK counted per-char");
    assert.equal(sideRequestGuard(cjkBody, "anthropic", Math.floor(cjkEst / 1.10), undefined, 1).blocked, false, "CJK over-estimation absorbed by tolerance");
    assert.equal(sideRequestGuard(cjkBody, "anthropic", Math.floor(cjkEst / 1.20), undefined, 1).blocked, true, "genuinely oversized CJK still blocks");
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
async function startRig(opts?: { modelContextLimit?: number; compressModelContextLimit?: number; store?: SessionStore; routeModels?: Record<string, { context?: number; output?: number }> }): Promise<Rig> {
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

    _setStoreForTest(opts?.store ?? new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: opts?.routeModels ? { models: opts.routeModels } : {} },
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

test("e2e: opencode v2 title-gen is classified by intent, not token budget (#1699)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const baseHeaders: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": SESSION,
            "x-bili-plugin": "opencode",
            "x-bili-plugin-conversation": SESSION,
        };
        // The exact opencode v2 title-gen shape that triggered the bug: one short
        // instruction, NO max_tokens (options {} for kind==="title").
        const titleBody = { model: MODEL, stream: true, messages: [{ role: "user", content: "Generate a short title for this conversation." }] };

        // Repro (pre-fix behavior): WITHOUT x-bili-plugin-agent the budget heuristic
        // sees no max_tokens → defaults to 8192 → NOT a side request → treated as a
        // main turn, so the compress philosophy prompt + render tags get injected.
        const rControl = await fetch(url, { method: "POST", headers: baseHeaders, body: JSON.stringify(titleBody) });
        assert.equal(rControl.status, 200);
        await rControl.text();
        const controlFwd = rig.lastBody as { messages?: unknown } | null;
        assert.ok(controlFwd, "control: upstream received the request");
        assert.notDeepEqual(controlFwd?.messages, titleBody.messages, "control: without the agent header the title request is misclassified as a main turn and its messages are rewritten");
        assert.ok(JSON.stringify(controlFwd ?? {}).length > JSON.stringify(titleBody).length + 1000, "control: the compress philosophy prompt inflated the forwarded payload (the reported ~11KiB injection)");

        // Fix: WITH x-bili-plugin-agent=title the request is a side request by
        // intent and is forwarded VERBATIM — its messages arrive byte-identical,
        // nothing injected, kernel state untouched.
        const rFix = await fetch(url, { method: "POST", headers: { ...baseHeaders, "x-bili-plugin-agent": "title" }, body: JSON.stringify(titleBody) });
        assert.equal(rFix.status, 200);
        await rFix.text();
        const fixFwd = rig.lastBody as { messages?: unknown } | null;
        assert.ok(fixFwd, "fix: upstream received the request");
        assert.deepEqual(fixFwd?.messages, titleBody.messages, "fix: title-gen messages forwarded verbatim (no compress prompt/render tags injected)");
    } finally {
        await closeRig(rig);
    }
});

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

test("e2e: starved main request with a poisoned high-water is floored by the configured output limit (#1665)", async () => {
    const rig = await startRig({ routeModels: { [MODEL]: { output: 4096 } } });
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };
        const tools = [{ name: "compress", description: "compress", input_schema: { type: "object", properties: {} } }];

        // First request bili sees for this session is already mid-death-spiral:
        // the client's raw-history estimate decayed its budget to 234 (>200, so it
        // seeds the water mark) — without the floor every later starved turn would
        // restore 234 forever.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 234, stream: true, tools, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(getSession(SESSION).metadata.outputBudgetHighWater, 234, "poisoned water mark seeded from the decaying client");

        // Fully starved now: the configured output limit must floor the restore.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1, stream: true, tools, messages: mainConversation(9) }) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 4096, "configured output limit floors the poisoned restore (#1665)");
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

test("e2e: overflow 400 on a side request arms the stated window; next one is blocked locally (#554)", async () => {
    const rig = await startRig(); // 200_000 configured window
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // ~1200 × ~130 ≈ 155k tokens: below the 200k configured window (so the
        // first attempt forwards) but above the real 120,000 window the upstream
        // reports in its overflow marker. #987: the marker's number is no longer
        // LEARNED, but it arms the one-shot evidence at 120k — enough for the
        // guard to block the second attempt locally.
        const big = mainConversation(1200);
        rig.sideErrorStatus = 400;
        rig.sideErrorBody = JSON.stringify({ error: { message: "exceed_context_size_error (198,277 / 198,661 > 120,000)" } });

        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r1.status, 400, "first overflow surfaces to the client");
        await r1.text();
        const s1 = getSession(SESSION);
        assert.ok(s1);
        assert.equal(s1.metadata.confirmedContextLimits, undefined, "#987: no window learned");
        assert.equal(s1.stats.lastInputTokens, 120_000, "emergency shrink armed at the stated window");

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

test("e2e: healthy host baseline must NOT clamp an unrelated side request (#1110)", async () => {
    const rig = await startRig(); // declared window 200_000
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // Host conversation active and healthy: one normal main turn whose real
        // usage lands at MAIN_INPUT_TOKENS (50k) → nudge baseline 50k, source
        // "usage". NO overflow ever happened, so there is NO overflow arm.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();

        const s1 = getSession(SESSION);
        assert.ok(s1, "session exists after the main turn");
        assert.equal(s1.stats.lastInputTokens, MAIN_INPUT_TOKENS, "healthy host turn sets the nudge baseline");
        assert.equal(s1.stats.lastInputTokensSource, "usage", "baseline provenance is a real usage report");
        assert.equal(s1.stats.overflowArmTokens, undefined, "#1110: no overflow occurred → no arm");

        // An UNRELATED in-process caller's fixed-size request (the MemOS shape):
        // no tools, tiny output budget → a side request, but its raw body (~90k
        // tokens) exceeds the host's 50k baseline × 1.15 while still fitting the
        // model's real 200k window. Pre-#1110 the guard clamped the effective
        // window to that 50k baseline and 413'd this permanently; post-fix it
        // must forward verbatim.
        const bigSideContent = "z".repeat(360_000);
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: bigSideContent }] }) });
        assert.equal(r2.status, 200, "#1110: unrelated side request that fits the real window must forward, not be 413'd by the host baseline");
        await r2.text();
        assert.ok(rig.upstreamHits >= 2, "the unrelated side request reached the upstream");

        // Side passthrough left the host baseline and kernel state untouched.
        assert.equal(getSession(SESSION).stats.lastInputTokens, MAIN_INPUT_TOKENS, "side request did not clobber the host baseline");
        assert.equal(getSession(SESSION).stats.overflowArmTokens, undefined, "#1110: a forwarded (non-overflow) side request must not mint an arm");
    } finally {
        await closeRig(rig);
    }
});

// #1129: the RELEASE direction of the one-shot overflow arm. #554/#1110 pin
// the ARMING direction (overflow 400 → next oversized side request 413s
// locally); nothing pinned that a REAL usage report on a later main turn
// retires the arm so the side request forwards again. The release rests on
// paired `delete session.stats.overflowArmTokens` writes (streaming
// src/loop/core.ts, non-streaming src/server.ts, plugin src/plugin.ts, plus
// resetSessionCompression) — a refactor that mis-gates any of them would
// 413 side requests permanently: the #1110 deadlock re-entered through the
// overflow path.
test("e2e: real usage report RETIRES the overflow arm — the blocked side request forwards again (#1129)", async () => {
    const rig = await startRig(); // declared window 200_000
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // 1) ARM — same shape as the #554 arm test: ~155k payload fits the
        //    declared 200k window (first attempt forwards) but exceeds the real
        //    120,000 the upstream states in its overflow marker.
        const big = mainConversation(1200);
        rig.sideErrorStatus = 400;
        rig.sideErrorBody = JSON.stringify({ error: { message: "exceed_context_size_error (198,277 / 198,661 > 120,000)" } });
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r1.status, 400, "first overflow surfaces to the client");
        await r1.text();
        const s1 = getSession(SESSION);
        assert.ok(s1);
        assert.equal(s1.stats.overflowArmTokens, 120_000, "arm recorded separately from the nudge baseline (#1110)");

        // 2) Armed → identical side request is blocked locally, no upstream hit.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r2.status, 413);
        await r2.text();
        assert.equal(rig.upstreamHits, 1, "armed guard blocks without a second upstream hit");

        // 3) RELEASE — one healthy MAIN turn streams a real usage report. The
        //    streaming recordUsage path (src/loop/core.ts) must delete the arm
        //    alongside the lastInputTokens = "usage" write.
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r3.status, 200);
        await r3.text();
        const s3 = getSession(SESSION);
        assert.equal(s3.stats.lastInputTokens, MAIN_INPUT_TOKENS, "main turn resets the nudge baseline");
        assert.equal(s3.stats.lastInputTokensSource, "usage", "release provenance is a real usage report");
        assert.equal(s3.stats.overflowArmTokens, undefined, "#1129: a real usage report retires the one-shot arm");

        // 4) The SAME oversized-but-fits-declared-window side request forwards
        //    again — the released arm must not linger as a permanent clamp.
        rig.sideErrorStatus = null;
        const r4 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r4.status, 200, "#1129: released arm lets the side request through again");
        await r4.text();
        assert.equal(rig.upstreamHits, 3, "overflow + main + resent side request — nothing else hit the upstream");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: the overflow arm survives a restart round-trip; usage after reload releases it (#1129)", async () => {
    // Restart shape: armed session flushed to disk, memory cleared, a FRESH
    // store instance over the same dir (process restart). The arm must still
    // block locally after reload, and a real usage report must still release it.
    const dir = mkdtempSync(join(tmpdir(), "bili-side-arm-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    let store2: SessionStore | null = null;
    const rig = await startRig({ store });
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // ARM: overflow 400 → arm at the stated 120k.
        const big = mainConversation(1200);
        rig.sideErrorStatus = 400;
        rig.sideErrorBody = JSON.stringify({ error: { message: "exceed_context_size_error (198,277 / 198,661 > 120,000)" } });
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r1.status, 400);
        await r1.text();
        assert.equal(getSession(SESSION).stats.overflowArmTokens, 120_000, "armed in memory");

        // Flush the armed session to disk (the arm path markDirty'd it; force
        // the debounce so the restart has something to reload).
        await store.flushAll();

        // RESTART: clear memory, swap in a fresh store over the same dir.
        _resetSessionsForTest();
        store2 = new SessionStore({ dir, debounceMs: 5, enabled: true });
        _setStoreForTest(store2);

        // Still blocked after the round-trip: the reload path (memory miss →
        // store.loadSync) must restore the arm, and the guard must honor it.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r2.status, 413, "arm survives the restart round-trip and still blocks locally");
        await r2.text();
        assert.equal(rig.upstreamHits, 1, "no upstream hit for the post-restart block");
        const s2 = getSession(SESSION);
        assert.equal(s2.stats.overflowArmTokens, 120_000, "reloaded session carries the armed window");

        // RELEASE after restart: a healthy main turn's real usage retires it.
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(getSession(SESSION).stats.overflowArmTokens, undefined, "usage report releases the reloaded arm too");

        // Forwards again.
        rig.sideErrorStatus = null;
        const r4 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r4.status, 200, "released after restart — side request forwards again");
        await r4.text();
        assert.equal(rig.upstreamHits, 3);
    } finally {
        await closeRig(rig);
        store.cancelAll();
        store2?.cancelAll();
        rmrf(dir);
    }
});
