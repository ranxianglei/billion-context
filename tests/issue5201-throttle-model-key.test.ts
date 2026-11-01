// #5201: the 429 governor's hold key gains a model dimension — one credential
// fronting many models with independent quota pools (LiteLLM/one-api style
// gateways) must not freeze healthy models when one pool exhausts. A send whose
// model cannot be identified (no body field, no path-carried model) keeps the
// legacy origin+credential key, so worst-case protection is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    activeThrottleHolds,
    noteUpstreamThrottle429,
    noteUpstreamThrottleResolved,
    sendModelDimension,
    upstreamThrottleLocalReject,
    _resetUpstreamThrottleForTest,
} from "../src/upstream-throttle.ts";

const URL_A = "http://gw.example/v1/chat/completions";
const H_CRED: Record<string, string> = { authorization: "Bearer KEY" };
// Integer-second timestamps: keeps HTTP-date Retry-After fixtures exact.
const T0 = 1_000_000;

const KNOB_ENVS = [
    "BILI_THROTTLE_429",
    "BILI_THROTTLE_429_MAX_CONSECUTIVE",
    "BILI_THROTTLE_429_BASE_DELAY_MS",
    "BILI_THROTTLE_429_MAX_DELAY_MS",
] as const;

// Env beats the config file — pin every knob explicitly so the daemon's own
// ~/.config/billion-context/billion-context.json can never leak into a row.
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

const bodyFor = (model: string): string => JSON.stringify({ model, messages: [] });

test("#5201: same origin+credential, different models — independent pools, no cross-model collateral", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "3", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        // Exhaust minimax-flash's quota: three consecutive upstream 429s → TERMINAL.
        for (let i = 0; i < 3; i++) noteUpstreamThrottle429(URL_A, H_CRED, null, T0 + i * 1000, bodyFor("minimax-flash"));
        const st = activeThrottleHolds()[0];
        assert.equal(st.streak, 3);
        assert.equal(st.terminal, true);
        // Check just inside the backoff window — the jittered delay must not
        // decide the row's outcome.
        const g = upstreamThrottleLocalReject(URL_A, H_CRED, st.nextAttemptAt - 1, bodyFor("minimax-flash"));
        assert.ok(g, "exhausted model still held");
        assert.equal(g.status, 424, "terminal for the exhausted model");
        // Healthy deepseek behind the SAME credential must be untouched.
        assert.equal(upstreamThrottleLocalReject(URL_A, H_CRED, st.nextAttemptAt - 1, bodyFor("deepseek-flash")), undefined, "healthy model unaffected by sibling exhaustion");
        assert.equal(activeThrottleHolds().length, 1, "only the exhausted pool armed");
        assert.equal(st.model, "minimax-flash");
    });
});

test("#5201: a non-429 response clears ONLY its own model's hold", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED, null, T0, bodyFor("minimax-flash"));
        noteUpstreamThrottle429(URL_A, H_CRED, null, T0 + 1000, bodyFor("deepseek-flash"));
        assert.equal(activeThrottleHolds().length, 2, "both models independently armed");
        // The #5201 log line: a deepseek 200 must NOT clear minimax's hold.
        noteUpstreamThrottleResolved(URL_A, H_CRED, 200, T0 + 2000, bodyFor("deepseek-flash"));
        const remaining = activeThrottleHolds();
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].model, "minimax-flash");
        // Just inside minimax's own (jittered) window: still held; deepseek's
        // key was cleared by its own 200 so it passes at any time.
        const mm = remaining[0];
        assert.ok(upstreamThrottleLocalReject(URL_A, H_CRED, mm.nextAttemptAt - 1, bodyFor("minimax-flash")), "minimax still held after deepseek 200");
        assert.equal(upstreamThrottleLocalReject(URL_A, H_CRED, mm.nextAttemptAt - 1, bodyFor("deepseek-flash")), undefined, "deepseek free after its own 200");
    });
});

test("#5201: unknown model falls back to the legacy origin+credential key", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        // No model in body AND none in path → old behavior: shared bucket.
        noteUpstreamThrottle429(URL_A, H_CRED, null, T0, "");
        assert.ok(upstreamThrottleLocalReject(URL_A, H_CRED, T0 + 100, ""), "unknown-model send held on the legacy key");
        assert.ok(upstreamThrottleLocalReject(URL_A, H_CRED, T0 + 100), "no body at all shares the legacy key too");
        assert.equal(activeThrottleHolds()[0].model, undefined, "legacy hold carries no model");
    });
});

test("#5201: model known on one side only — keys differ, no leak across the boundary", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED, null, T0, bodyFor("minimax-flash"));
        // A send whose model cannot be identified takes the legacy key — it does
        // NOT match the model-suffixed hold (self-heals: its next 429 re-arms).
        assert.equal(upstreamThrottleLocalReject(URL_A, H_CRED, T0 + 100), undefined, "legacy-key send passes the model-suffixed hold");
        assert.equal(activeThrottleHolds().length, 1, "no spurious extra hold created");
    });
});

test("#5201: Google-native and Anthropic-on-Vertex paths carry the model in the URL", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        const geminiA = "http://gw.example/v1beta/models/gemini-a:generateContent";
        const geminiB = "http://gw.example/v1beta/models/gemini-b:generateContent";
        noteUpstreamThrottle429(geminiA, H_CRED, null, T0, null);
        assert.ok(upstreamThrottleLocalReject(geminiA, H_CRED, T0 + 100, null), "gemini-a held via path model");
        assert.equal(upstreamThrottleLocalReject(geminiB, H_CRED, T0 + 100, null), undefined, "gemini-b unaffected");
        assert.equal(activeThrottleHolds()[0].model, "gemini-a");

        _resetUpstreamThrottleForTest();
        const vertexA = "https://vertex.example/v1/projects/p/locations/l/publishers/anthropic/models/claude-x:rawPredict";
        const vertexB = "https://vertex.example/v1/projects/p/locations/l/publishers/anthropic/models/claude-y:rawPredict";
        noteUpstreamThrottle429(vertexA, H_CRED, null, T0, null);
        assert.ok(upstreamThrottleLocalReject(vertexA, H_CRED, T0 + 100, null), "vertex claude-x held via path model");
        assert.equal(upstreamThrottleLocalReject(vertexB, H_CRED, T0 + 100, null), undefined, "vertex claude-y unaffected");
    });
});

test("#5201: terminal reject names the model in the client-facing message", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "3", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        for (let i = 0; i < 3; i++) noteUpstreamThrottle429(URL_A, H_CRED, null, T0 + i * 1000, bodyFor("minimax-flash"));
        const st = activeThrottleHolds()[0];
        const g = upstreamThrottleLocalReject(URL_A, H_CRED, st.nextAttemptAt - 1, bodyFor("minimax-flash"));
        assert.ok(g);
        assert.equal(g.status, 424);
        assert.ok(g.message.includes("minimax-flash"), `terminal message names the model: ${g.message}`);
        assert.ok(g.message.includes("gw.example"), `terminal message still names the host: ${g.message}`);
    });
});

test("#5201: sendModelDimension — body beats path, garbage/non-string model ignored, Buffer accepted", () => {
    assert.equal(sendModelDimension("http://h.invalid/v1/chat/completions", '{"model":"m-1","messages":[]}'), "m-1");
    assert.equal(sendModelDimension("http://h.invalid/v1/chat/completions", null), undefined, "no body, no path model");
    assert.equal(sendModelDimension("http://h.invalid/v1/chat/completions", "not json"), undefined, "non-JSON body falls through");
    assert.equal(sendModelDimension("http://h.invalid/v1/chat/completions", '{"model":42}'), undefined, "non-string model ignored");
    assert.equal(sendModelDimension("http://h.invalid/v1/chat/completions", '{"model":""}'), undefined, "empty model ignored");
    assert.equal(sendModelDimension("http://h.invalid/v1beta/models/gemini-z:streamGenerateContent", null), "gemini-z", "path-carried model");
    assert.equal(sendModelDimension("http://h.invalid/v1beta/models/gemini-z:generateContent", Buffer.from('{"model":"body-wins"}')), "body-wins", "body field wins over path");
    assert.equal(sendModelDimension("http://h.invalid/v1/messages", null), undefined, "plain /v1/messages carries no model");
});

test("#5201: a hold on one origin never gates a different origin (same credential included)", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "3", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const URL_B = "http://other.example/v1/chat/completions";
        for (let i = 0; i < 3; i++) noteUpstreamThrottle429(URL_A, H_CRED, null, T0 + i * 1000, bodyFor("minimax-flash"));
        const st = activeThrottleHolds()[0];
        assert.ok(upstreamThrottleLocalReject(URL_A, H_CRED, st.nextAttemptAt - 1, bodyFor("minimax-flash")), "held origin still held");
        assert.equal(upstreamThrottleLocalReject(URL_B, H_CRED, st.nextAttemptAt - 1, bodyFor("minimax-flash")), undefined, "sibling origin unaffected even with the same credential");
        assert.equal(activeThrottleHolds().length, 1, "no spurious hold on the sibling origin");
    });
});
