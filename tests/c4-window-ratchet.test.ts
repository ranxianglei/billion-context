// C4 (PR #7684): the window ratchet for models with NO declared window.
// A model that resolves to nothing (no plugin/launcher/operator/registry/
// table evidence) rides the anonymous default window (base.modelContextLimit).
// Ruling (owner, 2026-11-25): the first request is NOT judged against a
// smaller guess — it runs on the default; if the turn SUCCEEDS and the
// upstream BILLS input beyond the window the request was judged on, that is
// proof the upstream window is bigger: raise the session-local window to
// 2× the observation, monotonically (never down). Declared windows are never
// touched. Before the fix, a model that bills beyond its default was stuck
// judging every later turn against the too-small default (the #6957/#7102
// "switched model, now everything is over-window" symptom half).

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const DEFAULT_WINDOW = 100_000;
const MODEL = "ratchet-model-7684";
const DECLARED_MODEL = "declared-model-7684";
const DECLARED_WINDOW = 50_000;

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

test("C4 a successful turn that bills beyond the default window raises the session window to 2× the observation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "window-ratchet-c4-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    let store: SessionStore | null = null;
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    let nextPromptTokens = 10;
    try {
        setRegistryForTest({});
        store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        upstream = http.createServer((req, res) => {
            req.on("data", () => undefined);
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-test", object: "chat.completion", model: MODEL,
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: nextPromptTokens, completion_tokens: 5, total_tokens: nextPromptTokens + 5 },
                }));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: llmUrl,
            routes: {
                // DECLARED_MODEL has an operator-declared window — it must
                // never be ratcheted (explicit declarations outrank evidence).
                [llmUrl]: { models: { [DECLARED_MODEL]: { context: DECLARED_WINDOW } } },
            },
            modelContextLimit: DEFAULT_WINDOW, kernelConfig: defaultConfig(DEFAULT_WINDOW),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: true, debug: true, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
            autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        srv = await startServer(opts);
        await listen(srv);
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
        const settle = async (sessionId: string): Promise<void> => {
            const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "first debounced flush landed");
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "second flush settled");
        };
        const turn = async (sessionId: string, model: string, promptTokens: number, i: number): Promise<{ status: number; text: string }> => {
            nextPromptTokens = promptTokens;
            const resp = await fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                // Plugin lane: the PROXY lane's non-streaming JSON response
                // path deliberately skips usage accounting (pipePluginJson is
                // called with no session, #460 residual) — the ratchet's
                // billing evidence only exists where the report is settled.
                headers: { "content-type": "application/json", "x-acp-session": sessionId, "x-bili-plugin": "opencode" },
                body: JSON.stringify({
                    model, stream: false, max_tokens: 4096,
                    messages: [
                        { role: "user", content: `q-${i} ${"x".repeat(64)}` },
                        { role: "assistant", content: `a-${i}` },
                        { role: "user", content: `next-${i}` },
                    ],
                }),
                signal: AbortSignal.timeout(30_000),
            });
            const text = await resp.text();
            return { status: resp.status, text };
        };
        const ratchetRaises = (): string[] => logs.filter((l) => l.includes("[window-ratchet]") && l.includes("raised to"));

        // 1. first request on the unresolved model: rides the default, runs
        //    without being judged down (bills comfortably inside).
        const t1 = await turn("c4-sess", MODEL, 10, 0);
        assert.equal(t1.status, 200, `first turn (got ${t1.status}: ${t1.text.slice(0, 200)})`);
        assert.ok(logs.some((l) => l.includes(`model=${MODEL}`) && l.includes("source=default") && l.includes("fallback=true")),
            `the model resolves to the anonymous default (log: ${logs.filter((l) => l.includes(`model=${MODEL}`) && l.includes("[window]")).slice(0, 2).join(" | ")})`);
        await settle("c4-sess");

        // 1b. NEGATIVE (the #971 e2e red, 2026-11-27): a bill INSIDE the
        //     judged window proves nothing — 60K bills inside the 100K default
        //     (2×60K would "outrank" it) must NOT ratchet. Only a bill BEYOND
        //     the judged window is acceptance evidence for a bigger upstream.
        const t1b = await turn("c4-sess", MODEL, 60_000, 1);
        assert.equal(t1b.status, 200, `mid-window bill turn (got ${t1b.status}: ${t1b.text.slice(0, 200)})`);
        await settle("c4-sess");
        assert.deepEqual(ratchetRaises().length, 0, `a mid-window bill never raises (log: ${ratchetRaises().join(" | ")})`);

        //    100K): the proof the upstream window is bigger.
        const t2 = await turn("c4-sess", MODEL, 120_000, 1);
        assert.equal(t2.status, 200, `the over-default turn succeeds (got ${t2.status}: ${t2.text.slice(0, 200)})`);
        await settle("c4-sess");
        assert.deepEqual(ratchetRaises().length, 1, `exactly one raise after the over-default billing (log: ${logs.filter((l) => l.includes("c4-sess")).filter((l) => /usage|window|anchor|ratchet|settle/i.test(l)).join(" | ").slice(0, 6000)})`);
        assert.ok(ratchetRaises()[0].includes(`model=${MODEL}`) && ratchetRaises()[0].includes("raised to 240000"), `raise is 2× the observation (${ratchetRaises()[0]})`);

        // 3. the next turn judges against the raised window, not the default:
        //    the 120K anchor is inside 240K (without the ratchet the same
        //    turn judges 120K against ~100K and fails or force-folds).
        const t3 = await turn("c4-sess", MODEL, 30, 2);
        assert.equal(t3.status, 200, `the post-raise turn runs on the raised window (got ${t3.status}: ${t3.text.slice(0, 200)})`);
        assert.ok(logs.some((l) => l.includes(`model=${MODEL}`) && l.includes("source=ratchet")), `the ratcheted source is logged (${logs.filter((l) => l.includes(`model=${MODEL}`) && l.includes("ratchet")).join(" | ")})`);
        await settle("c4-sess");

        // 4. monotonic: a later small bill does not raise again (and never lowers).
        const t4 = await turn("c4-sess", MODEL, 30, 3);
        assert.equal(t4.status, 200, `small bill turn (got ${t4.status}: ${t4.text.slice(0, 200)})`);
        assert.deepEqual(ratchetRaises().length, 1, `no second raise for a smaller bill (log: ${ratchetRaises().join(" | ")})`);

        // 4b. one anomalous GIANT bill (#6781 class: a 43MB full resend bills
        //     millions of tokens) must not leap the session window to 2× of it
        //     in a single step: clamp to the 4×-judged bound. Here the session
        //     already judged at the raised 240K, so the bound is 4×240K =
        //     960K instead of 2×5M = 10M. The follow-up bill — judged against
        //     the raised value — re-raises within the bound, so a genuinely
        //     large window still converges, in bounded steps.
        const t4b = await turn("c4-sess", MODEL, 5_000_000, 4);
        assert.equal(t4b.status, 200, `giant-bill turn (got ${t4b.status}: ${t4b.text.slice(0, 200)})`);
        await settle("c4-sess");
        assert.deepEqual(ratchetRaises().length, 2, `exactly one extra raise for the giant bill (log: ${ratchetRaises().join(" | ")})`);
        assert.ok(ratchetRaises()[1].includes("raised to 960000") && ratchetRaises()[1].includes("clamped"), `the giant bill clamps to the 4×-judged bound (960K) instead of 2× the bill (10M) (${ratchetRaises()[1]})`);

        // 5. declared windows are never ratcheted: the control model bills
        //    beyond its DECLARED 50K window and still must not ratchet.
        const d1 = await turn("c4-sess-d", DECLARED_MODEL, 60_000, 0);
        assert.equal(d1.status, 200, `declared-model turn (got ${d1.status}: ${d1.text.slice(0, 200)})`);
        await settle("c4-sess-d");
        assert.ok(!ratchetRaises().some((l) => l.includes(DECLARED_MODEL)), `the declared model is never ratcheted (log: ${ratchetRaises().join(" | ")})`);
    } finally {
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((r) => { if (srv) srv.close(() => r()); else r(); });
        await new Promise<void>((r) => { if (upstream) upstream.close(() => r()); else r(); });
    }
});
