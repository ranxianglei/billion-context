import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_REPLAY_RETRY_MAX = "1";
// Zero backoff so any retry legs run instantly.
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { diagnoseEmptySummary, isDeterministicEmptyCompletion } from "../src/preflight.ts";

// #2832: a relay model (kimi code alias behind an anthropic-shaped gateway)
// answered every preflight summary probe with stop_reason=end_turn and its
// whole answer inside thinking blocks — zero text. Preflight classified that
// as TRANSIENT (no size signal matched), burned two same-span retries plus
// the per-regime retry budget on every span, then let the #726 halving
// cascade re-bill doomed sub-spans: six failed probes over six minutes, ZERO
// folds landed, and the turn fell through to an evidence-only forward that
// billed the full payload. The fix classifies normal-stop-zero-text
// completions as DETERMINISTIC (no same-span retries, no halving), records a
// strike per (host, model) pair in session metadata, arms a dead-probe
// verdict after three consecutive strikes, and lets exactly ONE canary probe
// per invocation detect a self-healed relay (which clears the verdict).

const SUMMARY_TEXT =
    "#2832 TEST SUMMARY: the segment held large log dumps plus several short turns; the raw payload is derivable, so the folded view loses nothing of value.";

type Call = { summary: boolean; failed: boolean };

// The incident shape on the openai wire: HTTP 200 plain JSON, empty content,
// NORMAL stop reason, the answer riding in reasoning_content instead.
function deterministicEmptyJson(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        id: "chatcmpl-det", object: "chat.completion", model: "muse-spark-1.3-contributor",
        choices: [{ index: 0, message: { role: "assistant", content: "", reasoning_content: "R".repeat(2048) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    }));
}

function okSummaryJson(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        id: "chatcmpl-ok", object: "chat.completion", model: "muse-spark-1.3-contributor",
        choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
}

function forwardSse(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const line = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
    line({ id: "c_fwd", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] });
    line({ id: "c_fwd", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
    res.write("data: [DONE]\n\n");
    res.end();
}

type ParsedBody = { messages?: unknown; instructions?: unknown };

function parseBody(raw: string): ParsedBody {
    try {
        return JSON.parse(raw) as ParsedBody;
    } catch {
        return {};
    }
}

// Summary calls on the openai wire carry exactly [system, user]; forwards
// carry the full conversation.
function isSummaryCall(parsed: ParsedBody): boolean {
    return Array.isArray(parsed.messages) && parsed.messages.length === 2
        && (parsed.messages[0] as Record<string, unknown>).role === "system";
}

function makeUpstream(calls: Call[], failMode: { current: boolean }): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = parseBody(Buffer.concat(chunks).toString("utf8"));
            const summary = isSummaryCall(parsed);
            const failed = summary && failMode.current;
            calls.push({ summary, failed });
            if (failed) deterministicEmptyJson(res);
            else if (summary) okSummaryJson(res);
            else forwardSse(res);
        });
    });
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
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
    } as ProxyOptions);
}

async function driveChat(proxyPort: number, upstreamPort: number, session: string, model: string, messages: unknown[]): Promise<Response> {
    return await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model, stream: true, messages }),
    });
}

// Four log-dump blocks separated by short user turns, well over the 10K
// window but far below the #2383 emergency digest bound (19.2x), so the LLM
// fold path runs. Nothing is ever forwarded while the relay is broken, so
// every turn re-enters preflight on the same over-window payload — the
// incident's steady state.
function giantBlocksInput(): unknown[] {
    const items: unknown[] = [];
    for (let i = 0; i < 4; i++) {
        items.push({ role: "user", content: `Question ${i}: what do these logs say?` });
        items.push({ role: "assistant", content: `LOG_BLOCK_${i}_`.repeat(1100) });
    }
    items.push({ role: "user", content: "final question here" });
    items.push({ role: "assistant", content: "short tail reply" });
    return items;
}

type ProbeState = { key: string; strikes: number; dead: boolean };

function probeStateOf(sessionId: string): ProbeState | undefined {
    const sess = listSessions().find((s) => s.id.includes(sessionId));
    assert.ok(sess, `session ${sessionId} recorded`);
    const stored = sess?.metadata?.["deterministicEmptyProbe"];
    if (!stored || typeof stored !== "object") return undefined;
    return stored as ProbeState;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("#2832 classifier: normal-stop zero-text is deterministic; blips and size signals are not", () => {
    const thinkingOnly = {
        id: "msg_1", model: "k3-256k", stop_reason: "end_turn",
        content: [
            { type: "thinking", thinking: "let me think about this summary..." },
            { type: "redacted_thinking", data: "xxx" },
        ],
    };
    assert.equal(isDeterministicEmptyCompletion("anthropic", thinkingOnly), true, "thinking-only end_turn is deterministic");
    assert.equal(isDeterministicEmptyCompletion("anthropic", { ...thinkingOnly, content: [{ type: "text", text: "short" }] }), false, "any answer text is NOT deterministic");
    assert.equal(isDeterministicEmptyCompletion("anthropic", { ...thinkingOnly, stop_reason: "max_tokens" }), false, "max_tokens stays size-driven");
    assert.equal(isDeterministicEmptyCompletion("anthropic", { ...thinkingOnly, content: "not-an-array" }), false, "unrecognized content shape is never deterministic");
    const openaiStopEmpty = { choices: [{ message: { role: "assistant", content: "", reasoning_content: "thought hard" }, finish_reason: "stop" }] };
    assert.equal(isDeterministicEmptyCompletion("openai", openaiStopEmpty), true, "finish_reason=stop with empty content is deterministic");
    assert.equal(isDeterministicEmptyCompletion("openai", { choices: [{ message: { content: "" }, finish_reason: "length" }] }), false, "finish_reason=length stays size-driven");
    assert.equal(isDeterministicEmptyCompletion("openai", { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }), false, "content_filter stays transient (#1767)");
    assert.equal(isDeterministicEmptyCompletion("openai", { choices: [{ message: { content: "x".repeat(60) }, finish_reason: "stop" }] }), false, "a real (short) answer is not deterministic");
    assert.equal(isDeterministicEmptyCompletion("responses", { status: "completed", output: [] }), true, "completed-with-no-output is deterministic");
    assert.equal(isDeterministicEmptyCompletion("responses", { output: [] }), true, "omitted status stays accepted");
    assert.equal(isDeterministicEmptyCompletion("responses", { status: "incomplete", output: [] }), false, "incomplete stays transient (#780/#784)");
    assert.equal(isDeterministicEmptyCompletion("google", { candidates: [] }), false, "google is out of scope for this classifier");
    assert.equal(isDeterministicEmptyCompletion("anthropic", null), false, "SSE bodies (json=null) are never deterministic here");
    assert.equal(isDeterministicEmptyCompletion("anthropic", "event: x\ndata: {}"), false, "non-object bodies are never deterministic");
});

test("#2832 diagnosis carries the block fingerprint (thinking-only vs stripped-text)", () => {
    // The incident shape: anthropic end_turn, answer entirely in thinking.
    const anthropicThinkingOnly = JSON.stringify({
        id: "msg_1", model: "k3-256k", stop_reason: "end_turn",
        content: [
            { type: "thinking", thinking: "A".repeat(1873) },
            { type: "redacted_thinking", data: "xxx" },
        ],
    });
    assert.match(
        diagnoseEmptySummary(anthropicThinkingOnly, JSON.parse(anthropicThinkingOnly)),
        /plain-JSON completion with empty content \(stop_reason=end_turn, text_blocks=0, thinking_blocks=2, reasoning_chars=1873, answered as model=k3-256k\)/,
    );
    // Same stop reason, relay stripped EVERYTHING: no thinking blocks either.
    const anthropicStripped = JSON.stringify({ id: "msg_2", model: "k3-256k", stop_reason: "end_turn", content: [] });
    assert.match(
        diagnoseEmptySummary(anthropicStripped, JSON.parse(anthropicStripped)),
        /plain-JSON completion with empty content \(stop_reason=end_turn, text_blocks=0, answered as model=k3-256k\)/,
    );
    const openaiReasoning = JSON.stringify({
        id: "chatcmpl-1", model: "muse-spark",
        choices: [{ index: 0, message: { role: "assistant", content: "", reasoning_content: "B".repeat(512) }, finish_reason: "stop" }],
    });
    assert.match(
        diagnoseEmptySummary(openaiReasoning, JSON.parse(openaiReasoning)),
        /plain-JSON completion with empty content \(finish_reason=stop, text_chars=0, reasoning_chars=512, answered as model=muse-spark\)/,
    );
    const responsesEmpty = JSON.stringify({ id: "resp_1", status: "completed", output: [], model: "gpt-x" });
    assert.match(
        diagnoseEmptySummary(responsesEmpty, JSON.parse(responsesEmpty)),
        /plain-JSON completion with empty content \(status=completed, text_parts=0, answered as model=gpt-x\)/,
    );
});

// Drives turns until the dead-probe verdict arms (at most one strike per
// probe-able range per turn; the bound below is generous to kernel range
// topology). Returns the turn count.
async function driveUntilArmed(
    proxyPort: number,
    upstreamPort: number,
    session: string,
    model: string,
    input: unknown[],
    maxTurns: number,
): Promise<number> {
    for (let turn = 1; turn <= maxTurns; turn++) {
        const r = await driveChat(proxyPort, upstreamPort, session, model, input);
        const body = await r.text();
        assert.equal(r.status, 502, `turn ${turn} must fail-fast while the relay is broken, got ${r.status}: ${body.slice(0, 300)}`);
        if (probeStateOf(session)?.dead === true) return turn;
        await sleep(500);
    }
    throw new Error(`verdict did not arm within ${maxTurns} turns (last state: ${JSON.stringify(probeStateOf(session))})`);
}

test("#2832 systemic deterministic empties: bounded strikes, sticky verdict, one canary per turn, nothing forwarded", { timeout: 180_000 }, async () => {
    const calls: Call[] = [];
    const failMode = { current: true };
    const upstream = makeUpstream(calls, failMode);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "muse-spark-1.3-contributor": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const input = giantBlocksInput();
        const armedTurn = await driveUntilArmed(proxyPort, upstreamPort, "s2832-dead", "muse-spark-1.3-contributor", input, 6);
        assert.ok(armedTurn <= 3, `three strikes must arm the verdict within three turns, took ${armedTurn}`);

        // OLD behavior burned 1 draw + 2 retries per span plus the #726
        // halving cascade for EVERY span of EVERY range EVERY turn (the
        // incident: 6+ probes in one minute, unbounded across ranges). NEW
        // behavior pays at most one strike per probe-able range per turn.
        const summariesArmed = calls.filter((c) => c.summary).length;
        assert.ok(summariesArmed >= 3 && summariesArmed <= 6, `total strikes must be bounded (3 to arm, one regime-headroom margin), got ${summariesArmed}`);
        assert.ok(!calls.some((c) => !c.summary), "nothing may be forwarded while the relay is broken");

        const st = probeStateOf("s2832-dead");
        assert.equal(st!.dead, true, "verdict armed");
        assert.ok(st!.key.includes("muse-spark-1.3-contributor"), "verdict key carries the model");

        // Next turn (no cooldown anymore, #4079): a carried verdict spends EXACTLY ONE canary
        // probe (old behavior re-burned the full retry budget per span).
        await sleep(500);
        const r2 = await driveChat(proxyPort, upstreamPort, "s2832-dead", "muse-spark-1.3-contributor", input);
        assert.equal(r2.status, 502, `carried verdict must still fail-fast, got ${r2.status}`);
        const j2 = (await r2.json()) as { error?: { code?: string; message?: string } };
        assert.equal(j2.error?.code, "preflight_compress_failed");
        const summariesAfterCanary = calls.filter((c) => c.summary).length;
        assert.equal(summariesAfterCanary, summariesArmed + 1, `a carried verdict allows exactly ONE canary probe per turn, got +${summariesAfterCanary - summariesArmed}`);
        assert.ok(!calls.slice(summariesArmed).some((c) => !c.summary), "still nothing forwarded");
        assert.equal(probeStateOf("s2832-dead")?.dead, true, "a failed canary keeps the verdict armed");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

test("#2832 self-healed relay: the canary clears the verdict and folding resumes", { timeout: 180_000 }, async () => {
    const calls: Call[] = [];
    const failMode = { current: true };
    const upstream = makeUpstream(calls, failMode);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "muse-spark-1.3-contributor": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const input = giantBlocksInput();
        await driveUntilArmed(proxyPort, upstreamPort, "s2832-heal", "muse-spark-1.3-contributor", input, 6);

        // The relay self-heals between turns.
        failMode.current = false;
        await sleep(500);
        const r3 = await driveChat(proxyPort, upstreamPort, "s2832-heal", "muse-spark-1.3-contributor", input);
        assert.equal(r3.status, 200, `the canary must detect the healed relay and resume folding, got ${r3.status}: ${(await r3.text()).slice(0, 300)}`);
        assert.equal(probeStateOf("s2832-heal"), undefined, "a successful probe must clear the verdict");
        assert.ok(calls.some((c) => !c.summary), "the folded payload was forwarded");
        const okSummaries = calls.filter((c) => c.summary && !c.failed).length;
        assert.ok(okSummaries >= 1, "at least the canary summary succeeded");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});
