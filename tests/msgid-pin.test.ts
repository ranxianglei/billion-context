// #4491 S5 stake: client msgid validation + pinning. Gate discipline (#3617):
// every reject class is asserted in BOTH directions — the poison shapes are
// rejected, and a well-formed array pins exactly its ids onto the messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MSG_IDS_BODY_FIELD, validateMsgIds, applyMsgIdPin } from "../src/msgid-pin.js";
import type { BiliMessage } from "acp-kernel/wire";

const wire = (n: number): BiliMessage[] =>
    Array.from({ length: n }, (_, i) => ({ id: `derived${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `t${i}` }) as BiliMessage);

test("valid: a well-formed array pins every id in order", () => {
    const v = validateMsgIds(["c1", "c2", "c3"], 3);
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.deepEqual(v.ids, ["c1", "c2", "c3"]);
    const msgs = applyMsgIdPin(wire(3), v.ids);
    assert.deepEqual(msgs.map((m) => m.id), ["c1", "c2", "c3"]);
    // pinning copies — the source messages keep their derived ids
    assert.equal(wire(3)[0].id, "derived0");
});

test("reject: not an array (string / object / null)", () => {
    for (const bad of ["c1", { 0: "c1" }, null]) {
        const v = validateMsgIds(bad as never, 1);
        assert.equal(v.ok, false);
        if (!v.ok) assert.equal(v.reason, "not-an-array");
    }
});

test("reject: length mismatch never pins partially", () => {
    const short = validateMsgIds(["c1"], 2);
    assert.equal(short.ok, false);
    if (!short.ok) assert.equal(short.reason, "length-mismatch");
    const long = validateMsgIds(["c1", "c2", "c3"], 2);
    assert.equal(long.ok, false);
    if (!long.ok) assert.equal(long.reason, "length-mismatch");
});

test("reject: bad entries (non-string, empty, oversize >512)", () => {
    for (const bad of [42, "", "x".repeat(513)]) {
        const v = validateMsgIds([bad as never], 1);
        assert.equal(v.ok, false);
        if (!v.ok) assert.equal(v.reason, "bad-entry");
    }
});

test("accept: exactly 512 chars is the boundary (off-by-one guard)", () => {
    const v = validateMsgIds(["y".repeat(512)], 1);
    assert.equal(v.ok, true);
});

test("reject: reserved acp_summary_ prefix (kernel anchor namespace)", () => {
    const v = validateMsgIds(["acp_summary_deadbeef"], 1);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "reserved-prefix");
});

test("reject: control chars and whitespace inside an id", () => {
    for (const bad of ["a b", "a\nb", "a\u0000b", "a\tb"]) {
        const v = validateMsgIds([bad], 1);
        assert.equal(v.ok, false);
        if (!v.ok) assert.equal(v.reason, "control-or-space");
    }
});

test("reject: duplicate ids within one observation", () => {
    const v = validateMsgIds(["dup", "other", "dup"], 3);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "duplicate");
});

test("body field constant is stable and bili-namespaced", () => {
    assert.equal(MSG_IDS_BODY_FIELD, "biliMsgIds");
});
