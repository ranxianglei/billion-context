// #4038: a model switch mid-conversation (same session id, out-of-band history
// rewrite) leaves the fold ledger resident but fully INACTIVE — every pre-switch
// block is deactivated while nothing rebases or archives the state. Remembered
// bN refs still resolve to those zombie blocks, so every compress fails with
// "already compressed" next to "0 active block(s)" — a self-contradicting
// verdict the model retries forever. The failure classifier had no branch for
// the shape (cause ""), so the circuit breaker armed with the loop-noise
// paragraph that FORBIDS polling acp_status — the one recovery step. Now:
// zero-active + already-compressed routes into the substrate-destruction family
// (single-recovery-step wording in the breaker, FOLD SUBSTRATE INVALID on
// acp_status), and the refs snapshot names the dead ledger so remembered bN ids
// stop being treated as live. Gate discipline (#3617): both directions asserted —
// fires when it should, and NOT when an active block exists.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, compressLastFailureCause, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { handleAcpStatus } from "../src/acp-status.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue4038-${randomUUID()}`,
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

function makeCtx(messages: CoreMessage[], config?: Config): Ctx {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: config ?? defaultConfig(200000), messages, session, log: () => {} };
}

function compressArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

// All-assistant 5000-char messages follow the #2146 fixture precedent
// (guaranteed-compressible; no user message to anchor the protected zone).
function genMsgs(prefix: string, n: number): CoreMessage[] {
    return Array.from({ length: n }, (_, i) => textMsg(`${prefix}_${i + 1}`, "assistant", "x".repeat(5000)));
}

/** Build the #4038 shape: two real folds over an old generation, then a model
 *  switch — the client re-sends a rewritten history whose refs continue the
 *  RETAINED map (the reporter's m00002–m09631 span), and every pre-switch block
 *  deactivates because its covered ids are gone from the view. Twelve old
 *  messages give the fold targets (m00001–m00008) enough distance from the tail
 *  to escape the protected zone (last-3 + the 5000-token recent walk). */
function staleLedgerCtx(): Ctx {
    const oldGen = genMsgs("old", 12); // m00001–m00012
    const fresh = genMsgs("new", 6);   // m00013–m00018
    const ctx = makeCtx(oldGen.concat(fresh));
    ctx.messages = oldGen;
    const r1 = applyRanges(parseCompressInput(compressArgs("m00001", "m00004")), ctx);
    const r2 = applyRanges(parseCompressInput(compressArgs("m00005", "m00008")), ctx);
    assert.ok(!r1.text.startsWith("[Compression FAILED:"), `first fold must succeed: ${r1.text.slice(0, 200)}`);
    assert.ok(!r2.text.startsWith("[Compression FAILED:"), `second fold must succeed: ${r2.text.slice(0, 200)}`);
    assert.equal(ctx.session.state.blocks.length, 2, "two resident blocks before the switch");
    // Generation switch: the view becomes the rewritten history; covered ids are
    // gone, so syncBlocks' effect lands — every block deactivates. Refs stay
    // retained (the stale span).
    ctx.messages = fresh;
    for (const b of ctx.session.state.blocks) b.active = false;
    return ctx;
}

test("#4038: stale-ledger failure is attributed substrate-destruction, not left uncaused", () => {
    const ctx = staleLedgerCtx();
    const f1 = applyRanges(parseCompressInput(compressArgs("b1", "b2")), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:"), `expected failure (got: ${f1.slice(0, 120)})`);
    assert.match(f1, /Requested range\(s\) already compressed \(e\.g\. b1\.\.b2\)/, "kernel verdict reproduced");
    assert.match(f1, /\[cause: substrate-destruction — remembered block refs/, "stale-ledger shape attributed as substrate-destruction");
    assert.match(f1, /resident block\(s\) are inactive/, "refs snapshot names the dead ledger");
    assert.match(f1, /0 active block\(s\)/, "base snapshot fact unchanged");
    assert.ok(!f1.includes("CIRCUIT BREAKER"), "one failure does not arm");
    assert.ok(compressLastFailureCause(ctx.session)?.startsWith("substrate-destruction"), "cause readable at n=1");
});

test("#4038: the armed breaker offers the single recovery step instead of forbidding acp_status", () => {
    const ctx = staleLedgerCtx();
    applyRanges(parseCompressInput(compressArgs("b1", "b1")), ctx);
    applyRanges(parseCompressInput(compressArgs("b2", "b2")), ctx);
    const f3 = applyRanges(parseCompressInput(compressArgs("b1", "b2")), ctx).text;
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "arms at three");
    assert.match(f3, /fold substrate was destroyed/, "substrate paragraph named");
    assert.match(f3, /exactly ONE recovery step/, "recovery step stated");
    assert.match(f3, /run acp_status once/, "the single permitted action is named");
    assert.doesNotMatch(f3, /do not poll acp_status/, "the blanket ban is WITHHELD (it forbids the only exit)");
});

test("#4038 negative control: covered-by-active-block failures keep the verbatim loop-noise paragraph", () => {
    // Genuine repeat-call shape: an ACTIVE block exists and covers the request.
    // The new branch must not fire — cause stays covered-by-block, wording intact.
    const oldGen = genMsgs("old", 8);
    const ctx = makeCtx(oldGen);
    const ok = applyRanges(parseCompressInput(compressArgs("m00001", "m00004")), ctx);
    assert.ok(!ok.text.startsWith("[Compression FAILED:"), `setup fold must succeed: ${ok.text.slice(0, 200)}`);
    applyRanges(parseCompressInput(compressArgs("m00001", "m00001")), ctx);
    applyRanges(parseCompressInput(compressArgs("m00002", "m00002")), ctx);
    const f3 = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx).text;
    assert.ok(f3.startsWith("[Compression FAILED:"), "covered ranges still fail");
    assert.match(f3, /covered by active block/i, "genuine covered shape reported");
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "arms at three");
    assert.match(f3, /do not try other ranges, do not re-issue any previous range, and do not poll acp_status\./, "verbatim loop-noise sentence intact");
    assert.doesNotMatch(f3, /substrate-destruction/, "no substrate attribution while an active block exists");
    assert.doesNotMatch(f3, /resident block\(s\) are inactive/, "stale-ledger note absent");
});

test("#4038 negative control: 'already compressed' WITH active blocks present is not substrate", () => {
    // Truth-table cell: the kernel's "active block, none of its content visible"
    // consumed path also emits "already compressed" — but an active block exists,
    // so the shape is not the dead-ledger one and the loop-noise wording holds.
    const oldGen = genMsgs("old", 12); // tail distance keeps m00001–m00008 foldable
    const fresh = genMsgs("new", 6);
    const ctx = makeCtx(oldGen.concat(fresh));
    ctx.messages = oldGen;
    const r1 = applyRanges(parseCompressInput(compressArgs("m00001", "m00004")), ctx);
    const r2 = applyRanges(parseCompressInput(compressArgs("m00005", "m00008")), ctx);
    assert.ok(!r1.text.startsWith("[Compression FAILED:") && !r2.text.startsWith("[Compression FAILED:"), "setup folds succeed");
    // View loses every trace of both blocks (no raws, no stubs) — blocks stay ACTIVE.
    ctx.messages = fresh;
    const f1 = applyRanges(parseCompressInput(compressArgs("b1", "b1")), ctx).text;
    assert.match(f1, /already compressed/, "active-but-invisible consumed path emits the same verdict");
    assert.doesNotMatch(f1, /substrate-destruction/, "not attributed as substrate while blocks are active");
    applyRanges(parseCompressInput(compressArgs("b2", "b2")), ctx);
    const f3 = applyRanges(parseCompressInput(compressArgs("b1", "b2")), ctx).text;
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "arms at three");
    assert.match(f3, /do not poll acp_status/, "loop-noise wording kept for this cell");
    assert.doesNotMatch(f3, /exactly ONE recovery step/, "no substrate recovery wording");
});

test("#4038: acp_status carries the substrate annotation and the live table for the stale shape", () => {
    const ctx = staleLedgerCtx();
    applyRanges(parseCompressInput(compressArgs("b1", "b2")), ctx);
    const cause = compressLastFailureCause(ctx.session);
    assert.ok(cause?.startsWith("substrate-destruction"), "n=1 cause read back");
    const statusCtx = { core: ctx.core, config: ctx.config, messages: ctx.messages, session: ctx.session };

    const preArm = handleAcpStatus({}, statusCtx).text ?? "";
    assert.match(preArm, /FOLD SUBSTRATE INVALID/, "pre-arm invalid-substrate section at n=1");
    assert.match(preArm, /start a fresh conversation/, "recovery path stated");
    assert.doesNotMatch(preArm, /COMPRESS CIRCUIT BREAKER: ARMED/, "no armed section below threshold");

    ctx.session.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now(), cause };
    const armed = handleAcpStatus({}, statusCtx).text ?? "";
    assert.match(armed, /COMPRESS CIRCUIT BREAKER: ARMED — consecutiveFailures: 4 \/ 3\./, "armed section with counter");
    assert.match(armed, /re-derived from the CURRENT resent view/, "tailored recovery line replaces the STOP order");
    assert.match(armed, /one success clears this breaker/, "disarm-by-success restated");
    assert.doesNotMatch(armed, /do not attempt to compress now; continue the task/, "non-substrate STOP order not used");
});
