import assert from "node:assert/strict";
import test from "node:test";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";

// #5186 checklist item ④ (ranxianglei/billion-context#5780 body ④): applyRanges
// snapshots coverage ONCE before the range loop (kernel/src/compress.ts
// `const preExistingCoverage = collectCoverage(state);`) and hands that same Set
// to every applySingleRange, so in-batch ranges are judged with PRE-BATCH
// visibility. Probed against master @ be611a856 (2026-11-06) through the real
// applyCompression entry: NO observable divergence reproduces — every geometry
// below yields batch outcome == sequential outcome, including final topology.
// These tests pin that contract (a future kernel change that makes siblings
// diverge must be deliberate) plus one real wart: when the reasoning half folds
// FIRST, the stale set skips the nothing-new-to-fold demotion and the call half
// lands as a redundant ACTIVE block nested inside the first (T1).

const CORE = createCore();

function buildFixture() {
    const config = defaultConfig(1_000_000);
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const H: CoreMessage[] = [];
    let n = 0;
    const push = (m: Omit<CoreMessage, "id">): string => {
        n++;
        const id = `msg-${n}`;
        H.push({ id, ...m });
        return id;
    };
    let state = createInitialState();
    const refresh = () => {
        const t = CORE.processTurn({ messages: H, state, config, tokenCount: 20_000, renderTags: "text-only" });
        state = t.state;
        return state.messageRefs.byRaw;
    };
    push({ role: "user", contentType: "text", text: "start the job ".repeat(30) });
    push({ role: "assistant", contentType: "text", text: "on it ".repeat(120) });
    return { H, config, getState: () => state, setState: (s: typeof state) => { state = s; }, refresh, push };
}

/** Turn [reasoning, text, call, ...gapUsers×user..., result]. */
function pushGapTurn(fx: ReturnType<typeof buildFixture>, gapUsers: number) {
    const R = fx.push({ role: "assistant", contentType: "reasoning", text: `thinking ${"r ".repeat(400)}` });
    const A1 = fx.push({ role: "assistant", contentType: "text", text: `planning ${"a ".repeat(400)}` });
    const C = fx.push({ role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call-x", text: `{"cmd":"${"x ".repeat(300)}"}` });
    for (let i = 0; i < gapUsers; i++) fx.push({ role: "user", contentType: "text", text: `interleave ${i} ${"u ".repeat(80)}` });
    const Res = fx.push({ role: "tool", contentType: "tool-result", toolCallId: "call-x", text: `output ${"o ".repeat(400)}` });
    return { R, A1, C, Res };
}

type Block = { blockId: string; active: boolean; effectiveMessageIds: string[] };
type StateLike = { blocks: Block[] };

function describeBlocks(state: StateLike) {
    return state.blocks.map((b) => `${b.blockId}${b.active ? "" : "(off)"}=[${b.effectiveMessageIds.join(",")}]`).join(" ");
}

const HALF_SUMMARY_R = "REASONING-HALF SUMMARY ".repeat(30);
const HALF_SUMMARY_C = "CALL-HALF SUMMARY ".repeat(30);

test("#5186④ adjacent turn halves in ONE batch, reasoning half first — folds, but pins the nested-double-block wart", () => {
    const fx = buildFixture();
    const { R, A1, C, Res } = pushGapTurn(fx, 0);
    const refs = fx.refresh();
    const out = CORE.applyCompression({
        messages: fx.H, state: fx.getState(), config: fx.config,
        ranges: [
            { startRef: refs[R]!, endRef: refs[A1]!, summary: HALF_SUMMARY_R },
            { startRef: refs[C]!, endRef: refs[Res]!, summary: HALF_SUMMARY_C },
        ],
    });
    fx.setState(out.state);
    console.error(`[shape adjacent R-first] ${describeBlocks(out.state)}`);
    assert.equal(out.result.errors.length, 0, `no apply-level fatal: ${out.result.errors.join(" | ")}`);
    assertCovered(out.state, [R, A1, C, Res]);
    // Wart (stale pre-batch coverage): the call half should have been demoted to
    // nothing-new-to-fold, but lands as a second ACTIVE block nested in the first.
    const active = out.state.blocks.filter((b) => b.active);
    assert.equal(active.length, 2, "current master leaves two active blocks");
    const [outer, inner] = [...active].sort((a, b) => b.effectiveMessageIds.length - a.effectiveMessageIds.length);
    for (const id of inner.effectiveMessageIds) assert.ok(outer.effectiveMessageIds.includes(id), "inner block must nest in outer");
});

test("#5186④ adjacent turn halves in ONE batch, call half first — single merged block", () => {
    const fx = buildFixture();
    const { R, A1, C, Res } = pushGapTurn(fx, 0);
    const refs = fx.refresh();
    const out = CORE.applyCompression({
        messages: fx.H, state: fx.getState(), config: fx.config,
        ranges: [
            { startRef: refs[C]!, endRef: refs[Res]!, summary: HALF_SUMMARY_C },
            { startRef: refs[R]!, endRef: refs[A1]!, summary: HALF_SUMMARY_R },
        ],
    });
    fx.setState(out.state);
    console.error(`[shape adjacent C-first] ${describeBlocks(out.state)}`);
    assert.equal(out.result.errors.length, 0, `no apply-level fatal: ${out.result.errors.join(" | ")}`);
    assertCovered(out.state, [R, A1, C, Res]);
    const active = out.state.blocks.filter((b) => b.active);
    assert.equal(active.length, 1, "widening + nested rescan merges onto one block");
});

test("#5186④ gapped pair, reasoning half ALONE — widening pulls the whole turn (incl. interleaved users)", () => {
    const fx = buildFixture();
    const { R, A1, C, Res } = pushGapTurn(fx, 25);
    const refs = fx.refresh();
    const out = CORE.applyCompression({
        messages: fx.H, state: fx.getState(), config: fx.config,
        ranges: [{ startRef: refs[R]!, endRef: refs[A1]!, summary: HALF_SUMMARY_R }],
    });
    fx.setState(out.state);
    console.error(`[shape gap-alone] ${describeBlocks(out.state)} warnings=${JSON.stringify(out.result.warnings)}`);
    assert.equal(out.result.errors.length, 0, `half-range must not fatal on master: ${out.result.errors.join(" | ")}`);
    assertCovered(out.state, [R, A1, C, Res]);
    const active = out.state.blocks.filter((b) => b.active);
    assert.equal(active.length, 1);
    assert.deepEqual(active[0]!.effectiveMessageIds.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        ["msg-3", "msg-4", "msg-5", "msg-6", "msg-7", "msg-8", "msg-9", "msg-10", "msg-11", "msg-12", "msg-13", "msg-14", "msg-15", "msg-16", "msg-17", "msg-18", "msg-19", "msg-20", "msg-21", "msg-22", "msg-23", "msg-24", "msg-25", "msg-26", "msg-27", "msg-28", "msg-29", "msg-30", "msg-31"]);
});

test("#5186④ gapped pair SEQUENTIALLY: call half, then reasoning half — single merged block", () => {
    const fx = buildFixture();
    const { R, A1, C, Res } = pushGapTurn(fx, 25);
    const refs = fx.refresh();
    const first = CORE.applyCompression({
        messages: fx.H, state: fx.getState(), config: fx.config,
        ranges: [{ startRef: refs[C]!, endRef: refs[Res]!, summary: HALF_SUMMARY_C }],
    });
    fx.setState(first.state);
    assert.equal(first.result.errors.length, 0, `call half must fold alone: ${first.result.errors.join(" | ")}`);
    const second = CORE.applyCompression({
        messages: fx.H, state: fx.getState(), config: fx.config,
        ranges: [{ startRef: refs[R]!, endRef: refs[A1]!, summary: HALF_SUMMARY_R }],
    });
    fx.setState(second.state);
    console.error(`[shape gapped sequential] ${describeBlocks(second.state)}`);
    assert.equal(second.result.errors.length, 0, `reasoning half must fold after the pair is covered: ${second.result.errors.join(" | ")}`);
    const active = second.state.blocks.filter((b) => b.active);
    assert.equal(active.length, 1, "second fold merges onto the first");
    assertCovered(second.state, [R, A1, C, Res]);
});

test("#5186④ gapped pair in ONE batch — batch outcome must equal the sequential lane's (no atomic reject)", () => {
    const fx = buildFixture();
    const { R, A1, C, Res } = pushGapTurn(fx, 25);
    const refs = fx.refresh();
    const out = CORE.applyCompression({
        messages: fx.H, state: fx.getState(), config: fx.config,
        ranges: [
            { startRef: refs[C]!, endRef: refs[Res]!, summary: HALF_SUMMARY_C },
            { startRef: refs[R]!, endRef: refs[A1]!, summary: HALF_SUMMARY_R },
        ],
    });
    fx.setState(out.state);
    console.error(`[shape gapped batch] ${describeBlocks(out.state)}`);
    // The reported ④ asymmetry (batch rejects what sequential accepts) does NOT
    // reproduce on probed master: the reasoning half widens over the sibling
    // block and merges, exactly like the sequential lane. Pin the equivalence.
    assert.equal(out.result.errors.length, 0, `batch must not atomically reject: ${out.result.errors.join(" | ")}`);
    const active = out.state.blocks.filter((b) => b.active);
    assert.equal(active.length, 1, "same single-block topology as the sequential lane");
    assertCovered(out.state, [R, A1, C, Res]);
});

function assertCovered(state: StateLike, ids: string[]) {
    const covered = new Set<string>();
    for (const b of state.blocks) if (b.active) for (const id of b.effectiveMessageIds) covered.add(id);
    for (const id of ids) assert.ok(covered.has(id), `${id} must be covered by an active block`);
}
