/**
 * #4175: storage durability trio.
 *
 * The unified store is the single source of truth but ships none of the
 * reliability trio: no corruption self-check at open, no online backup, no
 * second-process-on-the-same-db detection. Stakes first — every test below
 * fails on the current tree.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

delete process.env.BILI_STORAGE_UNIFIED;

import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";

function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "storage-durability-"));
}

/** Minimal legacy-shaped record for ingesting one session through the store. */
function legacyLike(id: string): LegacySessionLike {
    return {
        id,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: { label: id, protocol: "anthropic", upstreamOrigin: "https://api.anthropic.com" },
        stats: { requests: 1 },
        metadata: { pluginAgent: "dsh" },
        state: {
            blocks: [],
            messageRefs: { byRaw: { m00001: "m00001" }, byRef: { m00001: "m00001" } },
            deadRefs: [],
            nextBlockId: 1,
            nextRunId: 1,
            coveredRefs: [],
        },
        blockContents: new Map(),
        lastMessages: [{ id: "m00001", role: "user", contentType: "text", text: "hello durability" }],
        lastMessagesFolded: false,
    };
}

test("quick_check: a corrupt db fails open with a typed error, files left UNTOUCHED (#4626 policy)", async () => {
    const dir = freshDir();
    try {
        // 1. Create a valid db.
        const path = join(dir, "index.db");
        const store = UnifiedStore.open(path);
        store.close();

        // 2. Corrupt the main db file (flip bytes in the middle of the page area).
        const raw = readFileSync(path);
        for (let i = Math.floor(raw.length / 3); i < Math.floor(raw.length / 3) + 4096; i++) {
            raw[i] = raw[i] ^ 0xff;
        }
        writeFileSync(path, raw);

        // 3. Reopen — must fail with a typed, greppable integrity error
        //    (migrations must never run against a corrupt file).
        assert.throws(() => UnifiedStore.open(path), /quick_check|integrity/i);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("backupInto: produces a consistent snapshot db that opens and holds the same sessions", async () => {
    const dir = freshDir();
    try {
        const path = join(dir, "index.db");
        const store = UnifiedStore.open(path);
        store.ingestSession(planIngest(legacyLike("durab-1")));
        const ids = store.listSessionIds();
        assert.deepEqual(ids, ["durab-1"]);

        // 4. Online backup.
        const dst = join(dir, "backups", "snapshot.db");
        mkdirSync(join(dir, "backups"), { recursive: true });
        const bytes = store.backupInto(dst);
        assert.ok(bytes > 0, "backup reports the produced byte length");
        assert.ok(existsSync(dst), "backup file exists");

        // 5. The backup opens as a store and holds the same session.
        const restored = UnifiedStore.open(dst);
        assert.deepEqual(restored.listSessionIds(), ["durab-1"]);
        restored.close();
        store.close();

        // 6. Refuses to overwrite an existing target (atomicity discipline).
        const store2 = UnifiedStore.open(path);
        assert.throws(() => store2.backupInto(dst), /exists/i);
        store2.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("lockfile: a live foreign pid is reported, a dead pid is taken over, close removes the lock", async () => {
    const dir = freshDir();
    try {
        const path = join(dir, "index.db");
        // Spawn a short-lived child to own a genuinely-live pid.
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
        await new Promise<void>((resolve) => setTimeout(resolve, 300)); // let it boot
        writeFileSync(`${path}.lock`, JSON.stringify({ pid: child.pid, boot: Date.now() }));

        // 1. Open with a live foreign holder → reports, does not crash.
        const store = UnifiedStore.open(path);
        const foreign = store.lockHolder();
        assert.ok(foreign !== null && typeof foreign === "object", "live foreign pid is surfaced");
        assert.equal(foreign?.pid, child.pid);
        store.close();

        // 2. Kill the holder, leave the stale lockfile → takeover, no report.
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        writeFileSync(`${path}.lock`, JSON.stringify({ pid: child.pid, boot: Date.now() }));
        const store2 = UnifiedStore.open(path);
        assert.equal(store2.lockHolder(), null, "stale lockfile is taken over silently");
        store2.close();
        assert.ok(!existsSync(`${path}.lock`), "close removes the lockfile");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("shadow open ALARMS on a corrupt index.db set — nothing renamed, boot proceeds (#4626)", async () => {
    const { UnifiedShadow } = await import("../src/storage/shadow.ts");
    const { readdirSync } = await import("node:fs");
    const dir = freshDir();
    try {
        const path = join(dir, "index.db");
        // Build a valid db first.
        const store = UnifiedStore.open(path);
        store.close();

        // Corrupt it (page area flip) and remember its exact bytes.
        const raw = readFileSync(path);
        for (let i = Math.floor(raw.length / 3); i < Math.floor(raw.length / 3) + 4096; i++) {
            raw[i] = raw[i] ^ 0xff;
        }
        writeFileSync(path, raw);
        const beforeHash = createHash("sha256").update(raw).digest("hex");

        // The shadow's maybeOpen (full mode) must ALARM, not refuse — come
        // back as "no sidecar" (this process then serves from the envelopes)
        // AND leave EVERY file exactly where it was: no rename, no copy, no
        // automatic rebuild, and NO legacy fallback (#4626-era owner decision
        // chain through 2026-10-30 — automatic moves can't prove full
        // recovery, and a fallback forks the two replicas forever).
        const env = { ...process.env, BILI_STORAGE_UNIFIED: "full" };
        const sh = UnifiedShadow.maybeOpen(dir, env);
        assert.equal(sh, null, "a provably-corrupt index must yield 'no sidecar' with a loud alarm — not throw, not rename, not rebuild");
        const names = readdirSync(dir);
        assert.ok(!names.some((n) => n.includes(".corrupt-")), `no automatic copies allowed, got ${names.join(", ")}`);
        const afterHash = createHash("sha256").update(readFileSync(path)).digest("hex");
        assert.equal(afterHash, beforeHash, "the corrupt primary must stay byte-identical");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runtime status surfaces integrity / secondProcess / backup facts", async () => {
    const { storageStatusWire, _resetStorageRuntimeStatusForTest, recordIntegrityOutcome, recordSecondProcessOwner, recordBackupOutcome } = await import("../src/storage/runtime-status.ts");
    _resetStorageRuntimeStatusForTest();
    recordIntegrityOutcome("/tmp/index.db", true, 42);
    const child = (await import("node:child_process")).spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    recordSecondProcessOwner(child.pid!);
    recordBackupOutcome("/tmp/x.db", 1024);
    // #3959: live pid stays surfaced; dead pid self-clears at the status read.
    let wire = storageStatusWire();
    assert.equal(wire.secondProcess?.pid, child.pid, "live foreign pid stays surfaced");
    child.kill("SIGKILL");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try { process.kill(child.pid!, 0); await new Promise<void>((resolve) => setTimeout(resolve, 50)); } catch { break; }
    }
    wire = storageStatusWire();
    assert.equal(wire.secondProcess, null, "dead pid self-clears at the status read");
    assert.equal(wire.integrity?.ok, true);
    assert.equal(wire.integrity?.durationMs, 42);
    assert.equal(wire.backup?.lastPath, "/tmp/x.db");
    assert.equal(wire.backup?.lastBytes, 1024);
});

test("#5082: a live foreign pid on <db>.lock is informational, never a corruption alarm", async () => {
    const { setLogCapture } = await import("../src/logger.ts");
    const { _resetStorageRuntimeStatusForTest, storageStatusWire } = await import("../src/storage/runtime-status.ts");
    // Repro shape from #5082: the peer is an inline-lane process that never
    // registers itself, and this process carries no BILI_LAUNCHER_LANE —
    // exactly the shape the old benign gate misjudged as a corruption risk.
    delete process.env.BILI_LAUNCHER_LANE;
    _resetStorageRuntimeStatusForTest();
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
    const dir = freshDir();
    const child = (await import("node:child_process")).spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        const dbPath = join(dir, "index.db");
        writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: child.pid, boot: Date.now() }));
        const store = UnifiedStore.open(dbPath);
        store.close();
        // Negative direction first: the old error line ("two processes on one
        // index.db corrupt it") must be gone entirely.
        assert.ok(!logs.some((l) => l.startsWith("error") && l.includes("already writing")), "no error-level corruption alarm for a coexisting pid");
        assert.ok(!logs.some((l) => l.includes("two processes on one index.db corrupt it")), "the #5082 alarm text is gone");
        // Positive direction: coexistence is logged info, naming the pid, and
        // the wire facts are informational.
        assert.ok(logs.some((l) => l.startsWith("info") && l.includes(`pid ${child.pid}`) && l.includes("supported topology")), "coexistence is logged at info level with the pid");
        const wire = storageStatusWire();
        assert.equal(wire.secondProcess?.pid, child.pid);
        assert.equal(wire.secondProcess?.benign, true, "the banner facts are informational (#5082)");
        // The coexistence pid never blocked the open: the db exists and works.
        assert.ok(existsSync(dbPath), "the db was created despite the coexisting lock holder");
    } finally {
        setLogCapture(null);
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#5082 negative: no foreign pid on the lock means nothing surfaces", async () => {
    const { setLogCapture } = await import("../src/logger.ts");
    const { _resetStorageRuntimeStatusForTest, storageStatusWire } = await import("../src/storage/runtime-status.ts");
    _resetStorageRuntimeStatusForTest();
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
    const dir = freshDir();
    try {
        const store = UnifiedStore.open(join(dir, "index.db"));
        store.close();
        assert.ok(!logs.some((l) => l.includes("is also using")), "no coexistence log without a foreign pid");
        assert.equal(storageStatusWire().secondProcess, null, "wire stays clean without a foreign pid");
    } finally {
        setLogCapture(null);
        rmSync(dir, { recursive: true, force: true });
    }
});
