// #5806: default residency budget of 512 MiB is smaller than ONE giant
// session; every byte-pressure event then hunts for a victim, and pure-LRU
// eviction picked off the SMALL session right after it was served — each
// reload replaying tens of MB synchronously, every round. #5783 added the
// 10-minute COLD-LOAD grace (re-materialization paid => shielded for a while);
// this PR closes the two gaps it left open:
//   1. A hot session that simply STAYED resident loses any shield ten minutes
//      later while usage continues — when the giant is in-flight/graced, pure
//      LRU kills the small session that was touched seconds ago. RECENT-TOUCH
//      grace (#5806): byte-budget eviction skips anything touched within the
//      last minute; count-cap admission still overrides it (a full pool must
//      admit, and the victim flushes to disk before deletion anyway).
//   2. The pool sat over budget SILENTLY with nothing left to shed. Now:
//      /__bili/memory reports evictedTotal / lastEviction / unsatisfiedBytes,
//      and a rate-limited "pool saturated" warn says out loud that memory is
//      bounded by the working set until the knob moves.
// Gate discipline (#3617/#5782 style): every direction is pinned both ways —
// shields hold AND expire, overrides work AND ordinary LRU stays intact.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import {
    getSession, acquireInFlight, releaseInFlight, markDirty,
    residentPressure, memoryReport, _resetSessionsForTest, _sessionsSizeForTest,
} from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

const BUDGET = 300_000;
// Well past the 60-second recent-touch window; the fixtures mutate lastSeen
// directly, so tests stay deterministic.
const AGED_MS = 180_000;

function fixture(run: () => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-5806-"));
    const store = new SessionStore({ dir: path.join(root, "sessions"), enabled: true, debounceMs: 0 });
    _resetSessionsForTest(256, BUDGET);
    _setStoreForTest(store);
    try { return run(); } finally {
        store.closeQuietly();
        _resetSessionsForTest(256, 512 * 1024 * 1024);
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmSync(root, { recursive: true, force: true });
    }
}

// Admits the (empty) session FIRST, then inflates its live weight outside any
// admission-time budget re-check — the deliberate #5782 fixture shape, since
// pressure is re-evaluated only at admission and at releaseInFlight.
function grow(id: string, chars: number): void {
    const s = getSession(id);
    s.metadata.blob = "x".repeat(chars); // live weight ≈ 32 + chars*2 bytes
    markDirty(s);
}

function poolIds(): string[] {
    return memoryReport().sessions.map(r => r.id).sort();
}

test("#5806: a just-served session survives byte pressure while the giant is in flight; shedding still works once it ages", async () => fixture(async () => {
    // Giant A (in mid-turn, hence in-flight/untouchable) + small B just
    // finished its own request. Pair exceeds BUDGET, and pre-#5806 the only
    // evictable candidate was B — the reported evict-every-round thrash.
    grow("sess-a", 110_000); // ≈220 KiB
    const a = getSession("sess-a");
    acquireInFlight(a);
    grow("sess-b", 110_000);
    const b = getSession("sess-b");
    acquireInFlight(b);
    releaseInFlight(b); // discharge: only B is idle; B was touched milliseconds ago
    assert.deepEqual(poolIds(), ["sess-a", "sess-b"], "recently touched B must ride out the discharge instead of being reloaded next round");

    // Same setup, B already older than the window: ordinary LRU resumes and
    // B absorbs the pressure (pins the other direction of the shield).
    b.lastSeen = Date.now() - AGED_MS;
    releaseInFlight(a); // A leaves flight; now BOTH are idle and over budget
    assert.deepEqual(poolIds(), ["sess-a"], "aged B is sheddable again once past the recent-touch window");
    assert.equal(memoryReport().pool.evictedTotal, 1, "evictions count toward observability");
}));

test("#5806: plain LRU order is untouched while both candidates are outside every window", async () => fixture(async () => {
    // A just outside the window (70 s), B long past it: pure LRU must pick
    // B (the longest-idle) — the shield must not reorder or freeze sessions.
    grow("sess-a", 110_000);
    grow("sess-b", 110_000);
    getSession("sess-a").lastSeen = Date.now() - 70_000;
    getSession("sess-b").lastSeen = Date.now() - AGED_MS;
    releaseInFlight(getSession("sess-a")); // A leaves flight idle; B has been waiting longer
    assert.deepEqual(poolIds(), ["sess-a"], "both windows expired => longest-idle (B) goes, exactly like pre-fix LRU");
}));

test("#5806: count-cap admission overrides the recent-touch window — a full pool still admits", async () => fixture(async () => {
    _resetSessionsForTest(2, 512 * 1024 * 1024); // tiny pool, generous bytes
    grow("sess-1", 1_000);
    grow("sess-2", 1_000);
    assert.equal(_sessionsSizeForTest(), 2);
    const third = getSession("sess-3"); // both residents are FRESH — only the
    // override lets admission proceed at all
    assert.equal(_sessionsSizeForTest(), 2, "one slot freed for the newcomer");
    assert.ok(third, "admission succeeded");
    assert.deepEqual(poolIds().filter(id => id !== "sess-3").length, 1, "exactly one resident absorbed it");

    // Nothing idle (all in-flight) => hard failure, not data loss.
    for (const id of poolIds()) acquireInFlight(getSession(id));
    assert.throws(() => getSession("sess-4"), /session pool exhausted/);
}));

test("#5806: saturation is visible in the report and warned exactly once per interval", async () => fixture(async () => {
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        // Admitted while empty, then grown PAST the entire budget; freshly
        // touched, so nothing may be shed — the pool sits over budget ON PURPOSE.
        const a = getSession("sess-a");
        a.metadata.blob = "x".repeat(200_000); // ≈400 KiB > 300 KiB budget
        markDirty(a);
        acquireInFlight(a);
        releaseInFlight(a); // first discharge over budget with zero candidates
        acquireInFlight(a);
        releaseInFlight(a); // second discharge: rate limiter must swallow it
        const sat = warns.filter(m => m.includes("pool saturated"));
        assert.equal(sat.length, 1, "saturation warn fires once per interval, got: " + JSON.stringify(warns));
        assert.ok(sat[0].includes("releaseInFlight"), "warn names its trigger site");
        const report = memoryReport().pool;
        assert.ok(report.unsatisfiedBytes > report.budgetBytes * 0.2, "report quantifies how far over budget we sit");
        assert.equal(report.evictedTotal, 0, "nothing was evicted in this scenario");
        assert.equal(report.lastEviction, undefined);
    } finally { setLogCapture(null); }
}));

test("#5806: no saturation warn while sheddable victims exist", async () => fixture(async () => {
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        grow("sess-a", 75_000); // ≈150 KiB, freshly touched
        grow("sess-b", 75_000); // ≈150 KiB, then aged past every window
        getSession("sess-b").lastSeen = Date.now() - AGED_MS;
        releaseInFlight(getSession("sess-a")); // pair exceeds budget, B is a real victim
        assert.deepEqual(poolIds(), ["sess-a"]);
        assert.equal(memoryReport().pool.unsatisfiedBytes, 0, "budget satisfied again after shedding");
        assert.equal(warns.filter(m => m.includes("pool saturated")).length, 0, "shedding worked — no saturation claim");
    } finally { setLogCapture(null); }
}));

test("#5806: residentPressure agrees with the recency shield (permanent flips)", async () => fixture(async () => {
    grow("sess-a", 120_000); // ≈240 KiB self
    grow("sess-b", 120_000); // pair well over budget
    // Freshly touched A cannot be repeatedly evicted while use continues =>
    // the refusal wording must NOT call its pressure permanent.
    assert.equal(residentPressure("sess-a").permanent, false, "recently touched session is shielded => not permanently under pressure");
    getSession("sess-a").lastSeen = Date.now() - AGED_MS;
    assert.equal(residentPressure("sess-a").permanent, true, "once outside every window the old #3918 accounting returns");
}));
