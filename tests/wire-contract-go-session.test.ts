// WC-016 (#2760) gates: OpenCode Go requires a stable x-opencode-session on every
// independent summary call, else HTTP 400 MissingSessionID. These drive the REAL
// summary path (candidate / compress-tool lane / preflight+auto-fold lane) against
// an in-memory validation-parity fake standing in for opencode.ai/zen/go, proving
// the header rides the outbound request, is stable across a batch, isolated across
// sessions, and never invented off-Go or without a conversation id.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type Config, type CoreMessage } from "acp-kernel";
import { withFetchTransport } from "../src/fetch-transport.js";
import { createSummaryHttpCandidate, isOpenCodeGoTarget, type SummaryHttpTarget } from "../src/external-summary-http.js";
import { ExternalSummaryExecutor, type SummaryWork } from "../src/external-summary.js";
import { applyConfiguredCompression } from "../src/external-summary-compress.js";
import { preflightCompress } from "../src/preflight.js";
import { createSession } from "../src/session.js";
import type { RewriteCtx } from "../src/stream.js";
import { PACKAGE_NAME, VERSION } from "../src/version.js";
import { _liveUpstreamTimersForTest, type FetchOptions } from "../src/fetch-util.js";
import { validateGoSessionHeaders, goMissingSessionIdEnvelope } from "./wire-contract-fakes.js";

process.env.NODE_ENV = "test";

const GO_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const SUMMARY_TEXT = "Retained decisions, evidence, constraints and unfinished objectives.";
const GO_COMPLETION = JSON.stringify({
    id: "chatcmpl_go", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
});
const work: SummaryWork = { content: "Prior evidence and decisions to retain.", reference: "Read-only current task context.", instructions: "Preserve unfinished objectives." };
const budget = { totalTimeoutMs: 4000, targetTimeoutMs: 1500, maxSummaryBytes: 2048 };

interface Captured { url: string; headers: Record<string, string> }

/** An in-memory OpenCode Go validation-parity fake: enforces WC-016 exactly like
 *  the real upstream (400 MissingSessionID when x-opencode-session is absent) and
 *  records the headers bili actually sent. Routed in via the fetch-transport seam
 *  so the candidate keeps the real opencode.ai hostname (detection still fires). */
function goFake(capture: Captured[]): (url: string, options: FetchOptions) => Promise<Response> {
    return async (_url, options) => {
        const headers = Object.fromEntries(new Headers(options.headers ?? {}).entries());
        capture.push({ url: _url, headers });
        if (validateGoSessionHeaders(headers).length > 0) {
            const env = goMissingSessionIdEnvelope();
            return new Response(env.body, { status: env.status, headers: { "content-type": "application/json" } });
        }
        return new Response(GO_COMPLETION, { status: 200, headers: { "content-type": "application/json" } });
    };
}

afterEach(() => assert.equal(_liveUpstreamTimersForTest(), 0));

test("WC-016: Go target detection is scoped to opencode.ai/zen/go only", () => {
    assert.equal(isOpenCodeGoTarget(GO_URL), true);
    assert.equal(isOpenCodeGoTarget("https://opencode.ai/zen/go/v1/chat/completions?alt=sse"), true);
    assert.equal(isOpenCodeGoTarget("https://OPENCODE.AI/zen/go/v1/chat/completions"), true, "host match is case-insensitive");
    assert.equal(isOpenCodeGoTarget("https://opencode.ai/zen/v1/messages"), false, "the zen Anthropic proxy under /zen/v1 is NOT Go");
    assert.equal(isOpenCodeGoTarget("https://opencode.ai/v1/chat/completions"), false, "non-/zen/go paths are untouched");
    assert.equal(isOpenCodeGoTarget("https://opencode.ai/zen/golang/v1/chat/completions"), false, "the /zen/go match is segment-bounded: a hypothetical /zen/golang is NOT Go");
    assert.equal(isOpenCodeGoTarget("https://opencode.ai/zen/go"), true, "the bare /zen/go root is Go");
    assert.equal(isOpenCodeGoTarget("https://evil.example.com/zen/go/v1/chat/completions"), false, "other hosts are untouched");
    assert.equal(isOpenCodeGoTarget("not-a-url"), false);
});

function goTarget(sessionId?: string): SummaryHttpTarget {
    return { protocol: "openai", url: GO_URL, model: "deepseek-v4.1-flash", headers: { authorization: "Bearer go-test-key" }, ...(sessionId !== undefined ? { sessionId } : {}) };
}

test("WC-016: a Go summary candidate stamps x-opencode-session and bili's own user agent", async () => {
    const capture: Captured[] = [];
    const result = await withFetchTransport(goFake(capture), () =>
        new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(goTarget("sess-stable-id"), 4096)], budget));
    assert.equal(result.status, "success");
    if (result.status === "success") assert.equal(result.summary, SUMMARY_TEXT);
    assert.equal(capture.length, 1);
    assert.equal(capture[0].headers["x-opencode-session"], "sess-stable-id", "the stable conversation id rides the outbound Go call");
    assert.equal(capture[0].headers["user-agent"], `${PACKAGE_NAME}/${VERSION}`, "bili's own user agent, not a generic SDK name");
    assert.equal(capture[0].headers["authorization"], "Bearer go-test-key", "its own credential is still present");
});

test("WC-016 negative control: a Go candidate with no session id fails on the upstream MissingSessionID 400", async () => {
    const capture: Captured[] = [];
    const result = await withFetchTransport(goFake(capture), () =>
        new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate(goTarget(), 4096)], budget));
    assert.equal(result.status, "failed");
    assert.deepEqual(result.attempts, [{ targetIndex: 0, outcome: "error" }]);
    assert.equal(capture[0].headers["x-opencode-session"], undefined, "no session id is fabricated — the failure stays honest");
});

test("WC-016: a non-Go target keeps the existing no-session-header invariant", async () => {
    const capture: Captured[] = [];
    await withFetchTransport(goFake(capture), () =>
        new ExternalSummaryExecutor(1).execute(work, [createSummaryHttpCandidate({ protocol: "responses", url: "http://127.0.0.1:9/summary", model: "m", headers: { authorization: "Bearer k" }, sessionId: "must-not-appear" }, 4096)], budget));
    assert.equal(capture.length, 1);
    assert.equal(capture[0].headers["x-opencode-session"], undefined, "sessionId is ignored off-Go");
    assert.equal(capture[0].headers["user-agent"], undefined, "no user-agent override off-Go");
});

// A resolved-config rail carrying a single OpenCode Go target (expanded form, inline key).
function goContext(sessionId: string): RewriteCtx {
    const core = createCore();
    const config = defaultConfig(400_000) as Config & { externalSummary?: unknown };
    config.externalSummary = { enabled: true, targets: [{ name: "go", protocol: "openai", url: GO_URL, model: "deepseek-v4.1-flash", apiKey: "go-test-key" }] };
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const session = createSession(sessionId);
    const messages: CoreMessage[] = [
        { id: "h1", role: "assistant", contentType: "text", text: "A".repeat(2000) },
        { id: "h2", role: "assistant", contentType: "text", text: "B".repeat(2000) },
        { id: "current-task", role: "user", contentType: "text", text: "Current task: finish tests." },
    ];
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 10_000, renderTags: "text-only" }).state;
    return { core, config, session, messages, log: () => {} } as RewriteCtx;
}

// BOTH compression modes execute the compress tool through applyConfiguredCompression
// (proxy mode server-side; plugin mode intercepts the agent's tool_use), so this lane
// covers both. A multi-range batch must stamp ONE stable id; a different session must
// stamp a different id.
test("WC-016 BOTH modes: the compress-tool lane stamps a stable x-opencode-session across a batch and isolates sessions", async () => {
    const ref = (ctx: RewriteCtx, id: string) => ctx.session.state.messageRefs.byRaw[id];
    const captureA: Captured[] = [];
    const ctxA = goContext("sess-A");
    const inputA = { content: [{ startId: ref(ctxA, "h1"), endId: ref(ctxA, "h1") }, { startId: ref(ctxA, "h2"), endId: ref(ctxA, "h2") }] };
    const resultA = await withFetchTransport(goFake(captureA), () => applyConfiguredCompression(inputA, ctxA));
    assert.equal(resultA.outcome, "applied", resultA.text);
    assert.equal(captureA.length, 2, "two ranges -> two outbound Go summary calls");
    for (const c of captureA) assert.equal(c.headers["x-opencode-session"], "sess-A", "every call in the batch carries the SAME session id");

    const captureB: Captured[] = [];
    const ctxB = goContext("sess-B");
    const inputB = { content: [{ startId: ref(ctxB, "h1"), endId: ref(ctxB, "h1") }] };
    const resultB = await withFetchTransport(goFake(captureB), () => applyConfiguredCompression(inputB, ctxB));
    assert.equal(resultB.outcome, "applied", resultB.text);
    assert.equal(captureB.length, 1);
    assert.equal(captureB[0].headers["x-opencode-session"], "sess-B", "a different session stamps a different id");
});

// The preflight + auto-fold lane dispatches summaries through preflightCompress.
test("WC-016 BOTH modes: the preflight/auto-fold lane stamps the session id on its Go summary calls", async () => {
    const capture: Captured[] = [];
    const ctx = goContext("preflight-sess");
    ctx.config.modelContextLimit = 1000;
    ctx.session.stats.lastInputTokens = 10_000;
    const result = await withFetchTransport(goFake(capture), () =>
        preflightCompress({ core: ctx.core, config: ctx.config, session: ctx.session, prompts: defaultPrompts, protocol: "responses", url: "http://127.0.0.1:9/main-must-not-summarize", headers: { authorization: "Bearer wrong-main-key" }, model: "main-model", log: () => {} }, ctx.messages));
    assert.ok(result.compressedRanges > 0, JSON.stringify(result));
    assert.ok(capture.length > 0, "the overflow was folded through the configured Go chain, not the main endpoint");
    for (const c of capture) assert.equal(c.headers["x-opencode-session"], "preflight-sess", "every auto-fold summary call carries the session id");
});
