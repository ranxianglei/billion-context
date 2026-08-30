import test from "node:test";
import assert from "node:assert/strict";
import { hoistMidSystemMessages } from "../src/util.ts";

type Msg = { role: string; content: string };

test("hoistMidSystemMessages: no-op (same array) when all system messages are already a leading prefix", () => {
    const msgs: Msg[] = [
        { role: "system", content: "head" },
        { role: "system", content: "summary-b1" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
    ];
    assert.equal(hoistMidSystemMessages(msgs), msgs, "clean input must return the same array (no allocation)");
});

test("hoistMidSystemMessages: no-op (same array) for an empty list", () => {
    const msgs: Msg[] = [];
    assert.equal(hoistMidSystemMessages(msgs), msgs);
});

test("hoistMidSystemMessages: no-op (same array) when there is no system message at all", () => {
    const msgs: Msg[] = [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
    ];
    assert.equal(hoistMidSystemMessages(msgs), msgs);
});

test("hoistMidSystemMessages: a single mid-conversation system moves to the leading prefix", () => {
    const msgs: Msg[] = [
        { role: "system", content: "head" },
        { role: "user", content: "u1" },
        { role: "system", content: "summary-b3" },
        { role: "user", content: "u2" },
    ];
    const out = hoistMidSystemMessages(msgs);
    assert.deepEqual(out.map((m) => m.role), ["system", "system", "user", "user"]);
    assert.deepEqual(out.map((m) => m.content), ["head", "summary-b3", "u1", "u2"]);
});

test("hoistMidSystemMessages: no leading system — mid systems become the new leading prefix", () => {
    const msgs: Msg[] = [
        { role: "user", content: "u1" },
        { role: "system", content: "summary-b1" },
        { role: "user", content: "u2" },
        { role: "system", content: "summary-b2" },
    ];
    const out = hoistMidSystemMessages(msgs);
    assert.deepEqual(out.map((m) => m.role), ["system", "system", "user", "user"]);
    assert.deepEqual(out.map((m) => m.content), ["summary-b1", "summary-b2", "u1", "u2"]);
});

test("hoistMidSystemMessages: multiple mid systems keep their relative order and land after the existing head", () => {
    const msgs: Msg[] = [
        { role: "system", content: "head" },
        { role: "system", content: "b1" },
        { role: "user", content: "u1" },
        { role: "system", content: "b2" },
        { role: "user", content: "u2" },
        { role: "developer", content: "dev-mid" },
        { role: "assistant", content: "a1" },
    ];
    const out = hoistMidSystemMessages(msgs);
    assert.deepEqual(out.map((m) => m.role), ["system", "system", "system", "developer", "user", "user", "assistant"]);
    assert.deepEqual(out.map((m) => m.content), ["head", "b1", "b2", "dev-mid", "u1", "u2", "a1"]);
});

test("hoistMidSystemMessages: an all-system list is unchanged in order (returned as-is when no mid exists past the prefix)", () => {
    const msgs: Msg[] = [
        { role: "system", content: "s1" },
        { role: "developer", content: "d1" },
        { role: "system", content: "s2" },
    ];
    assert.equal(hoistMidSystemMessages(msgs), msgs);
});

test("hoistMidSystemMessages: the issue #355 wire shape — [system, system, system, user, system, user] becomes a clean leading prefix", () => {
    const msgs: Msg[] = [
        { role: "system", content: "sysprompt" },
        { role: "system", content: "b1" },
        { role: "system", content: "b2" },
        { role: "user", content: "m00240" },
        { role: "system", content: "b3" },
        { role: "user", content: "m00329" },
    ];
    const out = hoistMidSystemMessages(msgs);
    const firstNonSystem = out.findIndex((m) => m.role !== "system" && m.role !== "developer");
    assert.ok(firstNonSystem > 0, "there is a non-system message");
    for (let i = firstNonSystem; i < out.length; i++) {
        assert.notEqual(out[i].role, "system", `system at index ${i} after the first non-system message`);
        assert.notEqual(out[i].role, "developer", `developer at index ${i} after the first non-system message`);
    }
    assert.deepEqual(out.map((m) => m.content), ["sysprompt", "b1", "b2", "b3", "m00240", "m00329"]);
});
