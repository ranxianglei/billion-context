import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createInitialState, emptyRefMap } from "acp-kernel";
import { beyondFrontierNote } from "../src/stream.ts";

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

// #5149: three independent reporters (Claude Code 0.1.197, omp/OpenAI 0.1.209
// + 0.1.212) hit the same production defect — the compression nudge offers
// refs from a long-lived conversation view, but the compress call resolves to
// a DIFFERENT (near-empty) session view, so every offered ref sits far above
// the target's high-water and fails stale-ref. The model then has no safe
// recovery: the receipt only steered it to "request refs ≤ hi", which in the
// drift case means folding the WRONG session's few refs (kaijianding reported
// correctly avoiding that). The beyond-frontier note (which already fires for
// this all-above-frontier shape) must now name the binding inconsistency,
// forbid probing/guessing other refs, and give the fresh-conversation recovery.

test("#5149: beyond-frontier note carries the session-binding-inconsistency warning", () => {
    // near-empty target session: only 3 refs minted (a scaled-down version of
    // francis-io's near-empty "highest allocated ref=m00009" shape)
    const res = assignRefs(
        [textMsg("r1", "assistant", "a"), textMsg("r2", "assistant", "b"), textMsg("r3", "assistant", "c")],
        { existing: emptyRefMap(), nextIndex: 0 },
    );
    const state = createInitialState();
    state.messageRefs = res.map;

    // the model's nudge offered refs far above the target's space
    // (francis-io m01411–m01935 / kaijianding m05160+ shapes)
    const note = beyondFrontierNote(state, [{ startRef: "m01411", endRef: "m01935" }]);

    assert.match(note, /above this session's highest ref \(m00003\)/, "still names the frontier");
    assert.match(note, /stale artifacts/, "keeps the stale-generation attribution");
    // the new guidance:
    assert.match(note, /session-binding inconsistency/i, "names the binding inconsistency");
    assert.match(note, /do NOT probe or guess other refs/i, "forbids probing/guessing other refs");
    assert.match(note, /folding them would corrupt it/i, "explains why probing is unsafe");
    assert.match(note, /start a fresh conversation/i, "gives the safe recovery");
});

test("#5149: note stays empty for in-frontier / no-mapped-refs (negatives unchanged)", () => {
    const res = assignRefs([textMsg("r1", "assistant", "a"), textMsg("r2", "assistant", "b")], { existing: emptyRefMap(), nextIndex: 0 });
    const state = createInitialState();
    state.messageRefs = res.map;
    assert.equal(beyondFrontierNote(state, [{ startRef: "m00001", endRef: "m00006" }]), "", "in-frontier start suppresses");
    const emptyState = createInitialState();
    assert.equal(beyondFrontierNote(emptyState, [{ startRef: "m00001", endRef: "m00002" }]), "", "no mapped refs");
});
