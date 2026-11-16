/**
 * Release-gate pin (e2e #2195 failure on 2026-11-13_release-v0.1.214, run
 * 43557997361): UnifiedStore.open must survive a CONCURRENT WRITER on the
 * same index.db. The machine-global sessions dir is deliberately shared
 * (one index.db per machine is the supported topology, #5082), and the
 * launcher kills its proxy fire-and-forget on exit (stopProxy is a bare
 * SIGTERM with no wait-for-exit), so a next launch's opener routinely
 * starts while a peer is still holding the file:
 *  - this file's own sibling e2e lanes (bare `runs-on: ubuntu-latest` —
 *    no container — and GitHub's shared-pool runners run several jobs of
 *    several repos side by side under the same user);
 *  - a previous bili instance still draining its final flush.
 *
 * The pre-fix trap this suite pins (deterministic repro): `PRAGMA
 * journal_mode` needs exclusive access and BYPASSES the connection's busy
 * handler entirely — with the file still in its legacy journal mode and a
 * peer holding a write transaction, it throws raw SQLITE_BUSY at 0 ms even
 * with `busy_timeout = 5000` installed on the handle (quick_check and the
 * other pragmas wait fine). The shadow layer then refused to start (no-
 * degrade owner policy) and the launcher parked on the startup-failure
 * page for its full 60 s health budget.
 *
 * The fix has two halves, each covered below:
 *  1. `PRAGMA busy_timeout = 5000` is installed immediately after the
 *     handle opens, BEFORE the pre-migration quick_check — a transient
 *     lock now queues up to 5 s instead of throwing raw SQLITE_BUSY;
 *  2. the journal_mode pragma never hard-fails a startup: it is skipped
 *     when the file header already declares WAL (a strict no-op — the
 *     store is created WAL and never switched back) and, for a legacy-mode
 *     file, a BUSY from the switch is DEFERRED to the next open (#5082
 *     owner decision 2026-10-31: a live foreign writer never blocks
 *     startup) instead of refusing the boot.
 *
 * The lock holder is a CHILD PROCESS in both tests (not a second in-
 * process connection): it matches the real topology (a separate node
 * process still holding the file), and a same-process setTimeout could
 * never run to release the lock while the opener blocks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { UnifiedStore } from "../src/storage/store.ts";

// Hermeticity pins, same shape as the other storage suites: no developer
// config may leak a storage tier into these tests.
process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-open-busy-lock-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "full";

/** Start the write-lock holder. `wal` selects the file's journal mode:
 *  true = production shape (created WAL, never switched back); false =
 *  legacy journal mode, the shape where the journal_mode pragma actually
 *  has to acquire exclusive access. The holder parks in a write
 *  transaction (BEGIN IMMEDIATE + insert — like a draining proxy's final
 *  flush) for `holdMs` after writing `readyPath`, then commits and exits.
 *  holdMs must stay well under the open path's 5 s busy_timeout so that,
 *  with the fix in place, every statement that needs the lock simply
 *  queues and completes. */
function startHolder(dbPath: string, readyPath: string, wal: boolean, holdMs: number): ChildProcess {
    const source = `
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
const db = new DatabaseSync(${JSON.stringify(dbPath)});
${wal ? 'db.exec("PRAGMA journal_mode = WAL");' : ""}
db.exec("CREATE TABLE IF NOT EXISTS probe_lock (x INTEGER)");
db.exec("INSERT INTO probe_lock VALUES (1)");
db.exec("BEGIN IMMEDIATE");
db.exec("INSERT INTO probe_lock VALUES (2)");
writeFileSync(${JSON.stringify(readyPath)}, "locked");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});
`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "inherit" });
    return child;
}

async function waitReady(readyPath: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(readyPath)) {
        if (Date.now() > deadline) throw new Error("holder never parked its write lock");
        await new Promise((r) => setTimeout(r, 20));
    }
}

// Give the holder a head start so its transaction is definitely parked
// before the opener's first statement — keeps the pre-fix failure
// deterministic (0 ms throw) instead of timing-race dependent.
const HEAD_START_MS = 700;

test("#2195: open defers (never refuses) when a peer holds the write lock on a legacy-journal file", { timeout: 60_000 }, async (t) => {
    const dbPath = path.join(hermetic, "legacy", "index.db");
    const readyPath = path.join(hermetic, "legacy-ready");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const holder = startHolder(dbPath, readyPath, false, 2500);
    t.after(() => { try { holder.kill("SIGKILL"); } catch { /* gone */ } });
    await waitReady(readyPath);
    await new Promise((r) => setTimeout(r, HEAD_START_MS));

    // Pre-fix this threw 'database is locked' at 0 ms from the
    // journal_mode pragma (it bypasses the busy handler) and the shadow
    // layer refused to start. Post-fix the switch is deferred to the next
    // open and the remaining statements queue on busy_timeout until the
    // holder commits at 2500 ms.
    let store: UnifiedStore | undefined;
    try {
        const t0 = Date.now();
        store = UnifiedStore.open(dbPath);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= 0, `open completed in ${elapsed} ms`);
    } finally {
        store?.close();
        // Never leak a holder past its commit window into the next test.
        try { holder.kill("SIGKILL"); } catch { /* already committed + exited */ }
    }
});

test("#2195: open is a no-op on the journal switch for a production (already-WAL) file under a live peer", { timeout: 60_000 }, async (t) => {
    const dbPath = path.join(hermetic, "wal", "index.db");
    const readyPath = path.join(hermetic, "wal-ready");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const holder = startHolder(dbPath, readyPath, true, 2500);
    t.after(() => { try { holder.kill("SIGKILL"); } catch { /* gone */ } });
    await waitReady(readyPath);
    await new Promise((r) => setTimeout(r, HEAD_START_MS));

    let store: UnifiedStore | undefined;
    try {
        store = UnifiedStore.open(dbPath);
    } finally {
        store?.close();
        try { holder.kill("SIGKILL"); } catch { /* already committed + exited */ }
    }
});
