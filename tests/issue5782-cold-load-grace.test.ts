// #5782: when the resident pool's byte budget is smaller than the ACTIVE
// working set, the old strict enforcement evicted sessions that had JUST been
// re-materialized from disk — every touch paid the full cold-load rebuild
// again (the reporter measured 308 reloads of one session inside 60 s), and
// the re-minted giant temporaries flooded large_object_space until the proxy
// hit its own heap ceiling. The fix gives a freshly cold-loaded session a
// grace window during which BYTE-budget eviction skips it (the hot working
// set may sit over budget instead of thrashing); COUNT-cap admission still
// overrides the window (a full pool must admit); and the #3918 permanent-
// refusal claim reverts to transient while the session is graced-resident.
// Gate discipline (#3617): every direction is pinned both ways — grace
// shields AND expires; count-cap overrides grace AND non-graced victims are
// still preferred first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, acquireInFlight, releaseInFlight, markDirty, residentPressure, memoryReport, _resetSessionsForTest, _sessionsSizeForTest } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

const BUDGET = 300_000;

function fixture(run: () => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-5782-"));
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

function poolIds(): string[] {
    return memoryReport().sessions.map(r => r.id).sort();
}

test("#5782: a freshly cold-loaded session survives byte-pressure eviction; the non-graced peer absorbs it", async () => fixture(async () => {
    // Phase 1 — fresh-created sessions carry NO grace: A is grown past its
    // share of the budget and the discharge loop evicts it exactly like the
    // pre-fix behavior (it has never been re-materialized).
    const a = getSession("sess-a");
    a.metadata.blob = "a".repeat(100_000); // ≈200 KiB live weight
    markDirty(a);
    acquireInFlight(a);
    releaseInFlight(a);
    const b = getSession("sess-b");
    b.metadata.blob = "b".repeat(60_000); // ≈120 KiB → pair exceeds BUDGET
    markDirty(b);
    acquireInFlight(b);
    releaseInFlight(b); // discharge: oldest idle (A, ungraced) goes
    assert.deepEqual(poolIds(), ["sess-b"], "A evicted while ungraced — fresh creates are not protected");
    assert.equal(memoryReport().sessions.find(r => r.id === "sess-b")?.coldLoadedAt, undefined, "fresh-create rows carry no cold-load stamp");

    // Phase 2 — touching A again is a real memory miss: the reload pays the
    // full rebuild, stamps the grace, and the adoption path must NOT evict A
    // to make room — the non-graced peer absorbs the pressure instead.
    const a2 = getSession("sess-a");
    assert.notEqual(a2, a, "reload built a NEW object");
    assert.ok(a2.coldLoadedAt !== undefined && Date.now() - a2.coldLoadedAt < 5_000, "cold-load stamp present after reload");
    assert.equal(memoryReport().sessions.find(r => r.id === "sess-a")?.coldLoadedAt, a2.coldLoadedAt, "report row exposes the stamp");
    assert.deepEqual(poolIds(), ["sess-a"], "graced reload kept; ungraced peer B absorbed the byte pressure");

    // Phase 3 — the over-budget working set coexists: B reloads, adoption
    // finds only graced candidates, and the pool sits OVER budget instead of
    // evicting A again (the old code ping-ponged here every round).
    const b2 = getSession("sess-b");
    assert.notEqual(b2, b, "B was reloaded too");
    assert.deepEqual(poolIds(), ["sess-a", "sess-b"], "both working-set members resident");
    assert.ok(memoryReport().pool.residentBytes > BUDGET, `hot working set tolerably over budget (${memoryReport().pool.residentBytes} > ${BUDGET})`);
    acquireInFlight(b2);
    releaseInFlight(b2); // discharge: everyone idle-and-graced → nothing goes
    assert.deepEqual(poolIds(), ["sess-a", "sess-b"], "discharge loop stops at the grace boundary instead of re-evicting");

    // Negative direction — grace is a WINDOW, not a pin: once A ages out of
    // it, normal LRU resumes and the byte budget means what it said before.
    a2.coldLoadedAt = Date.now() - 11 * 60_000;
    acquireInFlight(b2);
    releaseInFlight(b2);
    assert.deepEqual(poolIds(), ["sess-b"], "grace expired → A evicted by ordinary LRU again");
}));

test("#5782: a full pool still admits when every idle candidate is graced (count-cap overrides grace, logged loudly)", async () => fixture(async () => {
    _resetSessionsForTest(2, Number.MAX_SAFE_INTEGER);
    const lines: string[] = [];
    setLogCapture((level, msg) => { if (level === "info" || level === "warn") lines.push(msg); });
    try {
        const a = getSession("s-a");
        a.metadata.blob = "a".repeat(10_000);
        markDirty(a);
        const b = getSession("s-b");
        b.metadata.blob = "b".repeat(10_000);
        markDirty(b);
        a.coldLoadedAt = Date.now();
        b.coldLoadedAt = Date.now();
        const c = getSession("s-c");
        assert.ok(c, "admission did not throw");
        assert.equal(_sessionsSizeForTest(), 2, "pool stayed at the count cap");
        assert.ok(poolIds().includes("s-c"), "C admitted");
        assert.ok(!poolIds().includes("s-a") || !poolIds().includes("s-b"), "one graced victim freed the slot");
        assert.ok(lines.some(l => l.includes("cold-load grace overridden for count-cap admission")), `override logged loudly: ${JSON.stringify(lines)}`);
    } finally {
        setLogCapture(null);
    }
}));

test("#5782: the count-cap override keeps the PRE-FIX victim choice — globally oldest idle, graced or not", async () => fixture(async () => {
    _resetSessionsForTest(2, Number.MAX_SAFE_INTEGER);
    const a = getSession("t-a");
    a.metadata.blob = "a".repeat(10_000);
    markDirty(a);
    a.coldLoadedAt = Date.now(); // graced but OLDEST by lastSeen
    const d = getSession("t-d");
    d.metadata.blob = "d".repeat(10_000);
    markDirty(d); // ungraced, newer
    const e = getSession("t-e"); // count-cap guard fires: size 2 >= max 2
    assert.ok(e, "admission did not throw");
    assert.deepEqual(poolIds(), ["t-d", "t-e"], "victim = globally oldest idle (pre-fix LRU), even though it is graced — the byte path is the one grace protects");
}));

test("#5782/#3918: an evicted session stays 'permanent' until its reload grants grace, then flips back to transient", async () => fixture(async () => {
    const big = getSession("big-sess");
    const peer = getSession("peer-sess");
    big.metadata.blob = "x".repeat(100_000); // ≈200 KiB
    peer.metadata.blob = "y".repeat(60_000); // ≈120 KiB → pair exceeds BUDGET
    markDirty(big);
    markDirty(peer);
    acquireInFlight(big);
    releaseInFlight(big); // discharge evicts big (oldest idle, ungraced)
    assert.deepEqual(poolIds(), ["peer-sess"]);
    const evicted = residentPressure("big-sess");
    assert.ok(evicted.permanent, "evicted + over budget → permanent (unchanged #3918 semantics)");
    const reloaded = getSession("big-sess"); // memory miss → reload → grace
    assert.ok(reloaded.coldLoadedAt !== undefined, "reload stamped the grace");
    const graced = residentPressure("big-sess");
    assert.equal(graced.permanent, false, "graced-resident → the retry heals → transient wording returns");
}));

test("#5782: a session heavier than the WHOLE budget warns once per cold load with the actionable exit", async () => fixture(async () => {
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        const heavy = getSession("heavy");
        heavy.metadata.blob = "h".repeat(200_000); // ≈400 KiB > BUDGET
        markDirty(heavy);
        acquireInFlight(heavy);
        releaseInFlight(heavy); // sole ungraced resident → evicted by discharge
        assert.deepEqual(poolIds(), [], "ungraced heavy session evicted like before");
        const reloaded = getSession("heavy"); // reload → grace + warn
        assert.ok(reloaded.coldLoadedAt !== undefined);
        assert.ok(warns.some(w => w.includes("exceeds the WHOLE resident pool budget") && w.includes("BILI_SESSION_RESIDENT_MAX_BYTES")), `actionable warn emitted: ${JSON.stringify(warns)}`);
        const small = getSession("small-sess"); // a normal small reload must NOT warn
        small.metadata.blob = "s".repeat(1_000);
        markDirty(small);
        assert.equal(warns.length, 1, "warn is tied to the over-budget measurement, not to every reload");
    } finally {
        setLogCapture(null);
    }
}));
