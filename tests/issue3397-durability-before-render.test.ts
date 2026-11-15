import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * #3397 (PR #6326): durability-before-render — the turn's ledger rows must be
 * in the unified index BEFORE the model can cite the turn's refs, so a crash
 * before the debounced envelope save (#5155) cannot leave rendered refs
 * unbacked ("above the highest allocated ref" on the next compress). The new
 * primitive is `SessionStore.ingestRowsNow`: the synchronous SQLite ingest leg
 * of the debounced save, minus the envelope write. The prepare phases
 * (server/prepare-*.ts) call it right before the model call; the incremental
 * lane (incremental-lane.ts) calls it the instant a turn's response has fully
 * left.
 *
 * Pinned here:
 *   1. ingestRowsNow ALONE makes a session durable in the index — with the
 *      JSON envelope writer off entirely, a cold restart still resolves the
 *      session from the index with folds + ref ledger intact (the
 *      orphaned-generation gap the fix closes).
 *   2. The multi-instance stale-disk guard stays observable through the
 *      durability path: converging a stale resident copy still emits the
 *      throttled "rejected stale snapshot" warn (tagged
 *      "(durability-before-render)") and never rolls the shared index
 *      counters back.
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: pin BOTH tiers so every
// leg controls its own mode explicitly (absent now defaults to full, #3818).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3397-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

function loadCorpusCase(dir: string, name: string, id: string, protocol: string) {
    fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
    const loader = new SessionStore({ dir: path.join(dir, name), debounceMs: 1, enabled: true });
    const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
    loader.cancelAll();
    loader.closeQuietly();
    assert.ok(loaded, `${name}: corpus loadSync returned null`);
    return loaded;
}

/** Session envelopes live at <proto>/<host>_<hash>.json; the probe counts
 *  only real session records. */
function envelopeFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (p: string) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const full = path.join(p, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".json") && !e.name.endsWith(".content-store.json") && e.name !== "no-config.json") out.push(full);
        }
    };
    walk(dir);
    return out;
}

/** Windows: an ephemeral stray handle must not fail CI — best-effort delete
 *  with bounded retries, swallowed on persistent EBUSY/EPERM. */
function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

test("durability-before-render: ingestRowsNow makes the rows durable without the envelope; a cold restart loads from the index", () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off"; // no envelope can ever appear — rows can only come from ingestRowsNow
    try {
        const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3397-seed-"));
        const session = loadCorpusCase(seed, "folded", "corpus-folded", "anthropic");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3397-dur-"));
        try {
            const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
            // Synchronous, request-path call — no await anywhere — exactly
            // what the prepare phase does before the model call.
            store.ingestRowsNow(session);
            store.cancelAll();
            store.closeQuietly();

            assert.equal(envelopeFiles(dir).length, 0, "the durability pass must not write the JSON envelope");
            assert.ok(fs.existsSync(path.join(dir, "index.db")), "index.db must exist after ingestRowsNow");
            const db = UnifiedStore.open(path.join(dir, "index.db"));
            try {
                const row = db.getSessionRow(session.id);
                assert.ok(row, "the session row must exist in the unified index");
            } finally {
                db.close();
            }

            // "Crash + restart": a fresh store resolves the session
            // unified-first; the refs the model saw are backed by the
            // ledger — the #3397 orphaned-generation gap.
            const reopen = new SessionStore({ dir, debounceMs: 1, enabled: true });
            try {
                const loaded = reopen.loadSync(session.id, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
                assert.ok(loaded, "index-only session must load after restart");
                assert.ok(loaded.state.blocks.length > 0, "folds must survive the envelope-less round-trip");
                assert.equal(loaded.state.blocks.length, session.state.blocks.length, "block count must survive the index-only round-trip");
                assert.equal(loaded.state.nextBlockId, session.state.nextBlockId, "nextBlockId cursor must be intact");
                assert.equal(loaded.state.messageRefs.byRaw.size, session.state.messageRefs.byRaw.size, "messageRefs ledger must be intact");
                reopen.cancelAll();
            } finally {
                reopen.closeQuietly();
            }
        } finally {
            rmBestEffort(dir);
            rmBestEffort(seed);
        }
    } finally {
        delete process.env.BILI_STORAGE_JSON_WRITER;
        process.env.BILI_STORAGE_UNIFIED = prevMode;
    }
});

test("durability-before-render: the stale-disk guard stays observable (warn + converge, no counter rollback)", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full"; // envelope ON — the guard compares against it
    try {
        // Two resident copies of the SAME session = two instances sharing the
        // dir (#394 topology): `base` belongs to instance A, `stale` to B.
        const seedA = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3397-a-"));
        const base = loadCorpusCase(seedA, "folded", "corpus-folded", "anthropic");
        const seedB = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3397-b-"));
        const stale = loadCorpusCase(seedB, "folded", "corpus-folded", "anthropic");
        const r0 = base.stats.requests ?? 0;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3397-stale-"));
        const logs: { level: string; msg: string }[] = [];
        try {
            const storeA = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
            await storeA.writeNow(base); // disk at R0
            base.stats.requests = r0 + 1;
            await storeA.writeNow(base); // disk at R0+1 — instance A advanced
            storeA.cancelAll();
            storeA.closeQuietly();

            // Instance B still holds the R0 copy. Its durability pass runs
            // against the shared dir → stale-disk branch (commit b34e5499).
            const storeB = new SessionStore({ dir, debounceMs: 60_000, enabled: true, log: (level, msg) => { logs.push({ level, msg }); } });
            storeB.ingestRowsNow(stale);
            storeB.cancelAll();
            storeB.closeQuietly();

            const warns = logs.filter((l) => l.msg.includes("rejected stale snapshot"));
            assert.ok(
                warns.some((l) => l.level === "warn" && l.msg.includes("(durability-before-render)")),
                `expected a warn tagged "(durability-before-render)", got: ${logs.map((l) => `${l.level} ${l.msg}`).join(" | ")}`,
            );
            assert.equal(stale.stats.requests, r0 + 1, "the stale in-memory copy must converge to the disk record");

            // The shared index must NOT have been rolled back by the stale ingest.
            const db = UnifiedStore.open(path.join(dir, "index.db"));
            try {
                const row = db.getSessionRow(stale.id);
                assert.ok(row, "the session row must exist in the unified index");
                const stats = JSON.parse(row!.statsJson ?? "{}") as { requests?: number };
                assert.equal(stats.requests, r0 + 1, "index counters must keep the newer commit (no rollback)");
            } finally {
                db.close();
            }
        } finally {
            rmBestEffort(dir);
            rmBestEffort(seedA);
            rmBestEffort(seedB);
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
    }
});
