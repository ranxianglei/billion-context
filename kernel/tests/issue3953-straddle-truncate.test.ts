// #3953: a compress range that STRADDLES a protected message (the protected
// id falls interior to the range) used to carve the protected message out and
// fold both sides into one block — the summary of messages AFTER the
// protected user message (its replies) then anchored at the EARLIEST covered
// position, i.e. BEFORE the question it answers. The fix truncates the fold
// at the first protected message: everything from that position on stays
// visible, causality intact. A protected message at the range TAIL (the
// advisory recent-zone brush this carve was built for) is unaffected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function setup(n: number, role: (i: number) => CoreMessage["role"] = (i) => (i % 2 === 1 ? "user" : "assistant")): { core: ReturnType<typeof createCore>; state: ReturnType<typeof createInitialState>; messages: CoreMessage[] } {
    const core = createCore();
    const state = createInitialState();
    const messages: CoreMessage[] = [];
    for (let i = 1; i <= n; i++) {
        messages.push(msg(`p${i}`, `body ${i} `.repeat(120), role(i)));
    }
    state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
    return { core, state, messages };
}

test("#3953: interior protected message truncates the fold at the boundary, replies stay visible after it", () => {
    // p7 = most recent user message (interior protection), p8..p10 = replies.
    // p7 = most recent USER message; p8..p10 are all assistant replies, so
    // the last-user protection pins p7 INTERIOR to a range that reaches p9.
    const { core, state, messages } = setup(10, (i) => (i > 7 ? "assistant" : i % 2 === 1 ? "user" : "assistant"));
    const result = core.applyCompression({
        ranges: [{ startRef: "m00002", endRef: "m00009", summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
        messages,
        state,
        config: defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 }),
    });
    assert.equal(result.result.blocksCreated, 1);
    const block = result.state.blocks.find((b) => b.active)!;
    assert.deepEqual(
        block.effectiveMessageIds,
        ["p2", "p3", "p4", "p5", "p6"],
        "fold truncates at the first protected message; p7 (protected user msg) and p8/p9 (its replies) stay visible",
    );
    const warn = result.result.warnings.find((w) => w.startsWith("Excluded"));
    assert.ok(warn, `expected an exclusion warning, got: ${JSON.stringify(result.result.warnings)}`);
    assert.match(warn, /truncated/i, "warning names the truncation");
    assert.match(warn, /stay visible/i);
});

test("#3953: tail-only protected brush keeps the byte-identical advisory carve (no truncation clause)", () => {
    // Protected ids sit at the range TAIL (m00007..m00008 of m00002..m00008)
    // — the bili-470 advisory shape. Nothing follows them inside the range,
    // so truncation must be a no-op and the warning must stay byte-identical.
    const { core, state, messages } = setup(8);
    const result = core.applyCompression({
        ranges: [{ startRef: "m00002", endRef: "m00008", summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
        messages,
        state,
        config: defaultConfig(200000, { preserveRecentMessages: 2, preserveRecentTokens: 0 }),
    });
    assert.equal(result.result.blocksCreated, 1);
    const block = result.state.blocks.find((b) => b.active)!;
    assert.deepEqual(block.effectiveMessageIds, ["p2", "p3", "p4", "p5", "p6"]);
    const warn = result.result.warnings.find((w) => w.startsWith("Excluded"));
    assert.ok(warn);
    assert.match(warn!, /Excluded 2 protected message\(s\) m00007, m00008/);
    assert.match(warn!, /do not target them in another compress call/);
    assert.doesNotMatch(warn!, /truncated/i, "no truncation clause for the tail-brush shape");
});
