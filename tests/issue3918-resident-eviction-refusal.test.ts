// #3918: a session whose live footprint cannot fit the resident pool alongside
// other active sessions is evicted after EVERY model request (releaseInFlight
// discharge), so the empty-view compress refusal (#3126) repeats forever — yet
// its receipt kept promising "the next model request restores the view". These
// tests pin the honest diagnosis: when the session's last-known live weight
// plus the current residents exceeds the byte budget, the refusal names the
// permanent case and gives the actionable exits (close the peer / raise
// sessions.residentMaxBytes); when the pool CAN hold it (peer closed, restart,
// small session), the original transient self-heal wording stands. The gate
// itself (refusal, nothing marked dead) stays pinned in
// tests/issue3126-no-visible-context.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreMessage } from "acp-kernel";
import { createCore, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, acquireInFlight, releaseInFlight, markDirty, dropSessionForGc, residentPressure, _resetSessionsForTest } from "../src/session.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";

const BUDGET = 300_000;

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

function makeCtx(session: RewriteCtx["session"], logs: string[]): RewriteCtx {
    return {
        core: createCore(),
        // Explicit protect-zone override (same recipe as
        // tests/issue3126-no-visible-context.test.ts): the bare default would
        // fence m00010..m00040 under recent-message protection and mask the
        // gate behavior under test.
        config: defaultConfig(200000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        messages: [],
        session,
        log: (m: string) => { logs.push(m); },
    };
}

const SPEC = () => parseCompressInput({ content: [{ startId: "m00010", endId: "m00040", summary: "y".repeat(100) }] });

async function fixture(run: () => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-3918-"));
    const store = new SessionStore({ dir: path.join(root, "sessions"), enabled: true, debounceMs: 0 });
    _resetSessionsForTest(256, BUDGET);
    _setStoreForTest(store);
    try { await run(); } finally {
        store.closeQuietly();
        _resetSessionsForTest(256, 512 * 1024 * 1024);
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmSync(root, { recursive: true, force: true });
    }
}

/** Grow `big-sess` past what BUDGET can hold alongside `peer-sess`, then run
 * one request cycle over it: releaseInFlight's discharge evicts the oldest
 * idle session (big, touched first) and stamps its live weight. Returns the
 * evicted object — alive in JS, out of the pool, refs intact on its state. */
function growAndEvictBig(): RewriteCtx["session"] {
    const big = getSession("big-sess");
    const peer = getSession("peer-sess");
    big.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    big.metadata.blob = "x".repeat(80_000);
    peer.metadata.blob = "y".repeat(60_000);
    markDirty(big);
    markDirty(peer);
    acquireInFlight(big);
    releaseInFlight(big);
    return big;
}

test("#3918: eviction stamps the live weight; pressure is permanent while the peer holds the budget, transient once it is gone", async () => fixture(async () => {
    const big = growAndEvictBig();
    const p = residentPressure(big.id);
    assert.ok(p.weightBytes !== undefined && p.weightBytes > 100_000, `live weight stamped at eviction (80K-char blob ≈ 160KiB): ${p.weightBytes}`);
    assert.equal(p.budgetBytes, BUDGET);
    assert.ok(p.otherBytes > 50_000, `the peer still occupies budget space: ${p.otherBytes}`);
    assert.ok(p.permanent, `weight ${p.weightBytes} + others ${p.otherBytes} > budget ${BUDGET} → permanent`);
    assert.equal(dropSessionForGc("peer-sess"), true);
    const freed = residentPressure(big.id);
    assert.equal(freed.permanent, false, "without the peer the session fits the budget → transient again");
    assert.equal(residentPressure("never-seen").permanent, false, "unknown session: no permanent claim");
    assert.equal(residentPressure("never-seen").weightBytes, undefined, "unknown session: no weight to quote");
}));

test("#3918: the refusal receipt names the PERMANENT case and gives the exits instead of an impossible retry", async () => fixture(async () => {
    const big = growAndEvictBig();
    const logs: string[] = [];
    const res = applyRanges(SPEC(), makeCtx(big, logs));
    assert.equal(res.outcome, "refused");
    assert.equal(res.reason, "gate:no-visible-context");
    assert.ok(res.text.includes("NOT TRANSIENT"), `receipt names the permanent case: ${res.text}`);
    assert.ok(res.text.includes("sessions.residentMaxBytes"), `receipt gives the config exit: ${res.text}`);
    assert.ok(!res.text.includes("after the next turn you can compress the same ranges again"), `impossible-retry advice removed: ${res.text}`);
    assert.ok(logs.some((l) => l.includes("PERMANENT")), `operator log carries the marker: ${JSON.stringify(logs)}`);
    assert.equal(res.blocksCreated, 0);
    assert.equal(big.state.deadRefs, undefined, "still nothing marked dead");
}));

test("#3918: with the peer gone the same empty-view shape keeps the transient self-heal advice (negative direction)", async () => fixture(async () => {
    const big = growAndEvictBig();
    assert.equal(dropSessionForGc("peer-sess"), true);
    const logs: string[] = [];
    const res = applyRanges(SPEC(), makeCtx(big, logs));
    assert.equal(res.outcome, "refused");
    assert.equal(res.reason, "gate:no-visible-context");
    assert.ok(res.text.includes("Do NOT retry now"), `transient wording intact: ${res.text}`);
    assert.ok(!res.text.includes("NOT TRANSIENT"), `no permanent claim when the pool fits: ${res.text}`);
    assert.ok(!logs.some((l) => l.includes("PERMANENT")), "log stays on the #3126 self-heal line");
}));
