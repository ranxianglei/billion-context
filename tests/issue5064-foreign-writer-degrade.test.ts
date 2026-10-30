/**
 * #5064/B: a live second LONG-LIVED writer on one index.db must degrade this
 * proxy to legacy-only instead of co-residing and corrupting the shared store.
 *
 * Both directions are asserted (gate discipline, #3617):
 *   - TRIGGER: rejectForeignWriter + a live foreign pid → open throws
 *     StorageForeignWriterError; maybeOpen degrades to null; status carries the
 *     isolation reason (and never the destructive "delete the file" hint).
 *   - NO-TRIGGER: without the flag (ephemeral CLI/export posture) the SAME
 *     foreign writer keeps the report-only behavior (open succeeds, holder
 *     surfaced); and a healthy dir (no foreign writer) opens the sidecar cleanly.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

delete process.env.BILI_STORAGE_UNIFIED;

import { UnifiedStore, StorageForeignWriterError } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { storageStatusWire, recordRequestedMode, _resetStorageRuntimeStatusForTest } from "../src/storage/runtime-status.ts";

function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "issue5064-foreign-writer-"));
}

/** Spawn a short-lived child owning a genuinely-live pid (same convention as
 *  tests/storage-durability.test.ts). */
async function liveChildPid(): Promise<{ pid: number; kill: () => void }> {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

test("#5064 trigger: rejectForeignWriter + live foreign pid → open throws, owner's lock left intact", async () => {
    const dir = freshDir();
    const holder = await liveChildPid();
    try {
        const path = join(dir, "index.db");
        writeFileSync(`${path}.lock`, JSON.stringify({ pid: holder.pid, boot: Date.now() }));
        assert.throws(
            () => UnifiedStore.open(path, undefined, { rejectForeignWriter: true }),
            (err: unknown) => err instanceof StorageForeignWriterError && err.holderPid === holder.pid,
        );
        // We refused BEFORE claiming the lock — the foreign owner's record survives.
        const onDisk = JSON.parse(readFileSync(`${path}.lock`, "utf8")) as { pid?: number };
        assert.equal(onDisk.pid, holder.pid, "the foreign owner's lockfile is not clobbered");
    } finally {
        holder.kill();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#5064 no-trigger: without the flag the same foreign writer keeps report-only (open succeeds)", async () => {
    const dir = freshDir();
    const holder = await liveChildPid();
    try {
        const path = join(dir, "index.db");
        writeFileSync(`${path}.lock`, JSON.stringify({ pid: holder.pid, boot: Date.now() }));
        const store = UnifiedStore.open(path); // no rejectForeignWriter → ephemeral posture
        try {
            assert.ok(store.lockHolder() !== null, "ephemeral open still surfaces the foreign holder");
            assert.equal(store.lockHolder()?.pid, holder.pid);
        } finally {
            store.close();
        }
    } finally {
        holder.kill();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#5064 trigger (integration): maybeOpen degrades the sidecar to null + status carries the isolation reason", async () => {
    const dir = freshDir();
    const holder = await liveChildPid();
    _resetStorageRuntimeStatusForTest();
    try {
        recordRequestedMode("shadow", false);
        writeFileSync(join(dir, "index.db.lock"), JSON.stringify({ pid: holder.pid, boot: Date.now() }));
        const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, () => null);
        assert.equal(shadow, null, "a second long-lived writer degrades the sidecar to legacy-only (null)");
        const wire = storageStatusWire();
        assert.equal(wire.degraded, true, "status reports degraded");
        assert.match(wire.reason ?? "", /BILI_SESSIONS_DIR/, "reason names the isolation lever");
        assert.doesNotMatch(wire.reason ?? "", /delete the file/i, "no destructive delete-file hint for a healthy shared db");
    } finally {
        holder.kill();
        _resetStorageRuntimeStatusForTest();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#5064 no-trigger (integration): a healthy dir (no foreign writer) opens the sidecar cleanly", async () => {
    const dir = freshDir();
    _resetStorageRuntimeStatusForTest();
    let shadow: UnifiedShadow | null = null;
    try {
        recordRequestedMode("shadow", false);
        shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, () => null);
        assert.ok(shadow !== null, "no foreign writer → sidecar opens (no spurious degrade)");
        const wire = storageStatusWire();
        assert.equal(wire.degraded, false, "healthy sidecar is not reported degraded");
    } finally {
        shadow?.close();
        _resetStorageRuntimeStatusForTest();
        rmSync(dir, { recursive: true, force: true });
    }
});
