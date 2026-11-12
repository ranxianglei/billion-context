import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * #5755 — characterization: the refs incremental write survives the
 * BLOCKED→numeric migration ord shape.
 *
 * kernel/src/refs.ts (#2607) migrates a stale BLOCKED entry to a fresh
 * numeric ref once protection lifts: delete map.byRaw[id] + re-insert moves
 * the key to the END of the ref map (ord RISES past survivors) while a
 * same-pass newcomer takes the vacated ord. The #5744 diff is safe here by
 * construction: a row is moved to touchedRefs ONLY when its stored copy
 * differs, and it is then NOT consumed from oldRefs — so it also lands in
 * goneRefIds and is DELETEd (by raw_id) before the upsert batch, freeing
 * its old ord first. These tests pin that invariant: if a future change
 * stops double-listing moved rows (a tempting "optimization"), the
 * (session_id, ord) PK starts firing mid-batch and these go red.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-5755-")),
    "no-config.json",
);

const mkSession = (id: string, byRaw: Record<string, string>): LegacySessionLike => {
    const byRef: Record<string, string> = {};
    for (const [rawId, ref] of Object.entries(byRaw)) if (ref !== "BLOCKED") byRef[ref] = rawId;
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: {},
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw, byRef } },
        blockContents: new Map(),
        lastMessages: [],
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as unknown as LegacySessionLike;
};

test("#5755: BLOCKED→numeric migration ord crossing no longer kills the refs upsert", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-5755-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));

        // Save 1 — the pre-migration snapshot: mA numeric, mB BLOCKED.
        store.ingestSession(planIngest(mkSession("sess", { mA: "r1", mB: "BLOCKED" })));

        // Save 2 — exactly the shape kernel/src/refs.ts produces when mB's
        // protection lifts in the same pass that mC arrives: mB re-inserted
        // at the END (ord 2) while newcomer mC takes the vacated ord 1. The
        // diff must land this (mB is delete-first, so ord 1 is freed).
        store.ingestSession(planIngest(mkSession("sess", { mA: "r1", mC: "r2", mB: "r3" })));

        const rows = store.getRefs("sess");
        assert.deepEqual(
            rows.map((r) => [r.ord, r.rawId, r.ref]),
            [
                [0, "mA", "r1"],
                [1, "mC", "r2"],
                [2, "mB", "r3"],
            ],
            "fallback rewrite lands the full migrated order",
        );

        // Save 3 — steady state: one ref string changes at an UNCHANGED ord
        // (its ord's stored holder is the row itself). Must stay on the
        // incremental upsert path (no crossing) and succeed.
        store.ingestSession(planIngest(mkSession("sess", { mA: "r1", mC: "r9", mB: "r3" })));
        assert.deepEqual(
            store.getRefs("sess").map((r) => [r.ord, r.rawId, r.ref]),
            [
                [0, "mA", "r1"],
                [1, "mC", "r9"],
                [2, "mB", "r3"],
            ],
            "same-ord ref update goes through the normal upsert",
        );

        // Save 4 — idempotent re-save: nothing touched, same rows, no throw.
        store.ingestSession(planIngest(mkSession("sess", { mA: "r1", mC: "r9", mB: "r3" })));
        assert.equal(store.getRefs("sess").length, 3);

        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("#5755: ord freed by a GONE ref is reusable without the fallback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-5755b-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));

        // mA@0, mB@1, mC@2 → mB vanishes and mD takes ord 1: the gone-DELETE
        // phase clears mB's ord BEFORE the insert phase, so this must ride
        // the normal incremental path (no crossing, no fallback, no throw).
        store.ingestSession(planIngest(mkSession("sess2", { mA: "r1", mB: "r2", mC: "r3" })));
        store.ingestSession(planIngest(mkSession("sess2", { mA: "r1", mD: "r4", mC: "r3" })));

        assert.deepEqual(
            store.getRefs("sess2").map((r) => [r.ord, r.rawId, r.ref]),
            [
                [0, "mA", "r1"],
                [1, "mD", "r4"],
                [2, "mC", "r3"],
            ],
            "freed ord reuse stays incremental",
        );

        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});
