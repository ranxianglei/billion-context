// #4204: egress-side 429 governor — consecutive upstream 429s stop amplifying:
// account limits hold origin+credential; a request-matched KeyRing model
// refusal holds only origin+credential+model.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    activeThrottleHolds,
    beginProvisionalUpstreamThrottle429,
    keyringModel429Scope,
    noteUpstreamThrottle429,
    noteUpstreamThrottleResolved,
    requestModelFromBody,
    reserveUpstreamThrottleClassification,
    upstreamThrottleGate,
    _resetUpstreamThrottleForTest,
} from "../src/upstream-throttle.ts";

const URL_A = "http://z.example/api/coding/paas/v4/chat/completions";
const URL_B = "http://keyring-b.example/api/coding/paas/v4/chat/completions";
const H_EMPTY: Record<string, string> = {};
const H_CRED_A: Record<string, string> = { authorization: "Bearer AAA" };
const H_CRED_B: Record<string, string> = { authorization: "Bearer BBB" };
// Integer-second timestamps: keeps HTTP-date Retry-After fixtures exact.
const T0 = 1_000_000;

function throttleReject(url: string, headers: Record<string, string>, now?: number, requestModel?: string) {
    return upstreamThrottleGate(url, headers, now, requestModel).reject;
}

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

test("#4204: request model extraction is not limited by the error-body cap", () => {
    const model = "deepseek-v4.1-flash";
    const body = JSON.stringify({ model, messages: [{ content: "x".repeat(20 * 1024) }] });
    assert.ok(new TextEncoder().encode(body).byteLength > 16 * 1024);
    assert.equal(requestModelFromBody(body), model);
    assert.equal(requestModelFromBody(new TextEncoder().encode(body)), model);
});
test("#4204: passthrough model scan uses top-level JSON semantics without parsing nested history", () => {
    assert.equal(
        requestModelFromBody('{"metadata":{"model":"nested"},"\\u006dodel":"escaped"}'),
        "escaped",
        "escaped top-level key is recognized while nested model keys are ignored",
    );
    assert.equal(requestModelFromBody('{"model":"first","model":"last"}'), "last", "duplicate members follow JSON.parse last-value semantics");
    assert.equal(requestModelFromBody('{"model":"first","model":1}'), undefined, "a non-string last member clears an earlier model");
});

test("#4204: Bili local model hold marker requires its exact scope and request model", () => {
    const model = "deepseek-v4.1-flash";
    const marker = (scope: string | undefined, responseModel: string) =>
        JSON.stringify({ error: { code: "bili_throttle_hold", ...(scope === undefined ? {} : { scope }), model: responseModel } });
    assert.equal(keyringModel429Scope(429, model, marker("model", model)), model);
    assert.equal(keyringModel429Scope(429, model, marker("account", model)), undefined);
    assert.equal(keyringModel429Scope(429, model, marker(undefined, model)), undefined);
    assert.equal(keyringModel429Scope(429, model, marker("model", "different-model")), undefined);
    assert.equal(keyringModel429Scope(400, model, marker("model", model)), undefined);
});

test("#4204: fresh origin is allowed; nothing armed yet (negative row)", () => {
    withKnobs({ BILI_THROTTLE_429: "1" }, () => {
        _resetUpstreamThrottleForTest();
        assert.equal(activeThrottleHolds().length, 0);
        assert.equal(throttleReject(URL_A, H_EMPTY, T0), undefined);
    });
});

test("#4204: first 429 arms a hold — next send answered locally 429 + Retry-After", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        const st = activeThrottleHolds()[0];
        assert.ok(st, "hold recorded");
        assert.equal(st.streak, 1);
        assert.equal(st.terminal, false);
        // streak 1: exp = base → jittered delay lands in [base/2, base].
        assert.ok(st.nextAttemptAt - T0 >= 1000 && st.nextAttemptAt - T0 <= 2000, `delay ${st.nextAttemptAt - T0} outside [1000,2000]`);

        const g = throttleReject(URL_A, H_EMPTY, T0 + 100);
        assert.ok(g, "send during the window must be rejected locally");
        assert.equal(g.status, 429);
        assert.equal(g.code, "bili_throttle_hold");
        assert.ok(g.retryAfterSec !== null && g.retryAfterSec >= 1 && g.retryAfterSec <= 2, `retryAfterSec=${g.retryAfterSec}`);
        assert.equal(g.host, "z.example");
        assert.ok(g.message.includes("z.example"));
        assert.equal(g.streak, 1);
        assert.equal(g.maxConsecutive, 5);

        // Repeated local rejects must not mutate the hold (no state drift).
        const g2 = throttleReject(URL_A, H_EMPTY, T0 + 200);
        assert.ok(g2);
        assert.equal(g2.nextAttemptAt, st.nextAttemptAt);
        assert.equal(g2.streak, 1);
    });
});

test("#4204: any resolved non-429 clears the hold (400 counts — endpoint is processing)", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        assert.ok(throttleReject(URL_A, H_EMPTY, T0 + 100), "armed: rejected");
        noteUpstreamThrottleResolved(URL_A, H_EMPTY, 400);
        assert.equal(activeThrottleHolds().length, 0, "hold cleared");
        assert.equal(throttleReject(URL_A, H_EMPTY, T0 + 200), undefined, "allowed again");
    });
});

test("#4204: budget exhausted → TERMINAL 424 without Retry-After; probe then success recovers fully", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "3", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        const st = activeThrottleHolds()[0];
        assert.equal(st.streak, 3);
        assert.equal(st.terminal, true);

        // Terminal verdict holds even mid-window — hosts must give up now.
        const g = throttleReject(URL_A, H_EMPTY, T0 + 1000);
        assert.ok(g);
        assert.equal(g.status, 424);
        assert.equal(g.code, "bili_throttle_terminal");
        assert.equal(g.retryAfterSec, null);
        assert.equal(g.streak, 3);
        assert.equal(g.maxConsecutive, 3);

        const probe = upstreamThrottleGate(URL_A, H_EMPTY, st.nextAttemptAt);
        assert.equal(probe.reject, undefined, "window opens and admits a probe");
        assert.equal(typeof probe.probeToken, "symbol", "admitted probe has a request-owned token");
        noteUpstreamThrottleResolved(URL_A, H_EMPTY, 200, st.nextAttemptAt + 1, undefined, probe.probeToken);
        assert.equal(activeThrottleHolds().length, 0, "cleared after successful probe");
        assert.equal(upstreamThrottleGate(URL_A, H_EMPTY, st.nextAttemptAt + 2).reject, undefined);
    });
});

test("#4204: backoff doubles per consecutive 429 and caps at maxDelay", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "8", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        // streak k ⇒ exp = min(cap, base·2^(k-1)) = 1000,2000,4000,8000,8000
        const expectedExp = [1000, 2000, 4000, 8000, 8000];
        for (let k = 0; k < expectedExp.length; k++) {
            noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
            const delay = activeThrottleHolds()[0].nextAttemptAt - T0;
            const exp = expectedExp[k];
            assert.ok(delay >= exp / 2 && delay <= exp, `streak ${k + 1}: delay ${delay} outside [${exp / 2},${exp}]`);
        }
    });
});

test("#4204: upstream Retry-After wins when larger — seconds, HTTP-date, garbage ignored, hard cap 600s", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, "30", T0);
        assert.equal(activeThrottleHolds()[0].nextAttemptAt - T0, 30_000, "seconds form honored exactly");

        _resetUpstreamThrottleForTest();
        const dateForm = new Date(T0 + 45_000).toUTCString();
        noteUpstreamThrottle429(URL_A, H_EMPTY, dateForm, T0);
        assert.equal(activeThrottleHolds()[0].nextAttemptAt - T0, 45_000, "HTTP-date form honored exactly");

        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, "not-a-time", T0);
        const dGarbage = activeThrottleHolds()[0].nextAttemptAt - T0;
        assert.ok(dGarbage >= 500 && dGarbage <= 1000, `garbage header must fall back to backoff, got ${dGarbage}`);

        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, "9999", T0);
        assert.equal(activeThrottleHolds()[0].nextAttemptAt - T0, 600_000, "Retry-After capped at 600s");
    });
});

test("#4204: single-flight probe — one admit per open window, slot self-releases after TTL", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        const edge = activeThrottleHolds()[0].nextAttemptAt;
        const first = upstreamThrottleGate(URL_A, H_EMPTY, edge);
        assert.equal(first.reject, undefined, "first caller at window edge gets the probe");
        assert.equal(typeof first.probeToken, "symbol");
        const dup = upstreamThrottleGate(URL_A, H_EMPTY, edge);
        assert.ok(dup.reject, "concurrent caller while probe is in flight is held locally");
        assert.equal(dup.probeToken, undefined, "rejected sends do not receive a token");
        const afterTtl = upstreamThrottleGate(URL_A, H_EMPTY, edge + 30_000);
        assert.equal(afterTtl.reject, undefined, "slot self-releases after the probe TTL even without a verdict");
        assert.equal(typeof afterTtl.probeToken, "symbol");
        assert.notEqual(afterTtl.probeToken, first.probeToken, "each admitted probe has unique ownership");
    });
});

test("#4204: same origin, different credentials — independent pools, no cross-account collateral", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0);
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 100), "credential A held");
        assert.equal(throttleReject(URL_A, H_CRED_B, T0 + 100), undefined, "credential B unaffected");
        assert.equal(throttleReject(URL_A, H_EMPTY, T0 + 100), undefined, "credential-less lane unaffected");
        assert.equal(activeThrottleHolds().length, 1, "only one pool armed");
    });
});

test("#4204: a matching KeyRing model refusal holds only that model; account quota remains origin+credential", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const model = "deepseek-v4.1-flash";
        const otherModel = "qwen3.8-flash";
        const modelError = JSON.stringify({
            error: { code: "keyring_model_temporarily_unavailable", model },
        });
        const modelScope = keyringModel429Scope(429, model, modelError);
        assert.equal(modelScope, model, "only the exact KeyRing model code+request model grants model scope");
        assert.equal(keyringModel429Scope(429, otherModel, modelError), undefined, "response model must match request model");
        assert.equal(
            keyringModel429Scope(429, model, JSON.stringify({ error: { code: "keyring_all_limited", model } })),
            undefined,
            "keyring_all_limited is account quota even when it echoes a model",
        );
        assert.equal(
            keyringModel429Scope(
                429,
                model,
                JSON.stringify({ error: { code: "GoUsageLimitError", message: "monthly OpenCode Go usage limit exhausted" } }),
            ),
            undefined,
            "direct OpenCode monthly quota is not a KeyRing model-local marker",
        );
        assert.equal(keyringModel429Scope(429, model, "{malformed"), undefined);
        assert.equal(keyringModel429Scope(400, model, modelError), undefined);

        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0, modelScope);
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 100, model), "the refused model is held");
        assert.equal(throttleReject(URL_A, H_CRED_A, T0 + 100, otherModel), undefined, "another model on the same credential stays eligible");
        assert.equal(activeThrottleHolds()[0].model, model);
        noteUpstreamThrottleResolved(URL_A, H_CRED_A, 200, T0 + 200, otherModel);
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 300, model), "another model's success does not clear this model hold");
        noteUpstreamThrottleResolved(URL_A, H_CRED_A, 200, T0 + 400, model);
        assert.equal(throttleReject(URL_A, H_CRED_A, T0 + 500, model), undefined, "the matching model's resolved response clears its hold");
        assert.equal(activeThrottleHolds().length, 0);

        const accountError = JSON.stringify({ error: { code: "GoUsageLimitError", message: "monthly OpenCode Go usage limit exceeded" } });
        const accountScope = keyringModel429Scope(429, model, accountError);
        assert.equal(accountScope, undefined);
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0 + 600, accountScope);
        assert.equal(activeThrottleHolds()[0].model, undefined, "account quota is not assigned a model scope");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 700, model), "account quota holds the requested model");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 700, otherModel), "account quota holds every model on this origin+credential");
        _resetUpstreamThrottleForTest();
    });
});

test("#4204: overlapping account and model holds select the strongest reject and share one probe", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const model = "deepseek-v4.1-flash";
        noteUpstreamThrottle429(URL_A, H_CRED_A, "10", T0, model);
        noteUpstreamThrottle429(URL_A, H_CRED_A, "5", T0 + 1);
        const modelHold = activeThrottleHolds().find((hold) => hold.model === model);
        const accountHold = activeThrottleHolds().find((hold) => hold.model === undefined);
        assert.ok(modelHold);
        assert.ok(accountHold);
        const edge = Math.max(modelHold.nextAttemptAt, accountHold.nextAttemptAt);

        const strongest = throttleReject(URL_A, H_CRED_A, T0 + 100, model);
        assert.ok(strongest);
        assert.equal(strongest.model, model, "the applicable hold with the longest backoff is selected");
        assert.equal(throttleReject(URL_A, H_CRED_A, T0 + 100, "other-model")?.model, undefined);

        const probe = upstreamThrottleGate(URL_A, H_CRED_A, edge, model);
        assert.equal(probe.reject, undefined, "one request claims both open probe slots");
        assert.equal(typeof probe.probeToken, "symbol");
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, edge + 1, model).reject, "the overlapping model hold is still in flight");
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, edge + 1, "other-model").reject, "the account hold shares the same probe slot");
        noteUpstreamThrottleResolved(URL_A, H_CRED_A, 200, edge + 2, model, probe.probeToken);
        assert.equal(activeThrottleHolds().length, 0);
    });
});

test("#4204: a 429 releases only the request-owned probe even when observation scope differs", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const requestModel = "request-model";
        const observedScope = "different-observation-scope";
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0, requestModel);
        const edge = activeThrottleHolds()[0].nextAttemptAt;
        const probe = upstreamThrottleGate(URL_A, H_CRED_A, edge, requestModel);
        assert.equal(probe.reject, undefined, "the original model probe is claimed");
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, edge + 1, requestModel).reject, "the probe starts in flight");

        noteUpstreamThrottle429(URL_A, H_CRED_A, null, edge + 1, observedScope, probe.probeToken);
        const next = upstreamThrottleGate(URL_A, H_CRED_A, edge + 2, requestModel);
        assert.equal(next.reject, undefined, "the actual request-model slot is released despite the changed observation scope");
        assert.equal(typeof next.probeToken, "symbol", "the original model hold admits a new probe after its owner completes");
        assert.notEqual(next.probeToken, probe.probeToken, "a later probe receives distinct ownership");
    });
});
test("#4204: a matching-model success cannot release another request's probe", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const model = "request-model";
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0, model);
        const edge = activeThrottleHolds()[0].nextAttemptAt;
        const probe = upstreamThrottleGate(URL_A, H_CRED_A, edge, model);
        assert.equal(probe.reject, undefined);
        assert.ok(probe.probeToken);

        noteUpstreamThrottleResolved(URL_A, H_CRED_A, 200, edge + 1, model, Symbol("unrelated request"));
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, edge + 2, model).reject, "model equality alone cannot release an active probe");

        noteUpstreamThrottleResolved(URL_A, H_CRED_A, 200, edge + 3, model, probe.probeToken);
        assert.equal(activeThrottleHolds().length, 0, "the owning completion clears its model hold");
    });
});
test("#4204: concurrent provisional observations settle independently", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const modelA = "model-a";
        const modelB = "model-b";
        const settleA = beginProvisionalUpstreamThrottle429(URL_A, H_CRED_A, null, T0, modelA);
        const settleB = beginProvisionalUpstreamThrottle429(URL_A, H_CRED_A, null, T0 + 1, modelB);

        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 2, "unrelated-model").reject, "unresolved scope is conservatively account-wide");
        settleA(modelA);
        assert.ok(activeThrottleHolds().some((hold) => hold.model === modelA), "first observation narrows to model A");
        assert.ok(activeThrottleHolds().some((hold) => hold.model === undefined), "second pending observation remains account-scoped");
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 3, modelA).reject, "the other pending observation still gates model A");
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 3, modelB).reject, "the other pending observation still gates model B");

        settleB(modelB);
        const refined = activeThrottleHolds();
        assert.equal(refined.length, 2);
        assert.ok(refined.some((hold) => hold.model === modelA));
        assert.ok(refined.some((hold) => hold.model === modelB));
        assert.equal(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 4, "unrelated-model").reject, undefined, "independent exact refinements remove only their account-wide provisional holds");
    });
});
test("#4204: an ambiguous concurrent refinement remains account-wide beside exact model evidence", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const modelA = "model-a";
        const settleExact = beginProvisionalUpstreamThrottle429(URL_A, H_CRED_A, null, T0, modelA);
        const settleAmbiguous = beginProvisionalUpstreamThrottle429(URL_A, H_CRED_A, null, T0 + 1, "model-b");
        settleExact(modelA);
        settleAmbiguous(undefined);

        assert.ok(activeThrottleHolds().some((hold) => hold.model === modelA), "exact evidence is model-scoped");
        assert.ok(activeThrottleHolds().some((hold) => hold.model === undefined), "ambiguous evidence remains account-scoped");
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 2, "other-model").reject);
    });
});
test("#4204: exact refinement preserves genuine account evidence", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const model = "deepseek-v4.1-flash";
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0);
        const settle = beginProvisionalUpstreamThrottle429(URL_A, H_CRED_A, null, T0 + 1, model);
        settle(model);

        assert.ok(activeThrottleHolds().some((hold) => hold.model === undefined), "verified account evidence remains account-wide");
        assert.ok(activeThrottleHolds().some((hold) => hold.model === model), "the provisional observation becomes a separate model hold");
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 2, "other-model").reject, "the verified account hold still gates other models");
    });
});
test("#4204: ambiguous provisional settlement confirms account scope", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const settle = beginProvisionalUpstreamThrottle429(URL_A, H_CRED_A, null, T0, "request-model");
        settle(undefined);
        assert.equal(activeThrottleHolds().length, 1);
        assert.equal(activeThrottleHolds()[0].model, undefined);
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 1, "other-model").reject);
    });
});
test("#4204: an unrelated success does not consume a pending refinement", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const model = "deepseek-v4.1-flash";
        const settle = beginProvisionalUpstreamThrottle429(URL_A, H_CRED_A, null, T0, model);
        noteUpstreamThrottleResolved(URL_A, H_CRED_A, 200, T0 + 1, "other-model");
        settle(model);
        assert.equal(activeThrottleHolds().length, 1);
        assert.equal(activeThrottleHolds()[0].model, model, "only the observation's own settlement refines it");
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 2, model).reject);
        assert.equal(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 2, "other-model").reject, undefined);
        _resetUpstreamThrottleForTest();
    });
});

test("#4204: provisional settlement is one-shot and only an exact request model narrows", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        const model = "deepseek-v4.1-flash";
        const settle = beginProvisionalUpstreamThrottle429(URL_A, H_CRED_A, null, T0, model);
        settle("different-model");
        settle(model);
        assert.equal(activeThrottleHolds().length, 1);
        assert.equal(activeThrottleHolds()[0].model, undefined, "a mismatch confirms account scope and later calls cannot narrow it");
        assert.ok(upstreamThrottleGate(URL_A, H_CRED_A, T0 + 1, "other-model").reject);
        _resetUpstreamThrottleForTest();
    });
});

test("#4204: 64 pending observations share bounded provisional state without evicting account holds", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0);
        const model = "model-b";
        const settlers: Array<(modelScope?: string) => void> = [];
        for (let i = 0; i < 64; i++) {
            settlers.push(beginProvisionalUpstreamThrottle429(URL_B, H_CRED_B, null, T0 + i, model));
        }

        const pending = activeThrottleHolds();
        assert.equal(pending.length, 2, "64 observations on B share one account-scoped pending gate");
        assert.ok(pending.some((hold) => hold.host === "z.example" && hold.model === undefined), "A's confirmed account hold remains recorded");
        assert.ok(pending.some((hold) => hold.host === "keyring-b.example" && hold.model === undefined), "B remains conservatively account-scoped while observations are pending");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 64), "A remains locally blocked");
        assert.ok(throttleReject(URL_B, H_CRED_B, T0 + 64, "other-model"), "pending B evidence gates unrelated models");

        settlers[0](model);
        assert.ok(throttleReject(URL_B, H_CRED_B, T0 + 65, "other-model"), "one exact settlement does not consume the other pending observations");
        for (let i = 1; i < settlers.length; i++) settlers[i](model);

        const settled = activeThrottleHolds();
        assert.equal(settled.length, 2, "settled observations converge onto one model-local B hold");
        assert.ok(settled.some((hold) => hold.host === "z.example" && hold.model === undefined), "B's exact settlements do not alter A");
        assert.ok(settled.some((hold) => hold.host === "keyring-b.example" && hold.model === model), "B is held only for its verified model");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 100), "A remains locally blocked after every B settlement");
        assert.ok(throttleReject(URL_B, H_CRED_B, T0 + 100, model), "the verified B model remains locally blocked");
        assert.equal(throttleReject(URL_B, H_CRED_B, T0 + 100, "other-model"), undefined, "unrelated B models become eligible");
    });
});

test("#4204: ambiguous B settlement preserves B account scope beside confirmed A", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0);
        const settleB = beginProvisionalUpstreamThrottle429(URL_B, H_CRED_B, null, T0 + 1, "model-b");
        settleB(undefined);

        const holds = activeThrottleHolds();
        assert.ok(holds.some((hold) => hold.host === "z.example" && hold.model === undefined), "A's confirmed account hold remains recorded");
        assert.ok(holds.some((hold) => hold.host === "keyring-b.example" && hold.model === undefined), "ambiguous B evidence stays account-wide");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 2), "A remains locally blocked");
        assert.ok(throttleReject(URL_B, H_CRED_B, T0 + 2, "other-model"), "ambiguous B evidence gates every model");
    });
});

test("#4204: model-local inserts at capacity do not evict confirmed account holds", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0);
        for (let i = 0; i < 63; i++) {
            noteUpstreamThrottle429(`http://capacity-${i}.invalid/v1/chat/completions`, H_EMPTY, null, T0);
        }
        assert.equal(activeThrottleHolds().length, 64, "confirmed account holds fill the bounded table");

        const model = "model-b";
        noteUpstreamThrottle429(URL_B, H_CRED_B, null, T0, model);
        assert.ok(activeThrottleHolds().some((hold) => hold.host === "z.example" && hold.model === undefined), "a new model-local hold cannot evict A");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 1), "A remains locally blocked after a direct model-local insertion");

        const settleB = beginProvisionalUpstreamThrottle429(URL_B, H_CRED_B, null, T0 + 1, model);
        settleB(model);
        assert.ok(activeThrottleHolds().some((hold) => hold.host === "z.example" && hold.model === undefined), "a settled model-local hold cannot evict A");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 2), "A remains locally blocked after provisional B settlement");
        assert.equal(
            activeThrottleHolds().some((hold) => hold.host === "keyring-b.example" && hold.model === undefined),
            false,
            "capacity fallback does not widen verified B model evidence into an account hold",
        );
    });
});

test("#4204: per-account classification reservations cap continuations without gating unrelated traffic", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0);
        const model = "model-b";
        const reservations: Array<{ release(): void }> = [];
        const settlers: Array<(modelScope?: string) => void> = [];
        for (let i = 0; i < 64; i++) {
            const reservation = reserveUpstreamThrottleClassification(URL_B, H_CRED_B);
            assert.ok(reservation, "each of B's first 64 classification reservations is admitted");
            reservations.push(reservation);
            settlers.push(beginProvisionalUpstreamThrottle429(URL_B, H_CRED_B, null, T0 + i, model, undefined, reservation));
        }

        assert.equal(reserveUpstreamThrottleClassification(URL_B, H_CRED_B), undefined, "the 65th active classification for B is refused");
        const aReservation = reserveUpstreamThrottleClassification(URL_A, H_CRED_A);
        assert.ok(aReservation, "B's saturated per-account capacity does not consume A's classification slots");
        aReservation.release();
        assert.equal(
            throttleReject("http://unrelated.example/v1/chat/completions", H_EMPTY, T0 + 10_000),
            undefined,
            "B's exhausted capacity does not install a process-wide gate",
        );
        const pending = activeThrottleHolds();
        assert.equal(pending.length, 2, "64 reserved observations still share one B provisional gate");
        assert.ok(pending.some((hold) => hold.host === "z.example" && hold.model === undefined), "A's account hold remains recorded");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 100), "A remains locally blocked while B is saturated");

        settlers[0](model);
        const reopenedSlot = reserveUpstreamThrottleClassification(URL_B, H_CRED_B);
        assert.ok(reopenedSlot, "settling B's first observation releases only its reservation");
        reopenedSlot.release();
        for (let i = 1; i < settlers.length; i++) settlers[i](model);

        const settled = activeThrottleHolds();
        assert.equal(settled.length, 2, "all exact results converge onto one model-local B hold");
        assert.ok(settled.some((hold) => hold.host === "z.example" && hold.model === undefined), "A is preserved after all B settlements");
        assert.ok(settled.some((hold) => hold.host === "keyring-b.example" && hold.model === model), "B's verified model is retained");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 100), "A remains locally blocked after B settlement");
        assert.equal(throttleReject(URL_B, H_CRED_B, T0 + 100, "other-model"), undefined, "unrelated B models remain eligible");
        for (const reservation of reservations) reservation.release();
    });
});

test("#4204: reserved ambiguous settlement records account scope and releases its own slot", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "1000", BILI_THROTTLE_429_MAX_DELAY_MS: "8000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0);
        const reservation = reserveUpstreamThrottleClassification(URL_B, H_CRED_B);
        assert.ok(reservation);
        const settle = beginProvisionalUpstreamThrottle429(URL_B, H_CRED_B, null, T0 + 1, "model-b", undefined, reservation);
        settle(undefined);

        const holds = activeThrottleHolds();
        assert.ok(holds.some((hold) => hold.host === "z.example" && hold.model === undefined), "A's confirmed account hold remains recorded");
        assert.ok(holds.some((hold) => hold.host === "keyring-b.example" && hold.model === undefined), "ambiguous B evidence is confirmed at account scope");
        assert.ok(throttleReject(URL_A, H_CRED_A, T0 + 2), "A remains locally blocked");
        assert.ok(throttleReject(URL_B, H_CRED_B, T0 + 2, "other-model"), "B's ambiguous evidence holds every model");

        const replacement = reserveUpstreamThrottleClassification(URL_B, H_CRED_B);
        assert.ok(replacement, "settlement releases the reservation");
        replacement.release();
    });
});

test("#4204: classification reservations cap active account keys at 64", () => {
    withKnobs({ BILI_THROTTLE_429: "1" }, () => {
        _resetUpstreamThrottleForTest();
        const reservations: Array<{ release(): void }> = [];
        for (let i = 0; i < 64; i++) {
            const reservation = reserveUpstreamThrottleClassification(`http://classification-${i}.invalid/v1/chat/completions`, H_EMPTY);
            assert.ok(reservation, "each of the first 64 account keys is admitted");
            reservations.push(reservation);
        }

        const overflowUrl = "http://classification-overflow.invalid/v1/chat/completions";
        assert.equal(reserveUpstreamThrottleClassification(overflowUrl, H_EMPTY), undefined, "a 65th active account key is refused");
        assert.equal(throttleReject(URL_B, H_CRED_B, T0 + 1), undefined, "active classification reservations do not themselves create throttle holds");
        reservations[0].release();
        const admitted = reserveUpstreamThrottleClassification(overflowUrl, H_EMPTY);
        assert.ok(admitted, "releasing one account key makes room for another");
        admitted.release();
        for (const reservation of reservations.slice(1)) reservation.release();
    });
});

test("#4204: disabled knob restores legacy behavior — observations are no-ops, gate always allows", () => {
    withKnobs({ BILI_THROTTLE_429: "0" }, () => {
        _resetUpstreamThrottleForTest();
        const reservation = reserveUpstreamThrottleClassification(URL_A, H_EMPTY);
        assert.ok(reservation, "disabled throttling returns a no-op reservation rather than capacity failure");
        reservation.release();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        assert.equal(activeThrottleHolds().length, 0, "disabled: no state recorded");
        assert.equal(throttleReject(URL_A, H_EMPTY, T0 + 100), undefined, "disabled: never gated");
    });
});

test("#4204: bounded state table — 65 origins evict the oldest, no crash", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        for (let i = 0; i < 65; i++) {
            noteUpstreamThrottle429(`http://h${i}.invalid/v1/chat/completions`, H_EMPTY, null, T0 + i);
        }
        assert.equal(activeThrottleHolds().length, 64, "table bounded at 64");
        assert.equal(throttleReject("http://h0.invalid/v1/chat/completions", H_EMPTY, T0 + 1), undefined, "oldest origin evicted → no hold");
        assert.ok(throttleReject("http://h64.invalid/v1/chat/completions", H_EMPTY, T0 + 65), "newest origin still held");
    });
});
