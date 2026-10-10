import { test } from "node:test";
import assert from "node:assert";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { reconcileFoldCoverage } from "../src/fold-reconcile.ts";
import { getCacheLedger, recordCacheFoldsFromBlocks, recordCacheSample } from "../src/cache-ledger.ts";
import { setLogCapture } from "../src/logger.ts";

// #2202: the ledger may only book a request against a fold while that fold's
// covered bytes are actually on the resent wire. This test drives the REAL
// seam end to end — recordCacheFoldsFromBlocks (sets LedgerFold.bid) →
// reconcileFoldCoverage (writes the per-block coverage record) →
// recordCacheSample (scales requestsAfter by the measured fraction) — plus
// the one-time transition logs. No server, no network, deterministic clocks.

const T0 = 1_000_000;
const COVERED = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];

function makeSession(id: string): Session {
    return {
        id,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const mk = (id: string, text: string): CoreMessage =>
    ({ id, role: "user", contentType: "text", text }) as unknown as CoreMessage;

// Conversation-sized passes: covered originals ride along verbatim (the shape
// every real host resends while bili strips outbound) vs pure filler.
const healthyPass = (): CoreMessage[] => [
    ...COVERED.map((id, i) => mk(id, `covered original ${i} payload words`)),
    ...Array.from({ length: 10 }, (_, i) => mk(`f${i}`, `filler turn index ${i} padding words`)),
];
const shadowedPass = (): CoreMessage[] =>
    Array.from({ length: 12 }, (_, i) => mk(`sh${i}`, `post-shadow turn index ${i} padding words`));

function materializeFold(session: Session, at: number): void {
    const b = {
        active: true,
        blockId: "b1",
        createdAt: at,
        compressedTokens: 5000,
        summary: "s".repeat(400),
        effectiveMessageIds: [...COVERED],
    } as never;
    // Production shape: applyRanges writes the kernel state back, so the block
    // is IN session.state.blocks by the time the next pass reconciles.
    session.state.blocks.push(b);
    recordCacheFoldsFromBlocks(session, [b], { V: 10000, Vp: 2000 });
}

type LogLine = { level: string; msg: string };

test("verified loss freezes accrual; recovery resumes; legacy and never-present keep status quo (#2202)", () => {
    const logs: LogLine[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    try {
        const session = makeSession("cl2202");
        // Pre-fold baseline bill, then the fold lands (S=5000, sigma=100).
        recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
        materializeFold(session, T0 + 1500);
        const led = getCacheLedger(session);
        assert.equal(led.folds.length, 1);
        assert.equal(led.folds[0].bid, "b1", "fold carries its block link");

        // ---- healthy: covered ids present every pass → full accrual ----
        reconcileFoldCoverage(session, healthyPass(), { mode: "repair", sessionId: session.id });
        for (let i = 0; i < 3; i++) {
            recordCacheSample(session, { at: T0 + 2000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 3, "full coverage books one request per sample");
        // Re-read after each pass: reconcile REPLACES the record object.
        const covOf = () => (session.metadata["foldCoverageByBlock"] as Record<string, { p: number; r: number; t: number; e?: 1; z?: number }> | undefined);
        assert.deepEqual(covOf()?.b1, { p: 7, r: 0, t: 7, e: 1, z: 0 });

        // ---- shadowed: host drops the covered originals off the wire ----
        reconcileFoldCoverage(session, shadowedPass(), { mode: "repair", sessionId: session.id });
        assert.deepEqual(covOf()?.b1, { p: 0, r: 0, t: 7, e: 1, z: 1 }, "ever flag survives the loss; zombie streak starts (#2695)");
        for (let i = 0; i < 3; i++) {
            recordCacheSample(session, { at: T0 + 5000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 3, "verified coverage-lost freezes accrual");
        const lostWarns = logs.filter((l) => l.level === "warn" && l.msg.includes("coverage-lost"));
        assert.equal(lostWarns.length, 1, "exactly one transition warn across all frozen samples");
        assert.match(lostWarns[0].msg, /requestsAfter=3\.0/, "warn names the frozen counter");

        // ---- recovery: originals re-enter the wire ----
        reconcileFoldCoverage(session, healthyPass(), { mode: "repair", sessionId: session.id });
        recordCacheSample(session, { at: T0 + 8000, input: 10000, cached: 9000 });
        assert.equal(led.folds[0].requestsAfter, 4, "accrual resumes when coverage returns");
        assert.equal(logs.filter((l) => l.level === "info" && l.msg.includes("coverage restored")).length, 1);
    } finally {
        setLogCapture(null);
    }
});

test("no evidence pass at all → legacy byte-identical accrual, no transition noise (#2202)", () => {
    const logs: LogLine[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    try {
        const session = makeSession("cl2202-legacy");
        recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
        materializeFold(session, T0 + 1500);
        const led = getCacheLedger(session);
        for (let i = 0; i < 3; i++) {
            recordCacheSample(session, { at: T0 + 2000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 3, "unverifiable fold keeps the pre-#2202 counter");
        assert.equal(logs.filter((l) => l.msg.includes("coverage-lost")).length, 0, "unverifiable ≠ lost: no warn");
    } finally {
        setLogCapture(null);
    }
});

test("never-present class stays unverifiable even when everything looks missing (#2202)", () => {
    const logs: LogLine[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    try {
        // A view-folding host whose resends NEVER carry raw originals: the first
        // evidence pass already shows total absence. Freezing here would silently
        // zero netSaved for whole session classes — so booking stays status quo.
        const session = makeSession("cl2202-never");
        recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
        materializeFold(session, T0 + 1500);
        const led = getCacheLedger(session);
        reconcileFoldCoverage(session, shadowedPass(), { mode: "repair", sessionId: session.id });
        const cov = session.metadata["foldCoverageByBlock"] as Record<string, { p: number; r: number; t: number; e?: 1 }>;
        assert.equal(cov.b1.e, undefined, "never observed present → no latch");
        for (let i = 0; i < 3; i++) {
            recordCacheSample(session, { at: T0 + 2000 + i * 1000, input: 10000, cached: 9000 });
        }
        assert.equal(led.folds[0].requestsAfter, 3, "status-quo accrual for the unverifiable class");
        assert.equal(logs.filter((l) => l.msg.includes("coverage-lost")).length, 0);
    } finally {
        setLogCapture(null);
    }
});
