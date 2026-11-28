import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { describeUncoveredRuns, uncoveredHistoryRuns } from "../src/uncovered.ts";

// #5780: UNCOVERED HISTORY advertised a protected-boundary turn fragment that
// apply ALWAYS rejects ("Range would split N turn(s) at the protected-zone
// boundary"), wasting a round trip and dragging the sibling range down in the
// atomic batch rollback. Root cause: the audit surface (added by #4331) never
// ran the shared apply-side foldability judgment (#3236 doctrine — advertise
// and execute must share one projection). Fix: every final run is screened
// through core.applyCompression on a state clone (public API, zero kernel
// diff); structurally-doomed runs carry a compact ⚠ marker, transient
// rejections (below the fold-size gate) stay plain.
//
// Geometry (P1): "fold up to the previous question" — the single most common
// model behavior — covers turn 0 plus turn 1's USER message. The recent
// window then starts exactly on turn 1's FIRST tool call: the surviving run
// is turn 1's reasoning+text plus all of turn 2, and its doomed head would
// fold away while that turn's calls sit behind the zone — submitting the run
// withdraws the whole turn and empties the range → the exact fatal from the
// incident log (L15599). Pre-fix the zone diff claimed every entry of the
// run and dropped it silently.
const MSGS_PER_TURN = 9;
const SUMMARY = "SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-SUMMARY-MINIMUM-LENGTH-CHECK-OK";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "issue5780-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

function withRefs(ctx: Ctx): Ctx {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function runApply(ctx: Ctx, args: unknown): string {
    return applyRanges(parseCompressInput(args), ctx).text;
}

// Turn layout (9 msgs): user, reasoning, text, 3x(tool-call, tool-result).
// Callers must pass a tool name OUTSIDE the kernel's built-in
// neverPreserveRecentTools list (decompress/search_context/read/bash, kernel
// types.ts): those messages are skipped when computeProtectedRefs counts the
// recent-N window, which silently distorts the protected zone in small
// sessions ("probe" is neutral).
function turnMsgs(turn: number, payloadChars: number, toolName: string): CoreMessage[] {
    const id = (k: number) => `t${turn}_${k}`;
    const fill = "x".repeat(payloadChars);
    return [
        { id: id(0), role: "user", contentType: "text", text: `User request for turn ${turn}. ${payloadChars > 0 ? fill.slice(0, 200) : ""}` },
        { id: id(1), role: "assistant", contentType: "reasoning", text: `Reasoning for turn ${turn}. ${payloadChars > 0 ? fill.slice(0, 200) : ""}` },
        { id: id(2), role: "assistant", contentType: "text", text: `Assistant answer for turn ${turn}. ${fill}` },
        ...[0, 1, 2].flatMap((k): CoreMessage[] => [
            { id: id(3 + k * 2), role: "assistant", contentType: "tool-call", toolName, toolCallId: `tc_${turn}_${k}`, text: JSON.stringify({ input: `${toolName} step-${k} ${fill.slice(0, 600)}` }) },
            { id: id(4 + k * 2), role: "tool", contentType: "tool-result", toolName, toolCallId: `tc_${turn}_${k}`, text: `result of ${toolName} step-${k}: ${fill.slice(0, 600)}` },
        ]),
    ];
}

function buildSession(turns: number, payloadChars: number, toolName: string): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let t = 0; t < turns; t++) out.push(...turnMsgs(t, payloadChars, toolName));
    return out;
}

const refAt = (i: number) => `m${String(i + 1).padStart(5, "0")}`;
const foldArgs = (spans: Array<{ startRef: string; endRef: string }>) =>
    ({ content: spans.map((s) => ({ startId: s.startRef, endId: s.endRef, summary: SUMMARY })) });

// Three turns; fold [turn 0 + turn 1's user message] — "up to the previous
// question". preserveRecentMessages: 15 puts the protected window exactly on
// turn 1's FIRST tool call (idx 12 of 27): turn 1's reasoning+text stay
// uncovered while every call/result of the turn sits behind the zone. The
// surviving run m00011–m00027 is structurally doomed — folding its head
// withdraws the turn's first group via INV1 (kept calls lose their reasoning)
// and empties the range: the incident's L15599 fatal. Pre-fix the zone diff
// claimed every entry of the run and dropped it silently.
function fragmentSession(payloadChars: number): Ctx {
    const ctx = withRefs(makeCtx(buildSession(3, payloadChars, "probe"), { preserveRecentMessages: 15, preserveRecentTokens: 0 }));
    const upToPrevQuestion = { startRef: refAt(0), endRef: refAt(MSGS_PER_TURN) }; // idx 0..9: turn 0 + u_1
    const out = runApply(ctx, foldArgs([upToPrevQuestion]));
    assert.ok(out.startsWith("[Compressed"), `setup fold expected to land, got: ${out.slice(0, 200)}`);
    return ctx;
}

test("#5780 P1: protected-boundary turn fragment is marked not foldable, and submitting it verbatim still fails identically (advertise↔execute agreement)", () => {
    const ctx = fragmentSession(4000);
    const runs = uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });
    assert.ok(runs.length >= 1, `expected at least one uncovered run, got: ${JSON.stringify(runs)}`);
    // The run starts at turn 1's reasoning (its user msg is covered by the
    // setup fold) and ends where the recent window clips it.
    const frag = runs.find((r) => r.startRef === refAt(MSGS_PER_TURN + 1));
    assert.ok(frag, `fragment run starting at turn-1 reasoning (${refAt(MSGS_PER_TURN + 1)}) missing: ${JSON.stringify(runs)}`);
    assert.match(frag.note ?? "", /not foldable/, `doomed fragment must carry the marker: ${JSON.stringify(frag)}`);
    assert.match(frag.note ?? "", /split/i, `marker must name the split cause: ${JSON.stringify(frag)}`);
    // Consistency pin: the advertised span, submitted verbatim, receives the
    // SAME structural rejection the marker predicts (the incident's L15599).
    const receipt = runApply(ctx, foldArgs([{ startRef: frag.startRef, endRef: frag.endRef }]));
    assert.ok(receipt.includes("FAILED"), `verbatim submission must fail:\n${receipt}`);
    assert.match(receipt, /would split/, `expected the split fatal, got:\n${receipt}`);
});

test("#5780 P1b: the marker rides the rendered surfaces (describeUncoveredRuns / acp_status family)", () => {
    const ctx = fragmentSession(4000);
    const runs = uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });
    const s = describeUncoveredRuns(runs);
    assert.match(s, /not foldable/, `rendered listing must carry the marker:\n${s}`);
});

test("#5780 N1: a turn-aligned mid-history run far from the zone stays UNMARKED and folds cleanly (no over-marking)", () => {
    // 40 turns; fold turns 1..16 and 28..39 → the hole (turns 17..27) is whole
    // turns, nowhere near the recent window. Same audit, opposite verdict.
    const ctx = withRefs(makeCtx(buildSession(40, 4000, "probe"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const left = { startRef: refAt(1 * MSGS_PER_TURN), endRef: refAt(17 * MSGS_PER_TURN - 1) };
    const right = { startRef: refAt(28 * MSGS_PER_TURN), endRef: refAt(40 * MSGS_PER_TURN - 1) };
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `setup folds expected to land, got: ${out.slice(0, 200)}`);
    const runs = uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });
    const hole = runs.find((r) => r.startRef === refAt(17 * MSGS_PER_TURN));
    assert.ok(hole, `hole run missing: ${JSON.stringify(runs)}`);
    assert.equal(hole.note, undefined, `viable hole must stay unmarked: ${JSON.stringify(hole)}`);
    // The recent-window tail (turn 39) is fully zone-claimed with its head
    // INSIDE the protected claim: it stays silent (no over-reporting).
    assert.equal(runs.find((r) => r.startRef === refAt(39 * MSGS_PER_TURN)), undefined, `zone-claimed tail must stay silent: ${JSON.stringify(runs)}`);
    const receipt = runApply(ctx, foldArgs([{ startRef: hole.startRef, endRef: hole.endRef }]));
    assert.ok(receipt.startsWith("[Compressed"), `unmarked run must fold cleanly:\n${receipt.slice(0, 300)}`);
});

test("#5780 P2: a run whose WHOLE body the zone diff claims is reported+marked when its head predates the protected window (was: silently vanished)", () => {
    // 4 turns; fold [turns 0-1 + turn 2's user] ("up to the previous question").
    // preserveRecentMessages: 15 puts the zone exactly on turn 2's FIRST tool
    // call (idx 21 of 36): turn 2's reasoning+text stay uncovered, the normal
    // offer demotes that doomed head unit via turn-integrity, and the zone
    // claims the tail — so EVERY entry of the run m00020–m00036 is
    // zone-diff-claimed and pre-fix code dropped the ENTIRE run as
    // "zone-hidden" although its head predates the protected window. Larger
    // context variant of P1.
    const ctx = withRefs(makeCtx(buildSession(4, 4000, "probe"), { preserveRecentMessages: 15, preserveRecentTokens: 0 }));
    const upToPrevQuestion = { startRef: refAt(0), endRef: refAt(2 * MSGS_PER_TURN) }; // idx 0..18
    const out = runApply(ctx, foldArgs([upToPrevQuestion]));
    assert.ok(out.startsWith("[Compressed"), `setup fold expected to land, got: ${out.slice(0, 200)}`);
    const runs = uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });
    const doomed = runs.find((r) => r.startRef === refAt(2 * MSGS_PER_TURN + 1)); // m00020: turn 2's reasoning
    assert.ok(doomed, `pre-claim doomed run missing (silently vanished?): ${JSON.stringify(runs)}`);
    assert.equal(doomed.endRef, refAt(4 * MSGS_PER_TURN - 1), `full run expected, got: ${JSON.stringify(doomed)}`);
    assert.match(doomed.note ?? "", /not foldable/, `doomed run must carry the marker: ${JSON.stringify(doomed)}`);
    const receipt = runApply(ctx, foldArgs([{ startRef: doomed.startRef, endRef: doomed.endRef }]));
    assert.ok(receipt.includes("FAILED"), `verbatim submission must fail:\n${receipt}`);
    assert.match(receipt, /would split/, `expected the split fatal, got:\n${receipt}`);
});

test("#5780 P2b: a run fully inside a #2886-closure-extended zone gets the zone marker when the naive message-count claim misses the pullback", () => {
    // 4 turns; the setup fold [idx 0..23] ends ON turn 2's second tool CALL.
    // The recent-12 window starts on that call's RESULT (cr@24); #2886 pair
    // closure pulls the paired call (c@23) INTO the zone, but the host-side
    // claim estimate counts messages only and misses the pullback — exactly
    // why it must under-count, never over-count: the run's head sits before
    // the naive claim yet inside the true zone. The reported run m00024–
    // m00036 is entirely zoned → the screen sees the zone fatal.
    const ctx = withRefs(makeCtx(buildSession(4, 4000, "probe"), { preserveRecentMessages: 12, preserveRecentTokens: 0 }));
    const setup = { startRef: refAt(0), endRef: refAt(23) }; // idx 0..23, ends at c_2k1
    const out = runApply(ctx, foldArgs([setup]));
    assert.ok(out.startsWith("[Compressed"), `setup fold expected to land, got: ${out.slice(0, 200)}`);
    const runs = uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });
    const zoned = runs.find((r) => r.startRef === refAt(23)); // m00024: c_2k1 (pulled into the zone)
    assert.ok(zoned, `closure-zone run missing (silently vanished?): ${JSON.stringify(runs)}`);
    assert.equal(zoned.endRef, refAt(4 * MSGS_PER_TURN - 1), `full run expected, got: ${JSON.stringify(zoned)}`);
    assert.match(zoned.note ?? "", /not foldable/, `zoned run must carry the marker: ${JSON.stringify(zoned)}`);
    assert.match(zoned.note ?? "", /protected zone/i, `marker must name the zone cause: ${JSON.stringify(zoned)}`);
    // Consistency pin: verbatim submission is the #5253 soft no-op (not a
    // hard failure) that the marker predicts — nothing folds, nothing fails.
    const receipt = runApply(ctx, foldArgs([{ startRef: zoned.startRef, endRef: zoned.endRef }]));
    assert.match(receipt, /no-op/, `verbatim submission must no-op:\n${receipt}`);
    assert.match(receipt, /entirely inside the protected zone/, `expected the zone no-op wording, got:\n${receipt}`);
});

test("#5780 P2c: the user-anchor zone component — mass past the anchor stays plain+actionable; anchor-claimed and fully-zoned mass is never advertised", () => {
    // Second-repro geometry: everything after the latest (still uncovered)
    // user message. The audit's relaxed pass zeroes preserveRecentMessages,
    // which switches OFF the kernel's user-anchor rule (Rule 3,
    // recommend.ts:150 — coupled to Rule 1) and the token rule alike, so
    // post-anchor mass reads as zone-hidden although only the user msg itself
    // is anchored. N=3/tokens=0: zone = last-3 (idx 24..26) ∪ anchor u_2
    // (idx 18) ∪ #2886 closure pullback (c@23).
    const fresh = () => {
        const ctx = withRefs(makeCtx(buildSession(3, 4000, "probe"), { preserveRecentMessages: 3, preserveRecentTokens: 0 }));
        // idx 0..17: turns 0-1 complete; u_2 stays uncovered → the anchor.
        const setup = runApply(ctx, foldArgs([{ startRef: refAt(0), endRef: refAt(2 * MSGS_PER_TURN - 1) }]));
        assert.ok(setup.startsWith("[Compressed"), `setup fold expected to land, got: ${setup.slice(0, 200)}`);
        return ctx;
    };
    const audit = (ctx: Ctx) =>
        uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });

    // (a) The foldable head PAST the anchor (turn 2's reasoning+text+first
    // pair, m00020–m00023) stays plain and folds cleanly — the anchor must
    // not poison adjacent viable mass.
    const runs = audit(fresh());
    const head = runs.find((r) => r.startRef === refAt(19)); // m00020: r_2
    assert.ok(head, `head run past the anchor missing: ${JSON.stringify(runs)}`);
    assert.equal(head.endRef, refAt(22), `run expected to stop where the zone starts: ${JSON.stringify(head)}`);
    assert.equal(head.note, undefined, `viable head must stay unmarked: ${JSON.stringify(head)}`);
    const receipt = runApply(fresh(), foldArgs([{ startRef: head!.startRef, endRef: head!.endRef }]));
    assert.ok(receipt.startsWith("[Compressed"), `unmarked head must fold cleanly:\n${receipt.slice(0, 300)}`);
    // (b) Neither the anchor-claimed user msg nor the zoned tail is advertised
    // as if it were "older than the protected window".
    assert.equal(runs.find((r) => r.startRef === refAt(18)), undefined, `anchor-claimed user msg must not be advertised: ${JSON.stringify(runs)}`);
    assert.equal(runs.find((r) => r.startRef === refAt(23)), undefined, `zoned tail must stay silent: ${JSON.stringify(runs)}`);

    // (c) Whole turn zoned (N=9 window covers every post-anchor message):
    // nothing is advertised at all — no "older than the window" text may name
    // a run that apply judges 100% inside the zone (the second-repro
    // contradiction).
    const wide = withRefs(makeCtx(buildSession(3, 4000, "probe"), { preserveRecentMessages: 9, preserveRecentTokens: 0 }));
    const setupW = runApply(wide, foldArgs([{ startRef: refAt(0), endRef: refAt(2 * MSGS_PER_TURN - 1) }]));
    assert.ok(setupW.startsWith("[Compressed"), `setup fold expected to land, got: ${setupW.slice(0, 200)}`);
    assert.deepEqual(audit(wide), [], `fully-zoned current turn must stay silent: ${JSON.stringify(audit(wide))}`);
});

test("#5780 P3: mixed-session sweep — every reported run either folds verbatim or carries its marker (no unmarked+doomed combination)", () => {
    // 5 turns, N=15: the folds cover [turn 0 + u_1] and [turn 2 + u_3].
    // Uncovered = turn 1's remainder (clean mid-history hole → plain, folds)
    // plus turn 3's doomed head (r,a — the group's calls sit behind the zone)
    // glued to the zoned tail (→ split marker). One audit surfaces BOTH
    // verdict classes; the sweep asserts the invariant over EVERY reported
    // run on isolated state copies, so one verdict cannot mutate the geometry
    // of the next.
    const fresh = () => {
        const ctx = withRefs(makeCtx(buildSession(5, 4000, "probe"), { preserveRecentMessages: 15, preserveRecentTokens: 0 }));
        const setup = runApply(ctx, foldArgs([
            { startRef: refAt(0), endRef: refAt(MSGS_PER_TURN) },                    // idx 0..9: turn 0 + u_1
            { startRef: refAt(2 * MSGS_PER_TURN), endRef: refAt(3 * MSGS_PER_TURN) }, // idx 18..27: turn 2 + u_3
        ]));
        assert.ok(setup.startsWith("[Compressed"), `setup folds expected to land, got: ${setup.slice(0, 200)}`);
        return ctx;
    };
    const probe = fresh();
    const runs = uncoveredHistoryRuns({ core: probe.core, messages: probe.messages, state: probe.session.state, config: probe.config, tokenCount: 100000 });
    const hole = runs.find((r) => r.startRef === refAt(10));   // m00011: turn 1's reasoning
    const doomed = runs.find((r) => r.startRef === refAt(28)); // m00029: turn 3's reasoning
    assert.ok(hole && doomed, `hole + doomed runs expected: ${JSON.stringify(runs)}`);
    assert.equal(hole!.endRef, refAt(17), JSON.stringify(hole));
    assert.equal(doomed!.endRef, refAt(5 * MSGS_PER_TURN - 1), JSON.stringify(doomed));
    for (const run of runs) {
        const receipt = runApply(fresh(), foldArgs([{ startRef: run.startRef, endRef: run.endRef }]));
        if (run.note === undefined) {
            assert.ok(receipt.startsWith("[Compressed"), `unmarked run must fold verbatim:\n${receipt.slice(0, 300)}`);
        } else {
            assert.ok(receipt.includes("FAILED"), `marked run must be rejected verbatim:\n${receipt}`);
            if (/split/i.test(run.note)) assert.match(receipt, /would split/);
            else if (/protected zone/i.test(run.note)) assert.match(receipt, /entirely inside the protected zone/);
        }
    }
    assert.equal(hole!.note, undefined, `hole must stay plain: ${JSON.stringify(hole)}`);
    assert.match(doomed!.note ?? "", /split/i, `doomed run must carry the split marker: ${JSON.stringify(doomed)}`);
});

test("#5780 P4: a sub-gate run (below minCompressRange) stays UNMARKED — its rejection is transient and self-teaching", () => {
    // Isolated one-turn hole far from the zone, payload-sized so the hole sits
    // BELOW the 5000-char fold gate (~4.9K across its 9 msgs) while clearing
    // the 200-tok viability floor. The screen sees the apply-side "too small"
    // refusal and must NOT mark it: combined with adjacent mass the hole folds,
    // and the refusal text itself teaches the model to combine.
    const ctx = withRefs(makeCtx(buildSession(40, 600, "probe"), { preserveRecentMessages: 3, preserveRecentTokens: 100 }));
    const left = { startRef: refAt(1 * MSGS_PER_TURN), endRef: refAt(18 * MSGS_PER_TURN - 1) };   // turns 1..17
    const right = { startRef: refAt(19 * MSGS_PER_TURN), endRef: refAt(39 * MSGS_PER_TURN - 1) }; // turns 19..38
    const out = runApply(ctx, foldArgs([left, right]));
    assert.ok(out.startsWith("[Compressed"), `setup folds expected to land, got: ${out.slice(0, 200)}`);
    const runs = uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });
    const hole = runs.find((r) => r.startRef === refAt(18 * MSGS_PER_TURN)); // m00163: turn 18
    assert.ok(hole, `sub-gate hole missing: ${JSON.stringify(runs)}`);
    assert.equal(hole.note, undefined, `sub-gate run must stay plain: ${JSON.stringify(hole)}`);
    const receipt = runApply(ctx, foldArgs([{ startRef: hole.startRef, endRef: hole.endRef }]));
    assert.ok(receipt.includes("FAILED"), `sub-gate submission must fail:\n${receipt}`);
    assert.match(receipt, /too small/i, `expected the size-gate refusal, got:\n${receipt}`);
});

test("#5780 P5: an isolated protected-tool run gets the FILTERED marker (not the zone marker) — the no-op cause is the content filter, not the zone", () => {
    // A standalone compress exchange (a call with no preceding assistant act
    // forms its own pair group) sits in mid-history, far from the recent
    // window. Both messages are ALWAYS_PROTECTED, so the offer never reaches
    // it (both passes) and the screen sees the kernel's filter no-op — "all of
    // its content is protected or filtered" — which the zone marker would
    // mislabel. A covered gap isolates the pair from the visible tail, and the
    // tail (3 turns) keeps the recent-3 zone away from the pair.
    const GAP_TURNS = 36;
    const TAIL_TURNS = 3;
    const allProbe = buildSession(GAP_TURNS + TAIL_TURNS, 4000, "probe");
    const gap = allProbe.slice(0, GAP_TURNS * MSGS_PER_TURN);
    const tail = allProbe.slice(GAP_TURNS * MSGS_PER_TURN);
    const fill = "z".repeat(2900);
    const head: CoreMessage[] = [
        { id: "comp_user", role: "user", contentType: "text", text: `Compress request. ${"w".repeat(200)}` },
        { id: "comp_call", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "tc_comp", text: JSON.stringify({ input: `fold ${fill}` }) },
        { id: "comp_result", role: "tool", contentType: "tool-result", toolName: "compress", toolCallId: "tc_comp", text: `compressed: ${fill}` },
    ];
    const ctx = withRefs(makeCtx([...head, ...gap, ...tail], { preserveRecentMessages: 3, preserveRecentTokens: 0 }));
    const userOnly = { startRef: refAt(0), endRef: refAt(0) }; // idx 0: the compress request
    const gapSpan = { startRef: refAt(3), endRef: refAt(3 + gap.length - 1) }; // idx 3..326: the covered gap
    const out = runApply(ctx, foldArgs([userOnly, gapSpan]));
    assert.ok(out.startsWith("[Compressed"), `setup folds expected to land, got: ${out.slice(0, 200)}`);
    const runs = uncoveredHistoryRuns({ core: ctx.core, messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000 });
    const pair = runs.find((r) => r.startRef === refAt(1)); // m00002: the compress call
    assert.ok(pair, `isolated protected-tool run missing: ${JSON.stringify(runs)}`);
    assert.equal(pair.endRef, refAt(2), `run = the pair only: ${JSON.stringify(pair)}`);
    assert.match(pair.note ?? "", /not foldable/, `run must carry the marker: ${JSON.stringify(pair)}`);
    assert.match(pair.note ?? "", /protected or filtered/i, `marker must name the filter cause: ${JSON.stringify(pair)}`);
    assert.doesNotMatch(pair.note ?? "", /protected zone/i, `zone marker would mislabel the filter no-op: ${JSON.stringify(pair)}`);
    // Consistency pin: verbatim submission is the filter no-op the marker
    // predicts — nothing folds, nothing fails.
    const receipt = runApply(ctx, foldArgs([{ startRef: pair.startRef, endRef: pair.endRef }]));
    assert.match(receipt, /no-op/, `verbatim submission must no-op:\n${receipt}`);
    assert.match(receipt, /all of its content is protected or filtered/, `expected the filter no-op wording, got:\n${receipt}`);
});

test("#5780 unit: describeUncoveredRuns renders notes inside the parens and keeps the cap", () => {
    const runs = [
        { startRef: "m00100", endRef: "m00110", count: 9, tokens: 5000 },
        { startRef: "m00120", endRef: "m00125", count: 6, tokens: 3000, note: "\u26a0 not foldable: would split a turn at the protected boundary" },
        ...Array.from({ length: 5 }, (_, i) => ({ startRef: `m002${i}0`, endRef: `m002${i}9`, count: 9, tokens: 900 })),
    ];
    const s = describeUncoveredRuns(runs);
    assert.ok(s.includes("m00120–m00125 (6 msgs, ~3K tok, \u26a0 not foldable"), s);
    assert.ok(s.includes("+2 more run(s)"), s); // 7 runs, 5 listed
    assert.ok(!s.includes("m00100–m00110 (9 msgs, ~5K tok)\u26a0"), "note-less runs render byte-stably");
});
