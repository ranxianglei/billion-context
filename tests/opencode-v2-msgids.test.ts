// #5825 host wiring (opencode V2): extraction + stamp-budget unit matrix.
// The whole-turn-degrade contract is the point — any single unusable entry in
// the turn's message list kills the WHOLE stamp (宁可降级不可错位).

import assert from "node:assert/strict";
import test from "node:test";

import { opencodeV2MsgIdList, stampedMsgIdsHeaderFromMessages } from "../src/agent/opencode-v2-msgids.js";

const turn = (...ids: string[]) => ids.map((id, i) => ({ id, role: i % 2 === 0 ? "user" : "assistant" }));

test("v2 extraction: full usable list stamps comma-joined", () => {
    const list = opencodeV2MsgIdList(turn("msg_abc123", "msg_def456", "msg_ghi789"));
    assert.deepEqual(list, ["msg_abc123", "msg_def456", "msg_ghi789"]);
    assert.equal(stampedMsgIdsHeaderFromMessages(turn("msg_abc123", "msg_def456")), "msg_abc123,msg_def456");
});

test("v2 extraction: missing id on ANY entry poisons the whole turn", () => {
    assert.equal(opencodeV2MsgIdList([{ id: "msg_a" }, {}]), undefined);
    assert.equal(opencodeV2MsgIdList([null, { id: "msg_a" }]), undefined);
    assert.equal(stampedMsgIdsHeaderFromMessages([{ id: "msg_a" }, { role: "assistant" }]), undefined);
});

test("v2 extraction: foreign-shaped ids never ride", () => {
    for (const bad of ["mvs_deadbeef", "acp_summary_x", "msg_", "", "msg_a b", "msg_a\u00e9tail", "msg_..a"]) {
        assert.equal(opencodeV2MsgIdList(turn("msg_ok", bad)), undefined, `foreign id ${JSON.stringify(bad)} must poison`);
    }
});

test("v2 extraction: non-message-array inputs degrade", () => {
    assert.equal(opencodeV2MsgIdList(undefined), undefined);
    assert.equal(opencodeV2MsgIdList(null), undefined);
    assert.equal(opencodeV2MsgIdList([]), undefined);
    assert.equal(opencodeV2MsgIdList(["not-an-object" as unknown as { id?: string; role?: string }]), undefined);
});

// #6525/#6539 core alignment: the header must align to the POST-HOIST core
// count the server pins against, so the contiguous leading system/developer
// run (which openaiToCore hoists out of the fold space) is excluded.
const lead = (roles: string[], id = (i: number) => `msg_lead${i}`) =>
    roles.map((role, i) => ({ id: id(i), role }));

test("v2 core-align: leading system run is skipped (openai wire case)", () => {
    // [system, user, assistant] → only [user, assistant] ids ride.
    assert.deepEqual(
        opencodeV2MsgIdList(lead(["system", "user", "assistant"])),
        ["msg_lead1", "msg_lead2"],
    );
    // multiple leading systems + developer all hoist out.
    assert.deepEqual(
        opencodeV2MsgIdList(lead(["system", "system", "developer", "user", "assistant"])),
        ["msg_lead3", "msg_lead4"],
    );
});

test("v2 core-align: no leading system is a no-op (anthropic wire case)", () => {
    // anthropic keeps system as a separate field, never inside messages → all ride.
    assert.deepEqual(
        opencodeV2MsgIdList(lead(["user", "assistant", "user"])),
        ["msg_lead0", "msg_lead1", "msg_lead2"],
    );
});

test("v2 core-align: mid-conversation system keeps its id", () => {
    // A system message that is NOT part of the leading run is a real core.
    assert.deepEqual(
        opencodeV2MsgIdList(lead(["user", "system", "assistant"])),
        ["msg_lead0", "msg_lead1", "msg_lead2"],
    );
});

test("v2 core-align: only a leading system run → nothing to pin", () => {
    assert.equal(opencodeV2MsgIdList(lead(["system"])), undefined);
    assert.equal(opencodeV2MsgIdList(lead(["system", "developer"])), undefined);
    assert.equal(stampedMsgIdsHeaderFromMessages(lead(["system"])), undefined);
});

test("v2 core-align: a poison entry after the leading run still kills the stamp", () => {
    // system is skipped, but the missing id on the user message poisons.
    assert.equal(opencodeV2MsgIdList([{ id: "msg_s", role: "system" }, { role: "user" }]), undefined);
});

test("v2 stamp budget: >4096 ids or >16KiB joined degrades without riding", () => {
    const big = Array.from({ length: 4097 }, (_, i) => ({ id: `msg_x${i}`, role: "user" }));
    assert.equal(opencodeV2MsgIdList(big), undefined, "per-turn id cap");
    // 4096 ids × ~12 bytes ≈ 48KiB joined → over the 16KiB header budget.
    const many = Array.from({ length: 4096 }, (_, i) => ({ id: `msg_padpadpadpadpad${i}`, role: "user" }));
    assert.notEqual(opencodeV2MsgIdList(many), undefined, "list itself is valid at exactly the cap");
    assert.equal(stampedMsgIdsHeaderFromMessages(many), undefined, "join budget degrades the STAMP only");
});
