import assert from "node:assert/strict";
import test from "node:test";
import { bodyOverWindowDetail, installNativeFetchIntercept, _resetForTest } from "../src/agent/native-intercept.js";
import { estimateRawBodyTokens } from "../src/preflight.js";

const WINDOW = 1_048_576;
const LOG_TEXT = "L".repeat(7_000_000);
const raw = (body: unknown): string => JSON.stringify(body);
const verdict = (body: string) => bodyOverWindowDetail(Buffer.byteLength(body), body, WINDOW);

test("DSH transport fields no longer disagree with the server meter at the native window guard", () => {
    const messages = [{ role: "user", content: "x".repeat(600_000) }];
    const model = { messages, system: "s".repeat(20_000) };
    for (const key of ["dsh_session_log", "dsh_plugin_packages", "dsh_future_extension"]) {
        const body = { ...model, [key]: { events: [{ text: LOG_TEXT }] } };
        assert.equal(estimateRawBodyTokens(body), estimateRawBodyTokens(model), "follow the already-merged server policy");
        assert.equal(verdict(raw(body)), undefined, key);
    }
});

test("the same DSH exclusion applies across request shapes without guessing a wire protocol", () => {
    for (const prompt of [
        { messages: [{ role: "user", content: "hello" }] },
        { messages: [{ role: "user", content: "hello" }], system: "instructions" },
        { input: "hello", instructions: "instructions" },
        { contents: [{ parts: [{ text: "hello" }] }], systemInstruction: { parts: [{ text: "instructions" }] } },
    ]) {
        assert.equal(verdict(raw({ ...prompt, dsh_session_log: LOG_TEXT })), undefined);
    }
});

test("model-visible overflow still refuses with or without DSH metadata", () => {
    for (const chars of [3_800_000, 4_500_000]) {
        const body = { messages: [{ role: "user", content: "x".repeat(chars) }] };
        const expected = verdict(raw(body));
        assert.ok(expected);
        assert.equal(expected.provablyOver, chars === 4_500_000, "retain both the calibrated and bare-floor tiers");
        assert.deepEqual(verdict(raw({ ...body, dsh_session_log: LOG_TEXT })), expected);
    }
});

test("DSH-looking keys inside messages and unknown top-level fields remain chargeable", () => {
    assert.ok(verdict(raw({ messages: [{ content: { dsh_session_log: LOG_TEXT } }] }))?.provablyOver);
    assert.ok(verdict(raw({ messages: [{ content: "hello" }], custom_extension: LOG_TEXT }))?.provablyOver);
});

test("media inside discarded metadata cannot be credited twice against a genuinely large prompt", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(4_500_000) }] };
    const metadata = { source: { type: "base64", data: "A".repeat(4_000_000) } };
    assert.deepEqual(verdict(raw({ ...body, dsh_session_log: metadata })), verdict(raw(body)));
});

test("actual prompt media stays excluded after removing DSH metadata from the estimate", () => {
    const body = { messages: [{ role: "user", content: [
        { type: "text", text: "hello" },
        { type: "image", source: { type: "base64", data: "A".repeat(4_000_000) } },
    ] }], dsh_session_log: LOG_TEXT };
    assert.equal(verdict(raw(body)), undefined);
});

test("ordinary byte calibration, missing raw bodies and invalid JSON keep their existing verdicts", () => {
    const body = raw({ messages: [{ role: "user", content: "x".repeat(3_800_000) }] });
    const expected = bodyOverWindowDetail(Buffer.byteLength(body), undefined, WINDOW);
    assert.ok(expected && !expected.provablyOver, "the existing 1.14 calibrated tier still applies");
    assert.deepEqual(verdict(body), expected);
    assert.deepEqual(bodyOverWindowDetail(5_000_000, "invalid JSON", WINDOW), bodyOverWindowDetail(5_000_000, undefined, WINDOW));
    assert.equal(bodyOverWindowDetail(undefined, body, WINDOW), undefined);
    assert.equal(bodyOverWindowDetail(Buffer.byteLength(body), body, undefined), undefined);
});

test("a deeply nested model-body copy falls back to the existing guard without throwing", () => {
    const nested = "[".repeat(12_000) + "0" + "]".repeat(12_000);
    const body = '{"messages":[{"content":"' + "x".repeat(4_500_000) + '"}],"custom_extension":' + nested + ',"dsh_session_log":"metadata"}';
    assert.deepEqual(verdict(body), bodyOverWindowDetail(Buffer.byteLength(body), undefined, WINDOW), "an unserializable estimate cannot bypass the old guard");
});

test("proxy-unavailable fallback forwards the original DSH request byte-exact and still refuses real overflow", async () => {
    const savedFetch = globalThis.fetch;
    const calls: string[] = [];
    _resetForTest();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const body = init?.body;
        assert.equal(typeof body, "string");
        calls.push(body as string);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        assert.equal(installNativeFetchIntercept({
            origin: undefined,
            ready: Promise.resolve(undefined),
            respawn: async () => undefined,
            declaredWindowForDirect: () => WINDOW,
        }), true);
        const fitting = raw({ model: "deepseek-flash", messages: [{ role: "user", content: "x".repeat(600_000) }], dsh_session_log: LOG_TEXT });
        const response = await fetch("http://127.0.0.1:8199/v1/chat/completions", { method: "POST", body: fitting });
        assert.equal(response.status, 200);
        assert.deepEqual(calls, [fitting], "only the estimate changes; the original log still goes upstream");
        const tooLarge = raw({ model: "deepseek-flash", messages: [{ role: "user", content: "x".repeat(4_500_000) }], dsh_session_log: LOG_TEXT });
        const refused = await fetch("http://127.0.0.1:8199/v1/chat/completions", { method: "POST", body: tooLarge });
        assert.equal(refused.status, 422);
        assert.equal(refused.headers.get("x-bili-gate"), "oversize-refusal-fallback");
        assert.equal(calls.length, 1, "the over-window prompt never reaches upstream");
    } finally {
        globalThis.fetch = savedFetch;
        _resetForTest();
    }
});
