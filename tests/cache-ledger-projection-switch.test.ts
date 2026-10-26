import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildSessionCacheReport,
    handleAcpCache,
    noteForwardedBody,
    readProjSwitchStats,
    settleUsageReport,
} from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

// #2867: a Responses self-heal degrade (plugin → proxy) re-projects the SAME
// incoming history through different rules — mid-history developer items get
// hoisted into the head developer block — so the forwarded-system fingerprint
// flips even though the host never touched its prompt. The ledger used to book
// every such flip as "host rewrote the system prompt" (#2350's dimension).
// These tests pin the split: the canonical incoming fingerprint decides
// attribution; a projection-only flip books the new `projection` cause.

const T0 = Date.parse("2026-10-07T02:40:00Z");
const FP_A = "aaaaaa1111bbbbbb";
const FP_B = "cccccc2222dddddd";
const FP_C = "eeeeee3333ffffff";
const CANON = "1234567890abcdef"; // canonical incoming view — stable across modes
const CANON_D = "fedcba0987654321";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `prj-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function turn(
    session: Session,
    body: string,
    sysFp: string | undefined,
    canonFp: string | undefined,
    mode: "plugin" | "proxy" | undefined,
    at: number,
    total: number,
    cached: number | null,
    proto = "responses",
): void {
    // Default wire is "responses": #2973 gates settle's canon/mode slot reads
    // to that lane, so scenarios modeling the self-heal degrade must settle on
    // it too. Non-responses lanes are passed explicitly where a test needs one.
    // Production writes these in the wire prepare phase (prepare-responses:
    // noteSystemPromptFingerprint + noteCanonicalSystemFingerprint + the
    // lastResponsesMode stamp); settle reads them back under the lock.
    if (sysFp !== undefined) session.metadata.systemFp = { fp: sysFp, size: 1234 };
    if (canonFp !== undefined) session.metadata.canonicalSysFp = { fp: canonFp, size: 1234 };
    if (mode !== undefined) session.metadata.lastResponsesMode = mode;
    noteForwardedBody(session, body, 4);
    settleUsageReport(session, { total, reportedCached: cached, protocol: proto, upstream: "https://relay.example" }, undefined);
    const led = (session.metadata as Record<string, { lines: Array<{ at: number }> }> & object)["cacheLedger"]!;
    led.lines[led.lines.length - 1]!.at = at;
}

type Line = { seq: number; cause?: string; sf?: number; pf?: number; cf?: number; pw?: number; pm?: string };
function lineOf(session: Session, n: number): Line {
    const led = (session.metadata as Record<string, { lines: Line[] }> & object)["cacheLedger"]!;
    return led.lines.find((l) => l.seq === n)!;
}

test("a self-heal mode flip with untouched history books projection, NOT prompt (#2867)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9000);
    turn(session, "b2", FP_A, CANON, "plugin", T0 + 2000, 10_500, 10_000);
    // Same URL, same model, same incoming history — the proxy degraded to proxy
    // mode and hoisted the mid-history developer items into the head block.
    turn(session, "b3", FP_B, CANON, "proxy", T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(session);
    const l3 = lineOf(session, 3);
    assert.equal(l3.cause, "projection");
    assert.equal(l3.pf, 1);
    assert.equal(l3.sf, 1); // raw observation survives: forwarded bytes DID change
    assert.equal(l3.pm, "proxy");
    assert.equal(lineOf(session, 1).pm, "plugin");
    assert.equal(r.projSwitches.count, 1);
    assert.equal(r.projSwitches.missedTokens, 10_500);
    const ev = r.projSwitches.events[0]!;
    assert.equal(ev.seq, 3);
    assert.equal(ev.from, FP_A);
    assert.equal(ev.to, FP_B);
    assert.equal(ev.attributed, 10_500);
    // …and it must NOT masquerade as a host rewrite anymore.
    assert.equal(r.promptSwitches.count, 0);
    assert.deepEqual(r.promptSwitches.events, []);
    assert.equal(r.invalidation.projection, 10_500);
    assert.equal(r.invalidation.prompt, 0);
    assert.equal(r.totals.residual, 0);
    assert.equal(r.totals.balanced, true);
});

test("cold rounds after a projection flip stay charged; a warm line closes the window (#2867)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9000);
    turn(session, "b2", FP_A, CANON, "plugin", T0 + 2000, 10_500, 10_000);
    turn(session, "b3", FP_B, CANON, "proxy", T0 + 3000, 11_000, 0); // the degrade itself
    turn(session, "b4", FP_B, CANON, "proxy", T0 + 4000, 11_200, 3_000); // cold tail, same projection
    turn(session, "b5", FP_B, CANON, "proxy", T0 + 5000, 11_400, 11_000); // warm → close
    turn(session, "b6", FP_B, CANON, "proxy", T0 + 6000, 11_600, 4_000); // cold again, no open window
    assert.equal(lineOf(session, 4).cause, "projection");
    assert.equal(lineOf(session, 5).cause, undefined);
    assert.equal(lineOf(session, 6).cause, undefined);
    const r = buildSessionCacheReport(session);
    assert.equal(r.projSwitches.count, 1);
    assert.ok(r.projSwitches.missedTokens >= 10_500);
});

test("repeated plugin→proxy→plugin flapping books one projection event per transition (#2867)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9000);
    turn(session, "b2", FP_B, CANON, "proxy", T0 + 2000, 10_600, 0); // self-heal degrade
    turn(session, "b3", FP_A, CANON, "plugin", T0 + 3000, 11_200, 0); // plugin lane restored
    const r = buildSessionCacheReport(session);
    assert.equal(r.projSwitches.count, 2);
    assert.deepEqual(r.projSwitches.events.map((e) => [e.from, e.to]), [
        [FP_A, FP_B],
        [FP_B, FP_A],
    ]);
    assert.equal(r.invalidation.projection, r.projSwitches.missedTokens);
    assert.equal(r.promptSwitches.count, 0);
});

test("a genuine host edit wins over the co-occurring mode flip (#2867 both-together)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9000);
    turn(session, "b2", FP_A, CANON, "plugin", T0 + 2000, 10_500, 10_000);
    // Host edited its instructions AND the proxy degraded in the same round:
    // the canonical view changed too → host-side narration keeps the line.
    turn(session, "b3", FP_B, CANON_D, "proxy", T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(session);
    assert.equal(lineOf(session, 3).cause, "prompt");
    assert.equal(r.promptSwitches.count, 1);
    assert.equal(r.projSwitches.count, 0);
    assert.equal(r.invalidation.prompt, 10_500);
    assert.equal(r.invalidation.projection, 0);
    assert.equal(r.totals.residual, 0);
});

test("a canonical-only flip (mid-history edit under plugin in-place rules) observes without billing (#2867)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9000);
    turn(session, "b2", FP_A, CANON, "plugin", T0 + 2000, 10_500, 10_000);
    // Plugin mode keeps mid-history developer items in place: the host edits
    // one of them, the forwarded head system block is UNCHANGED.
    turn(session, "b3", FP_A, CANON_D, "plugin", T0 + 3000, 11_000, 10_000);
    const l3 = lineOf(session, 3);
    assert.equal(l3.cf, 1);
    assert.equal(l3.sf, undefined);
    assert.equal(l3.pf, undefined);
    assert.equal(l3.cause, undefined);
    const r = buildSessionCacheReport(session);
    assert.equal(r.promptSwitches.count, 0);
    assert.equal(r.projSwitches.count, 0);
    assert.equal(r.invalidation.prompt, 0);
    assert.equal(r.invalidation.projection, 0);
});

test("lanes without a canonical fingerprint keep the legacy host-side reading (#2867 sparseness)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    // Non-responses lanes never write canonicalSysFp: an sp flip there is
    // exactly what #2350 measured — attributed to the host as before.
    turn(session, "b1", FP_A, undefined, undefined, T0 + 1000, 10_000, 9000, "anthropic");
    turn(session, "b2", FP_A, undefined, undefined, T0 + 2000, 10_500, 10_000, "anthropic");
    turn(session, "b3", FP_B, undefined, undefined, T0 + 3000, 11_000, 0, "anthropic");
    assert.equal(lineOf(session, 3).cause, "prompt");
    const r = buildSessionCacheReport(session);
    assert.equal(r.promptSwitches.count, 1);
    assert.equal(r.projSwitches.count, 0);

    // Sparseness: canon A→unknown→A with a stable sp fabricates nothing.
    const s2 = makeSession();
    s2.metadata.lastModel = "gpt-6.1-sol";
    turn(s2, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9000);
    turn(s2, "b2", FP_A, CANON, "plugin", T0 + 2000, 10_500, 10_000);
    delete s2.metadata.canonicalSysFp;
    turn(s2, "b3", FP_A, undefined, "plugin", T0 + 3000, 11_000, 10_000);
    turn(s2, "b4", FP_A, CANON, "plugin", T0 + 4000, 11_500, 10_500);
    const r2 = buildSessionCacheReport(s2);
    assert.equal(r2.projSwitches.count, 0);
    assert.equal(r2.promptSwitches.count, 0);
    const led2 = (s2.metadata as Record<string, { lines: Line[] }> & object)["cacheLedger"]!;
    assert.ok(led2.lines.every((l) => l.cf === undefined && l.pf === undefined));
});

test("a stale responses canon never leaks into a non-responses settle — host edit stays host-attributed (#2973)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9_000);
    turn(session, "b2", FP_A, CANON, "plugin", T0 + 2000, 10_500, 10_000);
    // The session switches off the responses wire; the metadata slots still
    // carry the last responses request's canon fp + mode stamp. The host edits
    // ITS system prompt on the anthropic wire: pre-#2973 the stale canon made
    // settle read this as bili's own projection flip — now the legacy host
    // reading wins, and neither slot value leaks onto the line.
    turn(session, "b3", FP_B, undefined, undefined, T0 + 3000, 11_000, 0, "anthropic");
    const l3 = lineOf(session, 3);
    assert.equal(l3.cause, "prompt");
    assert.equal(l3.sf, 1);
    assert.equal(l3.pf, undefined);
    assert.equal(l3.cf, undefined);
    assert.equal(l3.pm, undefined); // stale mode slot must not leak either
    const r = buildSessionCacheReport(session);
    assert.equal(r.promptSwitches.count, 1);
    assert.equal(r.projSwitches.count, 0);
    assert.deepEqual(r.projSwitches.events, []);
    assert.equal(r.invalidation.prompt, 10_500);
    assert.equal(r.invalidation.projection, 0);
    assert.equal(r.totals.balanced, true);
});

test("a model change outranks a co-occurring projection flip; the shadowed counter stays silent (#2867 #2784)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9_000);
    turn(session, "b2", FP_A, CANON, "plugin", T0 + 2000, 10_500, 10_000);
    session.metadata.lastModel = "glm-5.3";
    turn(session, "b3", FP_B, CANON, "proxy", T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(session);
    assert.equal(r.modelSwitches.count, 1);
    assert.equal(r.projSwitches.count, 0);
    assert.deepEqual(r.projSwitches.events, []);
    assert.equal(readProjSwitchStats(session)?.count, 0);
    assert.equal(readProjSwitchStats(session)?.missedTokens, 0);
    // The raw observation survives on the line itself…
    assert.equal(lineOf(session, 3).pf, 1);
    assert.equal(lineOf(session, 3).cause, "model");
    // …and the baseline advanced with it: a LATER pure mode flip still fires.
    // b4 keeps the projection (warm) so only b5 transitions; the model cold
    // window opened at b3 is long expired by then (SWITCH_COLD_ROUNDS=4).
    turn(session, "b4", FP_B, CANON, "proxy", T0 + 4000, 11_500, 11_000);
    turn(session, "b5", FP_A, CANON, "plugin", T0 + 5000, 12_000, 0);
    const r2 = buildSessionCacheReport(session);
    assert.equal(lineOf(session, 5).cause, "projection");
    assert.equal(r2.projSwitches.count, 1);
    assert.equal(r2.modelSwitches.count, 1);
});

test("a projection flip outranks a co-occurring wire switch (#2867)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    // A baseline on the responses wire anchors the canonical fp …
    turn(session, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9_000);
    // … a detour off it …
    turn(session, "b2", FP_A, undefined, undefined, T0 + 2000, 10_500, 10_000, "anthropic");
    // … and the return-to-responses round co-fires the mode flip: the fresh
    // change wins the line as projection; the wire flag stays observable on
    // the line but its counter stays shadowed (#2784 one-line-one-cause).
    turn(session, "b3", FP_B, CANON, "proxy", T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(session);
    assert.equal(lineOf(session, 3).cause, "projection");
    assert.equal(lineOf(session, 3).pf, 1);
    assert.equal(lineOf(session, 3).pw, 1);
    assert.equal(r.projSwitches.count, 1);
    assert.deepEqual(r.projSwitches.events.map((e) => [e.from, e.to]), [[FP_A, FP_B]]);
    assert.equal(r.wireSwitches.count, 1); // b2's detour is its own event; b3's flag is shadowed
    assert.equal(r.projSwitches.missedTokens, 10_500);
    assert.equal(r.wireSwitches.missedTokens, 0); // b2 was warm: no residual to charge
    assert.equal(r.invalidation.projection, 10_500);
    assert.equal(r.invalidation.wire, 0);
    assert.equal(r.promptSwitches.count, 0);
    assert.equal(r.totals.residual, 0);
    assert.equal(r.totals.balanced, true);
});

test("handleAcpCache surfaces PROJECTION SWITCHES without blaming the host (#2867)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-6.1-sol";
    turn(session, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9_000);
    turn(session, "b2", FP_A, CANON, "plugin", T0 + 2000, 10_500, 10_000);
    turn(session, "b3-degraded-projection", FP_B, CANON, "proxy", T0 + 3000, 11_000, 0);

    const text = handleAcpCache(session, { detail: "full" }).text;
    assert.ok(text.includes("PROJECTION SWITCHES"), "dedicated section expected");
    assert.ok(text.includes(`${FP_A} → ${FP_B}`), "fingerprint pair expected");
    assert.ok(text.includes("projection switch:"), "invalidation line expected");
    assert.ok(!text.includes("PROMPT SWITCHES (host rewrote"), "no host blame for a pure mode flip");
    assert.ok(!text.includes("degraded-projection"), "raw payload must never render");

    // The legacy host-edit path renders the PROMPT section instead.
    const host = makeSession();
    host.metadata.lastModel = "gpt-6.1-sol";
    turn(host, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9_000);
    turn(host, "b2-host-edited-instructions", FP_B, CANON_D, "plugin", T0 + 2000, 10_600, 0);
    const text2 = handleAcpCache(host, { detail: "full" }).text;
    assert.ok(text2.includes("PROMPT SWITCHES (host rewrote system prompt)"));
    assert.ok(!text2.includes("PROJECTION SWITCHES"));

    // Quiet session: neither section.
    const quiet = makeSession();
    quiet.metadata.lastModel = "gpt-6.1-sol";
    turn(quiet, "b1", FP_A, CANON, "plugin", T0 + 1000, 10_000, 9_000);
    assert.ok(!handleAcpCache(quiet).text.includes("PROJECTION SWITCHES"));
});
