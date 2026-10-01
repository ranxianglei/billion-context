import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { diagnoseSuccessWithoutUsage, listSessions, reanchorNudgeOnUsageDrop, storeEffectiveConfig, _resetSessionsForTest } from "../src/session.ts";
import { applyUsageSample } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #1595: when an upstream failure (network / 5xx) arms emergency shrink, the
// next prepare feeds an ESTIMATE-grade reading into the kernel, which can then
// stamp the nudge's lastNudgeShownTokens at a phantom-high level. The kernel's
// own downward re-anchor compares against the BASELINE only, while its growth
// decision prefers lastNudgeShownTokens whenever that is non-zero — so once
// real usage settles far below the phantom, every later growth calculation runs
// against the phantom (permanently negative) and the tier cadence is blocked
// until context regrows past the phantom level or a compression resets the refs.
// Fix (host-side; all lanes share settleUsageReport): when a REAL usage-grade
// sample lands more than one full growth interval below the current reference,
// retire the stale reference with the kernel drift-reset trio semantics. Plus a
// once-per-session diagnostic for the third silent no-usage shape: upstream
// SUCCESS completing without reporting input usage (transport failures and 5xx
// already log their own arms).
// Pins:
//   unit A-F: helper math (margin, within-margin boundary, no-ref no-op,
//             owner-flattened margin, once-per-session diagnostic, plugin-lane
//             settle wiring);
//   I-A: full repro through the proxy SSE lane — poisoned estimate baseline +
//        phantom-shown reference, then a real small usage report retires it;
//   I-B: streaming success without usage → exactly one [acp-loop] diagnostic;
//   I-C: non-streaming JSON success without usage → [proxy-json] diagnostic.

const WINDOW = 120_000;
const PHANTOM = 600_000; // mirrors the reported 500k-class inflated estimate

function makeSession(): Session {
    return {
        id: "issue1595-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function captureLogs<T>(fn: () => T): { lines: string[]; result: T } {
    const lines: string[] = [];
    setLogCapture((_level, msg) => { lines.push(msg); });
    try {
        const result = fn();
        return { lines, result };
    } finally {
        setLogCapture(null);
    }
}

test("#1595 unit A: usage-grade drop beyond one interval retires a stale-high shown reference", () => {
    const s = makeSession();
    s.stats.lastInputTokens = 100_000;
    s.state.nudge.lastNudgeShownTokens = PHANTOM;
    s.state.nudge.lastPerMessageNudgeTokens = 135_000; // healthy low baseline (repro shape)
    const { lines } = captureLogs(() => reanchorNudgeOnUsageDrop(s));
    assert.equal(s.state.nudge.lastNudgeShownTokens, 0, "shown reference cleared");
    assert.equal(s.state.nudge.lastPerMessageNudgeTokens, 100_000, "baseline re-anchored to the real value");
    assert.deepEqual(s.state.nudge.lastShownByTier, {}, "per-tier stamps cleared");
    assert.ok(lines.some((l) => l.includes("nudge reference re-anchored 600000 -> 100000")), `re-anchor log missing: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.includes("(margin 50000)")), "default flat 50k margin");
});

test("#1595 unit B: a drop within one growth interval leaves the reference alone", () => {
    const s = makeSession();
    s.stats.lastInputTokens = 570_000; // 30k below the reference — inside the 50k margin
    s.state.nudge.lastNudgeShownTokens = PHANTOM;
    s.state.nudge.lastPerMessageNudgeTokens = 135_000;
    const { lines } = captureLogs(() => reanchorNudgeOnUsageDrop(s));
    assert.equal(s.state.nudge.lastNudgeShownTokens, PHANTOM, "within-margin drop must not retire the reference");
    assert.equal(s.state.nudge.lastPerMessageNudgeTokens, 135_000, "baseline untouched");
    assert.ok(!lines.some((l) => l.includes("re-anchored")), `unexpected re-anchor: ${JSON.stringify(lines)}`);
});

test("#1595 unit C: no live reference is a no-op", () => {
    const s = makeSession();
    s.stats.lastInputTokens = 100_000;
    const { lines } = captureLogs(() => reanchorNudgeOnUsageDrop(s));
    assert.deepEqual(s.state.nudge, createInitialState().nudge, "fresh nudge state untouched");
    assert.ok(!lines.some((l) => l.includes("re-anchored")), `unexpected re-anchor: ${JSON.stringify(lines)}`);
});

test("#1595 unit D: margin follows the owner-flattened stamped config", () => {
    const s = makeSession();
    const cfg = defaultConfig(272_000);
    cfg.nudge.growthFloor = cfg.nudge.growthCap = 20_000; // compress.nudgeGrowthTokens-style flatten
    storeEffectiveConfig(s, cfg);
    s.stats.lastInputTokens = 575_000; // 25k below — beyond the 20k margin, inside the default 50k
    s.state.nudge.lastNudgeShownTokens = PHANTOM;
    const { lines } = captureLogs(() => reanchorNudgeOnUsageDrop(s));
    assert.equal(s.state.nudge.lastNudgeShownTokens, 0, "flattened margin must tighten the trigger");
    assert.ok(lines.some((l) => l.includes("(margin 20000)")), `expected 20k margin in log: ${JSON.stringify(lines)}`);
});

test("#1595 unit E: success-without-usage diagnostic warns once per session", () => {
    const s = makeSession();
    const { lines } = captureLogs(() => {
        diagnoseSuccessWithoutUsage(s, "acp-loop");
        diagnoseSuccessWithoutUsage(s, "acp-loop");
        diagnoseSuccessWithoutUsage(s, "proxy-json");
    });
    const hits = lines.filter((l) => l.includes("upstream success without usage report"));
    assert.equal(hits.length, 1, `expected exactly one diagnostic, got ${JSON.stringify(hits)}`);
    assert.ok(hits[0].includes("[acp-loop]"), "first wire wins the once-per-session slot");
    assert.ok(hits[0].includes("keeping lastInputTokens="), `diagnostic text: ${hits[0]}`);
});

test("#1595 unit F: plugin-lane settle (applyUsageSample) retires a stale-high reference too", () => {
    const s = makeSession();
    s.stats.lastInputTokens = PHANTOM;
    s.stats.lastInputTokensSource = "estimate";
    s.state.nudge.lastNudgeShownTokens = PHANTOM;
    s.state.nudge.lastShownByTier = { 1: PHANTOM };
    captureLogs(() => applyUsageSample(s, { inputTokens: 5000, outputTokens: 12 }, "anthropic"));
    assert.equal(s.stats.lastInputTokens, 5000, "real sample overwrote the armed estimate");
    assert.equal(s.stats.lastInputTokensSource, "usage");
    assert.equal(s.state.nudge.lastNudgeShownTokens, 0, "plugin pipe must route through the shared re-anchor");
    assert.equal(s.state.nudge.lastPerMessageNudgeTokens, 5000);
    assert.deepEqual(s.state.nudge.lastShownByTier, {});
});

// ---------------------------------------------------------------------------
// Integration: real proxy + mock relay, Anthropic wire, 120k window so the
// kernel's absolute-token zones stay out of the fixture's way (#1119/#1492).
// ---------------------------------------------------------------------------

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 5000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function okSseNoUsage(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant" } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function summaryJson(withUsage: boolean): string {
    const j: Record<string, unknown> = {
        id: "msg_summary",
        type: "message",
        role: "assistant",
        model: "claude-relay",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
    };
    if (withUsage) j.usage = { input_tokens: 500, output_tokens: 50 };
    return JSON.stringify(j);
}

// ~44k chars of ASCII code text: well below every nudge percentage band of the
// 120k window, so no preflight/nudge fires off the payload itself.
const LINE = (i: number) =>
    `const handler_${i} = (req: Request, res: Response) => { res.status(200).json({ status: "ok", id: ${i}, ts: Date.now() }); };`;
const HEAVY = (i: number) => `CODE_${i}_` + LINE(i).repeat(62);

type Msg = { role: string; content: unknown };

function baseConversation(): Msg[] {
    const msgs: Msg[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: i < 6 ? HEAVY(i) : `note_${i}_short tail ${i}` });
    }
    return msgs;
}

/** Mock relay: always 200; serves streaming turns (SSE body) and non-stream
 *  calls (JSON body), records what it received. */
function makeRelay(streamBody: string, jsonBody: string) {
    const received: Buffer[] = [];
    let nonStream = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            received.push(raw);
            let parsed: Record<string, unknown> = {};
            try {
                parsed = JSON.parse(raw.toString("utf8"));
            } catch {
                /* non-JSON — treat as streaming forward */
            }
            if (parsed.stream !== true) {
                nonStream += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(jsonBody);
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(streamBody);
        });
    });
    return { server, received, nonStreamCalls: () => nonStream };
}

async function withProxy(sessionId: string, streamBody: string, jsonBody: string, fn: (url: string, logs: string[]) => Promise<void>): Promise<void> {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const relay = makeRelay(streamBody, jsonBody);
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-relay": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    try {
        await fn(`http://127.0.0.1:${proxy.address().port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, logs);
    } finally {
        setLogCapture(null);
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
}

test("#1595 I-A: real usage report retires a phantom-high nudge reference armed by a failed turn", async () => {
    await withProxy("issue1595-iA", okSse(), summaryJson(true), async (url, logs) => {
        const headers = { "content-type": "application/json", "x-acp-session": "issue1595-iA" };
        const base = baseConversation();
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: base }) });
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();

        const s = listSessions().find((x) => x.stats.lastInputTokens === 5000);
        assert.ok(s, "turn 1 reported usage (lastInputTokens = 5000)");
        // Poison exactly what the failure sequence leaves behind: armFailureShrink's
        // estimate-grade lastInputTokens plus the phantom-shown reference the
        // following estimate-grade prepare stamped into the kernel.
        s!.stats.lastInputTokens = PHANTOM;
        s!.stats.lastInputTokensSource = "estimate";
        s!.state.nudge.lastNudgeShownTokens = PHANTOM;
        s!.state.nudge.lastShownByTier = { 1: PHANTOM };

        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok, done." }, { role: "user", content: "step two?" }];
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: msgs2 }) });
        assert.equal(r2.status, 200, "turn 2 succeeds");
        await r2.text();

        const s2 = listSessions().find((x) => x.id === s!.id)!;
        assert.equal(s2.stats.lastInputTokens, 5000, "real usage report overwrote the armed estimate");
        assert.equal(s2.stats.lastInputTokensSource, "usage", "provenance flipped back to usage");
        assert.ok(logs.some((l) => l.includes("nudge reference re-anchored 600000 -> 5000")), `re-anchor log missing: ${JSON.stringify(logs.filter((l) => l.includes("re-anchor")))}`);
        assert.equal(s2.state.nudge.lastNudgeShownTokens, 0, "phantom shown reference retired");
        assert.equal(s2.state.nudge.lastPerMessageNudgeTokens, 5000, "baseline re-anchored to reality");
        assert.deepEqual(s2.state.nudge.lastShownByTier, {}, "per-tier stamps cleared");
    });
});

test("#1595 I-B: streaming success without usage names itself once per session", async () => {
    await withProxy("issue1595-iB", okSseNoUsage(), summaryJson(true), async (url, logs) => {
        const headers = { "content-type": "application/json", "x-acp-session": "issue1595-iB" };
        const base = baseConversation();
        for (let i = 0; i < 2; i++) {
            const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: base }) });
            assert.equal(r.status, 200, `turn ${i + 1} succeeds`);
            await r.text();
        }
        const hits = logs.filter((l) => l.includes("upstream success without usage report"));
        assert.equal(hits.length, 1, `expected one [acp-loop] diagnostic across two turns, got ${JSON.stringify(hits)}`);
        assert.ok(hits[0].includes("[acp-loop]"), `diagnostic wire label: ${hits[0]}`);
    });
});

test("#1595 I-C: non-streaming JSON success without usage names itself", async () => {
    await withProxy("issue1595-iC", okSse(), summaryJson(false), async (url, logs) => {
        const headers = { "content-type": "application/json", "x-acp-session": "issue1595-iC" };
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: false, system: "You are a helpful assistant.", messages: baseConversation() }) });
        assert.equal(r.status, 200, "non-stream turn succeeds");
        await r.text();
        const hits = logs.filter((l) => l.includes("upstream success without usage report"));
        assert.equal(hits.length, 1, `expected one [proxy-json] diagnostic, got ${JSON.stringify(hits)}`);
        assert.ok(hits[0].includes("[proxy-json]"), `diagnostic wire label: ${hits[0]}`);
    });
});
