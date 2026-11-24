import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { coreToResponses } from "acp-kernel/wire";
import { judgeInboundOutbound, maybeJudgeContinuity, _setInvariantJudgeForTest, type JudgeVerdict } from "../src/invariant-judge.ts";
import { repairResponsesAssistantOrdering } from "../src/server/responses-ordering.ts";
import { RESPONSES_TURN_SEPARATOR } from "../src/server/responses-separator.ts";

// #564/#2627 continuity: a loop round's entry side is bili's PREVIOUS outbound,
// so its separators are bili's own markers. With their proven indexes carried
// as entry-side provenance they are never client obligations: re-sent they
// match, moved or removed they are no drop — and nothing else is exempted.

let n = 0;
const msg = (role: "user" | "assistant", text: string): CoreMessage => ({ id: `c${n++}`, role, contentType: "text", text });
const sep = (): CoreMessage => msg("user", RESPONSES_TURN_SEPARATOR);
const kinds = (v: JudgeVerdict): string => JSON.stringify(v.violations.map((x) => [x.kind, x.index]));

// Previous round: one bili marker between two assistant turns, at entry index 2.
const prev = (): CoreMessage[] => [msg("user", "q1"), msg("assistant", "r1"), sep(), msg("assistant", "r2"), msg("user", "q2")];

test("an entry marker bili owned matches its owned re-send when this round mints another", () => {
    const exit = [msg("user", "q1"), msg("assistant", "r1"), sep(), msg("assistant", "r2"), msg("user", "q2"), msg("assistant", "r3"), sep(), msg("assistant", "r4")];
    const v = judgeInboundOutbound(prev(), exit, { separatorProvenance: new Set([2, 6]), entrySeparatorProvenance: new Set([2]) });
    assert.equal(v.ok, true, kinds(v));
});

test("bili moving or removing its own marker is not a drop", () => {
    const exit = [msg("user", "q1"), msg("assistant", "r1"), msg("assistant", "r2"), msg("user", "q2"), msg("assistant", "r3"), sep(), msg("assistant", "r4")];
    const v = judgeInboundOutbound(prev(), exit, { separatorProvenance: new Set([5]), entrySeparatorProvenance: new Set([2]) });
    assert.equal(v.ok, true, kinds(v));
});

test("a shed round without exit provenance still matches the re-sent marker by equality", () => {
    const exit = [msg("user", "q1"), msg("assistant", "r1"), sep(), msg("assistant", "r2"), msg("user", "q2"), msg("assistant", "r3")];
    const v = judgeInboundOutbound(prev(), exit, { entrySeparatorProvenance: new Set([2]) });
    assert.equal(v.ok, true, kinds(v));
});

test("an owned entry marker never pulls the cursor past a dropped client item", () => {
    // Marker removed AND the client's r2 dropped: the owned marker must not
    // jump to the new marker at exit 4 and swallow r2's absence.
    const exit = [msg("user", "q1"), msg("assistant", "r1"), msg("user", "q2"), msg("assistant", "r3"), sep(), msg("assistant", "r4")];
    const v = judgeInboundOutbound(prev(), exit, { separatorProvenance: new Set([4]), entrySeparatorProvenance: new Set([2]) });
    assert.equal(v.ok, false);
    assert.ok(v.violations.some((x) => x.index === 3 && (x.kind === "mid-history-rewrite" || x.kind === "mid-history-drop")), kinds(v));
});

test("entry ownership is per index: a dropped client lookalike is still judged", () => {
    const entry = [msg("user", "q1"), sep(), msg("assistant", "r1"), sep(), msg("assistant", "r2")];
    const exit = [msg("user", "q1"), msg("assistant", "r1"), sep(), msg("assistant", "r2")];
    const v = judgeInboundOutbound(entry, exit, { separatorProvenance: new Set([2]), entrySeparatorProvenance: new Set([3]) });
    assert.equal(v.ok, false);
    assert.ok(v.violations.some((x) => x.index === 1), kinds(v));
});

test("maybeJudgeContinuity carries the producer's proven markers into the next round", () => {
    const user = (id: string, text: string): CoreMessage => ({ id, role: "user", contentType: "text", text });
    const asst = (id: string, text: string): CoreMessage => ({ id, role: "assistant", contentType: "text", text });
    const reasoning = (id: string): CoreMessage => ({ id, role: "assistant", contentType: "reasoning", text: id, rawResponsesItem: { type: "reasoning", id, encrypted_content: `ENC_${id}`, summary: [] } } as CoreMessage);
    const round1 = [user("u1", "q"), reasoning("rsA"), asst("txA", "A"), reasoning("rsB"), asst("txB", "B")];
    const round2 = [...round1, reasoning("rsC"), asst("txC", "C")];
    const ordered1 = repairResponsesAssistantOrdering(round1, round1);
    const ordered2 = repairResponsesAssistantOrdering(round2, round2);
    assert.equal(ordered1.slots.length, 1);
    assert.equal(ordered2.slots.length, 2, "fixture: round 2 re-mints round 1's marker and adds one");
    const wire1 = coreToResponses(ordered1.messages) as unknown[];
    const wire2 = coreToResponses(ordered2.messages) as unknown[];
    const body1 = JSON.stringify({ input: wire1 });
    const body2 = JSON.stringify({ input: wire2 });
    const verdicts: JudgeVerdict[] = [];
    _setInvariantJudgeForTest(true, (v) => { verdicts.push(v); });
    try {
        const owned1 = maybeJudgeContinuity(null, body1, "responses", "s-carry", ordered1.slots, wire1);
        assert.equal(owned1?.size, 1, "the first send's marker is proven even without a previous body");
        assert.equal(verdicts.length, 0, "no previous body, no verdict");
        maybeJudgeContinuity(body1, body2, "responses", "s-carry", ordered2.slots, wire2, owned1);
        assert.equal(verdicts.at(-1)?.ok, true, kinds(verdicts.at(-1)!));
    } finally {
        _setInvariantJudgeForTest(false);
    }
});
