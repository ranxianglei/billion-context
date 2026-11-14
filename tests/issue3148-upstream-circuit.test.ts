// #3148: upstream-unavailable amplification — round-level circuit breaker +
// acp_status visibility (emergency shrink / output clamp / circuit state).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import {
    getOpenUpstreamCircuits,
    recordUpstreamCircuitFailure,
    recordUpstreamCircuitSuccess,
    upstreamCircuitBlockReason,
    _resetUpstreamCircuitsForTest,
    _setCircuitCooldownForTest,
} from "../src/upstream-alerts.ts";
import { clampOutgoingOutput } from "../src/server/budget.ts";
import { settleUsageReport } from "../src/cache-ledger.ts";

const URL_A = "http://dead-host.invalid:8443/v1/chat/completions";
const URL_B = "http://other-host.invalid/v1/chat/completions";

function refused(): Error {
    return Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:8443"), { code: "ECONNREFUSED" });
}
function headersTimeout(): Error {
    return Object.assign(new Error("request timed out while waiting for headers"), { code: "UND_ERR_HEADERS_TIMEOUT" });
}
function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

test("#3148: circuit opens after 3 consecutive pre-response failures and fast-fails until a probe succeeds", () => {
    _resetUpstreamCircuitsForTest();
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined, "fresh host: no block");

    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined, "2 consecutive failures: not open yet");

    recordUpstreamCircuitFailure(URL_A, refused(), false);
    const open = getOpenUpstreamCircuits();
    assert.equal(open.length, 1, "circuit open after the 3rd consecutive failure");
    assert.equal(open[0].host, new URL(URL_A).host);
    assert.ok(open[0].consecutiveFailures >= 3);

    const reason = upstreamCircuitBlockReason(URL_A);
    assert.ok(reason !== undefined, "blocked while open");
    // #4254: the reason's free-text host follows the same masking rule as the
    // embedded last-failure detail (non-public → <private-host>), so it no longer
    // leaks the raw private hostname; the actionable endpoint rides upstreamFailure.host.
    assert.ok(reason.includes("<private-host>"), "reason masks the private host consistently");
    assert.ok(reason.includes("consecutive pre-response failures"), "reason states the cause");
    assert.ok(reason.includes("next probe"), "reason gives the probe ETA");
    assert.equal(upstreamCircuitBlockReason(URL_B), undefined, "other hosts unaffected");

    recordUpstreamCircuitSuccess(URL_A);
    assert.equal(getOpenUpstreamCircuits().length, 0, "success closes the circuit");
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined, "no block after close");
});

test("#3148: consecutive counter resets on any resolved response mid-stream", () => {
    _resetUpstreamCircuitsForTest();
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitSuccess(URL_A);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    assert.equal(getOpenUpstreamCircuits().length, 0, "flapping upstream never reaches 3 CONSECUTIVE failures");
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined);
});

test("#3148: non-transport failures (timeouts/aborts) never count toward the circuit", () => {
    _resetUpstreamCircuitsForTest();
    for (let i = 0; i < 5; i++) recordUpstreamCircuitFailure(URL_A, headersTimeout(), false);
    assert.equal(getOpenUpstreamCircuits().length, 0, "upstream-timeout is not in the count set");
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined);
});

test("#3148: half-open allows exactly one probe; a failed probe re-arms the cooldown", async () => {
    _resetUpstreamCircuitsForTest();
    _setCircuitCooldownForTest(50);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    assert.ok(upstreamCircuitBlockReason(URL_A) !== undefined, "open immediately after the 3rd failure");

    await sleep(70);
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined, "cooldown elapsed: this request becomes THE probe");
    assert.ok(upstreamCircuitBlockReason(URL_A) !== undefined, "a concurrent request while the probe is in flight stays blocked");

    recordUpstreamCircuitFailure(URL_A, refused(), false);
    assert.ok(upstreamCircuitBlockReason(URL_A) !== undefined, "failed probe re-arms the cooldown");
    await sleep(70);
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined, "second probe granted after the new cooldown");
    recordUpstreamCircuitSuccess(URL_A);
    assert.equal(getOpenUpstreamCircuits().length, 0, "probe success closes the circuit");
});

test("#3148 review: an UNCOUNTED probe failure (timeout/client abort) must not pin the circuit open", async () => {
    _resetUpstreamCircuitsForTest();
    _setCircuitCooldownForTest(50);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    assert.ok(upstreamCircuitBlockReason(URL_A) !== undefined, "open after the 3rd failure");

    await sleep(70);
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined, "cooldown elapsed: this request becomes THE probe");
    // The probe dies with an uncounted kind — a degraded host that accepts TCP
    // but never answers (headers timeout), or a client that aborts mid-probe.
    // Pre-fix this left the single-flight slot held and the circuit failed fast
    // FOREVER (until process restart), even after full recovery.
    recordUpstreamCircuitFailure(URL_A, headersTimeout(), false);
    assert.ok(getOpenUpstreamCircuits()[0].lastFailure?.kind === "upstream-timeout", "uncounted probe failure is visible");
    assert.ok(upstreamCircuitBlockReason(URL_A) !== undefined, "re-armed cooldown blocks immediately");
    await sleep(70);
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined, "slot released: next probe granted after the re-armed cooldown");

    const aborted = Object.assign(new Error("request aborted"), { name: "AbortError" });
    recordUpstreamCircuitFailure(URL_A, aborted, false);
    assert.equal(getOpenUpstreamCircuits().length, 1, "an abort proves nothing — circuit stays open");
    await sleep(70);
    assert.equal(upstreamCircuitBlockReason(URL_A), undefined, "abort also released the slot");
    recordUpstreamCircuitSuccess(URL_A);
    assert.equal(getOpenUpstreamCircuits().length, 0, "probe success closes the circuit");
});

test("#3148: clampOutgoingOutput records the exact clamp event without changing the wire decision", () => {
    const rebuilt: Record<string, unknown> = { max_tokens: 300_000 };
    let seen: { raw: number; capped: number; window: number; planningInput: number; ledgerFloor: number } | undefined;
    // The reporter's numbers (floor 997348, window 1048576 -> margin
    // ceil(997348*0.05)=49868, cap floor(1048576-997348-49868)=1360, lifted to
    // 4096 by #3071's capability floor bounded by raw headroom 51228) are kept;
    // #3384 re-gated the floor, so the request is raised to 300K >=
    // 0.25*1048576=262144 to take the giant-request ground and keep the hook
    // path covered.
    clampOutgoingOutput(
        rebuilt,
        "max_tokens",
        {
            systemText: "",
            tools: [],
            processedMessages: [],
            lastInputTokens: 97730,
            lastInputTokensSource: "usage",
            nativeWindow: 1048576,
            imageTokens: 0,
            ledgerFloorTokens: 997348,
        },
        "t",
        () => {},
        (info) => { seen = info; },
    );
    assert.deepEqual(seen, { raw: 300_000, capped: 4096, window: 1048576, planningInput: 997348, ledgerFloor: 997348 }, "exact clamp event captured");
    assert.equal(rebuilt.max_tokens, 4096, "wire decision unchanged (same cap as before the hook)");

    // #3384: the OLD expectation here (modest 65536 request against this same
    // floor clamps to 4096) IS the starvation regression — below both gate
    // lines the floor must not drive planning, or a healthy session (folded
    // wire ~9% of the window) loses its output budget to bytes never sent.
    const modest: Record<string, unknown> = { max_tokens: 65_536 };
    let modestCalls = 0;
    clampOutgoingOutput(
        modest,
        "max_tokens",
        {
            systemText: "",
            tools: [],
            processedMessages: [],
            lastInputTokens: 97730,
            lastInputTokensSource: "usage",
            nativeWindow: 1048576,
            imageTokens: 0,
            ledgerFloorTokens: 997348,
        },
        "t",
        () => {},
        () => { modestCalls++; },
    );
    assert.equal(modestCalls, 0, "#3384: no clamp event — the floor is gated off for a modest request");
    assert.equal(modest.max_tokens, 65_536, "#3384: budget untouched while the folded view is healthy");

    const healthy: Record<string, unknown> = { max_tokens: 65536 };
    let healthyCalls = 0;
    clampOutgoingOutput(
        healthy,
        "max_tokens",
        {
            systemText: "",
            tools: [],
            processedMessages: [],
            lastInputTokens: 97730,
            lastInputTokensSource: "usage",
            nativeWindow: 1048576,
            imageTokens: 0,
        },
        "t",
        () => {},
        () => { healthyCalls++; },
    );
    assert.equal(healthyCalls, 0, "no clamp event when nothing was clamped");
    assert.equal(healthy.max_tokens, 65536, "budget untouched when headroom suffices");
});

function makeSession(overrides?: Partial<Session["stats"]> & { metadata?: Record<string, unknown> }): Session {
    return {
        id: "issue3148-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0, ...overrides },
        metadata: overrides?.metadata ?? {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function makeCtx(session: Session): { core: ReturnType<typeof createCore>; config: ReturnType<typeof defaultConfig>; messages: CoreMessage[]; session: Session } {
    const messages: CoreMessage[] = [
        { id: "raw_1", role: "user", contentType: "text", text: "hello" },
        { id: "raw_2", role: "assistant", contentType: "text", text: "hi" },
    ];
    return { core: createCore(), config: defaultConfig(200000), messages, session };
}

test("#3148: acp_status surfaces the open circuit, armed emergency shrink and the sticky clamp floor", () => {
    _resetUpstreamCircuitsForTest();
    _setCircuitCooldownForTest(60_000);
    const session = makeSession({
        emergencyShrinkAt: Date.now() - 60_000,
        emergencyShrinkEstimate: 699777,
        lastOutputClamp: { raw: 65536, capped: 1360, window: 1048576, planningInput: 997348, ledgerFloor: 997348, at: Date.now() - 30_000 },
    });
    session.metadata.dshCompactionRefusedBytes = 997348 * 4;
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitFailure(URL_A, refused(), false);
    recordUpstreamCircuitFailure(URL_A, refused(), false);

    const text = handleAcpStatus({}, makeCtx(session)).text;
    assert.ok(text.includes("UPSTREAM CIRCUIT OPEN"), "open circuit visible");
    assert.ok(text.includes("dead-host.invalid"), "circuit names the host");
    assert.ok(text.includes("EMERGENCY SHRINK ARMED"), "armed shrink visible");
    assert.ok(text.includes("699777"), "shrink estimate visible");
    assert.ok(text.includes("OUTPUT BUDGET CLAMP"), "clamp section visible");
    assert.ok(text.includes("65536 -> 1360"), "last clamp values visible");
    assert.ok(text.includes("997348"), "planning floor visible");
});

test("#3148: acp_status stays quiet about all three when none is active", () => {
    _resetUpstreamCircuitsForTest();
    const text = handleAcpStatus({}, makeCtx(makeSession())).text;
    assert.ok(!text.includes("UPSTREAM CIRCUIT OPEN"), "no circuit line when closed");
    assert.ok(!text.includes("EMERGENCY SHRINK ARMED"), "no shrink line when not armed");
    assert.ok(!text.includes("OUTPUT BUDGET CLAMP"), "no clamp line without ledger/clamp history");
});

test("#3148: a real usage report clears the emergency-shrink visibility marker", () => {
    _resetUpstreamCircuitsForTest();
    const session = makeSession({ emergencyShrinkAt: Date.now(), emergencyShrinkEstimate: 699777, lastInputTokensSource: "estimate" });
    // #4425: the report must be main-grade relative to the fixture's 15K
    // established scale — a sub-10% sample is an aux-sidecar shape now kept
    // off the decision state (see issue4425-aux-settle-gate.test.ts).
    settleUsageReport(session, { total: 15_000, reportedCached: 0 });
    assert.equal(session.stats.emergencyShrinkAt, undefined, "marker cleared");
    assert.equal(session.stats.emergencyShrinkEstimate, undefined, "estimate cleared");
    assert.equal(session.stats.lastInputTokensSource, "usage", "baseline back to usage grade");
});
