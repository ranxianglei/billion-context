// #2131 reachability: per-call outbound body-stability proof. Every settled
// request stores the SHA-256 of its exact outbound body plus (when retained
// under BODY_FULL_CAP) the first-diverging byte offset vs the previous settled
// request's body, classified head/append/mid/unknown. The report surfaces the
// aggregate (plus size-bucket hit stratification and the low/high-hit gap
// split) so "was the prefix unchanged between calls" is stored data visible in
// /acp-cache, __bili/cache-report and the dashboard — not an interpretation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `stability-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
const T0 = Date.parse("2026-09-28T10:00:00Z");

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

test("identical consecutive bodies prove byte-identity (be=1)", () => {
    const s = makeSession();
    const b = body(["a", "b"]);
    noteForwardedBody(s, b);
    settle(s, T0, 100_000, 99_000);
    // A transport retry resends the EXACT same payload.
    noteForwardedBody(s, b);
    settle(s, T0 + 1000, 100_000, 99_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.be, 1, "second body must be flagged byte-identical");
    assert.equal(line.bd, createHash("sha256").update(b, "utf8").digest("hex"), "digest must match the exact outbound body");
    assert.equal(line.bl, undefined, "no LCP for an identical pair");
    assert.equal(line.bs, undefined, "no divergence class for an identical pair");
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.paired, 1);
    assert.equal(rep.stability.equal, 1);
    assert.equal(rep.stability.diverged, 0);
});

test("pure tail-append diverges at the closing-bracket region (bs=append)", () => {
    const s = makeSession();
    const b1 = body(["a", "b", "c"]);
    const b2 = body(["a", "b", "c", "d"]);
    noteForwardedBody(s, b1);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, b2);
    settle(s, T0 + 1000, 100_000, 90_000);
    const line = getCacheLedger(s).lines[getCacheLedger(s).lines.length - 1]!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "append", "whole shorter payload survives ±64 closing-bracket bytes");
    assert.equal(line.bl, b1.length - 2, "LCP lands exactly where body2 stops being a prefix (before body1's final two brackets)");
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.append, 1);
    assert.equal(rep.stability.mid, 0);
});

test("head-region change classifies as host-side parameter change (bs=head)", () => {
    const s = makeSession();
    const b1 = body(["a", "b"]);
    const b2 = JSON.stringify({ model: "OTHER-MODEL", messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] });
    noteForwardedBody(s, b1);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, b2);
    settle(s, T0 + 1000, 100_000, 90_000);
    const line = getCacheLedger(s).lines[getCacheLedger(s).lines.length - 1]!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "head", "divergence inside the first 1 KiB = parameter region, not a history rewrite");
    assert.ok(line.bl !== undefined && line.bl < 1024);
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.head, 1);
});

test("mid-history change classifies as a real rewrite (bs=mid)", () => {
    const s = makeSession();
    const many = Array.from({ length: 30 }, (_, i) => `msg${i}-${"x".repeat(300)}`);
    const b1 = body(many);
    const changed = [...many];
    changed[5] = `msg5-${"y".repeat(300)}`;
    const b2 = body(changed);
    noteForwardedBody(s, b1);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, b2);
    settle(s, T0 + 1000, 100_000, 90_000);
    const line = getCacheLedger(s).lines[getCacheLedger(s).lines.length - 1]!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "mid", "divergence past 1 KiB and not at the tail = mid-history rewrite");
    assert.ok(line.bl !== undefined && line.bl > 1024 && line.bl < b1.length - 64);
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.mid, 1);
});

test("bodies above the retention cap stay provable via digest only (bs=unknown)", () => {
    const s = makeSession();
    const big1 = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(8 * 1024 * 1024 + 1024) }] });
    const big2 = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(8 * 1024 * 1024 + 1024) + "z" }] });
    assert.notEqual(big1.length, big2.length);
    noteForwardedBody(s, big1);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, big2);
    settle(s, T0 + 1000, 100_000, 90_000);
    const line = getCacheLedger(s).lines[getCacheLedger(s).lines.length - 1]!;
    assert.equal(line.be, 0, "inequality proven by digest even without the full bodies");
    assert.equal(line.bs, "unknown", "offset unavailable above BODY_FULL_CAP");
    assert.equal(line.bl, undefined);
    assert.equal(line.bd, createHash("sha256").update(big2, "utf8").digest("hex"));
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.unknownOffset, 1);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("report surfaces stability aggregate, per-line fields and context checks", async () => {
    const s = makeSession();
    const b1 = body(["a"]);
    noteForwardedBody(s, b1);
    settle(s, T0, 40_000, 36_000);
    // Ledger lines stamp Date.now() internally — real delays give the gap
    // diagnostic measurable, non-zero inter-request gaps.
    await sleep(5);
    const b2 = body(["a", "b"]);
    noteForwardedBody(s, b2);
    settle(s, T0 + 5_000, 60_000, 54_000);
    await sleep(5);
    const b3 = JSON.stringify({ model: "Z", messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c" }] });
    noteForwardedBody(s, b3);
    settle(s, T0 + 10_000, 80_000, 20_000);
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.paired, 2);
    assert.equal(rep.stability.append, 1);
    assert.equal(rep.stability.head, 1);
    assert.ok(rep.lines.length >= 3);
    assert.equal(rep.lines[rep.lines.length - 1]!.bodyEqual, 0);
    assert.equal(rep.lines[rep.lines.length - 1]!.bodyClass, "head");
    assert.match(String(rep.lines[rep.lines.length - 1]!.bodyDigest), /^[0-9a-f]{64}$/);
    assert.ok(rep.stability.sizeBuckets.length >= 1, "size buckets computed from measurable lines");
    assert.ok(rep.stability.gapSplit.highHitMedGapMs !== null && rep.stability.gapSplit.lowHitMedGapMs !== null, "gap split computed for both hit classes (90% pair + 25% pair)");
    const res = handleAcpCache(s);
    const text = res.text;
    assert.match(text, /BODY STABILITY/);
    assert.match(text, /byte-identical/);
});
