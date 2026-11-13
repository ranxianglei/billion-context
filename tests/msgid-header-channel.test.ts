// #5825 stamped-header channel (x-bili-msg-ids): server-side parse contract.
// The header rides the SAME light checks as body stamps (incomingMsgIdsOf);
// full strictness stays at pin time. Any doubt → undefined → pre-channel path.

import assert from "node:assert/strict";
import test from "node:test";

import { incomingMsgIdsHeader } from "../src/msgid-pin.js";

test("stamped header: well-formed comma list parses to id array", () => {
    assert.deepEqual(incomingMsgIdsHeader("msg_a1,msg_b2,msg_c3"), ["msg_a1", "msg_b2", "msg_c3"]);
});

test("stamped header: multi-line values take the first line only", () => {
    assert.deepEqual(incomingMsgIdsHeader(["msg_a1,msg_b2", "msg_c3"]), ["msg_a1", "msg_b2"]);
});

test("stamped header: absent / empty / whitespace-only values degrade", () => {
    assert.equal(incomingMsgIdsHeader(undefined), undefined);
    assert.equal(incomingMsgIdsHeader(""), undefined);
    assert.equal(incomingMsgIdsHeader(","), undefined, "only separators → empty list");
    assert.equal(incomingMsgIdsHeader([undefined] as unknown as string[]), undefined);
});

test("stamped header: same LIGHT contract as body stamps (dups deferred to pin time)", () => {
    assert.equal(incomingMsgIdsHeader("acp_summary_x"), undefined, "reserved prefix");
    assert.equal(incomingMsgIdsHeader("msg a"), undefined, "space");
    assert.equal(incomingMsgIdsHeader("msg\u0000a"), undefined, "control char");
    // Duplicates survive the light check BY DESIGN: incomingMsgIdsOf (body
    // stamps) carries this exact contract and validateMsgIds at pin time is
    // where duplicates die — both channels must stay in parity.
    assert.deepEqual(incomingMsgIdsHeader("dup,dup"), ["dup", "dup"]);
});

test("stamped header: oversized value or id count degrades", () => {
    const fat = `msg_${"p".repeat(65536)}`; // > 64KiB raw
    assert.equal(typeof incomingMsgIdsHeader(fat), "undefined");
    const many = Array.from({ length: 4097 }, (_, i) => `msg_i${i}`).join(",");
    assert.equal(incomingMsgIdsHeader(many), undefined, "> 4096 ids cap");
});
