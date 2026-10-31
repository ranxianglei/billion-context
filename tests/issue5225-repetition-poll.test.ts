// #5225: the repetition guard escalated on consecutive-identical COUNT alone, so
// legitimate bounded long polling (identical args BY DESIGN while each call waits
// out its documented interval observing external state — e.g. an MCP wait tool)
// got its 5th poll blocked and the whole turn aborted. The fix keys escalation
// on RAPIDITY: a prior identical call that actually executed for >= 5s restarts
// the run. Rapid degenerate loops still escalate, now staged (#5225): warn@3,
// ONE live refusal at 5 (turn stays alive so a mid-poll model can switch to a
// longer wait), kill only on the identical repeat after that refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireToolGuardrails, RepetitionTracker } from "../src/agent/tool-guardrails.ts";
import type { ExtensionAPI } from "../src/agent/pi.ts";

function withFakeClock(fn: (tick: (ms: number) => void) => void): void {
    let t = 1_000_000;
    const realNow = Date.now;
    Date.now = () => t;
    try {
        fn((ms) => {
            t += ms;
        });
    } finally {
        Date.now = realNow;
    }
}

function makePollHarness() {
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    const pi = {
        on: (name: string, fn: (...a: never[]) => unknown) => {
            handlers[name] = fn as (...a: unknown[]) => unknown;
        },
    } as unknown as ExtensionAPI;
    const ctx = {
        ui: { notify: () => {} },
        abortCalls: 0,
        sessionManager: { getSessionId: () => "sess-poll" },
        abort: () => {
            ctx.abortCalls += 1;
        },
    };
    wireToolGuardrails(pi);
    return {
        call: (id: string, input: Record<string, unknown>) =>
            handlers["tool_call"]!({ type: "tool_call", toolName: "mcp__kernel_debug__kd_wait", toolCallId: id, input }, ctx),
        result: (id: string) =>
            handlers["tool_result"]!(
                { toolName: "mcp__kernel_debug__kd_wait", toolCallId: id, content: [{ type: "text", text: "still running" }], isError: false },
                ctx,
            ),
        input: (source: string) => handlers["input"]!({ source }, ctx),
        ctx,
    };
}

test("#5225: five 10s-spaced identical polls never escalate (no block, no abort)", () => {
    const w = makePollHarness();
    withFakeClock((tick) => {
        for (let i = 1; i <= 5; i++) {
            tick(1000); // model emits the next poll shortly after the previous result
            assert.equal(w.call(`p${i}`, { seconds: 10 }), undefined, `poll ${i} must not be blocked`);
            tick(10_000); // the poll executed its documented ~10s interval
            w.result(`p${i}`);
        }
    });
    assert.equal(w.ctx.abortCalls, 0, "turn must NOT be aborted during legitimate long polling");
});

test("#5225: rapid identical loop escalates staged — refusal at 5, kill only on the repeat after it", () => {
    const w = makePollHarness();
    let fifth: unknown;
    let sixth: unknown;
    let abortAfterFifth = -1;
    withFakeClock((tick) => {
        for (let i = 1; i <= 5; i++) {
            tick(50); // machine-fast repeats: each prior call completed in ~50ms
            fifth = w.call(`q${i}`, { seconds: 10 });
            tick(50);
            w.result(`q${i}`);
        }
        abortAfterFifth = w.ctx.abortCalls;
        sixth = w.call("q6", { seconds: 10 });
    });
    assert.equal((fifth as { block?: boolean })?.block, true, "5th rapid identical call is refused (not executed)");
    assert.match((fifth as { reason?: string })?.reason ?? "", /REFUSED/);
    assert.match((fifth as { reason?: string })?.reason ?? "", /FINAL WARNING/);
    assert.equal(abortAfterFifth, 0, "the refusal must NOT kill the turn — one live chance to change approach");
    assert.equal((sixth as { block?: boolean })?.block, true, "the identical repeat after the refusal is blocked");
    assert.match((sixth as { reason?: string })?.reason ?? "", /BLOCKED/);
    assert.equal(w.ctx.abortCalls, 1, "turn aborted exactly once, at the repeat after the final refusal");
});

test("#5225: rapid loop escapes the final refusal via ONE longer wait (staging composes with polling advice)", () => {
    const w = makePollHarness();
    withFakeClock((tick) => {
        for (let i = 1; i <= 5; i++) {
            tick(50);
            w.call(`e${i}`, { seconds: 10 });
            tick(50);
            w.result(`e${i}`);
        }
        const longer = w.call("e6", { seconds: 60 });
        assert.equal(longer, undefined, "changed arguments reset the run and execute");
        tick(60_000);
        w.result("e6");
        assert.equal(w.call("e7", { seconds: 10 }), undefined, "back to the old args restarts the count at 1");
    });
    assert.equal(w.ctx.abortCalls, 0, "a model that heeds the refusal never reaches the kill");
});

test("#5225: warning text no longer claims byte-for-byte identity or a guaranteed stale result", () => {
    const w = makePollHarness();
    let warned: unknown;
    withFakeClock((tick) => {
        for (let i = 1; i <= 3; i++) {
            tick(50);
            w.call(`v${i}`, { seconds: 10 });
            tick(50);
            warned = w.result(`v${i}`);
        }
    });
    const ret = warned as { content?: Array<{ type: string; text?: string }> };
    const t = ret.content?.[0]?.text ?? "";
    assert.match(t, /CONSECUTIVE identical/, "warn notice must still fire at count 3");
    assert.doesNotMatch(t, /byte-for-byte/, "canonical fingerprint is key-order-insensitive — old wording was false");
    assert.match(t, /key order aside/, "wording must describe the actual matching rule");
    assert.doesNotMatch(t, /will not produce a new result/, "false absolute for state-observing tools");
});

test("#5225: user input still resets a polling run (cancellation path preserved)", () => {
    const w = makePollHarness();
    withFakeClock((tick) => {
        tick(1000);
        w.call("w1", { seconds: 10 });
        tick(10_000);
        w.result("w1");
    });
    w.input("interactive");
    withFakeClock((tick) => {
        tick(1000);
        w.call("w2", { seconds: 10 });
        tick(10_000);
        w.result("w2");
        tick(1000);
        w.call("w3", { seconds: 10 });
        tick(10_000);
        w.result("w3");
    });
    assert.equal(w.ctx.abortCalls, 0, "reset + continued slow polling must stay clean");
});

// --- unit level: RepetitionTracker timing semantics (explicit clocks) ---

const T0 = 1_000_000;

test("RepetitionTracker: a prior identical call that ran >= 5s restarts the run (#5225)", () => {
    const t = new RepetitionTracker({ warn: 3, abort: 5 });
    assert.equal(t.note("wait", { seconds: 10 }, "a1", T0).action, "none");
    t.complete("a1", T0 + 10_000);
    assert.equal(t.note("wait", { seconds: 10 }, "a2", T0 + 11_000).count, 1, "slow prior call restarts the run");
    t.complete("a2", T0 + 21_000);
    assert.equal(t.note("wait", { seconds: 10 }, "a3", T0 + 22_000).count, 1);
    assert.equal(t.note("wait", { seconds: 10 }, "a4", T0 + 23_000).action, "none", "polling must never reach warn/abort");
});

test("RepetitionTracker: fast identical calls escalate staged — final-refuse at 5, abort at 6 (fail-safe unchanged)", () => {
    const t = new RepetitionTracker({ warn: 3, abort: 5 });
    let d = { action: "none" as string, count: 0 };
    for (let i = 1; i <= 5; i++) {
        d = t.note("w", {}, `f${i}`, T0 + i * 100);
        t.complete(`f${i}`, T0 + i * 100 + 900); // 900ms < 5000 threshold
    }
    assert.equal(d.action, "final-refuse", "the 5th is the single live refusal");
    assert.equal(d.count, 5);
    const d6 = t.note("w", {}, "f6", T0 + 6 * 100);
    assert.equal(d6.action, "abort", "only the repeat after the refusal aborts");
    assert.equal(d6.count, 6);
});

test("RepetitionTracker: duration evidence without any complete() leaves count-only behavior standing", () => {
    const t = new RepetitionTracker({ warn: 3, abort: 5 });
    for (let i = 1; i <= 4; i++) {
        t.note("w", {}, `n${i}`, T0 + i * 10);
    }
    assert.equal(t.note("w", {}, "n5", T0 + 50).action, "final-refuse", "missing results -> ladder still staged");
    assert.equal(t.note("w", {}, "n6", T0 + 60).action, "abort", "missing results -> legacy count-only escalation");
});

test("RepetitionTracker: exactly-at-threshold duration counts as slow (>= boundary)", () => {
    const t = new RepetitionTracker({ warn: 3, abort: 5 });
    t.note("w", {}, "g1", T0);
    t.complete("g1", T0 + 5000);
    assert.equal(t.note("w", {}, "g2", T0 + 6000).count, 1, "boundary: >= 5000ms resets");
});

test("RepetitionTracker: a 4999ms prior call does NOT reset (just under threshold)", () => {
    const t = new RepetitionTracker({ warn: 3, abort: 5 });
    for (let i = 1; i <= 3; i++) {
        const id = `s${i}`;
        t.note("w", {}, id, T0 + i * 100);
        t.complete(id, T0 + i * 100 + 4999);
    }
    assert.equal(t.note("w", {}, "s4", T0 + 4000).action, "warn", "sub-threshold durations keep escalating");
});

test("RepetitionTracker: duration evidence for a different fingerprint never resets the run", () => {
    const t = new RepetitionTracker({ warn: 3, abort: 5 });
    t.note("w", {}, "h1", T0);
    t.complete("h1", T0 + 100);
    t.note("other", { x: 1 }, "h2", T0 + 200);
    t.complete("h2", T0 + 12_000); // slow, but different fp
    assert.equal(t.note("w", {}, "h3", T0 + 13_000).count, 1, "different-fp interruption restarts the fp run anyway");
    assert.equal(t.note("w", {}, "h4", T0 + 14_000).count, 2, "stale other-fp duration must not leak into this run");
    assert.equal(t.note("w", {}, "h5", T0 + 15_000).action, "warn", "counts keep accumulating on rapid repeats");
});

test("RepetitionTracker.reset() clears pending timing and completed evidence", () => {
    const t = new RepetitionTracker({ warn: 3, abort: 5 });
    t.note("w", {}, "r1", T0);
    t.complete("r1", T0 + 10_000);
    t.reset();
    t.note("w", {}, "r2", T0 + 20_000);
    t.complete("r2", T0 + 20_100);
    assert.equal(t.note("w", {}, "r3", T0 + 21_000).count, 2, "post-reset run counts normally (fast evidence honored)");
});
