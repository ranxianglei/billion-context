import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { canonicalize, sha256 } from "./golden-canonical.ts";
import { planIngest, loadLegacyView, toLegacyLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { resolveStorageMode } from "../src/storage/shadow.ts";
import { setPreferredSqliteEngineForTests, type SqliteEngineName } from "../src/storage/driver.ts";

/**
 * Unified-storage acceptance (Phase 1, #2671).
 *
 * The legacy corpus (tests/golden/storage-corpus, pinned by
 * tests/storage-corpus.test.ts) is driven through the full migration path:
 *
 *   legacy files → loadSync → planIngest → UnifiedStore.ingest
 *               → getRows → loadLegacyView → canonical digest
 *
 * and the digest must equal the manifest byte-for-byte on BOTH engines.
 * Any mismatch means the unified layer loses or reshapes information —
 * exactly what the migration may never do.
 */

process.env.BILI_PERSIST_ZSTD = "0";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

interface CaseResult { description: string; files: string[]; digest: string; notes?: Record<string, unknown> }
const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, "manifest.json"), "utf8")) as Record<string, CaseResult>;

const CASE_META: Record<string, { protocol: string; id: string }> = {
    "folded": { protocol: "anthropic", id: "corpus-folded" },
    "tier2": { protocol: "chat", id: "corpus-tier2" },
    "deadrefs": { protocol: "anthropic", id: "corpus-deadrefs" },
    "fork-receipt": { protocol: "chat", id: "corpus-fork-receipt" },
    "fork-retained": { protocol: "chat", id: "corpus-fork-retained" },
    "image": { protocol: "anthropic", id: "corpus-image" },
    "ccr": { protocol: "responses", id: "corpus-ccr" },
    "twinfile": { protocol: "openai", id: "corpus-twin" },
    "zstd": { protocol: "anthropic", id: "corpus-folded" },
};

function loadCase(name: string): Session {
    const meta = CASE_META[name]!;
    const prevZstd = process.env.BILI_PERSIST_ZSTD;
    if (name === "zstd") process.env.BILI_PERSIST_ZSTD = "1";
    try {
        const store = new SessionStore({ dir: path.join(CORPUS_ROOT, name), debounceMs: 1, enabled: true });
        const loaded = store.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(loaded, `${name}: loadSync returned null`);
        return loaded;
    } finally {
        if (prevZstd === undefined) delete process.env.BILI_PERSIST_ZSTD;
        else process.env.BILI_PERSIST_ZSTD = prevZstd;
    }
}

/** Same digest shape as the corpus manifest (see scripts/update-storage-corpus.ts). */
function sessionDigest(view: ReturnType<typeof loadLegacyView>): string {
    return sha256(JSON.stringify(canonicalize({
        id: view.id,
        meta: view.meta,
        stats: view.stats,
        metadata: view.metadata,
        state: view.state,
        blockContents: [...view.blockContents.entries()],
        lastMessages: view.lastMessages,
        lastMessagesFolded: view.lastMessagesFolded,
        pluginSnapshot: view.pluginSnapshot,
        contentStore: view.contentStore,
    })));
}

function runCase(engine: SqliteEngineName, name: string): void {
    const loaded = loadCase(name);
    const legacy = toLegacyLike(loaded);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-unified-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"), engine);
        try {
            const plan = planIngest(legacy);
            store.ingestSession(plan);

            const verify = store.verifyProjections(name === "zstd" ? CASE_META[name]!.id : loaded.id);
            assert.ok(verify.ok, `${engine}/${name}: projection check failed: ${verify.ok ? "" : verify.error}`);

            const rows = {
                session: (() => {
                    const s = store.getSessionRow(loaded.id)!;
                    assert.ok(s, `${engine}/${name}: session row missing`);
                    return s;
                })(),
                messages: store.getMessages(loaded.id),
                blocks: store.getBlocks(loaded.id),
                deadRefs: store.getDeadRefs(loaded.id),
                refs: store.getRefs(loaded.id),
            };
            const view = loadLegacyView(rows);
            assert.equal(sessionDigest(view), manifest[name]!.digest, `${engine}/${name}: unified round-trip digest drift`);
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const ENGINES: SqliteEngineName[] = ["better-sqlite3", "node:sqlite"];

/** better-sqlite3 is an optional native dep — when its install was skipped
 *  (Windows runners without a VS toolchain, minimal containers) the corpus
 *  runs still cover node:sqlite, and the better-sqlite3 leg skips loudly. */
function betterSqliteAvailable(): boolean {
    const req = createRequire(import.meta.url);
    try {
        req("better-sqlite3");
        return true;
    } catch {
        return false;
    }
}

test("storage unified: corpus round-trip digests equal the legacy manifest (better-sqlite3)", { skip: !betterSqliteAvailable() && "better-sqlite3 not installed (optional native dependency)" }, () => {
    for (const name of Object.keys(CASE_META)) runCase("better-sqlite3", name);
});

test("storage unified: corpus round-trip digests equal the legacy manifest (node:sqlite)", () => {
    for (const name of Object.keys(CASE_META)) runCase("node:sqlite", name);
});

test("storage unified: re-ingest is idempotent across the whole corpus (digest stable, no duplicate rows)", () => {
    for (const name of Object.keys(CASE_META)) {
        const loaded = loadCase(name);
        const legacy = toLegacyLike(loaded);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-unified-"));
        try {
            const store = UnifiedStore.open(path.join(dir, "index.db"));
            try {
                store.ingestSession(planIngest(legacy));
                const first = store.counts();
                store.ingestSession(planIngest(legacy));
                const second = store.counts();
                assert.equal(second.sessions, first.sessions, `${name}: sessions dup`);
                assert.equal(second.messages, first.messages, `${name}: messages dup`);
                assert.equal(second.blocks, first.blocks, `${name}: blocks dup`);
                assert.equal(second.refs, first.refs, `${name}: refs dup`);
                assert.equal(second.content, first.content, `${name}: content dup (CAS dedup broken)`);
                const rows = {
                    session: store.getSessionRow(loaded.id)!,
                    messages: store.getMessages(loaded.id),
                    blocks: store.getBlocks(loaded.id),
                    deadRefs: store.getDeadRefs(loaded.id),
                    refs: store.getRefs(loaded.id),
                };
                assert.equal(sessionDigest(loadLegacyView(rows)), manifest[name]!.digest, `${name}: digest drift after re-ingest`);
            } finally {
                store.close();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test("storage shadow (BILI_STORAGE_UNIFIED=1): real persist path double-writes and reconciles", async () => {
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "1";
    try {
        for (const name of ["folded", "fork-receipt", "deadrefs", "ccr"]) {
            const meta = CASE_META[name]!;
            // Copy the corpus case out first: loading in place would converge
            // lastSeen and save back into the golden corpus (and open a shadow
            // index.db there). The corpus dir must stay pristine.
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-shadow-"));
            try {
                fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
                const caseDir = path.join(dir, name);
                const loadStore = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
                const loaded = loadStore.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
                assert.ok(loaded, `${name}: loadSync returned null`);
                loadStore.cancelAll();

                const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
                await store.writeNow(loaded);
                store.cancelAll();
                const unified = UnifiedStore.open(path.join(dir, "index.db"));
                try {
                    const rows = {
                        session: unified.getSessionRow(loaded.id)!,
                        messages: unified.getMessages(loaded.id),
                        blocks: unified.getBlocks(loaded.id),
                        deadRefs: unified.getDeadRefs(loaded.id),
                        refs: unified.getRefs(loaded.id),
                    };
                    assert.ok(rows.session, `${name}: shadow did not ingest the session`);
                    assert.equal(
                        sessionDigest(loadLegacyView(rows)),
                        manifest[name]!.digest,
                        `${name}: shadow replay digest drift through the REAL write path`,
                    );
                } finally {
                    unified.close();
                }
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
    }
});

test("resolveStorageMode maps every env spelling", () => {
    const cases: Array<[string | undefined, string]> = [
        [undefined, "legacy"],
        ["", "legacy"],
        ["0", "legacy"],
        ["false", "legacy"],
        ["legacy", "legacy"],
        ["garbage", "legacy"],
        ["1", "shadow"],
        ["true", "shadow"],
        ["shadow", "shadow"],
        ["full", "full"],
        ["unified", "full"],
    ];
    for (const [raw, want] of cases) {
        const env: NodeJS.ProcessEnv = {};
        if (raw !== undefined) env.BILI_STORAGE_UNIFIED = raw;
        assert.equal(resolveStorageMode(env), want, `BILI_STORAGE_UNIFIED=${JSON.stringify(raw)}`);
    }
});

test("storage unified FULL mode: read path serves from the index with organic import + GC parity", async () => {
    const meta = CASE_META["folded"]!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-full-"));
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(dir, "folded"), { recursive: true });
        const caseDir = path.join(dir, "folded");
        // First open against a dir that has ONLY the legacy file: loadSync
        // must organically import and serve the unified view.
        const store = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
        const session = store.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(session, "full-mode loadSync returned null");
        assert.equal(sessionDigest(toLegacyLike(session)), manifest["folded"]!.digest, "full-mode read digest drift (organic import)");
        store.cancelAll();
        // The import must have populated the index even though writeNow never ran.
        const probe = UnifiedStore.open(path.join(caseDir, "index.db"));
        try {
            assert.ok(probe.getSessionRow(meta.id), "organic import did not populate index.db");
        } finally {
            probe.close();
        }
        // Second store, same dir: load again — serves from the index, no
        // import churn, digest still exact.
        const store2 = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
        const again = store2.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(again, "second full-mode loadSync returned null");
        assert.equal(sessionDigest(toLegacyLike(again)), manifest["folded"]!.digest, "second full-mode read digest drift");
        store2.cancelAll();
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("storage unified FULL mode: boot() walks files, imports, and #286 rekey removes the old id from the index", async () => {
    const meta = CASE_META["folded"]!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-"));
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(dir, "folded"), { recursive: true });
        const caseDir = path.join(dir, "folded");
        const store = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
        // corpus-folded's label is "corpus-corpus-folded" (label != id), so
        // boot()'s #286 migration rekeys to the label id and calls
        // removeLegacyFile on the old id — the shadow must follow.
        const sessions = await store.boot();
        store.cancelAll();
        assert.ok(sessions.size >= 1, "boot loaded nothing");
        const probe = UnifiedStore.open(path.join(caseDir, "index.db"));
        try {
            assert.ok(!probe.getSessionRow(meta.id), "old id still present in index after #286 rekey GC");
            assert.ok(probe.listSessionIds().includes("corpus-corpus-folded"), "rekeyed label id missing from index");
        } finally {
            probe.close();
        }
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("storage unified: encryption guard keeps the sidecar closed", () => {
    const meta = CASE_META["folded"]!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-enc-"));
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    const prevKey = process.env.BILI_ENCRYPTION_KEY;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ENCRYPTION_KEY = "a".repeat(64); // 32 bytes hex
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(dir, "folded"), { recursive: true });
        const caseDir = path.join(dir, "folded");
        const store = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
        const session = store.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(session, "encrypted legacy loadSync returned null");
        assert.equal(sessionDigest(toLegacyLike(session)), manifest["folded"]!.digest, "encrypted legacy read digest drift");
        store.cancelAll();
        assert.ok(!fs.existsSync(path.join(caseDir, "index.db")), "index.db must NOT exist while encryption is active");
    } finally {
        if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevMode;
        if (prevKey === undefined) delete process.env.BILI_ENCRYPTION_KEY;
        else process.env.BILI_ENCRYPTION_KEY = prevKey;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
