import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { absorbEnabled, applyAbsorbConfig, executeAbsorb, type AbsorbCtx } from "../src/absorb.js";
import type { Session } from "../src/session.js";

function baseMessages(): CoreMessage[] {
    return [
        { id: "m1", role: "user", contentType: "text", text: "run the build" },
        { id: "m2", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: "{}" },
        { id: "m3", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "call_1", text: "build ok: 512 tests pass" },
        { id: "m4", role: "assistant", contentType: "text", text: "done" },
    ];
}

function makeCtx(absorb: Config["absorb"]): { ctx: AbsorbCtx; session: Session } {
    const core = createCore();
    const config: Config = { ...defaultConfig(), absorb };
    const turn = core.processTurn({ messages: baseMessages(), state: createInitialState(), config, tokenCount: 0 });
    const session = { state: turn.state } as unknown as Session;
    const ctx: AbsorbCtx = { core, config, messages: turn.messages, session, log: () => {} };
    return { ctx, session };
}

test("absorbEnabled: boolean shorthand and object forms", () => {
    assert.equal(absorbEnabled({}), false);
    assert.equal(absorbEnabled({ absorb: true }), true);
    assert.equal(absorbEnabled({ absorb: false }), false);
    assert.equal(absorbEnabled({ absorb: { enabled: true } }), true);
    assert.equal(absorbEnabled({ absorb: { enabled: false } }), false);
    assert.equal(absorbEnabled({ absorb: { minToolTokens: 500 } }), true);
});

test("applyAbsorbConfig: disabled keeps base; settings map with percent parsing", () => {
    const base: Config = { ...defaultConfig() };
    assert.equal(applyAbsorbConfig(base, {}), base, "disabled keeps the base config untouched");
    const on = applyAbsorbConfig(base, { absorb: { minToolTokens: 500, contextThresholdPct: "20%" } });
    assert.deepEqual(on.absorb, { enabled: true, toolName: "absorb", minToolTokens: 500, contextThresholdPct: 0.2, excludeTools: [] });
    const defaults = applyAbsorbConfig(base, { absorb: true });
    assert.deepEqual(defaults.absorb, { enabled: true, toolName: "absorb", minToolTokens: 1000, contextThresholdPct: 0, excludeTools: [] });
});

test("executeAbsorb: disabled session fails fast without touching state", () => {
    const { ctx, session } = makeCtx(undefined);
    const before = session.state;
    const out = executeAbsorb({ ref: "m00003", summary: "build passed" }, ctx);
    assert.match(out, /\[absorb FAILED: absorb is not enabled/);
    assert.equal(session.state, before);
});

test("executeAbsorb: missing summary returns usage guidance", () => {
    const { ctx } = makeCtx({ enabled: true, toolName: "absorb", minToolTokens: 1, contextThresholdPct: 0, excludeTools: [] });
    const out = executeAbsorb({ ref: "m00003" }, ctx);
    assert.match(out, /\[absorb FAILED: provide ref/);
});

test("executeAbsorb: success records the pair, hides the original, carries the summary verbatim", () => {
    const { ctx, session } = makeCtx({ enabled: true, toolName: "absorb", minToolTokens: 1, contextThresholdPct: 0, excludeTools: [] });
    const out = executeAbsorb({ ref: "m00003", summary: "build passed" }, ctx, "toolu_abs_1");
    assert.match(out, /absorbed m00003/);
    assert.match(out, /<absorbed-summary>\nbuild passed\n<\/absorbed-summary>/);
    assert.equal(session.state.absorbed?.length, 1);
    assert.equal(session.state.absorbed?.[0]?.toolCallId, "call_1");
    assert.equal(session.state.absorbed?.[0]?.absorbCallId, "toolu_abs_1");

    const turn2 = ctx.core.processTurn({ messages: ctx.messages, state: session.state, config: ctx.config, tokenCount: 0 });
    assert.equal(
        turn2.messages.some((m) => m.contentType === "tool-result" && m.toolCallId === "call_1"),
        false,
        "absorbed tool-result must be hidden on the next turn",
    );

    const again = executeAbsorb({ ref: "m00003", summary: "dup" }, ctx, "toolu_abs_2");
    assert.match(again, /already absorbed/);
});

test("executeAbsorb: unknown ref fails with a scoped error", () => {
    const { ctx } = makeCtx({ enabled: true, toolName: "absorb", minToolTokens: 1, contextThresholdPct: 0, excludeTools: [] });
    const out = executeAbsorb({ ref: "m00999", summary: "x" }, ctx);
    assert.match(out, /\[absorb FAILED: .*does not exist/);
});
