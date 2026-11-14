import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Session } from "../src/session.ts";
import { getCacheLedger, liveBlockIds, recordCacheFoldsFromBlocks, recordCacheSample } from "../src/cache-ledger.ts";
import { setLogCapture } from "../src/logger.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { buildOverview, buildSessionList, _resetDiskCacheForTest } from "../src/web/sessions-data.ts";
import { rmrf } from "./tmp-rm.ts";

// #5646: a fold's avoided-token accrual may only grow while its kernel block
// still ALIVES in the session's compression state. Reaped (#2695), host-dropped
// or orphaned-under-a-dead-ancestor blocks no longer represent spared content,
// so booking further requests against them inflated grossSaved/netSaved past
// any physical bound in long plugin-mode sessions (the issue's 15.5× figure).
// This test drives the real seam: recordCacheFoldsFromBlocks (sets LedgerFold.bid)
// → liveBlockIds liveness snapshot → recordCacheSample (freezes requestsAfter for
// dead folds), plus the one-time transition warns and the self-heal path. No
// server, no network, deterministic clocks.

const T0 = 1_000_000;

function makeSession(id: string): Session {
    return {
        id,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

interface FakeBlockOpts {
    S?: number;
    summaryLen?: number;
    directBlockIds?: string[];
}

let blockSeq = 0;
function materializeFold(session: Session, at: number, opts: FakeBlockOpts = {}): string {
    blockSeq += 1;
    const blockId = `b${blockSeq}`;
    const b = {
        active: true,
        blockId,
        createdAt: at,
        compressedTokens: opts.S ?? 5000,
        summary: "s".repeat(opts.summaryLen ?? 400),
        effectiveMessageIds: [`m${blockSeq}`],
        ...(opts.directBlockIds ? { directBlockIds: opts.directBlockIds } : {}),
    } as never;
    session.state.blocks.push(b);
    recordCacheFoldsFromBlocks(session, [b], { V: 10000, Vp: 2000 });
    return blockId;
}

type LogLine = { level: string; msg: string };

test("nested tiers keep accruing while alive; reaping the root freezes root AND orphaned child (#5646)", () => {
    const logs: LogLine[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    try {
        const session = makeSession("cl5646-nested");
        blockSeq = 0;
        recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });

        // Tier-1 fold b1 (S=5000, sigma=100).
        materializeFold(session, T0 + 1500);
        const led = getCacheLedger(session);
        assert.equal(led.folds.length, 1);
        for (let i = 0; i < 3; i++) {
            recordCacheSample(session, { at: T0 + 2000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 3);

        // Tier-2 fold b2 consumes b1 (kernel shape: child deactivated in place,
        // parent S counts the child's SUMMARY — telescoping keeps both terms valid).
        const b1 = session.state.blocks[0] as { active: boolean };
        b1.active = false;
        materializeFold(session, T0 + 4500, { S: 5100, directBlockIds: ["b1"] });
        for (let i = 0; i < 3; i++) {
            recordCacheSample(session, { at: T0 + 5000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 6, "superseded-but-anchored child keeps accruing (telescoping intact)");
        assert.equal(led.folds[1].requestsAfter, 3, "tier-2 root accrues");
        assert.equal(logs.filter((l) => l.msg.includes("block dead")).length, 0, "no death while the tree is alive");

        // REAP: the host removes the root from state (zombie-substrate reap, #2695).
        // The inactive child remains in state but is now ORPHANED under a dead ancestor.
        session.state.blocks.splice(1, 1);
        for (let i = 0; i < 3; i++) {
            recordCacheSample(session, { at: T0 + 8000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 6, "orphaned child freezes when its ancestor dies");
        assert.equal(led.folds[1].requestsAfter, 3, "reaped root freezes");
        const deadWarns = logs.filter((l) => l.level === "warn" && l.msg.includes("block dead"));
        assert.equal(deadWarns.length, 2, "exactly one transition warn per dead fold");
        assert.ok(deadWarns.some((l) => l.msg.includes("(block b1)")), "warn names the child block");
        assert.ok(deadWarns.some((l) => l.msg.includes("(block b2)")), "warn names the root block");
    } finally {
        setLogCapture(null);
    }
});

test("self-heal: a block that returns to state resumes accruing (#5646)", () => {
    const logs: LogLine[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    try {
        const session = makeSession("cl5646-heal");
        blockSeq = 0;
        recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
        materializeFold(session, T0 + 1500);
        const led = getCacheLedger(session);
        recordCacheSample(session, { at: T0 + 2000, input: 10000, cached: 9000 });
        assert.equal(led.folds[0].requestsAfter, 1);

        // Host drops the block out of state (restart / resync gap).
        const removed = session.state.blocks.pop()!;
        recordCacheSample(session, { at: T0 + 3000, input: 10000, cached: 9000 });
        assert.equal(led.folds[0].requestsAfter, 1, "frozen while absent");

        // Host resync restores the same block id into state.
        session.state.blocks.push(removed);
        recordCacheSample(session, { at: T0 + 4000, input: 10000, cached: 9000 });
        assert.equal(led.folds[0].requestsAfter, 2, "accrual resumes when the block returns");
        assert.equal(logs.filter((l) => l.msg.includes("block dead")).length, 1, "one warn for the single death");
    } finally {
        setLogCapture(null);
    }
});

test("legacy folds without a block link and absent state stay unverifiable → status quo (#5646)", () => {
    const logs: LogLine[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    try {
        const session = makeSession("cl5646-legacy");
        blockSeq = 0;
        recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
        materializeFold(session, T0 + 1500);
        const led = getCacheLedger(session);
        delete led.folds[0].bid;
        session.state.blocks.length = 0;
        for (let i = 0; i < 3; i++) {
            recordCacheSample(session, { at: T0 + 2000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 3, "unverifiable fold keeps the pre-fix counter");
        assert.equal(logs.filter((l) => l.msg.includes("block dead")).length, 0, "unverifiable ≠ dead: no warn");
    } finally {
        setLogCapture(null);
    }
});

test("marathon shape: mass folded early and reaped mid-session stops compounding (#5646)", () => {
    setLogCapture(() => undefined);
    try {
        const session = makeSession("cl5646-marathon");
        blockSeq = 0;
        recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
        // One big fold: S=1M, sigma=100 → ~999_900 avoided per request while alive.
        materializeFold(session, T0 + 1500, { S: 1_000_000 });
        const led = getCacheLedger(session);
        for (let i = 0; i < 10; i++) {
            recordCacheSample(session, { at: T0 + 2000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 10);
        // The block dies at request 12 of a 32-request session.
        session.state.blocks.length = 0;
        for (let i = 0; i < 20; i++) {
            recordCacheSample(session, { at: T0 + 13000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 10, "counter frozen at death, not grown to 30");
        const grossSaved = (led.folds[0].S - led.folds[0].sigma) * led.folds[0].requestsAfter;
        assert.equal(grossSaved, 999_900 * 10, "grossSaved reflects requests actually spared, not the whole tail");
    } finally {
        setLogCapture(null);
    }
});

test("liveBlockIds: alive = active roots plus everything anchored beneath them", () => {
    const blocks = [
        { blockId: "b1", active: false, directBlockIds: [] },
        { blockId: "b2", active: false, directBlockIds: ["b1"] },
        { blockId: "b3", active: true, directBlockIds: ["b2"] },
        { blockId: "b4", active: false, directBlockIds: [] },
    ];
    assert.deepEqual([...liveBlockIds(blocks)].sort(), ["b1", "b2", "b3"], "consumed descendants stay alive under their root; unanchored inactive block is dead");

    // Dead root orphans its whole subtree.
    const noRoot = blocks.filter((b) => b.blockId !== "b3");
    assert.deepEqual(liveBlockIds(noRoot), new Set(), "orphaned subtree is entirely dead");

    // Cycle-safe traversal (corrupted directBlockIds pointing back up).
    const cyclic = [
        { blockId: "x1", active: true, directBlockIds: ["x2"] },
        { blockId: "x2", active: true, directBlockIds: ["x1"] },
    ];
    assert.deepEqual([...liveBlockIds(cyclic)].sort(), ["x1", "x2"], "cycles terminate");

    // Empty / id-less lists carry no information (callers treat them as unverifiable).
    assert.deepEqual(liveBlockIds([]), new Set());
    assert.deepEqual(liveBlockIds([{ active: true }]), new Set());
});

// ---- display side: the frozen share reconciles in the web payloads ----

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-issue5646-hermetic-")), "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

interface DisplayStats {
    requests: number;
    tokensSaved: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    contextTokens: number;
}

function makeDisplaySession(id: string, patch: Partial<DisplayStats>, metadata: Record<string, unknown>, blocks: unknown[]): Session {
    return {
        id,
        meta: { protocol: "openai" },
        stats: { requests: 5, tokensSaved: 0, inputTokens: 1000, cachedTokens: 400, outputTokens: 10, contextTokens: 500, ...patch },
        metadata,
        state: { blocks, messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as unknown as Session;
}

function withSessionsDir<T>(name: string, fn: (dir: string) => Promise<T>): void {
    test(name, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-issue5646-"));
        const prev = process.env.BILI_SESSIONS_DIR;
        process.env.BILI_SESSIONS_DIR = dir;
        try {
            await fn(dir);
        } finally {
            if (prev === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prev;
            _resetDiskCacheForTest();
            rmrf(dir);
        }
    });
}

withSessionsDir("overview marks dead-fold frozen share and flags savings as estimated (#5646)", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    // Session A: one fold whose block LEFT the state (dead) — 10 requests accrued
    // before death, (S−sigma)=999_900 → 9_999_000 frozen.
    await store.writeNow(makeDisplaySession(
        "d5646-dead",
        { requests: 32, inputTokens: 320_000 },
        { cacheLedger: { agg: { requests: 32 }, folds: [{ seq: 1, at: T0 + 1500, S: 1_000_000, sigma: 100, T: 0, hPct: null, requestsAfter: 10, k: null, bid: "b1" }] } },
        [],
    ));
    // Session B: fold with its block still alive → nothing dead, nothing frozen.
    await store.writeNow(makeDisplaySession(
        "d5646-alive",
        { requests: 8, inputTokens: 80_000 },
        { cacheLedger: { agg: { requests: 8 }, folds: [{ seq: 1, at: T0 + 1500, S: 20_000, sigma: 100, T: 0, hPct: null, requestsAfter: 4, k: null, bid: "b1" }] } },
        [{ blockId: "b1", active: true, compressedTokens: 20_000, summary: "s".repeat(400) }],
    ));
    // Session C: synthetic id-less blocks (unified-index row shape) → UNVERIFIABLE,
    // never marked dead even though the fold's bid matches nothing.
    await store.writeNow(makeDisplaySession(
        "d5646-idless",
        { requests: 6, inputTokens: 60_000 },
        { cacheLedger: { agg: { requests: 6 }, folds: [{ seq: 1, at: T0 + 1500, S: 30_000, sigma: 100, T: 0, hPct: null, requestsAfter: 2, k: null, bid: "b9" }] } },
        [{ topic: "no id here", summary: "synthetic", active: true, compressedTokens: 30_000 }],
    ));

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
    const list = await buildSessionList();
    const dead = list.find((s) => s.id === "d5646-dead");
    assert.ok(dead, "dead session present in the list");
    assert.equal(dead.grossSaved, 999_900 * 10);
    assert.equal(dead.blockDeadFolds, 1, "dead fold counted");
    assert.equal(dead.blockDeadFrozenTokens, 999_900 * 10, "its full accrued share is the frozen share");

    const alive = list.find((s) => s.id === "d5646-alive");
    assert.equal(alive?.blockDeadFolds, undefined, "live block → no dead marking");

    const idless = list.find((s) => s.id === "d5646-idless");
    assert.equal(idless?.blockDeadFolds, undefined, "id-less synthetic blocks stay unverifiable, never marked dead");

    const ov = await buildOverview();
    assert.equal(ov.blockDeadFoldTotal, 1);
    assert.equal(ov.blockDeadFrozenTotal, 999_900 * 10);
    assert.ok(ov.grossSavedTotal > 0);
    assert.equal(ov.savingsEstimated, true, "any non-zero gross total is flagged as an estimate");
});
