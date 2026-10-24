/**
 * #3250: index.db-wal reclamation in long-lived processes.
 *
 * The unified index runs in WAL mode, but nothing ever shrank the WAL FILE:
 * passive/auto checkpoints move frames into the main db and reset the write
 * offset, yet they never ftruncate the file — so a long-lived lane process
 * (dashboard/export/second-lane readers pin frames, big saves burst past any
 * peak) left index.db-wal growing to its historical high-water mark and
 * staying there (field observation: 55 MiB flat, `{busy:0, log:2720,
 * checkpointed:2720}` — every frame reclaimable, nobody reclaiming). Costs:
 * permanent disk occupation proportional to uptime, and crash-recovery
 * replay time after SIGKILL/power loss.
 *
 * Fix under test (src/storage/schema.ts + src/storage/store.ts):
 *   1. `PRAGMA journal_size_limit` (default 8 MiB, tunable via
 *      storage.walJournalSizeLimitBytes / BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES,
 *      resolved in src/knobs.ts) — every COMPLETED checkpoint now truncates the
 *      file back to the cap;
 *   2. one-shot `wal_checkpoint(TRUNCATE)` on UnifiedStore.open (converges
 *      residue an unclean exit left behind — shortens the NEXT recovery)
 *      and before close (clean exit leaves nothing to replay);
 *   3. a PASSIVE checkpoint every WAL_CHECKPOINT_EVERY_INGESTS successful
 *      ingests — reclamation keeps happening under continuous ingest even
 *      when the autocheckpoint window never appears; never blocks, failures
 *      are logged and forgotten.
 *
 * Every test below is a RED/GREEN discriminator: on the pre-fix tree the
 * asserted size is the unreclaimed high-water mark; with the fix the file
 * converges to the cap (or zero).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema, STORAGE_PRAGMAS } from "../src/storage/schema.ts";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3250-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

const indexDb = (dir: string): string => path.join(dir, "index.db");
const walPath = (dir: string): string => `${indexDb(dir)}-wal`;

function walSize(dir: string): number {
    try {
        return fs.statSync(walPath(dir)).size;
    } catch {
        return 0;
    }
}

/** Raw connection mirroring UnifiedStore.open's setup — used to hold the
 *  database open (keeping the -wal file alive across another store's
 *  close()) or to take a pinned read snapshot. */
function rawOpen(dir: string): { db: ReturnType<typeof openSqliteDatabase>["db"]; close(): void } {
    const { db } = openSqliteDatabase(indexDb(dir));
    for (const pragma of STORAGE_PRAGMAS) db.exec(pragma);
    migrateSchema(db);
    return { db, close: () => db.close() };
}

let msgCounter = 0;
function mkMsg(text: string): CoreMessage {
    msgCounter += 1;
    return { id: `h_msg${msgCounter}`, role: msgCounter % 2 === 0 ? "user" : "assistant", contentType: "text", text } as CoreMessage;
}

function mkLegacy(id: string, totalBytes: number, msgsPerSession: number): LegacySessionLike {
    const pad = Math.max(1, Math.floor(totalBytes / msgsPerSession));
    const lastMessages = Array.from({ length: msgsPerSession }, (_, k) => mkMsg(`${id}-${k}-`.padEnd(pad, "x")));
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        // Key order matters: loadLegacyView rebuilds state in MERGE_STATE_FIELDS
        // order and the shadow digest is JSON.stringify-based (order-sensitive).
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
    };
}

function ingest(store: UnifiedStore, id: string, totalBytes: number, msgsPerSession: number): void {
    assert.equal(store.ingestSession(planIngest(mkLegacy(id, totalBytes, msgsPerSession))), true, `ingest ${id} must apply`);
}

const KiB = 1024;
const MiB = 1024 * 1024;
// Contract literals, deliberately NOT imported from src: the assertions must
// hold even if the implementation's constants drift. 8 MiB is the #3250
// journal_size_limit; 20 is the periodic-checkpoint cadence (ingests).
const WAL_CAP = 8 * MiB;
const CHECKPOINT_EVERY_N = 20;
/** Truncation lands page-aligned; allow one page of measurement slack. */
const CAP_SLACK = 4 * KiB;
/** #4489: convergence deadline for the custom-cap test, in 128 KiB ingest
 *  units. This scenario is a lone writer, so EVERY completed checkpoint
 *  truncates the file back to the configured cap (a 128 KiB unit commits far
 *  fewer pages than the 1 MiB cap holds on 4 KiB pages, so the post-truncation
 *  file rests exactly at the cap). Completed checkpoints arrive on two clocks:
 *  the built-in autocheckpoint (once >1000 pages accumulate since the last one
 *  — a 128 KiB unit commits ≥ 32 pages, so within ⌈1000/32⌉ = 32 units) and
 *  the cadence-tick PASSIVE (every CHECKPOINT_EVERY_N = 20 ingests); the
 *  cadence is the tighter clock, and the truncate observes at most one unit
 *  late (it lands inside the following commit). 20 + 1 + 3 headroom = 24. */
const CONV_UNITS = 24;

test("#3250: close() converges the WAL so a clean exit leaves nothing to replay", () => {
    const dir = tmpdir("bili-3250-close-");
    let pin: ReturnType<typeof rawOpen> | undefined;
    let store: UnifiedStore | undefined;
    let check: UnifiedStore | undefined;
    let storeClosed = false; // the body closes `store`; keep the finally idempotent (double close throws ERR_INVALID_STATE)
    try {
        // A foreign connection keeps the database (and thus the -wal file)
        // alive after `store` closes — otherwise a clean last-connection
        // close would delete the WAL file and mask whether close() did the
        // converging work itself.
        pin = rawOpen(dir);
        store = UnifiedStore.open(indexDb(dir));
        ingest(store, "s1", 1 * MiB, 40);
        ingest(store, "s2", 1 * MiB, 40);
        assert.ok(walSize(dir) > 0, "frames must be sitting in the WAL before close");

        store.close();
        storeClosed = true;
        assert.ok(
            walSize(dir) <= CAP_SLACK,
            `close() must have truncated the WAL (left ${walSize(dir)} bytes — un-reclaimed high-water mark)`,
        );

        check = UnifiedStore.open(indexDb(dir));
        for (const id of ["s1", "s2"]) {
            assert.equal(check.getMessages(id).length, 40, `${id} message rows must survive the checkpoint`);
        }
    } finally {
        check?.close();
        if (!storeClosed) store?.close();
        pin?.close();
        rmBestEffort(dir);
    }
});

test("#3250: open() converges the WAL an unclean exit left behind, data intact", () => {
    const dir = tmpdir("bili-3250-open-");
    let dirty: UnifiedStore | undefined;
    let late: UnifiedStore | undefined;
    try {
        dirty = UnifiedStore.open(indexDb(dir));
        ingest(dirty, "s1", 1 * MiB, 40);
        ingest(dirty, "s2", 1 * MiB, 40);
        // `dirty` is deliberately NOT closed: the process died (SIGKILL /
        // power loss) with its handle open, leaving a live WAL behind.
        assert.ok(walSize(dir) > 0, "the unclean exit must have left WAL frames behind");

        late = UnifiedStore.open(indexDb(dir));
        assert.ok(
            walSize(dir) <= CAP_SLACK,
            `open() must have checkpointed the residue (left ${walSize(dir)} bytes — next crash would replay it all)`,
        );
        for (const id of ["s1", "s2"]) {
            assert.equal(late.getMessages(id).length, 40, `${id} message rows must survive the open-time checkpoint`);
        }
    } finally {
        late?.close();
        dirty?.close();
        rmBestEffort(dir);
    }
});

test("#3250: a save burst past the cap comes back under the cap at the next cadence tick", () => {
    const dir = tmpdir("bili-3250-burst-");
    let store: UnifiedStore | undefined;
    try {
        store = UnifiedStore.open(indexDb(dir));
        // One 12 MiB commit (≈3000 pages). A connection cannot checkpoint the
        // frames it just wrote while it is still the last writer (verified:
        // same-conn PASSIVE right after the commit reclaims nothing) — so the
        // burst residue sitting in the WAL is normal WAL behavior, not the bug.
        // The #3250 defect is what happens NEXT: without journal_size_limit,
        // every later checkpoint resets the write offset but never shrinks the
        // file, so the ~12 MiB high-water mark persists for the life of the
        // process. With the limit, the first COMPLETED checkpoint after newer
        // writes truncate the file back to the cap — here driven by the
        // periodic PASSIVE at the CHECKPOINT_EVERY_N-th ingest.
        ingest(store, "big", 12 * MiB, 480);
        assert.ok(walSize(dir) > 0, "the burst must have left frames in the WAL");
        for (let i = 2; i <= CHECKPOINT_EVERY_N; i++) ingest(store, `small${i}`, 1 * MiB, 40);
        assert.ok(
            walSize(dir) <= WAL_CAP + CAP_SLACK,
            `WAL must be truncated to the cap by the cadence checkpoint (left ${walSize(dir)} bytes, cap ${WAL_CAP})`,
        );
        assert.equal(store.getMessages("big").length, 480, "all burst rows must land");
        assert.equal(store.getMessages(`small${CHECKPOINT_EVERY_N}`).length, 40, "all follow-up rows must land");
    } finally {
        store?.close();
        rmBestEffort(dir);
    }
});

test("#3250: pinned reader lifecycle — growth while pinned, reclamation after release", () => {
    const dir = tmpdir("bili-3250-pin-");
    let store: UnifiedStore | undefined;
    let reader: ReturnType<typeof rawOpen> | undefined;
    try {
        store = UnifiedStore.open(indexDb(dir));
        ingest(store, "seed1", 1 * MiB, 40);
        ingest(store, "seed2", 1 * MiB, 40);

        // A foreign connection takes a read snapshot AFTER the seed frames
        // exist and holds it open — the production shape (dashboard/export/
        // second lane sharing the directory, #2671 topology). WAL backfill is
        // sequential from frame 1, so the pinned snapshot blocks reclamation
        // of everything written after it: the file must grow while pinned.
        reader = rawOpen(dir);
        reader.db.exec("BEGIN");
        reader.db.prepare("SELECT count(*) FROM sessions").get();

        for (let i = 0; i < 20; i++) ingest(store, `pin${i}`, 512 * KiB, 20);
        const pinnedSize = walSize(dir);
        assert.ok(pinnedSize > WAL_CAP, `pinned growth must exceed the cap (${pinnedSize} bytes)`);

        reader.db.exec("ROLLBACK");
        reader.close();
        reader = undefined;

        // Drain enough ingests past the checkpoint cadence: the first
        // COMPLETED checkpoint after the release truncates the file back to
        // the cap (autocheckpoint or the periodic PASSIVE — either way the
        // reclamation now actually happens).
        for (let i = 0; i < 2 * CHECKPOINT_EVERY_N; i++) ingest(store, `post${i}`, 100 * KiB, 4);
        assert.ok(
            walSize(dir) <= WAL_CAP + CAP_SLACK,
            `WAL must come back under the cap after the reader released (left ${walSize(dir)} bytes, cap ${WAL_CAP})`,
        );

        const view = loadLegacyView({
            session: (() => {
                const row = store.getSessionRow("pin0");
                assert.ok(row, "pin0 row must exist");
                return row;
            })(),
            messages: store.getMessages("pin0"),
            blocks: store.getBlocks("pin0"),
            deadRefs: store.getDeadRefs("pin0"),
            refs: store.getRefs("pin0"),
        });
        assert.equal(view.lastMessages?.length, 20, "pinned-phase rows must round-trip");
    } finally {
        reader?.close();
        store?.close();
        rmBestEffort(dir);
    }
});

test("#3250: a configured cap flows open() → journal_size_limit (custom limit honored end-to-end)", () => {
    const dir = tmpdir("bili-3250-customcap-");
    let store: UnifiedStore | undefined;
    try {
        const customCap = 1 * MiB;
        store = UnifiedStore.open(indexDb(dir), undefined, { walJournalSizeLimitBytes: customCap });
        // A 3 MiB burst overshoots the CUSTOM cap in-flight...
        ingest(store, "big", 3 * MiB, 120);
        assert.ok(walSize(dir) > customCap, "the burst must overshoot the custom cap in-flight");
        // ...and any COMPLETED checkpoint thereafter truncates back to the
        // CONFIGURED cap, not the 8 MiB default: with the default the file
        // would sit at the ~4.4 MiB high-water mark here, never touching 1 MiB.
        // A trough resting AT the configured cap is the observable proof the
        // value reached the pragma. (In a shared directory a foreign reader can
        // pin the snapshot and stall the truncate — #3250's field mode — but
        // this scenario is a lone writer, so every checkpoint completes.)
        //
        // #4489: WHERE the 1000-page autocheckpoint window closes relative to
        // commit boundaries depends on the runner's bundled SQLite build (page
        // packing differs across versions/OSes), so the residue above the cap
        // after a FIXED ingest count is environment-dependent — asserting at a
        // fixed point raced the grow/truncate sawtooth (byte-identical red on
        // some runners, green on others, same sha). Assert CONVERGENCE instead:
        // keep committing 128 KiB units until a completed checkpoint brings the
        // file back under the cap; CONV_UNITS bounds how long that can take
        // (derived above). A pre-fix tree (limit never honored) stays at its
        // high-water mark through all units and can never converge — the
        // RED/GREEN discrimination holds.
        let converged = false;
        for (let i = 2; i <= CONV_UNITS && !converged; i++) {
            ingest(store, `conv${i}`, 128 * KiB, 8);
            converged = walSize(dir) <= customCap + CAP_SLACK;
        }
        assert.ok(
            converged,
            `WAL must converge to the configured cap at a completed checkpoint (last ${walSize(dir)} bytes, cap ${customCap}, ${CONV_UNITS} units exhausted)`,
        );
        assert.equal(store.getMessages("big").length, 120, "all burst rows must land");
        // A clean exit converges to zero whatever the cap.
        store.close();
        store = undefined;
        assert.ok(walSize(dir) <= CAP_SLACK, `close() must converge the WAL (left ${walSize(dir)} bytes)`);
    } finally {
        store?.close();
        rmBestEffort(dir);
    }
});
