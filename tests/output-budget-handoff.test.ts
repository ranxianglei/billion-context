import assert from "node:assert/strict";
import test from "node:test";
import { restoreOutputBudget } from "../src/server/side-request.ts";
import { clampOutgoingOutput } from "../src/server/budget.ts";

const log = (): void => {};

test("output budget handoff restores a fresh 1024-token request before the rebuilt-input clamp", () => {
    const session = { id: "fresh", metadata: {} as Record<string, unknown> };
    const body = { max_tokens: 1024 };
    restoreOutputBudget(body, session, log, undefined, "131072:1024", 131072);
    assert.equal(body.max_tokens, 131072);
    clampOutgoingOutput(body, "max_tokens", {
        systemText: "", tools: [], processedMessages: [], lastInputTokens: 82763,
        lastInputTokensSource: "usage", nativeWindow: 1000000, imageTokens: 0,
    }, session.id, log);
    assert.equal(body.max_tokens, 131072);
    clampOutgoingOutput(body, "max_tokens", {
        systemText: "", tools: [], processedMessages: [], lastInputTokens: 82763,
        lastInputTokensSource: "usage", nativeWindow: 100000, imageTokens: 0,
    }, session.id, log);
    assert.equal(body.max_tokens, 13098, "a small window still clamps the restored reservation");
});

test("output budget handoff preserves explicit small caps and rejects mismatched or invalid metadata", () => {
    for (const handoff of [undefined, "131072:2048", "0:1024", "Infinity:1024", "131072.5:1024", "131072:1024junk", "1024:1024"]) {
        const body = { max_tokens: 1024 };
        restoreOutputBudget(body, { id: "small", metadata: {} }, log, undefined, handoff, 131072);
        assert.equal(body.max_tokens, 1024);
    }
    const body = { max_tokens: 1024 };
    restoreOutputBudget(body, { id: "small", metadata: {} }, log, undefined, "4096:1024", 131072);
    assert.equal(body.max_tokens, 4096, "restore only this request's ceiling, not a session high-water");
});

test("output budget handoff preserves an explicit tiny tool budget and stays below the model ceiling", () => {
    const session = { id: "explicit", metadata: { outputBudgetHighWater: 131072 } };
    const body = { max_tokens: 128, tools: [{ name: "tool" }] };
    restoreOutputBudget(body, session, log, 131072, "128:128", 131072);
    assert.equal(body.max_tokens, 128);
    const tooLarge = { max_tokens: 1024 };
    restoreOutputBudget(tooLarge, session, log, undefined, "200000:1024", 131072);
    assert.equal(tooLarge.max_tokens, 1024);
    restoreOutputBudget(tooLarge, session, log, undefined, "131072:1024");
    assert.equal(tooLarge.max_tokens, 131072, "first request can hand off before runtime-info refresh");
});
