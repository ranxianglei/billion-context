// #2773: seam-slot pairing (bs/bl/be on ledger lines) is process-local — the
// first post-restart request loses its #2131 body-stability attribution.
// Regression suite: the last-settled seam slot is projected into the ledger
// (persisted with the session) and rehydrated once per loaded Session object,
// gated by the 30-minute epoch window.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCacheLedger, noteForwardedBody, rehydrateSeamSlot, settleUsageReport, SEAM_SLOT_RESTART_WINDOW_MS } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

const CAP = 512 * 1024;

let seq = 0;
function fakeSession(id: string, metadata?: Record<string, unknown>): Session {
    seq += 1;
    return {
        id,
        metadata: metadata ?? {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
        blockContents: new Map(),
    } as unknown as Session;
}

function sha256hex(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

function firstDiff(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
    return n;
}

function bodyWith(messages: string[]): string {
    return JSON.stringify({ model: "gpt-test", messages: messages.map((c, i) => ({ role: i % 2 ? "assistant" : "user", content: c })) });
}

const USAGE = (total: number) => ({ total, reportedCached: Math.floor(total * 0.9), output: 0, protocol: "openai" as const, upstream: "http://u" });

/** Settle one request on `s` with outbound `body`. */
function turn(s: Session, body: string, msgs: number): void {
    noteForwardedBody(s, body, msgs);
    settleUsageReport(s, USAGE(Math.ceil(body.length / 4)));
}

/** Simulate a proxy restart: fresh Session OBJECT sharing the serialized
 *  metadata (what buildSession reconstructs from disk) under a FOREIGN boot
 *  id, so the next sample is the first-known-after-restart line (rs=1). */
function restart(s: Session): Session {
    const metadata = JSON.parse(JSON.stringify(s.metadata)) as Record<string, unknown>;
    const led = metadata["cacheLedger"] as { lastBoot?: string };
    if (led && typeof led === "object") led.lastBoot = randomUUID();
    return fakeSession(s.id, metadata);
}

before(() => {
    // Incidental markDirty calls inside settle must never touch the disk.
    _setStoreForTest(new SessionStore({ enabled: false }));
});

test("#2773: settled slot is projected into the ledger with capped-head payload", () => {
    const s = fakeSession(`p-${seq}`);
    const body = bodyWith(["hello world", "hi there"]);
    turn(s, body, 2);
    const led = getCacheLedger(s);
    assert.ok(led.seamSlot, "seamSlot projection must be written at settle roll-forward");
    const p = led.seamSlot!;
    assert.equal(p.v, 1);
    assert.equal(p.digest, sha256hex(body));
    assert.equal(p.str, body);
    assert.equal(p.msgs, 2);
    assert.ok(typeof p.at === "number" && Number.isFinite(p.at));
    assert.ok(Date.now() - p.at <= 5000);
});

test("#2773: rehydrated slot attributes the first post-restart line (byte-identical resend → be=1)", () => {
    const a = fakeSession(`r1-${seq}`);
    const body = bodyWith(["stable history", "still stable"]);
    turn(a, body, 2);
    const b = restart(a);
    rehydrateSeamSlot(b);
    turn(b, body, 2);
    const line = getCacheLedger(b).lines[1]!;
    assert.equal(line.rs, 1, "first post-restart known line carries rs");
    assert.equal(line.bd, sha256hex(body));
    assert.equal(line.be, 1, "identical resend across restart must attribute be=1");
    assert.equal(line.bl, undefined);
    assert.equal(line.bs, undefined);
});

test("#2773: genuine mid-history rewrite on the first post-restart request classifies bs=mid (issue edge case)", () => {
    const a = fakeSession(`m-${seq}`);
    const bodyA = bodyWith(["alpha " + "A".repeat(1000), "middle message stays intact", "gamma " + "G".repeat(1000)]);
    turn(a, bodyA, 3);
    const b = restart(a);
    rehydrateSeamSlot(b);
    const bodyB = bodyWith(["alpha " + "A".repeat(1000), "MIDDLE REWRITTEN BY HOST", "gamma " + "G".repeat(1000)]);
    turn(b, bodyB, 3);
    const line = getCacheLedger(b).lines[1]!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "mid", "mid-history divergence must classify as mid, not stay unattributed");
    assert.ok(typeof line.bl === "number" && line.bl > 1024 && line.bl < bodyA.length, `bl=${line.bl} should localize inside the body`);
    assert.equal(line.bl, firstDiff(bodyA, bodyB));
});

test("#2773: head-region rewrite across restart classifies bs=head", () => {
    const a = fakeSession(`h-${seq}`);
    const bodyA = bodyWith(["system-ish first message", "second " + "S".repeat(2000)]);
    turn(a, bodyA, 2);
    const b = restart(a);
    rehydrateSeamSlot(b);
    const bodyB = bodyWith(["CHANGED FIRST MESSAGE", "second " + "S".repeat(2000)]);
    turn(b, bodyB, 2);
    const line = getCacheLedger(b).lines[1]!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "head");
    assert.ok(typeof line.bl === "number" && line.bl < 1024);
});

test("#2773: tail growth across restart classifies bs=append", () => {
    const a = fakeSession(`ap-${seq}`);
    const base = ["one " + "O".repeat(500), "two " + "T".repeat(500)];
    const bodyA = bodyWith(base);
    turn(a, bodyA, 2);
    const b = restart(a);
    rehydrateSeamSlot(b);
    const bodyB = bodyWith([...base, "three " + "U".repeat(500)]);
    turn(b, bodyB, 3);
    const line = getCacheLedger(b).lines[1]!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "append");
    assert.equal(line.bl, firstDiff(bodyA, bodyB));
});

test("#2773: slot older than the epoch window is refused (no false pairing across long downtime)", () => {
    const a = fakeSession(`st-${seq}`);
    const body = bodyWith(["history", "more"]);
    turn(a, body, 2);
    getCacheLedger(a).seamSlot!.at = Date.now() - SEAM_SLOT_RESTART_WINDOW_MS - 60_000;
    const b = restart(a);
    rehydrateSeamSlot(b);
    turn(b, body, 2);
    const line = getCacheLedger(b).lines[1]!;
    assert.equal(line.bd, sha256hex(body), "digest stamping is unaffected");
    assert.equal(line.be, undefined, "stale slot must not pair");
    assert.equal(line.bs, undefined);
});

test("#2773: boundary slot AT the window edge still pairs (guard is strictly greater)", () => {
    const a = fakeSession(`edge-${seq}`);
    const body = bodyWith(["history", "more"]);
    turn(a, body, 2);
    getCacheLedger(a).seamSlot!.at = Date.now() - (SEAM_SLOT_RESTART_WINDOW_MS - 60_000);
    const b = restart(a);
    rehydrateSeamSlot(b);
    turn(b, body, 2);
    assert.equal(getCacheLedger(b).lines[1]!.be, 1);
});

test("#2773: capped prev head degrades to bs=unknown instead of manufacturing a class", () => {
    const a = fakeSession(`cap-${seq}`);
    const big = "X".repeat(CAP + 88_000);
    const bodyA = bodyWith([big]);
    assert.ok(bodyA.length > CAP);
    turn(a, bodyA, 1);
    const p = getCacheLedger(a).seamSlot!;
    assert.equal(p.str.length, CAP, "persisted head is capped at SEAM_BODY_CAP");
    const b = restart(a);
    rehydrateSeamSlot(b);
    // Divergence BEYOND the stored head: digests differ, but the truncated
    // prev head cannot localize it — must degrade like the live over-cap case.
    const bodyB = bodyWith([big.slice(0, CAP + 40_000) + "Y" + big.slice(CAP + 40_001)]);
    assert.notEqual(sha256hex(bodyB), sha256hex(bodyA));
    turn(b, bodyB, 1);
    const line = getCacheLedger(b).lines[1]!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "unknown", "truncated prev head must not fabricate append/mid/head");
    assert.equal(line.bl, undefined);
});

test("#2773: malformed projections are dropped silently (never a crash, never a seed)", () => {
    const a = fakeSession(`bad-${seq}`);
    const bodyA = bodyWith(["original", "original2"]);
    turn(a, bodyA, 2);
    const good = getCacheLedger(a).seamSlot!;

    // Each case starts from the FULL serialized metadata (so the post-restart
    // session carries the pre-restart ledger line) with only the projection
    // mutated.
    const cases: Array<[string, (led: { seamSlot?: unknown }) => void]> = [
        ["missing slot", (led) => { delete led.seamSlot; }],
        ["null slot", (led) => { led.seamSlot = null; }],
        ["wrong version", (led) => { led.seamSlot = { ...good, v: 2 }; }],
        ["missing version", (led) => { led.seamSlot = { at: good.at, digest: good.digest, msgs: 2, str: good.str }; }],
        ["non-finite at", (led) => { led.seamSlot = { ...good, at: NaN }; }],
        ["string at", (led) => { led.seamSlot = { ...good, at: "now" }; }],
        ["short digest", (led) => { led.seamSlot = { ...good, digest: "abc" }; }],
        ["empty str", (led) => { led.seamSlot = { ...good, str: "" }; }],
        ["non-string str", (led) => { led.seamSlot = { ...good, str: 42 }; }],
    ];
    for (const [name, mutate] of cases) {
        const metadata = JSON.parse(JSON.stringify(a.metadata)) as Record<string, unknown>;
        const led = metadata["cacheLedger"] as { seamSlot?: unknown };
        mutate(led);
        const b = fakeSession(`bad-${name}-${seq}`, metadata);
        rehydrateSeamSlot(b);
        turn(b, bodyWith(["different", "different2"]), 2);
        const line = getCacheLedger(b).lines[1]!;
        assert.equal(line.be, undefined, `${name}: no pairing may happen`);
        assert.equal(line.bs, undefined, `${name}: no classification may happen`);
    }
    // msgs normalization: a garbage msgs value degrades to null, pairing still works.
    const metadata = JSON.parse(JSON.stringify(a.metadata)) as Record<string, unknown>;
    (metadata["cacheLedger"] as { seamSlot?: unknown }).seamSlot = { ...good, msgs: "garbage" };
    const c = fakeSession(`bad-msgs-${seq}`, metadata);
    rehydrateSeamSlot(c);
    turn(c, bodyA, 2);
    assert.equal(getCacheLedger(c).lines[1]!.be, 1, "garbage msgs normalizes to null; digest pairing holds");
});

test("#2773: rehydrate is once-per-object — a later call must not clobber the live rolled-forward slot", () => {
    const a = fakeSession(`once-${seq}`);
    const bodyA = bodyWith(["pre-restart body", "pre2"]);
    turn(a, bodyA, 2);
    const staleProjection = JSON.parse(JSON.stringify(getCacheLedger(a).seamSlot!));
    const b = restart(a);
    rehydrateSeamSlot(b);
    const bodyB = bodyWith(["post-restart body", "post2"]);
    turn(b, bodyB, 2);
    // Disk still shows the PRE-restart projection; a buggy re-seed would pair
    // the next turn against it. Restore the stale projection and re-invoke.
    getCacheLedger(b).seamSlot = staleProjection;
    rehydrateSeamSlot(b);
    turn(b, bodyB, 2);
    const line = getCacheLedger(b).lines[2]!;
    assert.equal(line.be, 1, "pairing must use the live in-memory slot, not re-read the stale projection");
});

test("#2773: end-to-end through the real store — writeNow/loadSync rehydrates and attributes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-2773-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 0 });
        const a = fakeSession("sess-2773-e2e");
        const bodyA = bodyWith(["alpha " + "A".repeat(1000), "middle stays", "gamma " + "G".repeat(1000)]);
        turn(a, bodyA, 3);
        await store.writeNow(a);
        const b = store.loadSync("sess-2773-e2e");
        assert.ok(b, "session must load back");
        // loadSync went through buildSession — the rehydrate already happened
        // there; simulate the foreign boot so this is the post-restart line.
        (b.metadata["cacheLedger"] as { lastBoot?: string }).lastBoot = randomUUID();
        const bodyB = bodyWith(["alpha " + "A".repeat(1000), "MIDDLE REWRITTEN", "gamma " + "G".repeat(1000)]);
        turn(b, bodyB, 3);
        const line = getCacheLedger(b).lines[1]!;
        assert.equal(line.rs, 1);
        assert.equal(line.be, 0);
        assert.equal(line.bs, "mid", "buildSession wiring must rehydrate the slot (end-to-end)");
        assert.equal(line.bl, firstDiff(bodyA, bodyB));
        assert.equal(line.bd, sha256hex(bodyB));
        store.cancelAll();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
