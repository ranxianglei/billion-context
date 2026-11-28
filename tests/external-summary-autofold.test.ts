import { strict as assert } from "node:assert";
import test, { afterEach, beforeEach } from "node:test";

import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { startServer, type ProxyOptions } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

/** Anthropomorphic main upstream: records request bodies, answers SSE ok. */
function startMainUpstream(): Promise<{ server: http.Server; url: string; bodies: unknown[] }> {
    return new Promise((resolve) => {
        const bodies: unknown[] = [];
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* ignore */ }
                res.writeHead(200, { "content-type": "text/event-stream" });
                // Honest-enough usage: a large (~36-pair) body bills 42000
                // tokens so the usage-baseline pressure band (>= 75% of the
                // 50K window) can warm up over two turns; small bodies bill
                // 1000 to keep every other meter cold.
                const billed = Buffer.concat(chunks).toString("utf8").length > 100_000 ? 42_000 : 1_000;
                res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":${billed}}}}\n\n`);
                res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`);
                res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
                res.end();
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }));
    });
}

/** External summary upstream: records calls, answers a valid openai summary JSON. */
function startSummaryUpstream(mode: "ok" | "fail"): Promise<{ server: http.Server; url: string; bodies: unknown[] }> {
    return new Promise((resolve) => {
        const bodies: unknown[] = [];
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* ignore */ }
                if (mode === "fail") {
                    res.writeHead(500, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "boom" }));
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { content: "SUMMARY: the user read system docs about wifi, ups, and gpu drivers; key facts retained." }, finish_reason: "stop" }] }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }));
    });
}

function bigConversation(pairs = 12): unknown[] {
    const filler = "0123456789abcdef".repeat(280); // ~4.5KB ≈ 1.1K tokens per message
    const messages: unknown[] = [];
    for (let i = 0; i < pairs; i++) {
        messages.push({ role: "user", content: [{ type: "text", text: `doc chunk ${i}: ${filler}` }] });
        messages.push({ role: "assistant", content: [{ type: "text", text: `ack ${i}` }] });
    }
    messages.push({ role: "user", content: [{ type: "text", text: "final question" }] });
    return messages;
}

// Route through the zero-config /bili/<upstream>/ prefix so the routes table
// entry declared in startServer matches (window source=configured): a bare
// /v1/messages request misses the table, falls back to the option-level
// window, and reads as fallback-derived — where the #282 floor lifts any
// reserved sub-100K window to 100K and dilutes the pressure bands these tests
// exercise (#4205).
async function postTurn(port: number, upstreamUrl: string, session: string, pairs = 12): Promise<{ status: number; body: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/bili/${upstreamUrl}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": "k",
            "anthropic-version": "2023-06-01",
            "x-acp-session": session,
        },
        body: JSON.stringify({ model: "test-model", max_tokens: 1024, stream: true, messages: bigConversation(pairs) }),
    });
    const body = await res.text();
    return { status: res.status, body };
}

/** Flexible turn sender for #3444 fixtures that need a top-level `system`
 *  prompt or a custom final message (the irreducible-baseline shapes). */
async function postRaw(port: number, session: string, extra: Record<string, unknown>): Promise<{ status: number }> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": "k",
            "anthropic-version": "2023-06-01",
            "x-acp-session": session,
        },
        body: JSON.stringify({ model: "test-model", max_tokens: 1024, stream: true, ...extra }),
    });
    await res.text();
    return { status: res.status };
}

/** ~60KB of system prompt ≈ 15K tokens — an irreducible baseline far above
 *  the 8192 growth target used by the #3444 fixtures. */
const BIG_SYSTEM = `policy doc: ${"0123456789abcdef".repeat(3700)}`;

const servers: { close: () => Promise<void> }[] = [];
function trackClose(server: http.Server): void {
    servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve(undefined))) });
}

beforeEach(() => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
});
afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
});

test("auto-fold fires below the window via the external chain, and the model sees no nudge", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    // ~40K tokens ≈ 82% of the reserved 48_976 judging window (#4205:
    // declared 50K − max_tokens 1024). On a first turn the growth gate
    // is idle by construction (growthSinceReference = 0), so the ONLY classic
    // nudge path at this size is the pressure band (usage >= 75%), which
    // bypasses the growth gate — the control arm in the "auto-fold off" test
    // proves a nudge WOULD fire here without auto-fold. The 8192 growth floor
    // owns the cadence instead.
    const turn = await postTurn(port, main.url, "autofold-1", 36);
    assert.equal(turn.status, 200);

    // The external chain did the folding (zero model involvement).
    assert.ok(sum.bodies.length >= 1, `expected external summary calls, got ${sum.bodies.length}`);

    // The forwarded history is folded…
    const forwarded = main.bodies.at(-1) as { messages?: { content?: unknown }[] };
    assert.ok(forwarded && Array.isArray(forwarded.messages), "main upstream received a body with messages");
    assert.ok(forwarded.messages.length < 45, `expected folded history, got ${forwarded.messages.length} messages`);
    const text = JSON.stringify(forwarded);
    // …and the nudge never reached the model even in the pressure band
    // (non-vacuous: the control arm below shows "Context breakdown:" DOES
    // reach the payload at this size when auto-fold is off).
    assert.ok(!text.includes("Context breakdown:"), "nudge leaked into the forwarded payload");

    // The folded block is tagged as external-chain work (compressCallId marker
    // → "⚡ext" in the panel), so preflight folds are observable as such.
    const status = await fetch(`http://127.0.0.1:${port}/__bili/plugin/status?conversationId=autofold-1`);
    assert.equal(status.status, 200, "panel status endpoint must answer for the folded session");
    const panel = ((await status.json()) as { panel?: string }).panel ?? "";
    assert.ok(panel.includes("⚡ext"), `panel should tag the external fold with ⚡ext, got:\n${panel}`);
});

test("auto-fold off: no growth fold below the window (growthArmed only when engaged)", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"] },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    const turn = await postTurn(port, main.url, "autofold-off");
    assert.equal(turn.status, 200);
    assert.equal(sum.bodies.length, 0, "external chain must not fold when autoFold is off and the payload fits the window");
    const forwarded = main.bodies.at(-1) as { messages?: unknown[] };
    assert.equal(forwarded.messages?.length, 25, "history must be forwarded intact");

    // Control arm for the "autofold-1" no-nudge assertion: same ~36-pair
    // size with auto-fold off. The usage meter is cold on turn 1 (usage=0%,
    // growth ref = self — a first-turn nudge is structurally impossible), so
    // turn 1 only warms the baseline via the stub's honest 42K bill; turn 2
    // sits at ≈86% usage (42_000 billed / 48_976 reserved) = pressure band,
    // where the classic cadence MUST
    // inject "Context breakdown:". That proves the first test's absence
    // assertion targets a live, firing cadence — not an always-idle one.
    const warm = await postTurn(port, main.url, "autofold-off-pressure", 36);
    assert.equal(warm.status, 200);
    assert.equal(sum.bodies.length, 0, "external chain stays idle below the window even in the pressure band");
    const pressure = await postTurn(port, main.url, "autofold-off-pressure", 36);
    assert.equal(pressure.status, 200);
    assert.equal(sum.bodies.length, 0, "classic nudges never call the external chain");
    const pressured = JSON.stringify(main.bodies.at(-1));
    assert.ok(pressured.includes("Context breakdown:"), "control arm: classic cadence nudges at ≈86% usage without auto-fold");
});

test("auto-fold fail-open: broken chain forwards the request instead of failing it", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("fail"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    const turn = await postTurn(port, main.url, "autofold-fail");
    assert.equal(turn.status, 200, "growth-fold failure must forward (fail-open), not fail the request");
    assert.ok(main.bodies.length >= 1, "payload reached the main upstream");
    const text = JSON.stringify(main.bodies.at(-1));
    assert.ok(text.includes("final question"), "forwarded payload kept the conversation tail");
});

test("auto-fold backoff: a failed growth fold arms a cooldown — the next turn skips external calls entirely", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("fail"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    // Turn 1: the chain is down — the growth fold fails, the request still
    // forwards (fail-open), and the failure arms the 10-minute backoff.
    const turn1 = await postTurn(port, main.url, "autofold-backoff");
    assert.equal(turn1.status, 200, "turn 1 must forward despite the failing chain");
    assert.ok(sum.bodies.length >= 1, `turn 1 attempted external summaries, got ${sum.bodies.length}`);

    // Turn 2 (same session, immediate — no clock dependency): the backoff
    // gate disengages auto-fold BEFORE any attempt, so the external chain is
    // never called again and the payload forwards raw.
    const attemptsAfterTurn1 = sum.bodies.length;
    const turn2 = await postTurn(port, main.url, "autofold-backoff");
    assert.equal(turn2.status, 200, "turn 2 must forward (backoff = skip, not fail)");
    assert.equal(sum.bodies.length, attemptsAfterTurn1, "backoff must skip external calls on the very next turn");
    const forwarded2 = main.bodies.at(-1) as { messages?: unknown[] };
    assert.equal(forwarded2.messages?.length, 25, "no fold happened on the backed-off turn");
    const text2 = JSON.stringify(forwarded2);
    assert.ok(text2.includes("final question"), "backed-off turn kept the conversation tail");
});

test("auto-fold backoff: a pure queue-drop (zero dispatched attempts) does NOT arm the cooldown — the next turn retries", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192, budget: { totalTimeoutMs: 500, targetTimeoutMs: 500, maxSummaryBytes: 64 * 1024 } },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    // Saturate the process-wide summary pool (the #2657 congestion shape):
    // four holders keep every permit busy well past the victim plan's 500ms
    // batch deadline, so the growth fold's batches die in the queue before a
    // single candidate call dispatches — attempts=[] with zero HTTP traffic.
    const { _executorForTest } = await import("../src/external-summary-runtime.ts");
    let releaseHolders!: () => void;
    const held = new Promise<string>((resolve) => { releaseHolders = () => resolve("held"); });
    let permitsOut = 0;
    let markSaturated!: () => void;
    const saturated = new Promise<void>((resolve) => { markSaturated = resolve; });
    const hold = () => _executorForTest.executeBatch(
        [{ content: "pool holder", instructions: "hold the permit" }],
        [{ summarize: () => {
            if (++permitsOut === 4) markSaturated();
            return held;
        } }],
        { totalTimeoutMs: 30_000, targetTimeoutMs: 20_000, maxSummaryBytes: 64 * 1024 });
    const holders = [hold(), hold(), hold(), hold()];
    try {
        await saturated;

        // Turn 1: every batch is dropped in the queue. The fold makes zero
        // progress, yet NOTHING was wrong with the chain — under the pre-#2662
        // policy this still armed the 10-minute cooldown.
        const turn1 = await postTurn(port, main.url, "autofold-qdrop", 36);
        assert.equal(turn1.status, 200, "queue-dropped fold must still forward (fail-open)");
        assert.equal(sum.bodies.length, 0, "pure queue-drop: no summary call may reach the endpoint at all");
        const forwarded1 = main.bodies.at(-1) as { messages?: unknown[] };
        assert.equal(forwarded1.messages?.length, 73, "nothing folded while every batch died in the queue");

        // The pool frees up: with NO cooldown armed, the very next turn
        // retries the chain and the fold lands.
        releaseHolders();
        await Promise.all(holders);
        const turn2 = await postTurn(port, main.url, "autofold-qdrop", 36);
        assert.equal(turn2.status, 200, "turn 2 must forward");
        assert.ok(sum.bodies.length >= 1, `backoff must NOT have armed on pure queue-drops; expected external calls on turn 2, got ${sum.bodies.length}`);
        const forwarded2 = main.bodies.at(-1) as { messages?: unknown[] };
        assert.ok(forwarded2.messages && forwarded2.messages.length < 73, `expected the fold to land once the pool freed, got ${forwarded2.messages?.length} messages`);
    } finally {
        releaseHolders();
        await Promise.all(holders); // release the shared pool for later tests
    }
});

// ---------------------------------------------------------------------------
// #3444: sub-floor targets must not storm (measured floor + benefit gate)
// ---------------------------------------------------------------------------

/** bigConversation with one extra ~4KB user pair spliced before the tail. */
function conversationWithExtraPair(pairs: number): unknown[] {
    const base = bigConversation(pairs) as unknown[];
    base.pop(); // drop the trailing "final question"
    base.push({ role: "user", content: [{ type: "text", text: `extra doc: ${"abcdef".repeat(667)}` }] });
    base.push({ role: "assistant", content: [{ type: "text", text: "ack extra" }] });
    base.push({ role: "user", content: [{ type: "text", text: "final question" }] });
    return base;
}

test("#3444 sub-floor target: an exhausted fold measures the irreducible floor — marginal growth stops re-folding", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    // The system prompt alone (~15K tokens) sits far above the 8192 target:
    // no fold can ever reach it. Pre-#3444 every turn re-fired the trigger
    // (payload >= target forever) and burned an external-summary round trip
    // for whatever sliver was foldable — the reported fold storm.
    const t1 = await postRaw(port, "autofold-floor", { system: BIG_SYSTEM, messages: bigConversation(12) });
    assert.equal(t1.status, 200, "turn 1 must forward");
    assert.ok(sum.bodies.length >= 1, `turn 1 must attempt the growth fold, got ${sum.bodies.length} summary calls`);
    const attemptsAfterTurn1 = sum.bodies.length;

    // Turn 2: same conversation plus one small extra pair (~1K tokens of real
    // growth past the measured floor). Payload is still far above the
    // CONFIGURED target 8192 — pre-#3444 this unconditionally re-ran the
    // chain. Now the effective target is the measured floor, so the expected
    // benefit (~1K) sits under the 4096-token cost bar: no new external calls.
    const t2 = await postRaw(port, "autofold-floor", { system: BIG_SYSTEM, messages: conversationWithExtraPair(12) });
    assert.equal(t2.status, 200, "turn 2 must forward");
    assert.equal(sum.bodies.length, attemptsAfterTurn1, "marginal growth past a sub-floor target must NOT re-run the external chain (fold storm)");
    const text2 = JSON.stringify(main.bodies.at(-1));
    assert.ok(text2.includes("SUMMARY:"), "the turn-1 fold must persist in the forwarded history");
});

test("#3444 sub-benefit fold: a round trip that saves less than its cost arms the backoff instead of repeating next turn", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    // Only ~3K tokens are foldable (three small pairs); the rest of the
    // payload is the live tail — one ~15K-token final user message that no
    // fold may touch. The trigger sees a large expected benefit and fires;
    // the actual pass saves ~3K < 4096 AUTO_FOLD_MIN_BENEFIT_TOKENS.
    const giantTail = bigConversation(3) as unknown[];
    giantTail.pop();
    giantTail.push({ role: "user", content: [{ type: "text", text: `giant paste: ${"0123456789abcdef".repeat(3750)}` }] });

    const t1 = await postRaw(port, "autofold-subbenefit", { messages: giantTail });
    assert.equal(t1.status, 200, "turn 1 must forward");
    assert.ok(sum.bodies.length >= 1, `turn 1 dispatched the fold attempt (proves the sub-benefit path, not zero-progress), got ${sum.bodies.length}`);
    const attemptsAfterTurn1 = sum.bodies.length;

    // Turn 2: identical payload, still far above the configured target. Pre-
    // #3444 the cheap pass repeated every turn; now the under-cost result
    // armed the 10-minute backoff, so the chain is skipped entirely.
    const t2 = await postRaw(port, "autofold-subbenefit", { messages: giantTail });
    assert.equal(t2.status, 200, "turn 2 must forward (backoff = skip, not fail)");
    assert.equal(sum.bodies.length, attemptsAfterTurn1, "a sub-benefit fold must arm the backoff — no repeat round trip next turn");
});

// ---------------------------------------------------------------------------
// growthFoldingArmed unit truth table (#2581 review fix #1)
// ---------------------------------------------------------------------------
test("growthFoldingArmed: only suppress classic nudges when growth folding can actually fire", async () => {
    const { growthFoldingArmed } = await import("../src/external-summary-surface.ts");
    const chain = (autoFold: boolean, target?: number) => ({
        externalSummary: { enabled: true, targets: ["sum/sm"], autoFold, ...(target !== undefined ? { autoFoldTargetTokens: target } : {}) },
        modelContextLimit: 50_000,
    });
    // sanity: the import resolved to a function
    assert.equal(typeof growthFoldingArmed, "function");
    // disabled chain / autoFold off / garbage config → false (never suppress)
    assert.equal(growthFoldingArmed(undefined), false);
    assert.equal(growthFoldingArmed({ modelContextLimit: 50_000 }), false);
    assert.equal(growthFoldingArmed(chain(false)), false);
    assert.equal(growthFoldingArmed({ garbage: true }), false);
    // no overflow resolvable (no window anywhere) → false
    assert.equal(growthFoldingArmed({ externalSummary: { enabled: true, autoFold: true } }), false);
    assert.equal(growthFoldingArmed({ externalSummary: { enabled: true, autoFold: true }, modelContextLimit: 0 }), false);
    // healthy window: implicit (half) and explicit targets arm
    assert.equal(growthFoldingArmed(chain(true)), true, "implicit round(overflow/2) target < window arms");
    assert.equal(growthFoldingArmed(chain(true, 8192)), true, "explicit 8192 target on 50K window arms");
    // degenerate: sub-MIN window clamps target up to the overflow → NOT armed
    assert.equal(growthFoldingArmed({ externalSummary: { enabled: true, autoFold: true }, modelContextLimit: 8192 }), false, "implicit target on 8192 window clamps to the window itself");
    assert.equal(growthFoldingArmed({ externalSummary: { enabled: true, autoFold: true, autoFoldTargetTokens: 10_000 }, modelContextLimit: 8192 }), false, "explicit target clamped to the window → not armed");
    assert.equal(growthFoldingArmed({ externalSummary: { enabled: true, autoFold: true, autoFoldTargetTokens: 50_000 }, modelContextLimit: 50_000 }), false, "target === window is a no-op → not armed");
    // codex lane bar: overflowTarget override is honored
    assert.equal(growthFoldingArmed(chain(true), 45_000), true, "0.9x codex bar on 50K window still leaves room");
    assert.equal(growthFoldingArmed({ externalSummary: { enabled: true, autoFold: true }, modelContextLimit: 20_000 }, 20_000), true, "bar with headroom above AUTO_FOLD_TARGET_MIN arms");
    assert.equal(growthFoldingArmed({ externalSummary: { enabled: true, autoFold: true }, modelContextLimit: 10_000 }, 8192), false, "bar exactly at AUTO_FOLD_TARGET_MIN clamps the implicit target up to the bar — not armed");
    assert.equal(growthFoldingArmed(chain(true, 4600), 4600), false, "explicit target clamped to at least MIN above the bar is a no-op");
    // #3444: the measured irreducible floor raises the effective target; at or
    // above the overflow bar the target is unreachable, so suppression must release.
    assert.equal(growthFoldingArmed(chain(true, 8192), undefined, 10_000), true, "floor 10K under the 50K window keeps arming (target raised to the floor)");
    assert.equal(growthFoldingArmed(chain(true, 8192), undefined, 50_000), false, "floor == window disarms (bar unreachable)");
    assert.equal(growthFoldingArmed(chain(true, 8192), undefined, 60_000), false, "floor above the window disarms");
    assert.equal(growthFoldingArmed(chain(true, 8192), 45_000, 46_000), false, "floor above the codex-lane bar disarms");
    assert.equal(growthFoldingArmed(chain(true, 8192), 45_000, 40_000), true, "floor below the codex-lane bar keeps arming");
});

test("autoFoldFloor: reads the measured floor from session metadata, rejecting invalid values", async () => {
    const { autoFoldFloor } = await import("../src/external-summary-surface.ts");
    assert.equal(autoFoldFloor(undefined), undefined);
    assert.equal(autoFoldFloor({}), undefined);
    assert.equal(autoFoldFloor({ metadata: {} }), undefined);
    assert.equal(autoFoldFloor({ metadata: { autoFoldFloorTokens: 42_000 } }), 42_000);
    assert.equal(autoFoldFloor({ metadata: { autoFoldFloorTokens: "42000" } }), undefined);
    assert.equal(autoFoldFloor({ metadata: { autoFoldFloorTokens: Number.NaN } }), undefined);
    assert.equal(autoFoldFloor({ metadata: { autoFoldFloorTokens: 0 } }), undefined);
    assert.equal(autoFoldFloor({ metadata: { autoFoldFloorTokens: -5 } }), undefined);
});

// ---------------------------------------------------------------------------
// e2e: degenerate growth configs must NOT suppress classic nudges (#2581 fix #1)
// ---------------------------------------------------------------------------
/** Main upstream that bills a flat token count (for tiny-window pressure bands). */
function startBilledUpstream(bill: number): Promise<{ server: http.Server; url: string; bodies: unknown[] }> {
    return new Promise((resolve) => {
        const bodies: unknown[] = [];
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* ignore */ }
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":${bill}}}}\n\n`);
                res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`);
                res.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
                res.end();
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }));
    });
}

test("degenerate sub-MIN growth window: classic nudges still fire (no silent suppression)", async () => {
    // window 8192 == AUTO_FOLD_TARGET_MIN: the implicit round(window/2) target
    // clamps up to the window itself, growth folding can never engage, and the
    // old `!autoFoldEngaged(...)` suppression used to eat every classic nudge.
    const main = await startBilledUpstream(7000); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 8192 } } } },
        modelContextLimit: 8192,
        // #3006: the escalation override now honors the kernel's minimum-benefit
        // floor; this fixture's small pending mass sits below it, so no nudge
        // would fire anymore. Pin it to legacy any-pending semantics (explicit 0)
        // so it keeps testing the autoFoldEngaged suppression guard, not the floor.
        kernelConfig: { ...defaultConfig(8192, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }), nudge: { ...defaultConfig(8192).nudge, minPressureBenefitTokens: 0 } },
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    const warm = await postTurn(port, main.url, "deg-win", 2);
    assert.equal(warm.status, 200, "warm-up turn forwards cleanly");
    const turn = await postTurn(port, main.url, "deg-win", 2);
    assert.equal(turn.status, 200, "turn 2 must forward cleanly");
    assert.equal(sum.bodies.length, 0, "growth folding never engaged (degenerate window) — no external calls");
    const text = JSON.stringify(main.bodies.at(-1));
    assert.ok(text.includes("Context breakdown:"), "classic nudge must fire when growth folding is degenerate (suppression bug)");
});

test("explicit autoFoldTargetTokens clamped to the window: classic nudges still fire", async () => {
    // 50K window with autoFoldTargetTokens=50_000: target==window is a no-op
    // growth config; it must not suppress the classic nudge either.
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 50_000 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: true,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    const warm = await postTurn(port, main.url, "deg-target", 36);
    assert.equal(warm.status, 200, "warm-up turn forwards cleanly");
    const turn = await postTurn(port, main.url, "deg-target", 36);
    assert.equal(turn.status, 200, "turn 2 must forward cleanly");
    assert.equal(sum.bodies.length, 0, "clamped target is a no-op growth config — no external calls");
    const text = JSON.stringify(main.bodies.at(-1));
    assert.ok(text.includes("Context breakdown:"), "classic nudge must fire when the explicit target clamps to the window");
});

test("explicit autoFoldTargetTokens above the route bar warns once that auto-fold is inert (#4543)", async () => {
    // The operator trap: a configured target at or above the route's overflow
    // bar clamps to it and silently disarms the pre-forward growth fold. The
    // warn must fire exactly once per session per route bar and name both values.
    // Target deliberately far ABOVE the route window: the env may floor the
    // judge window upward (fallback floor for unproven models), so a value
    // above every plausible bar keeps the inert condition deterministic.
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 500_000 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        const first = await postTurn(port, main.url, "inert-bar", 2);
        assert.equal(first.status, 200, "turn 1 forwards cleanly despite the inert config");
        let inertLines = warns.filter((m) => m.includes("auto-fold INERT"));
        assert.equal(inertLines.length, 1, JSON.stringify(warns));
        assert.ok(inertLines[0].includes("autoFoldTargetTokens=500000"), inertLines[0]);
        assert.ok(/overflow target \d+/.test(inertLines[0]), inertLines[0]);
        assert.ok(inertLines[0].includes("#4543"), inertLines[0]);

        const second = await postTurn(port, main.url, "inert-bar", 2);
        assert.equal(second.status, 200, "turn 2 forwards cleanly");
        inertLines = warns.filter((m) => m.includes("auto-fold INERT"));
        assert.equal(inertLines.length, 1, `throttled to one warn per session per route bar: ${JSON.stringify(warns)}`);
    } finally {
        setLogCapture(null);
    }
});

test("no inert warning while growth folding is armed (target below the window)", async () => {
    // Negative arm of the same gate: an explicit target that stays below the
    // overflow bar arms growth folding and must not produce the inert warning.
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
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
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        const turn = await postTurn(port, main.url, "armed-bar", 2);
        assert.equal(turn.status, 200, "turn forwards cleanly with an armed target");
        assert.equal(warns.filter((m) => m.includes("auto-fold INERT")).length, 0, JSON.stringify(warns));
    } finally {
        setLogCapture(null);
    }
});
