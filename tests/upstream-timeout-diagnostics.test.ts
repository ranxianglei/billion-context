import test from "node:test";
import assert from "node:assert/strict";
import { describeUpstreamFailure } from "../src/upstream-proxy.js";
import { classifyUpstreamFailure, buildProxyFailureResponse, withUpstreamFailure } from "../src/upstream-fail.js";
import { fetchWithRetry, fetchWithTransportRetry } from "../src/fetch-util.js";
import { setMaskHostsEnabled } from "../src/log-mask.js";

function connectError(code: string, address: string, message = ""): Error {
    return Object.assign(new Error(message), { code, errno: -110, syscall: "connect", address, port: 443 });
}

function familyFailure(): TypeError {
    const aggregate = Object.assign(new AggregateError([
        connectError("ETIMEDOUT", "192.0.2.1"),
        connectError("ENETUNREACH", "2001:db8::1"),
    ], ""), { code: "ETIMEDOUT" });
    return new TypeError("fetch failed", { cause: aggregate });
}

test("ETIMEDOUT diagnostics do not claim that the idle watchdog expired", () => {
    for (const error of [connectError("ETIMEDOUT", "192.0.2.1"), familyFailure()]) {
        const parts = describeUpstreamFailure(error, "https://chatgpt.com/backend-api/codex/responses");
        assert.equal(parts.detail.kind, "upstream-timeout");
        assert.doesNotMatch(parts.detail.hint!, /idle budget expired/);
        assert.match(parts.detail.hint!, /phase/);
        assert.match(parts.detail.hint!, /not retried/);
    }
});

test("aggregate diagnostics retain every address attempt with its own fields", () => {
    setMaskHostsEnabled(false);
    try {
        const parts = describeUpstreamFailure(familyFailure(), "https://chatgpt.com/backend-api/codex/responses");
        assert.match(parts.message, /ENETUNREACH/);
        assert.match(parts.message, /2001:db8::1/);
        const causes = JSON.parse(parts.message.match(/causes=(\[.*\]) url=/)![1]!);
        assert.ok(causes.some((entry: Record<string, unknown>) => entry.code === "ETIMEDOUT" && entry.syscall === "connect" && entry.address === "192.0.2.1" && entry.port === 443));
        assert.ok(causes.some((entry: Record<string, unknown>) => entry.code === "ENETUNREACH" && entry.address === "2001:db8::1"));
    } finally {
        setMaskHostsEnabled(true);
    }
});

test("nested causes are masked before appearing in the client-facing 502 body", () => {
    const secret = "sk-example-secret-for-diagnostics";
    const child = connectError("ETIMEDOUT", "192.0.2.1", `connect relay.internal 192.0.2.1 https://user:password@relay.internal/path?token=${secret} Bearer ${secret}`);
    const error = new TypeError("fetch failed", { cause: new AggregateError([child], "") });
    const parts = describeUpstreamFailure(error, "https://relay.internal/v1/messages", "http://user:password@127.0.0.1:8080");
    const response = buildProxyFailureResponse(parts.message, withUpstreamFailure(new Error(parts.message), parts.detail));
    assert.equal(response.status, 502);
    assert.match(response.body, /ETIMEDOUT/);
    assert.match(response.body, /connect/);
    for (const value of [secret, "relay.internal", "192.0.2.1", "user:password"]) assert.ok(!response.body.includes(value), value);
});

test("aggregate traversal handles cyclic causes and shared children once", () => {
    const child = connectError("ENETUNREACH", "127.0.0.1", "unique-child");
    const aggregate = new AggregateError([child, child], "root");
    aggregate.cause = aggregate;
    const parts = describeUpstreamFailure(aggregate, "https://chatgpt.com/backend-api/codex/responses");
    assert.match(parts.message, /ENETUNREACH/);
    const causes = JSON.parse(parts.message.match(/causes=(\[.*\]) url=/)![1]!);
    assert.equal(causes.filter((entry: Record<string, unknown>) => entry.message === "unique-child").length, 1);
});

test("aggregate diagnostic work and output are bounded for large trees", () => {
    const errors = Array.from({ length: 200 }, (_, i) => connectError("ETIMEDOUT", "127.0.0.1", `attempt-${i}`));
    const parts = describeUpstreamFailure(new AggregateError(errors, "root"), "https://chatgpt.com/backend-api/codex/responses");
    assert.match(parts.message, /attempt-0/);
    assert.doesNotMatch(parts.message, /attempt-199/);
    assert.match(parts.message, /truncated/);
    assert.ok(parts.message.length < 20_000);
});

test("deep causes and repeated aggregate children cannot bypass traversal limits", () => {
    let deep: Error = new Error("deepest");
    for (let i = 0; i < 100; i++) deep = new Error(`level-${i}`, { cause: deep });
    assert.match(describeUpstreamFailure(deep, "https://chatgpt.com/responses").message, /truncated/);
    const child = new Error("shared");
    const repeated = new AggregateError(Array.from({ length: 200 }, () => child), "root");
    assert.match(describeUpstreamFailure(repeated, "https://chatgpt.com/responses").message, /truncated/);
});

test("non-scalar error metadata cannot break diagnostic serialization", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const child = Object.assign(new Error("child"), { code: "ETIMEDOUT", address: circular, port: 443 });
    const parts = describeUpstreamFailure(new AggregateError([child], "root"), "https://chatgpt.com/responses");
    assert.match(parts.message, /ETIMEDOUT/);
    assert.doesNotMatch(parts.message, /\\"self\\"/);
});

test("malformed aggregate containers do not replace the original failure", () => {
    for (const errors of [null, 42, {}]) {
        const aggregate = Object.assign(new AggregateError([], "original failure"), { errors, code: "ETIMEDOUT" });
        const parts = describeUpstreamFailure(aggregate, "https://chatgpt.com/responses");
        assert.match(parts.message, /original failure/);
        assert.equal(parts.detail.code, "ETIMEDOUT");
    }
});

test("falsy aggregate children still consume the visit budget", () => {
    let visited = 0;
    const children = Array.from({ length: 200 }, () => null);
    for (let i = 0; i < children.length; i++) {
        Object.defineProperty(children, i, { get() { visited++; return null; } });
    }
    const aggregate = new AggregateError([], "root");
    aggregate.errors = children;
    const bounded = describeUpstreamFailure(aggregate, "https://chatgpt.com/responses");
    assert.match(bounded.message, /truncated/);
    assert.ok(visited <= 32, String(visited));
});

test("redacted causes remain valid JSON with quoted URLs and backslashes", () => {
    const child = new Error('failed "https://api.openai.com/v1" in C:\\tmp\\file');
    const parts = describeUpstreamFailure(new AggregateError([child], "root"), "https://chatgpt.com/responses");
    const causes = JSON.parse(parts.message.match(/causes=(\[.*\]) url=/)![1]!);
    assert.match(causes[0].message, /failed/);
    assert.ok(causes[0].message.includes("C:\\tmp\\file"));
});

test("diagnostic improvements preserve conservative timeout classification and retry behavior", async () => {
    for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
        assert.equal(classifyUpstreamFailure(Object.assign(new Error("timeout"), { code })), "upstream-timeout");
    }
    const original = globalThis.fetch;
    try {
        for (const send of [fetchWithRetry, fetchWithTransportRetry]) {
            for (const error of [connectError("ETIMEDOUT", "127.0.0.1"), familyFailure()]) {
                let attempts = 0;
                globalThis.fetch = async () => { attempts++; throw error; };
                await assert.rejects(send("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" }, 5000, undefined), (actual) => actual === error);
                assert.equal(attempts, 1);
            }
        }
    } finally {
        globalThis.fetch = original;
    }
});
