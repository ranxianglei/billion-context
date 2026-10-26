// #4204: egress-side 429 throttle governor — consecutive upstream 429s stop
// amplifying: local 429+Retry-After holds (exponential backoff × jitter,
// upstream Retry-After honored), TERMINAL 424 outside SDK retry sets once the
// budget is exhausted, one probe per backoff window for automatic recovery,
// ANY resolved non-429 clears immediately, per origin+credential isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    activeThrottleHolds,
    noteUpstreamThrottle429,
    noteUpstreamThrottleResolved,
    upstreamThrottleLocalReject,
    _resetUpstreamThrottleForTest,
} from "../src/upstream-throttle.ts";

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

test("#4204: fresh origin is allowed; nothing armed yet (negative row)", () => {
    withKnobs({ BILI_THROTTLE_429: "1" }, () => {
        _resetUpstreamThrottleForTest();
        assert.equal(activeThrottleHolds().length, 0);
        assert.equal(upstreamThrottleLocalReject(URL_A, H_EMPTY, T0), undefined);
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

        const g = upstreamThrottleLocalReject(URL_A, H_EMPTY, T0 + 100);
        assert.ok(g, "send during the window must be rejected locally");
        assert.equal(g.status, 429);
        assert.equal(g.code, "bili_throttle_hold");
        assert.ok(g.retryAfterSec !== null && g.retryAfterSec >= 1 && g.retryAfterSec <= 2, `retryAfterSec=${g.retryAfterSec}`);
        assert.equal(g.host, "z.example");
        assert.ok(g.message.includes("z.example"));
        assert.equal(g.streak, 1);
        assert.equal(g.maxConsecutive, 5);

        // Repeated local rejects must not mutate the hold (no state drift).
        const g2 = upstreamThrottleLocalReject(URL_A, H_EMPTY, T0 + 200);
        assert.ok(g2);
        assert.equal(g2.nextAttemptAt, st.nextAttemptAt);
        assert.equal(g2.streak, 1);
    });
});

test("#4204: any resolved non-429 clears the hold (400 counts — endpoint is processing)", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        assert.ok(upstreamThrottleLocalReject(URL_A, H_EMPTY, T0 + 100), "armed: rejected");
        noteUpstreamThrottleResolved(URL_A, H_EMPTY, 400);
        assert.equal(activeThrottleHolds().length, 0, "hold cleared");
        assert.equal(upstreamThrottleLocalReject(URL_A, H_EMPTY, T0 + 200), undefined, "allowed again");
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
        const g = upstreamThrottleLocalReject(URL_A, H_EMPTY, T0 + 1000);
        assert.ok(g);
        assert.equal(g.status, 424);
        assert.equal(g.code, "bili_throttle_terminal");
        assert.equal(g.retryAfterSec, null);
        assert.equal(g.streak, 3);
        assert.equal(g.maxConsecutive, 3);

        // Window opens → exactly one probe admitted → success clears everything.
        assert.equal(upstreamThrottleLocalReject(URL_A, H_EMPTY, st.nextAttemptAt), undefined, "probe admitted at window edge");
        noteUpstreamThrottleResolved(URL_A, H_EMPTY, 200);
        assert.equal(activeThrottleHolds().length, 0, "cleared after successful probe");
        assert.equal(upstreamThrottleLocalReject(URL_A, H_EMPTY, st.nextAttemptAt + 1), undefined);
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
        assert.equal(upstreamThrottleLocalReject(URL_A, H_EMPTY, edge), undefined, "first caller at window edge gets the probe");
        const dup = upstreamThrottleLocalReject(URL_A, H_EMPTY, edge);
        assert.ok(dup, "concurrent caller while probe is in flight is held locally");
        assert.equal(upstreamThrottleLocalReject(URL_A, H_EMPTY, edge + 30_000), undefined, "slot self-releases after the probe TTL even without a verdict");
    });
});

test("#4204: same origin, different credentials — independent pools, no cross-account collateral", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_CRED_A, null, T0);
        assert.ok(upstreamThrottleLocalReject(URL_A, H_CRED_A, T0 + 100), "credential A held");
        assert.equal(upstreamThrottleLocalReject(URL_A, H_CRED_B, T0 + 100), undefined, "credential B unaffected");
        assert.equal(upstreamThrottleLocalReject(URL_A, H_EMPTY, T0 + 100), undefined, "credential-less lane unaffected");
        assert.equal(activeThrottleHolds().length, 1, "only one pool armed");
    });
});

test("#4204: disabled knob restores legacy behavior — observations are no-ops, gate always allows", () => {
    withKnobs({ BILI_THROTTLE_429: "0" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        noteUpstreamThrottle429(URL_A, H_EMPTY, null, T0);
        assert.equal(activeThrottleHolds().length, 0, "disabled: no state recorded");
        assert.equal(upstreamThrottleLocalReject(URL_A, H_EMPTY, T0 + 100), undefined, "disabled: never gated");
    });
});

test("#4204: bounded state table — 65 origins evict the oldest, no crash", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        for (let i = 0; i < 65; i++) {
            noteUpstreamThrottle429(`http://h${i}.invalid/v1/chat/completions`, H_EMPTY, null, T0 + i);
        }
        assert.equal(activeThrottleHolds().length, 64, "table bounded at 64");
        assert.equal(upstreamThrottleLocalReject("http://h0.invalid/v1/chat/completions", H_EMPTY, T0 + 1), undefined, "oldest origin evicted → no hold");
        assert.ok(upstreamThrottleLocalReject("http://h64.invalid/v1/chat/completions", H_EMPTY, T0 + 65), "newest origin still held");
    });
});
