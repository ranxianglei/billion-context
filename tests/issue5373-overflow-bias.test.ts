// #5373 regression — DSH lane, 0.1.209: the local estimator under-counts a
// CJK-heavy payload while the declared completion reserve eats part of the
// window, so folding to raw ≤ (window − reserve) still overflows on EVERY
// forward: permanent 400 loop after a resume-miss. The overflow body STATES
// the true counts ("you requested N tokens (M in the messages, K in the
// completion)"). Before the fix those stated counts only seeded the
// calibration ring behind its ≥2-agreeing-samples publication rule — a fresh
// overflow-only session whose conversation keeps growing never gets a factor
// in time (incident: four forwards, sidecar traffic able to clobber the
// single-slot ring, and an armed fold comparator unsatisfiable under a
// clamped arm burning the whole ladder every cycle). The fix retains a
// provisional per-route bias at arm time and lets effectiveCalibration apply
// it (trigger, fold stop, output clamp — including the armed comparator)
// until the ring supersedes.
//
// What this pins (hermetic, deterministic — no timing):
//   A. the FIRST overflow retains the stated-calibre bias (ratio ≈ the real
//      billing gap) WITHOUT publishing the ring (single-sample discipline);
//   B. the NEXT grown turn is judged at stated calibre: its INITIAL forward
//      already fits the window instead of re-hitting it (unfixed code
//      forwards the raw-estimate payload, which bills over the window).
// The incident's full permanence additionally required interruptions
// (client disconnects mid-ladder, a stuck summarize holding the request for
// minutes) which a hermetic suite cannot reproduce without timing flakiness;
// see the issue thread. The mock bills ALL body strings at RATIO × the local
// estimator formula (the provider tokenizer gap); the rescue response
// carries NO usage (mainSeen gate) so the arm persists across turns on both
// branches — the regime the fix changes.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
process.env.NODE_ENV = "test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import {
    CALIBRATION_CLAMP_MAX,
    CALIBRATION_CLAMP_MIN,
    calibrationOriginApplies,
    effectiveCalibration,
} from "../src/util.ts";

const WINDOW = 100_000;
const MAX_TOKENS = 20_000;
const TARGET = WINDOW - MAX_TOKENS; // 80,000 — the judging limit bili folds to
const RATIO = 1.3; // upstream billing multiplier vs the local estimate
const HISTORY_TURNS = 80; // ~61k est units of completed CJK turns (~67k incl. overhead)
const GROWTH = 10_000; // per-turn content growth in local estimator units (CJK chars)
// 1×1 PNG — decoded dims feed the pixels billing prior (85 + 170 tiles),
// giving the payload a small positive image reserve.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FILLER = "上下文压缩回归测试语料填充片段";

// Same formula family as the local estimator: CJK = 1 token/char, rest /4.
function estUnits(text: string): number {
    let cjk = 0;
    let rest = 0;
    for (const ch of text) (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? cjk++ : rest++);
    return cjk + Math.ceil(rest / 4);
}

// Bills EVERY string in the body at RATIO × the local estimator formula —
// the same basis family as bili's own estimate (messages + system + tools +
// wire residue), scaled up by the provider's tokenizer gap (#5373's core
// asymmetry). Bili's estimate additionally carries overhead ON TOP of the
// string mass, so a calibrated fold-stop (raw×ratio < target) guarantees the
// billed total fits, while a raw-estimate stop overshoots.
function collectStrings(v: unknown, out: string[]): void {
    if (typeof v === "string") { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) collectStrings(x, out); return; }
    if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out);
}

function billBody(body: unknown): number {
    const strs: string[] = [];
    collectStrings(body, strs);
    return Math.round(strs.reduce((a, s) => a + estUnits(s), 0) * RATIO);
}

type MockCall = { kind: "main" | "summary"; billed: number };

async function startMock(): Promise<{ port: number; close(): Promise<void>; calls: MockCall[] }> {
    const calls: MockCall[] = [];
    let mainSeen = 0;
    const srv = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let body: unknown = {};
            try { body = JSON.parse(raw); } catch { /* unparseable body bills zero */ }
            const b = body as Record<string, unknown>;
            const billed = billBody(b);
            const mt = typeof b.max_tokens === "number" ? b.max_tokens : 0;
            const isSummary = Array.isArray(b.messages) && b.messages.length === 1 && b.system !== undefined;
            calls.push({ kind: isSummary ? "summary" : "main", billed });
            if (!isSummary && billed + mt > WINDOW) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    error: {
                        type: "invalid_request_error",
                        code: "context_length_exceeded",
                        message: `This model's maximum context length is ${WINDOW} tokens. However, you requested ${billed + mt} tokens (${billed} in the messages, ${mt} in the completion). Please reduce the length of the inputs or output.`,
                    },
                }));
                return;
            }
            mainSeen += !isSummary ? 1 : 0;
            // Only the FIRST successful main response carries usage: the
            // session's overflow arm therefore stays armed (no usage settle
            // retires it) and the ring cannot complete from usage — the
            // persistent-arm regime the fix must steer.
            const withUsage = mainSeen <= 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "msg_mock",
                type: "message",
                role: "assistant",
                model: typeof b.model === "string" ? b.model : "claude-test",
                content: [{ type: "text", text: isSummary
                    ? "历史对话摘要：多轮上下文压缩回归测试语料已压缩为要点，完整保留了每一轮的关键结论、编号、决定与引用关系，供后续轮次继续引用核对。"
                    : "好的，收到。" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                ...(withUsage ? { usage: { input_tokens: billed, output_tokens: 5 } } : {}),
            }));
        });
    });
    srv.listen(0, "127.0.0.1");
    await once(srv, "listening");
    const port = (srv.address() as { port: number }).port;
    return { port, calls, close: async () => { await new Promise<void>((r) => srv.close(() => r())); } };
}

// HISTORY_TURNS completed CJK turns plus a FINAL unpaired user question
// carrying the image — the live turn is never a fold candidate, so the image
// reserve survives every preflight walk.
function buildHistory(turns: number): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < turns; i++) {
        msgs.push({ role: "user", content: `第${i}轮提问：${FILLER.repeat(25)}` });
        msgs.push({ role: "assistant", content: `第${i}轮回答：${FILLER.repeat(25)}` });
    }
    msgs.push({
        role: "user",
        content: [
            { type: "text", text: `第${turns}轮提问（附图）：${FILLER.repeat(5)}` },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } },
        ],
    });
    return msgs;
}

async function sendTurn(url: string, sid: string, model: string, messages: Array<Record<string, unknown>>): Promise<{ status: number; text: string }> {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sid },
        body: JSON.stringify({ model, max_tokens: MAX_TOKENS, stream: false, messages }),
    });
    return { status: r.status, text: await r.text() };
}

function baseOptions(upPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upPort}`]: { models: { "claude-test": { context: WINDOW } } },
        },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        compat: { roles: {} },
        sessionHeader: "x-acp-session",
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

async function boundPort(proxy: Awaited<ReturnType<typeof startServer>>): Promise<number> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const addr = proxy.address();
        if (addr && typeof addr === "object") return addr.port;
        if (Date.now() > deadline) throw new Error("proxy never bound a port");
        await new Promise((r) => setTimeout(r, 25));
    }
}

function statsNow(): Record<string, unknown> {
    return (listSessions()[0]?.stats ?? {}) as Record<string, unknown>;
}

async function stopAll(proxy: Awaited<ReturnType<typeof startServer>>, up: Awaited<ReturnType<typeof startMock>>): Promise<void> {
    proxy.close();
    proxy.closeIdleConnections?.();
    await once(proxy, "close");
    await up.close();
}

// --- unit: effectiveCalibration gates -------------------------------------

test("effectiveCalibration: ring-published k̂ wins when applicable to the route", () => {
    const stats = {
        calibratedEstimate: 1.2,
        calibratedEstimateOrigin: "https://a.com",
        overflowBias: { ratio: 1.9, origin: "https://a.com" },
    };
    assert.deepEqual(effectiveCalibration(stats, undefined, "https://a.com/v1/messages"), { k: 1.2, origin: "https://a.com" });
});

test("effectiveCalibration: ring factor for another route falls through to the route's overflow bias", () => {
    const stats = {
        calibratedEstimate: 1.2,
        calibratedEstimateOrigin: "https://a.com",
        overflowBias: { ratio: 1.3, origin: "https://b.com" },
    };
    assert.deepEqual(effectiveCalibration(stats, undefined, "https://b.com/v1/messages"), { k: 1.3, origin: "https://b.com" });
});

test("effectiveCalibration: no applicable evidence → absent (raw estimate)", () => {
    const stats = {
        calibratedEstimate: 1.2,
        calibratedEstimateOrigin: "https://a.com",
        overflowBias: { ratio: 1.3, origin: "https://b.com" },
    };
    assert.deepEqual(effectiveCalibration(stats, undefined, "https://c.com"), { k: undefined, origin: undefined });
    assert.deepEqual(effectiveCalibration({}, undefined, "https://a.com"), { k: undefined, origin: undefined });
});

test("effectiveCalibration: bias model gate mirrors the ring rule", () => {
    const bias = { ratio: 1.3, origin: "https://a.com", model: "m-main" };
    assert.equal(effectiveCalibration({ overflowBias: bias }, "m-other", "https://a.com").k, undefined);
    assert.equal(effectiveCalibration({ overflowBias: bias }, "m-main", "https://a.com").k, 1.3);
    assert.equal(effectiveCalibration({ overflowBias: bias }, undefined, "https://a.com").k, 1.3);
});

test("effectiveCalibration: factors are clamped into the learning band", () => {
    const o = "https://a.com";
    assert.equal(effectiveCalibration({ overflowBias: { ratio: 9, origin: o } }, undefined, o).k, CALIBRATION_CLAMP_MAX);
    assert.equal(effectiveCalibration({ overflowBias: { ratio: 0.05, origin: o } }, undefined, o).k, CALIBRATION_CLAMP_MIN);
    for (const bad of [NaN, -1, Infinity]) {
        assert.equal(effectiveCalibration({ overflowBias: { ratio: bad, origin: o } }, undefined, o).k, undefined);
    }
});

test("effectiveCalibration: a band-clamped (view-mismatched) bias does not steer", () => {
    // #3450 shape: upstream stated ≥4× bili's own view of the payload — the
    // count describes content bili does not hold; steering folds off it would
    // skip the burn-and-net master relied on. Treated as absent.
    const o = "https://a.com";
    const mismatched = { ratio: CALIBRATION_CLAMP_MAX, origin: o, mismatched: true };
    assert.deepEqual(effectiveCalibration({ overflowBias: mismatched }, undefined, o), { k: undefined, origin: undefined });
    // A ring-published factor still wins over a mismatched bias (precedence unchanged).
    assert.equal(effectiveCalibration({ calibratedEstimate: 1.3, calibratedEstimateOrigin: o, overflowBias: mismatched }, undefined, o).k, 1.3);
    // The same numeric ratio WITHOUT the flag steers (the flag is the writer's verdict).
    assert.equal(effectiveCalibration({ overflowBias: { ratio: CALIBRATION_CLAMP_MAX, origin: o } }, undefined, o).k, CALIBRATION_CLAMP_MAX);
});

test("calibrationOriginApplies: normalized equality only", () => {
    assert.ok(calibrationOriginApplies("https://a.com", "https://a.com/v1/messages"));
    assert.ok(!calibrationOriginApplies("https://a.com", "https://b.com"));
    assert.ok(!calibrationOriginApplies(undefined, "https://a.com"));
    assert.ok(!calibrationOriginApplies("https://a.com", undefined));
});

// --- e2e: the real pipeline through DeepSeek-shaped overflows -------------

test("#5373 mechanism: the first overflow retains a stated-calibre bias without publishing the ring", { timeout: 240_000 }, async () => {
    const up = await startMock();
    const proxy = await startServer(baseOptions(up.port));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const port = await boundPort(proxy);
    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${up.port}/v1/messages`;
        const r = await sendTurn(url, "s5373-mech", "claude-test", buildHistory(HISTORY_TURNS));
        assert.equal(r.status, 400, `first forward must overflow (test precondition), got ${r.status}: ${r.text.slice(0, 200)}`);
        const st = statsNow();
        assert.equal(st.lastInputTokensSource, "overflow-arm", "arm not recorded after first overflow");
        const bias = st.overflowBias as { ratio: number; origin: string; model?: string; measured: number; estimate: number } | undefined;
        assert.ok(bias, "overflow-stated bias was not retained at arm time");
        assert.ok(bias.ratio > 1.1 && bias.ratio < 1.5, `bias ratio ${bias.ratio} not near RATIO ${RATIO}`);
        assert.equal(bias.model, "claude-test");
        assert.ok(bias.measured > 0 && bias.estimate >= 2000, `bias evidence malformed: ${JSON.stringify(bias)}`);
        const ring = st.calibrationRing as { values: number[] } | undefined;
        assert.ok(ring && ring.values.length === 1, `ring must hold exactly the one overflow sample, got ${JSON.stringify(ring)}`);
        assert.equal(st.calibratedEstimate, undefined, "single sample must not publish the ring yet");
    } finally {
        await stopAll(proxy, up);
    }
});

test("#5373 regression: the grown turn after an overflow fits on its initial forward", { timeout: 300_000 }, async () => {
    const up = await startMock();
    const proxy = await startServer(baseOptions(up.port));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const port = await boundPort(proxy);
    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${up.port}/v1/messages`;
        const sid = "s5373-steer";
        const messages = buildHistory(HISTORY_TURNS);
        const t1 = await sendTurn(url, sid, "claude-test", messages);
        assert.equal(t1.status, 400, `first forward must overflow (test precondition), got ${t1.status}: ${t1.text.slice(0, 200)}`);
        const st1 = statsNow();
        assert.equal(st1.lastInputTokensSource, "overflow-arm", "first overflow must arm the session (persistent-arm precondition)");
        const bias1 = st1.overflowBias as { ratio: number } | undefined;
        assert.ok(bias1 && bias1.ratio > 1.1, `turn-1 bias missing (stated counts never retained): ${JSON.stringify(st1.overflowBias)}`);

        // The conversation keeps growing (dsh appends new user content every
        // turn; incident req C→D grew ~50k est). Unfixed code judges this
        // turn at raw-estimate calibre: the floor sits a hair below budget
        // (arm headroom clamp) and the raw channel is below it too, so no
        // preflight fires and the INITIAL forward bills over the window.
        // Fixed code judges it at stated calibre (raw × bias ≥ budget) and
        // folds before forwarding, so the initial forward already fits.
        const mainsBefore = up.calls.filter((c) => c.kind === "main").length;
        const sumsBefore = up.calls.filter((c) => c.kind === "summary").length;
        messages.push({ role: "user", content: `[g2] ${FILLER.repeat(GROWTH / 15)}` });
        const t2 = await sendTurn(url, sid, "claude-test", messages);
        const mainsT2 = up.calls.filter((c) => c.kind === "main").slice(mainsBefore);
        const sumsT2 = up.calls.filter((c) => c.kind === "summary").length - sumsBefore;
        console.error(`# STEER TRACE: T2=${t2.status} mains=${JSON.stringify(mainsT2.map((c) => c.billed))} summarizeCalls=${sumsT2}`);
        assert.equal(t2.status, 200, `grown turn must recover, got ${t2.status}: ${t2.text.slice(0, 200)}`);
        for (const m of mainsT2) {
            assert.ok(m.billed <= TARGET,
                `a grown-turn forward billed ${m.billed} (> judging limit ${TARGET}): the stated counts did not steer the fold target (#5373)`);
        }
        assert.ok(sumsT2 <= 4, `grown turn burned ${sumsT2} summarize calls: fold work must stay bounded under the arm`);

        // Shared invariant (both branches): by the second turn the learning
        // loop has completed — a factor is published and the arm retired by
        // the usage settle.
        const st2 = statsNow();
        const k2 = st2.calibratedEstimate as number | undefined;
        assert.ok(k2 !== undefined && k2 > 1.1 && k2 < 1.45, `expected a published factor after two overflows, got ${JSON.stringify(k2)} (ring=${JSON.stringify(st2.calibrationRing)})`);
        assert.equal(st2.lastInputTokensSource, "usage", "successful usage must retire the overflow arm");
    } finally {
        await stopAll(proxy, up);
    }
});
