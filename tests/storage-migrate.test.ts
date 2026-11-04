import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { runStorageMigrateCommand } from "../src/storage-maintenance.ts";
import { rmrf } from "./tmp-rm.ts";

// Plain-JSON envelopes (bypass the codec) and the v0.1.203+ default mode:
// migrate is tested against a store configured exactly like a current install.
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";

function makeSession(id: string, meta: Session["meta"] = {}, requests = 0): Session {
    return {
        id,
        meta,
        stats: { requests, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

async function writeSessions(dir: string, sessions: Array<{ id: string; meta?: Session["meta"]; requests?: number }>): Promise<void> {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    try {
        for (const s of sessions.map((x) => makeSession(x.id, x.meta, x.requests))) await store.writeNow(s);
    } finally {
        await store.closeQuietlyAsync();
    }
}

/** Every file under dir (any name) keyed by relative path, minus the index.db
 *  family (the migration target, expected to appear). */
function snapshotFiles(dir: string): Map<string, { size: number; mtimeMs: number }> {
    const out = new Map<string, { size: number; mtimeMs: number }>();
    const walk = (cur: string): void => {
        for (const name of readdirSync(cur)) {
            if (name.startsWith("index.db")) continue;
            const full = join(cur, name);
            const st = statSync(full);
            if (st.isDirectory()) walk(full);
            else out.set(relative(dir, full), { size: st.size, mtimeMs: st.mtimeMs });
        }
    };
    walk(dir);
    return out;
}

/** Fresh-install simulation: the writing instance's index.db is gone, only the
 *  legacy JSON files remain. */
function dropIndex(dir: string): void {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, `index.db${suffix}`), { force: true });
}

interface MigrateResultEntry {
    id: string;
    file: string;
    status: "imported" | "indexed" | "drifted" | "failed" | "planned";
    reason?: string;
    alternates?: number;
    decodedBytes?: number;
}

interface MigrateJson {
    dryRun: boolean;
    scannedFiles: number;
    counts: { imported: number; indexed: number; drifted: number; failed: number; planned: number };
    results: MigrateResultEntry[];
    indexDbBefore?: number;
    indexDbAfter?: number;
}

async function runMigrate(dir: string, dryRun = false): Promise<{ code: number; out: MigrateJson }> {
    const r = await runStorageMigrateCommand({ dir, dryRun, json: true });
    return { code: r.code, out: JSON.parse(r.text) as MigrateJson };
}

const byId = (out: MigrateJson, id: string): MigrateResultEntry => {
    const hit = out.results.find((r) => r.id === id);
    assert.ok(hit, `result entry for ${id}`);
    return hit!;
};

test("bulk-imports legacy JSON sessions into a fresh index and reconciles clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-"));
    try {
        await writeSessions(dir, [
            { id: "mig-a" },
            { id: "mig-b" },
            { id: "mig-c", meta: { protocol: "anthropic", upstreamOrigin: "https://a.example" } },
        ]);
        dropIndex(dir);
        const first = await runMigrate(dir);
        assert.equal(first.code, 0);
        assert.equal(first.out.counts.imported, 3);
        assert.equal(first.out.counts.failed + first.out.counts.drifted, 0);
        assert.equal(first.out.scannedFiles, 3);
        for (const id of ["mig-a", "mig-b", "mig-c"]) assert.equal(byId(first.out, id).status, "imported");

        // Delete the JSON corpus entirely: the data must be servable from the
        // index alone (the jsonWriter-off end-state).
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) rmrf(full);
        }
        const reader = new SessionStore({ dir, enabled: true });
        try {
            for (const id of ["mig-a", "mig-b", "mig-c"]) assert.ok(reader.loadSync(id), `${id} served from the index alone`);
        } finally {
            await reader.closeQuietlyAsync();
        }

        // Re-run on the now file-less dir: nothing left to scan, clean exit.
        const second = await runMigrate(dir);
        assert.equal(second.code, 0);
        assert.equal(second.out.scannedFiles, 0);
    } finally {
        rmrf(dir);
    }
});

test("already-indexed sessions report indexed without re-writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-"));
    try {
        await writeSessions(dir, [{ id: "keep-1" }, { id: "keep-2" }]);
        // Without this the writing instance's own first-open auto-import has
        // already filled the index, and the first migrate run only verifies.
        dropIndex(dir);
        const first = await runMigrate(dir);
        assert.equal(first.out.counts.imported, 2);
        const second = await runMigrate(dir);
        assert.equal(second.code, 0);
        assert.equal(second.out.counts.indexed, 2, "consistent sessions verify clean on re-run");
        assert.equal(second.out.counts.imported, 0, "no re-write of consistent sessions");
    } finally {
        rmrf(dir);
    }
});

test("dry-run plans without writing; the real run then imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-"));
    try {
        await writeSessions(dir, [{ id: "dry-1" }, { id: "dry-2" }]);
        dropIndex(dir);
        const plan = await runMigrate(dir, true);
        assert.equal(plan.code, 0);
        assert.equal(plan.out.dryRun, true);
        assert.equal(plan.out.counts.planned, 2);
        assert.equal(plan.out.counts.imported, 0);
        const real = await runMigrate(dir);
        assert.equal(byId(real.out, "dry-1").status, "imported", "dry-run wrote nothing — the real run still has to import");
        assert.equal(byId(real.out, "dry-2").status, "imported");
    } finally {
        rmrf(dir);
    }
});

test("corrupt file is reported failed without stopping the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-"));
    try {
        await writeSessions(dir, [{ id: "ok-1" }, { id: "bad-1" }]);
        const protoDir = join(dir, "_unknown");
        const badFile = join(protoDir, readdirSync(protoDir).find((n) => {
            try {
                return JSON.parse(readFileSync(join(protoDir, n), "utf8")).payload.id === "bad-1";
            } catch {
                return false;
            }
        })!);
        appendFileSync(badFile, "\nGARBAGE{{not-json");
        dropIndex(dir);
        const r = await runMigrate(dir);
        assert.equal(r.code, 1, "failed results exit non-zero");
        assert.equal(r.out.counts.failed, 1);
        assert.equal(r.out.counts.imported, 1, "healthy sessions still import");
        const failed = r.out.results.find((x) => x.status === "failed")!;
        assert.ok(failed.reason?.includes("unreadable"), `reason names the failure: ${failed.reason}`);
        assert.equal(byId(r.out, "ok-1").status, "imported");
    } finally {
        rmrf(dir);
    }
});

test("same-id route files arbitrate to newest savedAt; alternates left untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-"));
    try {
        await writeSessions(dir, [{ id: "dup-1", meta: { protocol: "anthropic", upstreamOrigin: "https://a.example" } }]);
        await new Promise((res) => setTimeout(res, 25));
        await writeSessions(dir, [{ id: "dup-1", meta: { protocol: "openai", upstreamOrigin: "https://b.example" }, requests: 1 }]);
        dropIndex(dir);
        const r = await runMigrate(dir);
        assert.equal(r.code, 0);
        const dup = byId(r.out, "dup-1");
        assert.equal(dup.alternates, 1, "the losing route file is reported, not merged");
        assert.equal(dup.status, "imported");
        assert.ok(dup.file.startsWith(`openai${sep}`), `newer route wins: ${dup.file}`);
    } finally {
        rmrf(dir);
    }
});

test("migrate never modifies any file under the sessions dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-"));
    try {
        await writeSessions(dir, [{ id: "ro-1" }, { id: "ro-2" }]);
        dropIndex(dir);
        const before = snapshotFiles(dir);
        const r = await runMigrate(dir);
        assert.equal(r.code, 0);
        const after = snapshotFiles(dir);
        assert.equal(after.size, before.size, "no files added or removed (quarantine renames included)");
        for (const [rel, meta] of before) assert.deepEqual(after.get(rel), meta, `${rel} untouched`);
    } finally {
        rmrf(dir);
    }
});

test("already-indexed session whose file diverged reports drifted without re-writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-"));
    try {
        await writeSessions(dir, [{ id: "drift-1", requests: 1 }]);
        dropIndex(dir);
        const first = await runMigrate(dir);
        assert.equal(byId(first.out, "drift-1").status, "imported");

        // Diverge the source file WITHOUT making it ahead: bump a non-request
        // stat so its digest no longer matches the index, while requests and
        // nextBlockId stay put so the ahead-probe does not re-import it.
        const protoDir = join(dir, "_unknown");
        const file = join(protoDir, readdirSync(protoDir).find((n) => {
            try {
                return JSON.parse(readFileSync(join(protoDir, n), "utf8")).payload.id === "drift-1";
            } catch {
                return false;
            }
        })!);
        const obj = JSON.parse(readFileSync(file, "utf8"));
        obj.payload.stats.tokensSaved = 999999;
        writeFileSync(file, JSON.stringify(obj));

        const second = await runMigrate(dir);
        assert.equal(second.code, 1, "drifted results exit non-zero");
        const d = byId(second.out, "drift-1");
        assert.equal(d.status, "drifted", `expected drifted, got ${d.status}: ${d.reason}`);
        assert.equal(second.out.counts.imported, 0, "diverged-but-not-ahead session is not re-imported");
    } finally {
        rmrf(dir);
    }
});
