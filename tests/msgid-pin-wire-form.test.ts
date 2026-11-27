// #7439 follow-up (cross-lane model/protocol switching): WIRE-granularity
// pinning. The host stamps one id per WIRE message element (the pi-ai
// walkers prove element⇄host-message pairing); the kernel splits one
// element into N cores (agentic text+tool_calls, multi-part user). The
// server therefore pins per-element: group cores by their kernel-stamped
// wireIndex, head core takes the host id, siblings get deterministic
// derived ids (`<head>#p<k>`).
//
// Direction asserts (#3617): every accept shape pins exactly its ids;
// every reject class degrades (returns null / !ok) and never pins
// partially.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wirePinGroups, validateWireMsgIds, applyWireMsgIdPin } from "../src/msgid-pin.js";
import type { BiliMessage } from "acp-kernel/wire";

const core = (id: string, wireIndex: number, extra: Partial<BiliMessage> = {}): BiliMessage =>
    ({ id, role: "user", contentType: "text", text: `t-${id}`, wireIndex, ...extra }) as BiliMessage;

/** 3 wire elements → 5 cores: element 1 splits into [text, tool_call]. */
const splitMsgs = (): BiliMessage[] => [
    core("d0", 0),
    core("d1", 1, { role: "assistant", contentType: "text", text: "a0" }),
    core("d2", 1, { role: "assistant", contentType: "tool-call", text: '{"x":1}', toolCallId: "tc1", toolName: "f" }),
    core("d3", 2, { contentType: "tool-result", toolCallId: "tc1", text: "t0" }),
];

test("wirePinGroups: split element detected, groups in core order", () => {
    const g = wirePinGroups(splitMsgs());
    assert.ok(g);
    assert.equal(g.min, 0);
    assert.equal(g.size, 3);
    assert.equal(g.split, true);
    assert.deepEqual([...g.groups.get(1)!], [1, 2]);
});

test("wirePinGroups: lead hoist — min > 0 is legal (openai/responses hoist the leading system run out of the fold space)", () => {
    const g = wirePinGroups([core("d0", 1), core("d1", 2), core("d2", 2)]);
    assert.ok(g);
    assert.equal(g.min, 1);
    assert.equal(g.size, 2);
    assert.equal(g.split, true);
});

test("wirePinGroups: all-1:1 → split=false (the legacy per-core form)", () => {
    const g = wirePinGroups([core("d0", 0), core("d1", 1)]);
    assert.ok(g);
    assert.equal(g.split, false);
    assert.equal(g.size, 2);
});

test("wirePinGroups: null on orphan index / missing wireIndex / empty", () => {
    assert.equal(wirePinGroups([core("d0", 0), core("d1", 2)]), null); // gap at 1 — vanished element
    const nowire = [{ id: "x", role: "user", contentType: "text", text: "t" }] as BiliMessage[];
    assert.equal(wirePinGroups(nowire), null);
    assert.equal(wirePinGroups([]), null);
});

test("validateWireMsgIds: expects the WIRE count (3), not the core count (5)", () => {
    const g = wirePinGroups(splitMsgs())!;
    assert.equal(validateWireMsgIds(["h0", "h1", "h2"], g).ok, true);
    const v = validateWireMsgIds(["h0", "h1"], g);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "length-mismatch");
    assert.equal(validateWireMsgIds(["h0", "h1", "h2", "h3"], g).ok, false);
    assert.equal(validateWireMsgIds("nope", g).ok, false);
});

test("validateWireMsgIds: entry rules at parity with the per-core path (empty / oversize / whitespace / reserved / dup)", () => {
    const g = wirePinGroups(splitMsgs())!;
    for (const bad of [[], ["h0", "", "h2"], ["h0", "x".repeat(513), "h2"], ["h 0", "h1", "h2"], ["acp_summary_a", "h1", "h2"], ["h0", "h0", "h2"]]) {
        const v = validateWireMsgIds(bad, g);
        assert.equal(v.ok, false, JSON.stringify(bad));
    }
});

test("applyWireMsgIdPin: head takes the host id, siblings get deterministic #pN", () => {
    const g = wirePinGroups(splitMsgs())!;
    const v = validateWireMsgIds(["h0", "h1", "h2"], g);
    assert.ok(v.ok);
    const pinned = applyWireMsgIdPin(splitMsgs(), g, v.ids);
    assert.deepEqual(pinned.map((m) => m.id), ["h0", "h1", "h1#p1", "h2"]);
    // pinning copies — the source messages keep their derived ids
    assert.equal((splitMsgs()[2] as BiliMessage).id, "d2");
});

test("applyWireMsgIdPin: lead-hoisted range maps ids[i] to wireIndex min+i", () => {
    const msgs = [core("d0", 1), core("d1", 2), core("d2", 2)];
    const g = wirePinGroups(msgs)!;
    const v = validateWireMsgIds(["a", "b"], g);
    assert.ok(v.ok);
    assert.deepEqual(applyWireMsgIdPin(msgs, g, v.ids).map((m) => m.id), ["a", "b", "b#p1"]);
});
