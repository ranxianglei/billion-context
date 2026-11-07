// #5199: marker-less gateway 429s are credential-wide by default (#5696
// semantics); network.throttle429Scope="model" keys them by the request model
// instead, so one model's RPM/quota exhaustion on a multi-pool gateway
// (LiteLLM/one-api/opencode.ai-style relays) cannot freeze its siblings.
// Recognized KeyRing/bili-relay markers keep their own semantics in both modes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { throttle429Scope } from "../src/knobs.ts";
import {
    activeThrottleHolds,
    noteUpstreamThrottle429,
    noteUpstreamThrottleResolved,
    throttle429ModelScope,
    upstreamThrottleGate,
    _resetUpstreamThrottleForTest,
} from "../src/upstream-throttle.ts";

const URL_A = "http://gw.example/v1/chat/completions";
const H_CRED_A: Record<string, string> = { authorization: "Bearer AAA" };
const T0 = 1_000_000;
const MODEL = "deepseek-v4.1-flash";
const SIBLING = "glm-5.6-flash";
// The two field-report shapes: an aggregator gateway RPM body with no
// structured marker (#5199, monkey-sking) and an opaque relay-rewritten
// prefill-cap refusal (opencode.ai lane, magpie log).
const MARKERLESS_RPM = JSON.stringify({ error: { code: null, message: "qnaigc: rate limit reached for RPM (request_id: req-1)" } });
const MARKERLESS_PREFILL = JSON.stringify({ error: { message: "[prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)" } });
const KEYRING_MODEL_ERROR = JSON.stringify({ error: { code: "keyring_model_temporarily_unavailable", model: MODEL } });

function throttleReject(url: string, headers: Record<string, string>, now?: number, requestModel?: string) {
    return upstreamThrottleGate(url, headers, now, requestModel).reject;
}

const KNOB_ENVS = [
    "BILI_THROTTLE_429",
    "BILI_THROTTLE_429_MAX_CONSECUTIVE",
    "BILI_THROTTLE_429_BASE_DELAY_MS",
    "BILI_THROTTLE_429_MAX_DELAY_MS",
    "BILI_THROTTLE_429_SCOPE",
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

test("#5199: knob reads env live and rejects unknown values back to credential", () => {
    withKnobs({}, () => {
        assert.equal(throttle429Scope(), "credential", "default is credential");
        process.env.BILI_THROTTLE_429_SCOPE = "model";
        assert.equal(throttle429Scope(), "model", "env flips per read, no restart");
        process.env.BILI_THROTTLE_429_SCOPE = "Model";
        assert.equal(throttle429Scope(), "credential", "value match is exact");
        process.env.BILI_THROTTLE_429_SCOPE = "";
        assert.equal(throttle429Scope(), "credential", "empty env reads as unset");
    });
});

test("#5199: default scope keeps marker-less gateway 429s credential-wide (#5696 row)", () => {
    withKnobs({ BILI_THROTTLE_429: "1" }, () => {
        assert.equal(throttle429ModelScope(429, MODEL, MARKERLESS_RPM), undefined);
        assert.equal(throttle429ModelScope(429, MODEL, MARKERLESS_PREFILL), undefined);
        assert.equal(throttle429ModelScope(429, MODEL, undefined), undefined);
        assert.equal(throttle429ModelScope(429, MODEL, "{malformed"), undefined);
        // The recognized marker keeps granting model scope in the default mode.
        assert.equal(throttle429ModelScope(429, MODEL, KEYRING_MODEL_ERROR), MODEL);
    });
});

test("#5199: scope=model settles marker-less 429s on the request model", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_SCOPE: "model" }, () => {
        assert.equal(throttle429ModelScope(429, MODEL, MARKERLESS_RPM), MODEL);
        assert.equal(throttle429ModelScope(429, MODEL, MARKERLESS_PREFILL), MODEL);
        assert.equal(throttle429ModelScope(429, MODEL, "{malformed"), MODEL, "malformed body cannot identify a wider scope than the send itself");
        // Negative rows: no identifiable request model stays credential-wide.
        assert.equal(throttle429ModelScope(429, undefined, MARKERLESS_RPM), undefined);
        assert.equal(throttle429ModelScope(429, "", MARKERLESS_RPM), undefined);
        // Non-429 never carries a scope.
        assert.equal(throttle429ModelScope(400, MODEL, MARKERLESS_RPM), undefined);
        // The recognized marker still wins (identical outcome, marker discipline).
        assert.equal(throttle429ModelScope(429, MODEL, KEYRING_MODEL_ERROR), MODEL);
    });
});

test("#5199: scope=model — a marker-less 429 holds its own model, siblings keep sending", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_SCOPE: "model" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0, throttle429ModelScope(429, MODEL, MARKERLESS_RPM));
        assert.equal(activeThrottleHolds()[0].model, MODEL, "the hold is model-scoped");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 100, MODEL), "the exhausted model is held");
        assert.equal(throttleReject(URL_A, H_CRED_A, T0 + 100, SIBLING), undefined, "a sibling model on the same credential stays eligible (#5199 fix)");
        assert.equal(throttleReject(URL_A, H_CRED_A, T0 + 100, undefined), undefined, "model-less sends bypass a model hold (a model mismatch cannot freeze them)");

        noteUpstreamThrottleResolved(URL_A, H_CRED_A, 200, T0 + 200, SIBLING);
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 300, MODEL), "a sibling's success does not clear the model hold");
        noteUpstreamThrottleResolved(URL_A, H_CRED_A, 200, T0 + 400, MODEL);
        assert.equal(throttleReject(URL_A, H_CRED_A, T0 + 500, MODEL), undefined, "the matching model's success clears it");
        _resetUpstreamThrottleForTest();
    });
});

test("#5199: scope=model — a marker-less model-LESS 429 stays credential-wide (protection never widens)", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_SCOPE: "model" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0, throttle429ModelScope(429, undefined, MARKERLESS_RPM));
        const st = activeThrottleHolds()[0];
        assert.equal(st.model, undefined, "no request model → legacy credential-wide hold");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 100, MODEL), "credential hold still gates a model send");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 100, SIBLING), "credential hold still gates every model (#4204 storm protection intact)");
        _resetUpstreamThrottleForTest();
    });
});

test("#5199: scope flip is read per settlement — credential-mode account hold stays until cleared", () => {
    withKnobs({ BILI_THROTTLE_429: "1" }, () => {
        _resetUpstreamThrottleForTest();
        // Armed while scope=credential: a credential-wide hold.
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0, throttle429ModelScope(429, MODEL, MARKERLESS_RPM));
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 100, SIBLING));
        // Flipping the knob live changes only FUTURE settlements...
        process.env.BILI_THROTTLE_429_SCOPE = "model";
        assert.equal(throttle429ModelScope(429, SIBLING, MARKERLESS_RPM), SIBLING);
        // ...the already-armed credential hold keeps gating until its probe clears.
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 150, SIBLING));
        noteUpstreamThrottleResolved(URL_A, H_CRED_A, 200, T0 + 200, SIBLING);
        assert.equal(throttleReject(URL_A, H_CRED_A, T0 + 250, SIBLING), undefined, "cleared as before");
        _resetUpstreamThrottleForTest();
    });
});
