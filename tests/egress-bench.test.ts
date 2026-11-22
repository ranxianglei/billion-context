// #7474/#7475: resident performance gate for the egress plane (ruling 7439).
//
// What it pins: the per-turn cost of a GROWING pinned plugin session with the
// egress plane ON must stay within 20% of the baseline recorded in
// tests/e2e/bench/egress-bench.baseline.json. The baseline is the
// post-fix shape (window re-anchor delta + lazy messages projection + frozen
// envelope): per-turn cost stays O(live window) — NOT O(ledger rows) — as the
// session grows. Any regression to the full-table path (remap over all rows,
// double ingest, drift-latched full saves) shows up as a >20% p50 growth and
// FAILS this test.
//
// Method (same shape as the #6785 perf validation, perf/replay-fold.mjs):
//   - one fake upstream that plays a well-behaved compression model: it scans
//     the acp refs in the forwarded body and, once the live span grows past
//     GROWTH refs since the last fold, answers ONE compress tool call
//     covering [minRef, maxRef-KEEP];
//   - the driver emulates the plugin host: after a compress call it FOLDS
//     client-side (dead span -> one summary block + the last KEEP messages)
//     and clears the watermark (full re-anchor next turn) — exactly like a
//     real host, so the wire stays bounded (~KEEP messages, ~0.8MB) while the
//     server ledger keeps growing (folded rows are never un-ingested);
//   - one real bili proxy (in-process, egressPlane ON via BILI_ROLLOUT_EGRESS_PLANE,
//     unified storage full, fresh XDG root per run, port 0);
//   - the driver appends BATCH messages per turn and resends with the
//     x-bili-pf watermark channel (count + tail ids).
// THREE full runs; steady = the last half of the turns; verdict on the median
// of the three p50s (and maxes) vs the baseline.
//
// Gate: ACP_TEST_EG_BENCH=1 (its own CI lane, ci-e2e-egbench.yml — master
// push + manual dispatch; not part of the per-PR core legs).
// Calibration: without the baseline file the test prints the measured numbers
// and passes; commit the printed values into the baseline file and the gate
// goes live.
//
// ACP tags in source: angle brackets hex-escaped (KDD #2).

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const RUN = process.env.ACP_TEST_EG_BENCH === "1";
const MODEL = "bench";
const SEED = 100;          // initial history
const BATCH = 100;         // new messages per turn
const TURNS = 300;         // -> (SEED + TURNS*BATCH) = 30k ledger rows at the end
const KEEP = 1800;         // live-view window after a fold (driver side; mirrors the fake)
const GROWTH = 300;        // fake: fold per this many NEW refs since the last fold
const STEADY_FRAC = 0.5;   // steady = last half of the turns (15k-30k row zone)
const RUNS = 3;
const MARGIN = 1.2;        // +20% over baseline (ruling 7439 / owner 2026-11-22)
const BASELINE = join(dirname(fileURLToPath(import.meta.url)), "e2e", "bench", "egress-bench.baseline.json");

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

const PAD = "x".repeat(240);
const filler = (i: number) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `step-${i} ${PAD}`,
});

const REF_RE = />(m\d{5,6})<\x2facp>/g;
const pad5 = (n: number) => `m${String(n).padStart(5, "0")}`;

// Ideal-model fold fake: the exact emulation from perf/fake-ideal.mjs.
async function startFoldFake(): Promise<{ base: string; close: () => Promise<void> }> {
    let lastFoldMax: number | null = null;
    let compressCalls = 0;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            let min: number | null = null, max: number | null = null;
            REF_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = REF_RE.exec(body))) {
                const n = Number(m[1].slice(1));
                if (min === null || n < min) min = n;
                if (max === null || n > max) max = n;
            }
            let fold: { start: number; end: number; n: number } | null = null;
            if (min !== null && max !== null) {
                if (lastFoldMax === null) {
                    lastFoldMax = max;
                } else if (max - lastFoldMax > GROWTH) {
                    const s = min, e = Math.max(min, max - KEEP);
                    if (e > s) {
                        compressCalls += 1;
                        fold = { start: s, end: e, n: e - s + 1 };
                        lastFoldMax = max; // baseline = max ref AT fold time
                    }
                }
            }
            const usage = { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: 8, total_tokens: Math.ceil(body.length / 4) + 8 };
            let payload: Record<string, unknown>;
            if (fold) {
                payload = {
                    id: "chatcmpl-ideal", object: "chat.completion", model: MODEL,
                    choices: [{
                        index: 0,
                        message: {
                            role: "assistant", content: null,
                            tool_calls: [{
                                id: `call_i${compressCalls}`, type: "function",
                                function: {
                                    name: "compress",
                                    arguments: JSON.stringify({
                                        content: [{
                                            startRef: pad5(fold.start), endRef: pad5(fold.end),
                                            summary: `bench summary ${fold.start}..${fold.end} (${fold.n} refs): consumed history condensed; key decisions preserved verbatim.`,
                                        }],
                                    }),
                                },
                            }],
                        },
                        finish_reason: "tool_calls",
                    }],
                    usage,
                };
            } else {
                payload = {
                    id: "chatcmpl-ideal", object: "chat.completion", model: MODEL,
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage,
                };
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(payload));
        });
    });
    server.listen(0, "127.0.0.1");
    await listen(server);
    return {
        base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

type Msg = { role: string; content: string };

async function oneRun(proxyBase: string, sessionName: string): Promise<{ p50: number; max: number; steady: number[]; folds: number }> {
    const msgs: Msg[] = [];
    const ids: string[] = [];
    for (let i = 0; i < SEED; i++) { msgs.push(filler(i)); ids.push(randomUUID()); }
    let pfSeq: number | null = null;
    let folds = 0;
    const steady: number[] = [];
    const steadyFrom = TURNS - Math.floor(TURNS * STEADY_FRAC);
    for (let t = 1; t <= TURNS; t++) {
        for (let i = 0; i < BATCH; i++) {
            msgs.push(filler(SEED + (t - 1) * BATCH + i));
            ids.push(randomUUID());
        }
        const body: Record<string, unknown> = { model: MODEL, stream: false, messages: msgs };
        if (pfSeq === null) body.biliMsgIds = ids; // full re-anchor carries host msgids
        const h: Record<string, string> = {
            "content-type": "application/json",
            authorization: "Bearer bench",
            "x-bili-plugin": "egbench",
            "x-bili-plugin-conversation": sessionName,
        };
        if (pfSeq !== null) {
            h["x-bili-pf-count"] = String(pfSeq);
            const width = msgs.length - pfSeq + 1;
            if (width >= 1 && width <= 2048) {
                const v = ids.slice(pfSeq - 1).map(encodeURIComponent).join(",");
                if (v.length <= 8 * 1024) h["x-bili-pf-tail-ids"] = v;
            }
        }
        const t0 = performance.now();
        const res = await fetch(`${proxyBase}/v1/chat/completions`, {
            method: "POST", headers: h, body: JSON.stringify(body),
        });
        const t1 = performance.now();
        const text = await res.text();
        assert.equal(res.status, 200, `turn ${t} failed: ${res.status} ${text.slice(0, 200)}`);
        if (process.env.EGBENCH_DEBUG && (t <= 3 || t % 50 === 0)) {
            console.log(`[egbench:dbg] t${t} ${Math.round(t1 - t0)}ms pfSeq=${res.headers.get("x-bili-pf-seq")} T=${msgs.length} folds=${folds}`);
        }
        // plugin host emulation: model issued compress -> the host folds locally
        // and the NEXT request carries the folded view (dead span -> one summary
        // block) — same as perf/replay-fold.mjs.
        let j: { choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[] } = {};
        try { j = JSON.parse(text); } catch { /* keep {} */ }
        const tcs = j.choices?.[0]?.message?.tool_calls;
        if (Array.isArray(tcs) && tcs.some((c) => c.function?.name === "compress") && msgs.length > KEEP) {
            const keepMsgs = msgs.slice(msgs.length - KEEP);
            const keepIds = ids.slice(ids.length - KEEP);
            const dead = msgs.length - KEEP;
            msgs.length = 0; ids.length = 0;
            msgs.push({ role: "user", content: `[compressed summary] ${dead} messages condensed: key decisions and file state preserved verbatim.` });
            ids.push(randomUUID());
            msgs.push(...keepMsgs); ids.push(...keepIds);
            pfSeq = null; // wire shrank vs stamped T -> clear mode, next send re-anchors
            folds += 1;
        } else if (res.headers.get("x-bili-pf-seq") !== null) {
            pfSeq = Number(res.headers.get("x-bili-pf-seq"));
        }
        if (t - 1 >= steadyFrom) steady.push(t1 - t0);
    }
    const sorted = [...steady].sort((a, b) => a - b);
    return { p50: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1], steady, folds };
}

test("egress plane bench: growing pinned session stays within 20% of baseline (#7474)", { timeout: 45 * 60_000 }, async (t) => {
    if (!RUN) { t.skip("gated off (ACP_TEST_EG_BENCH=1)"); return; }
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "1";
    setRegistryForTest({});

    const p50s: number[] = [];
    const maxes: number[] = [];
    await t.test("3 runs, fresh XDG root each", async (t2) => {
        for (let r = 1; r <= RUNS; r++) {
            await t2.test(`run ${r}`, async (t3) => {
                const dir = mkdtempSync(join(tmpdir(), `egbench-r${r}-`));
                t3.after(() => rmSync(dir, { recursive: true, force: true }));
                for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) process.env[key] = dir;
                process.env.XDG_CONFIG_HOME = dir;
                const store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
                _setStoreForTest(store);
                const fake = await startFoldFake();
                const llmUrl = fake.base;
                const opts: ProxyOptions = {
                    port: 0, host: "127.0.0.1", upstream: llmUrl,
                    routes: { [llmUrl]: { models: { [MODEL]: { context: 100_000_000 } } } },
                    modelContextLimit: 100_000_000, kernelConfig: defaultConfig(100_000_000),
                    compress: { injectTool: false, injectNudge: false },
                    promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
                    log: false, debug: false, passthrough: false, autoUpdate: false,
                    compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
                    autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
                    mitm: { enabled: false, domains: [] },
                };
                const srv = await startServer(opts);
                await listen(srv);
                const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
                try {
                    const m = await oneRun(base, `bench-conv-${r}`);
                    p50s.push(m.p50); maxes.push(m.max);
                    console.log(`[egbench] run ${r}: steady n=${m.steady.length} folds=${m.folds} p50=${m.p50.toFixed(0)}ms max=${m.max.toFixed(0)}ms`);
                } finally {
                    srv.close();
                    await fake.close();
                    await store.closeQuietly();
                }
            });
        }
    });
    const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    assert.equal(p50s.length, RUNS, `expected ${RUNS} completed runs, got ${p50s.length}`);
    const medP50 = med(p50s), medMax = med(maxes);
    assert.ok(Number.isFinite(medP50) && Number.isFinite(medMax), "bench produced no steady samples");
    console.log(`[egbench] median of ${RUNS}: p50=${medP50.toFixed(0)}ms max=${medMax.toFixed(0)}ms`);
    if (!existsSync(BASELINE)) {
        console.log(`[egbench] CALIBRATION (no baseline at ${BASELINE}) — commit these values:\n${JSON.stringify({
            scale: { seed: SEED, batch: BATCH, turns: TURNS, runs: RUNS, margin: MARGIN },
            p50_ms: Math.round(medP50), max_ms: Math.round(medMax),
            runs_p50: p50s.map(Math.round), runs_max: maxes.map(Math.round),
            measured_at: new Date().toISOString(),
        }, null, 2)}`);
        return;
    }
    const bl = JSON.parse(readFileSync(BASELINE, "utf8")) as { p50_ms: number; max_ms: number };
    assert.ok(medP50 <= MARGIN * bl.p50_ms,
        `egress bench regression: steady p50 ${medP50.toFixed(0)}ms exceeds +${(MARGIN - 1) * 100}% of baseline ${bl.p50_ms}ms (runs: ${p50s.map((v) => v.toFixed(0)).join("/")})`);
    assert.ok(medMax <= MARGIN * bl.max_ms,
        `egress bench regression: steady max ${medMax.toFixed(0)}ms exceeds +${(MARGIN - 1) * 100}% of baseline ${bl.max_ms}ms`);
});
