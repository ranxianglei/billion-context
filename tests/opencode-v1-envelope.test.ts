// #6525/#6539 (发) opencode V1 full-resend envelope — the fetch-time glue in
// opencode-native.ts that positionally proves the transform-harvested host ids
// against the ACTUAL wire and stamps the x-bili-msg-ids header (the server's
// header channel, handle.ts) + feeds the shared watermark slot. The core
// alignment proof (alignedMsgIdsForWire) is covered by opencode-msgids.test.ts;
// these tests cover the glue: wire gating, sid lookup, degrade classes, and
// the never-overwrite / never-restamp-diverted guards.
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { opencodeV1EnvelopeBeforeSend } from "../src/agent/opencode-native.js";
import { harvestOpencodeMsgIds, __resetOpencodeMsgIdsForTests } from "../src/agent/opencode-msgids.js";
import { INCREMENTAL_TURN_MARKER_HEADER } from "../src/agent/incremental-client.js";

const SID = "ses_v1_test";

function hostMsg(id: string, role: "user" | "assistant", texts: string[]): unknown {
    return { info: { id, role, sessionID: SID }, parts: texts.map((text) => ({ type: "text", text })) };
}
function wireMsg(role: "user" | "assistant", content: unknown): unknown {
    return { role, content };
}
function initFor(body: unknown, headers: Record<string, string> = {}): RequestInit {
    return { method: "POST", headers, body: JSON.stringify(body) };
}

describe("opencodeV1EnvelopeBeforeSend (opencode V1 full-resend envelope, #6525/#6539)", () => {
    beforeEach(() => {
        __resetOpencodeMsgIdsForTests();
    });

    it("stamps x-bili-msg-ids for a pure-text aligned turn", async () => {
        harvestOpencodeMsgIds(SID, [hostMsg("msg_a000000000001", "user", ["hello"]), hostMsg("msg_a000000000002", "assistant", ["hi there"])]);
        const init = initFor(
            { model: "claude-x", messages: [wireMsg("user", "hello"), wireMsg("assistant", "hi there")] },
            { "x-bili-plugin-conversation": SID },
        );
        await opencodeV1EnvelopeBeforeSend("https://up/v1/messages", init);
        assert.equal(new Headers(init.headers).get("x-bili-msg-ids"), "msg_a000000000001,msg_a000000000002");
    });

    it("accepts block-array content that lowers to the same text sequence", async () => {
        harvestOpencodeMsgIds(SID, [hostMsg("msg_b000000000001", "user", ["line1", "line2"])]);
        const init = initFor(
            { model: "claude-x", messages: [wireMsg("user", [{ type: "text", text: "line1" }, { type: "text", text: "line2" }])] },
            { "x-bili-plugin-conversation": SID },
        );
        await opencodeV1EnvelopeBeforeSend("https://up/v1/messages", init);
        assert.equal(new Headers(init.headers).get("x-bili-msg-ids"), "msg_b000000000001");
    });

    it("degrades (no header) when a harvested message carries a non-text part", async () => {
        // tool part → shape:null → poisons alignment for the whole turn.
        harvestOpencodeMsgIds(SID, [
            hostMsg("msg_c000000000001", "user", ["call the tool"]),
            { info: { id: "msg_c000000000002", role: "assistant", sessionID: SID }, parts: [{ type: "text", text: "" }, { type: "tool", tool: "bash" }] },
        ]);
        const init = initFor(
            { model: "claude-x", messages: [wireMsg("user", "call the tool"), wireMsg("assistant", "done")] },
            { "x-bili-plugin-conversation": SID },
        );
        await opencodeV1EnvelopeBeforeSend("https://up/v1/messages", init);
        assert.equal(new Headers(init.headers).get("x-bili-msg-ids"), null);
    });

    it("degrades when the wire count diverges from the harvest (race / drift)", async () => {
        harvestOpencodeMsgIds(SID, [hostMsg("msg_d000000000001", "user", ["one"])]);
        const init = initFor(
            { model: "claude-x", messages: [wireMsg("user", "one"), wireMsg("assistant", "two")] }, // 2 wire, 1 harvested
            { "x-bili-plugin-conversation": SID },
        );
        await opencodeV1EnvelopeBeforeSend("https://up/v1/messages", init);
        assert.equal(new Headers(init.headers).get("x-bili-msg-ids"), null);
    });

    it("degrades when no harvest exists for the conversation", async () => {
        const init = initFor(
            { model: "claude-x", messages: [wireMsg("user", "hello")] },
            { "x-bili-plugin-conversation": "ses_never_harvested" },
        );
        await opencodeV1EnvelopeBeforeSend("https://up/v1/messages", init);
        assert.equal(new Headers(init.headers).get("x-bili-msg-ids"), null);
    });

    it("degrades when the conversation header is absent", async () => {
        harvestOpencodeMsgIds(SID, [hostMsg("msg_e000000000001", "user", ["hello"])]);
        const init = initFor({ model: "claude-x", messages: [wireMsg("user", "hello")] }); // no conversation header
        await opencodeV1EnvelopeBeforeSend("https://up/v1/messages", init);
        assert.equal(new Headers(init.headers).get("x-bili-msg-ids"), null);
    });

    it("never restamps an incremental-lane (diverted) turn", async () => {
        harvestOpencodeMsgIds(SID, [hostMsg("msg_f000000000001", "user", ["hello"])]);
        const init = initFor(
            { model: "claude-x", messages: [wireMsg("user", "hello")] },
            { "x-bili-plugin-conversation": SID, [INCREMENTAL_TURN_MARKER_HEADER]: "turn-1" },
        );
        await opencodeV1EnvelopeBeforeSend("https://up/v1/messages", init);
        assert.equal(new Headers(init.headers).get("x-bili-msg-ids"), null);
    });

    it("never overwrites an already-present x-bili-msg-ids (a V2 request stamps its own)", async () => {
        harvestOpencodeMsgIds(SID, [hostMsg("msg_g000000000001", "user", ["hello"])]);
        const init = initFor(
            { model: "claude-x", messages: [wireMsg("user", "hello")] },
            { "x-bili-plugin-conversation": SID, "x-bili-msg-ids": "msg_preexisting0000" },
        );
        await opencodeV1EnvelopeBeforeSend("https://up/v1/messages", init);
        assert.equal(new Headers(init.headers).get("x-bili-msg-ids"), "msg_preexisting0000");
    });

    it("leaves non-anthropic-wire / non-object bodies untouched", async () => {
        harvestOpencodeMsgIds(SID, [hostMsg("msg_h000000000001", "user", ["hello"])]);
        // openai-shape (role tool present) fails wireMessagesLookAnthropic
        const openai = initFor(
            { model: "gpt-x", messages: [{ role: "tool", tool_call_id: "call_1", content: "x" }] },
            { "x-bili-plugin-conversation": SID },
        );
        await opencodeV1EnvelopeBeforeSend("https://up/v1/chat/completions", openai);
        assert.equal(new Headers(openai.headers).get("x-bili-msg-ids"), null);
    });
});
