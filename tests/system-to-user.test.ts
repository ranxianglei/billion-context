import test from "node:test";
import assert from "node:assert/strict";
import { systemToUser } from "../src/util.ts";

type Msg = { role: string; content: string };

test("systemToUser: no-op (same array) when there is no system/developer message", () => {
    const msgs: Msg[] = [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
    ];
    assert.equal(systemToUser(msgs), msgs, "clean input must return the same array (no allocation)");
});

test("systemToUser: no-op (same array) for an empty list", () => {
    const msgs: Msg[] = [];
    assert.equal(systemToUser(msgs), msgs);
});

test("systemToUser: a single mid-conversation system becomes a user message, staying in place", () => {
    const msgs: Msg[] = [
        { role: "user", content: "u1" },
        { role: "system", content: "summary-b3" },
        { role: "user", content: "u2" },
    ];
    const out = systemToUser(msgs);
    assert.deepEqual(out.map((m) => m.role), ["user", "user", "user"]);
    assert.deepEqual(out.map((m) => m.content), ["u1", "summary-b3", "u2"]);
});

test("systemToUser: multiple mid systems + developer become user messages, keeping position and order", () => {
    const msgs: Msg[] = [
        { role: "user", content: "u1" },
        { role: "system", content: "b1" },
        { role: "user", content: "u2" },
        { role: "system", content: "b2" },
        { role: "developer", content: "dev-mid" },
        { role: "assistant", content: "a1" },
    ];
    const out = systemToUser(msgs);
    assert.deepEqual(out.map((m) => m.role), ["user", "user", "user", "user", "user", "assistant"]);
    assert.deepEqual(out.map((m) => m.content), ["u1", "b1", "u2", "b2", "dev-mid", "a1"]);
});

test("systemToUser: a leading system is also converted (the function is role-based, not position-based)", () => {
    // In the real flow the leading system is extracted by openaiToCore and
    // re-injected by injectOpenaiSystem AFTER this function, so the array
    // passed here carries only mid-stream acp_summary system messages. This
    // test documents that the function itself converts any system/developer
    // message it sees, regardless of position.
    const msgs: Msg[] = [
        { role: "system", content: "head" },
        { role: "user", content: "u1" },
    ];
    const out = systemToUser(msgs);
    assert.deepEqual(out.map((m) => m.role), ["user", "user"]);
    assert.deepEqual(out.map((m) => m.content), ["head", "u1"]);
});

test("systemToUser: non-system messages keep their object identity", () => {
    const u1: Msg = { role: "user", content: "u1" };
    const a1: Msg = { role: "assistant", content: "a1" };
    const sys: Msg = { role: "system", content: "b1" };
    const msgs: Msg[] = [u1, sys, a1];
    const out = systemToUser(msgs);
    assert.equal(out[0], u1, "user message is not copied");
    assert.equal(out[2], a1, "assistant message is not copied");
    assert.notEqual(out[1], sys, "system message is replaced");
    assert.equal(out[1].role, "user");
    assert.equal(out[1].content, "b1");
});

test("systemToUser: the issue #377 wire shape — mid-stream block summaries become user turns, zero system/developer remain", () => {
    const msgs: Msg[] = [
        { role: "user", content: "m00240" },
        { role: "system", content: "b1" },
        { role: "user", content: "m00250" },
        { role: "system", content: "b2" },
        { role: "user", content: "m00329" },
    ];
    const out = systemToUser(msgs);
    for (let i = 0; i < out.length; i++) {
        assert.notEqual(out[i].role, "system", `system at index ${i}`);
        assert.notEqual(out[i].role, "developer", `developer at index ${i}`);
    }
    assert.deepEqual(out.map((m) => m.content), ["m00240", "b1", "m00250", "b2", "m00329"]);
});
