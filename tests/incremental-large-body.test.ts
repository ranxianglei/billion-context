import assert from "node:assert/strict";
import test from "node:test";
import { incrementalTurnBodyShape } from "../src/incremental-lane.js";
import { incrementalEnvelopeConversationId } from "../src/agent/incremental-client.js";

test("large incremental envelopes keep the same lane classification as the client", () => {
    const envelope = { conversationId: "synthetic-large-seed", sinceSeq: 0, messages: [{ role: "user", content: "synthetic" }], request: { model: "fixture-model" } };
    assert.equal(incrementalEnvelopeConversationId(envelope), envelope.conversationId);
    // Valid JSON whitespace crosses the old heuristic without allocating a
    // huge nested text object. readBody owns the actual receive-size budget.
    const raw = Buffer.from(JSON.stringify(envelope) + " ".repeat(64 * 1024 * 1024));
    assert.ok(raw.length > 64 * 1024 * 1024);
    assert.equal(incrementalTurnBodyShape(raw), true, "must not relay a lane-only envelope as an ordinary model request");
});

test("large marked ordinary requests retain their ordinary classification", () => {
    const ordinary = { model: "fixture-model", messages: [{ role: "user", content: "synthetic" }] };
    const raw = Buffer.from(JSON.stringify(ordinary) + " ".repeat(64 * 1024 * 1024));
    assert.equal(incrementalEnvelopeConversationId(ordinary), undefined);
    assert.equal(incrementalTurnBodyShape(raw), false);
});
