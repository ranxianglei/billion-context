import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildSessionCacheReport,
    handleAcpCache,
    noteForwardedBody,
    readPromptSwitchStats,
    settleUsageReport,
} from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

// #2350: host system-prompt rewrites (the host edits its own instructions
// between requests — e.g. OMP inserts/removes a fixed-length dynamic section)
// were invisible to the attribution layer: the loss landed in the unattributed
// TTL residual and surfaced as a misleading "cache seam" suspect. These tests
// pin the new `prompt` cause dimension end-to-end.

const T0 = Date.parse("2026-10-07T02:40:00Z");
const FP_A = "aaaaaa1111bbbbbb";
const FP_B = "cccccc2222dddddd";
const FP_C = "eeeeee3333ffffff";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `psw-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function turn(session: Session, body: string, sysFp: string | undefined, at: number, total: number, cached: number | null, proto = "openai"): void {
    // Production writes this in the wire prepare phase (fold-reconcile's
    // noteSystemPromptFingerprint); the settle reads it back under the lock.
    if (sysFp !== undefined) session.metadata.systemFp = { fp: sysFp, size: 1234 };
    noteForwardedBody(session, body, 4);
    settleUsageReport(session, { total, reportedCached: cached, protocol: proto, upstream: "https://relay.example" }, undefined);
    // settleUsageReport stamps Date.now() — keep ledger ordering deterministic.
    const led = (session.metadata as Record<string, { lines: Array<{ at: number }> }> & object)["cacheLedger"]!;
    led.lines[led.lines.length - 1]!.at = at;
}

function causeOf(session: Session, n: number): string | undefined {
    const led = (session.metadata as Record<string, { lines: Array<{ seq: number; cause?: string }> }> & object)["cacheLedger"]!;
    return led.lines.find((l) => l.seq === n)?.cause;
}

test("instructions-only change attributes the full residual to prompt (#2350)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, T0 + 1000, 10_000, 9000);
    turn(session, "b2", FP_A, T0 + 2000, 10_500, 10_000);
    // Same URL, same model, same wire — only the host rewrote the system prompt.
    turn(session, "b3", FP_B, T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(session);
    assert.equal(causeOf(session, 3), "prompt");
    assert.equal(r.promptSwitches.count, 1);
    // missed 11000 = growth 500 (new content) + 10500 re-billed stable prefix.
    assert.equal(r.promptSwitches.missedTokens, 10_500);
    const ev = r.promptSwitches.events[0]!;
    assert.equal(ev.seq, 3);
    assert.equal(ev.from, FP_A);
    assert.equal(ev.to, FP_B);
    assert.equal(ev.attributed, 10_500);
    const l3 = r.lines.find((l) => l.seq === 3)!;
    assert.equal(l3.newContent, 500);
    assert.equal(l3.ttlRepay, 10_500);
    assert.equal(l3.sysFp, FP_B);
    // The other identity dimensions stay silent…
    assert.equal(r.modelSwitches.count, 0);
    assert.equal(r.keySwitches.count, 0);
    assert.equal(r.upstreamSwitches.count, 0);
    assert.equal(r.invalidation.prompt, 10_500);
    // …and the line must NOT masquerade as a mid-history cache seam anymore.
    assert.equal(r.seam.suspects, 0);
    assert.equal(r.totals.residual, 0);
    assert.equal(r.totals.balanced, true);
});

test("cold rounds after a prompt rewrite stay charged; a warm line closes the window (#2350)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, T0 + 1000, 10_000, 9000);
    turn(session, "b2", FP_A, T0 + 2000, 10_500, 10_000);
    turn(session, "b3", FP_B, T0 + 3000, 11_000, 0); // the rewrite itself
    turn(session, "b4", FP_B, T0 + 4000, 11_200, 3_000); // cold tail, same prompt
    turn(session, "b5", FP_B, T0 + 5000, 11_400, 11_000); // warm → close
    turn(session, "b6", FP_B, T0 + 6000, 11_600, 4_000); // cold again, no open window
    assert.equal(causeOf(session, 4), "prompt");
    assert.equal(causeOf(session, 5), undefined);
    assert.equal(causeOf(session, 6), undefined);
    const r = buildSessionCacheReport(session);
    // One discrete event; the tail rides the cold-window charge.
    assert.equal(r.promptSwitches.count, 1);
    assert.ok(r.promptSwitches.missedTokens >= 10_500);
});

test("periodic insert/remove of a dynamic section books one rewrite per transition (#2350 OMP shape)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, T0 + 1000, 10_000, 9000);
    turn(session, "b2", FP_B, T0 + 2000, 10_600, 0); // host inserts the dynamic section
    turn(session, "b3", FP_A, T0 + 3000, 11_200, 0); // host removes it again
    const r = buildSessionCacheReport(session);
    assert.equal(r.promptSwitches.count, 2);
    assert.deepEqual(r.promptSwitches.events.map((e) => [e.from, e.to]), [
        [FP_A, FP_B],
        [FP_B, FP_A],
    ]);
    assert.equal(r.invalidation.prompt, r.promptSwitches.missedTokens);
});

test("lanes without a noted system never fabricate rewrite events (#2350 sparseness)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", undefined, T0 + 1000, 10_000, 9000);
    turn(session, "b2", FP_A, T0 + 2000, 10_500, 10_000);
    // First known fingerprint: no prior known → no rewrite possible.
    delete session.metadata.systemFp;
    turn(session, "b3", undefined, T0 + 3000, 11_000, 0);
    // A→unknown→A with no real rewrite: the unknown lane must not fabricate
    // a switch by advancing (or clearing) the known baseline.
    turn(session, "b4", FP_A, T0 + 4000, 11_500, 10_500);
    const r = buildSessionCacheReport(session);
    assert.equal(r.promptSwitches.count, 0);
    assert.equal(r.promptSwitches.missedTokens, 0);
    assert.deepEqual(r.promptSwitches.events, []);
});

test("a model change outranks a co-occurring prompt rewrite; the shadowed counter stays silent (#2350 #2784)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, T0 + 1000, 10_000, 9_000);
    turn(session, "b2", FP_A, T0 + 2000, 10_500, 10_000);
    session.metadata.lastModel = "glm-5.3";
    turn(session, "b3", FP_B, T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(session);
    // ONE narrative cause per line: the model switch narrates it; the fingerprint flip that rode
    // along on the same request no longer books its own zero-token event (#2784).
    assert.equal(r.modelSwitches.count, 1);
    assert.equal(r.promptSwitches.count, 0);
    assert.deepEqual(r.promptSwitches.events, []);
    // The partition still charges the residual to the model only.
    assert.equal(r.modelSwitches.missedTokens, 10_500);
    assert.equal(r.promptSwitches.missedTokens, 0);
    assert.equal(r.invalidation.model, 10_500);
    assert.equal(r.invalidation.prompt, 0);
    assert.equal(r.totals.residual, 0);
});

test("a prompt rewrite outranks a co-occurring wire switch; the shadowed counter stays silent (#2350 #2784)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, T0 + 1000, 10_000, 9_000, "openai");
    turn(session, "b2", FP_A, T0 + 2000, 10_500, 10_000, "openai");
    turn(session, "b3", FP_B, T0 + 3000, 11_000, 0, "anthropic");
    const r = buildSessionCacheReport(session);
    assert.equal(causeOf(session, 3), "prompt");
    assert.equal(r.promptSwitches.count, 1);
    assert.equal(r.wireSwitches.count, 0);
    assert.equal(r.promptSwitches.missedTokens, 10_500);
    assert.equal(r.wireSwitches.missedTokens, 0);
    assert.equal(r.invalidation.prompt, 10_500);
    assert.equal(r.invalidation.wire, 0);
    assert.equal(r.totals.residual, 0);
});

test("a dsh-style model switch narrates ONE cause; a later genuine rewrite still fires (#2784)", () => {
    const session = makeSession();
    session.metadata.lastModel = "deepseek-v4";
    turn(session, "b1", FP_A, T0 + 1000, 10_000, 9_000);
    turn(session, "b2", FP_A, T0 + 2000, 10_500, 10_000);
    // dsh re-renders the active model into its system prompt on every switch: the
    // fingerprint flips on the SAME request as the model change.
    session.metadata.lastModel = "deepseek-v4-pro";
    turn(session, "b3", FP_B, T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(session);
    assert.equal(causeOf(session, 3), "model");
    assert.equal(r.modelSwitches.count, 1);
    assert.equal(r.modelSwitches.missedTokens, 10_500);
    // No shadowed zero-token event → the web chip gate (count>0 || tokens>0) renders nothing.
    assert.equal(readPromptSwitchStats(session)?.count, 0);
    assert.equal(readPromptSwitchStats(session)?.missedTokens, 0);
    // The raw observation survives on the line itself…
    const led = (session.metadata as Record<string, { lines: Array<{ sf?: number }> }> & object)["cacheLedger"]!;
    assert.equal(led.lines[2]!.sf, 1);
    // …and the baseline advanced with it: a LATER genuine host rewrite still fires.
    turn(session, "b4", FP_C, T0 + 4000, 11_500, 0);
    const r2 = buildSessionCacheReport(session);
    assert.equal(causeOf(session, 4), "prompt");
    assert.equal(r2.promptSwitches.count, 1);
    assert.equal(r2.modelSwitches.count, 1);
    const ev = r2.promptSwitches.events[0]!;
    assert.equal(ev.from, FP_B);
    assert.equal(ev.to, FP_C);
});

test("handleAcpCache surfaces a PROMPT SWITCHES section with fingerprints only (#2350)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, T0 + 1000, 10_000, 9_000);
    turn(session, "b2", FP_A, T0 + 2000, 10_500, 10_000);
    turn(session, "b3-with-dynamic-section-body", FP_B, T0 + 3000, 11_000, 0);

    const text = handleAcpCache(session, { detail: "full" }).text;
    assert.ok(text.includes("PROMPT SWITCHES (host rewrote system prompt)"), "dedicated section expected");
    assert.ok(text.includes(`${FP_A} → ${FP_B}`), "fingerprint pair expected");
    assert.ok(text.includes("prompt rewrite:"), "invalidation line expected");
    assert.ok(!text.includes("dynamic-section-body"), "raw payload must never render");

    const quiet = makeSession();
    quiet.metadata.lastModel = "gpt-6.1-sol";
    turn(quiet, "b1", FP_A, T0 + 1000, 10_000, 9_000);
    const text2 = handleAcpCache(quiet).text;
    assert.ok(!text2.includes("PROMPT SWITCHES"), "no rewrite → no section");
});
