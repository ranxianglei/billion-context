/**
 * #6181 item 3 — resetSessionCompression completeness guard.
 *
 * resetSessionCompression is a hand-enumerated, field-by-field clear of
 * per-turn compression state after a host-native-compaction rebase. Every line
 * in it carries an issue comment, so the failure mode is: someone adds a new
 * state field to `Session` and forgets to handle it here, silently leaking
 * stale state across the ref-space reset (the #5984 class).
 *
 * Two layers of teeth:
 *   1. COMPILE-TIME (in src/session.ts): every `keyof Session` must appear in
 *      exactly one of RESET_SESSION_FIELDS / INTENTIONAL_WRITE_SESSION_FIELDS /
 *      PRESERVED_SESSION_FIELDS, else `UncoveredSessionFields` stops being
 *      `never` and the build fails naming the unclassified field. This test
 *      imports those lists, so it tracks the source of truth automatically.
 *   2. RUNTIME (here): drive a fully-populated session through a real
 *      resetSessionCompression and assert each bucket holds its contract, plus
 *      pin the stats/metadata SUB-field surface (where the #5984 free-form-key
 *      gap lived) so partial touches stay visible.
 *
 * Known boundary (documented, NOT fixed — #6181 item 1 / discussion #5874
 * proposal 6): `session.metadata` is a free-form Record<string, unknown>, so
 * ad-hoc keys (e.g. COMPRESS_LOOP_KEY = "compressFailStreak" at
 * src/stream.ts:231) sit outside the typed surface and cannot be enumerated
 * here. Proposal 6's identity+snapshot reconciliation is the structural
 * replacement for this whole mechanism.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import {
    createSession,
    resetSessionCompression,
    zeroStats,
    RESET_SESSION_FIELDS,
    INTENTIONAL_WRITE_SESSION_FIELDS,
    PRESERVED_SESSION_FIELDS,
    type BlockContent,
    type Session,
} from "../src/session.ts";

process.env.BILI_PERSIST = "0";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "issue6181-reset-")), "missing.json");

const ALL_SURFACE_FIELDS = [
    ...RESET_SESSION_FIELDS,
    ...INTENTIONAL_WRITE_SESSION_FIELDS,
    ...PRESERVED_SESSION_FIELDS,
];

/** Populate every top-level Session field with an observable sentinel so that
 *  "reset left it alone" is distinguishable from "it happened to already be
 *  undefined". Opaque collections use `as never` (repo test idiom); everything
 *  else is constructed against its real type. */
function populate(s: Session): void {
    // RESET targets
    s.state = createInitialState();                                  // distinct instance; reset replaces wholesale
    s.blockContents.set("b1", {} as BlockContent);                   // populated; reset .clear()s in place
    s.contentStore = {} as never;                                    // set; reset -> undefined
    s.pendingRetrievals = [{ ref: "m5", reason: "probe" }] as never; // populated; reset .length = 0

    // INTENTIONAL_WRITE pre-values (each flipped/written by reset)
    s.contentStoreDirty = false;                                     // reset -> true
    s.ccrReconcilePending = true;                                    // reset -> false
    s.revisionEpoch = 42;                                            // reset (markDirty) -> 43

    // PRESERVED sentinels (reference identity must hold after reset)
    s.transient = {} as never;
    s.restampSuperseded = new Map([["m1", "old"]]);
    s.pendingLedgerAlign = true;
    s.lastMessages = [] as never;
    s.lastMessagesFolded = true;
    s.pluginSnapshot = [] as never;
    s.decompositionLog = [] as never;
    s.pluginRevisionCache = { epoch: 1, revision: "rev-x" };
    s.retrieveCountsByRef = new Map([["m1", 2]]);
    s.incomingImageIndex = new Map([["m1", [{ mediaType: "image/png", bytes: 5, path: "/x" }]]]);
    s.lastImgPrune = 12345;
    s.inFlight = 2;
    s.restored = true;
    s.coldLoadedAt = 999;
    s.lastCompress = { at: 1, shrinkRatio: 0.5, foldPoint: "m3", blocks: 2, tokensCompressed: 100 };
    s.lockChain = Promise.resolve();

    // stats: cumulative billing counters (must SURVIVE) + per-turn estimate
    // sub-fields (zeroed or deleted by reset)
    s.stats = {
        ...zeroStats(),
        requests: 5, inputTokens: 100, outputTokens: 40, cachedTokens: 10,
        tokensSaved: 7, compressCreditTokens: 3, retrieveCalls: 2,
        lastInputTokens: 123, localInputEstimate: 200, contextTokens: 300,
        lastInputTokensSource: "estimate", calibratedEstimate: 999, contextEstimateCalibrated: true,
    };

    // metadata: named keys reset deletes / sets / preserves + one free-form key
    // (compressFailStreak) that sits OUTSIDE the typed surface — documented, not asserted.
    s.metadata = {
        pluginAgent: "probe-agent", biliVersion: "v-test", storageMode: "unified", effectiveConfig: { a: 1 },
        ccrUndelivered: [{ id: "x" }], ccrDropNotes: ["n"], postRebuildAnchor: "anchor-val",
        nativeCompactionAt: 111, compressFailStreak: 4,
    };
}

test("#6181: every Session field is classified into exactly one reset bucket", () => {
    // The three lists together must cover every top-level Session field with no
    // duplicates. The compile-time gate in src/session.ts already enforces this
    // at build time; this re-checks it at test time so a stale list is caught
    // even if the build config changes.
    const seen = new Set<string>();
    for (const f of ALL_SURFACE_FIELDS) {
        assert.ok(!seen.has(f), `${f} appears in more than one reset-surface list`);
        seen.add(f);
    }
    const expected = ["transient", "id", "meta", "stats", "metadata", "state", "restampSuperseded",
        "pendingLedgerAlign", "createdAt", "lastSeen", "blockContents", "lastMessages",
        "lastMessagesFolded", "pluginSnapshot", "decompositionLog", "revisionEpoch",
        "pluginRevisionCache", "contentStore", "contentStoreDirty", "retrieveCountsByRef",
        "pendingRetrievals", "incomingImageIndex", "lastImgPrune", "inFlight", "persisted",
        "restored", "ccrReconcilePending", "coldLoadedAt", "lastCompress", "lockChain"];
    assert.deepStrictEqual([...seen].sort(), [...expected].sort(),
        "reset-surface lists must cover exactly the 30 top-level Session fields");
});

test("#6181: reset honors the RESET / INTENTIONAL_WRITE / PRESERVED buckets", () => {
    const s = createSession("sess-issue6181");
    populate(s);

    const pre = {} as Record<keyof Session, unknown>;
    for (const k of ALL_SURFACE_FIELDS) pre[k] = s[k];
    const preRevisionEpoch = s.revisionEpoch ?? 0;

    resetSessionCompression(s);

    // RESET: replaced wholesale or cleared in place -> back to fresh
    for (const k of RESET_SESSION_FIELDS) {
        switch (k) {
            case "state":
                assert.notStrictEqual(s.state, pre.state, "state must be replaced wholesale");
                assert.deepStrictEqual(s.state, createInitialState(), "state must equal a fresh initial state");
                break;
            case "contentStore":
                assert.strictEqual(s.contentStore, undefined, "contentStore must be undefined after reset");
                break;
            case "blockContents":
                assert.strictEqual(s.blockContents, pre.blockContents, "blockContents cleared in place (same ref)");
                assert.strictEqual(s.blockContents.size, 0, "blockContents must be empty after reset");
                break;
            case "pendingRetrievals":
                assert.strictEqual(s.pendingRetrievals, pre.pendingRetrievals, "pendingRetrievals cleared in place (same ref)");
                assert.strictEqual((s.pendingRetrievals as unknown[]).length, 0, "pendingRetrievals must be empty after reset");
                break;
            case "pendingLedgerAlign":
                // Consumed by the markDirty->save boundary reset always invokes
                // (persist.ts consumePendingLedgerAlign, #5608-D): absent after reset.
                assert.strictEqual(s.pendingLedgerAlign, undefined, "pendingLedgerAlign consumed by the save boundary after reset");
                break;
        }
    }

    // INTENTIONAL_WRITE: written to its intended non-default value
    for (const k of INTENTIONAL_WRITE_SESSION_FIELDS) {
        switch (k) {
            case "contentStoreDirty":
                assert.strictEqual(s.contentStoreDirty, true, "contentStoreDirty must be set true");
                break;
            case "ccrReconcilePending":
                assert.strictEqual(s.ccrReconcilePending, false, "ccrReconcilePending must be set false");
                break;
            case "revisionEpoch":
                assert.strictEqual(s.revisionEpoch, preRevisionEpoch + 1, "revisionEpoch bumped once via markDirty");
                break;
        }
    }

    // PRESERVED: reference identity unchanged
    for (const k of PRESERVED_SESSION_FIELDS) {
        assert.strictEqual(s[k], pre[k], `${String(k)} must be untouched by reset (reference identity)`);
    }
});

test("#6181: stats sub-field surface — cumulative survives, per-turn estimates zeroed/deleted", () => {
    const s = createSession("sess-issue6181");
    populate(s);
    resetSessionCompression(s);

    // Cumulative billing counters MUST survive the rebase (they describe the
    // whole session's history, not the pre-compaction payload lineage).
    assert.equal(s.stats.requests, 5);
    assert.equal(s.stats.inputTokens, 100);
    assert.equal(s.stats.outputTokens, 40);
    assert.equal(s.stats.cachedTokens, 10);
    assert.equal(s.stats.tokensSaved, 7);
    assert.equal(s.stats.compressCreditTokens, 3);
    assert.equal(s.stats.retrieveCalls, 2);

    // Per-turn estimate baselines are zeroed (re-measured by the next prepare*).
    assert.equal(s.stats.lastInputTokens, 0);
    assert.equal(s.stats.localInputEstimate, 0);
    assert.equal(s.stats.contextTokens, 0);

    // Provenance flags describing the pre-compaction payload lineage are dropped.
    assert.equal(s.stats.lastInputTokensSource, undefined);
    assert.equal(s.stats.calibratedEstimate, undefined);
    assert.equal(s.stats.contextEstimateCalibrated, undefined);
});

test("#6181: metadata key surface — ccr/anchor keys dropped, nativeCompactionAt stamped, identity keys kept", () => {
    const s = createSession("sess-issue6181");
    populate(s);
    resetSessionCompression(s);

    // Dropped across the rebase.
    assert.equal(s.metadata.ccrUndelivered, undefined);
    assert.equal(s.metadata.ccrDropNotes, undefined);
    assert.equal(s.metadata.postRebuildAnchor, undefined);

    // Stamped with the rebase timestamp.
    assert.equal(typeof s.metadata.nativeCompactionAt, "number");
    assert.notEqual(s.metadata.nativeCompactionAt, 111);

    // Identity / attribution keys deliberately preserved.
    assert.deepEqual(s.metadata.pluginAgent, "probe-agent");
    assert.deepEqual(s.metadata.biliVersion, "v-test");
    assert.deepEqual(s.metadata.storageMode, "unified");
    assert.deepEqual(s.metadata.effectiveConfig, { a: 1 });
    // NOTE: compressFailStreak (and any other free-form metadata key) is outside
    // the typed surface and intentionally NOT asserted here — see the module
    // header for the #5984 / proposal-6 boundary.
});
