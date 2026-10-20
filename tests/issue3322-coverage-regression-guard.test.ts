import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetForTest as resetRegistryForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

afterEach(() => {
    resetRegistryForTest();
});

// #3322: a committed fold must never leave a previously-covered message
// WITHOUT ANY covering block. On full-resend hosts (dsh plugin lane compresses
// against the raw history, #2627) the kernel's turn-integrity gate once judged
// splits against the fold's OWN set instead of post-fold coverage: turns whose
// pieces sat in non-consumed sibling blocks were misread as split, their
// inherited ids withdrew wholesale, the consumed blocks deactivated — ~305
// messages lost ALL coverage, the processed view doubled (253→519), the local
// estimate blew past the model window and preflight fail-fasted forever while
// upstream had headroom. applyRanges now measures active-block coverage before
// vs after on the clone and refuses the commit when it shrank (state and prefix
// cache untouched). The kernel root fix lands separately (Kernel Boundary);
// this guard is the host-side backstop pinning the commit contract either way.

function makeCtx(prefix: string) {
    const core = createCore();
    const config = defaultConfig(200_000) as Config;
    config.compress.maxSummaryLength = 0;
    // Fold ANY message: the guard under test must not depend on where the
    // token-based recent-zone boundary falls inside this small fixture.
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    const session = getSession(`issue3322-${prefix}-${randomUUID()}`);
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
    const logs: string[] = [];
    const ctx = { core, config, messages: turn.messages, session, log: (msg: string) => { logs.push(msg); } };
    return { core, session, logs, ctx };
}

function coveredIds(state: { blocks: Array<{ active: boolean; effectiveMessageIds: string[] }> }): Set<string> {
    const out = new Set<string>();
    for (const b of state.blocks) {
        if (!b.active) continue;
        for (const id of b.effectiveMessageIds) out.add(id);
    }
    return out;
}

test("#3322 a fold that regresses coverage is refused BEFORE commit (state + cache untouched)", () => {
    const { core, session, logs, ctx } = makeCtx("guard");

    // Land a real fold first: b1 covers h_0/h_1.
    const first = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "First summary: messages 1-2 covered the initial phase in detail." }] }), ctx as never);
    assert.equal(first.outcome, "applied", `base fold must land: ${first.text}`);
    const source = session.state.blocks.find((b) => b.active);
    assert.ok(source, "the base fold materialized a block");
    assert.deepEqual([...coveredIds(session.state)].sort(), ["h_0", "h_1"]);

    // Simulate the incident on the NEXT fold: the kernel hands back a state in
    // which the consuming block deactivated while the NEW block lost every
    // inherited id (the pre-fix integrity gate's withdrawal shape). The guard
    // must catch ANY such regression regardless of producer.
    const realApply = core.applyCompression.bind(core);
    core.applyCompression = (args) => {
        const out = realApply(args);
        const beforeIds = new Set(session.state.blocks.map((b) => b.blockId));
        for (const b of out.state.blocks) {
            if (!beforeIds.has(b.blockId)) b.effectiveMessageIds = [];
        }
        return out;
    };

    const stateRefBefore = session.state;
    const blocksBefore = session.state.blocks.length;
    const distill = applyRanges(parseCompressInput({ content: [{ startId: source!.blockId, endId: source!.blockId, summary: "Distilled: the initial phase details merged into the running context." }] }), ctx as never);
    assert.equal(distill.outcome, "refused", `a coverage-regressing fold must be refused: ${distill.text}`);
    assert.equal(distill.reason, "gate:coverage-regression", `machine-readable reason: ${distill.reason}`);
    assert.equal(distill.blocksCreated, 0, "no block is reported as created");
    assert.match(distill.text, /Compression refused: coverage regression/, `refusal is explicit: ${distill.text}`);
    assert.match(distill.text, /Nothing was folded/, "the receipt states nothing was folded");
    assert.ok(!distill.text.includes("[Compressed "), `no fake success line: ${distill.text.slice(0, 120)}`);
    assert.equal(session.state.blocks.length, blocksBefore, "no new block materialized");
    assert.equal(session.state, stateRefBefore, "state object uncommitted — prefix cache left untouched");
    assert.deepEqual([...coveredIds(session.state)].sort(), ["h_0", "h_1"], "previously-folded messages stay covered");
    assert.ok(logs.some((line) => line.includes("compress REFUSED") && line.includes("coverage regression")), "the refusal reaches the server log copy");
});

test("#3322 legitimate nested consumption still applies (no false rejection)", () => {
    const { session, ctx } = makeCtx("healthy");

    const first = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "First summary: messages 1-2 covered the initial phase in detail." }] }), ctx as never);
    assert.equal(first.outcome, "applied", `base fold must land: ${first.text}`);

    // Production shape of the incident batch: a later distillation whose span
    // crosses the existing block's anchor consumes it — the new block INHERITS
    // the old coverage, so the guard must let it through.
    const second = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00006", summary: "Distilled span 1-6: initial phase plus the following exchange, details merged." }] }), ctx as never);
    assert.equal(second.outcome, "applied", `nested consumption must not be refused: ${second.text}`);
    assert.ok((second.blocksCreated ?? 0) >= 1, `a block landed: ${second.text}`);
    const covered = coveredIds(session.state);
    for (const id of ["h_0", "h_1", "h_2", "h_3", "h_4", "h_5"]) {
        assert.ok(covered.has(id), `${id} must stay covered after the nested fold`);
    }
});
