import { test } from "node:test";
import assert from "node:assert/strict";
import { dropCompressReasoning, resolveReasoningDrop, DEFAULT_COMPRESS_REASONING, type CompressReasoningConfig } from "../src/reasoning-drop.ts";
import { mergeCompress } from "../src/compress-settings.ts";
import type { BiliMessage } from "acp-kernel/wire";

const R = (text: string, id = "r"): BiliMessage => ({ id, role: "assistant", contentType: "reasoning", text });
const CALL = (toolName = "compress", toolCallId = "t1"): BiliMessage => ({ id: "c", role: "assistant", contentType: "tool-call", toolName, toolCallId, text: "{}" });
const RESULT = (toolCallId = "t1"): BiliMessage => ({ id: "res", role: "user", contentType: "tool-result", toolName: "compress", toolCallId, text: "ok" });
const USER = (text = "hi"): BiliMessage => ({ id: "u", role: "user", contentType: "text", text });
const TEXT = (text = "hm"): BiliMessage => ({ id: "txt", role: "assistant", contentType: "text", text });

test("default: drops oversized reasoning run before a closed compress call", () => {
    const msgs = [R("x".repeat(3000)), CALL(), RESULT(), USER("next")];
    const out = dropCompressReasoning(msgs);
    assert.equal(out.length, 3);
    assert.ok(!out.some((m) => m.contentType === "reasoning"));
    assert.ok(out.some((m) => m.contentType === "tool-call" && m.toolName === "compress"));
});

test("#348 twin: closes WITHOUT any user message — assistant continuation is round evidence", () => {
    const msgs = [R("x".repeat(3000)), CALL(), RESULT(), TEXT("carrying on"), CALL("bash", "t2")];
    const out = dropCompressReasoning(msgs);
    assert.equal(out.length, 4);
    assert.ok(!out.some((m) => m.contentType === "reasoning"));
});

test("in flight: result still the last message → never touched", () => {
    const msgs = [USER("q"), R("x".repeat(3000)), CALL(), RESULT()];
    assert.equal(dropCompressReasoning(msgs).length, 4);
});

test("result pending (call without any result) → never touched", () => {
    const msgs = [R("x".repeat(3000)), CALL(), TEXT("next round already started")];
    assert.equal(dropCompressReasoning(msgs).length, 3);
});

test("result for a different toolCallId does not close the round", () => {
    const msgs = [R("x".repeat(3000)), CALL("compress", "a"), RESULT("b"), USER("next")];
    assert.equal(dropCompressReasoning(msgs).length, 4);
});

test("result BEFORE the call does not close the round", () => {
    const msgs = [RESULT(), R("x".repeat(3000)), CALL("compress", "t1"), USER("next")];
    assert.equal(dropCompressReasoning(msgs).length, 4);
});

test("small reasoning survives the default threshold", () => {
    const msgs = [R("x".repeat(1000)), CALL(), RESULT(), USER("next")];
    assert.equal(dropCompressReasoning(msgs).length, 4);
});

test("exactly-threshold reasoning is kept (strictly-greater gate)", () => {
    const msgs = [R("x".repeat(DEFAULT_COMPRESS_REASONING.threshold)), CALL(), RESULT(), USER("next")];
    assert.equal(dropCompressReasoning(msgs).length, 4);
});

test("only compress calls select the drop — other tool calls keep their reasoning", () => {
    const msgs = [R("x".repeat(3000)), CALL("read", "t1"), RESULT("t1"), USER("next")];
    assert.ok(dropCompressReasoning(msgs).some((m) => m.contentType === "reasoning"));
});

test("multi-message reasoning run is summed before the gate", () => {
    const msgs = [R("x".repeat(1200), "a"), R("y".repeat(1200), "b"), CALL(), RESULT(), USER("next")];
    const out = dropCompressReasoning(msgs);
    assert.equal(out.length, 3);
    assert.ok(!out.some((m) => m.contentType === "reasoning"));
});

test("non-contiguous reasoning is not attributed to the compress call", () => {
    const msgs = [R("x".repeat(1200)), TEXT(), R("y".repeat(1200)), CALL(), RESULT(), USER("next")];
    const out = dropCompressReasoning(msgs);
    assert.equal(out.length, 6);
});

test("threshold 0 drops any non-empty run", () => {
    const msgs = [R("tiny"), CALL(), RESULT(), USER("next")];
    assert.equal(dropCompressReasoning(msgs, { threshold: 0 }).length, 3);
});

test("drop:false is a kill-switch", () => {
    const msgs = [R("x".repeat(3000)), CALL(), RESULT(), USER("next")];
    assert.equal(dropCompressReasoning(msgs, { drop: false }).length, 4);
});

test("purity: the input array is never mutated", () => {
    const msgs = [R("x".repeat(3000)), CALL(), RESULT(), USER("next")];
    const snapshot = JSON.stringify(msgs);
    dropCompressReasoning(msgs);
    assert.equal(JSON.stringify(msgs), snapshot);
});

test("idempotence: a second pass changes nothing", () => {
    const msgs = [R("x".repeat(3000)), CALL(), RESULT(), USER("next")];
    const once = dropCompressReasoning(msgs);
    assert.equal(dropCompressReasoning(once).length, once.length);
});

test("resolveReasoningDrop: defaults, validation, and passthrough", () => {
    assert.deepEqual(resolveReasoningDrop(undefined), { drop: true, threshold: 2048 });
    assert.deepEqual(resolveReasoningDrop({}), { drop: true, threshold: 2048 });
    assert.deepEqual(resolveReasoningDrop({ drop: false, threshold: 0 }), { drop: false, threshold: 0 });
    assert.deepEqual(resolveReasoningDrop({ threshold: -3 }), { drop: true, threshold: 2048 });
    assert.deepEqual(resolveReasoningDrop({ threshold: 512.9 }), { drop: true, threshold: 512 });
});

test("multiple closed compress rounds all get stripped (distinct toolCallIds)", () => {
    const msgs = [
        R("a".repeat(3000), "r1"), CALL("compress", "c1"), RESULT("c1"),
        R("b".repeat(3000), "r2"), CALL("compress", "c2"), RESULT("c2"),
        USER("next"),
    ];
    const out = dropCompressReasoning(msgs);
    assert.equal(out.length, 5);
    assert.ok(!out.some((m) => m.contentType === "reasoning"));
});

test("multiple agentic compress rounds close without any user message", () => {
    const msgs = [
        R("a".repeat(3000), "r1"), CALL("compress", "c1"), RESULT("c1"),
        R("b".repeat(3000), "r2"), CALL("compress", "c2"), RESULT("c2"),
        CALL("bash", "t9"),
    ];
    const out = dropCompressReasoning(msgs);
    assert.equal(out.length, 5);
    assert.ok(!out.some((m) => m.contentType === "reasoning"));
});

test("mergeCompress merges reasoning sub-field-wise across levels", () => {
    assert.deepEqual(mergeCompress({ reasoning: { threshold: 1024 } }, undefined, { reasoning: { drop: false } }).reasoning, { threshold: 1024, drop: false });
    assert.equal(mergeCompress(undefined, undefined, undefined).reasoning, undefined);
    assert.deepEqual(mergeCompress({ reasoning: { threshold: 100 } }, { reasoning: { threshold: 200 } }, undefined).reasoning, { threshold: 200 });
});

test("empty input and empty config short-circuit", () => {
    assert.deepEqual(dropCompressReasoning([]), []);
    const cfg: CompressReasoningConfig = {};
    assert.equal(dropCompressReasoning([R("x"), CALL(), RESULT(), USER()], cfg).length, 4);
});
