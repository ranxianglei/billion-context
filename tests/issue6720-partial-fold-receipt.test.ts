import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { diagNudge } from "../src/server.ts";

// #6720: a PARTIAL tier-1 fold must not read as a clean "done" — the receipt
// names the unharvested remainder so the model sees there is more to fold
// instead of treating the partial fold as complete (the ratchet's model-side
// enabler). And the nudge inject log line must list the OFFERED ranges so
// "the model saw this list and didn't fold it all" is verifiable from the log
// (previously only pendingT1 was logged, never the list itself).

_setStoreForTest(new SessionStore({ enabled: false }));

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue6720-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

type Ctx = RewriteCtx & { session: Session; config: Config };

/** Ten ~5k-char messages with refs assigned; the session's nudge state carries
 *  a banked T1 fire (lastT1FirePending) so a small fold answers it as PARTIAL. */
function makePartialCtx(firePending: number): { ctx: Ctx; firstRef: string; lastRef: string } {
    const all = Array.from({ length: 10 }, (_, i) =>
        textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", `m${i} `.repeat(2000)),
    );
    const session = makeSession();
    const res = assignRefs(all, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    session.state.nudge.lastT1FirePending = firePending;
    const ctx: Ctx = { core: createCore(), config: defaultConfig(200000), messages: all, session, log: () => {} };
    return { ctx, firstRef: res.map.byRaw["raw_1"]!, lastRef: res.map.byRaw["raw_10"]! };
}

function args(startId: string, endId: string, summary = "s".repeat(200)) {
    return parseCompressInput(JSON.parse(JSON.stringify({ content: [{ startId, endId, summary }] })));
}

test("#6720: a partial tier-1 fold receipt names the unharvested remainder", () => {
    // Bank a T1 fire offering ~15k (the full pending); fold ONE ~6k-char
    // message into a tiny summary — a partial harvest far below the 50% stall
    // ratio, leaving the rest of the offer on the table.
    const { ctx, firstRef } = makePartialCtx(15_000);
    const out = applyRanges(args(firstRef, firstRef), ctx, { loopTracking: false }).text;
    assert.ok(out.startsWith("[Compressed "), `expected a success receipt, got: ${out.slice(0, 160)}`);
    assert.match(
        out,
        /tokens of the offered ranges remain unfolded/,
        `the receipt must name the unharvested remainder: ${out}`,
    );
    assert.match(out, /include them in your next compress call/, "the receipt must instruct the model to fold the rest");
});

test("#6720: a compliant full fold receipt carries no remainder note", () => {
    // Bank a T1 fire offering ~15k; fold the WHOLE range into a small summary
    // — an eager harvest well above the 50% stall ratio, so no remainder is
    // reported.
    const { ctx, firstRef, lastRef } = makePartialCtx(15_000);
    const out = applyRanges(args(firstRef, lastRef), ctx, { loopTracking: false }).text;
    assert.ok(out.startsWith("[Compressed "), `expected a success receipt, got: ${out.slice(0, 160)}`);
    assert.doesNotMatch(out, /tokens of the offered ranges remain unfolded/, "a full fold reads as done");
});

test("#6720: the nudge inject log line lists the offered ranges", () => {
    // The offered range list itself must reach the log — "the model saw this
    // list and didn't fold it all" was previously unverifiable (only pendingT1
    // was logged). Capped at 4 ranges with a "+N more" tail.
    const turn = {
        nudge: {
            shouldInject: true,
            reason: "T1 effective 50000 >= 50000, growth 10000, usage 24%",
            contextUsage: 0.24,
            tier: 1,
            breakdown: { growth: 10000, growthFloor: 50000, nudgeGrowthTokens: 50000, pendingT1: 50000, growthReference: 400000 },
            compressibleRanges: [
                { startRef: "m00001", endRef: "m00010", tokens: 12000 },
                { startRef: "m00011", endRef: "m00020", tokens: 9000 },
                { startRef: "m00021", endRef: "m00030", tokens: 7000 },
                { startRef: "m00031", endRef: "m00040", tokens: 6000 },
                { startRef: "m00041", endRef: "m00050", tokens: 5000 },
                { startRef: "m00051", endRef: "m00060", tokens: 4000 },
            ],
        },
    };
    const line = diagNudge(turn, "sess-1", 100000, 1000000, "deepseek-v4.1-flash", true);
    assert.match(line, /ranges=\[/, `the log line must carry the range list: ${line}`);
    assert.match(line, /m00001–m00010\(12000\)/, "first range listed");
    assert.match(line, /m00031–m00040\(6000\)/, "fourth range listed (cap)");
    assert.match(line, /\+2 more/, "the tail beyond the cap is counted");
    assert.doesNotMatch(line, /m00041–m00050/, "ranges beyond the cap are not spelled out");
});

test("#6720: the nudge log line omits the range list when none are offered", () => {
    const turn = {
        nudge: {
            shouldInject: true,
            reason: "T2 distill ready",
            contextUsage: 0.5,
            tier: 2,
            breakdown: { pendingT1: 0 },
            compressibleRanges: [],
        },
    };
    const line = diagNudge(turn, "sess-2", 50000, 100000, "deepseek-v4.1-flash", true);
    assert.doesNotMatch(line, /ranges=\[/, "no range list when nothing is offered");
});
