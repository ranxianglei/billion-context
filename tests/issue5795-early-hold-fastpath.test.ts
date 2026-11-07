// #5795: pre-ingest 429-hold fast path — while the egress governor (#4204)
// holds origin+credential, sends ≥ EARLY_HOLD_GATE_MIN_BYTES are refused
// BEFORE prepare pays the O(history) parse/convert/pin cost. Invariants:
//   1. upstreamThrottlePeekReject is byte-for-byte the gate's REJECT branch
//      (parity rows) but NEVER mutates — above all it must not consume the
//      single-flight probe slot the real gate owns.
//   2. tryAnswerEarlyHold gates both directions: refuses when a hold applies,
//      falls through untouched when it does not (method/protocol/size/model).
//   3. Hermetic E2E: a held multi-MiB send egresses ZERO bytes (the field bug:
//      every host retry re-paid ~6s of ingest for a send that could not leave),
//      while sub-threshold and model-mismatched sends keep their exact
//      pre-#5795 behavior.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { closeServers } from "./server-close-guard.ts";
import {
    activeThrottleHolds,
    beginProvisionalUpstreamThrottle429,
    keyringModel429Scope,
    noteUpstreamThrottle429,
    upstreamThrottleGate,
    upstreamThrottlePeekReject,
    _resetUpstreamThrottleForTest,
} from "../src/upstream-throttle.ts";
import { EARLY_HOLD_GATE_MIN_BYTES, tryAnswerEarlyHold } from "../src/server/relay.ts";

const URL_A = "http://z.example/api/coding/paas/v4/chat/completions";
const H_EMPTY: Record<string, string> = {};
const H_CRED_A: Record<string, string> = { authorization: "Bearer AAA" };
const H_CRED_B: Record<string, string> = { authorization: "Bearer BBB" };
// Integer-second timestamps: keeps HTTP-date Retry-After fixtures exact.
const T0 = 1_000_000;

const KNOB_ENVS = [
    "BILI_THROTTLE_429",
    "BILI_THROTTLE_429_MAX_CONSECUTIVE",
    "BILI_THROTTLE_429_BASE_DELAY_MS",
    "BILI_THROTTLE_429_MAX_DELAY_MS",
] as const;

function withKnobs(vars: Partial<Record<(typeof KNOB_ENVS)[number], string>>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const k of KNOB_ENVS) saved[k] = process.env[k];
    try {
        for (const [k, v] of Object.entries(vars)) process.env[k] = v;
        fn();
    } finally {
        for (const k of KNOB_ENVS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

async function withKnobsAsync(vars: Partial<Record<(typeof KNOB_ENVS)[number], string>>, fn: () => Promise<void>): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const k of KNOB_ENVS) saved[k] = process.env[k];
    try {
        for (const [k, v] of Object.entries(vars)) process.env[k] = v;
        await fn();
    } finally {
        for (const k of KNOB_ENVS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

const KNOWN_KNOBS: Partial<Record<(typeof KNOB_ENVS)[number], string>> = {
    BILI_THROTTLE_429: "1",
    BILI_THROTTLE_429_MAX_CONSECUTIVE: "5",
    BILI_THROTTLE_429_BASE_DELAY_MS: "2000",
    BILI_THROTTLE_429_MAX_DELAY_MS: "30000",
};

// ---------------------------------------------------------------------------
// upstreamThrottlePeekReject — parity with the gate's REJECT branch, zero mutation
// ---------------------------------------------------------------------------

test("#5795: peek is byte-parity with the gate's reject branch (active hold)", () => {
    withKnobs(KNOWN_KNOBS, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        const gateReject = upstreamThrottleGate(URL_A, H_EMPTY, T0 + 100).reject;
        assert.ok(gateReject, "gate rejects mid-window");
        assert.deepEqual(upstreamThrottlePeekReject(URL_A, H_EMPTY, T0 + 100), gateReject);
        // Repeated peeks never drift the hold either.
        assert.ok(upstreamThrottlePeekReject(URL_A, H_EMPTY, T0 + 200));
        assert.equal(activeThrottleHolds()[0].streak, 1);
    });
});

test("#5795: peek parity on a TERMINAL hold (424, no Retry-After)", () => {
    withKnobs({ ...KNOWN_KNOBS, BILI_THROTTLE_429_MAX_CONSECUTIVE: "2" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        const p = upstreamThrottlePeekReject(URL_A, H_EMPTY, T0 + 100);
        assert.ok(p);
        assert.equal(p.status, 424);
        assert.equal(p.code, "bili_throttle_terminal");
        assert.equal(p.retryAfterSec, null);
        assert.deepEqual(p, upstreamThrottleGate(URL_A, H_EMPTY, T0 + 100).reject);
    });
});

test("#5795: peek is read-only — it must not consume the single-flight probe slot", () => {
    withKnobs(KNOWN_KNOBS, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        const edge = activeThrottleHolds()[0].nextAttemptAt;
        assert.equal(upstreamThrottlePeekReject(URL_A, H_EMPTY, edge), undefined, "window open: nothing to refuse");
        const admitted = upstreamThrottleGate(URL_A, H_EMPTY, edge);
        assert.equal(admitted.reject, undefined, "the real gate still admits the probe");
        assert.equal(typeof admitted.probeToken, "symbol", "peek must not have minted/consumed the probe token");
        // Mid-window, peek and gate agree AND the gate's reject carries no token.
        const dup = upstreamThrottleGate(URL_A, H_EMPTY, T0 + 100);
        assert.ok(dup.reject);
        assert.equal(dup.probeToken, undefined);
        assert.deepEqual(upstreamThrottlePeekReject(URL_A, H_EMPTY, T0 + 100), dup.reject);
    });
});

test("#5795: peek honors model-scoped holds conservatively (exact match only)", () => {
    withKnobs(KNOWN_KNOBS, () => {
        _resetUpstreamThrottleForTest();
        const model = "deepseek-v4.1-flash";
        const modelScope = keyringModel429Scope(429, model, JSON.stringify({ error: { code: "keyring_model_temporarily_unavailable", model } }));
        assert.equal(modelScope, model);
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0, modelScope);
        assert.ok(upstreamThrottlePeekReject(URL_A, H_CRED_A, T0 + 100, model), "exact model match is refused");
        assert.equal(upstreamThrottlePeekReject(URL_A, H_CRED_A, T0 + 100, "other-model"), undefined, "another model passes");
        assert.equal(upstreamThrottlePeekReject(URL_A, H_CRED_A, T0 + 100), undefined, "unknown model passes (cannot prove mismatch)");
    });
});

test("#5795: peek keeps credential pools isolated", () => {
    withKnobs(KNOWN_KNOBS, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0);
        assert.ok(upstreamThrottlePeekReject(URL_A, H_CRED_A, T0 + 100));
        assert.equal(upstreamThrottlePeekReject(URL_A, H_CRED_B, T0 + 100), undefined, "other credential unaffected");
    });
});

test("#5795: peek sees provisional groups (account-scoped while classifying)", () => {
    withKnobs(KNOWN_KNOBS, () => {
        _resetUpstreamThrottleForTest();
        const settle = beginProvisionalUpstreamThrottle429(URL_A, H_EMPTY, "10", T0, undefined);
        const p = upstreamThrottlePeekReject(URL_A, H_EMPTY, T0 + 100);
        assert.ok(p, "provisional hold refuses like a confirmed one");
        assert.equal(p?.status, 429);
        settle();
    });
});

test("#5795: disabled governor — peek is inert even with an armed hold", () => {
    withKnobs(KNOWN_KNOBS, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        assert.ok(upstreamThrottlePeekReject(URL_A, H_EMPTY, T0 + 100), "enabled: refuses");
    });
    withKnobs({ ...KNOWN_KNOBS, BILI_THROTTLE_429: "0" }, () => {
        assert.equal(upstreamThrottlePeekReject(URL_A, H_EMPTY, T0 + 100), undefined, "disabled: inert");
    });
});

// ---------------------------------------------------------------------------
// tryAnswerEarlyHold — gate directions (refuse when it should, pass when not)
// ---------------------------------------------------------------------------

interface FakeRes {
    headersSent: boolean;
    headStatus?: number;
    headHeaders?: Record<string, string>;
    endBody?: string;
}

function makeFakeRes(): FakeRes & http.ServerResponse {
    const f: FakeRes = { headersSent: false };
    (f as { writeHead?: unknown }).writeHead = (status: number, headers?: Record<string, string>) => {
        f.headStatus = status;
        f.headHeaders = headers;
    };
    (f as { end?: unknown }).end = (body?: string) => {
        f.endBody = body ?? "";
    };
    return f as unknown as FakeRes & http.ServerResponse;
}

function earlyHoldBase(logs: string[]) {
    return {
        upstreamUrl: URL_A,
        credHeaders: H_EMPTY,
        protocol: "openai" as const,
        log: (level: string, msg: string) => logs.push(`${level} ${msg}`),
    };
}

test("#5795: tryAnswerEarlyHold pass-through rows (no refusal, response untouched)", () => {
    withKnobs(KNOWN_KNOBS, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        const big = EARLY_HOLD_GATE_MIN_BYTES + 1;
        const logs: string[] = [];

        for (const method of ["GET", "HEAD"]) {
            const res = makeFakeRes();
            assert.equal(tryAnswerEarlyHold({ ...earlyHoldBase(logs), method, bodyBytes: big, res }), false, `${method} never consults the hold`);
            assert.equal(res.headStatus, undefined);
        }
        const pnull = makeFakeRes();
        assert.equal(tryAnswerEarlyHold({ ...earlyHoldBase(logs), method: "POST", protocol: null, bodyBytes: big, res: pnull }), false, "unknown wire stays verbatim");
        assert.equal(pnull.headStatus, undefined);
        const small = makeFakeRes();
        assert.equal(tryAnswerEarlyHold({ ...earlyHoldBase(logs), method: "POST", bodyBytes: EARLY_HOLD_GATE_MIN_BYTES - 1, res: small }), false, "sub-threshold keeps its exact pre-#5795 path");
        assert.equal(small.headStatus, undefined);
        assert.equal(logs.length, 0, "pass-through rows log nothing");

        _resetUpstreamThrottleForTest();
        const admit = makeFakeRes();
        assert.equal(tryAnswerEarlyHold({ ...earlyHoldBase(logs), method: "POST", bodyBytes: big, res: admit }), false, "no hold: admitted");
        assert.equal(admit.headStatus, undefined);
    });
});

test("#5795: tryAnswerEarlyHold answers a held send with the exact local 429 shape", () => {
    withKnobs(KNOWN_KNOBS, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        const logs: string[] = [];
        const res = makeFakeRes();
        assert.equal(tryAnswerEarlyHold({ ...earlyHoldBase(logs), method: "POST", bodyBytes: EARLY_HOLD_GATE_MIN_BYTES, now: T0 + 100, res }), true, "threshold boundary consults the hold");
        assert.equal(res.headStatus, 429);
        assert.equal(res.headHeaders?.["content-type"], "application/json");
        assert.ok(res.headHeaders?.["retry-after"], "Retry-After rides the local 429");
        const body = JSON.parse(res.endBody ?? "") as { error: { type: string; code: string; stage: string; message: string; retryable: boolean } };
        assert.equal(body.error.type, "rate_limit_error");
        assert.equal(body.error.code, "bili_throttle_hold");
        assert.equal(body.error.stage, "forward");
        assert.equal(body.error.retryable, true);
        assert.ok(logs.some((l) => l.includes("[pre-ingest]") && l.includes("answered locally with 429")), "fast-path refusal is logged distinctly");
    });
});

test("#5795: tryAnswerEarlyHold answers a TERMINAL hold with 424 (no Retry-After, non-retryable)", () => {
    withKnobs({ ...KNOWN_KNOBS, BILI_THROTTLE_429_MAX_CONSECUTIVE: "2" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        const logs: string[] = [];
        const res = makeFakeRes();
        assert.equal(tryAnswerEarlyHold({ ...earlyHoldBase(logs), method: "POST", bodyBytes: EARLY_HOLD_GATE_MIN_BYTES, now: T0 + 100, res }), true);
        assert.equal(res.headStatus, 424);
        assert.equal(res.headHeaders?.["retry-after"], undefined, "terminal has no Retry-After");
        const body = JSON.parse(res.endBody ?? "") as { error: { code: string; retryable: boolean } };
        assert.equal(body.error.code, "bili_throttle_terminal");
        assert.equal(body.error.retryable, false);
        assert.ok(logs.some((l) => l.startsWith("warn")), "terminal refusals log at warn");
    });
});

// ---------------------------------------------------------------------------
// Hermetic E2E — held multi-MiB send egresses zero bytes
// ---------------------------------------------------------------------------

interface Capture { raw: string; headerKeys: string[] }

function completionBody(): string {
    return JSON.stringify({
        id: "chatcmpl-test", object: "chat.completion", created: 1, model: "model-test",
        choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
    });
}

function makeScriptedUpstream(sink: Capture[], first: { status: number; body: string } | null) {
    let n = 0;
    return http.createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            sink.push({ raw: data, headerKeys: Object.keys(req.headers).map((k) => k.toLowerCase()) });
            // Advance on EVERY request: with `first` set, incrementing only on
            // the 200 path replayed the first response forever, so the
            // model-scope row's "other model egresses" turn could never see a 200.
            const isFirst = n === 0 && first !== null;
            n++;
            if (isFirst) {
                res.writeHead(first.status, { "content-type": "application/json" });
                res.end(first.body);
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(completionBody());
        });
    });
}

interface Harness2 { root: string; store: SessionStore; captured: Capture[]; upstream: http.Server }

function makeHarness(tag: string): Harness2 {
    _resetStoreForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const root = mkdtempSync(path.join(os.tmpdir(), `e5795-${tag}-`));
    for (const k of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[k] = root;
    const store = new SessionStore({ dir: path.join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    const captured: Capture[] = [];
    return { root, store, captured, upstream: makeScriptedUpstream(captured, null) };
}

async function bringUp(h: Harness2) {
    h.upstream.listen(0, "127.0.0.1");
    await once(h.upstream, "listening");
    const uaddr = h.upstream.address();
    assert(uaddr && typeof uaddr === "object");
    const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { "model-test": { context: 2_000_000 } } } },
        modelContextLimit: 2_000_000,
        kernelConfig: defaultConfig(2_000_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true, debug: true, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return { proxy, origin: `http://127.0.0.1:${paddr.port}`, upstreamUrl };
}

// The fill must NOT be one homogeneous character run: these requests mint a
// FRESH ANONYMOUS session (no session header), whose provenance path masks the
// ENTIRE first message through maskUrlsInText BEFORE truncating to the preview
// cap. That masker's scheme-prefix scan ([a-z][a-z0-9+.-]*://) backtracks
// O(n²) over long scheme-char runs — a megabyte of 'x' spins the event loop
// for minutes (pre-existing since the #4191 any-scheme regex; tracked
// separately). Whitespace-separated words keep the byte size identical while
// keeping the scan linear.
const BIG_TURN_WORDS = "lorem ipsum dolor sit amet ";
function bigTurn(model: string, targetBytes: number): unknown {
    const overhead = JSON.stringify({ model, messages: [{ role: "user", content: "" }], max_tokens: 64, stream: false }).length;
    const fill = BIG_TURN_WORDS.repeat(Math.ceil((targetBytes - overhead) / BIG_TURN_WORDS.length)).slice(0, targetBytes - overhead);
    return { model, messages: [{ role: "user", content: fill }], max_tokens: 64, stream: false };
}

async function post(origin: string, upstreamUrl: string, body: unknown): Promise<{ status: number; retryAfter: string | null; error?: { type?: string; code?: string; stage?: string; retryable?: boolean } }> {
    const res = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let error: { type?: string; code?: string; stage?: string; retryable?: boolean } | undefined;
    try {
        const parsed = JSON.parse(text) as { error?: typeof error };
        error = parsed.error;
    } catch { /* non-JSON success body */ }
    return { status: res.status, retryAfter: res.headers.get("retry-after"), error };
}

test("#5795 e2e: held send ≥1MiB is refused pre-ingest — zero egress, local shape intact", async () => {
    await withKnobsAsync(KNOWN_KNOBS, async () => {
        const roots: string[] = [];
        try {
            const h0 = makeHarness("hold");
            roots.push(h0.root);
            h0.upstream.close();
            h0.upstream = makeScriptedUpstream(h0.captured, {
                status: 429,
                body: JSON.stringify({ error: { type: "server_error", message: "[overloaded] the server is overloaded; retry shortly" } }),
            });
            const h = await bringUp(h0);
            // Turn 1 (small): egresses, upstream 429 arms the account hold.
            const r1 = await post(h.origin, h.upstreamUrl, { model: "model-test", messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: false });
            assert.equal(r1.status, 429, "turn 1 relays the upstream 429");
            assert.equal(h0.captured.length, 1);
            // Turn 2 (≥1MiB): held LOCALLY before prepare — the core invariant.
            const r2 = await post(h.origin, h.upstreamUrl, bigTurn("model-test", EARLY_HOLD_GATE_MIN_BYTES + 64 * 1024));
            assert.equal(r2.status, 429, "held turn answered locally");
            assert.equal(h0.captured.length, 1, "ZERO egress for the held turn — no re-upload cost paid");
            assert.ok(r2.retryAfter !== null, "local refusal carries Retry-After");
            assert.equal(r2.error?.code, "bili_throttle_hold");
            assert.equal(r2.error?.stage, "forward");
            assert.equal(r2.error?.retryable, true);
            // Turn 3 (small, still held): the post-ingest gate still catches it too.
            const r3 = await post(h.origin, h.upstreamUrl, { model: "model-test", messages: [{ role: "user", content: "again" }], max_tokens: 64, stream: false });
            assert.equal(r3.status, 429);
            assert.equal(h0.captured.length, 1, "small held turn still refused by the original gate");
            assert.equal(r3.error?.code, "bili_throttle_hold");
            h0.store.cancelAll();
            await closeServers([h.proxy, h0.upstream], "#5795 hold");
        } finally {
            for (const root of roots) rmSync(root, { recursive: true, force: true });
        }
    });
});

test("#5795 e2e negative: a ≥1MiB send with NO hold egresses normally", async () => {
    await withKnobsAsync(KNOWN_KNOBS, async () => {
        const roots: string[] = [];
        try {
            const h0 = makeHarness("clean");
            roots.push(h0.root);
            const h = await bringUp(h0);
            const r = await post(h.origin, h.upstreamUrl, bigTurn("model-test", EARLY_HOLD_GATE_MIN_BYTES + 64 * 1024));
            assert.equal(r.status, 200, "no hold: the fast path must not over-refuse");
            assert.equal(h0.captured.length, 1, "egressed once");
            assert.ok(h0.captured[0].raw.length >= EARLY_HOLD_GATE_MIN_BYTES, "full multi-MiB body reached upstream");
            h0.store.cancelAll();
            await closeServers([h.proxy, h0.upstream], "#5795 clean");
        } finally {
            for (const root of roots) rmSync(root, { recursive: true, force: true });
        }
    });
});

test("#5795 e2e: model-scoped hold — other models egress, matching model held", async () => {
    await withKnobsAsync(KNOWN_KNOBS, async () => {
        const roots: string[] = [];
        try {
            const h0 = makeHarness("modelscope");
            roots.push(h0.root);
            h0.upstream.close();
            h0.upstream = makeScriptedUpstream(h0.captured, {
                status: 429,
                body: JSON.stringify({ error: { code: "keyring_model_temporarily_unavailable", model: "model-a", message: "model temporarily unavailable" } }),
            });
            const h = await bringUp(h0);
            const r1 = await post(h.origin, h.upstreamUrl, { model: "model-a", messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: false });
            assert.equal(r1.status, 429, "turn 1 relays the KeyRing model 429");
            assert.equal(h0.captured.length, 1);
            const r2 = await post(h.origin, h.upstreamUrl, bigTurn("model-b", EARLY_HOLD_GATE_MIN_BYTES + 64 * 1024));
            assert.equal(r2.status, 200, "model-b is outside the model-scoped hold — must egress");
            assert.equal(h0.captured.length, 2);
            const r3 = await post(h.origin, h.upstreamUrl, bigTurn("model-a", EARLY_HOLD_GATE_MIN_BYTES + 64 * 1024));
            assert.equal(r3.status, 429, "model-a is held");
            assert.equal(h0.captured.length, 2, "zero egress for the held model");
            assert.equal(r3.error?.code, "bili_throttle_hold");
            h0.store.cancelAll();
            await closeServers([h.proxy, h0.upstream], "#5795 modelscope");
        } finally {
            for (const root of roots) rmSync(root, { recursive: true, force: true });
        }
    });
});
