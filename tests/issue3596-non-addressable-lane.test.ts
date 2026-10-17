import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

// #3596: a dsh sub-agent lane replays its whole PARENT history as ONE opaque
// user message. Its own compression state therefore carries ZERO mapped refs
// (the single blob never gains per-message granularity), yet the model cites
// the parent session's mNNNNN refs (rendered into the blob by the host). Every
// such ref is necessarily unknown here and NONE can ever resolve — the generic
// per-ref "unknown … run acp_status and retry" receipt loops forever on this
// structurally incompressible lane. applyRanges must instead return ONE clean
// conclusive verdict and forbid the retry, while the operator log keeps the
// full kernel text. Complements #3126 (empty in-memory view): here the view is
// non-empty but addressable-free.

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue3596-${randomUUID()}`,
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

/** The #3596 sub-agent shape: ONE giant opaque user message in the view, ZERO
 *  refs in the persisted state. Any mNNNNN the model cites is foreign. */
function makeNonAddressableCtx(logs?: string[]): Ctx {
    const session = makeSession();
    session.state.messageRefs = emptyRefMap();
    const blob = textMsg("raw_blob", "user", "PARENT-HISTORY-BLOB-".repeat(800));
    return { core: createCore(), config: defaultConfig(200000), messages: [blob], session, log: logs ? (m) => logs.push(m) : () => {} };
}

/** Control: a normal session WITH mapped refs (the complement of the above). */
function makeRefedCtx(): Ctx {
    const all = [
        textMsg("raw_1", "assistant", "a".repeat(5000)),
        textMsg("raw_2", "assistant", "b".repeat(5000)),
    ];
    const session = makeSession();
    const res = assignRefs(all, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: defaultConfig(200000), messages: all, session, log: () => {} };
}

function args(startId: string, endId: string) {
    return parseCompressInput(JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] })));
}

test("#3596: zero-ref lane gets a conclusive non-addressable verdict, not a per-ref unknown dump", () => {
    const logs: string[] = [];
    const ctx = makeNonAddressableCtx(logs);
    const out = applyRanges(args("m00970", "m00991"), ctx).text;

    assert.ok(out.startsWith("[Compression FAILED:"), `got: ${out.slice(0, 120)}`);
    assert.match(out, /ZERO addressable per-message refs/, "names the structural cause");
    assert.match(out, /opaque blob/, "identifies the host-serialized single-message shape");
    assert.match(out, /do NOT retry compress or call acp_status/, "forbids the futile retry loop");
    // The per-ref kernel dump that misleads the model must NOT leak into the receipt.
    assert.doesNotMatch(out, /every ref is unknown to this session/, "no per-ref unknown spam");
    assert.doesNotMatch(out, /\[cause: stale-ref/, "not mislabeled as stale-generation/typo");
    // The operator log keeps the full kernel error for diagnosis (two distinct
    // lines: the 0-ref state signature and the FAILED outcome).
    assert.ok(logs.some((l) => l.includes("state has 0 ref(s) mapped")), "operator log retains the 0-ref signature");
    assert.ok(logs.some((l) => l.includes("compress FAILED")), "operator log retains the FAILED outcome");
});

test("#3596: the loop breaker still arms on repeated non-addressable failures (tracking preserved)", () => {
    const ctx = makeNonAddressableCtx();
    const f1 = applyRanges(args("m00970", "m00991"), ctx).text;
    const f2 = applyRanges(args("m00993", "m01018"), ctx).text;
    const f3 = applyRanges(args("m01020", "m01044"), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:") && !f1.includes("CIRCUIT BREAKER"), "failure 1");
    assert.ok(f2.startsWith("[Compression FAILED:") && !f2.includes("CIRCUIT BREAKER"), "failure 2");
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "third consecutive failure arms the breaker");
    assert.match(f3, /do NOT retry compress/, "verdict stays even once the breaker paragraph is appended");
});

test("#3596: a refed session citing unknown refs does NOT get the non-addressable verdict (control)", () => {
    const ctx = makeRefedCtx();
    const out = applyRanges(args("m00970", "m00991"), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), `got: ${out.slice(0, 120)}`);
    assert.doesNotMatch(out, /ZERO addressable per-message refs/, "refed session keeps the generic stale-ref path");
    assert.match(out, /\[cause: stale-ref/, "still labeled stale-ref — the complement case is untouched");
});
