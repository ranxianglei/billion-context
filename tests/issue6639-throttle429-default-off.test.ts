// #6639/#5853 decision: the egress 429 governor (#4204) is OFF by default.
// With no BILI_THROTTLE_429 env and no network.throttle429Enabled config,
// upstream 429s are forwarded to the client untouched — no local hold, no
// terminal 424 — and bili logs one [429-passthrough] warn per observed 429.
// The governor stays available as an opt-in escape hatch (env "1" or config
// true) for accounts where host retry storms pin a shared concurrency limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    activeThrottleHolds,
    beginProvisionalUpstreamThrottle429,
    noteUpstreamThrottle429,
    upstreamThrottleGate,
    upstreamThrottlePeekReject,
    _resetUpstreamThrottleForTest,
} from "../src/upstream-throttle.ts";
import { throttle429Enabled } from "../src/knobs.ts";
import { setLogCapture } from "../src/logger.ts";

const URL_A = "http://z.example/api/coding/paas/v4/chat/completions";
const H_CRED_A: Record<string, string> = { authorization: "Bearer AAA" };
const T0 = 1_000_000;

const KNOB_ENVS = [
    "BILI_THROTTLE_429",
    "BILI_THROTTLE_429_MAX_CONSECUTIVE",
    "BILI_THROTTLE_429_BASE_DELAY_MS",
    "BILI_THROTTLE_429_MAX_DELAY_MS",
    "BILI_THROTTLE_429_SCOPE",
    "BILI_CONFIG_FILE",
] as const;

/** No throttle env, no reachable config file — the pure default. */
function withDefaults(fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const k of KNOB_ENVS) saved[k] = process.env[k];
    try {
        for (const k of KNOB_ENVS) {
            if (k === "BILI_CONFIG_FILE") process.env.BILI_CONFIG_FILE = "/nonexistent-bili-6639-config.json";
            else delete process.env[k];
        }
        _resetUpstreamThrottleForTest();
        fn();
    } finally {
        for (const k of KNOB_ENVS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

test("default (no env, no config): governor is OFF — the passthrough posture (#6639)", () => {
    withDefaults(() => {
        assert.equal(throttle429Enabled(), false);
    });
});

test("default: 8 sequential upstream 429s never produce a local hold or a 424", () => {
    withDefaults(() => {
        for (let i = 0; i < 8; i++) {
            const gate = upstreamThrottleGate(URL_A, H_CRED_A, T0 + i * 1000, "glm-5.2");
            assert.equal(gate.reject, undefined, `request ${i + 1}: no local rejection`);
            assert.equal(gate.probeToken, undefined, `request ${i + 1}: no probe token minted`);
            assert.equal(upstreamThrottlePeekReject(URL_A, H_CRED_A, T0 + i * 1000 + 500, "glm-5.2"), undefined);
            noteUpstreamThrottle429(URL_A, H_CRED_A, "600", T0 + i * 1000, "glm-5.2");
        }
        assert.equal(activeThrottleHolds().length, 0, "no hold state stored while disabled");
    });
});

test("default: every observed 429 logs one [429-passthrough] warn (gate + provisional paths)", () => {
    withDefaults(() => {
        const captured: { level: string; msg: string }[] = [];
        setLogCapture((level, msg) => captured.push({ level, msg }));
        try {
            noteUpstreamThrottle429(URL_A, H_CRED_A, "600", T0, "glm-5.2");
            const settle = beginProvisionalUpstreamThrottle429(
                URL_A, H_CRED_A, null, T0 + 1000, "glm-5.2",
            );
            settle("glm-5.2"); // settle must stay a no-op while disabled
            const warns = captured.filter((c) => c.level === "warn" && c.msg.includes("[429-passthrough]"));
            assert.equal(warns.length, 2, `expected 2 passthrough warns, got: ${captured.map((c) => c.msg).join(" | ")}`);
            assert.match(warns[0]!.msg, /upstream 429 forwarded to the client unchanged/);
            assert.match(warns[0]!.msg, /for model "glm-5\.2"/);
            assert.match(warns[0]!.msg, /Retry-After ~600s/);
            assert.match(warns[1]!.msg, /z\.example/);
            // The provisional settler released its state: nothing armed.
            assert.equal(activeThrottleHolds().length, 0);
        } finally {
            setLogCapture(null);
        }
    });
});

test("opt-in escape hatch: BILI_THROTTLE_429=1 re-arms the governor (#4204)", () => {
    const savedEnv = process.env.BILI_THROTTLE_429;
    const savedCfg = process.env.BILI_CONFIG_FILE;
    process.env.BILI_THROTTLE_429 = "1";
    process.env.BILI_CONFIG_FILE = "/nonexistent-bili-6639-config.json";
    try {
        _resetUpstreamThrottleForTest();
        assert.equal(throttle429Enabled(), true);
        noteUpstreamThrottle429(URL_A, H_CRED_A, "600", T0, "glm-5.2");
        const hold = activeThrottleHolds()[0];
        assert.ok(hold, "opt-in: hold state stored");
        assert.equal(hold.streak, 1);
        const gate = upstreamThrottleGate(URL_A, H_CRED_A, T0 + 10, "glm-5.2");
        assert.ok(gate.reject, "opt-in: subsequent send rejected locally");
    } finally {
        _resetUpstreamThrottleForTest();
        if (savedEnv === undefined) delete process.env.BILI_THROTTLE_429;
        else process.env.BILI_THROTTLE_429 = savedEnv;
        if (savedCfg === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = savedCfg;
    }
});
