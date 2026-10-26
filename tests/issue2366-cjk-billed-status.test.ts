import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, createCore, createInitialState, assignRefs, emptyRefMap } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { settleUsageReport } from "../src/cache-ledger.ts";
import { applyEstimateCalibration } from "../src/util.ts";

// #2366: on CJK-heavy routes upstream billing runs 2.4–4.0× above the local
// chars/4 estimate, so every agent-visible surface (acp_status breakdown,
// nudge reason) understated real context pressure until the window was nearly
// full and little compressible mass remained — the "small-benefit fold loop".
// Two host-side fixes are pinned here:
//   A) calibration is now two-way (clamp [0.25, 4]) so under-estimating routes
//      learn k̂>1 instead of clamping back to the raw proxy;
//   B) acp_status shows the usage-grade BILLED INPUT next to the estimate view
//      (+ divergence NOTE at ratio ≥1.5, + PRESSURE NOTE when billed pressure
//      is high but compressible mass is exhausted).

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i2366-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

// One settled pair (pending estimate + its usage report) on a route.
function pair(s: Session, est: number, origin: string, billed: number): void {
    s.stats.lastLocalTextEstimate = est;
    s.stats.lastLocalTextEstimateOrigin = origin;
    settleUsageReport(s, { total: billed, reportedCached: null, upstream: origin });
}

test("#2366 A: an under-estimating (CJK-like) route learns k̂>1 — two-way calibration", () => {
    const s = makeSession();
    pair(s, 10000, "http://llama", 24000); // ratio 2.4
    assert.equal(s.stats.calibratedEstimate, undefined, "one sample must not publish");
    pair(s, 10000, "http://llama", 31000); // ratio 3.1
    assert.ok(Math.abs((s.stats.calibratedEstimate ?? 0) - 2.75) < 1e-9, `consistent under-estimate evidence publishes mean 2.75 unclamped, got ${s.stats.calibratedEstimate}`);
    assert.equal(s.stats.calibratedEstimateOrigin, "http://llama");
});

test("#2366 A: inflation is bounded at CLAMP_MAX 4, below the sample band max 5", () => {
    const s = makeSession();
    pair(s, 10000, "http://llama", 46000);
    pair(s, 10000, "http://llama", 48000);
    assert.equal(s.stats.calibratedEstimate, 4, "mean 4.7 clamps to 4");

    // A non-corresponding report (>5×) never enters the ring and cannot
    // disturb a published factor.
    pair(s, 10000, "http://llama", 60000);
    assert.equal(s.stats.calibratedEstimate, 4, "out-of-band sample leaves the factor intact");
    assert.deepEqual(s.stats.calibrationRing?.values, [4.6, 4.8], "ring untouched by the rejected sample");
});

test("#2366 A: applyEstimateCalibration moves both directions on the learned route only", () => {
    assert.equal(applyEstimateCalibration(10000, 2.75, "http://llama", "http://llama/v1/chat/completions"), 27500, "same route inflates");
    assert.equal(applyEstimateCalibration(10000, 0.5, "http://relay", "http://relay"), 5000, "deflate direction unchanged");
    assert.equal(applyEstimateCalibration(10000, 2.75, "http://other", "http://llama"), 10000, "cross-route stays raw");
});

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

interface CtxOverrides {
    lastInputTokens?: number;
    source?: string;
    contextTokensAt?: number;
    systemPromptTokens?: number;
}

function makeCtx(messages: CoreMessage[], o?: CtxOverrides): {
    core: ReturnType<typeof createCore>;
    config: ReturnType<typeof defaultConfig>;
    messages: CoreMessage[];
    session: Session;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "i2366-ctx",
            meta: {},
            stats: {
                requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0,
                lastInputTokens: o?.lastInputTokens ?? 0,
                ...(o?.source !== undefined ? { lastInputTokensSource: o.source as never } : {}),
                compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0,
                storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0,
            },
            metadata: {
                ...(o?.contextTokensAt !== undefined ? { contextTokensAt: o.contextTokensAt } : {}),
                ...(o?.systemPromptTokens !== undefined ? { systemPromptTokens: o.systemPromptTokens } : {}),
            },
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        } as unknown as Session,
    };
}

function asciiMsgs(count: number, charsPerMsg: number): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 1; i <= count; i++) msgs.push(textMsg(`raw_${i}`, i % 2 === 1 ? "user" : "assistant", "x".repeat(charsPerMsg)));
    return msgs;
}

function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

// 12 × 4000 ASCII chars → est-view total exactly 12000 tok (chars/4).
const MSGS = () => asciiMsgs(12, 4000);

test("#2366 B: acp_status shows the billed input next to the estimate view, with a divergence note at ratio ≥ 1.5", () => {
    const ctx = withRefs(makeCtx(MSGS(), { lastInputTokens: 30000, source: "usage", contextTokensAt: Date.now() }));
    const out = handleAcpStatus({}, ctx).text;
    assert.ok(out.includes("BILLED INPUT (upstream usage): 30000 tok"), `billed line present (got: ${out.slice(0, 400)})`);
    assert.ok(out.includes("est-view total 12000 tok · ratio 2.5×"), "estimate-view total + ratio rendered");
    assert.ok(out.includes("Judge context pressure from BILLED INPUT"), "divergence note present at ratio 2.5×");
    assert.ok(!out.includes("measured "), "fresh measurement carries no age suffix");
});

test("#2366 B: system-heavy sessions don't read as divergence — est view carries the system+tools overhead", () => {
    // 12,000 tok of message text + 20,000 tok system/tools vs billed 36,000:
    // message-only caliber would show 3.0× and blame the tokenizer; the
    // like-for-like caliber (32,000 incl. overhead) shows 1.1× → no note.
    const ctx = withRefs(makeCtx(MSGS(), { lastInputTokens: 36000, source: "usage", contextTokensAt: Date.now(), systemPromptTokens: 20000 }));
    const out = handleAcpStatus({}, ctx).text;
    assert.ok(out.includes("est-view total 32000 tok · ratio 1.1×"), `overhead folded into the est view (got: ${out.slice(0, 400)})`);
    assert.ok(!out.includes("Judge context pressure from BILLED INPUT"), "same-caliber ratio 1.1× < 1.5 → no divergence note");
});

test("#2366 B: stale measurement carries an age suffix; no note below ratio 1.5", () => {
    const stale = withRefs(makeCtx(MSGS(), { lastInputTokens: 15000, source: "usage", contextTokensAt: Date.now() - 30 * 60_000 }));
    const out = handleAcpStatus({}, stale).text;
    assert.ok(out.includes("BILLED INPUT (upstream usage): 15000 tok, measured 30m ago"), "age rendered for a 30m-old measurement");
    assert.ok(!out.includes("Judge context pressure from BILLED INPUT"), "ratio 1.25× < 1.5 → no divergence note");
});

test("#2366 B: estimate-grade anchors must not masquerade as billed input (#2029 class)", () => {
    // legacy session: a positive lastInputTokens WITHOUT a usage-grade source
    // is an estimate-grade value — statusInputBaseline returns 0, no line.
    const legacy = withRefs(makeCtx(MSGS(), { lastInputTokens: 150000 }));
    const out = handleAcpStatus({}, legacy).text;
    assert.ok(!out.includes("BILLED INPUT"), "no usage-grade anchor → no BILLED line");

    const fresh = withRefs(makeCtx(MSGS()));
    assert.ok(!handleAcpStatus({}, fresh).text.includes("BILLED INPUT"), "never-reporting upstream → no BILLED line");
});

test("#2366 B: overflow-arm readings are labelled as bounded, scope mode stays base-only", () => {
    const arm = withRefs(makeCtx(MSGS(), { lastInputTokens: 90000, source: "overflow-arm" }));
    assert.ok(handleAcpStatus({}, arm).text.includes("BILLED INPUT (overflow arm (bounded)): 90000 tok"), "bounded reading labelled distinctly");

    const scoped = withRefs(makeCtx(MSGS(), { lastInputTokens: 30000, source: "usage" }));
    const out = handleAcpStatus({ scope: "uncompressed" }, scoped).text;
    assert.ok(!out.includes("BILLED INPUT"), "scope= short-circuit returns the base report only");
});

test("#2366 B: PRESSURE NOTE fires at high billed pressure with exhausted compressible mass", () => {
    // 130000/200000 = 65% ≥ 0.6; the 12k-tok message list leaves far less than
    // the nudge growth threshold of compressible mass — the exact #2366 state
    // ("max compressible 13355 < threshold 50000" while usage climbed past 66%).
    const ctx = withRefs(makeCtx(MSGS(), { lastInputTokens: 130000, source: "usage", contextTokensAt: Date.now() }));
    const out = handleAcpStatus({}, ctx).text;
    assert.ok(out.includes("Nudge: idle"), `nudge idle in this state (got: ${out.slice(0, 400)})`);
    assert.ok(out.includes("PRESSURE NOTE"), "pressure note present");
    assert.ok(out.includes("% of the 200000-token limit"), "note names the limit");
    assert.ok(out.includes("continue the task instead of folding again"), "note advises against repeated small folds");
});

test("#2366 B: PRESSURE NOTE stays silent at low billed pressure", () => {
    const ctx = withRefs(makeCtx(MSGS(), { lastInputTokens: 30000, source: "usage", contextTokensAt: Date.now() }));
    const out = handleAcpStatus({}, ctx).text;
    assert.ok(out.includes("Nudge: idle"));
    assert.ok(!out.includes("PRESSURE NOTE"), "15% usage → no pressure note");
});

test("#2366 B: plain sessions keep today's output exactly (additive-only change)", () => {
    const ctx = withRefs(makeCtx(MSGS()));
    const out = handleAcpStatus({}, ctx).text;
    assert.ok(out.includes("Nudge:"), "nudge line still present");
    assert.ok(!out.includes("BILLED INPUT") && !out.includes("PRESSURE NOTE"), "no new sections without a usage-grade anchor");
});
