/**
 * #R3 memory diagnostics: residentBreakdown / memoryReport must attribute a
 * session's resident bytes to the right fields, so the lazy-load priorities
 * (blockContents, contentStore, lastMessages, pluginSnapshot) are decided on
 * measured data instead of guesses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSession, getSession, memoryReport, residentBreakdown } from "../src/session.js";

const BIG = 200_000; // chars → ~400KB as JS strings

test("residentBreakdown attributes big fields and sums to total", () => {
    const session = createSession("mem-diag-1");
    session.lastMessages = [{ id: "m1", role: "user", content: "x".repeat(BIG) }] as never;
    session.blockContents = new Map([
        ["b1", { one: null, full: { text: "y".repeat(BIG / 2), count: 2 } as never }],
    ]);
    const breakdown = residentBreakdown(session);
    // 2 bytes/char in the estimator → each BIG-char string is ≥ BIG*2 bytes.
    assert.ok(breakdown.lastMessages >= BIG * 2, `lastMessages attributed: ${breakdown.lastMessages}`);
    assert.ok(breakdown.blockContents >= (BIG / 2) * 2, `blockContents attributed: ${breakdown.blockContents}`);
    const fieldsSum = breakdown.lastMessages + breakdown.pluginSnapshot + breakdown.blockContents
        + breakdown.contentStore + breakdown.state + breakdown.metadata + breakdown.other;
    assert.equal(fieldsSum, breakdown.total, "columns sum to total (other absorbs the remainder)");
    assert.ok(breakdown.other >= 0 && breakdown.state > 0, "state weighed, other non-negative");
});

test("residentBreakdown scales with content (monotone)", () => {
    const small = createSession("mem-diag-small");
    small.lastMessages = [{ id: "m1", role: "user", content: "a".repeat(1_000) }] as never;
    const big = createSession("mem-diag-big");
    big.lastMessages = [{ id: "m1", role: "user", content: "a".repeat(1_000_000) }] as never;
    const smallB = residentBreakdown(small);
    const bigB = residentBreakdown(big);
    assert.ok(bigB.lastMessages > smallB.lastMessages * 100, "1M chars must dwarf 1K chars");
});

test("memoryReport includes pool sessions sorted by bytes with budget context", () => {
    const session = createSession(`mem-diag-pool-${Date.now()}`);
    session.lastMessages = [{ id: "m1", role: "user", content: "z".repeat(500_000) }] as never;
    // Register into the resident pool the same way the request path does
    // (createSession alone does not register).
    const pooled = getSession(`mem-diag-pool-live-${Date.now()}`);
    pooled.lastMessages = session.lastMessages;
    const report = memoryReport();
    assert.ok(report.pool.sessions >= 1, "pool counts the registered session");
    assert.ok(report.pool.maxSessions >= report.pool.sessions, "maxSessions sane");
    assert.ok(report.pool.budgetBytes > 0, "byte budget exposed");
    assert.ok(report.breakdown.total > 0, "pool totals non-zero with a fat session resident");
    const sorted = [...report.sessions].sort((a, b) => b.fields.total - a.fields.total);
    assert.deepEqual(report.sessions.map((r) => r.id), sorted.map((r) => r.id), "sessions sorted heaviest-first");
    const mine = report.sessions.find((r) => r.id === pooled.id);
    assert.ok(mine, "registered session present in report");
    assert.ok(mine.fields.lastMessages >= 500_000 * 2, "field attribution survives the pool path");
    assert.equal(mine.inFlight, 0, "idle session reports zero in-flight");
});
