import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { METADATA_DRIFT_ESCALATED } from "../src/fold-reconcile.ts";

// #2360 §2: a FAILED compress receipt must carry ONE instruction. While the
// #2146 circuit breaker is armed, the kernel's per-error retry guidance
// ("Run acp_status, then call the compress tool again …") contradicted the
// breaker paragraph ("do not poll acp_status") in the SAME tool result — the
// observed loop was 3 blind re-issues with zero acp_status calls. The armed
// receipt scrubs the kernel guidance; the operator log keeps it. The cause
// label (§2.4) names who owns the failure: stale refs / covered-by-block /
// substrate destruction (host-native compaction landed outside bili's
// knowledge — this incident's root cause).

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue2360-${randomUUID()}`,
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

/** Refs assigned over five messages, but the VIEW carries only the first two:
 *  m00003–m00005 are mapped yet absent from the visible context and uncovered
 *  by any block — exactly the shape a host-native compaction landing outside
 *  bili's knowledge leaves behind (#1729/#2193/#2360). Every request against
 *  those refs fails with the kernel's "cannot be anchored" gate message. */
function makeDanglingCtx(logs?: string[]): Ctx {
    const all = [
        textMsg("raw_1", "assistant", "a".repeat(5000)),
        textMsg("raw_2", "assistant", "b".repeat(5000)),
        textMsg("raw_3", "assistant", "c".repeat(5000)),
        textMsg("raw_4", "assistant", "d".repeat(5000)),
        textMsg("raw_5", "assistant", "e".repeat(5000)),
    ];
    const session = makeSession();
    const res = assignRefs(all, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: defaultConfig(200000), messages: all.slice(0, 2), session, log: logs ? (m) => logs.push(m) : () => {} };
}

function args(startId: string, endId: string) {
    return parseCompressInput(JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] })));
}

test("#2360: non-armed cannot-anchor receipt keeps the kernel retry guidance + labels its cause", () => {
    const ctx = makeDanglingCtx();
    const out = applyRanges(args("m00003", "m00003"), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), `got: ${out.slice(0, 120)}`);
    assert.match(out, /cannot be anchored/);
    assert.match(out, /Do not retry this range in any form \u2014 run acp_status and target only the live refs it reports\./, "breaker not armed yet — guidance stays");
    assert.match(out, /\[cause: content-changed/, "unanchored failure without escalation labels content-changed");
});

test("#2360: armed breaker receipt carries ONE instruction — kernel acp_status guidance scrubbed", () => {
    const logs: string[] = [];
    const ctx = makeDanglingCtx(logs);

    const f1 = applyRanges(args("m00003", "m00003"), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:") && !f1.includes("CIRCUIT BREAKER"), "failure 1");
    const f2 = applyRanges(args("m00004", "m00004"), ctx).text;
    assert.ok(f2.startsWith("[Compression FAILED:") && !f2.includes("CIRCUIT BREAKER"), "failure 2");
    const f3 = applyRanges(args("m00005", "m00005"), ctx).text;

    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "third consecutive failure arms the breaker");
    assert.match(f3, /cannot be anchored/, "the reason itself stays in the receipt");
    assert.doesNotMatch(f3, /run acp_status and target only the live refs/, "the contradictory dead-ref retry guidance is scrubbed while armed");
    assert.match(f3, /do not poll acp_status/, "the breaker paragraph is the single authority");
    assert.match(f3, /\[cause: content-changed/, "cause label present while armed too");
    // The operator log keeps the full kernel text for diagnosis.
    assert.ok(logs.some((l) => l.includes("compress FAILED") && l.includes("run acp_status")), "operator log retains the unscrubbed kernel error");
});

test("#2360: escalated fold-drift sharpens the cause into substrate destruction", () => {
    const ctx = makeDanglingCtx();
    ctx.session.metadata[METADATA_DRIFT_ESCALATED] = true;
    const out = applyRanges(args("m00003", "m00003"), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"));
    assert.match(out, /cannot be anchored/);
    assert.match(out, /\[cause: substrate-destruction/, "escalated drift flags host-native compaction as the owner");
});

test("#2360: unknown-ref failures label stale-ref; covered ranges label covered-by-block", () => {
    const ctx = makeDanglingCtx();
    const stale = applyRanges(args("m00099", "m00100"), ctx).text;
    assert.ok(stale.startsWith("[Compression FAILED:"));
    assert.match(stale, /every ref is unknown to this session/);
    assert.match(stale, /\[cause: stale-ref/);

    // Full-view context: compress a big range successfully, then re-request it.
    const all = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    for (let i = 3; i <= 8; i++) all.push(textMsg(`raw_${i}`, "assistant", "x".repeat(5000)));
    const session = makeSession();
    const res = assignRefs(all, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    const fullCtx: Ctx = { core: createCore(), config: defaultConfig(200000), messages: all, session, log: () => {} };
    const ok = applyRanges(args("m00003", "m00008"), fullCtx).text;
    assert.ok(ok.startsWith("[Compressed "), `large range compresses (got: ${ok.slice(0, 120)})`);
    const again = applyRanges(args("m00003", "m00008"), fullCtx).text;
    assert.ok(again.startsWith("[Compression FAILED:"));
    assert.match(again, /covered by active block/);
    assert.match(again, /\[cause: covered-by-block/);
});
