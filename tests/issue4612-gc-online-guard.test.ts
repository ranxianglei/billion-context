import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { setLogCapture } from "../src/logger.ts";
import { runStorageGcCommand } from "../src/storage-maintenance.ts";

/**
 * #4612 — storage gc full-VACUUM online guard + progress.
 *
 * Field report: an online `bili storage gc` (vacuum=full) against a 14 GB
 * index.db held the exclusive write lock across the whole O(db-size) VACUUM
 * rewrite for 14 minutes with zero progress output, starving the running
 * proxy until its unified shadow layer degraded (3 consecutive "database is
 * locked" failures → legacy-only for the process lifetime).
 *
 * Fix under test: (1) gc full-vacuum refuses up front when another live
 * process holds the db (#4175 <db>.lock pid discipline — both the holder
 * captured at open and a later opener that overwrote our lockfile); (2) the
 * zero-ref sweep commits in bounded batches with per-batch progress; (3) the
 * CLI lane surfaces the refusal as code 1 + actionable text instead of a
 * generic mid-run failure. Dry-run stays read-only; incremental/no-vacuum
 * sweeps stay online-safe.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-4612-gc-guard-")),
    "no-config.json",
);

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function waitUntil(fn: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** A live stand-in for "the other instance" (e.g. a running proxy). */
function spawnDummyWriter(): { pid: number; done(): Promise<void>; kill(): void } {
    const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = child.pid!;
    return {
        pid,
        done: () => waitUntil(() => !alive(pid), 10_000, `dummy writer ${pid} to exit`),
        kill: () => child.kill("SIGTERM"),
    };
}

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkLegacy = (id: string, msgs: CoreMsg[], lastSeen: number): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen,
    meta: { protocol: "openai" },
    stats: {},
    metadata: {},
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

/** DB-direct seeding (no JSON files). */
function seedDb(dir: string, entries: Array<[string, CoreMsg[], number]>): void {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        for (const [id, msgs, lastSeen] of entries) store.ingestSession(planIngest(mkLegacy(id, msgs, lastSeen)));
    } finally {
        store.close();
    }
}

test("#4612: full gc refuses while an open-time foreign holder is live; incremental proceeds; refusal lifts on exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4612-guard-open-"));
    const dbPath = path.join(dir, "index.db");
    const dummy = spawnDummyWriter();
    try {
        await waitUntil(() => alive(dummy.pid), 10_000, "dummy writer to start");
        // The peer opened first: its lockfile entry is what our open() captures.
        fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: dummy.pid, boot: Date.now() }));
        const store = UnifiedStore.open(dbPath);
        try {
            assert.equal(store.lockHolder()?.pid, dummy.pid, "open captures the foreign holder (#4175)");
            assert.equal(store.activeForeignWriter(), dummy.pid, "fresh liveness re-validation sees the live peer");

            assert.throws(
                () => store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive"), vacuum: "full" }),
                (err: Error) => /another process \(pid \d+\)/.test(err.message) && /vacuum:"incremental"/.test(err.message),
                "full gc refuses up front with an actionable error",
            );
            // Incremental stays online-safe: short transactions, no exclusive rewrite.
            const inc = store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive"), vacuum: "incremental" });
            assert.equal(typeof inc.archived, "number", "incremental gc proceeds while the peer writes");

            dummy.kill();
            await dummy.done();
            assert.equal(store.activeForeignWriter(), null, "dead holder no longer blocks");
            const full = store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive"), vacuum: "full" });
            assert.equal(full.archived, 0, "full gc runs once the peer has exited");
        } finally {
            store.close();
        }
    } finally {
        dummy.kill();
        await dummy.done().catch(() => {});
    }
});

test("#4612: detects a writer that started AFTER us via the lockfile fresh-read path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4612-guard-late-"));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    const dummy = spawnDummyWriter();
    try {
        await waitUntil(() => alive(dummy.pid), 10_000, "dummy writer to start");
        assert.equal(store.activeForeignWriter(), null, "clean open: no foreign writer");
        // The peer started after us and overwrote the lockfile with its own pid
        // (every opener does, #4175) — the open-time snapshot cannot see it.
        fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: dummy.pid, boot: Date.now() }));
        assert.equal(store.activeForeignWriter(), dummy.pid, "fresh lockfile read catches the later opener");
        assert.throws(
            () => store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive"), vacuum: "full" }),
            /another process \(pid \d+\)/,
            "full gc refuses against the later opener too",
        );
        dummy.kill();
        await dummy.done();
        assert.equal(store.activeForeignWriter(), null, "stale lockfile entry (dead pid) is not a writer");
        store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive"), vacuum: "full" });
    } finally {
        dummy.kill();
        await dummy.done().catch(() => {});
        store.close();
    }
});

test("#4612: zero-ref sweep deletes every garbage row in batches with progress lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4612-sweep-"));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    try {
        const N = 21_000; // fixed sweep batch 2000 → eleven commits; a cadence
        // line lands every 10th batch plus always on the final batch
        const raw = new DatabaseSync(dbPath);
        try {
            const ins = raw.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 0, 'sha256', ?)");
            for (let i = 0; i < N; i++) {
                const body = Buffer.from(`zero-ref body ${i}`);
                ins.run(`4612-zero-ref-${i}`, body.length, body);
            }
        } finally {
            raw.close();
        }
        const lines: string[] = [];
        setLogCapture((_level, msg) => { lines.push(msg); });
        let result!: { archived: number; contentRowsDeleted: number };
        try {
            result = store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive") });
        } finally {
            setLogCapture(null);
        }
        assert.equal(result.contentRowsDeleted, N, "every zero-ref row collected");
        const progress = lines.filter((m) => /zero-ref content rows so far \(batch \d+\)/.test(m));
        assert.ok(progress.length >= 2, `sweep committed in multiple batches (got ${progress.length} progress lines)`);
        assert.match(progress[progress.length - 1], new RegExp(`collected ${N} zero-ref content rows so far`), "final progress line reports full completion");
        const raw2 = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const left = raw2.prepare("SELECT COUNT(*) AS n FROM content WHERE refcount <= 0").get() as { n: number };
            assert.equal(left.n, 0, "no garbage rows survive");
        } finally {
            raw2.close();
        }
    } finally {
        store.close();
    }
});

test("#4612: CLI 'storage gc --vacuum full' exits 1 with actionable refusal while a writer is live", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4612-cli-"));
    seedDb(dir, [["sess-1", [mkMsg("m1", "cli guard body ".repeat(20))], Date.now()]]);
    const dummy = spawnDummyWriter();
    // Each CLI invocation is its own process that reads whatever the peer last
    // wrote to <db>.lock; an in-process invocation overwrites the file with its
    // own pid on open, so re-arm the fixture before every guarded call.
    const armPeerLock = (): void => fs.writeFileSync(path.join(dir, "index.db.lock"), JSON.stringify({ pid: dummy.pid, boot: Date.now() }));
    try {
        await waitUntil(() => alive(dummy.pid), 10_000, "dummy writer to start");
        armPeerLock();

        const refused = await runStorageGcCommand({ dir, vacuum: "full" });
        assert.equal(refused.code, 1, "refusal is a hard failure");
        assert.match(refused.text, /refused: another process \(pid \d+\)/);
        assert.match(refused.text, new RegExp(String(dummy.pid)));
        assert.match(refused.text, /--vacuum incremental/);

        armPeerLock();
        const dry = await runStorageGcCommand({ dir, vacuum: "full", dryRun: true });
        assert.equal(dry.code, 0, "dry-run stays read-only even with a writer present");
        assert.match(dry.text, /dry-run: nothing executed/);

        armPeerLock();
        const jsonOut = await runStorageGcCommand({ dir, vacuum: "full", json: true });
        assert.equal(jsonOut.code, 1);
        const parsed = JSON.parse(jsonOut.text) as { refused?: unknown; writerPid?: unknown };
        assert.equal(parsed.refused, true);
        assert.equal(parsed.writerPid, dummy.pid);

        dummy.kill();
        await dummy.done();
        const ok = await runStorageGcCommand({ dir, vacuum: "full" });
        assert.equal(ok.code, 0, "succeeds once the writer has exited");
        assert.match(ok.text, /content rows deleted:/);
    } finally {
        dummy.kill();
        await dummy.done().catch(() => {});
    }
});
