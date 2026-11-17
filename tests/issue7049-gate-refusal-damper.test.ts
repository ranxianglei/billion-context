import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { applyRanges, compressBreakerArmed, gateRefusalDamperArmed } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { getSession } from "../src/session.ts";

// #7049: the no-net-shrink and coverage-regression gate refusals are
// deliberately NOT fed into the #2146 circuit breaker (#847). But the nudge
// keeps re-inviting the model to compress, and the model re-issues the same
// refused call — a loop the #2146 breaker never sees. This damper tracks
// consecutive gate refusals per session; at 3 with no commit in between, it
// suppresses nudge injection until a commit lands or 10 min elapse. The model
// can still call compress (user-driven or spontaneous); the nudge just stops
// re-inviting it.

function makeCtx() {
    const core = createCore();
    const config = defaultConfig(200000) as Config;
    const session = getSession(`issue7049-${Math.random().toString(36).slice(2)}`);
    return { core, config, session };
}

// Land the base fold (m00001–m00002 → one active block) and hand back the
// live ctx. The view is left INTACT — tests that refold by ref then
// decompress + clear it themselves (compressARange).
function foldFirstRange() {
    const { core, config, session } = makeCtx();
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${String(i + 1).padStart(5, "0")}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(3000)}`,
        });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx: { core: typeof core; config: Config; messages: typeof turn.messages; session: typeof session; log: () => void; compressMessages?: CoreMessage[] } = { core, config, messages: turn.messages, session, log: () => {} };
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "First summary: messages 1-2 covered the initial phase in detail." }] }), ctx as never).text;
    assert.match(out, /Compressed m00001–m00002 → 1 block\(s\)/, `compress must succeed: ${out}`);
    const block = [...session.state.blocks].slice(-1)[0]!;
    return { ctx, core, config, session, msgs, block };
}

function compressARange() {
    const r = foldFirstRange();
    resolveDecompress({ blockId: r.block.blockId }, r.ctx as never);
    r.ctx.messages = [];
    r.ctx.compressMessages = [];
    return r;
}

// A refold summary deliberately longer than the existing one → net delta < 0
// → the no-net-shrink gate refuses the fold.
const GROW_SUMMARY = "Refolded summary that is deliberately much longer than the one it replaces so the net context change goes negative and the gate refuses the fold outright.";

test("#7049: gate-refusal damper arms after 3 consecutive no-net-shrink refusals; #2146 breaker stays disarmed", () => {
    const { ctx, session, block } = compressARange();
    resolveDecompress({ blockId: block.blockId }, ctx as never);
    ctx.messages = [];
    ctx.compressMessages = [];

    assert.equal(gateRefusalDamperArmed(session), false, "damper starts disarmed");
    assert.equal(compressBreakerArmed(session), false, "#2146 breaker starts disarmed");

    // Refusal 1: no-net-shrink.
    const r1 = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: GROW_SUMMARY }] }), ctx as never);
    assert.equal(r1.outcome, "refused", `refusal 1: ${r1.text}`);
    assert.equal(r1.reason, "gate:no-net-shrink");
    assert.equal(gateRefusalDamperArmed(session), false, "damper not yet armed after 1 refusal");
    assert.equal(compressBreakerArmed(session), false, "#2146 breaker not armed (deliberately excluded, #847)");
    assert.ok(!r1.text.includes("CIRCUIT BREAKER"), "receipt carries no breaker paragraph");

    // Refusal 2: no-net-shrink.
    const r2 = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: GROW_SUMMARY }] }), ctx as never);
    assert.equal(r2.outcome, "refused", `refusal 2: ${r2.text}`);
    assert.equal(gateRefusalDamperArmed(session), false, "damper not yet armed after 2 refusals");
    assert.equal(compressBreakerArmed(session), false, "#2146 breaker still not armed");

    // Refusal 3: no-net-shrink → damper arms.
    const r3 = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: GROW_SUMMARY }] }), ctx as never);
    assert.equal(r3.outcome, "refused", `refusal 3: ${r3.text}`);
    assert.equal(r3.reason, "gate:no-net-shrink");
    assert.equal(gateRefusalDamperArmed(session), true, "damper arms after 3 consecutive gate refusals");
    assert.equal(compressBreakerArmed(session), false, "#2146 breaker still not armed (damper is a separate mechanism)");
    assert.ok(!r3.text.includes("CIRCUIT BREAKER"), "receipt carries no breaker paragraph (per #847 intent)");

    // Refusal 4: damper stays armed, count continues.
    const r4 = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: GROW_SUMMARY }] }), ctx as never);
    assert.equal(r4.outcome, "refused");
    assert.equal(gateRefusalDamperArmed(session), true, "damper stays armed");
});

test("#7049: a successful commit clears the gate-refusal damper", () => {
    const { ctx, session, block } = compressARange();
    resolveDecompress({ blockId: block.blockId }, ctx as never);
    ctx.messages = [];
    ctx.compressMessages = [];

    // Arm the damper with 3 consecutive no-net-shrink refusals.
    for (let i = 0; i < 3; i++) {
        const r = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: GROW_SUMMARY }] }), ctx as never);
        assert.equal(r.outcome, "refused", `refusal ${i + 1}`);
    }
    assert.equal(gateRefusalDamperArmed(session), true, "damper armed");

    // A successful refold (shorter than the existing summary in tokens, but
    // above the 50-char minimum) clears the damper.
    const ok = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "Initial phase and setup are completed, config is done." }] }), ctx as never);
    assert.ok(ok.text.startsWith("[Compressed "), `refold must land: ${ok.text}`);
    assert.equal(gateRefusalDamperArmed(session), false, "damper cleared on successful commit");
});

test("#7049: preflight backstop folds (loopTracking:false) do not feed the damper", () => {
    const { ctx, session } = compressARange();
    for (let i = 0; i < 3; i++) {
        const r = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: GROW_SUMMARY }] }), ctx as never, { loopTracking: false });
        assert.equal(r.outcome, "refused", `refusal ${i + 1}: ${r.text}`);
        assert.equal(r.reason, "gate:no-net-shrink");
    }
    assert.equal(gateRefusalDamperArmed(session), false, "internal folds never arm the model-loop damper");
    assert.equal(compressBreakerArmed(session), false, "#2146 breaker also not armed");
});

test("#7049: gate-refusal damper decays after 10 min quiet", () => {
    const { ctx, session } = compressARange();
    // Simulate a stale streak (11 min old) → reads as disarmed.
    session.metadata["compressGateRefusalStreak"] = { n: 5, lastAt: Date.now() - 11 * 60 * 1000 };
    assert.equal(gateRefusalDamperArmed(session), false, "stale streak (11 min) reads as disarmed");

    // A fresh streak (1 min old) → reads as armed.
    session.metadata["compressGateRefusalStreak"] = { n: 5, lastAt: Date.now() - 1 * 60 * 1000 };
    assert.equal(gateRefusalDamperArmed(session), true, "fresh streak (1 min) reads as armed");
});

test("#7049: coverage-regression refusals also feed the damper (real gate path)", () => {
    const { ctx, core, session, block } = foldFirstRange();

    // The real #3322 incident shape (same fixture as
    // tests/issue3322-coverage-regression-guard.test.ts): the kernel hands
    // back a state in which the NEW block lost every inherited id → the
    // coverage guard refuses the commit. Driving it through applyRanges pins
    // the noteGateRefusal feed line on the coverage-regression path.
    const realApply = core.applyCompression.bind(core);
    core.applyCompression = (args) => {
        const out = realApply(args);
        const beforeIds = new Set(session.state.blocks.map((b) => b.blockId));
        for (const b of out.state.blocks) {
            if (!beforeIds.has(b.blockId)) b.effectiveMessageIds = [];
        }
        return out;
    };

    assert.equal(gateRefusalDamperArmed(session), false, "damper starts disarmed");
    for (let i = 1; i <= 3; i++) {
        const r = applyRanges(parseCompressInput({ content: [{ startId: block.blockId, endId: block.blockId, summary: "Distilled: the initial phase details merged into the running context." }] }), ctx as never);
        assert.equal(r.outcome, "refused", `refusal ${i}: ${r.text}`);
        assert.equal(r.reason, "gate:coverage-regression", `refusal ${i} reason: ${r.reason}`);
    }
    assert.equal(gateRefusalDamperArmed(session), true, "damper arms after 3 consecutive coverage-regression refusals");
    assert.equal(compressBreakerArmed(session), false, "#2146 breaker not armed");
});
