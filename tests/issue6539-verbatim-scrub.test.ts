/** #6539 (双-review F1/F2): biliMsgIds / biliLedgerSeqs must NEVER reach a
 *  real model endpoint on a verbatim-forward lane. The four fully-processed
 *  prepares already strip them; this pins the verbatim scrub
 *  (`scrubMsgIdFields`) + the count_tokens egress hygiene, so a stamped
 *  full-resend body can't ride a passthrough/bypass/hop-marker/decode-fail
 *  lane to a strict-schema upstream (#1403 doctrine) or break #661's body
 *  fingerprinting. A body WITHOUT the fields must pass back byte-identical
 *  (same Buffer object), so the normal case is untouched. */
import test from "node:test";
import assert from "node:assert/strict";
import { scrubMsgIdFields } from "../src/server.ts";
import { MSG_IDS_BODY_FIELD, MSG_SEQS_BODY_FIELD } from "../src/msgid-pin.ts";

const log = (_level: string, _msg: string) => {};

test("scrubMsgIdFields: strips both fields when present", () => {
    const body = {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        [MSG_IDS_BODY_FIELD]: ["a", "b"],
        [MSG_SEQS_BODY_FIELD]: [1, 2],
    };
    const out = scrubMsgIdFields(Buffer.from(JSON.stringify(body), "utf8"), log);
    const parsed = JSON.parse(out.toString("utf8")) as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, MSG_IDS_BODY_FIELD));
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, MSG_SEQS_BODY_FIELD));
    // the rest of the body survives
    assert.deepEqual(parsed.messages, [{ role: "user", content: "hi" }]);
    assert.equal(parsed.model, "m");
});

test("scrubMsgIdFields: strips a lone field", () => {
    const body = { messages: [{ role: "user", content: "hi" }], [MSG_SEQS_BODY_FIELD]: [7] };
    const out = scrubMsgIdFields(Buffer.from(JSON.stringify(body), "utf8"), log);
    const parsed = JSON.parse(out.toString("utf8")) as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, MSG_SEQS_BODY_FIELD));
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, MSG_IDS_BODY_FIELD));
});

test("scrubMsgIdFields: body without the fields passes back the SAME buffer (byte-identical, #661)", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const buf = Buffer.from(JSON.stringify(body), "utf8");
    const out = scrubMsgIdFields(buf, log);
    assert.strictEqual(out, buf, "must be the same Buffer object — zero re-serialization in the normal case");
});

test("scrubMsgIdFields: non-JSON body passes through untouched", () => {
    const buf = Buffer.from("not json at all", "utf8");
    assert.strictEqual(scrubMsgIdFields(buf, log), buf);
});

test("scrubMsgIdFields: JSON array body passes through untouched (top-level must be an object)", () => {
    const buf = Buffer.from(JSON.stringify([{ [MSG_IDS_BODY_FIELD]: ["x"] }]), "utf8");
    assert.strictEqual(scrubMsgIdFields(buf, log), buf);
});

test("scrubMsgIdFields: null body passes through untouched", () => {
    const buf = Buffer.from("null", "utf8");
    assert.strictEqual(scrubMsgIdFields(buf, log), buf);
});

test("scrubMsgIdFields: empty buffer passes through untouched", () => {
    const buf = Buffer.alloc(0);
    assert.strictEqual(scrubMsgIdFields(buf, log), buf);
});
