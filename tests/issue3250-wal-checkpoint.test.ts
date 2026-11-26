/**
 * #3250 + #7674: index.db-wal frame convergence in long-lived processes.
 *
 * #3250 fixed the missing FRAME convergence: passive/auto checkpoints move
 * committed frames into the main db and reset the write offset, and nothing
 * else did — a long-lived lane process left the replay tail uncollected
 * (field: `{busy:0, log:2720, checkpointed:2720}` sitting unprocessed). The
 * #3250 fix added an open/close TRUNCATE pass plus a PASSIVE checkpoint
 * every WAL_CHECKPOINT_EVERY_INGESTS successful ingests.
 *
 * #7674 (2026-11-24) replaces the file-reclaim part of that fix: TRUNCATE —
 * and the engine-internal reclaim driven by the default
 * `journal_size_limit = 8 MiB` — moves the WAL file and its -shm index out
 * from under every live peer connection (the #2671 shared-sessions-dir
 * topology), and a peer holding a STALE view of that index then writes into
 * reclaimed offsets. That is the #7156 damage shape (pages double-allocated
 * in the tail, "2nd reference to page", index pages corrupting before table
 * pages): three field events on this host (2026-11-19, 2026-11-21,
 * 2026-11-23) plus the #7156 incident itself, all on a growing multi-GB
 * index with peers. The engine NEVER shrinks a WAL it did not truncate, so
 * the safe contract is:
 *
 *   1. `journal_size_limit` defaults to 0 (unlimited, the SQLite default);
 *      a positive cap stays available via
 *      storage.walJournalSizeLimitBytes / BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES
 *      (explicit operator request → the engine's truncate-at-checkpoint
 *      applies at the configured value).
 *   2. open() / close() checkpoints are PASSIVE — they converge the replay
 *      tail (frames into the main db) WITHOUT touching the WAL file.
 *   3. the periodic ingest checkpoint stays PASSIVE for the same reason.
 *
 * Every test below is a RED/GREEN discriminator against the PRE-#7674 tree:
 * there, the default 8 MiB cap and the TRUNCATE passes shrink the file to
 * the cap (or zero), so the "file never shrinks" assertions fail; with the
 * fix the file sits at its high-water mark while the DATA assertions prove
 * the frames were really moved (not just left alone).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema, STORAGE_PRAGMAS, storagePragmas } from "../src/storage/schema.ts";
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
// hold even if the implementation's constants drift. 20 is the
// periodic-checkpoint cadence (ingests).
const CHECKPOINT_EVERY_N = 20;
/** #7674: the file is NEVER shrunken by checkpoints anymore — the slack here
 *  budgets page-granular measurement only, in the "must not shrink" direction. */
const NO_SHRINK_SLACK = 4 * KiB;
/**
 * Custom-cap (explicit journal_size_limit) inter-reset budget. #4506/#4796/
 * #5539 lineage: after the autocheckpoint truncates to the configured cap,
 * subsequent commits keep appending frames (row-identity + index-maintenance
 * frames per message) until the next reset — the observed tail grew from
 * ~12 pages (pre-v9) to 130.8–146.9 KiB (schema v11, ±16 KiB run-to-run
 * packing jitter). Every reset still lands exactly on the cap, so the budget
 * is a wide inter-reset bound, not a pinned tail. Still discriminating: if
 * the configured cap failed to reach the pragma the file would sit at its
 * high-water mark, far above the bound.
 */
const CUSTOM_CAP_SLACK = 256 * KiB;

test("#7674: storagePragmas — default 0 issues no journal_size_limit; a positive cap does", () => {
    assert.ok(
        !storagePragmas(0).some((p) => p.includes("journal_size_limit")),
        "default (0 = unlimited) must NOT issue the journal cap — the engine-internal truncate is the #7156 vector",
    );
    assert.ok(
        storagePragmas(1024 * 1024).includes("PRAGMA journal_size_limit = 1048576"),
        "a positive cap must reach the pragma verbatim",
    );
});

test("#3250/#7674: close() converges the replay tail but leaves the WAL file at its high-water mark", () => {
    const dir = tmpdir("bili-3250-close-");
    let pin: ReturnType<typeof rawOpen> | undefined;
    let store: UnifiedStore | undefined;
    let check: UnifiedStore | undefined;
    let storeClosed = false; // the body closes `store`; keep the finally idempotent (double close throws ERR_INVALID_STATE)
    try {
        // A foreign connection keeps the database (and thus the -wal file)
        // alive after `store` closes — otherwise a clean last-connection
        // close would delete the WAL file and mask what close() did.
        pin = rawOpen(dir);
        store = UnifiedStore.open(indexDb(dir));
        ingest(store, "s1", 1 * MiB, 40);
        ingest(store, "s2", 1 * MiB, 40);
        const preClose = walSize(dir);
        assert.ok(preClose > 0, "frames must be sitting in the WAL before close");

        store.close();
        storeClosed = true;
        // The close PASSIVE moves the frames into the main db — but the FILE
        // stays at its high-water mark: truncating it from under a live peer
        // is the #7156 corruption vector (#7674). Pre-fix this assertion sees
        // the file truncated to ≤4 KiB.
        assert.ok(
            walSize(dir) >= preClose - NO_SHRINK_SLACK,
            `close() must NOT truncate the WAL file under a live peer (was ${preClose}, now ${walSize(dir)} bytes)`,
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

test("#3250/#7674: open() converges the residue an unclean exit left behind, data intact, file untouched", () => {
    const dir = tmpdir("bili-3250-open-");
    let dirty: UnifiedStore | undefined;
    let late: UnifiedStore | undefined;
    try {
        dirty = UnifiedStore.open(indexDb(dir));
        ingest(dirty, "s1", 1 * MiB, 40);
        ingest(dirty, "s2", 1 * MiB, 40);
        const preLateOpen = walSize(dir);
        assert.ok(preLateOpen > 0, "the unclean exit must have left WAL frames behind");

        late = UnifiedStore.open(indexDb(dir));
        // `dirty` is still holding its handle (the SIGKILL / power-loss
        // shape): the open-time PASSIVE may be blocked at the peer's read
        // view (checkpointed < log) and retry on later passes — but it must
        // never touch the file itself.
        assert.ok(
            walSize(dir) >= preLateOpen - NO_SHRINK_SLACK,
            `open() must NOT truncate the WAL file out from under a live peer (was ${preLateOpen}, now ${walSize(dir)} bytes)`,
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

test("#3250/#7674: a save burst leaves the WAL at its high-water mark — frames converge, the file does not shrink", () => {
    const dir = tmpdir("bili-3250-burst-");
    let store: UnifiedStore | undefined;
    try {
        store = UnifiedStore.open(indexDb(dir));
        // One 12 MiB commit (≈3000 pages) plus enough follow-up ingests to
        // cross several periodic-checkpoint cadences. With the pre-fix default
        // (journal_size_limit 8 MiB) the first completed checkpoint after the
        // burst pulled the file back under the cap; with the fix the engine
        // never truncates a WAL it was not told to, so the ~12+ MiB
        // high-water mark PERSISTS (the #3250 disk-occupation cost, now an
        // accepted trade for #7156-class corruption safety — shrink on demand
        // with ?vacuum=full or an explicit cap).
        ingest(store, "big", 12 * MiB, 480);
        const peak = walSize(dir);
        assert.ok(peak > 0, "the burst must have left frames in the WAL");
        for (let i = 2; i <= 2 * CHECKPOINT_EVERY_N; i++) ingest(store, `small${i}`, 1 * MiB, 40);
        assert.ok(
            walSize(dir) >= peak - NO_SHRINK_SLACK,
            `the WAL must stay at its high-water mark after the cadence checkpoints (was ${peak}, now ${walSize(dir)} bytes — implicit truncation is the #7156 vector)`,
        );
        assert.equal(store.getMessages("big").length, 480, "all burst rows must land");
        assert.equal(store.getMessages(`small${2 * CHECKPOINT_EVERY_N}`).length, 40, "all follow-up rows must land");
    } finally {
        store?.close();
        rmBestEffort(dir);
    }
});

test("#3250/#7674: pinned reader lifecycle — growth while pinned, no shrink after release", () => {
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
        // of everything written after it: the file grows while pinned.
        reader = rawOpen(dir);
        reader.db.exec("BEGIN");
        reader.db.prepare("SELECT count(*) FROM sessions").get();

        for (let i = 0; i < 20; i++) ingest(store, `pin${i}`, 512 * KiB, 20);
        const pinnedSize = walSize(dir);
        assert.ok(pinnedSize > 8 * MiB, `pinned growth must exceed the old 8 MiB cap (${pinnedSize} bytes)`);

        reader.db.exec("ROLLBACK");
        reader.close();
        reader = undefined;

        // Drain enough ingests past the checkpoint cadence for the periodic
        // PASSIVE to run post-release. Pre-fix, the first completed
        // checkpoint after the release pulled the file back under the 8 MiB
        // cap; with the fix the file NEVER shrinks below its pinned
        // high-water mark.
        for (let i = 0; i < 2 * CHECKPOINT_EVERY_N; i++) ingest(store, `post${i}`, 100 * KiB, 4);
        assert.ok(
            walSize(dir) >= pinnedSize - NO_SHRINK_SLACK,
            `the WAL must NOT be re-claimed after the reader released (was ${pinnedSize}, now ${walSize(dir)} bytes)`,
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

test("#3250: a configured cap still flows open() → journal_size_limit (explicit limit honored end-to-end)", () => {
    const dir = tmpdir("bili-3250-customcap-");
    let store: UnifiedStore | undefined;
    let pin: ReturnType<typeof rawOpen> | undefined;
    try {
        const customCap = 1 * MiB;
        // A foreign connection keeps the -wal file observable after close —
        // a clean last-connection close would delete it.
        pin = rawOpen(dir);
        store = UnifiedStore.open(indexDb(dir), undefined, { walJournalSizeLimitBytes: customCap });
        // A 3 MiB burst overshoots the CUSTOM cap in-flight...
        ingest(store, "big", 3 * MiB, 120);
        assert.ok(walSize(dir) > customCap, "the burst must overshoot the custom cap in-flight");
        // ...and once the WAL crosses the autocheckpoint window (1000 pages),
        // the writer's own completed checkpoint truncates back to the
        // CONFIGURED cap — the explicit cap is still an operator-sanctioned
        // reclaim under #7674. (With the pre-#7674 default the file would sit
        // at the ~4.4 MiB high-water mark here, never touching 1 MiB — so this
        // row also proves the configured value reached the pragma.)
        for (let i = 2; i <= 10; i++) ingest(store, `small${i}`, 128 * KiB, 8);
        assert.ok(
            walSize(dir) <= customCap + CUSTOM_CAP_SLACK,
            `WAL must be truncated to the configured cap at the autocheckpoint (left ${walSize(dir)} bytes, cap ${customCap})`,
        );
        assert.equal(store.getMessages("big").length, 120, "all burst rows must land");
        // A clean exit converges the REPLAY TAIL whatever the cap: with an
        // explicit cap in play the closing PASSIVE's completed checkpoint
        // truncates back to that configured value (an operator-sanctioned
        // reclaim) — the pre-fix expectation of zero is gone, but a bounded
        // convergence at the cap remains.
        store.close();
        store = undefined;
        assert.ok(
            walSize(dir) <= customCap + CUSTOM_CAP_SLACK,
            `close() must converge the WAL at the configured cap (left ${walSize(dir)} bytes, cap ${customCap})`,
        );
    } finally {
        store?.close();
        pin?.close();
        rmBestEffort(dir);
    }
});

test("#6323: auto_vacuum precedes WAL so fresh databases honor INCREMENTAL", () => {
    const { db } = openSqliteDatabase(":memory:");
    for (const pragma of STORAGE_PRAGMAS) db.exec(pragma);
    migrateSchema(db);
    const row = db.prepare("PRAGMA auto_vacuum").get() as Record<string, unknown>;
    assert.equal(Object.values(row)[0], 2, "auto_vacuum should be INCREMENTAL (2)");
    db.close();
});
