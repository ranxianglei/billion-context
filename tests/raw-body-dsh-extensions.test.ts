import assert from "node:assert/strict";
import test from "node:test";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";

test("top-level non-model DSH extension fields contribute zero tokens (#dsh_session_log)", () => {
    const baseline = {
        model: "deepseek-chat",
        system: "You are a helpful assistant.",
        messages: [
            { role: "user", content: "Summarize the previous steps." },
        ],
    };
    const baseTokens = estimateRawBodyTokens(baseline);
    const baseBreakdown = estimateRawBodyBreakdown(baseline);

    // Multi-megabyte (>5.5 MiB) transport-only DSH extension payload attached at top level.
    const hugeEvents = Array.from({ length: 1200 }, (_, i) => ({
        seq: i,
        type: "assistant/text",
        text: `event-${i}: ` + "x".repeat(4800),
    }));
    const withExtensions = {
        ...baseline,
        dsh_session_log: {
            version: 1,
            sessionId: "sess-123",
            events: hugeEvents,
        },
        dsh_plugin_packages: [
            { name: "@deepseek-ai/dsh-base", version: "0.2.2-rc.5" },
            { name: "billion-context", version: "0.1.216" },
        ],
        dsh_custom_extension: { note: "y".repeat(50_000) },
    };

    assert.ok(JSON.stringify(withExtensions).length > 5_500_000, "fixture exceeds 5.5 MiB");
    assert.equal(estimateRawBodyTokens(withExtensions), baseTokens);
    assert.deepEqual(estimateRawBodyBreakdown(withExtensions), baseBreakdown);
    assert.equal(estimateRawBodyBreakdown(withExtensions).other, baseBreakdown.other);
});

test("nested dsh_* fields inside messages[] are still counted", () => {
    const withoutNested = {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hello" }],
    };
    const withNested = {
        model: "deepseek-chat",
        messages: [
            {
                role: "user",
                content: "hello",
                dsh_session_log: { note: "nested content inside user message should still count" },
                dsh_foo: "extra nested tokens",
            },
        ],
    };

    assert.ok(estimateRawBodyTokens(withNested) > estimateRawBodyTokens(withoutNested));
    const bd = estimateRawBodyBreakdown(withNested);
    assert.equal(bd.total, estimateRawBodyTokens(withNested));
    assert.ok(bd.messages > estimateRawBodyBreakdown(withoutNested).messages);
});

test("non-plain-object roots (arrays, strings, primitives) behave consistently", () => {
    const arrayRoot = [{ dsh_session_log: "should still count when root is an array" }, "tail"];
    assert.equal(estimateRawBodyBreakdown(arrayRoot).total, estimateRawBodyTokens(arrayRoot));
    assert.ok(estimateRawBodyTokens(arrayRoot) > 0);
    assert.equal(estimateRawBodyTokens("plain text"), estimateRawBodyBreakdown("plain text").total);
    assert.equal(estimateRawBodyTokens(null), 0);
});
