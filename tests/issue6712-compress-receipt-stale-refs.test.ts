import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue6712-${randomUUID()}`,
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

function makeCtx(messages: CoreMessage[], config?: Config, logs?: string[]): RewriteCtx & { session: Session; config: Config } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: config ?? defaultConfig(200000), messages, session, log: logs ? (m) => logs.push(m) : () => {} };
}

function compressArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

function compressArgsMulti(specs: Array<[string, string]>) {
    return JSON.parse(JSON.stringify({ content: specs.map(([startId, endId]) => ({ startId, endId, summary: SUMMARY })) }));
}

// Two sub-gate small messages + six big ones: eight refs, frontier m00008.
function fixtureMessages(): CoreMessage[] {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    for (let i = 3; i <= 8; i++) msgs.push(textMsg(`raw_${i}`, "assistant", "x".repeat(5000)));
    return msgs;
}

test("#6712: all-refs-above-frontier receipt keeps the requested ref numbers", () => {
    const ctx = makeCtx(fixtureMessages());
    const out = applyRanges(parseCompressInput(compressArgs("m00010", "m00014")), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), `unknown refs fail (got: ${out.slice(0, 120)})`);
    assert.match(out, /above this session's highest ref \(m00008\)/, "frontier diagnosis present");
    // The #2146 invariant still holds: no bare phantom ref token reaches the
    // client-persisted receipt, so the echo channel stays dead.
    assert.doesNotMatch(out, /m00010|m00014/, "phantom endpoints are NOT echoed back as bare refs");
    // ...but the caller can still tell WHICH refs it used: the scrub marker
    // carries the ref number, so the range line stays diagnosable.
    assert.match(out, /\[stale-ref:00010\]/, "start ref number preserved in the scrub marker");
    assert.match(out, /\[stale-ref:00014\]/, "end ref number preserved in the scrub marker");
    assert.match(out, /range \[stale-ref:00010\]..\[stale-ref:00014\]/, "range diagnostic line names the requested numbers");
});

test("#6712: every range in a multi-range request keeps its numbers", () => {
    const ctx = makeCtx(fixtureMessages());
    const out = applyRanges(parseCompressInput(compressArgsMulti([["m00010", "m00011"], ["m00012", "m00014"]])), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), `unknown refs fail (got: ${out.slice(0, 120)})`);
    assert.doesNotMatch(out, /m00010|m00011|m00012|m00014/, "no bare phantom ref token anywhere");
    for (const n of ["00010", "00011", "00012", "00014"]) {
        assert.match(out, new RegExp(`\\[stale-ref:${n}\\]`), `ref number ${n} preserved`);
    }
});
