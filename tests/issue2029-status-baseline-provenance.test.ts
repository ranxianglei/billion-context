// #2029: status readers must share the provenance-aware input baseline. The
// main request path refused estimate-grade failure baselines in #1839/#1846
// (effectiveTokenCount), but the status-side readers kept passing raw
// stats.lastInputTokens into processTurn — a no-usage failure or preflight
// write-back could raise it to an estimate-grade phantom (repro: 60k real /
// 174k estimate → false 116% emergency in the panel for a 150k window). These
// tests pin the exact tokenCount each reader hands to the kernel across the
// provenance matrix, plus stats/state read-only-ness of the status surfaces.
// The JSON observation contract (contextTokens/contextTokensSource) is owned
// by #2017 and deliberately not asserted here.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { zeroStats, _resetSessionsForTest, getSession, statusInputBaseline, type Session } from "../src/session.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { handlePluginStatus, _resetPluginStateForTest, rememberPluginMessages } from "../src/plugin.ts";

const WINDOW = 150000;

type Scenario = {
    name: string;
    stats: Partial<Session["stats"]>;
    expected: number;
    // real (trusted-source) over-window pressure must survive unclamped
    emergencyPct?: string;
    // expected panel Context-line rendering for the baseline
    panelPct?: string;
    panelFmt?: string;
};

const SCENARIOS: Scenario[] = [
    { name: "estimate-grade failure baseline falls back to the retained real anchor (issue repro)", stats: { lastInputTokens: 174000, lastInputTokensSource: "estimate", lastUsageGradeTokens: 60000 }, expected: 60000, panelPct: "40", panelFmt: "60k" },
    { name: "estimate-grade baseline without any real anchor is unknown (0)", stats: { lastInputTokens: 174000, lastInputTokensSource: "estimate" }, expected: 0, panelPct: "0", panelFmt: "0" },
    { name: "legacy unflagged baseline falls back to the retained real anchor", stats: { lastInputTokens: 174000, lastUsageGradeTokens: 60000 }, expected: 60000, panelPct: "40", panelFmt: "60k" },
    { name: "legacy unflagged baseline without any real anchor is unknown (0)", stats: { lastInputTokens: 174000 }, expected: 0, panelPct: "0", panelFmt: "0" },
    { name: "real over-window usage stays verbatim (never clamped)", stats: { lastInputTokens: 174000, lastInputTokensSource: "usage" }, expected: 174000, emergencyPct: "116%", panelPct: "116", panelFmt: "174k" },
    { name: "credit-adjusted measured value wins over the older anchor", stats: { lastInputTokens: 30000, lastInputTokensSource: "usage", lastUsageGradeTokens: 60000 }, expected: 30000, panelPct: "20", panelFmt: "30k" },
    { name: "bounded overflow-arm value passes through", stats: { lastInputTokens: 150000, lastInputTokensSource: "overflow-arm" }, expected: 150000, emergencyPct: "100%", panelPct: "100", panelFmt: "150k" },
    { name: "trusted source drained to zero keeps its verbatim value (no stale-anchor fallback)", stats: { lastInputTokens: 0, lastInputTokensSource: "usage", lastUsageGradeTokens: 80000 }, expected: 0, panelPct: "0", panelFmt: "0" },
];

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function twelveMessages(): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 1; i <= 12; i++) {
        msgs.push(textMsg(`raw_${i}`, i % 2 === 1 ? "user" : "assistant", "x".repeat(5000)));
    }
    return msgs;
}

function captureTokenCounts(core: ReturnType<typeof createCore>): number[] {
    const seen: number[] = [];
    const orig = core.processTurn.bind(core);
    core.processTurn = (input: Parameters<typeof orig>[0]) => {
        seen.push(input.tokenCount);
        return orig(input);
    };
    return seen;
}

// stable snapshot that survives Map-valued state fields
function snap(v: unknown): string {
    return JSON.stringify(v, (_k, x) => (x instanceof Map ? Object.fromEntries(x) : x));
}

function makeAcpCtx(stats: Session["stats"]) {
    const messages = twelveMessages();
    const refs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    const session: Session = {
        id: "issue2029-acp",
        meta: {},
        stats,
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
    session.state.messageRefs = refs.map;
    const core = createCore();
    const seen = captureTokenCounts(core);
    return { core, config: defaultConfig(WINDOW), messages, session, log: () => {}, seen };
}

test("#2029: statusInputBaseline selects the baseline by provenance", () => {
    for (const sc of SCENARIOS) {
        const session = { stats: { ...zeroStats(), ...sc.stats } } as Session;
        assert.equal(statusInputBaseline(session), sc.expected, sc.name);
    }
});

test("#2029: acp_status nudge recompute feeds the provenance-aware baseline", () => {
    for (const sc of SCENARIOS) {
        const stats = { ...zeroStats(), ...sc.stats } as Session["stats"];
        const ctx = makeAcpCtx(stats);
        const statsBefore = snap(ctx.session.stats);
        const stateBefore = snap(ctx.session.state);
        const out = handleAcpStatus({}, ctx);
        // #4331 added the uncovered-history audit, which runs its own
        // processTurn passes on this surface — the contract is that EVERY
        // kernel call on a status reader feeds the provenance-aware baseline,
        // not that there is exactly one call.
        assert.ok(ctx.seen.length >= 1 && ctx.seen.every((v) => v === sc.expected),
            `${sc.name}: every kernel call fed the provenance-aware baseline (got ${JSON.stringify(ctx.seen)})`);
        assert.equal(snap(ctx.session.stats), statsBefore, `${sc.name}: stats must stay read-only`);
        assert.equal(snap(ctx.session.state), stateBefore, `${sc.name}: state must stay read-only`);
        const nudgeLine = out.text.split("\n").find((l) => l.startsWith("Nudge:"));
        assert.ok(nudgeLine, `${sc.name}: nudge line rendered`);
        if (sc.emergencyPct) {
            assert.ok(nudgeLine.includes("EMERGENCY") && nudgeLine.includes(sc.emergencyPct),
                `${sc.name}: real over-window pressure preserved unclamped (got: ${nudgeLine})`);
        } else {
            assert.ok(!nudgeLine.includes("EMERGENCY") && !nudgeLine.includes("OVER-LIMIT"),
                `${sc.name}: no phantom pressure (got: ${nudgeLine})`);
        }
    }
});

function mockRes(): { res: http.ServerResponse; status: number; body: string } {
    const out = { res: undefined as unknown as http.ServerResponse, status: 0, body: "" };
    const res = {
        writeHead(code: number) { out.status = code; return res; },
        end(chunk?: unknown) { if (typeof chunk === "string") out.body = chunk; return res; },
    } as unknown as http.ServerResponse;
    out.res = res;
    return out;
}

test("#2029: plugin status nudge + panel feed the provenance-aware baseline", () => {
    _resetSessionsForTest();
    _resetPluginStateForTest();
    try {
        SCENARIOS.forEach((sc, i) => {
            const session = getSession(`issue2029-plugin-${i}`, { protocol: "anthropic" });
            session.metadata.effectiveContextLimit = WINDOW;
            session.stats = { ...zeroStats(), ...sc.stats } as Session["stats"];
            const messages = twelveMessages();
            const refs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
            session.state.messageRefs = refs.map;
            rememberPluginMessages(session.id, messages, messages);

            const deps = { core: createCore(), config: defaultConfig(WINDOW), log: () => {} };
            const seen = captureTokenCounts(deps.core);
            const r = mockRes();
            handlePluginStatus(session.id, r.res, deps);
            assert.equal(r.status, 200, `${sc.name}: status answered`);
            assert.deepStrictEqual(seen, [sc.expected], `${sc.name}: nudge recompute tokenCount`);
            const panel = JSON.parse(r.body).panel as string | undefined;
            assert.ok(panel, `${sc.name}: panel rendered`);
            if (sc.panelPct !== undefined) {
                assert.match(panel, new RegExp(`Context \\(session accounting, host footer scale\\): ${sc.panelPct}% \\(${sc.panelFmt} / 150k\\)`),
                    `${sc.name}: panel Context line reflects the baseline (panel: ${panel.slice(0, 200)})`);
            }
            const nudgeLine = panel.split("\n").find((l) => l.startsWith("Nudge:"));
            assert.ok(nudgeLine, `${sc.name}: panel nudge line rendered`);
            if (sc.emergencyPct) {
                assert.ok(nudgeLine.includes("EMERGENCY") && nudgeLine.includes(sc.emergencyPct),
                    `${sc.name}: real over-window pressure preserved unclamped (got: ${nudgeLine})`);
            } else {
                assert.ok(!nudgeLine.includes("EMERGENCY") && !nudgeLine.includes("OVER-LIMIT"),
                    `${sc.name}: no phantom pressure (got: ${nudgeLine})`);
            }
        });
    } finally {
        _resetSessionsForTest();
        _resetPluginStateForTest();
    }
});
