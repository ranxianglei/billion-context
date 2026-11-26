import test from "node:test";
import assert from "node:assert/strict";
import { classifyUpstreamFailure, isFailFastUpstreamKind } from "../src/upstream-fail.js";
import { ALERT_KINDS } from "../src/upstream-alerts.js";
import { _resetFetchUtilForTest, fetchWithRetry, fetchWithTransportRetry } from "../src/fetch-util.js";

function timeout(syscall?: string): Error {
    return Object.assign(new Error("connect ETIMEDOUT 192.0.2.1:443"), { code: "ETIMEDOUT", syscall });
}

function familyFailure(errors: unknown[] = [
    timeout("connect"),
    Object.assign(new Error("connect ENETUNREACH 2001:db8::1:443"), { code: "ENETUNREACH", syscall: "connect" }),
]): Error {
    const aggregate = Object.assign(new AggregateError(errors, ""), { code: "ETIMEDOUT" });
    return new TypeError("fetch failed", { cause: aggregate });
}

for (const [name, error] of [
    ["direct connect timeout", timeout("connect")],
    ["wrapped connect timeout", new TypeError("fetch failed", { cause: timeout("connect") })],
    ["Node dual-stack aggregate", familyFailure()],
] as const) {
    test(`${name} uses the existing replayable and alertable connect category`, () => {
        for (const viaProxy of [false, true]) {
            const kind = classifyUpstreamFailure(error, { viaProxy });
            assert.equal(kind, "connect-timeout");
            assert.equal(isFailFastUpstreamKind(kind), true);
            assert.equal(ALERT_KINDS.has(kind), true);
        }
    });
}

for (const [name, error] of [
    ["unknown phase despite connect-shaped prose", timeout()],
    ["read timeout", timeout("read")],
    ["write timeout", timeout("write")],
    ["empty aggregate", familyFailure([])],
    ["sparse aggregate", new TypeError("fetch failed", { cause: Object.assign(new AggregateError([], ""), { code: "ETIMEDOUT", errors: new Array(2) }) })],
    ["aggregate with an unknown phase", familyFailure([timeout("connect"), timeout()])],
    ["aggregate with a read failure", familyFailure([timeout("connect"), timeout("read")])],
    ["aggregate with a non-error child", familyFailure([timeout("connect"), { syscall: "connect" }])],
] as const) {
    test(`${name} remains a non-replayed timeout`, () => {
        const kind = classifyUpstreamFailure(error);
        assert.equal(kind, "upstream-timeout");
        assert.equal(isFailFastUpstreamKind(kind), false);
        assert.equal(ALERT_KINDS.has(kind), false);
    });
}

test("client cancellation overrides a proven connect phase", () => {
    for (const error of [timeout("connect"), familyFailure()]) {
        assert.equal(classifyUpstreamFailure(error, { externalAborted: true }), "client-abort");
    }
});

for (const send of [fetchWithRetry, fetchWithTransportRetry]) {
    test(`${send.name} recovers from the Node connect aggregate without changing the request`, async (t) => {
        const previousDelay = process.env.BILI_REPLAY_RETRY_BASE_MS;
        const previousMax = process.env.BILI_REPLAY_RETRY_MAX;
        process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
        process.env.BILI_REPLAY_RETRY_MAX = "3";
        t.after(() => {
            if (previousDelay === undefined) delete process.env.BILI_REPLAY_RETRY_BASE_MS;
            else process.env.BILI_REPLAY_RETRY_BASE_MS = previousDelay;
            if (previousMax === undefined) delete process.env.BILI_REPLAY_RETRY_MAX;
            else process.env.BILI_REPLAY_RETRY_MAX = previousMax;
            _resetFetchUtilForTest();
        });
        const attempts: Array<{ url: string; method: string | undefined; body: RequestInit["body"] }> = [];
        t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
            attempts.push({ url: String(url), method: init?.method, body: init?.body });
            if (attempts.length === 1) throw familyFailure();
            return new Response("ok", { status: 200 });
        });
        const retries: string[] = [];
        const result = await send("https://example.com/v1/messages", { method: "POST", body: '{"messages":[]}' }, 5000, undefined,
            (info) => retries.push(info.detail));
        try {
            assert.equal(await result.response.text(), "ok");
        } finally {
            result.clearTimer();
        }
        assert.equal(attempts.length, 2);
        assert.deepEqual(attempts[0], attempts[1]);
        assert.equal(retries.length, 1);
        assert.match(retries[0]!, /^connect-timeout /);
    });

    test(`${send.name} keeps the existing retry budget for persistent connect timeouts`, async (t) => {
        const previousDelay = process.env.BILI_REPLAY_RETRY_BASE_MS;
        const previousMax = process.env.BILI_REPLAY_RETRY_MAX;
        process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
        process.env.BILI_REPLAY_RETRY_MAX = "2";
        t.after(() => {
            if (previousDelay === undefined) delete process.env.BILI_REPLAY_RETRY_BASE_MS;
            else process.env.BILI_REPLAY_RETRY_BASE_MS = previousDelay;
            if (previousMax === undefined) delete process.env.BILI_REPLAY_RETRY_MAX;
            else process.env.BILI_REPLAY_RETRY_MAX = previousMax;
            _resetFetchUtilForTest();
        });
        const failure = familyFailure();
        let attempts = 0;
        t.mock.method(globalThis, "fetch", async () => { attempts++; throw failure; });
        await assert.rejects(send("https://example.com/v1/messages", { method: "POST", body: "{}" }, 5000, undefined),
            (error) => error === failure);
        assert.equal(attempts, 2);
    });
}
