// #2929: the fold claim window is the post-fold COLD TAIL, mirroring the
// kernel's buildCacheReport (#1847 switch discipline applied to folds). Before
// this, the first measurable sample after a fold consumed it, so the client's
// echo re-bill ~25–66s later carried no foldSeq, fell into the unattributed
// ttlRepay residual, and tripped the cache-seam detector with "no fold
// attribution" — every one of #2929's seven seams was exactly this shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger } from "../src/cache-ledger.ts";
import { FOLD_CLAIM_COLD_ROUNDS, FOLD_CLAIM_WARM_HIT_PCT } from "acp-kernel";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `fold-claim-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
const T0 = Date.parse("2026-10-12T10:56:00Z");

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

/** Push a fold as a kernel block — same rig as cache-seam-detector.test.ts. */
function fold(session: Session, at: number): void {
    const st = session.state as unknown as { blocks: Array<Record<string, unknown>> };
    st.blocks.push({ blockId: "b1", createdAt: at, compressedTokens: 50_000, summary: "x".repeat(200), startRef: "m00002" });
}

test("constants exported for host/kernel parity (#2929)", () => {
    assert.equal(FOLD_CLAIM_COLD_ROUNDS, 4);
    assert.equal(FOLD_CLAIM_WARM_HIT_PCT, 85);
});

test("the client-echo re-bill is fold-owned: no seam, ttl stays clean (#2929)", () => {
    const s = makeSession();
    // Healthy baseline.
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    // Degenerate head fold lands between requests.
    fold(s, T0 + 500);
    // Proxy re-request (folded view) — first claim, as before.
    noteForwardedBody(s, body(["a", "SUMMARY"]));
    settle(s, T0 + 1_000, 51_000, 5_000);
    // Client echo re-bill 25–66s later: mid-history divergence vs the folded
    // view, cold (10%), no switch/restart — the exact #2929 seam shape.
    noteForwardedBody(s, body(["a", "b", "c", "d"]));
    settle(s, T0 + 60_000, 55_000, 5_100);
    const led = getCacheLedger(s);
    const echo = led.lines[led.lines.length - 1]!;
    assert.ok(echo.foldSeq !== null, "echo re-bill claimed by the fold's cold-tail window");
    assert.equal(echo.seam, undefined, "echo must NOT trip the seam detector anymore");
    assert.equal(led.agg.seamSuspects, 0);
    assert.ok(echo.cr > 0 && echo.tr === 0, "residual booked as compRepay, not unattributed ttl");
    assert.ok(led.agg.cr >= echo.cr, "fold economics owner absorbs it");
});

test("warm line retires the window: a later cold blip is unattributed again (#2929)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    fold(s, T0 + 500);
    noteForwardedBody(s, body(["a", "SUMMARY"]));
    settle(s, T0 + 1_000, 51_000, 5_000);      // claim 1 (cold)
    noteForwardedBody(s, body(["a", "SUMMARY", "d"]));
    settle(s, T0 + 30_000, 55_000, 52_000);    // 94.5% warm — retires every open window
    noteForwardedBody(s, body(["a", "SUMMARY", "d", "e"]));
    settle(s, T0 + 90_000, 60_000, 20_000);    // unrelated later cold blip (33%)
    const led = getCacheLedger(s);
    const blip = led.lines[led.lines.length - 1]!;
    assert.equal(blip.foldSeq, null, "window closed by the warm line");
    assert.ok(blip.tr > 0, "blip falls to the unattributed residual");
    assert.equal(blip.seam, undefined, "blip is byte-stable append-shaped here; and even a mid-history one would be a NEW seam worth seeing");
});

test("FOLD_CLAIM_COLD_ROUNDS bounds the window without a warm line (#2929)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    fold(s, T0 + 500);
    for (let i = 0; i < FOLD_CLAIM_COLD_ROUNDS + 2; i++) {
        noteForwardedBody(s, body(["a", "SUMMARY", `t${i}`]));
        settle(s, T0 + 1_000 + i * 5_000, 55_000 + i * 100, 5_100);   // all cold
    }
    const led = getCacheLedger(s);
    const claimed = led.lines.filter((l) => l.foldSeq !== null).length;
    assert.equal(claimed, FOLD_CLAIM_COLD_ROUNDS, "exactly the bound");
    const tail = led.lines[led.lines.length - 1]!;
    assert.equal(tail.foldSeq, null);
    assert.ok(tail.tr > 0, "post-window residual is unattributed again");
});

test("ledger persisted before #2929 (no claims/retired fields) still claims the first sample", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    fold(s, T0 + 500);
    noteForwardedBody(s, body(["a", "SUMMARY"]));
    settle(s, T0 + 1_000, 51_000, 5_000);
    const led = getCacheLedger(s);
    // Sparse-field compat: the fold record now carries the new fields.
    const f = led.folds[0]!;
    assert.equal(f.claims, 1);
    assert.notEqual(f.retired, true);
    assert.ok(led.lines[led.lines.length - 1]!.foldSeq === f.seq);
});

test("#2929 taxonomy: long-idle byte-stable miss = normal upstream TTL, short-gap = abnormal provider-side", () => {
    const s = makeSession();
    const realNow = Date.now;
    const at = (t: number): void => { Date.now = () => t; };
    try {
        at(T0);              noteForwardedBody(s, body(["a", "b"]));
        settle(s, T0, 100_000, 99_000);
        at(T0 + 10_000);     noteForwardedBody(s, body(["a", "b"]));
        settle(s, T0 + 10_000, 100_000, 40_000);   // byte-stable, 10s gap, big tr → ABNORMAL provider-side
        // 25 minutes later, identical body again → normal TTL expiry.
        const idle = T0 + 10_000 + 25 * 60_000;
        at(idle);            noteForwardedBody(s, body(["a", "b"]));
        settle(s, idle, 100_000, 30_000);
    } finally {
        Date.now = realNow;
    }
    const led = getCacheLedger(s);
    const a = led.agg as unknown as { providerSideMisses: number; providerSideMissed: number; providerTtlMisses: number; providerTtlMissed: number };
    assert.equal(a.providerSideMisses, 1, "short-gap byte-stable miss stays abnormal");
    assert.ok(a.providerSideMissed > 0);
    assert.equal(a.providerTtlMisses, 1, "long-idle byte-stable miss is re-labeled normal TTL");
    assert.ok(a.providerTtlMissed > 0);
});
